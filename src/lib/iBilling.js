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
// All 11 rules implemented (this commit completes them all).
//
// Rule 8 upgrade (PR #12 step 6). When PR #12's parent-acknowledgment
// system is in place, Rule 8 becomes a per-day check using the
// attendance hash for tamper detection (spec § 9.1). Severity is driven
// by the provider's `acknowledgment_strictness` setting on `profiles`
// — 'warning' default, 'blocking' in strict mode. The pure helper
// `computeAttendanceHash` lives in src/lib/parentAcknowledgment.js so
// the parent portal, the provider dashboard, and the validation engine
// share one canonical serialisation.

import { computeAttendanceHash } from './parentAcknowledgment'

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
// Rule 9 — missing provider name on T&A record (LEP Handbook p.15, Warning)
// -----------------------------------------------------------------------------

/**
 * Warning if the provider's profile has no full_name. The MiLEAP T&A
 * Record requires provider identification at the top; a blank name on
 * the printed form is an audit defect, not a billing block.
 */
export function checkMissingProviderName({ profile }) {
  if (profile && profile.full_name && String(profile.full_name).trim()) return []
  return [makeIssue({
    ruleId: RULE.MISSING_PROVIDER_NAME,
    severity: SEVERITY.WARNING,
    message: 'Provider name is missing from the profile. The MiLEAP T&A Record requires it; fill it in under Settings → Business Info before exporting.',
    auditCitation: 'CDC LEP Handbook p.15',
  })]
}

// -----------------------------------------------------------------------------
// Rule 7 — overnight segment not split at midnight (I-Billing guide Step 3,
// Blocking)
// -----------------------------------------------------------------------------

/**
 * An attendance segment with check_out time earlier than check_in time
 * (e.g. 21:00 → 05:00) is an overnight span that the I-Billing entry
 * screen cannot accept as-is — it must be split into a same-day half
 * and a next-day half. We flag every such segment as blocking with a
 * proposed-fix payload Screen 3 can apply automatically.
 */
export function checkOvernightNotSplitAtMidnight({ attendance }) {
  const safe = Array.isArray(attendance) ? attendance : []
  const issues = []
  for (const rec of safe) {
    if (!rec || rec.status !== 'present') continue
    const inH = parseTimeToHours(rec.check_in)
    const outH = parseTimeToHours(rec.check_out)
    if (inH == null || outH == null) continue
    if (outH < inH) {
      issues.push(makeIssue({
        ruleId: RULE.OVERNIGHT_NOT_SPLIT_AT_MIDNIGHT,
        severity: SEVERITY.BLOCKING,
        childId: rec.child_id,
        date: rec.date,
        segmentIndex: rec.segment_index ?? 0,
        message: `Overnight span ${rec.check_in}–${rec.check_out} crosses midnight; split into ${rec.check_in}–23:59 (${rec.date}) and 00:00–${rec.check_out} (next day) before exporting.`,
        proposedFix: {
          description: 'Auto-split this segment at midnight',
          action: { kind: 'split_at_midnight', attendanceId: rec.id },
        },
        auditCitation: 'MiLEAP I-Billing Step-by-Step instructions, Step 3',
      }))
    }
  }
  return issues
}

// -----------------------------------------------------------------------------
// Rule 8 — missing parent initials (LEP Handbook p.15, Warning or Blocking)
// -----------------------------------------------------------------------------

/**
 * One issue per billed segment that is not cleanly acknowledged by the
 * parent. Severity is driven by the provider's
 * `profiles.acknowledgment_strictness` setting from PR #8.5c:
 *   - 'warning' (default) → SEVERITY.WARNING — exports proceed, parent
 *     initials column on the T&A PDF reads "(awaiting)".
 *   - 'strict'             → SEVERITY.BLOCKING — exports refuse until
 *     each day is either acknowledged by the parent or overridden by
 *     the provider with a reason.
 *
 * Two failure modes per segment:
 *   1. No acknowledgment row on file → "Awaiting parent acknowledgment".
 *      Proposed-fix is a provider override (one-click on Screen 3 with
 *      a required reason).
 *   2. Acknowledgment exists but the row's current canonical hash no
 *      longer matches `attendance_snapshot_hash` → the segment was
 *      edited after acknowledgment. Parent must re-confirm; no
 *      one-click fix offered.
 *
 * Acknowledgment rows authored as `acknowledged_via = 'provider_override'`
 * count as "clean" — the override is the resolution.
 *
 * Implementation note. The hash function lives in
 * src/lib/parentAcknowledgment.js (one canonical serialisation shared
 * by the parent portal write side and the validation read side). Both
 * sides agree on which fields participate, so a parent who acknowledges
 * a segment is acknowledging the exact `(check_in, check_out, status,
 * segment_index)` tuple — and any subsequent edit to those columns
 * trips this rule.
 */
export function checkMissingParentInitials({ attendance, acknowledgments, profile }) {
  const safe = Array.isArray(attendance) ? attendance : []
  const acks = Array.isArray(acknowledgments) ? acknowledgments : []
  if (!safe.some(r => r && r.status === 'present' && segmentHours(r) > 0)) return []

  const strictness = profile?.acknowledgment_strictness === 'strict' ? 'strict' : 'warning'
  const severity = strictness === 'strict' ? SEVERITY.BLOCKING : SEVERITY.WARNING

  // Index acknowledgments by (child_id, date, segment_index).
  const ackByKey = new Map()
  for (const a of acks) {
    if (!a || a.archived_at) continue
    if (!a.child_id || !a.date) continue
    const key = `${a.child_id}|${a.date}|${a.segment_index ?? 0}`
    ackByKey.set(key, a)
  }

  const issues = []
  for (const rec of safe) {
    if (!rec || rec.status !== 'present') continue
    if (segmentHours(rec) <= 0) continue

    const segIdx = rec.segment_index ?? 0
    const key = `${rec.child_id}|${rec.date}|${segIdx}`
    const ack = ackByKey.get(key)

    if (!ack) {
      issues.push(makeIssue({
        ruleId: RULE.MISSING_PARENT_INITIALS,
        severity,
        childId: rec.child_id,
        date: rec.date,
        segmentIndex: segIdx,
        message: `No parent acknowledgment on file for ${rec.date}. Parent must review in the portal, or you can override with a reason.`,
        proposedFix: {
          description: 'Override with reason (provider attests)',
          action: { kind: 'provider_override_acknowledgment', attendanceId: rec.id },
        },
        auditCitation: 'CDC LEP Handbook p.15',
      }))
      continue
    }

    // Hash check — did the row change after the parent acknowledged?
    const currentHash = computeAttendanceHash(rec)
    if (currentHash !== ack.attendance_snapshot_hash) {
      issues.push(makeIssue({
        ruleId: RULE.MISSING_PARENT_INITIALS,
        severity,
        childId: rec.child_id,
        date: rec.date,
        segmentIndex: segIdx,
        message: `Attendance was edited after parent acknowledged for ${rec.date}. Parent must re-confirm before this day can be billed.`,
        auditCitation: 'CDC LEP Handbook p.15',
      }))
    }
  }
  return issues
}

// -----------------------------------------------------------------------------
// Rule 2 — 360-hour fiscal-year absence cap (LEP Handbook p.16,
// Warning at 80%, Blocking at 100%)
// -----------------------------------------------------------------------------

/**
 * Sum absence-day equivalents since Oct 1 of the current fiscal year.
 * Each absence day counts as 8 hours — a coarse approximation pending
 * the spec's "historical schedule average" feature in Screen 3, which
 * would derive a child-specific average from prior pay periods. The
 * 8-hour figure is conservative for most LEP children (the handbook's
 * 360-hour cap is roughly 45 × 8h days).
 *
 * One provider-level issue: warning at 80% of cap; blocking at 100%.
 */
export function checkFiscalYearAbsenceCap({ fiscalYearAttendance, today }) {
  const safe = Array.isArray(fiscalYearAttendance) ? fiscalYearAttendance : []
  if (safe.length === 0) return []

  // Only count absences since fiscal-year start.
  const fyStart = fiscalYearStartYMD(today || todayYMD())
  const absentRows = safe.filter(r => r && r.status === 'absent' && r.date >= fyStart)
  // Dedupe by (child_id, date) — absence is a per-day concept,
  // segment_index doesn't multiply the hour count.
  const seen = new Set()
  let absenceDays = 0
  for (const r of absentRows) {
    const key = `${r.child_id}|${r.date}`
    if (seen.has(key)) continue
    seen.add(key)
    absenceDays += 1
  }
  const absenceHours = absenceDays * 8

  if (absenceHours >= FISCAL_YEAR_ABSENCE_HOURS_CAP) {
    return [makeIssue({
      ruleId: RULE.FISCAL_YEAR_ABSENCE_CAP,
      severity: SEVERITY.BLOCKING,
      message: `Fiscal-year absence hours (${absenceHours}, est. from ${absenceDays} days × 8h) have reached the ${FISCAL_YEAR_ABSENCE_HOURS_CAP}-hour cap. No further absence may be billed this fiscal year.`,
      auditCitation: 'CDC LEP Handbook p.16',
    })]
  }
  const threshold = FISCAL_YEAR_ABSENCE_HOURS_CAP * FISCAL_YEAR_ABSENCE_WARNING_THRESHOLD
  if (absenceHours >= threshold) {
    return [makeIssue({
      ruleId: RULE.FISCAL_YEAR_ABSENCE_CAP,
      severity: SEVERITY.WARNING,
      message: `Fiscal-year absence hours (${absenceHours}, est. from ${absenceDays} days × 8h) are at ${Math.round((absenceHours / FISCAL_YEAR_ABSENCE_HOURS_CAP) * 100)}% of the ${FISCAL_YEAR_ABSENCE_HOURS_CAP}-hour cap. Approaching the limit.`,
      auditCitation: 'CDC LEP Handbook p.16',
    })]
  }
  return []
}

/** Oct 1 of the fiscal year that `today` falls in. */
function fiscalYearStartYMD(today) {
  const [y, m, d] = String(today).split('-').map(Number)
  const fy = (m > FISCAL_YEAR_START_MONTH || (m === FISCAL_YEAR_START_MONTH && d >= FISCAL_YEAR_START_DAY))
    ? y
    : y - 1
  return `${fy}-${String(FISCAL_YEAR_START_MONTH).padStart(2, '0')}-${String(FISCAL_YEAR_START_DAY).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Rule 3 — 10 consecutive absence days with no care billed (LEP Handbook
// p.16, Blocking)
// -----------------------------------------------------------------------------

/**
 * For each child, walk the union of fiscalYearAttendance + the current
 * period's attendance day-by-day. Find the longest run of consecutive
 * days on which the child has no "billed care" (i.e., no present
 * segment with hours > 0). If any run is ≥ CONSECUTIVE_ABSENCE_DAYS_CAP
 * AND the run overlaps the current pay period, emit a blocking issue.
 */
export function checkConsecutiveAbsenceDays({ attendance, fiscalYearAttendance, payPeriod }) {
  const period = payPeriod || {}
  if (!period.start_date || !period.end_date) return []

  const all = [
    ...(Array.isArray(attendance) ? attendance : []),
    ...(Array.isArray(fiscalYearAttendance) ? fiscalYearAttendance : []),
  ]
  if (all.length === 0) return []

  // Group billed-care days per child.
  const billedByChild = new Map()
  const absentByChild = new Map()
  for (const r of all) {
    if (!r || !r.child_id || !r.date) continue
    const billed = r.status === 'present' && segmentHours(r) > 0
    const absent = r.status === 'absent'
    if (billed) {
      const set = billedByChild.get(r.child_id) || new Set()
      set.add(r.date)
      billedByChild.set(r.child_id, set)
    }
    if (absent) {
      const set = absentByChild.get(r.child_id) || new Set()
      set.add(r.date)
      absentByChild.set(r.child_id, set)
    }
  }

  const issues = []
  const childIds = new Set([
    ...billedByChild.keys(),
    ...absentByChild.keys(),
  ])

  for (const childId of childIds) {
    const billedDays = billedByChild.get(childId) || new Set()
    const absentDays = absentByChild.get(childId) || new Set()
    // Walk days in absentDays in sorted order, group into consecutive runs
    // where each day in the run has no billed care.
    const sortedAbsent = [...absentDays].sort()
    let runStart = null
    let runEnd = null
    for (const day of sortedAbsent) {
      if (billedDays.has(day)) continue
      if (runEnd && daysBetweenYMD(runEnd, day) === 1) {
        runEnd = day
      } else {
        // Close prior run if it qualifies
        if (runStart && runEnd) {
          maybeFlagRun(runStart, runEnd, childId, period, issues)
        }
        runStart = day
        runEnd = day
      }
    }
    if (runStart && runEnd) {
      maybeFlagRun(runStart, runEnd, childId, period, issues)
    }
  }
  return issues
}

function maybeFlagRun(runStart, runEnd, childId, period, issues) {
  const lengthDays = daysBetweenYMD(runStart, runEnd) + 1
  if (lengthDays < CONSECUTIVE_ABSENCE_DAYS_CAP) return
  // Only flag if the run overlaps the current pay period.
  const overlap = !(runEnd < period.start_date || runStart > period.end_date)
  if (!overlap) return
  issues.push(makeIssue({
    ruleId: RULE.CONSECUTIVE_ABSENCE_DAYS,
    severity: SEVERITY.BLOCKING,
    childId,
    date: runStart,
    message: `Child has ${lengthDays} consecutive absence days with no billed care (${runStart} through ${runEnd}). Cannot exceed ${CONSECUTIVE_ABSENCE_DAYS_CAP} consecutive days without break — billing for this child must pause.`,
    auditCitation: 'CDC LEP Handbook p.16',
  }))
}

// -----------------------------------------------------------------------------
// Rule 6 — billing during school hours (LEP Handbook p.16, Blocking + IPV)
// -----------------------------------------------------------------------------

const DAY_OF_WEEK_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * For each attendance segment of a school-enrolled child, check whether
 * the segment time-range overlaps the bell schedule for that day of
 * week. Behaviour per spec § Rule 6 caveat:
 *   - school_enrolled !== true → rule does not apply
 *   - school_enrolled === true + no bell schedule → warning only
 *   - school_enrolled === true + bell schedule present → blocking on overlap
 */
export function checkBillingDuringSchoolHours({ attendance, children }) {
  const safeRecs = Array.isArray(attendance) ? attendance : []
  const safeKids = Array.isArray(children) ? children : []
  const childById = new Map(safeKids.map(c => [c.id, c]))

  const issues = []
  const seenSchedulelessKids = new Set()  // for the per-child schedule-missing warning

  for (const rec of safeRecs) {
    if (!rec || rec.status !== 'present') continue
    const child = childById.get(rec.child_id)
    if (!child || child.school_enrolled !== true) continue

    const schedule = child.school_bell_schedule_json
    if (!schedule || typeof schedule !== 'object') {
      if (!seenSchedulelessKids.has(child.id)) {
        seenSchedulelessKids.add(child.id)
        issues.push(makeIssue({
          ruleId: RULE.BILLING_DURING_SCHOOL_HOURS,
          severity: SEVERITY.WARNING,
          childId: child.id,
          message: 'Child marked school-age but no school schedule on file. Cannot validate the school-hours billing rule. Add the bell schedule to the child profile.',
          auditCitation: 'CDC LEP Handbook p.16',
        }))
      }
      continue
    }

    // Day-of-week lookup.
    const [yy, mm, dd] = String(rec.date).split('-').map(Number)
    const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay()
    const daySched = schedule[DAY_OF_WEEK_KEYS[dow]]
    if (!daySched || !daySched.start || !daySched.end) continue  // no school that day

    const segStart = parseTimeToHours(rec.check_in)
    const segEnd   = parseTimeToHours(rec.check_out)
    const schStart = parseTimeToHours(daySched.start)
    const schEnd   = parseTimeToHours(daySched.end)
    if (segStart == null || segEnd == null || schStart == null || schEnd == null) continue
    if (segEnd <= segStart) continue  // Rule 7 handles overnight separately

    // Half-open overlap test: [segStart, segEnd) ∩ [schStart, schEnd) ≠ ∅
    const overlap = segStart < schEnd && schStart < segEnd
    if (overlap) {
      issues.push(makeIssue({
        ruleId: RULE.BILLING_DURING_SCHOOL_HOURS,
        severity: SEVERITY.BLOCKING,
        childId: child.id,
        date: rec.date,
        segmentIndex: rec.segment_index ?? 0,
        message: `Attendance ${rec.check_in}–${rec.check_out} overlaps school hours ${daySched.start}–${daySched.end}. Trim to before/after-school portions only.`,
        proposedFix: {
          description: `Trim out the school-hours portion (${daySched.start}–${daySched.end})`,
          action: { kind: 'trim_school_hours', attendanceId: rec.id, schoolStart: daySched.start, schoolEnd: daySched.end },
        },
        auditCitation: 'CDC LEP Handbook p.16 (IPV)',
      }))
    }
  }
  return issues
}

// -----------------------------------------------------------------------------
// Rule 4 — six children concurrent at any timestamp (LEP only;
// LEP Handbook p.7 / p.16, Blocking + IPV)
// -----------------------------------------------------------------------------

const LEP_PROVIDER_TYPES = new Set(['lep_related', 'lep_unrelated'])

/**
 * Sweep-line over (start, end) timestamps from each present attendance
 * segment. If the running concurrent-children count ever exceeds
 * LEP_CONCURRENT_CHILDREN_CAP, emit a single blocking issue tagged
 * with the first date the threshold was crossed.
 *
 * Provider-type gate: licensed providers see no issue here (their own
 * concurrent-children rules differ — the spec defers them).
 */
export function checkConcurrentChildrenCap({ attendance, profile }) {
  const providerType = profile && profile.provider_type
  if (!LEP_PROVIDER_TYPES.has(providerType)) return []

  const safe = Array.isArray(attendance) ? attendance : []
  if (safe.length === 0) return []

  // Build (timestampNumeric, delta, childId, date) events.
  const events = []
  for (const r of safe) {
    if (!r || r.status !== 'present') continue
    const startH = parseTimeToHours(r.check_in)
    const endH = parseTimeToHours(r.check_out)
    if (startH == null || endH == null) continue
    if (endH <= startH) continue  // Rule 7's territory
    // Encode (date as days-since-epoch + time-of-day) into one number so
    // events from different days sort correctly.
    const [yy, mm, dd] = String(r.date).split('-').map(Number)
    const dayMillis = Date.UTC(yy, mm - 1, dd)
    const dayHours = dayMillis / 3600000
    events.push({ t: dayHours + startH, delta: +1, childId: r.child_id, date: r.date, kind: 'in' })
    events.push({ t: dayHours + endH,   delta: -1, childId: r.child_id, date: r.date, kind: 'out' })
  }

  // Sort by timestamp; departures (-1) sort before arrivals (+1) at the
  // same instant — when one child checks out at exactly the moment
  // another checks in, they don't both count as concurrent.
  events.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t
    return a.delta - b.delta
  })

  let concurrent = 0
  let peak = 0
  let peakEvent = null
  for (const e of events) {
    concurrent += e.delta
    if (concurrent > peak) {
      peak = concurrent
      peakEvent = e
    }
  }
  if (peak <= LEP_CONCURRENT_CHILDREN_CAP) return []
  return [makeIssue({
    ruleId: RULE.CONCURRENT_CHILDREN_CAP,
    severity: SEVERITY.BLOCKING,
    date: peakEvent ? peakEvent.date : null,
    message: `Peak of ${peak} children concurrent — exceeds the LEP provider cap of ${LEP_CONCURRENT_CHILDREN_CAP}. Adjust the schedule or reduce billed segments so no more than ${LEP_CONCURRENT_CHILDREN_CAP} children are present at any one time.`,
    auditCitation: 'CDC LEP Handbook p.7 / p.16 (IPV)',
  })]
}

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
