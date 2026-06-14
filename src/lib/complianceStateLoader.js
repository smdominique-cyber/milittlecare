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
 *
 * §2a note (2026-06-09 loader-shape change): `safeQuery` returns []
 * for all three failure modes (genuine empty, PostgREST error, thrown
 * exception). Resolvers downstream cannot distinguish them. For the
 * twelve §2a-violating rows whose applicability silently collapses
 * `[]` to does_not_apply, the loader exposes a sibling
 * `sourceRowsLoaded` signal via `safeQueryWithLoaded` below — those
 * specific tables route through that wrapper instead. Other tables
 * keep using `safeQuery` and their resolvers keep their pre-fix
 * behavior (Option B from docs/pr-compliance-loader-shape-scope.md).
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

/**
 * §2a loader-shape change (2026-06-09). Variant of `safeQuery` that
 * additionally reports whether the underlying query succeeded.
 *
 * Return shape: `{ rows: Array, loaded: boolean }`.
 *  - `loaded: true`  — query ran cleanly; `rows` is the real result
 *                      set (which may legitimately be empty).
 *  - `loaded: false` — PostgREST returned an error OR an exception
 *                      was thrown. `rows` is always [] in this case.
 *
 * Used only for tables whose resolvers opt into the loaded signal:
 * the original five from the §2a audit (funding_sources,
 * medication_authorizations, medication_admin_events, acks via
 * combined childAcks+medAcks, health_safety_updates), plus
 * staff_training_records + training_requirements (E5 role-based
 * thresholds, 2026-06-09), plus caregivers, funding_documents,
 * miregistry_training_entries, and attendance_acks (§2a coverage
 * completion, 2026-06-09). Everything else stays on `safeQuery` to
 * preserve the non-opted-in rows' current behavior exactly.
 */
async function safeQueryWithLoaded(label, fn) {
  try {
    const result = await fn()
    if (result && result.error) return { rows: [], loaded: false }
    const rows = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : [])
    return { rows, loaded: true }
  } catch (err) {
    return { rows: [], loaded: false }
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
    return {
      provider: null,
      children: [],
      sourceRows: emptySourceRows(),
      sourceRowsLoaded: emptySourceRowsLoaded(),
    }
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
  //    provider) or all active children. Phase 3 fix-forward
  //    (2026-06-05): include `first_name, last_name` so the loader's
  //    convenience wrappers can expose display-ready child rows to
  //    the checklist UI (the per-child rollup on /compliance was
  //    rendering raw UUIDs). The pure engine layer ignores these
  //    fields — they're display data only.
  let childrenQuery = supabase
    .from('children')
    .select(
      'id, family_id, first_name, last_name, date_of_birth, ' +
      'intake_completed_at, records_last_reviewed_on, ' +
      'immunization_status, food_provider'
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
    const providerLevel = await loadProviderLevelRows(providerId, attendanceWindowDays)
    return {
      provider,
      children: [],
      sourceRows: providerLevel.sourceRows,
      sourceRowsLoaded: providerLevel.sourceRowsLoaded,
    }
  }

  // 3. Acknowledgments — child-subject rows. Routed through the
  //    loaded-signal wrapper because acks is one of the five tables
  //    whose §2a-violating resolvers (C4/C5) opt into the signal.
  const childAcksResp = await safeQueryWithLoaded('acknowledgments(child)', () =>
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
  const medAcksResp = await safeQueryWithLoaded('acknowledgments(medication_authorization)', () =>
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

  // 5. Medication authorizations + dose events. Both opted-in.
  const medAuthsResp = await safeQueryWithLoaded('medication_authorizations', () =>
    supabase
      .from('medication_authorizations')
      .select('*')
      .eq('provider_id', providerId)
      .in('child_id', allChildIds)
      .is('archived_at', null)
  )

  const doseEventsResp = await safeQueryWithLoaded('medication_administration_events', () =>
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
  //    Provider-level; not gated by childIds. caregivers carries the
  //    loaded signal (§2a coverage completion, 2026-06-09): a failed
  //    load is read by the staff/medication resolvers and must
  //    surface as `unknown`, not "no active caregivers."
  const caregiversResp = await safeQueryWithLoaded('caregivers', () =>
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
  const caregiversNormalized = caregiversResp.rows.map(c => ({
    ...c,
    regulatory_roles: (c.caregiver_regulatory_roles || [])
      .map(r => r && r.regulatory_role)
      .filter(Boolean),
  }))

  // staff_training_records + training_requirements carry the loaded
  // signal (E5 role-based thresholds, 2026-06-09): a failed load of
  // either must surface as `unknown`, not a false missing/on_file.
  //
  // Filter shape (2026-06-13 production-bug fix): the table has NO
  // `licensee_id` column; its licensee relationship is indirect via
  // `caregiver_id → caregivers.licensee_id` (matching the table's
  // RLS SELECT policy). The previous `.eq('licensee_id', providerId)`
  // 400'd for every provider — the §2a guard correctly surfaced this
  // as "couldn't verify" on all eight staff-files rows. Reuse the
  // caregiver list already loaded above instead of a relationship
  // embed — the ids are in hand and a flat `.in()` avoids a
  // PostgREST relationship dependency. When caregivers loaded cleanly
  // and is empty, skip the query (no caregivers ⇒ no records, by
  // precondition); when caregivers failed, propagate the load
  // failure to `staff_training_records.loaded` so resolvers honestly
  // resolve to UNKNOWN rather than a false on_file.
  const staffTrainingCaregiverIds = caregiversNormalized.map(c => c.id)
  const staffTrainingResp = staffTrainingCaregiverIds.length === 0
    ? { rows: [], loaded: caregiversResp.loaded }
    : await safeQueryWithLoaded('staff_training_records', () =>
        supabase
          .from('staff_training_records')
          .select('*')
          .in('caregiver_id', staffTrainingCaregiverIds)
      )

  // Statewide reference catalog (migration 013) — no provider filter;
  // SELECT-only RLS for every authenticated user.
  const trainingRequirementsResp = await safeQueryWithLoaded('training_requirements', () =>
    supabase
      .from('training_requirements')
      .select('*')
  )

  const healthSafetyResp = await safeQueryWithLoaded('health_safety_updates', () =>
    supabase
      .from('health_safety_updates')
      .select('*')
      .eq('licensee_id', providerId)
  )

  // 7. Funding sources + documents (provider-level). funding_sources
  //    opts into the loaded signal — this is the originally-motivating
  //    table (the four CDC rows G2/G3/G4/H1). funding_documents joined
  //    the signal 2026-06-09 (§2a coverage completion): a failed load
  //    read the enrollment-agreement row falsely red.
  const fundingResp = await safeQueryWithLoaded('funding_sources', () =>
    supabase
      .from('funding_sources')
      .select('*')
      .eq('user_id', providerId)
      .is('archived_at', null)
  )

  const fundingDocumentsResp = await safeQueryWithLoaded('funding_documents', () =>
    supabase
      .from('funding_documents')
      .select('*')
      .eq('user_id', providerId)
      .is('archived_at', null)
  )

  // 8. MiRegistry training entries (provider-level — LEP).
  const miregistryEntriesResp = await safeQueryWithLoaded('miregistry_training_entries', () =>
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
  // Filter shape (2026-06-13 production-bug fix): the table has NO
  // `provider_id` column AND NO `licensee_id` column. Its provider
  // relationship is indirect via `child_id → children.user_id`
  // (matching the table's RLS SELECT policy, which goes through
  // attendance.user_id = auth.uid()). The previous
  // `.eq('provider_id', providerId)` 400'd for every provider.
  // Filter through the loaded children list — already in scope, and
  // `allChildIds` is guaranteed non-empty at this point (the empty
  // case returned via loadProviderLevelRows above).
  const attendanceAcksResp = await safeQueryWithLoaded('attendance_acknowledgments', () =>
    supabase
      .from('attendance_acknowledgments')
      .select('id, child_id, date, segment_index, acknowledged_via, archived_at')
      .in('child_id', allChildIds)
      .gte('date', cutoff)
      .is('archived_at', null)
  )

  // §2a loaded signal — acks is one logical table merged from two
  //   queries; report loaded only when BOTH halves loaded cleanly.
  //   If only the medication-subject half failed, C4/C5 (child-acks
  //   readers) would still be at risk because we can't distinguish
  //   per-half from the merged array — conservative: any half failed
  //   ⇒ acks loaded = false.
  const acksLoaded = childAcksResp.loaded && medAcksResp.loaded

  return {
    provider,
    children,
    sourceRows: {
      acks: [...childAcksResp.rows, ...medAcksResp.rows],
      medication_authorizations: medAuthsResp.rows,
      medication_admin_events: doseEventsResp.rows,
      caregivers: caregiversNormalized,
      staff_training_records: staffTrainingResp.rows,
      training_requirements: trainingRequirementsResp.rows,
      health_safety_updates: healthSafetyResp.rows,
      funding_sources: fundingResp.rows,
      funding_documents: fundingDocumentsResp.rows,
      miregistry_training_entries: miregistryEntriesResp.rows,
      attendance_acks: attendanceAcksResp.rows,
      // Pattern E slots — sources not yet shipped.
      drill_logs: null,
      property_records: null,
    },
    // §2a sibling signal (Option B per
    // docs/pr-compliance-loader-shape-scope.md §2.2). Eleven tables
    // opt in (five from the 2026-06-09 loader-shape change,
    // staff_training_records + training_requirements for E5's
    // role-based thresholds, and caregivers + funding_documents +
    // miregistry_training_entries + attendance_acks from the §2a
    // coverage-completion pass). An absent key (or `undefined`)
    // never triggers the UNKNOWN branch — only `=== false` does.
    sourceRowsLoaded: {
      acks:                        acksLoaded,
      medication_authorizations:   medAuthsResp.loaded,
      medication_admin_events:     doseEventsResp.loaded,
      caregivers:                  caregiversResp.loaded,
      health_safety_updates:       healthSafetyResp.loaded,
      funding_sources:             fundingResp.loaded,
      funding_documents:           fundingDocumentsResp.loaded,
      staff_training_records:      staffTrainingResp.loaded,
      training_requirements:       trainingRequirementsResp.loaded,
      miregistry_training_entries: miregistryEntriesResp.loaded,
      attendance_acks:             attendanceAcksResp.loaded,
    },
  }
}

/**
 * Sub-loader used when the children list is empty — we still want
 * provider-level requirements (drills, property, staff, miregistry,
 * funding_docs, cdc_compliance) to evaluate.
 *
 * Returns `{ sourceRows, sourceRowsLoaded }` (2026-06-09 shape change).
 * In the no-children case the four child-scoped opted-in tables
 * (`acks`, `medication_authorizations`, `medication_admin_events`,
 * `attendance_acks`) are intrinsically empty by precondition — no
 * children means no per-child rows possible — so their loaded flag is
 * `true`. The provider-level opted-in tables are actually queried
 * here and report their real loaded value.
 */
async function loadProviderLevelRows(providerId, attendanceWindowDays) {
  // Reuse the main loader's per-table calls but skip child-scoped ones.
  const caregiversResp = await safeQueryWithLoaded('caregivers', () =>
    supabase
      .from('caregivers')
      .select(`
        id, full_name, email, app_user_id, date_of_hire, archived_at,
        caregiver_regulatory_roles ( regulatory_role )
      `)
      .eq('licensee_id', providerId)
      .is('archived_at', null)
  )
  const caregiversNormalized = caregiversResp.rows.map(c => ({
    ...c,
    regulatory_roles: (c.caregiver_regulatory_roles || [])
      .map(r => r && r.regulatory_role)
      .filter(Boolean),
  }))
  // Same fix as the main loader (see 2026-06-13 note above):
  // staff_training_records has no licensee_id column. Filter through
  // caregiver_id, reusing the just-loaded caregiver list. Skip-query
  // shortcut on empty caregivers, propagating the caregivers loaded
  // signal so a failure surfaces as UNKNOWN.
  const staffTrainingCaregiverIds = caregiversNormalized.map(c => c.id)
  const staffTrainingResp = staffTrainingCaregiverIds.length === 0
    ? { rows: [], loaded: caregiversResp.loaded }
    : await safeQueryWithLoaded('staff_training_records', () =>
        supabase
          .from('staff_training_records')
          .select('*')
          .in('caregiver_id', staffTrainingCaregiverIds)
      )
  const trainingRequirementsResp = await safeQueryWithLoaded('training_requirements', () =>
    supabase.from('training_requirements').select('*')
  )
  const healthSafetyResp = await safeQueryWithLoaded('health_safety_updates', () =>
    supabase.from('health_safety_updates').select('*').eq('licensee_id', providerId)
  )
  const fundingResp = await safeQueryWithLoaded('funding_sources', () =>
    supabase.from('funding_sources').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  const fundingDocumentsResp = await safeQueryWithLoaded('funding_documents', () =>
    supabase.from('funding_documents').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  const miregistryEntriesResp = await safeQueryWithLoaded('miregistry_training_entries', () =>
    supabase.from('miregistry_training_entries').select('*').eq('user_id', providerId).is('archived_at', null)
  )
  return {
    sourceRows: {
      acks: [],
      medication_authorizations: [],
      medication_admin_events: [],
      caregivers: caregiversNormalized,
      staff_training_records: staffTrainingResp.rows,
      training_requirements: trainingRequirementsResp.rows,
      health_safety_updates: healthSafetyResp.rows,
      funding_sources: fundingResp.rows,
      funding_documents: fundingDocumentsResp.rows,
      miregistry_training_entries: miregistryEntriesResp.rows,
      attendance_acks: [],
      drill_logs: null,
      property_records: null,
    },
    sourceRowsLoaded: {
      // No children → these four are empty by precondition, not by
      // load failure. Treat as loaded so any provider-level §2a-row
      // gated on them resolves the same way it would with an explicit
      // empty result set.
      acks:                        true,
      medication_authorizations:   true,
      medication_admin_events:     true,
      attendance_acks:             true,
      caregivers:                  caregiversResp.loaded,
      health_safety_updates:       healthSafetyResp.loaded,
      funding_sources:             fundingResp.loaded,
      funding_documents:           fundingDocumentsResp.loaded,
      staff_training_records:      staffTrainingResp.loaded,
      training_requirements:       trainingRequirementsResp.loaded,
      miregistry_training_entries: miregistryEntriesResp.loaded,
    },
  }
}

function emptySourceRows() {
  return {
    acks: [],
    medication_authorizations: [],
    medication_admin_events: [],
    caregivers: [],
    staff_training_records: [],
    training_requirements: [],
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
 * Mirrors `emptySourceRows()` for the loaded signal. Used only when
 * `loadComplianceSourceRows` is called without a providerId — a
 * precondition failure path that no production caller exercises. All
 * eleven opted-in tables read as `true` here because the precondition
 * failure isn't a load failure, and the legacy behavior (empty rows
 * → does_not_apply where applicable) is what we preserve.
 */
function emptySourceRowsLoaded() {
  return {
    acks:                        true,
    medication_authorizations:   true,
    medication_admin_events:     true,
    caregivers:                  true,
    health_safety_updates:       true,
    funding_sources:             true,
    funding_documents:           true,
    staff_training_records:      true,
    training_requirements:       true,
    miregistry_training_entries: true,
    attendance_acks:             true,
  }
}

/**
 * Convenience: load + compute provider-level state in one call.
 * Phase 2 consumers (e.g., a Compliance dashboard widget) will
 * typically call this.
 */
export async function computeProviderComplianceState({ providerId, childIds, now = new Date() } = {}) {
  const { provider, children, sourceRows, sourceRowsLoaded } = await loadComplianceSourceRows({ providerId, childIds })
  if (!provider) return null
  return getProviderComplianceStatePure({ provider, children, sourceRows, sourceRowsLoaded, now })
}

/**
 * Convenience: load + compute per-child state.
 */
export async function computeChildComplianceState({ providerId, childId, now = new Date() } = {}) {
  if (!providerId || !childId) return null
  const { provider, children, sourceRows, sourceRowsLoaded } = await loadComplianceSourceRows({ providerId, childIds: [childId] })
  if (!provider) return null
  const child = children.find(c => c.id === childId)
  if (!child) return null
  return getChildComplianceStatePure({ child, provider, sourceRows, sourceRowsLoaded, now })
}

// -----------------------------------------------------------------------------
// Phase 3 — applicability overrides loader + mutation helpers.
//
// Reads/writes the compliance_applicability_overrides table (migration 037).
// The pure engine already accepts the Map shape these functions produce; no
// engine API change.
//
// §2a contract: a row is the affirmative basis. An absent row (or an
// archived row) makes the engine fall back to the registry's
// autoDefault. Phase 3 UI ONLY writes provider-wide rows (family_id +
// child_id both NULL) — the narrower-scope columns are forward-compat
// per the migration 037 header.
// -----------------------------------------------------------------------------

/**
 * Load every active applicability override row for a provider and
 * convert to the `Map<requirement_key, 'applies' | 'does_not_apply'>`
 * shape `resolveApplicability` accepts as the `overrides` parameter.
 *
 * Phase 3 honors only PROVIDER-WIDE rows (family_id IS NULL AND
 * child_id IS NULL). Rows with a non-null narrower scope are
 * forward-compat — silently skipped until a per-family or per-child
 * writer ships.
 *
 * Defensive: returns an empty Map on any error (per the loader's
 * project-wide defensive contract). The engine then falls back to
 * autoDefault for every row, which is the safe behavior — never
 * `does_not_apply` without a real row.
 */
export async function loadApplicabilityOverrides({ providerId } = {}) {
  if (!providerId) return new Map()
  const rows = await safeQuery('compliance_applicability_overrides', () =>
    supabase
      .from('compliance_applicability_overrides')
      .select('requirement_key, mode, family_id, child_id')
      .eq('provider_id', providerId)
      .is('archived_at', null)
  )
  const map = new Map()
  for (const row of rows) {
    // Forward-compat: skip rows with a narrower scope. The narrower-
    // overrides-wider semantics ships when a writer for that scope
    // does.
    if (row.family_id || row.child_id) continue
    if (row.mode === 'applies' || row.mode === 'does_not_apply') {
      map.set(row.requirement_key, row.mode)
    }
  }
  return map
}

/**
 * Upsert a provider-wide applicability override.
 *
 * Idempotent: re-saving the same answer leaves the table state
 * unchanged (modulo updated_at). The partial-unique index makes
 * "one active row per (provider, requirement_key, family_id,
 * child_id)" the schema-enforced invariant; this helper achieves
 * it by archiving any existing active row before inserting the
 * new one (archive-then-insert protocol, same shape as
 * consent_templates edits).
 *
 * Passing `mode = null` resets to auto by archiving the current
 * active row WITHOUT inserting a replacement — the engine then
 * falls back to the registry's autoDefault for that requirement.
 *
 * NOTE on §2a: this helper never writes 'does_not_apply' implicitly.
 * Only an explicit caller-supplied `mode = 'does_not_apply'` produces
 * such a row. A "Skip — ask me later" UI affordance MUST translate
 * to `mode = null` (reset to auto), NOT `mode = 'does_not_apply'`.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string} args.requirementKey
 * @param {'applies'|'does_not_apply'|null} args.mode
 *   null = archive the current active row (reset to autoDefault).
 * @param {string|null} [args.familyId]    Phase 3 always passes null.
 * @param {string|null} [args.childId]     Phase 3 always passes null.
 * @param {string|null} [args.notes]
 * @returns {Promise<{ ok: boolean, error?: any }>}
 */
export async function setApplicabilityOverride({
  providerId,
  requirementKey,
  mode,
  familyId = null,
  childId = null,
  notes = null,
} = {}) {
  if (!providerId || !requirementKey) {
    return { ok: false, error: new Error('setApplicabilityOverride: providerId + requirementKey required') }
  }
  if (mode !== null && mode !== 'applies' && mode !== 'does_not_apply') {
    return { ok: false, error: new Error(`setApplicabilityOverride: invalid mode ${mode}`) }
  }

  // 1. Archive every active row for this exact (provider, requirement,
  //    family, child) tuple. PostgREST's null-aware matching needs
  //    .is() for the nullable columns.
  let archiveQ = supabase
    .from('compliance_applicability_overrides')
    .update({ archived_at: new Date().toISOString() })
    .eq('provider_id', providerId)
    .eq('requirement_key', requirementKey)
    .is('archived_at', null)
  archiveQ = familyId == null ? archiveQ.is('family_id', null) : archiveQ.eq('family_id', familyId)
  archiveQ = childId  == null ? archiveQ.is('child_id', null)  : archiveQ.eq('child_id', childId)
  const archiveResp = await archiveQ
  if (archiveResp.error) {
    return { ok: false, error: archiveResp.error }
  }

  // 2. If mode was null, we're done — that was a reset.
  if (mode === null) return { ok: true }

  // 3. Insert the new active row.
  const { data: userResp } = await supabase.auth.getUser()
  const insertResp = await supabase
    .from('compliance_applicability_overrides')
    .insert({
      provider_id:    providerId,
      requirement_key: requirementKey,
      mode,
      family_id:      familyId,
      child_id:       childId,
      set_at:         new Date().toISOString(),
      set_by_user_id: userResp?.user?.id || providerId,
      notes:          notes || null,
    })
  if (insertResp.error) {
    return { ok: false, error: insertResp.error }
  }
  return { ok: true }
}

/**
 * Convenience: load source rows + overrides + compute provider rollup
 * in one call. The Phase 3 checklist surfaces use this; Phase 4's
 * score will too. Replaces the Phase 1 `computeProviderComplianceState`
 * for any consumer that wants overrides honored (which is everyone
 * Phase 3 onward).
 *
 * Return shape (Phase 3 fix-forward 2026-06-05):
 *   { state: ProviderComplianceState, children: Array<ChildRow> }
 * Children carry `id, first_name, last_name` plus the fields the
 * engine reads, so UI consumers can render child names in the
 * per-child rollup without a second fetch. Returns `null` only when
 * the provider profile itself can't be loaded.
 */
export async function computeProviderComplianceStateWithOverrides({
  providerId,
  childIds,
  now = new Date(),
} = {}) {
  if (!providerId) return null
  const [{ provider, children, sourceRows, sourceRowsLoaded }, overrides] = await Promise.all([
    loadComplianceSourceRows({ providerId, childIds }),
    loadApplicabilityOverrides({ providerId }),
  ])
  if (!provider) return null
  const state = getProviderComplianceStatePure({ provider, children, sourceRows, sourceRowsLoaded, overrides, now })
  // §2a loader-shape change (2026-06-09): expose the per-table loaded
  // signal on the envelope per docs/pr-compliance-loader-shape-scope.md
  // §2.5 decision #2. Existing UI consumers
  // (ComplianceChecklistPage, FamilyComplianceTab) ignore the new
  // field and gate rendering on their own React `loading` state — so
  // their behavior is unchanged. Future non-page consumers can
  // branch on this signal to avoid reintroducing flicker.
  return { state, children: children || [], sourceRowsLoaded }
}

/**
 * Same as above but per-child.
 *
 * Return shape (Phase 3 fix-forward):
 *   { state: PerChildComplianceState, child: ChildRow }
 */
export async function computeChildComplianceStateWithOverrides({
  providerId,
  childId,
  now = new Date(),
} = {}) {
  if (!providerId || !childId) return null
  const [{ provider, children, sourceRows, sourceRowsLoaded }, overrides] = await Promise.all([
    loadComplianceSourceRows({ providerId, childIds: [childId] }),
    loadApplicabilityOverrides({ providerId }),
  ])
  if (!provider) return null
  const child = children.find(c => c.id === childId)
  if (!child) return null
  const state = getChildComplianceStatePure({ child, provider, sourceRows, sourceRowsLoaded, overrides, now })
  return { state, child, sourceRowsLoaded }
}
