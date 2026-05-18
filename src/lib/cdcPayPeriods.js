// Pure helpers for the CDC Pay Period Catalog. No Supabase imports,
// no React. The caller fetches the statewide catalog (rows from
// public.cdc_pay_period_catalog) and passes it in; these functions
// compute the derived state the UI renders.
//
// See docs/cdc_pay_periods_spec.md § 2.4 for the design. Mirrors the
// style of src/lib/miregistry.js.
//
// Catalog row shape (one row from public.cdc_pay_period_catalog):
//   {
//     id:                     uuid,
//     schedule_year:          number,   // 2025, 2026, …
//     period_number:          number,   // 501–526, 601–626, …
//     start_date:             'YYYY-MM-DD',
//     end_date:               'YYYY-MM-DD',
//     reporting_deadline:     'YYYY-MM-DD',
//     deadline_is_4pm:        boolean,
//     expected_payment_date:  'YYYY-MM-DD',
//     payment_may_be_delayed: boolean,
//   }
//
// All catalog columns are plain `date` — there is no time-of-day and
// no timezone math. "Today" is the device's local calendar date
// (spec § 7.6). YYYY-MM-DD strings are lexicographically ordered, so
// string comparison is a correct date comparison.

// -----------------------------------------------------------------------------
// Display-status constants
// -----------------------------------------------------------------------------

// The four date-derived states a period can be in (spec § 2.4). This
// is NOT the billing_periods.status enum — it is computed purely from
// the calendar, never stored.
export const PERIOD_STATUS = Object.freeze({
  UPCOMING:         'upcoming',          // start_date > today
  CURRENT:          'current',           // start_date ≤ today ≤ end_date
  OPEN_FOR_BILLING: 'open_for_billing',  // end_date < today ≤ reporting_deadline
  BILLING_CLOSED:   'billing_closed',    // reporting_deadline < today
})

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Returns today's date in local time as 'YYYY-MM-DD'. Same helper as
 * src/lib/miregistry.js#todayYMD — duplicated rather than shared
 * because extracting a date util touches miregistry.js, out of scope
 * for this PR. Tracked in docs/tech_debt.md.
 *
 * @returns {string}
 */
export function todayYMD() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Whole days between two YYYY-MM-DD strings (b - a). Computed via
 * Date.UTC so a daylight-saving boundary never introduces an
 * off-by-one. Returns a signed integer.
 */
function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = aYmd.split('-').map(Number)
  const [by, bm, bd] = bYmd.split('-').map(Number)
  const aUtc = Date.UTC(ay, am - 1, ad)
  const bUtc = Date.UTC(by, bm - 1, bd)
  return Math.round((bUtc - aUtc) / (1000 * 60 * 60 * 24))
}

/**
 * The calendar date one day after the given YYYY-MM-DD string,
 * returned as a YYYY-MM-DD string. Goes through Date.UTC so month and
 * year roll over correctly (including across leap days).
 */
function nextDayYMD(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  const yyyy = t.getUTCFullYear()
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(t.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isCatalogRow(row) {
  return !!row && !!row.start_date && !!row.end_date
}

// -----------------------------------------------------------------------------
// Public helpers
// -----------------------------------------------------------------------------

/**
 * The pay period whose [start_date, end_date] window contains `today`
 * — both bounds inclusive. Searches the WHOLE catalog regardless of
 * schedule_year, because a period can straddle the year boundary
 * (period 601 covers Dec 28, 2025 – Jan 10, 2026; spec § 7.2).
 *
 * Returns null when no period contains today — by design between the
 * last seeded period and the next year's schedule being published
 * (spec § 7.4). The caller renders the schedule-not-published state.
 *
 * @param {string}   [today]   YYYY-MM-DD; defaults to today (local).
 * @param {object[]} catalog   Catalog rows.
 * @returns {object|null}
 */
export function getCurrentPeriod(today, catalog) {
  const t = today || todayYMD()
  const rows = Array.isArray(catalog) ? catalog : []
  return (
    rows
      .filter(isCatalogRow)
      .find(p => p.start_date <= t && t <= p.end_date) || null
  )
}

/**
 * The pay period with the smallest start_date strictly greater than
 * `today`. Searches the whole catalog (all schedule years). Returns
 * null when today is on or after the last seeded period's start_date.
 *
 * @param {string}   [today]   YYYY-MM-DD; defaults to today (local).
 * @param {object[]} catalog   Catalog rows.
 * @returns {object|null}
 */
export function getNextPeriod(today, catalog) {
  const t = today || todayYMD()
  const rows = Array.isArray(catalog) ? catalog : []
  const future = rows
    .filter(isCatalogRow)
    .filter(p => p.start_date > t)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0))
  return future[0] || null
}

/**
 * The date-derived display status of a single period (spec § 2.4):
 *
 *   'upcoming'         — start_date > today
 *   'current'          — start_date ≤ today ≤ end_date
 *   'open_for_billing' — end_date < today ≤ reporting_deadline
 *   'billing_closed'   — reporting_deadline < today
 *
 * Returns null for a missing period.
 *
 * @param {object} period     A catalog row.
 * @param {string} [today]    YYYY-MM-DD; defaults to today (local).
 * @returns {string|null}     A PERIOD_STATUS value, or null.
 */
export function getPeriodDisplayStatus(period, today) {
  if (!isCatalogRow(period)) return null
  const t = today || todayYMD()
  if (t < period.start_date) return PERIOD_STATUS.UPCOMING
  if (t <= period.end_date) return PERIOD_STATUS.CURRENT
  if (t <= period.reporting_deadline) return PERIOD_STATUS.OPEN_FOR_BILLING
  return PERIOD_STATUS.BILLING_CLOSED
}

/**
 * Whole days from `today` until the period's reporting_deadline.
 * Positive when the deadline is in the future ("N days left"), 0 on
 * the deadline day, negative once it has passed. Returns null for a
 * missing period.
 *
 * @param {object} period     A catalog row.
 * @param {string} [today]    YYYY-MM-DD; defaults to today (local).
 * @returns {number|null}
 */
export function getDeadlineCountdown(period, today) {
  if (!isCatalogRow(period) || !period.reporting_deadline) return null
  const t = today || todayYMD()
  return daysBetweenYMD(t, period.reporting_deadline)
}

/**
 * Contiguity check over the catalog (spec § 7.5). Ordered by
 * start_date, every period's start_date must be exactly the previous
 * period's end_date + 1 day — no gaps, no overlaps, including across
 * the schedule-year boundary (period 526 → 601).
 *
 * Returns an array of problem descriptions; an empty array means the
 * catalog is contiguous. Used by the Vitest seed-data test so a
 * transcription error in Appendix A fails loudly before production.
 *
 * @param {object[]} catalog   Catalog rows.
 * @returns {{ afterPeriod: number, beforePeriod: number,
 *             expectedStart: string, actualStart: string }[]}
 */
export function findCatalogContiguityGaps(catalog) {
  const rows = (Array.isArray(catalog) ? catalog : [])
    .filter(isCatalogRow)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0))

  const gaps = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const curr = rows[i]
    const expectedStart = nextDayYMD(prev.end_date)
    if (curr.start_date !== expectedStart) {
      gaps.push({
        afterPeriod: prev.period_number,
        beforePeriod: curr.period_number,
        expectedStart,
        actualStart: curr.start_date,
      })
    }
  }
  return gaps
}
