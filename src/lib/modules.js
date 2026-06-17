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
  STAFF_TRAINING: 'staff_training',
  LICENSED_COMPLIANCE: 'licensed_compliance',
  LICENSE_EXEMPT_COMPLIANCE: 'license_exempt_compliance',
  CACFP: 'cacfp',
  REMINDERS: 'reminders',
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
 * @param {boolean}  args.isTrackedStaffCaregiver
 *                                        True when the current user is a
 *                                        caregiver on another provider's
 *                                        regulatory roster — i.e. a staff
 *                                        member of a licensed home (see the
 *                                        staff_training activation below).
 * @returns {Set<string>}
 *
 * A funding source counts as active iff status === 'active' AND
 * archived_at is null.
 */
export function getActiveModules({ profile, fundingSources, isTrackedStaffCaregiver } = {}) {
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

  // miregistry_tracker: active iff the provider is license-exempt.
  //
  // 2026-06-16 — narrowed from "miregistry_id present OR license-exempt"
  // to "license-exempt only." The page (Level 2 progress, December 16
  // Annual Ongoing deadline, LEPPT completion, $10 enrollment language)
  // is by-design LEP-targeted. Licensed-home providers who happen to
  // have a MiRegistry ID on file were ending up here too, seeing
  // LEP-framed copy that doesn't apply to them. Their training-record
  // surface is Staff Training (R 400.1923 / R 400.1924), not this
  // tracker. The `miregistry_id`-presence branch is removed.
  //
  // Chicken-and-egg for brand-new LEPs is unchanged: an LEP without a
  // MiRegistry ID yet still gets the tracker (so the empty-state can
  // prompt them for one).
  //
  // See miregistry_tracker_spec.md § 4 for the original rule + this
  // commit's rationale for the narrowing.
  if (safeProfile.is_license_exempt === true) {
    modules.add(MODULE_KEYS.MIREGISTRY_TRACKER)
  }
  // staff_training: the staff-training-tracking feature for LICENSED
  // providers and the staff who work under them (PR #8 /
  // docs/staff_training_tracking_spec.md § 5.1, § 4.4). Two paths:
  //
  //   - The licensee — the affirmative "I am a licensed provider"
  //     answer, is_license_exempt === false (captured at onboarding by
  //     PR #5 / PR #7). Not keyed on michigan_license_number, which a
  //     licensed provider may leave blank for a while. The strict
  //     === false check keeps the feature off for the null (unanswered)
  //     and true (license-exempt) cases (spec § 4.2).
  //   - A staff member — they carry no license status on their own
  //     profile, so the signal is roster membership: they appear on a
  //     licensee's regulatory roster (a public.caregivers row linked by
  //     app_user_id, owned by a different licensee). V1 is licensee-
  //     driven (spec § 9 OQ16) — the staff self-view unlocks once the
  //     licensee adds them to the roster.
  if (
    safeProfile.is_license_exempt === false ||
    isTrackedStaffCaregiver === true
  ) {
    modules.add(MODULE_KEYS.STAFF_TRAINING)
  }
  // PR #14: license_type is the compliance source of truth (migration 022).
  // The gates explicitly read license_type — NOT michigan_license_number or
  // is_license_exempt — so LEPs (license_exempt) get no licensed-home
  // compliance UI and a licensed provider with a blank license number still
  // sees their modules. is_license_exempt remains a derived mirror written
  // in lockstep at every capture surface; non-compliance gates above
  // (miregistry_tracker, staff_training) continue keying on it without change.
  if (safeProfile.license_type === 'family_home' ||
      safeProfile.license_type === 'group_home') {
    modules.add(MODULE_KEYS.LICENSED_COMPLIANCE)
  }
  if (safeProfile.license_type === 'license_exempt') {
    modules.add(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)
  }
  if (settings.cacfp === true) modules.add(MODULE_KEYS.CACFP)

  // PR #15: the opt-in reminder system's settings page is available to
  // any provider with a confirmed license_type — including LEPs, who
  // get their own catalog entries (miregistry_annual_training,
  // fingerprint_reprint). Per-category gating (which categories show
  // up in the settings UI) is enforced by the catalog's
  // `license_type_gating` field, not here. We only gate at the
  // module level: a provider who has not yet picked a license_type
  // sees no reminders surface (mirrors the LicenseTypeReviewBanner UX).
  if (safeProfile.license_type != null) {
    modules.add(MODULE_KEYS.REMINDERS)
  }

  return modules
}

/**
 * Convenience predicate. Returns true when the given module is active.
 */
export function hasModule(profile, fundingSources, moduleKey) {
  return getActiveModules({ profile, fundingSources }).has(moduleKey)
}
