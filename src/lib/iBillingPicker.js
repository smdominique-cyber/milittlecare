// Pure helpers for the I-Billing Screen 1 picker (PR #9).
//
// Kept out of the JSX file so the candidate-filtering logic is testable
// without a DOM. The picker component imports these and renders.

import {
  getPeriodDisplayStatus,
  getDeadlineCountdown,
  PERIOD_STATUS,
} from './cdcPayPeriods'

/**
 * True iff at least one of the provider's CDC funding sources has an
 * authorization window overlapping the given period's
 * [start_date, end_date]. Typed columns preferred; falls back to
 * `details.X` for pre-PR #8.5b legacy rows. Archived rows excluded.
 *
 * @param {object}   period           Catalog row.
 * @param {object[]} fundingSources   Provider's funding_sources rows.
 * @returns {boolean}
 */
export function periodOverlapsAnyCdc(period, fundingSources) {
  if (!period || !Array.isArray(fundingSources)) return false
  if (!period.start_date || !period.end_date) return false
  for (const fs of fundingSources) {
    if (!fs || fs.archived_at) continue
    if (fs.type !== 'cdc_scholarship') continue
    const start = fs.authorization_start || (fs.details && fs.details.authorization_start) || null
    const end   = fs.authorization_end   || (fs.details && fs.details.authorization_end)   || null
    if (start && start > period.end_date) continue
    if (end   && end   < period.start_date) continue
    return true
  }
  return false
}

/**
 * Used to sort candidate periods so the action a provider most likely
 * wants ("submit my just-closed period") floats to the top.
 *   open_for_billing → 3 (the natural call-to-action)
 *   current          → 2 (in-progress; the picker shows it for
 *                         transparency but the provider can't submit yet)
 *   billing_closed   → 1 (visible only as "you missed this")
 *   anything else    → 0 (not rendered)
 */
export function statusRank(status) {
  if (status === PERIOD_STATUS.OPEN_FOR_BILLING) return 3
  if (status === PERIOD_STATUS.CURRENT)          return 2
  if (status === PERIOD_STATUS.BILLING_CLOSED)   return 1
  return 0
}

/**
 * Build the picker's candidate list from the statewide catalog +
 * provider's funding sources. Filters to periods that:
 *   (a) overlap at least one CDC funding source the provider has, and
 *   (b) are CURRENT, OPEN_FOR_BILLING, or BILLING_CLOSED
 *       (closed appears for visibility; the picker disables it).
 * Sorted: open_for_billing first, then current, then closed (most
 * recent closed first).
 *
 * @param {object}   args
 * @param {object[]} args.catalog
 * @param {object[]} args.fundingSources
 * @param {string}   [args.today]   'YYYY-MM-DD'
 * @returns {{ period: object, status: string, countdown: number|null }[]}
 */
export function buildPickerCandidates({ catalog, fundingSources, today }) {
  const safe = Array.isArray(catalog) ? catalog : []
  return safe
    .filter(p => periodOverlapsAnyCdc(p, fundingSources))
    .map(p => ({
      period:    p,
      status:    getPeriodDisplayStatus(p, today),
      countdown: getDeadlineCountdown(p, today),
    }))
    .filter(c => c.status === PERIOD_STATUS.CURRENT
              || c.status === PERIOD_STATUS.OPEN_FOR_BILLING
              || c.status === PERIOD_STATUS.BILLING_CLOSED)
    .sort((a, b) =>
      statusRank(b.status) - statusRank(a.status)
      || (a.period.start_date < b.period.start_date ? 1 : -1)
    )
}
