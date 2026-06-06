// Compliance Engine Phase 3 — pure gate helper for the
// Compliance Checklist surface visibility.
//
// Three places gate the same logical condition:
//   - Sidebar.jsx — whether to render the "Compliance Checklist" item.
//   - ComplianceChecklistPage.jsx — whether to render the page or
//     redirect away.
//   - FamilyComplianceTab inside FamiliesPage.jsx — whether to render
//     the per-family Compliance tab button + body.
//
// All three must agree. This module is the single source of truth.
//
// The gate has THREE outcomes (not just visible/hidden) because the
// PAGE uses it for routing decisions where "loading" is structurally
// different from "denied":
//
//   - 'loading'           — the data needed to decide hasn't arrived yet.
//                           Page MUST render a loading state; redirecting
//                           during loading is the Phase-3-live-gate bug
//                           that motivated this helper.
//   - 'redirect_dashboard'— provider is not a licensed home. Page should
//                           navigate to /dashboard. (Sidebar simply hides
//                           the item; same effective outcome, different
//                           rendering.)
//   - 'redirect_optin'    — provider IS a licensed home but hasn't
//                           opted in. Page should navigate to the
//                           BusinessInfo applicability section so they
//                           can flip the toggle. (Sidebar hides; tab
//                           hides.)
//   - 'allowed'           — render the surface.
//
// §2a aside: the gate has NOTHING to do with applicability resolution.
// It's only about whether the provider sees the surfaces. The engine's
// §2a invariant — never silently resolve a regulatory requirement to
// not_applicable — is enforced inside the engine itself and is
// independent of this surface gate.

import { MODULE_KEYS } from './modules'

export const CHECKLIST_GATE = Object.freeze({
  LOADING:             'loading',
  REDIRECT_DASHBOARD:  'redirect_dashboard',
  REDIRECT_OPTIN:      'redirect_optin',
  ALLOWED:             'allowed',
})

/**
 * @param {object} args
 * @param {boolean} args.loading        useActiveModules().loading
 * @param {Set<string>|null} args.modules  useActiveModules().modules
 * @param {object|null} args.profile    useActiveModules().profile
 *                                      Must include program_settings
 *                                      (the Phase 3 build-bug fix:
 *                                      FamiliesPage's licenseeProfile
 *                                      SELECT was missing this column,
 *                                      so always-undefined flag → tab
 *                                      always hidden).
 * @returns {'loading'|'redirect_dashboard'|'redirect_optin'|'allowed'}
 */
export function resolveComplianceChecklistGate({
  // Defaults reflect the safe failure mode: when a caller hasn't
  // populated these yet, assume loading. The page must NOT fire
  // <Navigate /> against partial state — that was the Phase 3 bug
  // this whole helper exists to prevent.
  loading = true,
  modules,
  profile,
} = {}) {
  // Loading takes precedence. While true, the modules Set is the
  // initial-render placeholder ({core}) and the profile is null —
  // neither carries enough information to decide. The page MUST wait.
  if (loading) return CHECKLIST_GATE.LOADING

  // Licensed-home check via the module (which keys on license_type
  // IN ('family_home', 'group_home') per src/lib/modules.js:125-128).
  // LEPs and providers who haven't picked a license_type fall here.
  if (!modules || !modules.has || !modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)) {
    return CHECKLIST_GATE.REDIRECT_DASHBOARD
  }

  // Opt-in flag — Phase 3 decision #8. Absent / falsy → not opted in
  // → redirect the page to BusinessInfo where the toggle lives.
  const optedIn =
    profile && profile.program_settings &&
    profile.program_settings.compliance_checklist_enabled === true
  if (!optedIn) return CHECKLIST_GATE.REDIRECT_OPTIN

  return CHECKLIST_GATE.ALLOWED
}

/**
 * Convenience boolean for Sidebar + FamilyComplianceTab — they don't
 * distinguish the two redirect reasons, they just hide the item.
 * Returns true ONLY when the gate resolves to 'allowed'. Loading,
 * redirect_dashboard, and redirect_optin all return false.
 *
 * This matches the Sidebar's existing behavior (hide while not yet
 * confirmed); the page must still call `resolveComplianceChecklistGate`
 * because it needs to distinguish loading from denied.
 */
export function isComplianceChecklistVisible({ loading, modules, profile } = {}) {
  return resolveComplianceChecklistGate({ loading, modules, profile }) === CHECKLIST_GATE.ALLOWED
}
