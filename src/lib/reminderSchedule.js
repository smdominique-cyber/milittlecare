// Pure scheduler helpers for the reminder system (PR #15 Half 1).
//
// Three recurrence shapes cover every category in REMINDER_CATEGORIES:
//
//   1. every_n_months  - fixed interval. Fire drills (every 3), radon and
//                        heating inspections (every 48 = 4 years), and
//                        any future "every N months from last" cadence.
//   2. seasonal_window - drill_tornado (two drills in the March-November
//                        window). Returns the next-required occurrence
//                        within the active or upcoming window, or null
//                        if the window is fully satisfied for the year.
//   3. annual          - exactly one year after the last occurrence.
//                        child_annual_review, physician_attestation,
//                        detector_check_overdue, drill_other.
//
// All helpers are pure. `today` is always a YMD string parameter so
// callers can substitute fixed values in tests; the production caller
// supplies `todayYMD()` from `./dates`.

import { todayYMD, daysBetweenYMD, yearOfYMD } from './dates'

const TWO_DIGITS = (n) => String(n).padStart(2, '0')
const ymd = (y, m1, d) => `${y}-${TWO_DIGITS(m1)}-${TWO_DIGITS(d)}`

/**
 * Add `months` calendar months to a YMD string, clamping the day to
 * the destination month's length (so 2026-01-31 + 1 month = 2026-02-28).
 *
 * @param {string} ymdStr   'YYYY-MM-DD'
 * @param {number} months   may be negative
 * @returns {string}
 */
export function addMonthsYMD(ymdStr, months) {
  const [y, m, d] = String(ymdStr).split('-').map(Number)
  // Normalize: month is 1-12 in YMD, 0-11 in Date.
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const ty = target.getUTCFullYear()
  const tm = target.getUTCMonth() + 1
  // Last day of target month for clamping.
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  const td = Math.min(d, lastDay)
  return ymd(ty, tm, td)
}

/**
 * Add `years` calendar years to a YMD string. Feb 29 + 1 year clamps
 * to Feb 28 of the destination year.
 *
 * @param {string} ymdStr
 * @param {number} years
 * @returns {string}
 */
export function addYearsYMD(ymdStr, years) {
  return addMonthsYMD(ymdStr, years * 12)
}

/**
 * Compute the next scheduled occurrence for a recurrence rule.
 *
 * The shape of the returned date depends on `rule.kind`:
 *
 *   { kind: 'every_n_months',
 *     lastPerformedOn: 'YYYY-MM-DD'|null,
 *     intervalMonths: number }
 *     -> lastPerformedOn + intervalMonths (or `today` if never performed)
 *
 *   { kind: 'annual',
 *     lastPerformedOn: 'YYYY-MM-DD'|null }
 *     -> lastPerformedOn + 12 months (or `today` if never performed)
 *
 *   { kind: 'seasonal_window',
 *     windowStartMonth: 3,    // March
 *     windowEndMonth:   11,   // November (inclusive)
 *     requiredCount: 2,
 *     historyInWindow: ['YYYY-MM-DD', ...] }
 *     -> next "must do another drill" date inside the active or
 *        upcoming window, or null if the year's requirement is met.
 *        The naive heuristic: if the window is still active and the
 *        provider is short, return `today`. If the window hasn't
 *        started yet and the provider has 0 drills for the year, return
 *        the first day of the window. If the window is closed and the
 *        provider is short, return `null` (the rule is for the year and
 *        nothing the dispatcher can do retroactively fixes it -
 *        PR #19's getDrillScheduleSummary surfaces the gap).
 *
 * `today` is a YMD; defaults to `todayYMD()`.
 *
 * @param {object} rule
 * @param {string} [today]
 * @returns {string|null}  YMD or null when no occurrence is owed.
 */
export function nextOccurrence(rule, today) {
  if (!rule || typeof rule !== 'object') return null
  const t = today || todayYMD()

  switch (rule.kind) {
    case 'every_n_months': {
      if (!Number.isFinite(rule.intervalMonths) || rule.intervalMonths <= 0) {
        return null
      }
      if (!rule.lastPerformedOn) {
        // Never performed - the next occurrence is "now" (the
        // scheduler is expected to immediately surface this as
        // overdue). Returning `today` keeps the math consistent.
        return t
      }
      return addMonthsYMD(rule.lastPerformedOn, rule.intervalMonths)
    }

    case 'annual': {
      if (!rule.lastPerformedOn) return t
      return addYearsYMD(rule.lastPerformedOn, 1)
    }

    case 'seasonal_window': {
      const startM = Number(rule.windowStartMonth)
      const endM = Number(rule.windowEndMonth)
      const required = Number(rule.requiredCount) || 0
      if (
        !Number.isInteger(startM) || !Number.isInteger(endM) ||
        startM < 1 || startM > 12 || endM < 1 || endM > 12 ||
        required <= 0
      ) {
        return null
      }
      const history = Array.isArray(rule.historyInWindow) ? rule.historyInWindow : []
      const year = yearOfYMD(t)
      const todayMonth = Number(t.slice(5, 7))

      const completedThisYear = history.filter(d => yearOfYMD(d) === year).length
      if (completedThisYear >= required) return null  // year satisfied

      if (todayMonth < startM) {
        // Window upcoming - first chance to do the next drill is the
        // first day of the start month.
        return ymd(year, startM, 1)
      }
      if (todayMonth > endM) {
        // Window closed for the year and the requirement was not met.
        // No schedulable occurrence inside this year; PR #19 surfaces
        // the rule miss elsewhere.
        return null
      }
      // Window active and short - the next occurrence is today (the
      // dispatcher will surface it as "do another now").
      return t
    }

    default:
      return null
  }
}

/**
 * Should the dispatcher fire this reminder right now? Returns true when
 * the underlying due date is within the configured lead window (i.e.
 * `dueAt - today <= leadTimeDays`).
 *
 * Negative deltas (today > dueAt) also return true - an overdue
 * reminder must still fire. The severity helper handles the visual
 * escalation; this helper is purely "is it time?".
 *
 * @param {string} dueAt          YMD of the underlying deadline.
 * @param {number} leadTimeDays   non-negative integer.
 * @param {string} [today]        defaults to todayYMD().
 * @returns {boolean}
 */
export function shouldRemindNow(dueAt, leadTimeDays, today) {
  if (!dueAt) return false
  const lead = Math.max(0, Math.floor(Number(leadTimeDays) || 0))
  const days = daysBetweenYMD(today || todayYMD(), dueAt)
  return days <= lead
}
