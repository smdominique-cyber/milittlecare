// Pure helpers for CDC provider-level compliance countdowns.
//
// Two surfaces:
//   - Annual Ongoing Training (R 400.1924) — every license-exempt
//     provider must complete the Michigan Ongoing Health & Safety
//     Refresher by December 16 each year. Missing the deadline closes
//     the provider's account (CDC Scholarship Handbook for License
//     Exempt Providers, Rev. 4/1/2026, p.12; also CLAUDE.md § Critical
//     Domain Knowledge).
//   - Fingerprint reprint window — License-Exempt Unrelated providers
//     need a fresh background-check fingerprint submission every five
//     years. The spec gates the "reminder" banner at >4.5 years old
//     and the "urgent" banner at >5 years.
//
// Both functions are pure: pass values in, get a banner state out.
// `today` is a parameter so tests are deterministic, matching the
// pattern in src/lib/staffTraining.js / src/lib/miregistry.js.

import { todayYMD, daysBetweenYMD, yearOfYMD } from './dates'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Annual training deadline anchor.
export const ANNUAL_TRAINING_DEADLINE_MONTH = 12   // December
export const ANNUAL_TRAINING_DEADLINE_DAY = 16

// Fingerprint window in days. 365.25 days/year averages over leap
// years closely enough for a UI gating threshold.
const FINGERPRINT_REMINDER_DAYS = Math.floor(4.5 * 365.25)  // 1643
const FINGERPRINT_URGENT_DAYS = Math.floor(5 * 365.25)      // 1826

// Annual training severity ladder — days-remaining thresholds before
// Dec 16. Mirrors the spec § PR #8.5c Step 5 pseudocode.
const TRAINING_LADDER = Object.freeze([
  { maxDays: 45,    severity: null },                                  // > 45 days out: no banner
  { maxDays: 30,    severity: 'info' },                                // 31–45 days: heads-up
  { maxDays: 15,    severity: 'warning' },                             // 16–30 days
  { maxDays:  6,    severity: 'urgent' },                              // 7–15 days
  { maxDays:  0,    severity: 'critical' },                            // 0–6 days
])

// Provider-type values for which the fingerprint reprint check
// applies. Spec § PR #8.5c: "only for LEP-Unrelated providers".
const FINGERPRINT_PROVIDER_TYPES = new Set(['lep_unrelated'])

// Date helpers (`todayYMD`, `daysBetweenYMD`, `yearOfYMD`) live in
// `src/lib/dates.js` as of PR #15 Half 1. Previously inline here and
// duplicated across miregistry.js / cdcPayPeriods.js / staffTraining.js /
// cdcAuthorization.js — see docs/tech_debt.md § "Deferred work
// introduced by PR #6". The other duplicates remain (out of scope for
// this PR per its prompt) and will migrate on each module's next
// PR-of-opportunity.

// `todayYMD` is re-exported so any caller previously importing it from
// here keeps working without changing its import path. New code should
// import directly from `./dates`.
export { todayYMD }

// -----------------------------------------------------------------------------
// Annual Ongoing Training (CDC Scholarship Handbook for LEP, p.12)
// -----------------------------------------------------------------------------

/**
 * Banner state for the annual Dec 16 training deadline.
 *
 * Returns null when no banner is warranted (already completed this
 * year, or the deadline is still > 45 days out). Otherwise returns a
 * `{ severity, label, daysUntilDeadline }` object the dashboard binds
 * to a tinted banner — severity controls the colour, label controls
 * the copy.
 *
 * Behaviour after Dec 16 (deadline passed without completion this
 * year): returns `{ severity: 'expired', ... }` for the remainder of
 * the calendar year. The handbook says a missed Dec 16 closes the
 * account and requires reapplication with MDHHS — the banner reflects
 * urgency but the actual account state is MDHHS-side and not modelled
 * here. On Jan 1 of the next year, the deadline-clock resets to the
 * new year's Dec 16; a provider who lapsed will see no banner until
 * the run-up to the new deadline. This matches the spec's pseudocode;
 * a richer "you missed last year's deadline" state would need MDHHS
 * status integration.
 *
 * @param {string|null} completedDate  Most recent annual-training
 *                                     completion as 'YYYY-MM-DD'.
 * @param {string}      [today]        'YYYY-MM-DD'; defaults to today.
 * @returns {null | {
 *   severity: 'info'|'warning'|'urgent'|'critical'|'expired',
 *   label: string,
 *   daysUntilDeadline: number,
 * }}
 */
export function getAnnualTrainingDeadlineState(completedDate, today) {
  const todayStr = today || todayYMD()
  const todayYear = yearOfYMD(todayStr)

  // Completed this calendar year? Nothing to nag about.
  if (completedDate && yearOfYMD(completedDate) === todayYear) return null

  const deadlineStr =
    `${todayYear}-${String(ANNUAL_TRAINING_DEADLINE_MONTH).padStart(2, '0')}-${String(ANNUAL_TRAINING_DEADLINE_DAY).padStart(2, '0')}`
  const daysUntilDeadline = daysBetweenYMD(todayStr, deadlineStr)

  if (daysUntilDeadline < 0) {
    return {
      severity: 'expired',
      label: 'Annual training overdue — provider status at risk',
      daysUntilDeadline,
    }
  }
  if (daysUntilDeadline > 45) return null
  if (daysUntilDeadline > 30) {
    return { severity: 'info', label: `Annual training due Dec 16 (${daysUntilDeadline} days)`, daysUntilDeadline }
  }
  if (daysUntilDeadline > 15) {
    return { severity: 'warning', label: `Annual training due in ${daysUntilDeadline} days`, daysUntilDeadline }
  }
  if (daysUntilDeadline > 6) {
    return {
      severity: 'urgent',
      label: `Annual training due in ${daysUntilDeadline} days — provider closed if missed`,
      daysUntilDeadline,
    }
  }
  return {
    severity: 'critical',
    label: `Annual training due in ${daysUntilDeadline} day${daysUntilDeadline === 1 ? '' : 's'} — you will lose your provider status`,
    daysUntilDeadline,
  }
}

// -----------------------------------------------------------------------------
// Fingerprint reprint window (LEP-Unrelated)
// -----------------------------------------------------------------------------

/**
 * Banner state for fingerprint reprint, only meaningful for
 * License-Exempt Unrelated providers. Reminder at >4.5 years old;
 * urgent at >5 years old.
 *
 * Returns null when no banner is warranted (provider type doesn't
 * require it, fingerprint date unknown, or fingerprint still fresh).
 *
 * @param {string|null} fingerprintDate  Date of the most recent
 *                                       fingerprint submission as
 *                                       'YYYY-MM-DD'.
 * @param {string|null} providerType     One of the
 *                                       provider_type enum values
 *                                       (`lep_related`, `lep_unrelated`,
 *                                       `licensed_family`,
 *                                       `licensed_group`,
 *                                       `licensed_center`).
 * @param {string}      [today]          'YYYY-MM-DD'; defaults to today.
 * @returns {null | {
 *   severity: 'reminder'|'urgent',
 *   label: string,
 *   ageDays: number,
 * }}
 */
export function getFingerprintReprintState(fingerprintDate, providerType, today) {
  if (!FINGERPRINT_PROVIDER_TYPES.has(providerType)) return null
  if (!fingerprintDate) return null

  const ageDays = daysBetweenYMD(fingerprintDate, today || todayYMD())
  if (ageDays < FINGERPRINT_REMINDER_DAYS) return null

  if (ageDays < FINGERPRINT_URGENT_DAYS) {
    return {
      severity: 'reminder',
      label: 'Fingerprint reprint due within 6 months — schedule with MDHHS',
      ageDays,
    }
  }
  return {
    severity: 'urgent',
    label: 'Fingerprint reprint overdue — your background-check eligibility may lapse',
    ageDays,
  }
}

// Internal thresholds exported for tests so the day-count math is
// verifiable without re-deriving from 365.25 × N.
export const __TEST_THRESHOLDS__ = Object.freeze({
  FINGERPRINT_REMINDER_DAYS,
  FINGERPRINT_URGENT_DAYS,
  TRAINING_LADDER,
})
