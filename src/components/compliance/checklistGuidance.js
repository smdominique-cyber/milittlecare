// Compliance Engine Phase 3.1a — checklist guidance content map.
//
// Translates the Part 2 worksheet (docs/phase-3-1-guidance-review-
// worksheet.md) into per-(requirement, gap-state) <ActionableGap>
// props. Lives in its own module (not inline in ChecklistRow) so the
// content is unit-testable without mounting React.
//
// Guidance copy is the worksheet's DRAFT GUIDANCE verbatim, with
// three deliberate deviations (all task-directed, 2026-06-10):
//   1. E5 (caregiver_professional_development_hours) reads the
//      per-role hour count from the role-based reason string
//      ('hours-<total>-of-<required>') instead of any fixed number.
//   2. unknown reasons that classify as the 'load_failure' bucket
//      render "couldn't verify — refresh to retry" — branched on the
//      classifyUnknownReason BUCKET, never on reason strings.
//   3. A9 (intake_discipline_policy_receipt) ships without the
//      "PR #17 will add a richer surface" half-sentence, per the
//      worksheet's own A9(b) directive (providers don't care about
//      the MILittleCare roadmap).
//
// fixTarget policy (3.1a): a deep-link button is built ONLY for
// category-A surfaces — routes that are real and addressable today:
//
//   Surface 1  /families?family=<fid>&child=<cid>&tab=children
//   Surface 2  /families?family=<fid>&child=<cid>&tab=funding
//   Surface 5  /miregistry
//
// Category B/C surfaces (BusinessInfo ?section=, StaffTraining /
// Team ?caregiver=, per-row /acknowledgments) render text-only until
// their query-param handling ships (3.1b+). Family/child-scoped
// targets additionally require the consumer to supply context
// ({ familyId, childId }); when the context is absent (e.g. the
// provider-level /compliance page rendering a funding row), the
// result degrades to text-only. Never a dead button.

import { classifyUnknownReason } from '@/lib/complianceState'

// ─── Pattern E "tracking ships with PR #N" copy ─────────────────────
//
// Moved here from ChecklistRow.jsx in 3.1a (the content map is the
// natural home; ChecklistRow re-exports for existing importers).
// Lookup precedence:
//
//   1. Per-row entry (keyed by req.key) — used when rows in the
//      same category track to different PRs (staff_files: physician
//      attestation + arrival/departure → PR #18, discipline policy
//      ack → PR #17).
//   2. Category fallback — when every not_yet_modelled row in a
//      category tracks to the same PR (drills → #19, property → #21).
//   3. Generic fallback — any row not enumerated.
export const TRACKING_SHIPS_WITH = Object.freeze({
  caregiver_physician_attestation_annual:  'PR #18 (staff file gaps)',
  caregiver_discipline_policy_ack_at_hire: 'PR #17 (discipline policy receipt at hire)',
  caregiver_daily_arrival_departure:       'PR #18 (staff file gaps)',
  drills:        'PR #19 (drills + emergency response plan)',
  property:      'PR #21 (property records)',
})

export function trackingCopy(req) {
  if (!req) return 'a future MILittleCare build'
  return TRACKING_SHIPS_WITH[req.key]
      || TRACKING_SHIPS_WITH[req.category]
      || 'a future MILittleCare build'
}

// ─── Bucket-level shared copy ───────────────────────────────────────

export const LOAD_FAILURE_GUIDANCE =
  'We couldn’t verify this — refresh to retry.'

export const DATA_ANOMALY_GUIDANCE =
  'Something looks wrong — contact support.'

const GENERIC_AWAITING_GUIDANCE =
  'Answer this in Business Info → “What applies to my program?” — ' +
  'your answer determines whether this requirement applies.'

const GENERIC_NEEDS_PROVIDER_DATA_GUIDANCE =
  'A record this row depends on is missing a field you can fill in ' +
  'yourself. Edit the underlying record to complete it.'

// Defensive only — every shipped gap-capable row has a map entry; this
// fires only if a future registry row ships without content.
const GENERIC_GAP_GUIDANCE =
  'Review this requirement — a required record is missing or out of date.'

// ─── Fix-target surfaces (category A only, this PR) ─────────────────

export const SURFACE = Object.freeze({
  FAMILIES_CHILDREN: 'families_children',  // Surface 1
  FAMILIES_FUNDING:  'families_funding',   // Surface 2
  MIREGISTRY:        'miregistry',         // Surface 5
})

function buildFixTarget(surface, context) {
  const ctx = context || {}
  if (surface === SURFACE.MIREGISTRY) {
    return { label: 'Open MiRegistry tracker', to: '/miregistry' }
  }
  if (surface === SURFACE.FAMILIES_CHILDREN) {
    if (!ctx.familyId || !ctx.childId) return null
    return {
      label: 'Open this child in Families',
      to: `/families?family=${encodeURIComponent(ctx.familyId)}&child=${encodeURIComponent(ctx.childId)}&tab=children`,
    }
  }
  if (surface === SURFACE.FAMILIES_FUNDING) {
    if (!ctx.familyId) return null
    const childParam = ctx.childId ? `&child=${encodeURIComponent(ctx.childId)}` : ''
    return {
      label: 'Open funding in Families',
      to: `/families?family=${encodeURIComponent(ctx.familyId)}${childParam}&tab=funding`,
    }
  }
  return null
}

// ─── Per-requirement content ────────────────────────────────────────
//
// Entry shape (all fields optional):
//   surface           — SURFACE.* for category-A rows; omit for text-only.
//   missing           — guidance for missing_required (string | fn(state)).
//   expired           — guidance for expired; falls back to `missing`.
//   pending           — guidance for pending_parent; falls back to `missing`.
//   pendingByReason   — per-reason pending_parent overrides.
//   needsProviderData — per-reason copy for the needs_provider_data bucket.
//   awaiting          — copy for the awaiting_input bucket (text-only —
//                       BusinessInfo ?section= is 3.1b sub-work B-1).
//   notYetShipped     — copy for feature_not_yet_shipped; falls back to
//                       the generic trackingCopy() sentence.
//   dataAnomaly       — per-row data_anomaly copy; falls back to the
//                       generic contact-support sentence.
//   severityOverride  — { <state kind>: severity } (F2's advisory tone).
//
// Rows with no gap-producing states (C4, C5, D1 — on_file /
// not_applicable only) and the 12 Group I not-yet-shipped rows are
// intentionally absent: Group I rows resolve through the generic
// feature_not_yet_shipped branch; the no-gap rows never reach this map.
export const CHECKLIST_GUIDANCE = Object.freeze({

  // ── Group A — intake bundle (Surface 1) ──────────────────────────
  child_in_care_statement_envelope: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Send the parent the intake bundle so they can sign the ' +
      'child-in-care statement (and the eight sub-acknowledgments ' +
      'under R 400.1907).',
  },
  intake_lead_disclosure: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s signature on the lead-paint disclosure. ' +
      'R 400.1913 requires it for homes built before 1978.',
    awaiting:
      'Tell us whether your home was built before 1978 — that ' +
      'determines whether lead disclosure applies. Answer in Business ' +
      'Info → Premises.',
  },
  intake_firearms_disclosure: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s signature on the firearms disclosure. ' +
      'The copy on the disclosure form varies depending on your ' +
      'firearms answer in Business Info — R 400.1916.',
    awaiting:
      'Tell us whether firearms are present on your premises — that ' +
      'determines the disclosure copy. Answer in Business Info → Premises.',
  },
  intake_food_provider_agreement: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s signature on the food-provider agreement ' +
      '— who provides each meal (R 400.1907(1)(b)(ii)).',
  },
  intake_licensing_notebook_availability: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s acknowledgment that they were notified ' +
      'of your licensing notebook’s availability per ' +
      'R 400.1907(1)(b)(vii) + R 400.1906(3).',
  },
  intake_licensing_rules_offered: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s acknowledgment that they were offered a ' +
      'copy of the licensing rules per R 400.1907(1)(b)(iii).',
  },
  intake_infant_safe_sleep: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s signature on the infant safe-sleep ' +
      'acknowledgment. R 400.1930 — applies until the child reaches ' +
      '18 months.',
  },
  intake_health_condition: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s statement about the child’s health ' +
      'condition at intake — R 400.1907(1)(b)(i).',
  },
  intake_discipline_policy_receipt: {
    surface: SURFACE.FAMILIES_CHILDREN,
    // Worksheet A9(b): ships WITHOUT the "PR #17 will add a richer
    // surface" half-sentence.
    missing:
      'Capture the parent’s acknowledgment that they received your ' +
      'discipline policy — R 400.1907(1)(b)(iv).',
  },
  child_in_care_statement_envelope_drift: {
    surface: SURFACE.FAMILIES_CHILDREN,
    pending:
      'Premises or child-age info changed since this parent confirmed ' +
      'intake. Re-send the intake bundle so they can re-acknowledge — ' +
      'the engine detected drift in what’s now required.',
  },

  // ── Group B — children record annual fields (Surface 1) ──────────
  child_immunization_record: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Record the child’s immunization status — up_to_date, ' +
      'waiver_on_file, or in_progress. R 400.1907.',
  },
  child_annual_record_review: {
    surface: SURFACE.FAMILIES_CHILDREN,
    expired:
      'Mark this child’s records as reviewed for the current year — ' +
      'R 400.1907 annual review.',
    missing:
      'Schedule an annual review of this child’s records and update ' +
      'records_last_reviewed_on when complete.',
  },

  // ── Group C — enrollment / operational consents (Surface 1) ──────
  consent_field_trip_permission: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s signature on the field-trip permission ' +
      'for this child — R 400.1952(2). If you never run field trips, ' +
      'mark this “No” in Business Info → “What applies to my ' +
      'program?”.',
  },
  consent_transportation_routine_annual: {
    surface: SURFACE.FAMILIES_CHILDREN,
    // C2 keeps "Annual" — the expiry-removal PR has NOT landed
    // (worksheet Q + task correction 3); current main still expires
    // annually.
    missing:
      'Capture the parent’s signature on the routine transportation ' +
      'permission — R 400.1952(1)(a). Annual baseline. Per-trip ' +
      'non-routine acks are captured separately when the trip happens.',
  },
  consent_water_activities_on_premises_seasonal: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s seasonal signature on the on-premises ' +
      'water-activity permission — R 400.1934(10)(b). Per-trip ' +
      'off-premises water acks are captured separately.',
  },
  consent_photo_sharing: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s photo-sharing consent. If they decline ' +
      '(or revoke), the engine will record that as the active state — ' +
      'provider-protective, not licensing-required. R 400 is silent on ' +
      'this.',
  },

  // ── Group D — medication (Surface 1; D4/D6 text-only) ────────────
  medication_permission_per_authorization: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s permission for this specific medication ' +
      '— R 400.1931(2).',
    pendingByReason: {
      'authorization-changed-since-permission':
        'The medication’s dose, schedule, or prescriber changed since ' +
        'the parent’s last permission. Re-send for re-acknowledgment.',
    },
  },
  medication_permission_otc_blanket: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Capture the parent’s blanket OTC topical permission (sunscreen ' +
      '/ repellent / diaper rash cream) — covers all topical OTC ' +
      'collectively per R 400.1931(8) but doesn’t waive the ' +
      'per-medication permission requirement.',
  },
  medication_role_gate_integrity: {
    // HIGH-STAKES, deliberately guidance-only: backwards-looking
    // historical evidence; there is nothing to "open" that fixes it.
    missing:
      'An ineligible caregiver administered a non-OTC dose in the past. ' +
      'Document the corrective action in your records and confirm only ' +
      'licensees + child-care staff members administer non-topical-OTC ' +
      'medication going forward — R 400.1931(1). The DB trigger blocks ' +
      'new ineligible administrations; this row reflects historical ' +
      'evidence.',
  },
  medication_original_container_attestation: {
    surface: SURFACE.FAMILIES_CHILDREN,
    missing:
      'Confirm the medication is stored in its original labeled ' +
      'container — R 400.1931(4). Update the authorization record ' +
      'after verifying.',
  },
  medication_dose_log_retention: {
    dataAnomaly:
      'This row reflects the dose log’s retention state. The DB ' +
      'enforces archive-only + 2-year retention per R 400.1931(9). An ' +
      '“unknown” state here means an event row disappeared — ' +
      'contact support.',
  },

  // ── Group E — staff files (category C surface — text-only) ───────
  caregiver_background_check_eligibility: {
    missing:
      'Record this caregiver’s background-check eligibility result. ' +
      'R 400.1919 + R 400.1903(1)(r). An eligible determination is ' +
      'required BEFORE unsupervised contact with children.',
    pendingByReason: {
      pending:
        'This caregiver’s background check is pending review — they ' +
        'may not have unsupervised contact until the determination comes ' +
        'back eligible.',
    },
  },
  caregiver_cpr_first_aid_current: {
    missing:
      'Record this caregiver’s current CPR + pediatric first-aid ' +
      'certification (the expiration date printed on their card). ' +
      'R 400.1924(8) + R 400.1920(3) / R 400.1921(3).',
  },
  caregiver_new_hire_training_complete: {
    missing:
      'Record completion of the 14 mandated new-hire training topics ' +
      'for this caregiver. R 400.1923. Must be done within 90 days of ' +
      'hire AND before unsupervised care.',
    needsProviderData: {
      'caregiver-missing-date-of-hire':
        'This caregiver is missing their hire date. Edit the caregiver ' +
        'record and set date_of_hire — the engine needs it to track ' +
        'the 90-day new-hire window.',
    },
  },
  caregiver_miregistry_account: {
    missing:
      'Confirm this caregiver’s MiRegistry account status (submitted ' +
      '/ materials_received / awaiting_print / current) — R 400.1922. ' +
      'We mirror what you enter; verify in MiRegistry directly. 30-day ' +
      'window from employment.',
  },
  caregiver_professional_development_hours: {
    // E5 — per-role hours from the role-based reason string
    // ('hours-<total>-of-<required>'), never a fixed number. Reasons
    // that don't carry hours (e.g. 'no-active-caregivers') fall back
    // to the worksheet's "varies by role" sentence.
    missing: (state) => {
      const m = /^hours-(\d+(?:\.\d+)?)-of-(\d+(?:\.\d+)?)$/.exec((state && state.reason) || '')
      const base =
        'Log this caregiver’s professional-development hours for the ' +
        'current calendar year — R 400.1924. '
      if (m) {
        return base + `${m[1]} of ${m[2]} hours logged for this caregiver’s role.`
      }
      return base + 'The required hour count varies by their regulatory role.'
    },
    needsProviderData: {
      // No Part 2 draft exists for this reason; copy composed to
      // parallel E3's drafted hire-date sentence (same self-fixable
      // shape, same surface).
      'no-regulatory-roles':
        'This caregiver has no regulatory role recorded. Edit the ' +
        'caregiver record and set their regulatory role(s) — the ' +
        'engine needs it to determine the required ' +
        'professional-development hours.',
    },
  },
  caregiver_health_safety_update_acked: {
    missing:
      'Acknowledge the published health-safety update for this ' +
      'caregiver — R 400.1924(11). MiLEAP publishes notices; each ' +
      'applicable caregiver must read and acknowledge within the ' +
      'notice’s stated timeframe.',
  },
  caregiver_physician_attestation_annual: {
    notYetShipped:
      'Tracking ships with PR #18 (staff file gaps). Keep paper records ' +
      'of physician attestation of staff mental and physical health ' +
      'annually — an auditor will ask.',
  },
  caregiver_discipline_policy_ack_at_hire: {
    notYetShipped:
      'Tracking ships with PR #17 (discipline policy receipt). Keep ' +
      'paper records of staff acknowledgment of your discipline policy ' +
      'at hire.',
  },
  caregiver_daily_arrival_departure: {
    notYetShipped:
      'Tracking ships with PR #18 for non-app-user caregivers. App-user ' +
      'staff are covered today via the staff time-clock; non-app-user ' +
      'caregivers need paper records until the substrate ships.',
  },

  // ── Group F — MiRegistry tracker (Surface 5) ─────────────────────
  provider_miregistry_annual_ongoing: {
    surface: SURFACE.MIREGISTRY,
    missing:
      'Complete the Michigan Ongoing Health & Safety Training Refresher ' +
      'and log the completion date — CDC LEP handbook Dec 16 deadline. ' +
      'Missing the deadline closes your CDC scholarship account; ' +
      'you’ll need to complete the current year’s training and ' +
      're-enroll with MDHHS before resuming CDC billing. We mirror what ' +
      'you enter; verify in MiRegistry directly. If you enrolled this ' +
      'calendar year, the Dec 16 deadline begins next year — verify ' +
      'against your enrollment records.',
  },
  provider_miregistry_level_2_currency: {
    surface: SURFACE.MIREGISTRY,
    // Advisory, not a violation (worksheet F2 reframe 2026-06-06):
    // expiring Level 2 is a pay-rate drop, money-on-the-table — info
    // weight, not amber/red.
    severityOverride: { expired: 'info' },
    expired:
      'Your Level 2 expiration date has passed — your CDC pay rate ' +
      'has dropped to Level 1 (base). This is NOT a compliance ' +
      'violation; Level 2 is the optional higher pay tier. Log 10 more ' +
      'approved training hours to reset the rolling clock and earn ' +
      'Level 2 back, or stay at Level 1 if Level 2 isn’t worth the ' +
      'time for you. We mirror what you enter; verify in MiRegistry ' +
      'directly.',
  },

  // ── Group G — funding + CDC paperwork (Surface 2; G4 text-only) ──
  funding_enrollment_agreement_on_file: {
    surface: SURFACE.FAMILIES_FUNDING,
    missing:
      'Upload the enrollment agreement for this CDC funding source — ' +
      'required for licensed-billing-basis CDC. Licensed Family Homes / ' +
      'Group Homes only.',
  },
  cdc_authorization_currency: {
    surface: SURFACE.FAMILIES_FUNDING,
    expired:
      'This child’s CDC authorization has expired and billing has ' +
      'stopped. The PARENT handles redetermination (they submit ' +
      'documentation; MDHHS begins eligibility review in the 11th month ' +
      'of each authorization cycle) — not the provider. Make sure the ' +
      'parent knows redetermination is due, and update the ' +
      'authorization end date here once the new approval comes through. ' +
      'Questions about authorization: MDHHS, 844-464-3447.',
    needsProviderData: {
      'no-authorization-end-on-funding-source':
        'This CDC funding source is missing its authorization end date. ' +
        'Edit the funding source and set authorization_end so the ' +
        'engine can track expiry. Find the end date on the parent’s ' +
        'MDHHS authorization notice.',
    },
  },
  cdc_fingerprint_reprint_currency: {
    // Fix surface is Business Info → Licensing (?section= is 3.1b
    // sub-work B-1) — text-only this PR.
    missing:
      'Your fingerprint reprint is on a 5-year cycle. The current state ' +
      'of your fingerprint_date field tells the engine how close you ' +
      'are — update after each reprint. Applies to YOU (the ' +
      'licensee), your STAFF, and HOUSEHOLD MEMBERS who were originally ' +
      'fingerprinted before April 2024.',
  },

  // ── Group H — attendance acks (category C surface — text-only) ───
  attendance_parent_acknowledgment_per_day: {
    missing:
      'This day’s attendance for a CDC-enrolled child hasn’t been ' +
      'acknowledged by the parent yet. Either prompt the parent (the ' +
      'existing acknowledgment digest cron sends weekly), or run a ' +
      'provider override with a documented reason if the parent is ' +
      'genuinely unreachable. CDC billing audit trail.',
    pending:
      'Provider override is on file but the parent hasn’t ' +
      'acknowledged. This usually clears when they next open the portal.',
  },
})

// ─── Resolver ───────────────────────────────────────────────────────

const SEVERITY_BY_KIND = Object.freeze({
  missing_required: 'critical',
  expired:          'warning',
  pending_parent:   'warning',
})

function resolveCopy(copy, state) {
  if (typeof copy === 'function') return copy(state)
  return copy || null
}

/**
 * Produce <ActionableGap> props for one checklist row, or null when
 * the row needs no actionable surface (on_file / not_applicable).
 *
 * @param {object} args
 * @param {object} args.requirement  REQUIREMENT_REGISTRY row.
 * @param {object} args.state        Engine state ({ kind, reason, ... }).
 * @param {object} [args.context]    { familyId, childId } when the
 *                                   consumer renders in a family/child
 *                                   scope. Absent → family-scoped
 *                                   fixTargets degrade to text-only.
 * @returns {null | { guidanceText: string,
 *                    severity: 'critical'|'warning'|'info',
 *                    fixTarget?: { label: string, to: string } }}
 */
export function actionableGapPropsFor({ requirement, state, context } = {}) {
  if (!requirement || !state || !state.kind) return null
  const kind = state.kind
  if (kind === 'on_file' || kind === 'not_applicable') return null

  const entry = CHECKLIST_GUIDANCE[requirement.key] || {}

  if (kind === 'unknown') {
    const bucket = classifyUnknownReason({ state })
    if (bucket === 'load_failure') {
      // Bucket-driven (task correction 2): every load-failure reason —
      // present and future — gets the transient-retry copy, never the
      // per-row anomaly copy.
      return { guidanceText: LOAD_FAILURE_GUIDANCE, severity: 'info' }
    }
    if (bucket === 'feature_not_yet_shipped') {
      const guidanceText = entry.notYetShipped
        || `Tracking ships with ${trackingCopy(requirement)} — keep paper records for now. An auditor will ask to see them.`
      return { guidanceText, severity: 'info' }
    }
    if (bucket === 'awaiting_input') {
      // Text-only: BusinessInfo ?section= handling is 3.1b sub-work
      // (B-1) — an honest sentence beats a link that doesn't land.
      return { guidanceText: entry.awaiting || GENERIC_AWAITING_GUIDANCE, severity: 'warning' }
    }
    if (bucket === 'needs_provider_data') {
      const guidanceText =
        (entry.needsProviderData && entry.needsProviderData[state.reason])
        || GENERIC_NEEDS_PROVIDER_DATA_GUIDANCE
      const fixTarget = buildFixTarget(entry.surface, context)
      return fixTarget
        ? { guidanceText, severity: 'critical', fixTarget }
        : { guidanceText, severity: 'critical' }
    }
    // data_anomaly
    return { guidanceText: entry.dataAnomaly || DATA_ANOMALY_GUIDANCE, severity: 'info' }
  }

  let guidanceText = null
  if (kind === 'missing_required') {
    guidanceText = resolveCopy(entry.missing, state)
  } else if (kind === 'expired') {
    guidanceText = resolveCopy(entry.expired, state) || resolveCopy(entry.missing, state)
  } else if (kind === 'pending_parent') {
    guidanceText =
      (entry.pendingByReason && entry.pendingByReason[state.reason])
      || resolveCopy(entry.pending, state)
      || resolveCopy(entry.missing, state)
  } else {
    return null  // defensive: unrecognized state kind
  }
  if (!guidanceText) guidanceText = GENERIC_GAP_GUIDANCE

  const severity =
    (entry.severityOverride && entry.severityOverride[kind])
    || SEVERITY_BY_KIND[kind]

  // pending_parent stays guidance-only in 3.1 (scope §3: the "send
  // reminder" action is deferred per Phase 3 decision #10).
  const fixTarget = kind === 'pending_parent'
    ? null
    : buildFixTarget(entry.surface, context)

  return fixTarget
    ? { guidanceText, severity, fixTarget }
    : { guidanceText, severity }
}
