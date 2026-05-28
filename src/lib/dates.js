// Shared date helpers — pure, no side effects, no I/O, no React, no Supabase.
//
// Extracted from `src/lib/cdcProviderCompliance.js` in PR #15 Half 1 as the
// standing tech-debt cleanup flagged by docs/tech_debt.md § "Deferred work
// introduced by PR #6". `cdcPayPeriods.js`, `staffTraining.js`,
// `miregistry.js`, and `cdcAuthorization.js` still hold their own
// inline copies — consolidating those is a follow-up extraction
// deliberately out of scope for PR #15 (the prompt says: "keep
// cdcProviderCompliance.js behavior identical (its existing tests must
// still pass unchanged)"). The other files should migrate to this
// module on each one's next PR-of-opportunity.
//
// All helpers operate on 'YYYY-MM-DD' (YMD) strings rather than Date
// objects so the math is timezone-independent and stays deterministic
// when chained with the cdcProviderCompliance / reminder system pure
// helpers that take `today` as a parameter for tests.

/**
 * Today's local date as 'YYYY-MM-DD'.
 *
 * Uses the local timezone (i.e. the browser / Node process timezone)
 * by construction. Callers that need to inject a deterministic value
 * for tests should not call this — they should pass a YMD literal as
 * their `today` parameter directly.
 *
 * @returns {string}
 */
export function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Whole days from `aYmd` to `bYmd` (b − a); signed.
 *
 * Uses `Date.UTC` to avoid DST shifts that would otherwise produce
 * fractional-day deltas during the spring-forward / fall-back hours.
 *
 * @param {string} aYmd   'YYYY-MM-DD'
 * @param {string} bYmd   'YYYY-MM-DD'
 * @returns {number}      Integer day difference, may be negative.
 */
export function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = String(aYmd).split('-').map(Number)
  const [by, bm, bd] = String(bYmd).split('-').map(Number)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  )
}

/**
 * Extract the year (YYYY) from a YMD string as an integer.
 *
 * Implemented via string slicing — not `new Date(ymd).getFullYear()` —
 * to avoid the timezone surprises that bite when the host TZ is far
 * from UTC (a YMD-only string can be parsed as midnight UTC and shift
 * to the previous day's year locally).
 *
 * @param {string} ymd
 * @returns {number}
 */
export function yearOfYMD(ymd) {
  return Number(String(ymd).slice(0, 4))
}
