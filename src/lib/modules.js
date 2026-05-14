// Module activation logic for the funding-source-driven feature gating
// system. See docs/funding_source_spec.md for the design rationale.
//
// Pure function: no React, no Supabase, no I/O. Callers fetch the
// provider's profile and active funding sources, then pass them in.
// The result is a Set of module keys the UI should expose.

export const MODULE_KEYS = Object.freeze({
  CORE: 'core',
  CDC: 'cdc',
  TRI_SHARE: 'tri_share',
  GSRP: 'gsrp',
  HEAD_START: 'head_start',
  AGENCY_BILLING: 'agency_billing',
  MIREGISTRY_TRACKER: 'miregistry_tracker',
  LICENSED_COMPLIANCE: 'licensed_compliance',
  LICENSE_EXEMPT_COMPLIANCE: 'license_exempt_compliance',
  CACFP: 'cacfp',
})

// Funding source type -> auto-activated module key.
// private_pay is intentionally absent: it is the default, not a module.
const TYPE_TO_MODULE = Object.freeze({
  cdc_scholarship: MODULE_KEYS.CDC,
  tri_share: MODULE_KEYS.TRI_SHARE,
  gsrp: MODULE_KEYS.GSRP,
  head_start: MODULE_KEYS.HEAD_START,
  agency_other: MODULE_KEYS.AGENCY_BILLING,
})

// Modules whose program_settings entry takes 'auto' | 'force_on' | 'force_off'.
const GATEABLE_MODULE_KEYS = Object.freeze([
  MODULE_KEYS.CDC,
  MODULE_KEYS.TRI_SHARE,
  MODULE_KEYS.GSRP,
])

/**
 * Returns the set of active module keys for a provider.
 *
 * @param {object}   args
 * @param {object}   args.profile         The provider's profiles row.
 * @param {object[]} args.fundingSources  Flat array of the provider's
 *                                        funding_sources rows (any
 *                                        attachment, family- or child-keyed).
 * @returns {Set<string>}
 *
 * A funding source counts as active iff status === 'active' AND
 * archived_at is null.
 */
export function getActiveModules({ profile, fundingSources } = {}) {
  // Destructuring defaults only apply to undefined, not null — coerce both.
  const safeProfile = profile || {}
  const safeSources = fundingSources || []

  const modules = new Set([MODULE_KEYS.CORE])
  const settings = safeProfile.program_settings || {}

  const activeTypes = new Set(
    safeSources
      .filter(s => s && s.status === 'active' && !s.archived_at)
      .map(s => s.type)
  )

  for (const type of activeTypes) {
    const moduleKey = TYPE_TO_MODULE[type]
    if (moduleKey) modules.add(moduleKey)
  }

  for (const key of GATEABLE_MODULE_KEYS) {
    const setting = settings[key]
    if (setting === 'force_on') modules.add(key)
    else if (setting === 'force_off') modules.delete(key)
  }

  // miregistry_tracker: active iff a MiRegistry ID is on file OR the
  // provider is license-exempt. License-exempt providers get the
  // tracker even before they enter their ID so the empty-state page
  // can prompt them for it (chicken-and-egg: without auto-activation,
  // a brand-new license-exempt provider would never see the screen
  // that asks for the ID). See miregistry_tracker_spec.md § 4.
  if (
    safeProfile.miregistry_id ||
    safeProfile.is_license_exempt === true
  ) {
    modules.add(MODULE_KEYS.MIREGISTRY_TRACKER)
  }
  if (safeProfile.michigan_license_number) modules.add(MODULE_KEYS.LICENSED_COMPLIANCE)
  if (safeProfile.is_license_exempt) modules.add(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)
  if (settings.cacfp === true) modules.add(MODULE_KEYS.CACFP)

  return modules
}

/**
 * Convenience predicate. Returns true when the given module is active.
 */
export function hasModule(profile, fundingSources, moduleKey) {
  return getActiveModules({ profile, fundingSources }).has(moduleKey)
}
