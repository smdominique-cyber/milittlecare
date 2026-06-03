// Parent-side compliance projections — Phase X (parent self-service).
//
// Authoritative spec: docs/pr-parent-self-service-scope.md
// (Phase X, §4 — the three parent-view bug fixes).
//
// Thin projection layer over the Phase 1 engine's REQUIREMENT_REGISTRY
// for the parent-facing surfaces. Keeps the engine module pure +
// untouched; provides the small lookups parent components need:
//
//   - INTAKE_BUNDLE_ACK_TYPES — the ack-type strings that make up
//     the R 400.1907 child-in-care statement bundle the parent
//     confirms via /parent/intake-acknowledge. The intake page
//     filters its ack fetch through this set so per-occurrence
//     consent rows can never leak into the bundle (Bug 2 fix).
//
//   - PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES — the per-occurrence
//     consent ack-type strings the read-only Bug 3 surface renders.
//     Sourced from the engine's PER_OCCURRENCE_CONSENT_TYPES export
//     so any future addition to that list shows up on the parent
//     surface without a code change here.
//
//   - labelForAckType(ackType) — friendly label per ack-type,
//     sourced from the registry's `label` field (Bug 1 fix —
//     replaces the hand-maintained SUB_TYPE_LABEL map that lacked
//     entries for per-occurrence types).
//
// This module is the parent-side adapter only. Provider surfaces
// stay on their existing per-domain helpers per Phase 2 decision 2.
//
// No Supabase imports — this is a pure lookup module.

import {
  ACK_TYPES,
  PER_OCCURRENCE_CONSENT_TYPES,
} from './acknowledgments'
import { REQUIREMENT_REGISTRY } from './complianceState'

/**
 * Ack-type → REQUIREMENT_REGISTRY key map for the R 400.1907 intake
 * bundle. Built as a hand-maintained constant rather than introspected
 * from the registry because the registry's `state_resolver` functions
 * are closures with the ackType baked in — not introspectable without
 * adding a typed field to every row. A constant here is the smaller
 * surface change.
 *
 * INVARIANT: every ack-type in this map MUST correspond to a
 * REQUIREMENT_REGISTRY row of category='child_files' AND must be the
 * ackType the row's Pattern A resolver reads. If a new intake-bundle
 * type is added to ACK_TYPES + a corresponding registry row, add it
 * here too. The associated unit test asserts the registry lookup
 * resolves.
 */
const INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY = Object.freeze({
  [ACK_TYPES.CHILD_IN_CARE_STATEMENT]:        'child_in_care_statement_envelope',
  [ACK_TYPES.LEAD_DISCLOSURE]:                'intake_lead_disclosure',
  [ACK_TYPES.FIREARMS_DISCLOSURE]:            'intake_firearms_disclosure',
  [ACK_TYPES.FOOD_PROVIDER_AGREEMENT]:        'intake_food_provider_agreement',
  [ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY]: 'intake_licensing_notebook_availability',
  [ACK_TYPES.LICENSING_RULES_OFFERED]:        'intake_licensing_rules_offered',
  [ACK_TYPES.INFANT_SAFE_SLEEP]:              'intake_infant_safe_sleep',
  [ACK_TYPES.HEALTH_CONDITION]:               'intake_health_condition',
  [ACK_TYPES.DISCIPLINE_POLICY_RECEIPT]:      'intake_discipline_policy_receipt',
})

/**
 * Ack-type → REQUIREMENT_REGISTRY key map for the enrollment-level
 * consents the parent sees on the Consents tab. Used by the friendly-
 * label rendering on that surface. Same shape rules as
 * INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY.
 */
const ENROLLMENT_CONSENT_TYPE_TO_REQUIREMENT_KEY = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]:                  'consent_field_trip_permission',
  [ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]:          'consent_transportation_routine_annual',
  [ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]:  'consent_water_activities_on_premises_seasonal',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]:                  'consent_photo_sharing',
})

/**
 * Ack-type → REQUIREMENT_REGISTRY key map for per-occurrence
 * consents. Used by the new read-only per-occurrence parent surface
 * (Bug 3 fix). Sourced from the engine's structurally separate
 * PER_OCCURRENCE_CONSENT_TYPES export — if a new per-occurrence type
 * ships in a future phase, add it here.
 */
const PER_OCCURRENCE_TYPE_TO_REQUIREMENT_KEY = Object.freeze({
  [ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP]:     'consent_transportation_nonroutine_per_trip_recency',
  [ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP]: 'consent_water_activities_off_premises_per_trip_recency',
})

/**
 * The set of ack-types that compose the parent intake bundle.
 * Includes the envelope + every sub-row type. The parent intake
 * page filters its ack fetch through this set (Bug 2 fix — keeps
 * per-occurrence rows out of the bundle).
 */
export const INTAKE_BUNDLE_ACK_TYPES = Object.freeze(
  Object.keys(INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY)
)

/**
 * The set of ack-types that render on the read-only per-occurrence
 * parent surface (Bug 3 fix). One section per type.
 */
export const PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES = Object.freeze(
  [...PER_OCCURRENCE_CONSENT_TYPES]
)

/**
 * Friendly label for an ack-type string, sourced from the registry.
 * Returns null for unknown ack-types (the caller should fall back to
 * the raw type or a generic placeholder — though raw-type-string
 * rendering is exactly what Bug 1 fixed; callers should treat null as
 * "unknown ack type, render a placeholder" rather than the raw string).
 *
 * @param {string} ackType
 * @returns {string|null}
 */
export function labelForAckType(ackType) {
  if (!ackType) return null
  const key =
       INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY[ackType]
    || ENROLLMENT_CONSENT_TYPE_TO_REQUIREMENT_KEY[ackType]
    || PER_OCCURRENCE_TYPE_TO_REQUIREMENT_KEY[ackType]
  if (!key) return null
  const row = REQUIREMENT_REGISTRY[key]
  return row ? row.label : null
}

/**
 * Returns true iff the ack-type belongs in the parent intake bundle
 * — i.e., the parent confirms it via /parent/intake-acknowledge.
 * Per-occurrence + enrollment consents return false.
 *
 * @param {string} ackType
 * @returns {boolean}
 */
export function isIntakeBundleAckType(ackType) {
  return ackType in INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY
}

/**
 * Returns true iff the ack-type is a per-occurrence consent
 * (transport non-routine per-trip, water off-premises per-trip).
 * The new Phase X read-only parent surface renders one section per
 * such type when ≥1 active row exists.
 *
 * @param {string} ackType
 * @returns {boolean}
 */
export function isPerOccurrenceAckType(ackType) {
  return ackType in PER_OCCURRENCE_TYPE_TO_REQUIREMENT_KEY
}
