// Pure builders for the three I-Billing export formats (PR #9, Screen 4):
//
//   - buildCsv()    — Format 3, one row per child-day-segment. Pure, ships
//                     today.
//   - (Format 1/2 PDFs land in a follow-up commit once jspdf+autotable is
//     approved per docs/pr-9-review.md.)
//
// No Supabase imports, no React. Same shape-tolerance pattern as
// src/lib/iBilling.js — funding_sources are read with typed columns
// preferred and `details.X` JSON as fallback.

import { runValidation, RULE } from './iBilling'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Spec § Screen 4 Format 3 column list.
export const CSV_COLUMNS = Object.freeze([
  'child_id',
  'child_full_name',
  'case_number',
  'pay_period_number',
  'date',
  'day_of_week',
  'segment_in_time',
  'segment_out_time',
  'segment_duration_hours',
  'absent_flag',
  'would_have_been_in',
  'would_have_been_out',
  'would_have_been_duration',
  'validation_flags',
  'generated_at',
])

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** RFC-4180-ish CSV escape: wrap in double quotes if the value contains
 *  a comma, quote, newline, or starts/ends with whitespace; double any
 *  embedded quotes. Empty / null → empty cell. */
function csvEscape(value) {
  if (value == null) return ''
  const s = String(value)
  if (s === '') return ''
  const needsQuote = /[",\r\n]/.test(s) || s !== s.trim()
  if (!needsQuote) return s
  return `"${s.replace(/"/g, '""')}"`
}

/** Day-of-week (Sunday–Saturday) for a YYYY-MM-DD without timezone surprises. */
function dayOfWeekFromYMD(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return ''
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** Decimal hours between two HH:MM(:SS) strings on the same date.
 *  Returns null when either is missing or check_out is not strictly
 *  after check_in (Rule 7's overnight case shows as blank duration). */
function segmentDurationHours(check_in, check_out) {
  if (!check_in || !check_out) return null
  const parse = (hms) => {
    const parts = String(hms).split(':').map(Number)
    if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null
    const [h, m, s = 0] = parts
    return h + m / 60 + s / 3600
  }
  const a = parse(check_in)
  const b = parse(check_out)
  if (a == null || b == null) return null
  const diff = b - a
  return diff > 0 ? Math.round(diff * 100) / 100 : null
}

/** Read the case_number from a funding_sources row, preferring the
 *  typed column (post-PR #8.5b) and falling back to `details.case_number`
 *  for legacy CDC rows. */
function readCaseNumber(fs) {
  if (!fs) return ''
  return fs.case_number || (fs.details && fs.details.case_number) || ''
}

/** Find the CDC funding source whose authorization window covers `date`
 *  for `childId`. Returns null when no such row exists. */
function activeCdcSourceFor(childId, date, fundingSources) {
  if (!childId || !date) return null
  for (const fs of fundingSources) {
    if (!fs || fs.archived_at) continue
    if (fs.type !== 'cdc_scholarship') continue
    if (fs.child_id !== childId) continue
    const start = fs.authorization_start || (fs.details && fs.details.authorization_start) || null
    const end   = fs.authorization_end   || (fs.details && fs.details.authorization_end)   || null
    if (start && date < start) continue
    if (end && date > end) continue
    return fs
  }
  return null
}

/** "First Last" or "First" or "" — defensive against partial children rows. */
function fullName(child) {
  if (!child) return ''
  const parts = [child.first_name, child.last_name].filter(s => s && String(s).trim())
  return parts.join(' ').trim()
}

/** Build a lookup from (childId|date|segmentIndex) → semicolon-joined rule IDs. */
function buildIssueIndex(issues) {
  const safe = Array.isArray(issues) ? issues : []
  const idx = new Map()
  for (const iss of safe) {
    if (!iss || !iss.ruleId) continue
    const key = `${iss.childId || ''}|${iss.date || ''}|${iss.segmentIndex ?? ''}`
    const list = idx.get(key) || []
    if (!list.includes(iss.ruleId)) list.push(iss.ruleId)
    idx.set(key, list)
  }
  return idx
}

// -----------------------------------------------------------------------------
// Public builder
// -----------------------------------------------------------------------------

/**
 * Build the I-Billing CSV export as a string (header row + one row per
 * child-day-segment), matching spec § Screen 4 Format 3.
 *
 * @param {object} args
 * @param {object} args.payPeriod       CDC pay period row.
 * @param {object[]} args.attendance    Attendance rows for the period.
 * @param {object[]} args.children      Children roster.
 * @param {object[]} args.fundingSources Funding sources for the provider.
 * @param {object[]} [args.issues]      Pre-computed validation issues; if
 *                                      omitted, runValidation is invoked
 *                                      with the same inputs to populate
 *                                      the validation_flags column.
 * @param {object} [args.profile]       Provider profile (for runValidation).
 * @param {object[]} [args.fiscalYearAttendance] (for runValidation).
 * @param {string} [args.generatedAt]   ISO timestamp; defaults to now.
 * @returns {string} CSV body, header included, LF newlines (RFC-4180-ish).
 */
export function buildCsv({
  payPeriod,
  attendance,
  children,
  fundingSources,
  issues,
  profile,
  fiscalYearAttendance,
  generatedAt,
} = {}) {
  const safeAttendance = Array.isArray(attendance) ? attendance : []
  const safeChildren = Array.isArray(children) ? children : []
  const safeFs = Array.isArray(fundingSources) ? fundingSources : []
  const childById = new Map(safeChildren.map(c => [c.id, c]))
  const generatedStamp = generatedAt || new Date().toISOString()
  const payPeriodNumber = payPeriod ? String(payPeriod.period_number ?? '') : ''

  const issueIdx = buildIssueIndex(
    issues || runValidation({
      payPeriod,
      attendance: safeAttendance,
      children: safeChildren,
      fundingSources: safeFs,
      profile,
      fiscalYearAttendance,
    })
  )

  // Stable order: child name, then date, then segment_index.
  const sorted = [...safeAttendance].sort((a, b) => {
    const an = fullName(childById.get(a.child_id)) || a.child_id || ''
    const bn = fullName(childById.get(b.child_id)) || b.child_id || ''
    if (an !== bn) return an.localeCompare(bn)
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date))
    return (a.segment_index ?? 0) - (b.segment_index ?? 0)
  })

  const rows = [CSV_COLUMNS.join(',')]

  for (const rec of sorted) {
    if (!rec) continue
    const child = childById.get(rec.child_id)
    const fs = activeCdcSourceFor(rec.child_id, rec.date, safeFs)
    const isAbsent = rec.status === 'absent'
    const isPresent = rec.status === 'present'
    const duration = isPresent ? segmentDurationHours(rec.check_in, rec.check_out) : null

    const issueKey = `${rec.child_id || ''}|${rec.date || ''}|${rec.segment_index ?? 0}`
    const childKey = `${rec.child_id || ''}||`
    const periodKey = '||'
    const flags = [
      ...(issueIdx.get(issueKey) || []),
      ...(issueIdx.get(childKey) || []),
      ...(issueIdx.get(periodKey) || []),
    ]

    const row = [
      rec.child_id || '',
      fullName(child),
      readCaseNumber(fs),
      payPeriodNumber,
      rec.date || '',
      dayOfWeekFromYMD(rec.date),
      isPresent ? (rec.check_in || '') : '',
      isPresent ? (rec.check_out || '') : '',
      duration == null ? '' : duration.toFixed(2),
      isAbsent ? 'true' : 'false',
      // would_have_been_* fields stay blank for V1 — the historical-
      // schedule-average derivation lives in Screen 3 (deferred).
      '',
      '',
      '',
      flags.join(';'),
      generatedStamp,
    ].map(csvEscape).join(',')

    rows.push(row)
  }

  return rows.join('\n')
}
