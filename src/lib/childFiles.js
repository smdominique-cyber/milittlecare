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
//
// ─── Rule-7 audit semantic (PR #16 follow-up, 2026-05-29) ─────────────
//
// R 400.1907's child-in-care statement items split into two regulatory
// categories:
//
//   - INFORM-ONLY (lead, subitem vi): "The licensee shall inform the
//     parent…" — the licensee's act of informing satisfies the rule.
//     Provider attestation (acknowledged_via='provider_override')
//     IS the record that the informing happened, so any active ack
//     counts as satisfied regardless of channel.
//
//   - PARENT-SIGNED (firearms, food provider, licensing notebook,
//     health condition, discipline policy receipt): "signed by the
//     parent" / "received by the parent". The rule wants the parent's
//     signature. Provider attestation that a paper signature was taken
//     in person ('in_person_paper') stands in for the parent's
//     signature — the modal copy makes the provider responsible for
//     that representation. The portal channel ('parent_portal') IS
//     the parent's own signature. A provider_override row alone is
//     NOT the parent's signature — it is the provider's attestation
//     that the disclosure was made, pending the parent's confirmation.
//
// This helper therefore uses CHANNEL-AWARE satisfaction for the
// parent-signed types: an active ack of one of those types satisfies
// the pending count ONLY when `acknowledged_via IN ('parent_portal',
// 'in_person_paper')`.
//
// REGULATORY-INTERPRETATION ASSUMPTION (revisitable before PR #22):
//
// "provider_override does not satisfy parent-signed items" is my
// reading of R 400.1907 — the rule's plain text is "signed by the
// parent" and the provider's claim that the parent acknowledged is
// not the parent's signature. The user (Seth) is treating this as a
// regulatory-interpretation call to confirm with a licensing
// consultant before PR #22 (Compliance Health Score) consumes these
// counts. If the consultant reads "provider_override with a clear
// reason is acceptable evidence of the parent acknowledging" — for
// example, when the parent verbally agreed in person but couldn't sign
// a portal/paper — flip the rule by adding 'provider_override' to
// PARENT_SIGNED_SATISFYING_CHANNELS below. The split-by-channel logic
// stays intact; only the membership of the satisfying set changes.
//
// In_person_paper is treated as satisfying because the modal's
// existing copy frames it as "Parent signed in person / on paper" —
// the provider is recording a real parent signature on a physical
// document. If the consultant disagrees (e.g., they want only digital
// portal signatures), remove 'in_person_paper' from the set.

import { supabase } from './supabase'

// ─── Bucket constants (exported for reuse / inspection) ────────────────

/**
 * R 400.1907 subitem (vi) — "The licensee shall inform the parent…"
 * Inform-only types: any active ack satisfies, regardless of channel.
 */
export const INFORM_ONLY_TYPES = Object.freeze([
  'lead_disclosure',
])

/**
 * R 400.1907 subitems (b)(i)-(v): items "signed by the parent" /
 * "received by the parent". Active ack satisfies ONLY when channel is
 * in PARENT_SIGNED_SATISFYING_CHANNELS.
 */
export const PARENT_SIGNED_TYPES = Object.freeze([
  'firearms_disclosure',
  'food_provider_agreement',
  'licensing_notebook_offered',
  'health_condition',
  'discipline_policy_receipt',
])

/**
 * Which `acknowledged_via` values count as a parent's signature on a
 * parent-signed type. See the regulatory-interpretation note at the
 * top of this file for the reasoning + revisit conditions.
 */
export const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
])

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

  // 3) Pull every active acknowledgment for those children. We need
  //    (subject_id, type, acknowledged_via) to apply the channel-aware
  //    satisfaction rule (see the regulatory note at the top of this
  //    file: parent-signed types are satisfied only by parent_portal /
  //    in_person_paper rows; lead is satisfied by any active row).
  let acks = []
  try {
    const { data, error } = await supabase
      .from('acknowledgments')
      .select('subject_id, type, acknowledged_via')
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

  // Index acks per child:
  //   anyChannelByChild  : childId -> Set<type>   any active row, any channel
  //   parentSignedByChild: childId -> Set<type>   active row with channel
  //                                                 IN PARENT_SIGNED_SATISFYING_CHANNELS
  // Parent-signed types check against parentSignedByChild; inform-only
  // types check against anyChannelByChild.
  const PARENT_SIGNED_SATISFYING_SET = new Set(PARENT_SIGNED_SATISFYING_CHANNELS)
  const anyChannelByChild = new Map()
  const parentSignedByChild = new Map()
  for (const a of acks) {
    if (!a || !a.subject_id) continue
    let any = anyChannelByChild.get(a.subject_id)
    if (!any) { any = new Set(); anyChannelByChild.set(a.subject_id, any) }
    any.add(a.type)
    if (PARENT_SIGNED_SATISFYING_SET.has(a.acknowledged_via)) {
      let ps = parentSignedByChild.get(a.subject_id)
      if (!ps) { ps = new Set(); parentSignedByChild.set(a.subject_id, ps) }
      ps.add(a.type)
    }
  }

  // 4) Compute counts.
  const active_children_count = children.length
  const intake_complete_count = children.filter(c => c.intake_completed_at != null).length
  const intake_incomplete_count = active_children_count - intake_complete_count
  const annual_review_overdue_count = countOverdueReviews(children)

  let pending_lead_disclosures_count = 0
  let pending_firearms_disclosures_count = 0
  if (profile && profile.home_built_before_1978 === true) {
    // Inform-only: lead is satisfied by ANY active ack regardless of
    // channel (provider_override is the licensee informing the parent,
    // which is what the rule requires).
    for (const c of children) {
      const s = anyChannelByChild.get(c.id)
      if (!s || !s.has('lead_disclosure')) pending_lead_disclosures_count += 1
    }
  }
  if (profile && (profile.firearms_on_premises === true || profile.firearms_on_premises === false)) {
    // Parent-signed: firearms is satisfied ONLY by parent_portal or
    // in_person_paper. A provider_override row alone (the
    // post-Send-to-Portal pre-confirm state) keeps the count pending
    // until the parent confirms via portal.
    for (const c of children) {
      const s = parentSignedByChild.get(c.id)
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
