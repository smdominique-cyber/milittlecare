// Compliance Engine Phase 1 — impure Supabase loader.
//
// Authoritative spec: docs/pr-compliance-engine-phase-1-scope.md §5.
// Fans out the queries the pure `complianceState.js` verdicts need,
// returns a `SourceRows` object the pure layer consumes. Mirrors the
// impure-caller pattern from `getChildFilesAuditState` (childFiles.js)
// + `loadComplianceSourceRows` should always be paired with a pure
// computation step — never inline DB logic in verdict code.
//
// Defensive shape: any table query that errors (missing migration,
// RLS reject) returns an empty array; the resolver continues with
// the rows it has. The engine never crashes the page over a single
// missing table — Pattern E + the loader's empty-defaults converge
// on `{ kind: 'unknown', reason: ... }` for the affected requirement.
//
// Field-name confirmations (per §7):
//   - profiles.miregistry_current_level (text, 'level_1' | 'level_2'),
//     profiles.miregistry_level_2_expires_on (date),
//     profiles.miregistry_level_last_updated_at (timestamptz)
//     — all three from migration 009 (verified 2026-06-03).
//   - caregivers.licensee_id (uuid → auth.users) — verified against
//     migration 012:94 + src/lib/staffTraining.js usage.
//   - children.user_id, .archived_at, .intake_completed_at,
//     .records_last_reviewed_on, .immunization_status, .food_provider,
//     .date_of_birth — verified against migrations 016, 021, 024.
//   - acknowledgments shape (provider_id, subject_type, subject_id,
//     type, acknowledged_via, acknowledged_at, expires_at,
//     snapshot_hash, archived_at, occurrence_metadata, id) —
//     verified against migrations 024, 026, 027.

import { supabase } from './supabase'
import {
  getProviderComplianceState as getProviderComplianceStatePure,
  getChildComplianceState as getChildComplianceStatePure,
} from './complianceState'

const DEFAULT_ATTENDANCE_WINDOW_DAYS = 90

/**
 * Defensive query wrapper. Returns rows array on success, [] on any
 * error (per the loader's defensive contract). Never throws.
 */
async function safeQuery(label, fn) {
  try {
    const result = await fn()
    if (result && result.error) {
      // PostgREST returned an error — typically schema/RLS. Swallow
      // and return []. The pure verdict reports `unknown` for any
      // requirement that needs the missing rows.
      return []
    }
    return Array.isArray(result.data) ? result.data : (result.data ? [result.data] : [])
  } catch (err) {
    // Network / unexpected. Swallow per the defensive contract.
    return []
  }
}

async function safeMaybeSingle(label, fn) {
  try {
    const result = await fn()
    if (result && result.error) return null
    return result.data || null
  } catch (err) {
    return null
  }
}

/**
 * Fans out the queries the pure verdict layer needs. Returns the
 * `SourceRows` object + the loaded `provider` + `children` lists.
 *
 * @param {object} args
 * @param {string} args.providerId            licensee's auth.uid()
 * @param {string[]} [args.childIds]          when omitted, loads all active children
 * @param {number} [args.attendanceWindowDays=90]
 *   How many days of attendance acks to pull. Default 90 (avoids
 *   loading a year of per-day rows for every read).
 * @returns {Promise<{ provider: object|null, children: object[], sourceRows: object }>}
 */
export async function loadComplianceSourceRows({
  providerId,
  childIds,
  attendanceWindowDays = DEFAULT_ATTENDANCE_WINDOW_DAYS,
} = {}) {
  if (!providerId) {
    return { provider: null, children: [], sourceRows: emptySourceRows() }
  }

  // 1. Provider profile.
  const provider = await safeMaybeSingle('profiles', () =>
    supabase
      .from('profiles')
      .select(
        'id, license_type, home_built_before_1978, firearms_on_premises, ' +
        'is_license_exempt, fingerprint_date, michigan_provider_id, ' +
        'michigan_license_number, miregistry_id, program_settings, ' +
        // §7 Blocker 1 resolution — actual field names per migration 009.
        'miregistry_current_level, miregistry_level_2_expires_on, ' +
        'miregistry_level_last_updated_at'
      )
      .eq('id', providerId)
      .maybeSingle()
  )

  // 2. Children. Either the supplied subset (resolved against this
  //    provider) or all active children.
  let childrenQuery = supabase
    .from('children')
    .select(
      'id, family_id, date_of_birth, intake_completed_at, ' +
      'records_last_reviewed_on, immunization_status, food_provider'
    )
    .eq('user_id', providerId)
    .is('archived_at', null)
  if (Array.isArray(childIds) && childIds.length > 0) {
    childrenQuery = childrenQuery.in('id', childIds)
  }
  const children = await safeQuery('children', () => childrenQuery)
  const allChildIds = children.map(c => c.id)

  if (allChildIds.length === 0 && (!Array.isArray(childIds) || childIds.length === 0)) {
    // No children — provider-level requirements still need to load.
    return {
      provider,
      children: [],
      sourceRows: await loadProviderLevelRows(providerId, attendanceWindowDays),
    }
  }

  // 3. Acknowledgments — child-subject rows.
  const childAcks = await safeQuery('acknowledgments(child)', () =>
    supabase
      .from('acknowledgments')
      .select(
        'id, type, subject_type, subject_id, acknowledged_via, ' +
        'acknowledged_at, expires_at, archived_at, snapshot_hash, ' +
        'occurrence_metadata'
      )
      .eq('provider_id', providerId)
      .eq('subject_type', 'child')
      .in('subject_id', allChildIds)
      .is('archived_at', null)
  )

  // 4. Acknowledgments — medication_authorization-subject rows.
  //    (subject_id is the auth UUID, not a child UUID, so we can't
  //    .in() them by childIds — fetch by provider_id + subject_type.)
  const medAcks = await safeQuery('acknowledgments(medication_authorization)', () =>
    supabase
      .from('acknowledgments')
      .select(
        'id, type, subject_type, subject_id, acknowledged_via, ' +
        'acknowledged_at, expires_at, archived_at, snapshot_hash'
      )
      .eq('provider_id', providerId)
      .eq('subject_type', 'medication_authorization')
      .is('archived_at', null)
  )

  // 5. Medication authorizations + dose events.
  const medAuths = await safeQuery('medication_authorizations', () =>
    supabase
      .from('medication_authorizations')
      .select('*')
      .eq('provider_id', providerId)
      .in('child_id', allChildIds)
      .is('archived_at', null)
  )

  const doseEvents = await safeQuery('medication_administration_events', () =>
    supabase
      .from('medication_administration_events')
      .select(
        'id, authorization_id, child_id, administered_by_caregiver_id, ' +
        'administered_at, archived_at'
      )
      .eq('provider_id', providerId)
      .is('archived_at', null)
  )

  // 6. Caregivers + staff training + health-safety updates.
  //    Provider-level; not gated by childIds.
  const caregivers = await safeQuery('caregivers', () =>
    supabase
      .from('caregivers')
      .select(`
        id, full_name, email, app_user_id, date_of_hire, archived_at,
        caregiver_regulatory_roles ( regulatory_role )
      `)
      .eq('licensee_id', providerId)
      .is('archived_at', null)
  )

  // Normalize caregiver roles to a flat array on each row for the
  // pure verdict layer's role-check helper.
  const caregiversNormalized = caregivers.map(c => ({
    ...c,
    regulatory_roles: (c.caregiver_regulatory_roles || [])
      .map(r => r && r.regulatory_role)
      .filter(Boolean),
  }))

  const staffTraining = await safeQuery('staff_training_records', () =>
    supabase
      .from('staff_training_records')
      .select('*')
      .eq('licensee_id', providerId)
  )

  const healthSafetyUpdates = await safeQuery('health_safety_updates', () =>
    supabase
      .from('health_safety_updates')
      .select('*')
      .eq('licensee_id', providerId)
  )

  // 7. Funding sources + documents (provider-level).
  const fundingSources = await safeQuery('funding_sources', () =>
    supabase
      .from('funding_sources')
      .select('*')
      .eq('user_id', providerId)
      .is('archived_at', null)
  )

  const fundingDocuments = await safeQuery('funding_documents', () =>
    supabase
      .from('funding_documents')
      .select('*')
      .eq('user_id', providerId)
      .is('archived_at', null)
  )

  // 8. MiRegistry training entries (provider-level — LEP).
  const miregistryEntries = await safeQuery('miregistry_training_entries', () =>
    supabase
      .from('miregistry_training_entries')
      .select('*')
      .eq('user_id', providerId)
      .is('archived_at', null)
  )

  // 9. Attendance acks — windowed (default 90 days). The volume
  //    concern from §5: a full year of per-day rows for every child
  //    is heavy; the window is the knob.
  const cutoff = new Date(Date.now() - attendanceWindowDays * 86400000)
    .toISOString()
    .slice(0, 10)
  const attendanceAcks = await safeQuery('attendance_acknowledgments', () =>
    supabase
      .from('attendance_acknowledgments')
      .select('id, child_id, date, segment_index, acknowledged_via, archived_at')
      .eq('provider_id', providerId)
      .gte('date', cutoff)
      .is('archived_at', null)
  )

  return {
    provider,
    children,
    sourceRows: {
      acks: [...childAcks, ...medAcks],
      medication_authorizations: medAuths,
      medication_admin_events: doseEvents,
      caregivers: caregiversNormalized,
      staff_training_records: staffTraining,
      health_safety_updates: healthSafetyUpdates,
      funding_sources: fundingSources,
      funding_documents: fundingDocuments,
      miregistry_training_entries: miregistryEntries,
      attendance_acks: attendanceAcks,
      // Pattern E slots — sources not yet shipped.
      drill_logs: null,
      property_records: null,
    },
  }
}

/**
 * Sub-loader used when the children list is empty — we still want
 * provider-level requirements (drills, property, staff, miregistry,
 * funding_docs, cdc_compliance) to evaluate.
 */
async function loadProviderLevelRows(providerId, attendanceWindowDays) {
  // Reuse the main loader's per-table calls but skip child-scoped ones.
  const caregivers = await safeQuery('caregivers', () =>
    supabase
      .from('caregivers')
      .select(`
        id, full_name, email, app_user_id, date_of_hire, archived_at,
        caregiver_regulatory_roles ( regulatory_role )
      `)
      .eq('licensee_id', providerId)
      .is('archived_at', null)
  )
  const caregiversNormalized = caregivers.map(c => ({
    ...c,
    regulatory_roles: (c.caregiver_regulatory_roles || [])
      .map(r => r && r.regulatory_role)
      .filter(Boolean),
  }))
  const staffTraining = await safeQuery('staff_training_records', () =>
    supabase.from('staff_training_records').select('*').eq('licensee_id', providerId)
  )
  const healthSafetyUpdates = await safeQuery('health_safety_updates', () =>
    supabase.from('health_safety_updates').select('*').eq('licensee_id', providerId)
  )
  const fundingSources = await safeQuery('funding_sources', () =>
    supabase.from('funding_sources').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  const fundingDocuments = await safeQuery('funding_documents', () =>
    supabase.from('funding_documents').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  const miregistryEntries = await safeQuery('miregistry_training_entries', () =>
    supabase.from('miregistry_training_entries').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  return {
    acks: [],
    medication_authorizations: [],
    medication_admin_events: [],
    caregivers: caregiversNormalized,
    staff_training_records: staffTraining,
    health_safety_updates: healthSafetyUpdates,
    funding_sources: fundingSources,
    funding_documents: fundingDocuments,
    miregistry_training_entries: miregistryEntries,
    attendance_acks: [],
    drill_logs: null,
    property_records: null,
  }
}

function emptySourceRows() {
  return {
    acks: [],
    medication_authorizations: [],
    medication_admin_events: [],
    caregivers: [],
    staff_training_records: [],
    health_safety_updates: [],
    funding_sources: [],
    funding_documents: [],
    miregistry_training_entries: [],
    attendance_acks: [],
    drill_logs: null,
    property_records: null,
  }
}

/**
 * Convenience: load + compute provider-level state in one call.
 * Phase 2 consumers (e.g., a Compliance dashboard widget) will
 * typically call this.
 */
export async function computeProviderComplianceState({ providerId, childIds, now = new Date() } = {}) {
  const { provider, children, sourceRows } = await loadComplianceSourceRows({ providerId, childIds })
  if (!provider) return null
  return getProviderComplianceStatePure({ provider, children, sourceRows, now })
}

/**
 * Convenience: load + compute per-child state.
 */
export async function computeChildComplianceState({ providerId, childId, now = new Date() } = {}) {
  if (!providerId || !childId) return null
  const { provider, children, sourceRows } = await loadComplianceSourceRows({ providerId, childIds: [childId] })
  if (!provider) return null
  const child = children.find(c => c.id === childId)
  if (!child) return null
  return getChildComplianceStatePure({ child, provider, sourceRows, now })
}
