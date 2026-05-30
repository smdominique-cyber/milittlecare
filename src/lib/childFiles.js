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
import { requiredSubTypesForChild } from './acknowledgments'

// ─── Bucket constants (exported for reuse / inspection) ────────────────

/**
 * R 400.1907 subitem (vi) — "The licensee shall inform the parent…"
 * Inform-only types: any active ack satisfies, regardless of channel.
 */
export const INFORM_ONLY_TYPES = Object.freeze([
  'lead_disclosure',
])

/**
 * R 400.1907(1)(b) parent-signed items — "signed by the parent" /
 * "received by the parent" / "offered to the parent." Active ack
 * satisfies ONLY when channel is in PARENT_SIGNED_SATISFYING_CHANNELS.
 *
 * Per the regulatory-interpretation note at the top of this file and
 * the subitem mapping recorded in `src/lib/acknowledgments.js`, the
 * seven R 400.1907(1)(b) items split into:
 *   (vi)   lead_disclosure       — INFORM-ONLY, NOT in this list.
 *   (v)    firearms_disclosure   — parent-signed, gated on premises.
 *   (i)    health_condition      — parent-signed, always required.
 *   (ii)   food_provider_agreement — parent-signed, always required.
 *   (iii)  licensing_rules_offered — parent-signed, always required.
 *                                    Added 2026-05-29 (was missing).
 *   (iv)   discipline_policy_receipt — parent-signed, always required.
 *   (vii)  licensing_notebook_offered — parent-signed, always required.
 *          DB string preserved for back-compat; the constant in
 *          `acknowledgments.js` is LICENSING_NOTEBOOK_AVAILABILITY.
 */
export const PARENT_SIGNED_TYPES = Object.freeze([
  'firearms_disclosure',           // (b)(v)
  'food_provider_agreement',       // (b)(ii)
  'licensing_notebook_offered',    // (b)(vii) — DB value preserved; JS const is LICENSING_NOTEBOOK_AVAILABILITY
  'licensing_rules_offered',       // (b)(iii) — added 2026-05-29
  'health_condition',              // (b)(i)
  'discipline_policy_receipt',     // (b)(iv)
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
 * @typedef {Object} ChildFilesPendingParentSignatures
 * @property {number} firearms_disclosure         Parent-signed under R 400.1907(1)(b)(v). Pending unless an
 *                                                 active ack with acknowledged_via IN ('parent_portal',
 *                                                 'in_person_paper') exists for the child. Only counted when
 *                                                 the licensee has answered profiles.firearms_on_premises
 *                                                 (true or false; null = disclosure not yet required).
 * @property {number} food_provider_agreement     Parent-signed under R 400.1907(1)(b)(ii). Always required.
 * @property {number} licensing_notebook_offered  Parent-signed under R 400.1907(1)(b)(vii) — notice of THIS
 *                                                 home's licensing notebook availability per R 400.1906(3).
 *                                                 DB string preserved for back-compat; the constant in
 *                                                 acknowledgments.js is LICENSING_NOTEBOOK_AVAILABILITY.
 *                                                 Always required. (The typedef key uses the DB string so
 *                                                 PR #22's consumer reads the same shape it sees in
 *                                                 acknowledgments rows.) The 2026-05-29 mapping fix corrected
 *                                                 this — it was previously labeled (iii) in the typedef, which
 *                                                 was wrong; the substance is (vii).
 * @property {number} licensing_rules_offered     Parent-signed under R 400.1907(1)(b)(iii) — offer to
 *                                                 provide a copy of the licensing rules (R 400.1901–1951).
 *                                                 Always required. Added 2026-05-29 (the genuinely-missing
 *                                                 acknowledgment that the bundle wasn't capturing).
 * @property {number} health_condition            Parent-signed under R 400.1907(1)(b)(i). Always required.
 * @property {number} discipline_policy_receipt   Parent-signed under R 400.1907(1)(b)(iv). Always required.
 */

/**
 * @typedef {Object} ChildFilesAuditState
 * @property {'child_files'}                  domain
 * @property {'type_2'}                       type                                 MILittleCare-owned (counted by PR #22 default)
 * @property {number}                         active_children_count                children.archived_at IS NULL
 * @property {number}                         intake_complete_count                children.intake_completed_at IS NOT NULL
 * @property {number}                         intake_incomplete_count
 * @property {number}                         annual_review_overdue_count          records_last_reviewed_on + 1y < today, or null
 * @property {number}                         pending_lead_disclosures_count       INFORM-ONLY (R 400.1907(1)(b)(vi)). Pending when
 *                                                                                  home_built_before_1978=true AND no active ack
 *                                                                                  of any channel exists for the child.
 * @property {number}                         pending_parent_signatures_count      Total pending PARENT-SIGNED signature SLOTS across
 *                                                                                  all six R 400.1907(1)(b) parent-signed types —
 *                                                                                  (i) health_condition, (ii) food_provider_agreement,
 *                                                                                  (iii) licensing_rules_offered (added 2026-05-29),
 *                                                                                  (iv) discipline_policy_receipt, (v) firearms,
 *                                                                                  (vii) licensing_notebook_offered — and all
 *                                                                                  children. Counts slots, NOT children. PR #22's
 *                                                                                  headline number for the compliance score.
 * @property {ChildFilesPendingParentSignatures} pending_parent_signatures        Per-type breakdown of the parent-signed pending
 *                                                                                  slots. Each value counts children missing an
 *                                                                                  active parent_portal / in_person_paper ack of
 *                                                                                  that type. provider_override alone does NOT
 *                                                                                  satisfy any parent-signed type.
 * @property {number}                         children_with_pending_parent_signatures_count
 *                                                                                  Distinct children missing at least one
 *                                                                                  parent-signed ack of any type. Captures
 *                                                                                  "children affected" — orthogonal to the
 *                                                                                  signature-slots rollup above (a child missing
 *                                                                                  3 signatures contributes 3 to
 *                                                                                  pending_parent_signatures_count but 1 to this
 *                                                                                  field).
 *
 * Shape rationale (2026-05-29): the previous shape exported only
 * `pending_firearms_disclosures_count` for the parent-signed bucket,
 * which silently overstated compliance for the other four parent-signed
 * types (food provider, licensing notebook, health, discipline) — the
 * helper had no opinion on whether they were satisfied. This shape
 * extends parent-signed tracking to all five types via
 * `pending_parent_signatures` + the rollup + the children-affected
 * count. `pending_firearms_disclosures_count` was REMOVED — firearms is
 * one of five parent-signed types and reads through the breakdown as
 * `pending_parent_signatures.firearms_disclosure`. Lead (inform-only)
 * stays a separate top-level field because it's a distinct regulatory
 * category, not a parent signature.
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
    pending_parent_signatures_count: 0,
    pending_parent_signatures: emptyParentSignaturesBreakdown(),
    children_with_pending_parent_signatures_count: 0,
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

  // Lead (INFORM-ONLY). Any active ack satisfies — see top-of-file
  // regulatory note.
  let pending_lead_disclosures_count = 0
  if (profile && profile.home_built_before_1978 === true) {
    for (const c of children) {
      const s = anyChannelByChild.get(c.id)
      if (!s || !s.has('lead_disclosure')) pending_lead_disclosures_count += 1
    }
  }

  // Parent-signed bucket — every PARENT_SIGNED_TYPES entry tracked with
  // the same channel-aware rule. Requirement gating is done per child
  // via `requiredSubTypesForChild` so the audit-state respects the same
  // truth-table the intake modal uses (firearms only counts when the
  // licensee has answered firearms_on_premises; the other four are
  // always required for every active child of a licensed home).
  const PARENT_SIGNED_SET = new Set(PARENT_SIGNED_TYPES)
  const pending_parent_signatures = emptyParentSignaturesBreakdown()
  let pending_parent_signatures_count = 0
  let children_with_pending_parent_signatures_count = 0

  for (const c of children) {
    const requiredForChild = requiredSubTypesForChild({ child: c, profile })
    const haveParentSigned = parentSignedByChild.get(c.id)
    let childHasAnyPending = false
    for (const t of requiredForChild) {
      if (!PARENT_SIGNED_SET.has(t)) continue
      if (haveParentSigned && haveParentSigned.has(t)) continue
      pending_parent_signatures[t] += 1
      pending_parent_signatures_count += 1
      childHasAnyPending = true
    }
    if (childHasAnyPending) children_with_pending_parent_signatures_count += 1
  }

  return {
    domain: 'child_files',
    type: 'type_2',
    active_children_count,
    intake_complete_count,
    intake_incomplete_count,
    annual_review_overdue_count,
    pending_lead_disclosures_count,
    pending_parent_signatures_count,
    pending_parent_signatures,
    children_with_pending_parent_signatures_count,
  }
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Build the `pending_parent_signatures` breakdown object with every
 * PARENT_SIGNED_TYPES key initialized to 0. Used by both the empty-state
 * return and the count loop. Keeps the shape stable across all return
 * paths so consumers can assume every key is always present.
 */
function emptyParentSignaturesBreakdown() {
  const out = {}
  for (const t of PARENT_SIGNED_TYPES) out[t] = 0
  return out
}

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
