// PR #20 — Medication administration (R 400.1931) data-layer helpers.
//
// Authoritative scope: docs/pr-20-medication-log-scope.md (reconciled
// against verbatim rule text 2026-06-02). Migration 028 ships the
// data layer; this file is the pure-helper + Supabase-write surface
// the modal (Part 2) will consume.
//
// This module owns:
//   - Per-type metadata helpers (single source of truth for shape).
//   - Authorization create / archive (one row per child × medication).
//   - Dose-event recording (one row per administered or applied dose).
//   - getDoseLogState(authorization, events) — recent-dose summary +
//     re-acknowledgment-needed flag (PR #16 snapshot-hash drift).
//   - mayAdminister(caregiver, roles) — pure role check (the DB
//     trigger is the authoritative guard; this is for UI dropdown
//     filtering).
//   - isTopicalOtcExempt(authorization) — convenience accessor.
//
// IMPORTANT — the DB trigger is the authoritative role-gate.
// `mayAdminister` is a UI affordance only; it MUST NOT be the only
// guard. R 400.1931(1) is enforced in
// `medication_event_caregiver_role_check()` (migration 028), with
// the (8) topical-OTC exemption built in. App-layer code can be
// bypassed; the trigger cannot.
//
// PARENT PERMISSION (R 400.1931(2)) rides the existing
// `public.acknowledgments` table via two ACK_TYPES already in the
// catalog (`src/lib/acknowledgments.js`):
//   - `medication_permission_otc_blanket` — one ack per child,
//     subject_type='child', subject_id=children.id. Covers all
//     topical OTC collectively per (8) (which exempts from (1)+(7)
//     but NOT (2)).
//   - `medication_permission` — one ack per non-OTC authorization,
//     subject_type='medication_authorization',
//     subject_id=medication_authorizations.id. Distinct subject_id
//     per authorization, which is how medication sidesteps the
//     per-occurrence index relaxation Phase C needed.
//
// Re-acknowledgment is DERIVED via PR #16's `computeAckHash` (snapshot-
// hash drift): when an authorization's dose/schedule/etc. changes,
// the current authorization's hash no longer matches the stored
// ack's `snapshot_hash`, and `getDoseLogState.needsReacknowledgment`
// flips true.

import { supabase } from './supabase'
import { ACK_TYPES, computeAckHash } from './acknowledgments'

// -----------------------------------------------------------------------------
// Eligible-role whitelist for the role-gate (R 400.1931(1)).
//
// SINGLE SOURCE OF TRUTH on the JS side. The DB trigger uses the
// same set verbatim — see migration 028. If the rule's eligible-role
// list ever changes (e.g., legal staff added), update BOTH this list
// AND the trigger function in the same migration.
//
// Topical OTC events (R 400.1931(8) exemption) bypass this check
// entirely — see `mayAdminister` and the trigger.
// -----------------------------------------------------------------------------

export const ELIGIBLE_ADMINISTERING_ROLES = Object.freeze([
  'licensee',
  'child_care_staff_member',
])

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * Build the canonical payload for the parent-permission ack on a
 * medication authorization. PR #16 stores `snapshot_hash` on every
 * ack row; when the authorization's dose/schedule/prescriber/OTC
 * status changes after the parent signed, the stored hash drifts
 * from `computeAckHash(currentPayload)` and `needsReacknowledgment`
 * flips true.
 *
 * SINGLE SOURCE OF TRUTH for the per-authorization permission
 * payload. Every write site that creates a `medication_permission`
 * ack row MUST go through this helper — never construct the
 * payload inline.
 *
 * @param {object} args
 * @param {object} args.authorization  The medication_authorizations row
 *   (or a subset carrying the fields below).
 * @returns {{
 *   medication_name:              string,
 *   dose_text:                    string,
 *   schedule_text:                string,
 *   prescriber_name:              string,
 *   is_topical_otc:               boolean,
 *   starts_on:                    string|null,
 *   ends_on:                      string|null,
 *   original_container_confirmed: boolean,
 * }}
 */
export function buildMedicationPermissionPayload({ authorization } = {}) {
  if (!authorization) {
    throw new Error('buildMedicationPermissionPayload: authorization is required')
  }
  return {
    medication_name:              authorization.medication_name || '',
    dose_text:                    authorization.dose_text || '',
    schedule_text:                authorization.schedule_text || '',
    prescriber_name:              authorization.prescriber_name || '',
    is_topical_otc:               !!authorization.is_topical_otc,
    starts_on:                    authorization.starts_on || null,
    ends_on:                      authorization.ends_on || null,
    original_container_confirmed: !!authorization.original_container_confirmed,
  }
}

/**
 * Compute the snapshot hash for an authorization's parent-permission
 * ack. The ack row's stored `snapshot_hash` is compared against
 * this current-hash to detect drift (re-ack required).
 *
 * @param {{ authorization: object }} args
 * @returns {string} 8-char hex (FNV-1a 32-bit, per PR #16).
 */
export function computeMedicationPermissionHash({ authorization } = {}) {
  return computeAckHash({
    type: ACK_TYPES.MEDICATION_PERMISSION,
    payload: buildMedicationPermissionPayload({ authorization }),
  })
}

/**
 * True iff the authorization is topical OTC. R 400.1931(8) exempts
 * these from subrule (1) (role-gate) and subrule (7) (dose log).
 * They are NOT exempt from subrule (2) (parent permission) —
 * covered separately via the `medication_permission_otc_blanket`
 * ack type.
 *
 * @param {{ is_topical_otc?: boolean }|null} authorization
 * @returns {boolean}
 */
export function isTopicalOtcExempt(authorization) {
  return !!(authorization && authorization.is_topical_otc)
}

/**
 * Pure role-check — true iff the caregiver has at least one
 * regulatory_role in the eligible whitelist
 * (`ELIGIBLE_ADMINISTERING_ROLES`). Used to filter the
 * administered_by dropdown in the modal (Part 2).
 *
 * IMPORTANT: this is a UI affordance only. The DB trigger
 * (`medication_event_caregiver_role_check`) is the authoritative
 * guard. Never rely on `mayAdminister` alone — the trigger always
 * runs at INSERT time.
 *
 * If the authorization is topical OTC (R 400.1931(8) exempt), this
 * function returns true regardless of role — any caregiver may
 * apply sunscreen / repellent / diaper rash cream.
 *
 * @param {object} args
 * @param {{ regulatory_roles?: string[] }|null} args.caregiver
 *   Caregiver with their `regulatory_role` values aggregated into
 *   an array. Different shapes are supported defensively — see
 *   normalizeCaregiverRoles below.
 * @param {{ is_topical_otc?: boolean }|null} [args.authorization]
 *   The linked medication authorization. When `is_topical_otc=true`,
 *   the role-check is skipped per R 400.1931(8).
 * @returns {boolean}
 */
export function mayAdminister({ caregiver, authorization } = {}) {
  if (isTopicalOtcExempt(authorization)) return true
  const roles = normalizeCaregiverRoles(caregiver)
  for (const r of roles) {
    if (ELIGIBLE_ADMINISTERING_ROLES.includes(r)) return true
  }
  return false
}

/**
 * Defensive role-shape normalizer. The caller's caregiver shape may
 * vary depending on the query (raw join vs aggregated). Accepts:
 *   - { regulatory_roles: ['licensee', ...] }            // aggregated array
 *   - { regulatory_role: 'licensee' }                    // single-role shape
 *   - { caregiver_regulatory_roles: [{regulatory_role}] }// raw nested join
 *   - null / undefined                                    // empty
 */
function normalizeCaregiverRoles(caregiver) {
  if (!caregiver) return []
  if (Array.isArray(caregiver.regulatory_roles)) return caregiver.regulatory_roles
  if (typeof caregiver.regulatory_role === 'string') return [caregiver.regulatory_role]
  if (Array.isArray(caregiver.caregiver_regulatory_roles)) {
    return caregiver.caregiver_regulatory_roles
      .map(r => r && r.regulatory_role)
      .filter(Boolean)
  }
  return []
}

/**
 * Per-authorization read state for the dose-log view in the modal.
 * Pure — takes the authorization, the events for that authorization,
 * and an active parent-permission ack (if any) — and returns the
 * summary the UI needs.
 *
 * @param {object}   args
 * @param {object}   args.authorization        The medication_authorizations row.
 * @param {object[]} args.events               Active dose events for this auth.
 * @param {object|null} [args.activePermissionAck]
 *   The active `medication_permission` ack for this authorization,
 *   if one exists. Used to detect snapshot_hash drift.
 * @returns {{
 *   isTopicalOtc:           boolean,
 *   eventCount:             number,
 *   lastAdministeredAt:     string|null,
 *   dosesInLast24Hours:     number,
 *   doseLogRequired:        boolean,   // false for topical OTC (R 400.1931(8))
 *   roleGateApplies:        boolean,   // false for topical OTC (R 400.1931(8))
 *   permissionOnFile:       boolean,
 *   needsReacknowledgment:  boolean,   // snapshot_hash drift detected
 * }}
 */
export function getDoseLogState({ authorization, events, activePermissionAck } = {}) {
  const safeEvents = Array.isArray(events) ? events : []
  const isTopicalOtc = isTopicalOtcExempt(authorization)

  let lastAdministeredAt = null
  let lastMs = -Infinity
  for (const e of safeEvents) {
    if (!e || !e.administered_at || e.archived_at) continue
    const ms = Date.parse(e.administered_at)
    if (Number.isFinite(ms) && ms > lastMs) {
      lastMs = ms
      lastAdministeredAt = e.administered_at
    }
  }

  const nowMs = Date.now()
  const dayAgoMs = nowMs - 24 * 60 * 60 * 1000
  let dosesInLast24Hours = 0
  for (const e of safeEvents) {
    if (!e || !e.administered_at || e.archived_at) continue
    const ms = Date.parse(e.administered_at)
    if (Number.isFinite(ms) && ms >= dayAgoMs && ms <= nowMs) {
      dosesInLast24Hours += 1
    }
  }

  const permissionOnFile = !!(activePermissionAck && !activePermissionAck.archived_at)
  let needsReacknowledgment = false
  if (permissionOnFile && activePermissionAck.snapshot_hash) {
    const currentHash = computeMedicationPermissionHash({ authorization })
    needsReacknowledgment = activePermissionAck.snapshot_hash !== currentHash
  }

  return {
    isTopicalOtc,
    eventCount: safeEvents.filter(e => e && !e.archived_at).length,
    lastAdministeredAt,
    dosesInLast24Hours,
    doseLogRequired: !isTopicalOtc,
    roleGateApplies:  !isTopicalOtc,
    permissionOnFile,
    needsReacknowledgment,
  }
}

// -----------------------------------------------------------------------------
// Write helpers — Supabase
//
// These wrap the insert/update paths the modal will call. The DB
// trigger is the authoritative guard on role-gate; these helpers
// are convenience + shape validation.
// -----------------------------------------------------------------------------

/**
 * Insert a new medication_authorizations row. The caller is
 * responsible for archiving any prior active row of the same
 * (child_id, lower(medication_name)) — the unique index will reject
 * the insert otherwise (same archive-then-insert protocol as Phase
 * A re-acks).
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.childId
 * @param {object} args.fields
 *   { medication_name, dose_text?, schedule_text?, is_topical_otc?,
 *     prescriber_name?, starts_on?, ends_on?, original_container_confirmed? }
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createMedicationAuthorization({ providerId, childId, fields } = {}) {
  if (!providerId) throw new Error('createMedicationAuthorization: providerId required')
  if (!childId)    throw new Error('createMedicationAuthorization: childId required')
  if (!fields || typeof fields.medication_name !== 'string' || fields.medication_name.trim() === '') {
    throw new Error('createMedicationAuthorization: fields.medication_name (non-blank) required')
  }
  const row = {
    provider_id:  providerId,
    child_id:     childId,
    medication_name: fields.medication_name.trim(),
    dose_text:    fields.dose_text     ?? null,
    schedule_text: fields.schedule_text ?? null,
    is_topical_otc: !!fields.is_topical_otc,
    prescriber_name: fields.prescriber_name ?? null,
    starts_on:    fields.starts_on    ?? null,
    ends_on:      fields.ends_on      ?? null,
    original_container_confirmed: !!fields.original_container_confirmed,
  }
  const { data, error } = await supabase
    .from('medication_authorizations')
    .insert([row])
    .select()
    .maybeSingle()
  return { data, error }
}

/**
 * Archive a medication_authorizations row (soft-delete). Never
 * hard-delete — per R 400.1931(9) the linked dose events must be
 * retained 2 years from `administered_at`.
 */
export async function archiveMedicationAuthorization({ authorizationId } = {}) {
  if (!authorizationId) throw new Error('archiveMedicationAuthorization: authorizationId required')
  const { error } = await supabase
    .from('medication_authorizations')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', authorizationId)
  return { error: error || null }
}

/**
 * Record a dose administration event. The DB trigger
 * (`medication_event_caregiver_role_check`) enforces R 400.1931(1)
 * + (8): if the linked authorization is non-OTC, the caregiver
 * must be `licensee` or `child_care_staff_member`. The error
 * surfaces in `result.error` with the trigger's exception message.
 *
 * For topical OTC authorizations, the dose log is OPTIONAL per
 * R 400.1931(8) — providers MAY record events for their own
 * tracking, and the trigger lets any caregiver record them.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.authorizationId
 * @param {string} args.childId
 * @param {string} args.administeredByCaregiverId
 * @param {string} [args.administeredAt]      ISO timestamp; default now().
 * @param {string} [args.doseAdministeredText] free text amount.
 * @param {string} [args.notes]               free text notes.
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function recordDoseEvent({
  providerId,
  authorizationId,
  childId,
  administeredByCaregiverId,
  administeredAt,
  doseAdministeredText,
  notes,
} = {}) {
  if (!providerId)                throw new Error('recordDoseEvent: providerId required')
  if (!authorizationId)           throw new Error('recordDoseEvent: authorizationId required')
  if (!childId)                   throw new Error('recordDoseEvent: childId required')
  if (!administeredByCaregiverId) throw new Error('recordDoseEvent: administeredByCaregiverId required')
  const row = {
    provider_id:                  providerId,
    authorization_id:             authorizationId,
    child_id:                     childId,
    administered_by_caregiver_id: administeredByCaregiverId,
    administered_at:              administeredAt || new Date().toISOString(),
    dose_administered_text:       doseAdministeredText ?? null,
    notes:                        notes ?? null,
  }
  const { data, error } = await supabase
    .from('medication_administration_events')
    .insert([row])
    .select()
    .maybeSingle()
  return { data, error }
}

/**
 * Archive a dose event (soft-delete). Useful for correcting a
 * recording error. The original row stays in the audit trail.
 */
export async function archiveDoseEvent({ eventId } = {}) {
  if (!eventId) throw new Error('archiveDoseEvent: eventId required')
  const { error } = await supabase
    .from('medication_administration_events')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', eventId)
  return { error: error || null }
}

/**
 * Fetch active medication authorizations for a single child.
 * Default ordering: most-recently-created first. Includes the
 * fields the modal renders.
 */
export async function listActiveAuthorizationsForChild({ providerId, childId } = {}) {
  if (!providerId || !childId) return { data: [], error: null }
  const { data, error } = await supabase
    .from('medication_authorizations')
    .select(
      'id, provider_id, child_id, medication_name, dose_text, schedule_text, ' +
      'is_topical_otc, prescriber_name, starts_on, ends_on, ' +
      'original_container_confirmed, archived_at, created_at, updated_at'
    )
    .eq('provider_id', providerId)
    .eq('child_id', childId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
  return { data: data || [], error: error || null }
}

/**
 * Fetch active dose events for a single authorization. Default
 * ordering: most-recent `administered_at` first.
 */
export async function listActiveEventsForAuthorization({ authorizationId, limit } = {}) {
  if (!authorizationId) return { data: [], error: null }
  let query = supabase
    .from('medication_administration_events')
    .select(
      'id, provider_id, authorization_id, child_id, administered_at, ' +
      'dose_administered_text, administered_by_caregiver_id, notes, ' +
      'archived_at, created_at, updated_at'
    )
    .eq('authorization_id', authorizationId)
    .is('archived_at', null)
    .order('administered_at', { ascending: false })
  if (Number.isFinite(limit) && limit > 0) query = query.limit(limit)
  const { data, error } = await query
  return { data: data || [], error: error || null }
}
