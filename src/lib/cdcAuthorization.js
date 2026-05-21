// Pure helpers for CDC funding-source authorization lifecycle.
//
// Used by the funding sources list, the child profile, and the dashboard
// summary widget to render expiration-aware badges on each CDC
// authorization. Schema is in flight: PR #8.5b promotes
// `authorization_end` from `funding_sources.details` JSON to a typed
// top-level column. These helpers tolerate both shapes — read the
// typed column first, fall back to JSON for rows that haven't been
// rewired yet.
//
// No Supabase imports, no React. Pass the funding-source row in, get a
// pure display-state object back. Same pattern as
// `src/lib/staffTraining.js` and `src/lib/miregistry.js`; date math
// goes through `Date.UTC` to dodge DST off-by-ones.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Window for the "Expiring" badge. Mirrors the spec § PR #8.5b acceptance
// criterion ("≤30 days = 'Expiring'") and the existing
// EXPIRING_SOON_WINDOW_DAYS = 60 in staffTraining.js — different number
// because the regulatory urgency is different (a CDC authorization
// expiring in <30 days threatens billing; a CPR card expiring in <60
// days threatens role compliance).
export const EXPIRING_WINDOW_DAYS = 30

// Lifecycle states that do not depend on date math — these short-circuit
// before authorization_end is consulted. Status values come from the
// `funding_source_status` enum after the PR #8.5b additive expansion
// (`pending`, `terminated`, `renewed` are new; `active`, `paused`,
// `ended` predate this PR).
const STATIC_STATES = Object.freeze({
  pending:    { label: 'Pending',    color: 'gray' },
  terminated: { label: 'Terminated', color: 'red' },
  renewed:    { label: 'Renewed',    color: 'blue' },
})

// -----------------------------------------------------------------------------
// Internal date helpers
//
// Duplicated from miregistry.js / cdcPayPeriods.js / staffTraining.js —
// see docs/tech_debt.md § "Deferred work introduced by PR #6" for the
// standing note to lift these into src/lib/dates.js.
// -----------------------------------------------------------------------------

/** Today's local date as 'YYYY-MM-DD'. */
export function todayYMD() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Whole days from aYmd to bYmd (b - a); signed. Date.UTC dodges DST. */
function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = String(aYmd).split('-').map(Number)
  const [by, bm, bd] = String(bYmd).split('-').map(Number)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  )
}

/**
 * Read `authorization_end` from the row, preferring the typed column
 * (post-PR #8.5b) and falling back to `details.authorization_end`
 * (pre-PR #8.5b, legacy rows). Returns a 'YYYY-MM-DD' string or null.
 */
function readAuthorizationEnd(fundingSource) {
  if (!fundingSource) return null
  if (fundingSource.authorization_end) return fundingSource.authorization_end
  const detailsValue = fundingSource.details && fundingSource.details.authorization_end
  return detailsValue || null
}

// -----------------------------------------------------------------------------
// Public helper
// -----------------------------------------------------------------------------

/**
 * Lifecycle display state for one CDC funding source (spec § PR #8.5b
 * Step 5). Returns a plain object the UI binds directly to a badge.
 *
 * State shape:
 *   - { label: 'Pending'    | 'Terminated' | 'Renewed', color }
 *   - { label: 'Expired',  color: 'red',    daysOverdue:  N }
 *   - { label: 'Expiring', color: 'yellow', daysRemaining: N }   // N ≤ 30
 *   - { label: 'Active',   color: 'green',  daysRemaining: N }   // N >  30
 *   - { label: <status>,   color: 'gray' }                       // no end date
 *
 * The function is pure: it consults no clock unless `today` is omitted,
 * which makes it test-deterministic in the staffTraining.js pattern.
 *
 * @param {object} fundingSource A `funding_sources` row.
 * @param {string} [today]       'YYYY-MM-DD'; defaults to today's local date.
 * @returns {{
 *   label: string,
 *   color: 'gray' | 'red' | 'yellow' | 'green' | 'blue',
 *   daysRemaining?: number,
 *   daysOverdue?: number,
 * }}
 */
export function getLifecycleDisplayState(fundingSource, today) {
  if (!fundingSource) return { label: 'Unknown', color: 'gray' }

  const status = fundingSource.status
  if (STATIC_STATES[status]) return STATIC_STATES[status]

  const authEnd = readAuthorizationEnd(fundingSource)
  if (!authEnd) return { label: status || 'Unknown', color: 'gray' }

  const todayStr = today || todayYMD()
  const daysUntilEnd = daysBetweenYMD(todayStr, authEnd)

  if (daysUntilEnd < 0) {
    return { label: 'Expired', color: 'red', daysOverdue: -daysUntilEnd }
  }
  if (daysUntilEnd <= EXPIRING_WINDOW_DAYS) {
    return { label: 'Expiring', color: 'yellow', daysRemaining: daysUntilEnd }
  }
  return { label: 'Active', color: 'green', daysRemaining: daysUntilEnd }
}
