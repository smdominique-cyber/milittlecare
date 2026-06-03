// Parent self-service data helpers — Phase X.
//
// Authoritative spec: docs/pr-parent-self-service-scope.md (Phase X).
// All parent write paths route through these helpers — NO inline
// `supabase.from(...)` in components per the per-PR convention.
//
// All writes use the SECURITY DEFINER RPCs added in migration 031:
//   - `child_parent_update`         — narrow column allowlist on `children`
//   - `parent_photo_consent_set`    — photo consent grant + revoke
//
// The Phase X surfaces (Consents tab + My Family page) call into
// these helpers. The RPCs enforce the parent-authorization check
// server-side (parent_family_links + child match); the helpers are
// the JS adapter only.

import { supabase } from './supabase'

/**
 * Photo-sharing consent grant. Inserts a parent_portal-channel
 * `photo_sharing_consent` row for the given child, archiving any
 * prior consent or revocation row first. Idempotent — repeating a
 * grant on an already-granted state re-archives and re-inserts.
 *
 * @param {object} args
 * @param {string} args.childId
 * @returns {Promise<{ data: number|null, error: object|null }>}
 *   `data` is the row count inserted (always 1 on success).
 */
export async function grantPhotoConsent({ childId } = {}) {
  if (!childId) {
    return { data: null, error: new Error('grantPhotoConsent: childId required') }
  }
  const { data, error } = await supabase.rpc('parent_photo_consent_set', {
    p_child_id: childId,
    p_grant:    true,
  })
  return { data, error }
}

/**
 * Photo-sharing consent revoke. Inserts a parent_portal-channel
 * `photo_sharing_consent_revoked` row for the given child, archiving
 * any prior consent or revocation row first.
 *
 * IMPORTANT (honest-copy rule, Consents Phase A scope §d): the parent
 * panel's revoke confirmation MUST NOT claim photo sharing has been
 * stopped. The messaging photo-attachment path does not yet consult
 * this consent state — enforcement is a future PR. The record is on
 * file; the enforcement is not. Use the panel's existing copy that
 * says "preference is recorded."
 *
 * @param {object} args
 * @param {string} args.childId
 */
export async function revokePhotoConsent({ childId } = {}) {
  if (!childId) {
    return { data: null, error: new Error('revokePhotoConsent: childId required') }
  }
  const { data, error } = await supabase.rpc('parent_photo_consent_set', {
    p_child_id: childId,
    p_grant:    false,
  })
  return { data, error }
}

/**
 * Update parent-authored child fields. Calls the SECURITY DEFINER
 * `child_parent_update` RPC which applies only the safe column
 * allowlist (`allergies`, `medical_notes`, `physician_*`,
 * `dentist_*`) and fires care-critical notifications for allergies
 * and medical_notes changes.
 *
 * Use the `apply` flags to distinguish "leave unchanged" from "set
 * to NULL" — only the columns flagged true are written. This lets a
 * caller update one field at a time without sending the others.
 *
 * @param {object} args
 * @param {string} args.childId
 * @param {{
 *   allergies?:       string|null,
 *   medical_notes?:   string|null,
 *   physician_name?:  string|null,
 *   physician_phone?: string|null,
 *   dentist_name?:    string|null,
 *   dentist_phone?:   string|null,
 * }} args.fields
 */
export async function updateChildAsParent({ childId, fields = {} } = {}) {
  if (!childId) {
    return { data: null, error: new Error('updateChildAsParent: childId required') }
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k)
  const params = {
    p_child_id:        childId,
    p_allergies:       has('allergies')       ? fields.allergies       : null,
    p_medical_notes:   has('medical_notes')   ? fields.medical_notes   : null,
    p_physician_name:  has('physician_name')  ? fields.physician_name  : null,
    p_physician_phone: has('physician_phone') ? fields.physician_phone : null,
    p_dentist_name:    has('dentist_name')    ? fields.dentist_name    : null,
    p_dentist_phone:   has('dentist_phone')   ? fields.dentist_phone   : null,
    p_apply_allergies:       has('allergies'),
    p_apply_medical_notes:   has('medical_notes'),
    p_apply_physician_name:  has('physician_name'),
    p_apply_physician_phone: has('physician_phone'),
    p_apply_dentist_name:    has('dentist_name'),
    p_apply_dentist_phone:   has('dentist_phone'),
  }
  const { data, error } = await supabase.rpc('child_parent_update', params)
  return { data, error }
}

/**
 * The list of fields the parent is allowed to edit on a child row.
 * Exposed so UI components can render the right form fields and so
 * the test surface can assert which columns are parent-editable.
 */
export const PARENT_EDITABLE_CHILD_FIELDS = Object.freeze([
  'allergies',
  'medical_notes',
  'physician_name',
  'physician_phone',
  'dentist_name',
  'dentist_phone',
])

/**
 * Care-critical fields — when these change, the provider gets a
 * notification (the RPC fires `notification_log` rows server-side).
 * Exposed for UI copy ("This will notify your provider").
 */
export const CARE_CRITICAL_CHILD_FIELDS = Object.freeze([
  'allergies',
  'medical_notes',
])
