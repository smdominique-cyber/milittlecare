// Authoritative reminder-category catalog (PR #15 Half 1).
//
// Owned by the application, NOT the database. Migration 023's
// `reminder_instances.category` and `reminder_preferences.category`
// columns are free-text per OQ3 (see migration header for rationale);
// the validator for "is this a known category?" is this file.
//
// The category KEYS below are LOAD-BEARING — they are the exact strings
// referenced by the scope docs `docs/pr-16-…` through `docs/pr-21-…`. Do
// not rename a key without updating every consumer scope doc and any
// already-written scheduler shim. The values (label, description,
// default_lead_time_days, etc.) can evolve freely without breaking
// consumers.
//
// Each entry's shape:
//   {
//     key: string,                          // matches the object key
//     label: string,                        // short UI label
//     description: string,                  // one-paragraph context
//     default_lead_time_days: number,       // initial preferences row default
//     license_type_gating: string[],        // license_type values that
//                                            //   activate the category in
//                                            //   the settings UI
//     subject_type: string|null,            // 'child' | 'caregiver' |
//                                            //   'family' | 'property_record'
//                                            //   | 'medication_authorization'
//                                            //   | null (provider-level)
//     severity_thresholds?: object,         // optional override of the
//                                            //   default ladder (see
//                                            //   src/lib/reminderSeverity.js)
//   }

export const REMINDER_CATEGORIES = Object.freeze({

  // ── PR #16 — Child files (R 400.1907) ──────────────────────────────
  child_annual_review: Object.freeze({
    key: 'child_annual_review',
    label: 'Annual child-records review due',
    description:
      'Per R 400.1907, every child\'s records must be reviewed at least once a year. ' +
      'Fires N days before the anniversary of children.records_last_reviewed_on ' +
      '(or, for never-reviewed children, N days after children.intake_completed_at).',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'child',
  }),
  intake_acknowledgment_pending: Object.freeze({
    key: 'intake_acknowledgment_pending',
    label: 'Parent has not yet signed intake acknowledgment',
    description:
      'Fires when the licensee has triggered parent-portal collection of an intake ' +
      'acknowledgment (PR #16 § B.6 parent-portal extension) and the parent has not ' +
      'completed it. Subject is the affected child; the per-acknowledgment row carries ' +
      'the disclosure type. Fires immediately on trigger (lead 0) and is cleared on ' +
      'parent confirm.',
    default_lead_time_days: 0,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'child',
  }),

  // ── PR #17 — Discipline policy (R 400.1942 + R 400.1906) ───────────
  staff_discipline_policy_ack_pending: Object.freeze({
    key: 'staff_discipline_policy_ack_pending',
    label: 'New hire owes discipline-policy acknowledgment',
    description:
      'Per R 400.1906 / R 400.1942, every personnel member must acknowledge the ' +
      'discipline policy at hire. Fires when caregivers.date_of_hire is set and no ' +
      'active staff_discipline_policy_receipt acknowledgment exists for that caregiver. ' +
      'Lead 0 = fires on the hire date; PR #17 also marks acks stale when the policy ' +
      'version bumps (see scope § B.4).',
    default_lead_time_days: 0,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'caregiver',
  }),

  // ── PR #18 — Staff files (R 400.1920, R 400.1933) ──────────────────
  cpr_first_aid_expiration: Object.freeze({
    key: 'cpr_first_aid_expiration',
    label: 'CPR / pediatric First Aid certification expiring',
    description:
      'Per R 400.1920(3) / R 400.1924(8), CPR (pediatric, infant, child, adult) and ' +
      'pediatric First Aid certifications must remain current per personnel member. ' +
      'Fires N days before the staff_training_records.expires_on for the most recent ' +
      'cpr_first_aid record.',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'caregiver',
  }),
  physician_attestation_expiration: Object.freeze({
    key: 'physician_attestation_expiration',
    label: 'Physician attestation renewal due',
    description:
      'Per R 400.1933, every personnel member (including the licensee themselves) ' +
      'needs an annual physician attestation of mental and physical health. Fires N ' +
      'days before the prior attestation\'s anniversary. PR #18 contributes the ' +
      'physician_attestation value to staff_training_category.',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'caregiver',
  }),

  // ── PR #19 — Drills (R 400.1939) ───────────────────────────────────
  drill_fire: Object.freeze({
    key: 'drill_fire',
    label: 'Fire drill due',
    description:
      'Per R 400.1939, fire drills every 3 months (4 per year). Provider-level — no ' +
      'subject_type since the drill applies to the whole home. Fires N days before ' +
      'the computed next-due date (last performed + 3 months).',
    default_lead_time_days: 14,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: null,
  }),
  drill_tornado: Object.freeze({
    key: 'drill_tornado',
    label: 'Tornado drill due',
    description:
      'Per R 400.1939, two tornado drills per year between March and November. ' +
      'Provider-level. Scheduler computes the next-due date based on history of ' +
      'tornado drills in the current March-November window.',
    default_lead_time_days: 14,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: null,
  }),
  drill_other: Object.freeze({
    key: 'drill_other',
    label: 'Annual drill (lockdown / shelter-in-place / reunification) due',
    description:
      'Per R 400.1939, the catch-all annual category. One reminder when no drill of ' +
      'any non-fire / non-tornado subtype has occurred within the trailing year. The ' +
      'subtype is stored in drill_logs.drill_type (lockdown, shelter_in_place, ' +
      'reunification, other-with-description).',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: null,
  }),

  // ── PR #20 — Medication (R 400.1931) ───────────────────────────────
  medication_authorization_renewal: Object.freeze({
    key: 'medication_authorization_renewal',
    label: 'Medication authorization renewal / re-acknowledgment due',
    description:
      'Per R 400.1931. Fires when a medication_authorizations.ends_on is within the ' +
      'lead window OR when getDoseLogState.needsReacknowledgment becomes true (the ' +
      'authorization\'s dose or schedule changed after the active parent permission ' +
      'acknowledgment).',
    default_lead_time_days: 7,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'medication_authorization',
  }),

  // ── PR #21 — Property records (R 400.1915, R 400.1945, R 400.1948) ─
  radon_test_due: Object.freeze({
    key: 'radon_test_due',
    label: 'Radon test due',
    description:
      'Per R 400.1915, radon testing every 4 years. Fires N days before the computed ' +
      'next-due date (last performed_on + 4 years).',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'property_record',
  }),
  heating_inspection_due: Object.freeze({
    key: 'heating_inspection_due',
    label: 'Heating inspection due',
    description:
      'Per R 400.1945, heat-producing equipment inspection every 4 years. Fires N ' +
      'days before the computed next-due date.',
    default_lead_time_days: 30,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: 'property_record',
  }),
  detector_check_overdue: Object.freeze({
    key: 'detector_check_overdue',
    label: 'Smoke / CO detector check overdue',
    description:
      'Annual product-added best practice. Rule R 400.1948 requires detector presence ' +
      'and working condition but does not enumerate an ongoing-check cadence. Default ' +
      'lead 0 = fires on annual anniversary of the last check; provider can adjust ' +
      'lead_time_days via the settings UI.',
    default_lead_time_days: 0,
    license_type_gating: ['family_home', 'group_home'],
    subject_type: null,
  }),

  // ── LEP / CDC categories (existing surfaces this PR optionally migrates) ──
  miregistry_annual_training: Object.freeze({
    key: 'miregistry_annual_training',
    label: 'Annual Ongoing Training due',
    description:
      'CDC Scholarship Handbook for License Exempt Provider (Dec 16 deadline). ' +
      'Mirrors the existing AnnualTrainingBanner gate; Half 2 will introduce the ' +
      'parallel scheduler that writes reminder_instances against the same source data ' +
      '(miregistry_training_entries where source = annual_ongoing).',
    default_lead_time_days: 45,
    license_type_gating: ['license_exempt'],
    subject_type: null,
    // Matches cdcProviderCompliance.js's existing TRAINING_LADDER exactly
    // so the new banner host (Half 2) renders identical severity to the
    // bespoke AnnualTrainingBanner.
    severity_thresholds: Object.freeze({
      info: 45,
      warning: 30,
      urgent: 15,
      critical: 6,
    }),
  }),
  fingerprint_reprint: Object.freeze({
    key: 'fingerprint_reprint',
    label: 'Fingerprint reprint due',
    description:
      'LEP-Unrelated providers only. Five-year background-check fingerprint reprint ' +
      'window; reminder gates at >4.5 years old, urgent at >5 years (matches the ' +
      'existing getFingerprintReprintState helper in cdcProviderCompliance.js).',
    default_lead_time_days: 180,
    license_type_gating: ['license_exempt'],
    subject_type: null,
  }),

  // ── Future non-compliance categories (documented for design validation;
  //    NOT implemented in PR #15 — placeholders only) ──────────────────
  // cdc_redetermination: post-July product wedge. Per-child reminders
  //   tied to DHS-198 capture + computed redetermination window. See
  //   docs/backlog.md § "Post-July priority: CDC redetermination
  //   ownership". subject_type='child'.
  //
  // billing_overdue: provider feedback - "remember to bill". Tracks
  //   pay-period close vs. submission. Per-pay-period or
  //   provider-level. subject_type TBD.
})

/**
 * Returns true when `category` is enumerated in REMINDER_CATEGORIES.
 * Server-side schedulers should validate before insert; the DB stores
 * free-text per OQ3.
 *
 * @param {string} category
 * @returns {boolean}
 */
export function isKnownCategory(category) {
  return Object.prototype.hasOwnProperty.call(REMINDER_CATEGORIES, category)
}

/**
 * Returns the array of category entries that apply to the given
 * license_type — used by the settings UI to render the toggle list.
 *
 * @param {string|null} licenseType  'family_home' | 'group_home' |
 *                                    'license_exempt' | null
 * @returns {object[]}  Array of REMINDER_CATEGORIES entries.
 */
export function categoriesForLicenseType(licenseType) {
  if (!licenseType) return []
  return Object.values(REMINDER_CATEGORIES).filter(
    c => c.license_type_gating.includes(licenseType)
  )
}
