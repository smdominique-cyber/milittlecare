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

// -----------------------------------------------------------------------------
// Caregiver roster (UI affordance — feeds the dose-log entry picker)
// -----------------------------------------------------------------------------

/**
 * Fetch every caregiver under a licensee with their regulatory_role
 * values attached as an array. The modal uses this list +
 * `mayAdminister` to filter the administered-by dropdown per
 * authorization — for non-OTC the dropdown narrows to eligible
 * roles; for topical OTC any caregiver is selectable.
 *
 * The role-gate DB trigger is the authoritative guard; this is the
 * UI-side mirror so the provider doesn't hit the trigger error in
 * normal use.
 *
 * @param {object} args
 * @param {string} args.licenseeId   The provider's auth.uid().
 * @returns {Promise<{
 *   data: Array<{ id: string, full_name?: string, app_user_id?: string,
 *                  regulatory_roles: string[] }>,
 *   error: object|null,
 * }>}
 */
export async function listCaregiversWithRoles({ licenseeId } = {}) {
  if (!licenseeId) return { data: [], error: null }

  // 1) Roster scoped to the licensee.
  const { data: caregivers, error: cgErr } = await supabase
    .from('caregivers')
    .select('id, licensee_id, app_user_id, full_name, archived_at')
    .eq('licensee_id', licenseeId)
    .is('archived_at', null)
  if (cgErr) return { data: [], error: cgErr }
  const rows = Array.isArray(caregivers) ? caregivers : []
  if (rows.length === 0) return { data: [], error: null }

  // 2) Roles for those caregivers.
  const ids = rows.map(r => r.id)
  const { data: roleRows, error: rolesErr } = await supabase
    .from('caregiver_regulatory_roles')
    .select('caregiver_id, regulatory_role')
    .in('caregiver_id', ids)
  if (rolesErr) return { data: [], error: rolesErr }

  // 3) Attach role arrays. Same pattern as useStaffTraining.js.
  const rolesByCaregiver = new Map()
  for (const r of roleRows || []) {
    if (!r || !r.caregiver_id) continue
    let list = rolesByCaregiver.get(r.caregiver_id)
    if (!list) { list = []; rolesByCaregiver.set(r.caregiver_id, list) }
    list.push(r.regulatory_role)
  }
  const out = rows.map(c => ({
    ...c,
    regulatory_roles: rolesByCaregiver.get(c.id) || [],
  }))
  return { data: out, error: null }
}

/**
 * Filter a caregiver roster down to the set eligible to administer
 * for a given authorization. For non-OTC, only `licensee` /
 * `child_care_staff_member` qualify; for topical OTC (R 400.1931(8)
 * exempt), every caregiver in the roster qualifies.
 *
 * Pure — takes the roster (from `listCaregiversWithRoles`) and the
 * authorization, returns the filtered subset.
 *
 * @param {object} args
 * @param {Array} args.caregivers       Roster with regulatory_roles[] attached.
 * @param {object|null} args.authorization
 * @returns {Array}
 */
export function eligibleCaregiversForAdministration({ caregivers, authorization } = {}) {
  const list = Array.isArray(caregivers) ? caregivers : []
  if (isTopicalOtcExempt(authorization)) return list.slice()
  return list.filter(c => mayAdminister({ caregiver: c, authorization }))
}

// -----------------------------------------------------------------------------
// Parent permission (R 400.1931(2)) — writes to `public.acknowledgments`
// via the two ACK_TYPES already in the catalog
// (`medication_permission`, `medication_permission_otc_blanket`).
//
// SHAPE: both consents are parent-signed — only parent_portal /
// in_person_paper SATISFY the rule; provider_override is captured
// in the audit trail but does NOT clear the pending count. Same
// channel-aware rule as every other parent-signed consent.
//
// ARCHIVE-THEN-INSERT: re-recording archives the prior active row
// and inserts a fresh one with the current snapshot_hash. This is
// what `getDoseLogState.needsReacknowledgment` is detecting — when
// the authorization's hashable fields drift, the prior ack's
// snapshot no longer matches and the modal prompts re-record.
// -----------------------------------------------------------------------------

const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
])

/**
 * Same shared-field shape every Phase A/B/C consent helper writes.
 * Mirrors EnrollmentConsentsModal's `buildSharedFields`. Throws on
 * invalid channel input. Kept internal to this module so the modal
 * never constructs the ack row inline.
 */
function buildAckSharedFields({ providerId, subjectType, subjectId, channel, parentLabel, providerReason }) {
  if (channel !== 'parent_portal' && channel !== 'in_person_paper' && channel !== 'provider_override') {
    throw new Error(`buildAckSharedFields: unknown channel "${channel}"`)
  }
  if (channel === 'in_person_paper' && (!parentLabel || !parentLabel.trim())) {
    throw new Error('in_person_paper requires a non-blank parentLabel')
  }
  if (channel === 'provider_override' && (!providerReason || !providerReason.trim())) {
    throw new Error('provider_override requires a non-blank providerReason')
  }
  return {
    provider_id: providerId,
    subject_type: subjectType,
    subject_id: subjectId,
    acknowledged_via: channel,
    acknowledged_by_user_id: null,
    acknowledged_by_label: channel === 'in_person_paper' ? parentLabel.trim() : null,
    provider_override_reason: channel === 'provider_override' ? providerReason.trim() : null,
  }
}

async function archiveAcksOfType({ providerId, subjectType, subjectId, type }) {
  const { data: existing, error: selErr } = await supabase
    .from('acknowledgments')
    .select('id')
    .eq('provider_id', providerId)
    .eq('type', type)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .is('archived_at', null)
  if (selErr) return { error: selErr }
  const ids = (existing || []).map(r => r.id)
  if (ids.length === 0) return { error: null }
  const { error: updErr } = await supabase
    .from('acknowledgments')
    .update({ archived_at: new Date().toISOString() })
    .in('id', ids)
  return { error: updErr || null }
}

/**
 * Record the per-authorization parent permission ack
 * (`medication_permission`). Archives any prior active ack of the
 * same type for this authorization, then inserts a fresh row with
 * `subject_type='medication_authorization'` and
 * `subject_id=authorization.id`. The snapshot_hash is computed from
 * the authorization's current hashable fields via
 * `computeMedicationPermissionHash` — so drift detection
 * (`needsReacknowledgment` in `getDoseLogState`) is automatic.
 *
 * NOTE: this writes to `public.acknowledgments`, not to the
 * medication-specific tables. The two medication ACK_TYPES are
 * already in PR #16's catalog (`src/lib/acknowledgments.js`); this
 * helper is the medication-domain wrapper that knows the right
 * subject_type/subject_id pair and the right snapshot_hash source.
 */
export async function recordMedicationPermission({
  providerId,
  authorization,
  channel,
  parentLabel,
  providerReason,
} = {}) {
  if (!providerId)     throw new Error('recordMedicationPermission: providerId required')
  if (!authorization || !authorization.id) {
    throw new Error('recordMedicationPermission: authorization (with id) required')
  }
  const type = ACK_TYPES.MEDICATION_PERMISSION
  const archive = await archiveAcksOfType({
    providerId, subjectType: 'medication_authorization', subjectId: authorization.id, type,
  })
  if (archive.error) return { data: null, error: archive.error }

  const snapshot_hash = computeMedicationPermissionHash({ authorization })
  const row = {
    ...buildAckSharedFields({
      providerId,
      subjectType: 'medication_authorization',
      subjectId: authorization.id,
      channel,
      parentLabel,
      providerReason,
    }),
    type,
    snapshot_hash,
    snapshot_version: 'v1',
  }
  const { data, error } = await supabase
    .from('acknowledgments')
    .insert([row])
    .select()
    .maybeSingle()
  return { data, error }
}

/**
 * Record the per-child OTC-blanket consent ack
 * (`medication_permission_otc_blanket`). One ack per child;
 * `subject_type='child'`, `subject_id=childId`. Covers all topical
 * OTC authorizations collectively per R 400.1931(8) — (8) exempts
 * from (1) and (7) but NOT from (2), so each child still needs ONE
 * parent permission on file before any topical OTC is applied.
 */
export async function recordOtcBlanketPermission({
  providerId,
  childId,
  channel,
  parentLabel,
  providerReason,
} = {}) {
  if (!providerId) throw new Error('recordOtcBlanketPermission: providerId required')
  if (!childId)    throw new Error('recordOtcBlanketPermission: childId required')
  const type = ACK_TYPES.MEDICATION_PERMISSION_OTC_BLANKET
  const archive = await archiveAcksOfType({
    providerId, subjectType: 'child', subjectId: childId, type,
  })
  if (archive.error) return { data: null, error: archive.error }

  const row = {
    ...buildAckSharedFields({
      providerId,
      subjectType: 'child',
      subjectId: childId,
      channel,
      parentLabel,
      providerReason,
    }),
    type,
    snapshot_hash: computeAckHash({
      type,
      payload: { child_id: childId, copyVersion: 'v1' },
    }),
    snapshot_version: 'v1',
  }
  const { data, error } = await supabase
    .from('acknowledgments')
    .insert([row])
    .select()
    .maybeSingle()
  return { data, error }
}

/**
 * Fetch every medication-related parent permission ack for a child:
 *   - One OTC-blanket ack (subject_type='child', subject_id=childId).
 *   - N per-authorization acks (subject_type='medication_authorization',
 *     subject_id in <child's authorization ids>).
 *
 * The modal uses this to surface "consent on file" per authorization
 * AND the global OTC-blanket state. Pass the child's authorization
 * ids so the per-auth fetch is scoped.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.childId
 * @param {string[]} [args.authorizationIds]  Optional; if absent, only the OTC-blanket is fetched.
 * @returns {Promise<{
 *   data: {
 *     otcBlanket: object|null,
 *     perAuthorization: Record<string, object>,   // by authorization_id
 *   },
 *   error: object|null,
 * }>}
 */
export async function listMedicationConsentsForChild({ providerId, childId, authorizationIds } = {}) {
  if (!providerId || !childId) {
    return { data: { otcBlanket: null, perAuthorization: {} }, error: null }
  }
  const ackProjection =
    'id, type, subject_type, subject_id, snapshot_hash, archived_at, acknowledged_via, acknowledged_at, snapshot_version'

  // OTC-blanket — subject_type='child'.
  const otcResp = await supabase
    .from('acknowledgments')
    .select(ackProjection)
    .eq('provider_id', providerId)
    .eq('type', ACK_TYPES.MEDICATION_PERMISSION_OTC_BLANKET)
    .eq('subject_type', 'child')
    .eq('subject_id', childId)
    .is('archived_at', null)
    .order('acknowledged_at', { ascending: false })
    .limit(1)
  if (otcResp.error) return { data: { otcBlanket: null, perAuthorization: {} }, error: otcResp.error }
  const otcBlanket = (otcResp.data && otcResp.data[0]) || null

  // Per-authorization — only if we were given auth IDs.
  const perAuthorization = {}
  const ids = Array.isArray(authorizationIds) ? authorizationIds.filter(Boolean) : []
  if (ids.length > 0) {
    const perResp = await supabase
      .from('acknowledgments')
      .select(ackProjection)
      .eq('provider_id', providerId)
      .eq('type', ACK_TYPES.MEDICATION_PERMISSION)
      .eq('subject_type', 'medication_authorization')
      .in('subject_id', ids)
      .is('archived_at', null)
    if (perResp.error) {
      return { data: { otcBlanket, perAuthorization }, error: perResp.error }
    }
    // Defensive JS-side filter: Supabase's .eq + .in already narrow
    // the query, but rebuilding the set here makes the helper robust
    // against any caller passing an over-broad row set (e.g. a wrapped
    // test mock, or a future RLS broadening that changes what comes
    // back). Only rows of the exact type with subject_id in the
    // requested set are considered.
    const idsSet = new Set(ids)
    for (const a of perResp.data || []) {
      if (!a || a.type !== ACK_TYPES.MEDICATION_PERMISSION) continue
      if (!idsSet.has(a.subject_id)) continue
      // Keep the most-recent (archive-then-insert should prevent
      // duplicates, but defensive).
      const prior = perAuthorization[a.subject_id]
      if (!prior || (Date.parse(a.acknowledged_at) > Date.parse(prior.acknowledged_at))) {
        perAuthorization[a.subject_id] = a
      }
    }
  }
  return { data: { otcBlanket, perAuthorization }, error: null }
}

/**
 * Convenience: returns true iff the consent surface for the
 * authorization is in a satisfying state. Pure — for use inside
 * memos in the modal.
 *
 *   - Non-OTC authorization: needs an active `medication_permission`
 *     ack via a satisfying channel (parent_portal / in_person_paper).
 *     If the stored snapshot_hash differs from the current hash,
 *     consent is on file but STALE — caller can detect via
 *     `getDoseLogState.needsReacknowledgment`.
 *   - Topical OTC authorization: needs the per-child OTC-blanket
 *     ack via a satisfying channel. The blanket ack covers the
 *     whole child, not per-authorization.
 */
export function medicationConsentSatisfied({ authorization, perAuthAck, otcBlanketAck } = {}) {
  if (isTopicalOtcExempt(authorization)) {
    return !!(otcBlanketAck
      && !otcBlanketAck.archived_at
      && PARENT_SIGNED_SATISFYING_CHANNELS.includes(otcBlanketAck.acknowledged_via))
  }
  return !!(perAuthAck
    && !perAuthAck.archived_at
    && PARENT_SIGNED_SATISFYING_CHANNELS.includes(perAuthAck.acknowledged_via))
}
