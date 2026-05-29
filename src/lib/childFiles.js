// PR #16 — Audit-state helper for the child-files domain.
//
// Per the cross-cutting audit-state mandate (CLAUDE.md § Critical Domain
// Knowledge + PR #16 scope § B.1a), every domain PR ships a
// `getXxxAuditState(licensee_id)` pure helper. PR #22 (Compliance Health
// Score) consumes these helpers uniformly to compose the unified score.
//
// Signature + return shape mirror `src/lib/reminderSystem.js`
// `getReminderSystemAuditState`:
//   { domain: 'child_files', type: 'type_2', ...domain-specific counts }
//
// Read-only. Tolerant of the schema not being applied yet (matches the
// PR #15 helper's defensive shape: when PostgREST returns an error, the
// helper returns the zero-shape rather than crashing the dashboard).

import { supabase } from './supabase'

/**
 * @typedef {Object} ChildFilesAuditState
 * @property {'child_files'}   domain
 * @property {'type_2'}        type                                 MILittleCare-owned (counted by PR #22 default)
 * @property {number}          active_children_count                children.archived_at IS NULL
 * @property {number}          intake_complete_count                children.intake_completed_at IS NOT NULL
 * @property {number}          intake_incomplete_count
 * @property {number}          annual_review_overdue_count          records_last_reviewed_on + 1y < today, or null
 * @property {number}          pending_lead_disclosures_count       profile.home_built_before_1978=true AND child lacks lead_disclosure ack
 * @property {number}          pending_firearms_disclosures_count   profile.firearms_on_premises set AND child lacks firearms_disclosure ack
 */

/**
 * @param {string} licenseeId
 * @returns {Promise<ChildFilesAuditState>}
 */
export async function getChildFilesAuditState(licenseeId) {
  const empty = {
    domain: 'child_files',
    type: 'type_2',
    active_children_count: 0,
    intake_complete_count: 0,
    intake_incomplete_count: 0,
    annual_review_overdue_count: 0,
    pending_lead_disclosures_count: 0,
    pending_firearms_disclosures_count: 0,
  }

  if (!licenseeId) return empty

  // 1) Pull the licensee's profile disclosures. We must select EVERY
  //    column the downstream logic reads (PR #15 lesson).
  let profile = null
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('home_built_before_1978, firearms_on_premises')
      .eq('id', licenseeId)
      .maybeSingle()
    if (error) return empty
    profile = data
  } catch {
    return empty
  }

  // 2) Pull every active (non-archived) child for the licensee.
  let children = []
  try {
    const { data, error } = await supabase
      .from('children')
      .select('id, intake_completed_at, records_last_reviewed_on, date_of_birth')
      .eq('user_id', licenseeId)
      .is('archived_at', null)
    if (error) return empty
    children = Array.isArray(data) ? data : []
  } catch {
    return empty
  }

  if (children.length === 0) return empty
  const childIds = children.map(c => c.id)

  // 3) Pull every active acknowledgment for those children. We only
  //    need (subject_id, type) to count missing lead / firearms.
  let acks = []
  try {
    const { data, error } = await supabase
      .from('acknowledgments')
      .select('subject_id, type')
      .eq('provider_id', licenseeId)
      .eq('subject_type', 'child')
      .in('subject_id', childIds)
      .is('archived_at', null)
    if (error) {
      // Acknowledgments table may not exist yet (migration 024 not
      // applied). Return the children-only zeros for disclosure counts.
      return {
        ...empty,
        active_children_count: children.length,
        intake_complete_count: children.filter(c => c.intake_completed_at != null).length,
        intake_incomplete_count: children.filter(c => c.intake_completed_at == null).length,
        annual_review_overdue_count: countOverdueReviews(children),
      }
    }
    acks = Array.isArray(data) ? data : []
  } catch {
    return {
      ...empty,
      active_children_count: children.length,
      intake_complete_count: children.filter(c => c.intake_completed_at != null).length,
      intake_incomplete_count: children.filter(c => c.intake_completed_at == null).length,
      annual_review_overdue_count: countOverdueReviews(children),
    }
  }

  // Index acks by child + type for cheap lookup.
  const haveAckByChild = new Map()  // childId -> Set<type>
  for (const a of acks) {
    if (!a || !a.subject_id) continue
    let s = haveAckByChild.get(a.subject_id)
    if (!s) { s = new Set(); haveAckByChild.set(a.subject_id, s) }
    s.add(a.type)
  }

  // 4) Compute counts.
  const active_children_count = children.length
  const intake_complete_count = children.filter(c => c.intake_completed_at != null).length
  const intake_incomplete_count = active_children_count - intake_complete_count
  const annual_review_overdue_count = countOverdueReviews(children)

  let pending_lead_disclosures_count = 0
  let pending_firearms_disclosures_count = 0
  if (profile && profile.home_built_before_1978 === true) {
    for (const c of children) {
      const s = haveAckByChild.get(c.id)
      if (!s || !s.has('lead_disclosure')) pending_lead_disclosures_count += 1
    }
  }
  if (profile && (profile.firearms_on_premises === true || profile.firearms_on_premises === false)) {
    for (const c of children) {
      const s = haveAckByChild.get(c.id)
      if (!s || !s.has('firearms_disclosure')) pending_firearms_disclosures_count += 1
    }
  }

  return {
    domain: 'child_files',
    type: 'type_2',
    active_children_count,
    intake_complete_count,
    intake_incomplete_count,
    annual_review_overdue_count,
    pending_lead_disclosures_count,
    pending_firearms_disclosures_count,
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function countOverdueReviews(children) {
  let n = 0
  const todayMs = Date.now()
  for (const c of children) {
    if (!c) continue
    const last = c.records_last_reviewed_on
    if (!last) { n += 1; continue }
    const lastMs = Date.parse(last + 'T00:00:00Z')
    if (!Number.isFinite(lastMs)) { n += 1; continue }
    // 365 days ~= 1 year. Annual review tolerates a small slip; use 365 + 1
    // day to avoid edge-of-leap-year false positives.
    if (todayMs - lastMs > 366 * 86400000) n += 1
  }
  return n
}
