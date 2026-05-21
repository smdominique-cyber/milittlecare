// Pure helpers for the I-Billing transfer & reconciliation flow (PR #9).
//
// The validation engine implements the 11 rules from the CDC LEP
// Handbook and the MiLEAP I-Billing guide. Each rule is a small pure
// function consuming a normalised slice of input and returning zero or
// more Issue records. The top-level `runValidation` runs all 11 and
// concatenates their output.
//
// No Supabase imports, no React. Callers fetch the pay period, the
// attendance for it, the children, the funding sources, the provider
// profile, and the fiscal-year attendance history; pass them in; get
// back an Issue[]. Same shape-tolerance pattern as
// src/lib/cdcAuthorization.js — funding_sources are read with the
// typed CDC columns preferred and a `details.X` JSON fallback for
// pre-PR #8.5b legacy rows.
//
// Status of rule implementations (this commit):
//   ✓ Rule 1  — 2,016-hour pay-period cap                 (implemented + tested)
//   ✗ Rule 2  — 360-hour fiscal-year absence cap          (stub — returns [])
//   ✗ Rule 3  — 10-consecutive-absence-days cap           (stub — returns [])
//   ✗ Rule 4  — 6-children-concurrent cap (LEP)           (stub — returns [])
//   ✓ Rule 5  — billing outside authorization dates       (implemented + tested)
//   ✗ Rule 6  — billing during school hours               (stub — returns [])
//   ✗ Rule 7  — overnight segment not split at midnight   (stub — returns [])
//   ✗ Rule 8  — missing parent initials                   (stub — returns [])
//   ✗ Rule 9  — missing provider name on T&A record       (stub — returns [])
//   ✓ Rule 10 — 90-day submission window past expiry      (implemented + tested)
//   ✓ Rule 11 — billing for child without active CDC      (implemented + tested)
// Stubs are wired into runValidation and return empty; filling them in
// is a same-PR follow-up commit.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Per-pay-period billable-hours cap, CDC LEP Handbook p.14.
export const PAY_PERIOD_HOURS_CAP = 2016

// Annual absence-hours cap (fiscal year), CDC LEP Handbook p.16.
// Warning at 80%; blocking at 100%.
export const FISCAL_YEAR_ABSENCE_HOURS_CAP = 360
export const FISCAL_YEAR_ABSENCE_WARNING_THRESHOLD = 0.8

// Consecutive-absence-days cap when no regular care billed; LEP Handbook p.16.
export const CONSECUTIVE_ABSENCE_DAYS_CAP = 10

// LEP concurrent-children cap, LEP Handbook p.7 / p.16.
export const LEP_CONCURRENT_CHILDREN_CAP = 6

// 90-day submission window past pay-period end date, LEP Handbook p.17.
export const SUBMISSION_WINDOW_DAYS = 90

// CDC fiscal year starts October 1.
export const FISCAL_YEAR_START_MONTH = 10
export const FISCAL_YEAR_START_DAY = 1

// Severity levels in priority order (worst first), used for sort + UI.
export const SEVERITY = Object.freeze({
  BLOCKING: 'blocking',
  WARNING: 'warning',
  INFO: 'info',
})

const SEVERITY_RANK = Object.freeze({
  [SEVERITY.BLOCKING]: 3,
  [SEVERITY.WARNING]: 2,
  [SEVERITY.INFO]: 1,
})

// Rule identifiers used in Issue.ruleId and override audit log.
export const RULE = Object.freeze({
  PAY_PERIOD_HOURS_CAP:           'rule_1_pay_period_hours_cap',
  FISCAL_YEAR_ABSENCE_CAP:        'rule_2_fiscal_year_absence_cap',
  CONSECUTIVE_ABSENCE_DAYS:       'rule_3_consecutive_absence_days',
  CONCURRENT_CHILDREN_CAP:        'rule_4_concurrent_children_cap',
  BILLING_OUTSIDE_AUTHORIZATION:  'rule_5_billing_outside_authorization',
  BILLING_DURING_SCHOOL_HOURS:    'rule_6_billing_during_school_hours',
  OVERNIGHT_NOT_SPLIT_AT_MIDNIGHT:'rule_7_overnight_not_split',
  MISSING_PARENT_INITIALS:        'rule_8_missing_parent_initials',
  MISSING_PROVIDER_NAME:          'rule_9_missing_provider_name',
  SUBMISSION_WINDOW_EXPIRED:      'rule_10_submission_window_expired',
  BILLING_WITHOUT_ACTIVE_CDC:     'rule_11_billing_without_active_cdc',
})

// -----------------------------------------------------------------------------
// Internal date / time helpers
//
// Duplicated from the other src/lib date helpers per the standing
// tech-debt note about extracting src/lib/dates.js.
// -----------------------------------------------------------------------------

/** Today's local date as 'YYYY-MM-DD'. */
export function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole days from aYmd to bYmd (b - a); signed. Date.UTC dodges DST. */
function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = String(aYmd).split('-').map(Number)
  const [by, bm, bd] = String(bYmd).split('-').map(Number)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  )
}

/** 'HH:MM' or 'HH:MM:SS' → decimal hours since midnight, or null. */
function parseTimeToHours(hms) {
  if (!hms) return null
  const parts = String(hms).split(':').map(Number)
  if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null
  const [h, m, s = 0] = parts
  return h + m / 60 + s / 3600
}

/**
 * Decimal hours billed by one attendance segment. Returns 0 for absent
 * records, partial-data records, and any segment where check_out is
 * not strictly after check_in (degenerate / midnight-crossing — Rule 7
 * is responsible for flagging those separately).
 */
export function segmentHours(record) {
  if (!record || record.status !== 'present') return 0
  const inH  = parseTimeToHours(record.check_in)
  const outH = parseTimeToHours(record.check_out)
  if (inH == null || outH == null) return 0
  const diff = outH - inH
  return diff > 0 ? diff : 0
}

/**
 * Read `authorization_start` / `authorization_end` from a funding
 * source row, preferring typed columns (post-PR #8.5b) and falling
 * back to `details.X` (pre-PR #8.5b legacy rows). Returns null when
 * neither shape carries the value.
 */
function readAuthDates(fs) {
  if (!fs) return { start: null, end: null }
  const start = fs.authorization_start || (fs.details && fs.details.authorization_start) || null
  const end   = fs.authorization_end   || (fs.details && fs.details.authorization_end)   || null
  return { start, end }
}

// -----------------------------------------------------------------------------
// Issue builder
// -----------------------------------------------------------------------------

function makeIssue({ ruleId, severity, childId = null, date = null, segmentIndex = null, message, proposedFix = null, auditCitation = null }) {
  return { ruleId, severity, childId, date, segmentIndex, message, proposedFix, auditCitation }
}

// -----------------------------------------------------------------------------
// Rule 1 — 2,016-hour pay-period cap (LEP Handbook p.14)
// -----------------------------------------------------------------------------

/**
 * Sum billable segment hours across every child, every segment, for
 * the pay period. If the total exceeds PAY_PERIOD_HOURS_CAP, return a
 * single blocking issue. Otherwise return [].
 *
 * The cap is a single per-provider total — not per-child. Provider-
 * level issue (childId / date / segmentIndex are null).
 */
export function checkPayPeriodHoursCap({ attendance }) {
  const safe = Array.isArray(attendance) ? attendance : []
  const total = safe.reduce((sum, r) => sum + segmentHours(r), 0)
  if (total <= PAY_PERIOD_HOURS_CAP) return []
  return [makeIssue({
    ruleId: RULE.PAY_PERIOD_HOURS_CAP,
    severity: SEVERITY.BLOCKING,
    message: `Billable hours this pay period (${total.toFixed(2)}) exceed the ${PAY_PERIOD_HOURS_CAP}-hour cap.`,
    auditCitation: 'CDC LEP Handbook p.14',
  })]
}

// -----------------------------------------------------------------------------
// Rule 5 — billing before authorization_start or after authorization_end
// (CDC LEP Handbook p.4–5, IPV examples)
// -----------------------------------------------------------------------------

/**
 * For each attendance segment, find the child's CDC funding source and
 * check the segment date against the authorization window. Out-of-window
 * segments produce blocking issues with an IPV citation.
 *
 * A child with no active CDC funding source is handled by Rule 11, not
 * this rule — we silently skip those here to avoid double-flagging.
 */
export function checkBillingOutsideAuthorization({ attendance, fundingSources }) {
  const safeRecs = Array.isArray(attendance) ? attendance : []
  const safeFs   = Array.isArray(fundingSources) ? fundingSources : []

  // Build a per-child lookup of CDC funding sources.
  const cdcByChild = new Map()
  for (const fs of safeFs) {
    if (!fs || fs.type !== 'cdc_scholarship' || fs.archived_at) continue
    if (!fs.child_id) continue
    const list = cdcByChild.get(fs.child_id) || []
    list.push(fs)
    cdcByChild.set(fs.child_id, list)
  }

  const issues = []
  for (const rec of safeRecs) {
    if (!rec || rec.status !== 'present') continue
    const cdcList = cdcByChild.get(rec.child_id)
    if (!cdcList || cdcList.length === 0) continue  // Rule 11's territory

    // Pass when any one of the child's CDC funding sources covers this date.
    const recDate = rec.date
    const covered = cdcList.some(fs => {
      const { start, end } = readAuthDates(fs)
      if (!start) return false
      if (recDate < start) return false
      if (end && recDate > end) return false
      return true
    })

    if (!covered) {
      issues.push(makeIssue({
        ruleId: RULE.BILLING_OUTSIDE_AUTHORIZATION,
        severity: SEVERITY.BLOCKING,
        childId: rec.child_id,
        date: recDate,
        segmentIndex: rec.segment_index ?? 0,
        message: 'Attendance recorded outside the CDC authorization window. Trim or remove this segment, or update the funding source authorization dates.',
        proposedFix: {
          description: `Remove this segment (${recDate})`,
          action: { kind: 'remove_segment', attendanceId: rec.id },
        },
        auditCitation: 'CDC LEP Handbook p.4–5 (IPV examples)',
      }))
    }
  }
  return issues
}

// -----------------------------------------------------------------------------
// Rule 10 — 90-day submission window past expiry (CDC LEP Handbook p.17)
// -----------------------------------------------------------------------------

/**
 * Compare today's date to the pay period's end_date + 90 days. If
 * today is past that, the period cannot be billed at all per MDHHS
 * policy — blocking issue at the period level.
 */
export function checkSubmissionWindowExpired({ payPeriod, today }) {
  if (!payPeriod || !payPeriod.end_date) return []
  const todayStr = today || todayYMD()
  const daysSinceEnd = daysBetweenYMD(payPeriod.end_date, todayStr)
  if (daysSinceEnd <= SUBMISSION_WINDOW_DAYS) return []
  return [makeIssue({
    ruleId: RULE.SUBMISSION_WINDOW_EXPIRED,
    severity: SEVERITY.BLOCKING,
    message: `This pay period closed ${daysSinceEnd} days ago; MDHHS will not accept submissions more than ${SUBMISSION_WINDOW_DAYS} days past the pay-period end date.`,
    auditCitation: 'CDC LEP Handbook p.17',
  })]
}

// -----------------------------------------------------------------------------
// Rule 11 — billing for a child without an active CDC funding source
// (CDC LEP Handbook p.4–5)
// -----------------------------------------------------------------------------

/**
 * For each child appearing in the period's attendance, verify they
 * have at least one CDC funding source that is non-archived, status =
 * 'active', and covers some part of the pay period. Children failing
 * the check produce one blocking issue (date-agnostic, since the
 * problem is provider-roster-level).
 */
export function checkBillingWithoutActiveCdc({ attendance, fundingSources, payPeriod }) {
  const safeRecs = Array.isArray(attendance) ? attendance : []
  const safeFs   = Array.isArray(fundingSources) ? fundingSources : []
  if (!payPeriod) return []

  const periodStart = payPeriod.start_date
  const periodEnd   = payPeriod.end_date

  const cdcByChild = new Map()
  for (const fs of safeFs) {
    if (!fs || fs.type !== 'cdc_scholarship') continue
    if (fs.archived_at) continue
    if (fs.status !== 'active') continue
    if (!fs.child_id) continue
    const { start, end } = readAuthDates(fs)
    if (start && periodEnd && start > periodEnd) continue
    if (end && periodStart && end < periodStart) continue
    const list = cdcByChild.get(fs.child_id) || []
    list.push(fs)
    cdcByChild.set(fs.child_id, list)
  }

  const seenChildren = new Set()
  for (const rec of safeRecs) {
    if (!rec || !rec.child_id) continue
    if (rec.status !== 'present') continue
    seenChildren.add(rec.child_id)
  }

  const issues = []
  for (const childId of seenChildren) {
    if (!cdcByChild.has(childId)) {
      issues.push(makeIssue({
        ruleId: RULE.BILLING_WITHOUT_ACTIVE_CDC,
        severity: SEVERITY.BLOCKING,
        childId,
        message: 'This child has no active CDC funding source covering the pay period. Bill cannot be submitted for them.',
        auditCitation: 'CDC LEP Handbook p.4–5',
      }))
    }
  }
  return issues
}

// -----------------------------------------------------------------------------
// Stubs for Rules 2, 3, 4, 6, 7, 8, 9 — return [] until implemented.
// Each is wired into runValidation so the top-level call surface is
// stable across the remaining rule implementations.
// -----------------------------------------------------------------------------

export function checkFiscalYearAbsenceCap(/* { fiscalYearAttendance, today } */) { return [] }
export function checkConsecutiveAbsenceDays(/* { attendance } */) { return [] }
export function checkConcurrentChildrenCap(/* { attendance, profile } */) { return [] }
export function checkBillingDuringSchoolHours(/* { attendance, children } */) { return [] }
export function checkOvernightNotSplitAtMidnight(/* { attendance } */) { return [] }
export function checkMissingParentInitials(/* { attendance } */) { return [] }
export function checkMissingProviderName(/* { profile } */) { return [] }

// -----------------------------------------------------------------------------
// Top-level entry point
// -----------------------------------------------------------------------------

/**
 * Runs all 11 validation rules and returns the combined Issue list,
 * sorted blocking → warning → info (severity rank desc), with stable
 * order within each severity tier so consecutive renders don't reshuffle.
 *
 * @param {object} args
 * @param {object} args.payPeriod              CDC pay period catalog row.
 * @param {object[]} args.attendance           Attendance rows for the period.
 * @param {object[]} args.children             Children roster.
 * @param {object[]} args.fundingSources       Funding sources for the provider.
 * @param {object} args.profile                Provider profile row.
 * @param {object[]} [args.fiscalYearAttendance] Attendance since FY start (rule 2).
 * @param {string} [args.today]                'YYYY-MM-DD'; defaults to today.
 * @returns {object[]} Issue[]
 */
export function runValidation(args = {}) {
  const all = [
    ...checkPayPeriodHoursCap(args),
    ...checkFiscalYearAbsenceCap(args),
    ...checkConsecutiveAbsenceDays(args),
    ...checkConcurrentChildrenCap(args),
    ...checkBillingOutsideAuthorization(args),
    ...checkBillingDuringSchoolHours(args),
    ...checkOvernightNotSplitAtMidnight(args),
    ...checkMissingParentInitials(args),
    ...checkMissingProviderName(args),
    ...checkSubmissionWindowExpired(args),
    ...checkBillingWithoutActiveCdc(args),
  ]
  return all.sort(
    (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
  )
}
