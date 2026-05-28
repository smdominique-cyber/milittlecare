// Generalized severity ladder for the reminder system (PR #15 Half 1).
//
// Lifts the same five-rung ladder from `cdcProviderCompliance.js`
// (info -> warning -> urgent -> critical -> expired) so every category
// in REMINDER_CATEGORIES gets the same banner treatment. Per-category
// override is via the catalog's optional `severity_thresholds` field.
//
// Threshold semantics (matches cdcProviderCompliance.js's existing
// TRAINING_LADDER exactly when called with that constant's values):
//
//   daysUntilDue >  info_threshold     -> null    (no banner)
//   daysUntilDue >  warning_threshold  -> 'info'
//   daysUntilDue >  urgent_threshold   -> 'warning'
//   daysUntilDue >  critical_threshold -> 'urgent'
//   daysUntilDue >= 0                  -> 'critical'
//   daysUntilDue <  0                  -> 'expired'
//
// Defaults below are the TRAINING_LADDER defaults: info > 45 means no
// banner; critical = 0-6 days remaining. PR #15's category catalog
// overrides per-category by passing the entry's `severity_thresholds`
// to `getSeverity(daysUntilDue, customThresholds)`.

import { daysBetweenYMD, todayYMD } from './dates'

/**
 * Threshold values are inclusive **upper bounds** for each
 * severity. A `daysUntilDue` strictly greater than `info` returns
 * null; equal to or less than `info` (but greater than `warning`)
 * returns 'info'; and so on. `critical` is the largest day count
 * still considered "critical" (default 6 days, matching the
 * cdcProviderCompliance ladder).
 */
export const DEFAULT_SEVERITY_THRESHOLDS = Object.freeze({
  info: 45,
  warning: 30,
  urgent: 15,
  critical: 6,
})

export const SEVERITIES = Object.freeze(
  ['info', 'warning', 'urgent', 'critical', 'expired']
)

/**
 * Compute the severity rung for a given day count.
 *
 * @param {number} daysUntilDue   Signed days remaining; negative means
 *                                 the deadline has passed.
 * @param {object} [customThresholds]   Partial override; merged onto
 *                                 DEFAULT_SEVERITY_THRESHOLDS.
 * @returns {'info'|'warning'|'urgent'|'critical'|'expired'|null}
 */
export function getSeverity(daysUntilDue, customThresholds) {
  if (!Number.isFinite(daysUntilDue)) return null
  const t = { ...DEFAULT_SEVERITY_THRESHOLDS, ...(customThresholds || {}) }
  if (daysUntilDue < 0) return 'expired'
  if (daysUntilDue > t.info) return null
  if (daysUntilDue > t.warning) return 'info'
  if (daysUntilDue > t.urgent) return 'warning'
  if (daysUntilDue > t.critical) return 'urgent'
  return 'critical'  // 0 <= daysUntilDue <= t.critical
}

/**
 * Convenience: given a due date and (optionally) a today YMD, return
 * the severity rung. Saves callers the daysBetweenYMD step.
 *
 * @param {string} dueAt           YMD.
 * @param {object} [customThresholds]
 * @param {string} [today]         YMD; defaults to todayYMD().
 * @returns {string|null}
 */
export function getSeverityForDueDate(dueAt, customThresholds, today) {
  if (!dueAt) return null
  const days = daysBetweenYMD(today || todayYMD(), dueAt)
  return getSeverity(days, customThresholds)
}
