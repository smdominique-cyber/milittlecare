// Pure helpers for the parent portal surface. Tiny on purpose — the
// dashboard is a 900-line page; pulling out the two branching
// expressions that drive header branding + the password-banner gate
// keeps the unit tests focused on the logic the road-to-publishable
// doc flagged.

// -----------------------------------------------------------------------------
// Branding header — provider name fallback chain
// -----------------------------------------------------------------------------
//
// 2026-06-15 — Part 1 of the parent-portal-branding-and-banners PR.
// Before this PR, the parent dashboard header read a hardcoded "MI
// Little Care." After this PR it reads the provider's `daycare_name`,
// matching the same fallback chain the email-sender uses
// (`api/send-invitation.js:152`) so a parent sees the SAME name in
// their email and in the portal header.
//
// Fallback order (verbatim from send-invitation.js):
//   1. `provider.daycare_name`  — provider's chosen public name.
//   2. `provider.full_name`     — fallback if daycare_name is unset.
//   3. `'Your provider'`        — last-resort string so the header is
//                                 never empty. Was `'Your child care
//                                 provider'` in the email sender; the
//                                 parent dashboard already shipped
//                                 with `'Your provider'` as its
//                                 in-page fallback for the same
//                                 expression. Keep that exact wording
//                                 here so this helper is a drop-in.

export const PARENT_PORTAL_PROVIDER_NAME_FALLBACK = 'Your provider'

/**
 * Resolve the name to show in the parent portal header (and anywhere
 * else that wants "the provider's chosen name, gracefully degraded").
 *
 * @param {object|null} provider  A profiles-row-shaped object, or null.
 *                                Reads `daycare_name` + `full_name`.
 * @returns {string} Non-empty name string. Never null / undefined /
 *                   empty — the fallback ensures the caller can
 *                   render it directly.
 */
export function resolveParentPortalProviderName(provider) {
  if (!provider) return PARENT_PORTAL_PROVIDER_NAME_FALLBACK
  const dc = (typeof provider.daycare_name === 'string') ? provider.daycare_name.trim() : ''
  if (dc) return dc
  const fn = (typeof provider.full_name === 'string') ? provider.full_name.trim() : ''
  if (fn) return fn
  return PARENT_PORTAL_PROVIDER_NAME_FALLBACK
}

// -----------------------------------------------------------------------------
// Password-banner gate — preserve the unknown state
// -----------------------------------------------------------------------------
//
// 2026-06-15 — Part 2 of the parent-portal-branding-and-banners PR.
// CONFIRMED cause of the spurious banner fires (not what
// road-to-publishable.md guessed): `parent_profiles.has_password` is
// ONLY written `true` by `ParentDashboardPage`'s "Set a password"
// form (line 342). It is NEVER written during signup. Every parent
// who signed up with a password via `LoginPage` has a working
// `auth.users.encrypted_password` but a NULL
// `parent_profiles.has_password` — and the pre-fix
// `setHasPassword(!!data?.has_password)` collapsed null → false, then
// the gate `hasPassword === false` matched, firing the banner for a
// parent who genuinely had a password.
//
// The fix preserves the three-way state: TRUE / FALSE / UNKNOWN.
// `false` is reserved for the explicit-no case (never written today,
// but the column type supports it); `null` means "we don't know"
// and is the default for parents who haven't gone through the
// dashboard form yet — including the bulk of legacy parents who
// DID set a password during signup. The dashboard's "Set a password"
// menu item (line 858 / 941) remains the affordance for any parent
// who legitimately needs to add one. Hiding the banner on UNKNOWN
// is the safer default than firing it spuriously, and matches the
// task brief: "show ONLY when the parent genuinely has not set a
// password."
//
// Three-state design recorded here so a future reader can see the
// branching at a glance without re-tracing the bug.

export const PASSWORD_BANNER_STATE = Object.freeze({
  HAS_PASSWORD:           'has_password',          // hide banner
  EXPLICITLY_NO_PASSWORD: 'explicitly_no_password', // show banner
  UNKNOWN:                'unknown',               // hide banner (safer default)
})

/**
 * Derive the password-banner state from a parent_profiles row.
 *
 * @param {object|null} parentProfileRow  A `parent_profiles` row, or null
 *                                        (no row → UNKNOWN).
 * @returns {PASSWORD_BANNER_STATE[keyof PASSWORD_BANNER_STATE]}
 */
export function resolveHasPasswordState(parentProfileRow) {
  if (!parentProfileRow) return PASSWORD_BANNER_STATE.UNKNOWN
  const v = parentProfileRow.has_password
  if (v === true) return PASSWORD_BANNER_STATE.HAS_PASSWORD
  if (v === false) return PASSWORD_BANNER_STATE.EXPLICITLY_NO_PASSWORD
  // null / undefined / column missing / anything else → unknown.
  return PASSWORD_BANNER_STATE.UNKNOWN
}

/**
 * Convenience: should the password banner render? Hides on UNKNOWN
 * to fix the spurious-fire bug.
 *
 * @param {PASSWORD_BANNER_STATE[keyof PASSWORD_BANNER_STATE]} state
 * @returns {boolean}
 */
export function shouldShowPasswordBanner(state) {
  return state === PASSWORD_BANNER_STATE.EXPLICITLY_NO_PASSWORD
}
