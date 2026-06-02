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
 * Enrollment-level LICENSING-REQUIRED consents (Consents Phase A, 2026-05-30).
 *
 * Separate from the intake bundle: these are sign-once-at-enrollment items
 * that licensing requires by rule (MiLEAP can ask for them). They are
 * NOT part of the R 400.1907 child-in-care statement envelope and do NOT
 * flow through requiredSubTypesForChild — instead the audit-state helper
 * counts them in their own dedicated block so PR #22's compliance score
 * can weigh them distinctly from intake signatures.
 *
 * Channel-aware satisfaction: same rule as PARENT_SIGNED_TYPES — only
 * parent_portal or in_person_paper satisfies; provider_override alone
 * does not. (Phase A's recording flow is provider-driven —
 * in_person_paper or provider_override — pending Phase B's generalized
 * parent-portal confirm path.)
 *
 * No revocation concept — a licensing-required acknowledgment is signed
 * once; re-acknowledgment archives the prior row.
 */
export const ENROLLMENT_CONSENT_TYPES = Object.freeze([
  'field_trip_permission',                  // R 400.1952(2) — non-vehicle field trips, sign at initial enrollment
  // Consents Phase B (2026-06-01) — time-bound recurring (annual).
  // Both share the same shape: parent-signed, one active row per
  // (provider, type, child), expires_at = acknowledged_at + 1 year,
  // renewal via archive-then-insert.
  'transportation_routine_annual',          // R 400.1952(1)(a) — "at least annually"; R 400.8149(1) parallel center rule.
  'water_activities_on_premises_seasonal',  // R 400.1934(10)(b) — "once per season"; "season" undefined, mapped to once annually per scope §7.
])

/**
 * Time-bound types (Consents Phase B) — the subset of
 * ENROLLMENT_CONSENT_TYPES that carry an `expires_at` on every
 * captured row. Read paths use this to know which types to render
 * with renewal copy ("expired YYYY-MM-DD — needs renewal") versus
 * sign-once copy ("not on file yet"). The write paths use it to
 * know which inserts must set `expires_at = acknowledged_at + 1y`.
 *
 * The shape is type-level, not row-level: every row of a TIME_BOUND
 * type carries `expires_at`; every row of a non-TIME_BOUND type
 * leaves it NULL. This keeps the column purely additive
 * (pre-Phase-B rows are unaffected) and the audit predicate
 * NULL-safe.
 */
export const TIME_BOUND_TYPES = Object.freeze([
  'transportation_routine_annual',
  'water_activities_on_premises_seasonal',
])

/**
 * Per-occurrence consent types (Consents Phase C, 2026-06-01).
 *
 * Structurally separate from ENROLLMENT_CONSENT_TYPES (per the
 * Phase C scope doc decision-table interpretation finalized at
 * build time): these are EVENT RECORDS, not enrollment-state.
 * Keeping them out of `ENROLLMENT_CONSENT_TYPES` means the verdict
 * function's pending/expired loops NATURALLY don't see them —
 * there's no filter to maintain, no risk of a future code change
 * forgetting to skip them. The structural separation mirrors how
 * `PROVIDER_PROTECTIVE_CONSENT_TYPES` is already a sibling const,
 * not folded into the licensing-required list.
 *
 * The verdict function STILL applies a defense-in-depth skip
 * filter (`if (PER_OCCURRENCE_CONSENT_TYPES.includes(t)) continue`)
 * inside the ENROLLMENT_CONSENT_TYPES loop — harmless no-op today
 * because the types aren't in that list, but catches the
 * accident-class where a future maintainer adds them to the
 * licensing-required list without thinking through the audit
 * implications.
 *
 * The relaxed `acknowledgments_active_unique` partial index
 * (migration 027) exempts exactly these two `type` values from the
 * one-active-row-per-(provider, type, subject_type, subject_id)
 * uniqueness — multiple active rows for the same child are
 * EXPECTED for per-occurrence types (one per trip / outing).
 *
 * Both types are PARENT-SIGNED — only parent_portal /
 * in_person_paper satisfy. Same rule as every other parent-signed
 * consent. provider_override is recorded in the audit trail but
 * does not satisfy the rule.
 */
export const PER_OCCURRENCE_CONSENT_TYPES = Object.freeze([
  'transportation_nonroutine_per_trip',       // R 400.1952(1)(b) — "before each trip"
  'water_activities_off_premises_per_trip',   // R 400.1934(10)(a) — "before each outdoor water activity"
])

// ─── Occurrence-metadata helpers (Consents Phase C, 2026-06-01) ──
//
// SINGLE SOURCE OF TRUTH for the per-occurrence jsonb payload shape.
// Every write site that inserts a per-occurrence row MUST go through
// one of these helpers — never construct the jsonb inline. If two
// call sites build the shape independently, a field-name typo
// (trip_date vs tripDate) creates silent data drift that no test
// catches until an auditor reads the rows.
//
// The DB stores free jsonb (no CHECK constraint on shape) — the app
// is the validator. The helpers throw on missing required fields and
// strip unknown keys (passive guard against typos in the calling
// component's field bindings).
//
// Documented shape vocabulary:
//   - `trip_date` / `outing_date` : ISO date string (YYYY-MM-DD).
//   - `destination` / `location`  : free text venue / address.
//   - `water_body_type`           : enum 'pool' | 'lake' | 'pond' |
//                                    'river' | 'beach' | 'other'.
//   - Other fields are optional free text or ISO datetime.

const TRANSPORT_OCCURRENCE_REQUIRED = ['trip_date', 'destination']
const TRANSPORT_OCCURRENCE_OPTIONAL = ['purpose', 'vehicle_description', 'estimated_return']
const WATER_OCCURRENCE_REQUIRED = ['outing_date', 'water_body_type', 'location']
const WATER_OCCURRENCE_OPTIONAL = ['address', 'supervising_adult', 'estimated_return']
const WATER_BODY_TYPES = Object.freeze([
  'pool', 'lake', 'pond', 'river', 'beach', 'other',
])

/**
 * Build the canonical `occurrence_metadata` jsonb for a
 * `transportation_nonroutine_per_trip` row.
 *
 * @param {object} input
 * @param {string} input.trip_date            REQUIRED — YYYY-MM-DD
 * @param {string} input.destination          REQUIRED — free text
 * @param {string} [input.purpose]            optional — free text
 * @param {string} [input.vehicle_description] optional — free text
 * @param {string} [input.estimated_return]   optional — ISO datetime
 * @returns {object} the validated metadata object (jsonb-ready)
 * @throws if required fields are missing or blank
 */
export function buildTransportNonroutineOccurrenceMetadata(input) {
  return buildOccurrenceMetadata(input || {},
    TRANSPORT_OCCURRENCE_REQUIRED,
    TRANSPORT_OCCURRENCE_OPTIONAL,
    'transportation_nonroutine_per_trip')
}

/**
 * Build the canonical `occurrence_metadata` jsonb for a
 * `water_activities_off_premises_per_trip` row.
 *
 * @param {object} input
 * @param {string} input.outing_date           REQUIRED — YYYY-MM-DD
 * @param {string} input.water_body_type       REQUIRED — pool|lake|pond|river|beach|other
 * @param {string} input.location              REQUIRED — free text
 * @param {string} [input.address]             optional — free text
 * @param {string} [input.supervising_adult]   optional — free text
 * @param {string} [input.estimated_return]    optional — ISO datetime
 * @returns {object} the validated metadata object (jsonb-ready)
 * @throws if required fields are missing or blank, or water_body_type
 *         is not in the enum
 */
export function buildWaterOffPremisesOccurrenceMetadata(input) {
  const out = buildOccurrenceMetadata(input || {},
    WATER_OCCURRENCE_REQUIRED,
    WATER_OCCURRENCE_OPTIONAL,
    'water_activities_off_premises_per_trip')
  if (!WATER_BODY_TYPES.includes(out.water_body_type)) {
    throw new Error(
      `water_activities_off_premises_per_trip: water_body_type must be one of ` +
      `${WATER_BODY_TYPES.join(', ')} (got "${out.water_body_type}")`
    )
  }
  return out
}

/**
 * Shared validation engine for the per-type helpers above. Throws
 * on missing/blank required fields. Strips keys outside the
 * union(required, optional) to defend against field-name typos in
 * the calling component.
 */
function buildOccurrenceMetadata(input, required, optional, typeLabel) {
  const out = {}
  for (const k of required) {
    const v = input[k]
    if (v == null || (typeof v === 'string' && v.trim() === '')) {
      throw new Error(`${typeLabel}: required field "${k}" is missing or blank`)
    }
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  for (const k of optional) {
    const v = input[k]
    if (v == null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  return out
}

/**
 * Allowed values for `water_body_type` in the water-off-premises
 * occurrence metadata. Exported so the modal can render the
 * dropdown options from the single source of truth.
 */
export const WATER_BODY_TYPE_OPTIONS = WATER_BODY_TYPES

/**
 * Time-bound row write helper — returns the ISO timestamp that an
 * insert / renewal should use for `expires_at`. Pure: takes the
 * acknowledged_at value the caller is about to write, returns
 * acknowledged_at + 1 year. Same formula for both Phase B types.
 *
 * @param {string|Date} acknowledgedAtIso  the row's acknowledged_at
 * @returns {string}                       ISO timestamp +1 year
 */
export function computePhaseBExpiresAt(acknowledgedAtIso) {
  const base = acknowledgedAtIso instanceof Date
    ? acknowledgedAtIso
    : new Date(acknowledgedAtIso || Date.now())
  const out = new Date(base.getTime())
  out.setUTCFullYear(out.getUTCFullYear() + 1)
  return out.toISOString()
}

/**
 * Partition active (non-archived) acknowledgment rows into the two
 * arrays the Phase B verdict needs: currently-valid (`activeAcks`)
 * vs. captured-but-lapsed (`expiredAcks`). Pure function — takes
 * the wall-clock moment as an explicit argument so the verdict
 * stays deterministic and the caller controls "now."
 *
 * Rows with `expires_at = NULL` are always in `activeAcks` (Phase A
 * types, durable consents). Rows with `expires_at > now` are
 * `activeAcks`. Rows with `expires_at <= now` are `expiredAcks`.
 *
 * @param {object} args
 * @param {Array<{expires_at?: string|null}>} args.rows
 * @param {Date|string|number} [args.now]  wall-clock "now"; default Date.now()
 * @returns {{ activeAcks: object[], expiredAcks: object[] }}
 */
export function partitionAcksByExpiry({ rows, now } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const nowMs = now != null
    ? (now instanceof Date ? now.getTime() : Date.parse(String(now)))
    : Date.now()
  const activeAcks = []
  const expiredAcks = []
  for (const r of list) {
    if (!r) continue
    if (r.expires_at == null) {
      activeAcks.push(r)
      continue
    }
    const exp = Date.parse(r.expires_at)
    if (!Number.isFinite(exp) || exp > nowMs) {
      activeAcks.push(r)
    } else {
      expiredAcks.push(r)
    }
  }
  return { activeAcks, expiredAcks }
}

/**
 * Enrollment-level PROVIDER-PROTECTIVE consents (Consents Phase A, 2026-05-30).
 *
 * No rule citation — these are captured for liability / parent-trust,
 * not compliance. PR #22 must score them DISTINCTLY from licensing-
 * required consents (a missing photo consent is a prudence gap, not a
 * regulatory violation).
 *
 * REVOCABLE — each entry pairs with a `<type>_revoked` ACK_TYPES value
 * (see REVOCATION_PAIRS below). The audit-state helper treats either
 * an active consent OR an active revocation as "recorded" (preference
 * captured); only the no-record-either-way case counts as pending.
 *
 * Channel-aware satisfaction: same parent-signed rule as the others —
 * parent_portal / in_person_paper satisfy; provider_override alone
 * does not.
 */
export const PROVIDER_PROTECTIVE_CONSENT_TYPES = Object.freeze([
  'photo_sharing_consent',         // no rule (licensing silent); see acknowledgments.js header note
])

/**
 * Revocation pairing for revocable provider-protective consents.
 * Map of consent type → revocation-pair type. The presence of an
 * active revocation-pair row counts as "preference recorded" (parent
 * has expressed a no), distinct from "preference unknown."
 *
 * Currently only photo_sharing_consent is revocable. Future revocable
 * consents add entries here.
 */
export const REVOCATION_PAIRS = Object.freeze({
  photo_sharing_consent: 'photo_sharing_consent_revoked',
})

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
 * Single source of truth for "which enrollment consents are pending for
 * this one child?" Pure function — no Supabase, no I/O, no `now()`
 * reference. Used by both the provider-side audit helper
 * (`getChildFilesAuditState`) and the parent-side surfaces
 * (`ParentAcknowledgmentsPage` tab badge,
 * `EnrollmentConsentsPendingBanner`, `ParentEnrollmentConsentsPanel`).
 * Both paths fetch acks under different RLS contexts but apply the
 * SAME verdict rule via this function — keeps the surfaces from
 * drifting on:
 *   - the channel rule (parent_portal / in_person_paper satisfy;
 *     provider_override alone does not),
 *   - the revocation-pair rule (an active `<type>_revoked` row recorded
 *     via a satisfying channel counts as "preference captured"),
 *   - the licensing-required vs provider-protective split,
 *   - the Phase B expiry distinction (captured-but-lapsed is a
 *     different state than never-captured).
 *
 * ── Phase B addition (2026-06-01) ──
 * The caller pre-partitions active-non-archived rows into two
 * arrays via `partitionAcksByExpiry` (or its own equivalent):
 *   - `activeAcks`  : rows with `expires_at IS NULL OR > now()`.
 *                    These are CURRENTLY VALID.
 *   - `expiredAcks` : rows with `expires_at <= now()`.
 *                    These are CAPTURED BUT LAPSED.
 * The verdict does pure set arithmetic over the two arrays; `now()`
 * never appears in this function. Phase A callers that omit
 * `expiredAcks` get the identical pre-Phase-B behavior (every Phase
 * A type has `expires_at = NULL`, so the partition puts everything in
 * `activeAcks` anyway).
 *
 * The function returns the per-child verdict only. Each caller
 * aggregates as it needs — slot-counts + children-affected on the
 * helper side; distinct-children-affected on the parent badge.
 *
 * @param {object}   args
 * @param {Array<{type: string, acknowledged_via: string}>} args.activeAcks
 *   The child's currently-valid acknowledgment rows. Each row must
 *   carry at least `type` and `acknowledged_via`. Extra fields are
 *   ignored — both call sites pass slightly different projections.
 * @param {Array<{type: string, acknowledged_via: string}>} [args.expiredAcks=[]]
 *   The child's captured-but-lapsed rows (active in the DB sense —
 *   `archived_at IS NULL` — but past `expires_at`). Used to
 *   distinguish "captured then lapsed" from "never captured."
 * @returns {{
 *   enrollment_consents_pending:           string[],
 *   enrollment_consents_expired:           string[],
 *   provider_protective_consents_pending:  string[],
 *   any_pending:                           boolean,
 * }}
 */
export function pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks } = {}) {
  const active = Array.isArray(activeAcks) ? activeAcks : []
  const expired = Array.isArray(expiredAcks) ? expiredAcks : []

  // Set of types this child has captured via a satisfying channel
  // and that are CURRENTLY VALID. provider_override rows are filtered
  // out — they exist in the audit trail but do NOT count as
  // preference captured.
  const satisfyingTypes = new Set()
  for (const a of active) {
    if (!a || !a.type) continue
    if (!PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    satisfyingTypes.add(a.type)
  }

  // Set of types this child once captured (via a satisfying channel)
  // that have since lapsed. A provider_override row that's expired
  // is NOT counted as "captured then lapsed" — the parent never
  // signed in the first place, so the type is still "never captured."
  const expiredSatisfyingTypes = new Set()
  for (const a of expired) {
    if (!a || !a.type) continue
    if (!PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    expiredSatisfyingTypes.add(a.type)
  }

  // Licensing-required: split into pending (never captured) vs.
  // expired (captured-but-lapsed). A currently-valid satisfying row
  // wins over an expired one (a renewed type isn't expired).
  //
  // Phase C (2026-06-01) defense-in-depth: skip any type in
  // PER_OCCURRENCE_CONSENT_TYPES. Per-occurrence consents are event
  // records — a child with no scheduled trips is NOT pending. They
  // are structurally kept OUT of ENROLLMENT_CONSENT_TYPES so this
  // filter is a no-op today; the filter exists to catch the
  // accident-class where a future maintainer adds them to the list
  // without thinking through the audit implications.
  const perOccurrenceSet = new Set(PER_OCCURRENCE_CONSENT_TYPES)
  const enrollment_consents_pending = []
  const enrollment_consents_expired = []
  for (const t of ENROLLMENT_CONSENT_TYPES) {
    if (perOccurrenceSet.has(t)) continue
    if (satisfyingTypes.has(t)) continue
    if (expiredSatisfyingTypes.has(t)) {
      enrollment_consents_expired.push(t)
    } else {
      enrollment_consents_pending.push(t)
    }
  }

  // Provider-protective: each type is pending iff NEITHER a satisfying
  // consent ack of the type NOR a satisfying revocation-pair ack
  // exists. An active revocation pair means the parent has expressed
  // a "no" — preference captured, just as a no. No expiry concept
  // for this category (the existing types are durable Phase A).
  const provider_protective_consents_pending = []
  for (const t of PROVIDER_PROTECTIVE_CONSENT_TYPES) {
    if (satisfyingTypes.has(t)) continue
    const revocationKey = REVOCATION_PAIRS[t]
    if (revocationKey && satisfyingTypes.has(revocationKey)) continue
    provider_protective_consents_pending.push(t)
  }

  return {
    enrollment_consents_pending,
    enrollment_consents_expired,
    provider_protective_consents_pending,
    any_pending:
      enrollment_consents_pending.length > 0 ||
      enrollment_consents_expired.length > 0 ||
      provider_protective_consents_pending.length > 0,
  }
}

/**
 * Thin sibling of `pendingEnrollmentConsentsForChild` exposing just the
 * photo-sharing consent verdict for the messaging photo-attach
 * reminder (PR Messaging Photo-Consent Reminder, 2026-06-01).
 *
 * Returns true when the provider should see the non-blocking reminder
 * before attaching/sending a photo in this child's message thread.
 *
 * IMPORTANT — different semantic from the audit-state verdict:
 *   `pendingEnrollmentConsentsForChild` answers "is the parent's
 *   preference CAPTURED?" — and counts an active revoked row under a
 *   satisfying channel as "yes, captured" (just as a no). That's
 *   correct for compliance reporting.
 *
 *   This function answers a different question — "should the provider
 *   be reminded that this photo might be against the parent's stated
 *   preference?" Per the PR scope, the answer is YES whenever consent
 *   is anything other than active affirmative parent-signed consent:
 *     - revoked under any channel → reminder fires
 *     - no record either way → reminder fires
 *     - affirmative consent under provider_override only → reminder fires
 *       (parent never actually signed; same parent-signed rule)
 *     - affirmative consent under parent_portal or in_person_paper → no reminder
 *
 *   We deliberately do NOT delegate to `pendingEnrollmentConsentsForChild`
 *   because its "captured" semantic would suppress the reminder for
 *   revoked-state children — exactly the case the scope says MUST fire.
 *
 * Reuse invariant: this function shares the
 * `PARENT_SIGNED_SATISFYING_CHANNELS` constant with every other
 * consent surface. If the channel rule ever changes (e.g., a future
 * channel value is added to the satisfying set), this function updates
 * in lockstep with the audit helper and the parent surfaces. The drift
 * risk the cc-followup parity refactor pinned is preserved.
 *
 * @param {object} args
 * @param {Array<{type: string, acknowledged_via: string}>} args.activeAcks
 * @returns {boolean}  true when the reminder should fire.
 */
export function photoConsentNeedsReminderForChild({ activeAcks }) {
  const rows = Array.isArray(activeAcks) ? activeAcks : []
  for (const a of rows) {
    if (!a || a.type !== 'photo_sharing_consent') continue
    if (PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) {
      // Active affirmative parent-signed consent → reminder suppressed.
      return false
    }
  }
  return true
}

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
 * @property {number}                         pending_enrollment_consents_count    Total pending LICENSING-REQUIRED enrollment-
 *                                                                                  consent slots (currently field_trip_permission
 *                                                                                  only). Channel-aware: parent_portal /
 *                                                                                  in_person_paper satisfy. Counts slots, NOT
 *                                                                                  children. Consents Phase A (2026-05-30).
 * @property {ChildFilesPendingEnrollmentConsents} pending_enrollment_consents     Per-type breakdown of licensing-required
 *                                                                                  enrollment-consent pending slots.
 * @property {number}                         pending_provider_protective_consents_count
 *                                                                                  Total pending PROVIDER-PROTECTIVE enrollment-
 *                                                                                  consent slots (currently photo_sharing_consent
 *                                                                                  only). NOT a licensing compliance signal —
 *                                                                                  PR #22 scores this distinctly from
 *                                                                                  enrollment_consents. "Pending" = no record
 *                                                                                  either way (neither active consent nor active
 *                                                                                  revocation pair).
 * @property {ChildFilesPendingProviderProtectiveConsents} pending_provider_protective_consents
 *                                                                                  Per-type breakdown of provider-protective
 *                                                                                  pending slots. Revocation-aware: an active
 *                                                                                  revocation pair counts as preference captured
 *                                                                                  and is therefore NOT pending.
 * @property {number}                         children_with_pending_enrollment_consents_count
 *                                                                                  Distinct children missing ≥1 licensing-required
 *                                                                                  enrollment consent. The compliance-side
 *                                                                                  children-affected metric.
 * @property {number}                         children_with_pending_provider_protective_consents_count
 *                                                                                  Distinct children with no provider-protective
 *                                                                                  preference captured. Data-quality metric, NOT
 *                                                                                  compliance.
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
 *
 * Consents Phase A extension (2026-05-30 — Option A from
 * pr-consents-A-scope.md): added FOUR new fields covering enrollment-
 * level consents that sit OUTSIDE the R 400.1907 intake bundle:
 *   - pending_enrollment_consents_count / _consents object — licensing-
 *     required category (currently field_trip_permission only).
 *     Channel-aware satisfaction.
 *   - pending_provider_protective_consents_count / _consents object —
 *     not-a-licensing-gap category (currently photo_sharing_consent
 *     only). Channel-aware AND revocation-aware: "preference recorded"
 *     = active consent ack OR active revocation pair. Only the
 *     no-record-either-way case counts as pending.
 *   - children_with_pending_enrollment_consents_count — distinct
 *     children missing ≥1 licensing-required enrollment consent. PR #22
 *     scores this distinctly from intake.
 *   - children_with_pending_provider_protective_consents_count —
 *     distinct children with no preference captured. NOT a compliance
 *     signal — for the prudence / data-quality side of the score.
 */

/**
 * @typedef {Object} ChildFilesPendingEnrollmentConsents
 * @property {number} field_trip_permission   R 400.1952(2) — written permission for non-vehicle
 *                                            field trips at initial enrollment. Always required;
 *                                            satisfied only by parent_portal / in_person_paper.
 */

/**
 * @typedef {Object} ChildFilesPendingProviderProtectiveConsents
 * @property {number} photo_sharing_consent   No rule (licensing silent). "Pending" means NO record
 *                                            either way — neither an active consent ack nor an
 *                                            active revocation pair. An active revocation counts
 *                                            as "preference captured" and is therefore NOT pending.
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
    // Consents Phase A (2026-05-30) — enrollment-level consents.
    pending_enrollment_consents_count: 0,
    pending_enrollment_consents: emptyEnrollmentConsentsBreakdown(),
    pending_provider_protective_consents_count: 0,
    pending_provider_protective_consents: emptyProviderProtectiveConsentsBreakdown(),
    children_with_pending_enrollment_consents_count: 0,
    children_with_pending_provider_protective_consents_count: 0,
    // Consents Phase B (2026-06-01) — time-bound expiry tracking.
    // A consent is "expired" when its row is active (archived_at IS NULL)
    // under a satisfying channel but `expires_at <= now()`. The
    // `_pending_count` counts NEVER-CAPTURED slots; the `_expired_count`
    // counts CAPTURED-BUT-LAPSED slots. Both contribute to
    // `children_with_pending_enrollment_consents_count` (a child with
    // any compliance gap, pending or expired, is "affected"). PR #22
    // weighs the two states separately — see pr-consents-B-scope.md
    // § Classification.
    pending_enrollment_consents_expired_count: 0,
    pending_enrollment_consents_expired: emptyEnrollmentConsentsBreakdown(),
    // Consents Phase C (2026-06-01) — per-occurrence event records.
    // Informational ONLY — NOT a compliance signal. Counts distinct
    // children with at least one active row of each per-occurrence
    // type. A child with no recorded trips contributes 0 to every
    // key; this field never indicates a compliance gap. PR #22 may
    // weigh it as a recency signal once a trips entity exists to
    // cross-reference against — Phase C only provides the capture
    // counts.
    per_occurrence_consents_recorded: emptyPerOccurrenceBreakdown(),
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
  //    Phase B (2026-06-01): we additionally select `expires_at` and
  //    partition the rows into currently-valid vs. expired before
  //    feeding the verdict. The verdict stays pure (no now() inside).
  let acks = []
  try {
    const { data, error } = await supabase
      .from('acknowledgments')
      .select('subject_id, type, acknowledged_via, expires_at')
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

  // Index acks per child. Phase B (2026-06-01) split:
  //   anyChannelByChild       : childId -> Set<type>  any CURRENTLY-VALID
  //                                                    row, any channel.
  //                                                    Expired rows excluded
  //                                                    — they no longer
  //                                                    inform the parent.
  //   parentSignedByChild     : childId -> Set<type>  currently-valid row
  //                                                    with channel IN
  //                                                    PARENT_SIGNED_SATISFYING_CHANNELS.
  //   activeAcksByChild       : childId -> object[]   currently-valid rows.
  //   expiredAcksByChild      : childId -> object[]   active-in-DB-sense
  //                                                    (archived_at IS NULL)
  //                                                    but past expires_at.
  // The two raw-rows Maps feed `pendingEnrollmentConsentsForChild`
  // separately so the verdict can distinguish never-captured from
  // captured-but-lapsed without referencing now() itself.
  //
  // Lead (inform-only) uses anyChannelByChild — an expired lead
  // disclosure stops counting because the rule's "informed" state
  // refers to current standing. (Lead never gets expires_at set today,
  // so this is a no-op for it; the structure is consistent across
  // all read paths.)
  const PARENT_SIGNED_SATISFYING_SET = new Set(PARENT_SIGNED_SATISFYING_CHANNELS)
  const nowMs = Date.now()
  const anyChannelByChild = new Map()
  const parentSignedByChild = new Map()
  const activeAcksByChild = new Map()
  const expiredAcksByChild = new Map()
  for (const a of acks) {
    if (!a || !a.subject_id) continue
    const expMs = a.expires_at == null ? null : Date.parse(a.expires_at)
    const isExpired = expMs != null && Number.isFinite(expMs) && expMs <= nowMs

    if (isExpired) {
      let ex = expiredAcksByChild.get(a.subject_id)
      if (!ex) { ex = []; expiredAcksByChild.set(a.subject_id, ex) }
      ex.push(a)
      // Expired rows do NOT inform anyChannelByChild or
      // parentSignedByChild — current standing only.
      continue
    }

    let any = anyChannelByChild.get(a.subject_id)
    if (!any) { any = new Set(); anyChannelByChild.set(a.subject_id, any) }
    any.add(a.type)
    if (PARENT_SIGNED_SATISFYING_SET.has(a.acknowledged_via)) {
      let ps = parentSignedByChild.get(a.subject_id)
      if (!ps) { ps = new Set(); parentSignedByChild.set(a.subject_id, ps) }
      ps.add(a.type)
    }
    let raw = activeAcksByChild.get(a.subject_id)
    if (!raw) { raw = []; activeAcksByChild.set(a.subject_id, raw) }
    raw.push(a)
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

  // ─── Consents Phase A (2026-05-30) — enrollment-level consents ──
  //
  // Two separate blocks per the Option A audit-state shape:
  //  - LICENSING-REQUIRED (currently field_trip_permission only).
  //    Channel-aware: only parent_portal / in_person_paper satisfy.
  //    No revocation concept — re-acknowledge to update.
  //  - PROVIDER-PROTECTIVE (currently photo_sharing_consent only).
  //    Channel-aware AND revocation-aware: an active revocation-pair
  //    row recorded via a parent-signed channel ALSO counts as
  //    "preference captured." Only the no-record-either-way state
  //    counts as pending.
  //
  // Both apply to EVERY active child of a licensed home; there is no
  // requiredSubTypesForChild gate here because these aren't part of
  // the R 400.1907 intake bundle.
  // Per-child verdict comes from `pendingEnrollmentConsentsForChild`
  // (single source of truth for the channel + revocation-pair rule).
  // The helper aggregates slot-counts + children-affected here; the
  // parent-side surfaces (ParentAcknowledgmentsPage tab badge,
  // EnrollmentConsentsPendingBanner) call the SAME function and
  // aggregate children-affected only. cc-followup-consent-count-parity
  // pinned that two-path agreement structurally — both paths now share
  // the verdict logic; only the aggregation shape differs per caller.
  const pending_enrollment_consents = emptyEnrollmentConsentsBreakdown()
  let pending_enrollment_consents_count = 0
  let children_with_pending_enrollment_consents_count = 0

  // Phase B (2026-06-01) — expired-consent breakdown. Same keys as the
  // pending breakdown so consumers can read the shape stably.
  const pending_enrollment_consents_expired = emptyEnrollmentConsentsBreakdown()
  let pending_enrollment_consents_expired_count = 0

  const pending_provider_protective_consents = emptyProviderProtectiveConsentsBreakdown()
  let pending_provider_protective_consents_count = 0
  let children_with_pending_provider_protective_consents_count = 0

  // Phase C (2026-06-01) — per-occurrence event-record rollup. NOT
  // a compliance signal: counts distinct children with ≥1 active
  // per-occurrence row of each type. The verdict NEVER folds these
  // into pending/expired (PER_OCCURRENCE_CONSENT_TYPES is separate
  // from ENROLLMENT_CONSENT_TYPES), so the rollup is computed here
  // from the raw activeAcksByChild map. Surfaced for PR #22 /
  // future audit-recency widgets.
  const per_occurrence_consents_recorded = emptyPerOccurrenceBreakdown()
  const perOccurrenceSet = new Set(PER_OCCURRENCE_CONSENT_TYPES)

  for (const c of children) {
    const activeAcks = activeAcksByChild.get(c.id) || []
    const expiredAcks = expiredAcksByChild.get(c.id) || []
    const verdict = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })

    for (const t of verdict.enrollment_consents_pending) {
      pending_enrollment_consents[t] += 1
      pending_enrollment_consents_count += 1
    }
    for (const t of verdict.enrollment_consents_expired) {
      pending_enrollment_consents_expired[t] += 1
      pending_enrollment_consents_expired_count += 1
    }
    // children_with_pending_enrollment_consents_count tracks children
    // with ANY licensing-required compliance gap (pending OR expired).
    // PR #22 may weight pending and expired separately, but the
    // children-affected metric counts the child once either way.
    if (verdict.enrollment_consents_pending.length > 0
      || verdict.enrollment_consents_expired.length > 0) {
      children_with_pending_enrollment_consents_count += 1
    }

    for (const t of verdict.provider_protective_consents_pending) {
      pending_provider_protective_consents[t] += 1
      pending_provider_protective_consents_count += 1
    }
    if (verdict.provider_protective_consents_pending.length > 0) {
      children_with_pending_provider_protective_consents_count += 1
    }

    // Per-occurrence rollup: distinct child × per-occurrence-type
    // count. A child with multiple active rows of the same type
    // contributes 1 to that type's count (we want distinct children,
    // not row count — multiple trips for one child shouldn't inflate
    // the rollup).
    const perOccurrenceTypesPresentForChild = new Set()
    for (const a of activeAcks) {
      if (!a || !a.type) continue
      if (!perOccurrenceSet.has(a.type)) continue
      perOccurrenceTypesPresentForChild.add(a.type)
    }
    for (const t of perOccurrenceTypesPresentForChild) {
      per_occurrence_consents_recorded[t] += 1
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
    pending_parent_signatures_count,
    pending_parent_signatures,
    children_with_pending_parent_signatures_count,
    pending_enrollment_consents_count,
    pending_enrollment_consents,
    pending_provider_protective_consents_count,
    pending_provider_protective_consents,
    children_with_pending_enrollment_consents_count,
    children_with_pending_provider_protective_consents_count,
    pending_enrollment_consents_expired_count,
    pending_enrollment_consents_expired,
    per_occurrence_consents_recorded,
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

/**
 * Build the `pending_enrollment_consents` breakdown object with every
 * ENROLLMENT_CONSENT_TYPES key initialized to 0 — EXCLUDING any type
 * in PER_OCCURRENCE_CONSENT_TYPES (Phase C, 2026-06-01). The
 * per-occurrence types live in a separate const and have their own
 * informational rollup (`per_occurrence_consents_recorded`); they
 * must never appear as zero-keys in the pending/expired breakdowns
 * or PR #22's consumer would mis-read them as enrollment-state gaps.
 *
 * Today PER_OCCURRENCE_CONSENT_TYPES is structurally separate from
 * ENROLLMENT_CONSENT_TYPES, so the filter is a no-op — but it's
 * applied as defense-in-depth, identical to the verdict function's
 * filter.
 */
function emptyEnrollmentConsentsBreakdown() {
  const out = {}
  const perOccurrenceSet = new Set(PER_OCCURRENCE_CONSENT_TYPES)
  for (const t of ENROLLMENT_CONSENT_TYPES) {
    if (perOccurrenceSet.has(t)) continue
    out[t] = 0
  }
  return out
}

/**
 * Build the `pending_provider_protective_consents` breakdown object
 * with every PROVIDER_PROTECTIVE_CONSENT_TYPES key initialized to 0.
 */
function emptyProviderProtectiveConsentsBreakdown() {
  const out = {}
  for (const t of PROVIDER_PROTECTIVE_CONSENT_TYPES) out[t] = 0
  return out
}

/**
 * Build the `per_occurrence_consents_recorded` breakdown object
 * (Phase C, 2026-06-01) with every PER_OCCURRENCE_CONSENT_TYPES key
 * initialized to 0. NOT a compliance signal — counts distinct
 * children with ≥1 active per-occurrence row of each type, surfaced
 * for PR #22 / future audit-recency views.
 */
function emptyPerOccurrenceBreakdown() {
  const out = {}
  for (const t of PER_OCCURRENCE_CONSENT_TYPES) out[t] = 0
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
