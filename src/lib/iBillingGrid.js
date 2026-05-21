// Pure helpers for the I-Billing Screen 2 review grid (PR #9).
//
// Shape:
//   - rows are children (only those who appear in the period's
//     attendance OR have an active CDC funding source overlapping the
//     period — same union as the PDFs in src/lib/iBillingPdf.js).
//   - columns are the calendar days of the pay period (14 days).
//   - each cell summarises the segments for that child on that day.
//   - running totals: per child (right margin), per day (bottom row),
//     grand total (bottom-right corner).
//
// Validation issues from src/lib/iBilling.js are joined in: each cell
// carries the highest-severity issue affecting it, plus the full list
// for the modal in Screen 3.

import { segmentHours, RULE, SEVERITY } from './iBilling'

// Severity rank — copied here rather than imported from iBilling so the
// grid helper has no dependency cycle if iBilling later imports anything
// from this file (it currently doesn't).
const RANK = { [SEVERITY.BLOCKING]: 3, [SEVERITY.WARNING]: 2, [SEVERITY.INFO]: 1 }

// -----------------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------------

/** Each 'YYYY-MM-DD' day from start through end inclusive. */
export function daysInPeriod(payPeriod) {
  if (!payPeriod || !payPeriod.start_date || !payPeriod.end_date) return []
  const days = []
  const [sy, sm, sd] = payPeriod.start_date.split('-').map(Number)
  const start = Date.UTC(sy, sm - 1, sd)
  const [ey, em, ed] = payPeriod.end_date.split('-').map(Number)
  const end = Date.UTC(ey, em - 1, ed)
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t)
    days.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`)
  }
  return days
}

// -----------------------------------------------------------------------------
// Grid builder
// -----------------------------------------------------------------------------

/**
 * Build the rendered review grid from the loaded slice.
 *
 * @param {object} args
 * @param {object}   args.payPeriod
 * @param {object[]} args.attendance
 * @param {object[]} args.children
 * @param {object[]} args.fundingSources
 * @param {object[]} args.issues          Pre-computed validation issues
 *                                        (from runValidation).
 * @returns {object} { days, rows, totals }
 *
 * Row shape:
 *   {
 *     child:     <children row>,
 *     cells:     { [date]: { segments, hours, isAbsent, issues, worstSeverity } },
 *     totalHours
 *   }
 * Totals shape:
 *   { perDay: { [date]: hours }, grand: hours }
 */
export function buildReviewGrid({
  payPeriod,
  attendance,
  children,
  fundingSources,
  issues,
} = {}) {
  const safeAtt   = Array.isArray(attendance)     ? attendance     : []
  const safeKids  = Array.isArray(children)       ? children       : []
  const safeFs    = Array.isArray(fundingSources) ? fundingSources : []
  const safeIss   = Array.isArray(issues)         ? issues         : []
  const days      = daysInPeriod(payPeriod)

  // Identify the child set: any kid with attendance OR an active CDC
  // funding source touching this period.
  const childIdsWithAttendance = new Set(safeAtt.map(r => r && r.child_id).filter(Boolean))
  const childIdsWithCdc = new Set()
  for (const fs of safeFs) {
    if (!fs || fs.archived_at) continue
    if (fs.type !== 'cdc_scholarship') continue
    if (!fs.child_id) continue
    childIdsWithCdc.add(fs.child_id)
  }
  const allChildIds = new Set([...childIdsWithAttendance, ...childIdsWithCdc])

  const childById = new Map(safeKids.map(c => [c.id, c]))

  // Index attendance by (child_id, date).
  const segByKey = new Map()
  for (const r of safeAtt) {
    if (!r || !r.child_id || !r.date) continue
    const key = `${r.child_id}|${r.date}`
    const list = segByKey.get(key) || []
    list.push(r)
    list.sort((a, b) => (a.segment_index ?? 0) - (b.segment_index ?? 0))
    segByKey.set(key, list)
  }

  // Index issues by cell, child, period.
  const issueByCell    = new Map()   // 'childId|date'
  const issueByChild   = new Map()   // 'childId'
  const issueByPeriod  = []          // provider-level
  for (const iss of safeIss) {
    if (!iss) continue
    if (iss.childId && iss.date) {
      const k = `${iss.childId}|${iss.date}`
      const list = issueByCell.get(k) || []
      list.push(iss)
      issueByCell.set(k, list)
    } else if (iss.childId) {
      const list = issueByChild.get(iss.childId) || []
      list.push(iss)
      issueByChild.set(iss.childId, list)
    } else {
      issueByPeriod.push(iss)
    }
  }

  const rows = []
  const perDay = Object.fromEntries(days.map(d => [d, 0]))
  let grand = 0

  // Stable order: children sorted by full name then by id.
  const sortedChildIds = [...allChildIds].sort((a, b) => {
    const ca = childById.get(a) || {}
    const cb = childById.get(b) || {}
    const na = `${ca.first_name || ''} ${ca.last_name || ''}`.trim() || a
    const nb = `${cb.first_name || ''} ${cb.last_name || ''}`.trim() || b
    return na.localeCompare(nb)
  })

  for (const childId of sortedChildIds) {
    const child = childById.get(childId) || { id: childId, first_name: '?', last_name: '' }
    const childIssues = issueByChild.get(childId) || []
    let totalHours = 0
    const cells = {}
    for (const date of days) {
      const segments = segByKey.get(`${childId}|${date}`) || []
      let hours = 0
      let isAbsent = false
      for (const s of segments) {
        if (s.status === 'present') hours += segmentHours(s)
        if (s.status === 'absent')  isAbsent = true
      }
      totalHours += hours
      perDay[date] += hours

      const cellIssues = issueByCell.get(`${childId}|${date}`) || []
      const worst = cellIssues.reduce(
        (acc, iss) => Math.max(acc, RANK[iss.severity] || 0), 0
      )
      cells[date] = {
        segments,
        hours,
        isAbsent,
        issues: cellIssues,
        worstSeverity: worst === 3 ? SEVERITY.BLOCKING
                     : worst === 2 ? SEVERITY.WARNING
                     : worst === 1 ? SEVERITY.INFO
                     : null,
      }
    }
    grand += totalHours
    rows.push({ child, childIssues, cells, totalHours })
  }

  return {
    days,
    rows,
    totals: { perDay, grand },
    providerIssues: issueByPeriod,
  }
}

// -----------------------------------------------------------------------------
// Light convenience: rule label lookup. Used by the cell tooltip in the
// Screen 2 hover.
// -----------------------------------------------------------------------------

export const RULE_LABEL = Object.freeze({
  [RULE.PAY_PERIOD_HOURS_CAP]:           'Pay-period 2,016-hour cap',
  [RULE.FISCAL_YEAR_ABSENCE_CAP]:        'Fiscal-year absence cap',
  [RULE.CONSECUTIVE_ABSENCE_DAYS]:       'Consecutive absences',
  [RULE.CONCURRENT_CHILDREN_CAP]:        'Concurrent-children cap',
  [RULE.BILLING_OUTSIDE_AUTHORIZATION]:  'Outside CDC authorization',
  [RULE.BILLING_DURING_SCHOOL_HOURS]:    'During school hours',
  [RULE.OVERNIGHT_NOT_SPLIT_AT_MIDNIGHT]:'Overnight not split at midnight',
  [RULE.MISSING_PARENT_INITIALS]:        'Missing parent acknowledgment',
  [RULE.MISSING_PROVIDER_NAME]:          'Missing provider name',
  [RULE.SUBMISSION_WINDOW_EXPIRED]:      'Past 90-day submission window',
  [RULE.BILLING_WITHOUT_ACTIVE_CDC]:     'No active CDC funding',
})
