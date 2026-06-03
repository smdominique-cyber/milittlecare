// Compliance Engine Phase 1 — pure state-derivation module.
//
// Authoritative spec: docs/pr-compliance-engine-phase-1-scope.md
// (status FINAL, 2026-06-03). This file implements §1 (module API),
// §3 (resolver patterns A-E), §4 (REQUIREMENT_REGISTRY — 52 rows;
// row 19 religious-objection DEFERRED), §6 (resolved applicability
// defaults), §2a (the governing principle, recorded as a code
// comment below).
//
// ────────────────────────────────────────────────────────────────────
// §2a GOVERNING PRINCIPLE (non-negotiable for every registry
// addition):
//
//   The engine NEVER silently resolves a real regulatory requirement
//   to `not_applicable` when it cannot actually determine
//   applicability. It resolves to `unknown` instead.
//
//   `not_applicable` is reserved for cases the engine can
//   AFFIRMATIVELY determine don't apply:
//     - data-inferred negative — the precondition row is genuinely
//       absent (e.g., no medication_authorizations row exists for a
//       child → per-medication permission is genuinely N/A).
//     - regulatory-universal negative — `universalFor` excludes the
//       provider's `license_type` (e.g., drill requirements for a
//       license_exempt provider).
//     - child-gate negative — `childGate` returns 'does_not_apply'
//       based on a readable fact (e.g., child ≥18mo → infant
//       safe-sleep is N/A).
//
//   Everything else is `unknown`.
//
//   Why this matters: the cost of being wrong is asymmetric. A
//   false `applies` is a dismissable nag. A false `does_not_apply`
//   is a SILENT compliance gap that manufactures false confidence —
//   the worst failure mode for a compliance tool.
//
//   When in doubt, `unknown`. Never `does_not_apply`.
//
//   This principle is non-negotiable for every future registry
//   addition. Any new requirement the engine can't affirmatively
//   classify is `unknown`.
// ────────────────────────────────────────────────────────────────────
//
// Module shape (mirrors `src/lib/childFiles.js` + `src/lib/acknowledgments.js`):
//   - PURE: no Supabase imports. Caller supplies the rows.
//   - Deterministic: `now` is an explicit Date parameter for testability.
//   - `overrides` Map is the Phase-3 seam — Phase 1 always passes
//     `new Map()` so the layer-1 override check is effectively a
//     no-op. Phase 3 adds the loader path that fills the Map from
//     the `compliance_applicability_overrides` table.

import { ACK_TYPES, PER_OCCURRENCE_CONSENT_TYPES } from './acknowledgments'

// Channel rule for parent-signed satisfaction. Duplicated from
// childFiles.js's PARENT_SIGNED_SATISFYING_CHANNELS rather than
// imported, because childFiles.js eagerly imports `./supabase` (it
// hosts the impure audit-state helper too), which would make this
// PURE module require Supabase env vars at import time and break
// downstream unit-test mocking. The two constants MUST stay in
// lockstep — if childFiles.js's set changes (e.g., a new channel
// added to PARENT_SIGNED_SATISFYING_CHANNELS), update here too.
// The duplication is a tested invariant: complianceState.test.js's
// backward-compat smoke imports both and asserts they're equal.
const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
])

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * The six per-requirement state kinds (parent scope §3, decision 5).
 */
export const REQUIREMENT_STATE_KIND = Object.freeze({
  ON_FILE:          'on_file',
  EXPIRED:          'expired',
  MISSING_REQUIRED: 'missing_required',
  PENDING_PARENT:   'pending_parent',
  NOT_APPLICABLE:   'not_applicable',
  UNKNOWN:          'unknown',
})

/**
 * Applicability resolution outcomes.
 */
export const APPLICABILITY_RESULT = Object.freeze({
  APPLIES:        'applies',
  DOES_NOT_APPLY: 'does_not_apply',
  UNKNOWN:        'unknown',
})

/**
 * The categories the registry groups by (Phase 4 score subscores).
 */
export const CATEGORIES = Object.freeze([
  'child_files',
  'consents',
  'medication',
  'staff_files',
  'miregistry',
  'funding_docs',
  'cdc_compliance',
  'attendance',
  'drills',
  'property',
])

/**
 * License types that surface compliance modules (per `modules.js` +
 * migration 022). license_exempt providers do NOT see Categories A-F
 * compliance surfaces.
 */
const LICENSED_HOME_LICENSE_TYPES = Object.freeze(['family_home', 'group_home'])

const EXPIRING_AUTHORIZATION_WINDOW_DAYS = 30

// -----------------------------------------------------------------------------
// Date helpers (pure, deterministic)
// -----------------------------------------------------------------------------

function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') return new Date(value)
  return new Date()
}

function parseTimestampMs(value) {
  if (value == null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function ageInMonths(dobYmd, nowDate) {
  if (!dobYmd) return null
  const [dy, dm, dd] = String(dobYmd).split('-').map(Number)
  if (!Number.isFinite(dy)) return null
  const ty = nowDate.getUTCFullYear()
  const tm = nowDate.getUTCMonth() + 1
  const td = nowDate.getUTCDate()
  let months = (ty - dy) * 12 + (tm - dm)
  if (td < dd) months -= 1
  return Math.max(0, months)
}

/**
 * Computes the current annual cadence window for a Dec-16-style
 * anchor (calendar-year-anchored, Pattern D).
 *
 * For the MiRegistry annual ongoing training (anchor = Dec 16):
 *  - If today ≤ Dec 16 of this year → cycle is (Jan 1 of this year,
 *    Dec 16 of this year).
 *  - If today > Dec 16 of this year → cycle is (Jan 1 of next year,
 *    Dec 16 of next year). The provider is in a "fresh" cycle they
 *    haven't completed yet.
 *
 * The semantic the LEP Handbook (p.12) gives: "Annual Ongoing
 * Training is required to be completed each year by December 16."
 * → calendar-year cycle ending on Dec 16.
 */
function annualCalendarCycle({ anchorMonth, anchorDay, now }) {
  const year = now.getUTCFullYear()
  const thisYearAnchor = Date.UTC(year, anchorMonth - 1, anchorDay, 23, 59, 59, 999)
  if (now.getTime() <= thisYearAnchor) {
    return {
      startMs: Date.UTC(year, 0, 1, 0, 0, 0, 0),
      endMs: thisYearAnchor,
      endIso: new Date(thisYearAnchor).toISOString(),
    }
  }
  const nextAnchor = Date.UTC(year + 1, anchorMonth - 1, anchorDay, 23, 59, 59, 999)
  return {
    startMs: Date.UTC(year + 1, 0, 1, 0, 0, 0, 0),
    endMs: nextAnchor,
    endIso: new Date(nextAnchor).toISOString(),
  }
}

/**
 * Whole days from aIso to bIso (b - a); signed.
 */
function daysBetweenIso(aIso, bIso) {
  const a = Date.parse(aIso)
  const b = Date.parse(bIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

// -----------------------------------------------------------------------------
// Pattern resolvers (§3)
// -----------------------------------------------------------------------------

/**
 * Pattern A — single satisfying ack row, parent-signed channel required.
 *
 * Used by every R 400.1907 intake parent-signed sub-row + every
 * enrollment consent (Phase A + Phase B).
 *
 * State transitions:
 *   - active satisfying row, expires_at = null OR future → on_file
 *   - active satisfying row past expires_at → expired
 *   - provider_override-only row, no parent-signed row → pending_parent
 *   - nothing → missing_required
 */
function patternAAckOnFile({
  ackType,
  subjectType,
  subjectId,
  sourceRows,
  parentSignedRequired = true,
  now,
}) {
  const nowMs = now.getTime()
  const acks = (sourceRows.acks || []).filter(a =>
    a
    && a.type === ackType
    && a.subject_type === subjectType
    && a.subject_id === subjectId
    && !a.archived_at
  )

  // 1. Currently-valid satisfying row.
  for (const a of acks) {
    const expiresMs = parseTimestampMs(a.expires_at)
    const expired = expiresMs != null && expiresMs <= nowMs
    if (expired) continue
    if (parentSignedRequired && !PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    return {
      kind: REQUIREMENT_STATE_KIND.ON_FILE,
      evidence_id: a.id,
      expires_at: a.expires_at || null,
    }
  }

  // 2. Expired satisfying row.
  for (const a of acks) {
    const expiresMs = parseTimestampMs(a.expires_at)
    if (expiresMs == null || expiresMs > nowMs) continue
    if (parentSignedRequired && !PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    return {
      kind: REQUIREMENT_STATE_KIND.EXPIRED,
      evidence_id: a.id,
      expired_at: a.expires_at,
    }
  }

  // 3. Provider-override-only row → pending_parent (parent must still sign).
  if (parentSignedRequired) {
    const providerOnly = acks.find(a => a.acknowledged_via === 'provider_override')
    if (providerOnly) {
      return {
        kind: REQUIREMENT_STATE_KIND.PENDING_PARENT,
        evidence_id: providerOnly.id,
      }
    }
  }

  return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
}

/**
 * Pattern B — inform-only ack (any channel satisfies). Lead disclosure
 * only (R 400.1907(1)(b)(vi)).
 */
function patternBInformOnly({ ackType, subjectType, subjectId, sourceRows, now }) {
  return patternAAckOnFile({
    ackType,
    subjectType,
    subjectId,
    sourceRows,
    parentSignedRequired: false,
    now,
  })
}

/**
 * Pattern C — date-driven currency. Used by CPR/First Aid expirations,
 * CDC authorization end, fingerprint reprint.
 *
 * `expiringWindowDays` is reported in the result via `expiring_soon`
 * but does NOT change the state kind — the consumer (Phase 4 score)
 * decides what to do with the flag. Expiring-within-window is still
 * `on_file` here; only past-expiry is `expired`.
 */
function patternCDateCurrency({ expiresOn, expiringWindowDays, now }) {
  if (!expiresOn) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
  const expiresMs = parseTimestampMs(expiresOn)
  if (expiresMs == null) {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unparseable-date' }
  }
  if (expiresMs <= now.getTime()) {
    return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: expiresOn }
  }
  const result = { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: expiresOn }
  if (expiringWindowDays != null) {
    const days = Math.round((expiresMs - now.getTime()) / 86400000)
    if (days <= expiringWindowDays) result.expiring_soon = true
  }
  return result
}

/**
 * Pattern D — annual cadence with anchor (calendar-year-anchored).
 *
 * MiRegistry annual ongoing (anchor Dec 16): "Annual Ongoing Training
 * is required to be completed each year by December 16." Cycle =
 * Jan 1 → Dec 16 of the relevant year (see annualCalendarCycle).
 *
 * Annual record review (anchor based on `intake_completed_at` or
 * `records_last_reviewed_on`) uses a different shape — handled
 * directly in the row's state_resolver.
 */
function patternDAnnualCadence({ lastCompletedOn, anchorMonth, anchorDay, now }) {
  if (!lastCompletedOn) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
  const lastMs = parseTimestampMs(lastCompletedOn)
  if (lastMs == null) {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unparseable-date' }
  }
  const cycle = annualCalendarCycle({ anchorMonth, anchorDay, now })
  if (lastMs >= cycle.startMs && lastMs <= cycle.endMs) {
    return { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: cycle.endIso }
  }
  // Completed before the current cycle's start window → expired.
  if (lastMs < cycle.startMs) {
    return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: cycle.endIso }
  }
  // Future date — schema oddity.
  return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'completion-date-in-future' }
}

/**
 * Pattern E — feature not yet modelled. Returns unknown with the
 * fixed `feature-not-yet-shipped` reason. Used by drills, property
 * records, the staff-file gaps (physician attestation, staff
 * discipline ack), and the religious-objection placeholder.
 *
 * Per §10 checklist + §2a: a Pattern E row whose applicability
 * resolves to `applies` (e.g., universally-required drill log) still
 * reports state = unknown with the `feature-not-yet-shipped` reason.
 * The applicability says "yes, you need this"; the state says "but
 * we don't have a place to capture it yet." When the substrate
 * ships, the row's state_resolver swaps in; no engine API change.
 */
function patternENotYetModelled() {
  return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'feature-not-yet-shipped' }
}

// -----------------------------------------------------------------------------
// Domain-specific helpers
// -----------------------------------------------------------------------------

/**
 * For the intake bundle drift detection — recompute the required
 * sub-types for this child given the current premises booleans + age.
 * Mirrors `requiredSubTypesForChild` from `acknowledgments.js`, but
 * inlined here so the registry's drift resolver is self-contained.
 *
 * NOTE: This is intentionally a separate copy from the one in
 * `acknowledgments.js`. The two should stay in sync; the registry's
 * `child_in_care_statement_envelope_drift` row uses this version to
 * detect when the required-set has changed since the envelope was
 * acknowledged. If `requiredSubTypesForChild` in acknowledgments.js
 * gains a new gating field, this copy must update in lockstep.
 */
function currentRequiredIntakeSubTypes({ child, provider, now }) {
  const req = []
  if (!child || !provider) return req
  if (provider.home_built_before_1978 === true) req.push(ACK_TYPES.LEAD_DISCLOSURE)
  if (provider.firearms_on_premises === true || provider.firearms_on_premises === false) {
    req.push(ACK_TYPES.FIREARMS_DISCLOSURE)
  }
  req.push(ACK_TYPES.FOOD_PROVIDER_AGREEMENT)
  req.push(ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY)
  req.push(ACK_TYPES.LICENSING_RULES_OFFERED)
  req.push(ACK_TYPES.HEALTH_CONDITION)
  req.push(ACK_TYPES.DISCIPLINE_POLICY_RECEIPT)
  if (child.date_of_birth) {
    const months = ageInMonths(child.date_of_birth, now)
    if (months != null && months < 18) req.push(ACK_TYPES.INFANT_SAFE_SLEEP)
  }
  return req.sort()
}

// -----------------------------------------------------------------------------
// REQUIREMENT_REGISTRY — the canonical catalog (§4)
// -----------------------------------------------------------------------------
//
// 52 rows. Row 19 (religious-objection) is DEFERRED per §6 — NOT
// included in this registry. Revisits when the ack type and capture
// flow ship.
//
// Each row has the shape:
//   {
//     key:            string,                   // stable identifier
//     category:       one of CATEGORIES,
//     rule_citation:  string,                   // R 400.xxxx or program rule
//     label:          string,                   // short UI label
//     subject_type:   'child' | 'caregiver' | 'provider' |
//                     'medication_authorization' | 'funding_source' |
//                     'attendance_day',
//     data_authority: 'milittlecare' | 'miregistry',  // T2 vs T1
//     gsq_relevant:   boolean,                  // GSQ projection seam
//     severity:       'critical' | 'high' | 'medium' | 'low',
//     applicability:  AppRule,
//     state_resolver: (ctx) => RequirementState,
//     data_state?:    'shipped' | 'not_yet_modelled',  // optional flag
//   }
//
// Order in the file matches §4: child_files, consents, medication,
// staff_files, miregistry, funding_docs+cdc, attendance, drills,
// property.

export const REQUIREMENT_REGISTRY = Object.freeze({

  // ─── child_files (12) ────────────────────────────────────────────

  child_in_care_statement_envelope: Object.freeze({
    key: 'child_in_care_statement_envelope',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)',
    label: 'Child-in-care statement (envelope)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_lead_disclosure: Object.freeze({
    key: 'intake_lead_disclosure',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(vi)',
    label: 'Lead-based paint disclosure (inform-only)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // Data-inferred from the provider's home_built_before_1978 flag.
      // Per §2a: null premises field → unknown (the provider hasn't
      // answered yet); not a silent does_not_apply.
      inferFromData: ({ provider }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        if (provider.home_built_before_1978 === true) return APPLICABILITY_RESULT.APPLIES
        if (provider.home_built_before_1978 === false) return APPLICABILITY_RESULT.DOES_NOT_APPLY
        return APPLICABILITY_RESULT.UNKNOWN
      },
    },
    state_resolver: ({ child, sourceRows, now }) => patternBInformOnly({
      ackType: ACK_TYPES.LEAD_DISCLOSURE,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_firearms_disclosure: Object.freeze({
    key: 'intake_firearms_disclosure',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(v)',
    label: 'Firearms-on-premises disclosure',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // Required regardless of yes/no — but null means the provider
      // hasn't answered, so the disclosure can't yet be written.
      // §2a: null → unknown, not does_not_apply.
      inferFromData: ({ provider }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        if (provider.firearms_on_premises === true || provider.firearms_on_premises === false) {
          return APPLICABILITY_RESULT.APPLIES
        }
        return APPLICABILITY_RESULT.UNKNOWN
      },
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.FIREARMS_DISCLOSURE,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_food_provider_agreement: Object.freeze({
    key: 'intake_food_provider_agreement',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(ii)',
    label: 'Agreement on who provides food',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_licensing_notebook_availability: Object.freeze({
    key: 'intake_licensing_notebook_availability',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(vii)',
    label: 'Notice of licensing notebook availability',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      // DB string value preserved as 'licensing_notebook_offered' per
      // the 2026-05-29 rename — see acknowledgments.js header.
      ackType: ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_licensing_rules_offered: Object.freeze({
    key: 'intake_licensing_rules_offered',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(iii)',
    label: 'Offer of licensing rules copy',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.LICENSING_RULES_OFFERED,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_infant_safe_sleep: Object.freeze({
    key: 'intake_infant_safe_sleep',
    category: 'child_files',
    rule_citation: 'R 400.1930',
    label: 'Infant safe sleep practices (children under 18 months)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      // childGate: <18 months at now → applies; ≥18 months → does_not_apply;
      // null DOB → unknown (per §2a — can't classify without DOB).
      childGate: ({ child, now }) => {
        if (!child || !child.date_of_birth) return APPLICABILITY_RESULT.UNKNOWN
        const months = ageInMonths(child.date_of_birth, now)
        if (months == null) return APPLICABILITY_RESULT.UNKNOWN
        return months < 18 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.INFANT_SAFE_SLEEP,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_health_condition: Object.freeze({
    key: 'intake_health_condition',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(i)',
    label: 'Acknowledgment of child health condition',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.HEALTH_CONDITION,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  intake_discipline_policy_receipt: Object.freeze({
    key: 'intake_discipline_policy_receipt',
    category: 'child_files',
    rule_citation: 'R 400.1907(1)(b)(iv)',
    label: 'Discipline policy receipt (parent at intake)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.DISCIPLINE_POLICY_RECEIPT,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  child_immunization_record: Object.freeze({
    key: 'child_immunization_record',
    category: 'child_files',
    rule_citation: 'R 400.1907',
    label: 'Immunization record (or waiver) on file',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child }) => {
      const VALID = ['up_to_date', 'waiver_on_file', 'in_progress']
      if (child && VALID.includes(child.immunization_status)) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      }
      return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
    },
  }),

  child_annual_record_review: Object.freeze({
    key: 'child_annual_record_review',
    category: 'child_files',
    rule_citation: 'R 400.1907',
    label: 'Annual review of child records',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ child, now }) => {
      // First-year tolerance: if intake_completed_at < 12 months,
      // on_file regardless (the child hasn't been enrolled a full year).
      const intakeMs = parseTimestampMs(child && child.intake_completed_at)
      const oneYearAgoMs = now.getTime() - 366 * 86400000  // ~1y
      if (intakeMs != null && intakeMs > oneYearAgoMs) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      }
      const lastReviewedOn = child && child.records_last_reviewed_on
      if (!lastReviewedOn) {
        // No review and not within first-year tolerance → expired
        // (the review is overdue).
        if (intakeMs != null) {
          return { kind: REQUIREMENT_STATE_KIND.EXPIRED }
        }
        return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
      }
      const lastMs = Date.parse(lastReviewedOn + 'T00:00:00Z')
      if (!Number.isFinite(lastMs)) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unparseable-date' }
      }
      if (now.getTime() - lastMs <= 366 * 86400000) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      }
      return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: lastReviewedOn }
    },
  }),

  child_in_care_statement_envelope_drift: Object.freeze({
    key: 'child_in_care_statement_envelope_drift',
    category: 'child_files',
    rule_citation: 'R 400.1907 (derived)',
    label: 'Intake envelope is up to date (no drift)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      // Only applies if there IS an envelope to drift from.
      inferFromData: ({ child, provider, sourceRows, now }) => {
        if (!child || !provider) return APPLICABILITY_RESULT.UNKNOWN
        const acks = sourceRows.acks || []
        const envelope = acks.find(a =>
             a.type === ACK_TYPES.CHILD_IN_CARE_STATEMENT
          && a.subject_type === 'child'
          && a.subject_id === child.id
          && !a.archived_at
        )
        return envelope ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ child, provider, sourceRows, now }) => {
      const acks = sourceRows.acks || []
      const envelope = acks.find(a =>
           a.type === ACK_TYPES.CHILD_IN_CARE_STATEMENT
        && a.subject_type === 'child'
        && a.subject_id === child.id
        && !a.archived_at
      )
      // applicability already guards this; defensive nullcheck.
      if (!envelope) return { kind: REQUIREMENT_STATE_KIND.NOT_APPLICABLE }
      const currentlyRequired = currentRequiredIntakeSubTypes({ child, provider, now })
      // Sub-rows currently active under this envelope.
      const presentSubTypes = new Set(
        acks
          .filter(a => a.subject_type === 'child' && a.subject_id === child.id && !a.archived_at)
          .map(a => a.type)
      )
      // Drift if any currently-required type is missing OR if any
      // unexpected sub-type lingers.
      for (const t of currentlyRequired) {
        if (!presentSubTypes.has(t)) {
          return {
            kind: REQUIREMENT_STATE_KIND.PENDING_PARENT,
            reason: 'envelope-stale-required-subtype-missing',
            evidence_id: envelope.id,
          }
        }
      }
      return { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: envelope.id }
    },
  }),

  // ─── consents (6 — row 19 deferred) ──────────────────────────────

  consent_field_trip_permission: Object.freeze({
    key: 'consent_field_trip_permission',
    category: 'consents',
    rule_citation: 'R 400.1952(2)',
    label: 'Non-vehicle field trip permission (at enrollment)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      // Rule reads as unconditional for licensed homes; auto = applies.
      // A provider who never does trips can dismiss / override in Phase 3.
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      autoDefault: APPLICABILITY_RESULT.APPLIES,
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.FIELD_TRIP_PERMISSION,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  consent_transportation_routine_annual: Object.freeze({
    key: 'consent_transportation_routine_annual',
    category: 'consents',
    rule_citation: 'R 400.1952(1)(a)',
    label: 'Routine transportation permission (annual)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // Provider-declared with NO auto fallback to does_not_apply.
      // Per §2a + §6: silent gap is the dangerous failure. Default
      // = unknown until Phase 3 overrides resolve.
      autoDefault: APPLICABILITY_RESULT.UNKNOWN,
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  consent_water_activities_on_premises_seasonal: Object.freeze({
    key: 'consent_water_activities_on_premises_seasonal',
    category: 'consents',
    rule_citation: 'R 400.1934(10)(b)',
    label: 'On-premises water activities permission (annual)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // §2a — default unknown, not does_not_apply.
      autoDefault: APPLICABILITY_RESULT.UNKNOWN,
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  consent_transportation_nonroutine_per_trip_recency: Object.freeze({
    key: 'consent_transportation_nonroutine_per_trip_recency',
    category: 'consents',
    rule_citation: 'R 400.1952(1)(b)',
    label: 'Per-trip non-routine transportation consent (recency)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      // Data-inferred: applies only when ≥1 active per-trip ack exists
      // in the last 12 months. Absence of trips = absence of requirement.
      inferFromData: ({ child, sourceRows, now }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        const cutoffMs = now.getTime() - 365 * 86400000
        const acks = sourceRows.acks || []
        const any = acks.some(a =>
             a.type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP
          && a.subject_type === 'child'
          && a.subject_id === child.id
          && !a.archived_at
          && parseTimestampMs(a.acknowledged_at) != null
          && parseTimestampMs(a.acknowledged_at) >= cutoffMs
        )
        return any ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ child, sourceRows, now }) => {
      // Applicability guarantees ≥1 active recent row when we get here.
      const acks = sourceRows.acks || []
      const cutoffMs = now.getTime() - 365 * 86400000
      const recent = acks.find(a =>
           a.type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP
        && a.subject_type === 'child'
        && a.subject_id === child.id
        && !a.archived_at
        && PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)
        && (parseTimestampMs(a.acknowledged_at) || 0) >= cutoffMs
      )
      return recent
        ? { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: recent.id }
        : { kind: REQUIREMENT_STATE_KIND.PENDING_PARENT }
    },
  }),

  consent_water_activities_off_premises_per_trip_recency: Object.freeze({
    key: 'consent_water_activities_off_premises_per_trip_recency',
    category: 'consents',
    rule_citation: 'R 400.1934(10)(a)',
    label: 'Per-trip off-premises water activity consent (recency)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ child, sourceRows, now }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        const cutoffMs = now.getTime() - 365 * 86400000
        const acks = sourceRows.acks || []
        const any = acks.some(a =>
             a.type === ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP
          && a.subject_type === 'child'
          && a.subject_id === child.id
          && !a.archived_at
          && (parseTimestampMs(a.acknowledged_at) || 0) >= cutoffMs
        )
        return any ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ child, sourceRows, now }) => {
      const acks = sourceRows.acks || []
      const cutoffMs = now.getTime() - 365 * 86400000
      const recent = acks.find(a =>
           a.type === ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP
        && a.subject_type === 'child'
        && a.subject_id === child.id
        && !a.archived_at
        && PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)
        && (parseTimestampMs(a.acknowledged_at) || 0) >= cutoffMs
      )
      return recent
        ? { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: recent.id }
        : { kind: REQUIREMENT_STATE_KIND.PENDING_PARENT }
    },
  }),

  consent_photo_sharing: Object.freeze({
    key: 'consent_photo_sharing',
    category: 'consents',
    rule_citation: 'None (provider-protective)',
    label: 'Photo-sharing consent',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'low',  // provider-protective, not licensing
    data_state: 'shipped',
    applicability: {
      // Messaging-with-photos is the default UX. Auto = applies.
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      autoDefault: APPLICABILITY_RESULT.APPLIES,
    },
    state_resolver: ({ child, sourceRows, now }) => {
      // Pattern A + revocation-pair: an active revocation row under
      // a satisfying channel counts as "preference captured" — same
      // semantic as pendingEnrollmentConsentsForChild.
      const consent = patternAAckOnFile({
        ackType: ACK_TYPES.PHOTO_SHARING_CONSENT,
        subjectType: 'child',
        subjectId: child.id,
        sourceRows,
        now,
      })
      if (consent.kind === REQUIREMENT_STATE_KIND.ON_FILE) return consent
      // Check for a revocation-pair row.
      const acks = sourceRows.acks || []
      const revoked = acks.find(a =>
           a.type === ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED
        && a.subject_type === 'child'
        && a.subject_id === child.id
        && !a.archived_at
        && PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)
      )
      if (revoked) {
        // Preference captured (as a no). Treat as on_file from the
        // engine's perspective; consumers can read evidence to render
        // "consented" vs "revoked."
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: revoked.id, revoked: true }
      }
      return consent
    },
  }),

  // ─── medication (6) ──────────────────────────────────────────────

  medication_authorization_for_authorization: Object.freeze({
    key: 'medication_authorization_for_authorization',
    category: 'medication',
    rule_citation: 'R 400.1931(3-6)',
    label: 'Medication authorization on file',
    subject_type: 'medication_authorization',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      // Data-inferred: applies per active medication_authorizations row.
      // The "requirement" is informational — the row IS the
      // requirement. State is on_file whenever an active row exists.
      inferFromData: ({ sourceRows }) => {
        const auths = sourceRows.medication_authorizations || []
        return auths.some(a => !a.archived_at)
          ? APPLICABILITY_RESULT.APPLIES
          : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: () => ({ kind: REQUIREMENT_STATE_KIND.ON_FILE }),
  }),

  medication_permission_per_authorization: Object.freeze({
    key: 'medication_permission_per_authorization',
    category: 'medication',
    rule_citation: 'R 400.1931(2)',
    label: 'Per-medication parent permission (non-OTC)',
    subject_type: 'medication_authorization',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: {
      // Per-non-OTC authorization. Computed once per provider-state;
      // rollup expands per non-OTC authorization. Applies when ≥1
      // non-OTC auth exists (the rollup iterates per auth and
      // reports per-auth state).
      inferFromData: ({ sourceRows }) => {
        const auths = sourceRows.medication_authorizations || []
        return auths.some(a => !a.archived_at && !a.is_topical_otc)
          ? APPLICABILITY_RESULT.APPLIES
          : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, now }) => {
      // Returns the WORST per-auth state across all non-OTC auths
      // for this provider/child scope. The per-child rollup
      // narrows by child first.
      const auths = (sourceRows.medication_authorizations || [])
        .filter(a => !a.archived_at && !a.is_topical_otc)
      if (auths.length === 0) return { kind: REQUIREMENT_STATE_KIND.NOT_APPLICABLE }
      let worst = null
      const rank = { on_file: 0, pending_parent: 1, expired: 2, missing_required: 3, unknown: 4 }
      for (const auth of auths) {
        const state = patternAAckOnFile({
          ackType: ACK_TYPES.MEDICATION_PERMISSION,
          subjectType: 'medication_authorization',
          subjectId: auth.id,
          sourceRows,
          now,
        })
        // Drift detection: ack present but snapshot_hash differs from
        // current — flag as pending_parent (re-ack needed).
        if (state.kind === REQUIREMENT_STATE_KIND.ON_FILE && state.evidence_id) {
          const ack = (sourceRows.acks || []).find(a => a.id === state.evidence_id)
          if (ack && ack.snapshot_hash) {
            // Drift check: compare against the canonical payload hash
            // for this authorization. We don't import computeAckHash
            // here to keep the pure module independent; instead, we
            // signal "drift suspected when the authorization's
            // updated_at is later than the ack's acknowledged_at."
            const ackMs = parseTimestampMs(ack.acknowledged_at)
            const authMs = parseTimestampMs(auth.updated_at)
            if (ackMs != null && authMs != null && authMs > ackMs) {
              const driftState = { kind: REQUIREMENT_STATE_KIND.PENDING_PARENT, reason: 'authorization-changed-since-permission' }
              if (worst == null || rank[driftState.kind] > rank[worst.kind]) worst = driftState
              continue
            }
          }
        }
        if (worst == null || (rank[state.kind] ?? 4) > (rank[worst.kind] ?? 4)) {
          worst = state
        }
      }
      return worst || { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
    },
  }),

  medication_permission_otc_blanket: Object.freeze({
    key: 'medication_permission_otc_blanket',
    category: 'medication',
    rule_citation: 'R 400.1931(8)',
    label: 'OTC-blanket parent permission (topical OTC)',
    subject_type: 'child',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // Applies when this child has ≥1 OTC authorization.
      inferFromData: ({ child, sourceRows }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        const any = (sourceRows.medication_authorizations || [])
          .some(a => !a.archived_at && a.is_topical_otc && a.child_id === child.id)
        return any ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ child, sourceRows, now }) => patternAAckOnFile({
      ackType: ACK_TYPES.MEDICATION_PERMISSION_OTC_BLANKET,
      subjectType: 'child',
      subjectId: child.id,
      sourceRows,
      now,
    }),
  }),

  medication_role_gate_integrity: Object.freeze({
    key: 'medication_role_gate_integrity',
    category: 'medication',
    rule_citation: 'R 400.1931(1)',
    label: 'Role-gate integrity (dose-administering staff eligibility)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: {
      // Applies when there's ≥1 non-OTC dose event for the provider.
      inferFromData: ({ sourceRows }) => {
        const events = sourceRows.medication_admin_events || []
        const auths = sourceRows.medication_authorizations || []
        const otcAuthIds = new Set(auths.filter(a => a.is_topical_otc).map(a => a.id))
        const any = events.some(e => !e.archived_at && !otcAuthIds.has(e.authorization_id))
        return any ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows }) => {
      // Defensive: the DB trigger guarantees on_file. We check anyway
      // because the trigger could be bypassed by a future direct
      // write. Anomaly = a non-OTC dose event whose caregiver lacks
      // an eligible regulatory_role.
      const events = sourceRows.medication_admin_events || []
      const auths = sourceRows.medication_authorizations || []
      const caregivers = sourceRows.caregivers || []
      const ELIGIBLE = new Set(['licensee', 'child_care_staff_member'])
      const otcAuthIds = new Set(auths.filter(a => a.is_topical_otc).map(a => a.id))
      for (const ev of events) {
        if (ev.archived_at) continue
        if (otcAuthIds.has(ev.authorization_id)) continue
        const cg = caregivers.find(c => c.id === ev.administered_by_caregiver_id)
        const roles = (cg && (cg.regulatory_roles || []).map(r => typeof r === 'string' ? r : r.regulatory_role)) || []
        const hasEligible = roles.some(r => ELIGIBLE.has(r))
        if (!hasEligible) {
          return {
            kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED,
            reason: 'ineligible-role-administered-non-otc-dose',
            evidence_id: ev.id,
          }
        }
      }
      return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
    },
  }),

  medication_original_container_attestation: Object.freeze({
    key: 'medication_original_container_attestation',
    category: 'medication',
    rule_citation: 'R 400.1931(4)',
    label: 'Original container attestation (per non-OTC authorization)',
    subject_type: 'medication_authorization',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const auths = sourceRows.medication_authorizations || []
        return auths.some(a => !a.archived_at && !a.is_topical_otc)
          ? APPLICABILITY_RESULT.APPLIES
          : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows }) => {
      const auths = (sourceRows.medication_authorizations || [])
        .filter(a => !a.archived_at && !a.is_topical_otc)
      for (const a of auths) {
        if (a.original_container_confirmed !== true) {
          return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, evidence_id: a.id }
        }
      }
      return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
    },
  }),

  medication_dose_log_retention: Object.freeze({
    key: 'medication_dose_log_retention',
    category: 'medication',
    rule_citation: 'R 400.1931(9)',
    label: 'Dose log retention (per non-OTC authorization)',
    subject_type: 'medication_authorization',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const auths = sourceRows.medication_authorizations || []
        const events = sourceRows.medication_admin_events || []
        const otcAuthIds = new Set(auths.filter(a => a.is_topical_otc).map(a => a.id))
        // Applies when there's at least one non-OTC dose event.
        const any = events.some(e => !e.archived_at && !otcAuthIds.has(e.authorization_id))
        return any ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: () => ({ kind: REQUIREMENT_STATE_KIND.ON_FILE }),
    // DB enforces archive-not-delete; nothing to disprove from the data.
  }),

  // ─── staff_files (9) ─────────────────────────────────────────────

  caregiver_background_check_eligibility: Object.freeze({
    key: 'caregiver_background_check_eligibility',
    category: 'staff_files',
    rule_citation: 'R 400.1919 / R 400.1903(1)(r)',
    label: 'Background check eligibility (per caregiver)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ sourceRows }) => {
      // Reports WORST across caregivers.
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const records = sourceRows.staff_training_records || []
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, pending_parent: 1, missing_required: 2, expired: 3, unknown: 4 }
      for (const c of caregivers) {
        const r = mostRecentByCategory(records, c.id, 'background_check_eligibility')
        let state
        if (!r) state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, evidence_id: null }
        else if (r.background_check_status === 'eligible') state = { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: r.id }
        else if (r.background_check_status === 'pending')  state = { kind: REQUIREMENT_STATE_KIND.PENDING_PARENT, evidence_id: r.id }
        else state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, evidence_id: r.id, reason: 'ineligible' }
        if ((rank[state.kind] ?? 4) > (rank[worst.kind] ?? 4)) worst = state
      }
      return worst
    },
  }),

  caregiver_cpr_first_aid_current: Object.freeze({
    key: 'caregiver_cpr_first_aid_current',
    category: 'staff_files',
    rule_citation: 'R 400.1924(8)',
    label: 'CPR + pediatric first aid currency (per caregiver)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ sourceRows, now }) => {
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const records = sourceRows.staff_training_records || []
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, pending_parent: 1, expired: 2, missing_required: 3, unknown: 4 }
      for (const c of caregivers) {
        const r = mostRecentByCategory(records, c.id, 'cpr_first_aid')
        const state = r
          ? patternCDateCurrency({ expiresOn: r.expires_on, expiringWindowDays: 60, now })
          : { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
        if ((rank[state.kind] ?? 4) > (rank[worst.kind] ?? 4)) worst = state
      }
      return worst
    },
  }),

  caregiver_new_hire_training_complete: Object.freeze({
    key: 'caregiver_new_hire_training_complete',
    category: 'staff_files',
    rule_citation: 'R 400.1923',
    label: 'New-hire 14-topic training (per caregiver, 90-day deadline)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ sourceRows, now }) => {
      // 14 topics required (per R 400.1923). Pure: count distinct
      // new_hire_training records per caregiver vs 14. The records'
      // shape carries a `topic` discriminator the dashboard renders;
      // we count distinct non-null topics here as a defensive proxy.
      const REQUIRED_TOPICS = 14
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const records = (sourceRows.staff_training_records || [])
        .filter(r => r.category === 'new_hire_training')
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, missing_required: 1, expired: 2, unknown: 3 }
      for (const c of caregivers) {
        const cgRecords = records.filter(r => r.caregiver_id === c.id)
        const topicsCovered = new Set(cgRecords.map(r => r.topic).filter(Boolean)).size
        if (topicsCovered >= REQUIRED_TOPICS) continue
        // Not yet complete — check 90-day window.
        let state
        if (!c.date_of_hire) {
          state = { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregiver-missing-date-of-hire' }
        } else {
          const hireMs = parseTimestampMs(c.date_of_hire + 'T00:00:00Z')
          if (hireMs == null) state = { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unparseable-hire-date' }
          else if (now.getTime() - hireMs <= 90 * 86400000) state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'within-90-day-window' }
          else state = { kind: REQUIREMENT_STATE_KIND.EXPIRED, reason: 'past-90-day-deadline' }
        }
        if ((rank[state.kind] ?? 4) > (rank[worst.kind] ?? 4)) worst = state
      }
      return worst
    },
  }),

  caregiver_miregistry_account: Object.freeze({
    key: 'caregiver_miregistry_account',
    category: 'staff_files',
    rule_citation: 'R 400.1922',
    label: 'MiRegistry account & membership (per caregiver, ≥30-day)',
    subject_type: 'caregiver',
    data_authority: 'miregistry',  // Type 1 — verify in MiRegistry
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ sourceRows }) => {
      const OK_STATUSES = new Set(['submitted', 'materials_received', 'awaiting_print', 'current'])
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const records = sourceRows.staff_training_records || []
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, missing_required: 1, expired: 2, unknown: 3 }
      for (const c of caregivers) {
        const r = mostRecentByCategory(records, c.id, 'miregistry_account')
        let state
        if (!r) state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
        else if (r.miregistry_status === 'expired') state = { kind: REQUIREMENT_STATE_KIND.EXPIRED, evidence_id: r.id }
        else if (OK_STATUSES.has(r.miregistry_status)) state = { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: r.id }
        else state = { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unrecognized-miregistry-status', evidence_id: r.id }
        if ((rank[state.kind] ?? 3) > (rank[worst.kind] ?? 3)) worst = state
      }
      return worst
    },
  }),

  caregiver_professional_development_hours: Object.freeze({
    key: 'caregiver_professional_development_hours',
    category: 'staff_files',
    rule_citation: 'R 400.1924',
    label: 'Professional development hours (per caregiver, annual)',
    subject_type: 'caregiver',
    data_authority: 'miregistry',  // Type 1
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: ({ sourceRows, now }) => {
      // Per-role hour thresholds — for Phase 1 we use a single
      // conservative threshold (16 hours) since the per-role
      // mapping isn't exposed via a typed column. The score (Phase 4)
      // refines this. For now: <16 → missing_required; ≥16 → on_file.
      const ANNUAL_HOURS = 16
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const records = (sourceRows.staff_training_records || [])
        .filter(r => r.category === 'professional_development')
      const year = now.getUTCFullYear()
      const yearStartMs = Date.UTC(year, 0, 1)
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, missing_required: 1, expired: 2, unknown: 3 }
      for (const c of caregivers) {
        const total = records
          .filter(r => r.caregiver_id === c.id && (parseTimestampMs(r.completed_on) || 0) >= yearStartMs)
          .reduce((sum, r) => sum + (Number(r.hours) || 0), 0)
        const state = total >= ANNUAL_HOURS
          ? { kind: REQUIREMENT_STATE_KIND.ON_FILE }
          : { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: `hours-${total}-of-${ANNUAL_HOURS}` }
        if ((rank[state.kind] ?? 3) > (rank[worst.kind] ?? 3)) worst = state
      }
      return worst
    },
  }),

  caregiver_health_safety_update_acked: Object.freeze({
    key: 'caregiver_health_safety_update_acked',
    category: 'staff_files',
    rule_citation: 'R 400.1924(11)',
    label: 'Health & safety update acknowledgments',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const updates = sourceRows.health_safety_updates || []
        return updates.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows }) => {
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      const updates = sourceRows.health_safety_updates || []
      const records = (sourceRows.staff_training_records || [])
        .filter(r => r.category === 'health_safety_update_acknowledgement')
      if (caregivers.length === 0 || updates.length === 0) {
        return { kind: REQUIREMENT_STATE_KIND.NOT_APPLICABLE }
      }
      // Every active caregiver should have acked every update.
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, missing_required: 1 }
      for (const c of caregivers) {
        for (const u of updates) {
          const acked = records.some(r => r.caregiver_id === c.id && r.health_safety_update_id === u.id)
          if (!acked) {
            const state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'unacked-update' }
            if ((rank[state.kind] ?? 1) > (rank[worst.kind] ?? 0)) worst = state
          }
        }
      }
      return worst
    },
  }),

  caregiver_physician_attestation_annual: Object.freeze({
    key: 'caregiver_physician_attestation_annual',
    category: 'staff_files',
    rule_citation: 'R 400.1933',
    label: 'Physician attestation of staff health (annual)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  caregiver_discipline_policy_ack_at_hire: Object.freeze({
    key: 'caregiver_discipline_policy_ack_at_hire',
    category: 'staff_files',
    rule_citation: 'R 400.1923',
    label: 'Staff acknowledgment of discipline policy (at hire)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  caregiver_daily_arrival_departure: Object.freeze({
    key: 'caregiver_daily_arrival_departure',
    category: 'staff_files',
    rule_citation: 'R 400.1906',
    label: 'Daily arrival/departure log (per caregiver, operating days)',
    subject_type: 'caregiver',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'not_yet_modelled',
    // App-user staff clock exists in staff_time_entries; non-app-user
    // surface is the gap. Phase 1 reports unknown because the
    // engine can't distinguish "non-app-user caregivers exist but
    // never need to clock" from "they need to but no surface exists."
    // Phase E posture.
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  // ─── miregistry (2) ──────────────────────────────────────────────

  provider_miregistry_annual_ongoing: Object.freeze({
    key: 'provider_miregistry_annual_ongoing',
    category: 'miregistry',
    rule_citation: 'LEP Handbook p.12 (Dec 16 deadline)',
    label: 'MiRegistry annual ongoing training (Dec 16 deadline)',
    subject_type: 'provider',
    data_authority: 'miregistry',  // Type 1 — verify in MiRegistry
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    applicability: {
      // License-exempt only.
      inferFromData: ({ provider }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        if (provider.is_license_exempt === true) return APPLICABILITY_RESULT.APPLIES
        if (provider.is_license_exempt === false) return APPLICABILITY_RESULT.DOES_NOT_APPLY
        // Also infer from license_type when is_license_exempt is null.
        if (provider.license_type === 'license_exempt') return APPLICABILITY_RESULT.APPLIES
        if (LICENSED_HOME_LICENSE_TYPES.includes(provider.license_type)) return APPLICABILITY_RESULT.DOES_NOT_APPLY
        return APPLICABILITY_RESULT.UNKNOWN
      },
    },
    state_resolver: ({ sourceRows, now }) => {
      const entries = (sourceRows.miregistry_training_entries || [])
        .filter(e => e.source === 'annual_ongoing' && !e.archived_at)
      const latest = entries
        .map(e => e.completed_on)
        .filter(Boolean)
        .sort()
        .reverse()[0] || null
      return patternDAnnualCadence({
        lastCompletedOn: latest,
        anchorMonth: 12,
        anchorDay: 16,
        now,
      })
    },
  }),

  provider_miregistry_level_2_currency: Object.freeze({
    key: 'provider_miregistry_level_2_currency',
    category: 'miregistry',
    rule_citation: 'LEP Handbook p.13 (rolling 10-hour)',
    label: 'MiRegistry Level 2 currency (rolling expiry)',
    subject_type: 'provider',
    data_authority: 'miregistry',  // Type 1
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // License-exempt AND currently at Level 2.
      inferFromData: ({ provider }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        const isLEP = provider.is_license_exempt === true || provider.license_type === 'license_exempt'
        if (!isLEP) {
          if (provider.is_license_exempt === false || LICENSED_HOME_LICENSE_TYPES.includes(provider.license_type)) {
            return APPLICABILITY_RESULT.DOES_NOT_APPLY
          }
          return APPLICABILITY_RESULT.UNKNOWN
        }
        if (provider.miregistry_current_level === 'level_2') return APPLICABILITY_RESULT.APPLIES
        if (provider.miregistry_current_level === 'level_1') return APPLICABILITY_RESULT.DOES_NOT_APPLY
        return APPLICABILITY_RESULT.UNKNOWN
      },
    },
    state_resolver: ({ provider, now }) => patternCDateCurrency({
      expiresOn: provider && provider.miregistry_level_2_expires_on,
      expiringWindowDays: 30,
      now,
    }),
  }),

  // ─── funding_docs + cdc_compliance (4) ───────────────────────────

  funding_dhs_198_on_file: Object.freeze({
    key: 'funding_dhs_198_on_file',
    category: 'funding_docs',
    rule_citation: 'CDC Handbook',
    label: 'DHS-198 on file (per CDC funding source)',
    subject_type: 'funding_source',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const fs = (sourceRows.funding_sources || []).filter(f => !f.archived_at && f.type === 'cdc_scholarship')
        return fs.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, now }) => {
      const cdcSources = (sourceRows.funding_sources || []).filter(f => !f.archived_at && f.type === 'cdc_scholarship')
      const docs = (sourceRows.funding_documents || []).filter(d => !d.archived_at && d.document_type === 'dhs_198')
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, expired: 1, missing_required: 2, unknown: 3 }
      for (const fs of cdcSources) {
        const doc = docs.find(d => d.funding_source_id === fs.id)
        let state
        if (!doc) state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
        else {
          const retentionMs = parseTimestampMs(doc.retention_until + 'T23:59:59Z')
          if (retentionMs != null && retentionMs <= now.getTime()) {
            state = { kind: REQUIREMENT_STATE_KIND.EXPIRED, evidence_id: doc.id, expired_at: doc.retention_until }
          } else {
            state = { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: doc.id }
          }
        }
        if ((rank[state.kind] ?? 3) > (rank[worst.kind] ?? 3)) worst = state
      }
      return worst
    },
  }),

  funding_enrollment_agreement_on_file: Object.freeze({
    key: 'funding_enrollment_agreement_on_file',
    category: 'funding_docs',
    rule_citation: 'CDC Handbook (licensed billing_basis = enrollment)',
    label: 'Enrollment Agreement on file (per licensed CDC source)',
    subject_type: 'funding_source',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const fs = (sourceRows.funding_sources || []).filter(f =>
             !f.archived_at
          && f.type === 'cdc_scholarship'
          && f.details && f.details.billing_basis === 'enrollment'
        )
        return fs.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, now }) => {
      const enrollmentSources = (sourceRows.funding_sources || []).filter(f =>
           !f.archived_at
        && f.type === 'cdc_scholarship'
        && f.details && f.details.billing_basis === 'enrollment'
      )
      const docs = (sourceRows.funding_documents || []).filter(d => !d.archived_at && d.document_type === 'enrollment_agreement')
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, expired: 1, missing_required: 2 }
      for (const fs of enrollmentSources) {
        const doc = docs.find(d => d.funding_source_id === fs.id)
        let state
        if (!doc) state = { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
        else {
          const retentionMs = parseTimestampMs(doc.retention_until + 'T23:59:59Z')
          state = (retentionMs != null && retentionMs <= now.getTime())
            ? { kind: REQUIREMENT_STATE_KIND.EXPIRED, evidence_id: doc.id }
            : { kind: REQUIREMENT_STATE_KIND.ON_FILE, evidence_id: doc.id }
        }
        if ((rank[state.kind] ?? 2) > (rank[worst.kind] ?? 2)) worst = state
      }
      return worst
    },
  }),

  cdc_authorization_currency: Object.freeze({
    key: 'cdc_authorization_currency',
    category: 'cdc_compliance',
    rule_citation: 'CDC Handbook',
    label: 'CDC authorization currency (per CDC funding source)',
    subject_type: 'funding_source',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const fs = (sourceRows.funding_sources || []).filter(f => !f.archived_at && f.type === 'cdc_scholarship')
        return fs.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, now }) => {
      const cdcSources = (sourceRows.funding_sources || []).filter(f => !f.archived_at && f.type === 'cdc_scholarship')
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, expired: 1, missing_required: 2, unknown: 3 }
      for (const fs of cdcSources) {
        const end = fs.authorization_end || (fs.details && fs.details.authorization_end)
        const state = end
          ? patternCDateCurrency({ expiresOn: end + 'T23:59:59Z', expiringWindowDays: EXPIRING_AUTHORIZATION_WINDOW_DAYS, now })
          : { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'no-authorization-end-on-funding-source' }
        if ((rank[state.kind] ?? 3) > (rank[worst.kind] ?? 3)) worst = state
      }
      return worst
    },
  }),

  cdc_fingerprint_reprint_currency: Object.freeze({
    key: 'cdc_fingerprint_reprint_currency',
    category: 'cdc_compliance',
    rule_citation: 'CDC Handbook (5-year cycle, LEP)',
    label: 'CDC fingerprint reprint currency (5-year cycle, LEP only)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ provider, sourceRows }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        const isLEP = provider.is_license_exempt === true || provider.license_type === 'license_exempt'
        if (!isLEP) {
          if (provider.is_license_exempt === false || LICENSED_HOME_LICENSE_TYPES.includes(provider.license_type)) {
            return APPLICABILITY_RESULT.DOES_NOT_APPLY
          }
          return APPLICABILITY_RESULT.UNKNOWN
        }
        const hasCdc = (sourceRows.funding_sources || []).some(f => !f.archived_at && f.type === 'cdc_scholarship')
        return hasCdc ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ provider, now }) => {
      if (!provider || !provider.fingerprint_date) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
      // 5-year cycle: print is good for 5 years.
      const printedMs = parseTimestampMs(provider.fingerprint_date + 'T00:00:00Z')
      if (printedMs == null) return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unparseable-fingerprint-date' }
      const ageDays = Math.round((now.getTime() - printedMs) / 86400000)
      const FIVE_YEARS_DAYS = 5 * 365  // ignore leap-year noise; spec acceptable
      if (ageDays >= FIVE_YEARS_DAYS) return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: provider.fingerprint_date }
      const result = { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: provider.fingerprint_date }
      // 30-day expiring window before the 5-year mark.
      if (ageDays >= FIVE_YEARS_DAYS - 30) result.expiring_soon = true
      return result
    },
  }),

  // ─── attendance (1) ──────────────────────────────────────────────

  attendance_parent_acknowledgment_per_day: Object.freeze({
    key: 'attendance_parent_acknowledgment_per_day',
    category: 'attendance',
    rule_citation: 'R 400.1906 (audit trail)',
    label: 'Daily attendance parent acknowledgment',
    subject_type: 'attendance_day',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows }) => {
        const acks = sourceRows.attendance_acks || []
        return acks.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows }) => {
      const acks = (sourceRows.attendance_acks || []).filter(a => !a.archived_at)
      if (acks.length === 0) return { kind: REQUIREMENT_STATE_KIND.NOT_APPLICABLE }
      const SATISFYING = new Set(['parent_portal', 'in_person_paper'])
      let pendingCount = 0
      let providerOnlyCount = 0
      for (const a of acks) {
        if (SATISFYING.has(a.acknowledged_via)) continue
        if (a.acknowledged_via === 'provider_override') providerOnlyCount += 1
        else pendingCount += 1
      }
      if (pendingCount === 0 && providerOnlyCount === 0) return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      if (providerOnlyCount > 0 && pendingCount === 0) {
        return { kind: REQUIREMENT_STATE_KIND.PENDING_PARENT, reason: `${providerOnlyCount}-days-provider-override-only` }
      }
      return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: `${pendingCount}-days-missing-ack` }
    },
  }),

  // ─── drills (4 — Pattern E) ──────────────────────────────────────

  drill_fire_quarterly: Object.freeze({
    key: 'drill_fire_quarterly',
    category: 'drills',
    rule_citation: 'R 400.1939',
    label: 'Fire drill (every 3 months)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  drill_tornado_seasonal: Object.freeze({
    key: 'drill_tornado_seasonal',
    category: 'drills',
    rule_citation: 'R 400.1939',
    label: 'Tornado drill (2× Mar-Nov)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  drill_other_emergencies_annual: Object.freeze({
    key: 'drill_other_emergencies_annual',
    category: 'drills',
    rule_citation: 'R 400.1939',
    label: 'Other emergency drills (annual)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  emergency_response_plan_on_file: Object.freeze({
    key: 'emergency_response_plan_on_file',
    category: 'drills',
    rule_citation: 'R 400.1939',
    label: 'Emergency Response Plan on file',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  // ─── property (8 — Pattern E) ────────────────────────────────────

  property_radon_test_quadrennial: Object.freeze({
    key: 'property_radon_test_quadrennial',
    category: 'property',
    rule_citation: 'R 400.1934/1932',
    label: 'Radon test (every 4 years)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_heating_inspection_quadrennial: Object.freeze({
    key: 'property_heating_inspection_quadrennial',
    category: 'property',
    rule_citation: 'R 400.1932',
    label: 'Heating equipment inspection (every 4 years)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_co_detectors_per_level: Object.freeze({
    key: 'property_co_detectors_per_level',
    category: 'property',
    rule_citation: 'R 400.1934',
    label: 'Carbon-monoxide detectors per level',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_smoke_detectors_per_floor: Object.freeze({
    key: 'property_smoke_detectors_per_floor',
    category: 'property',
    rule_citation: 'R 400.1934',
    label: 'Smoke detectors per floor',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_fire_extinguishers_per_floor: Object.freeze({
    key: 'property_fire_extinguishers_per_floor',
    category: 'property',
    rule_citation: 'R 400.1934',
    label: 'Fire extinguishers per floor (2A-10BC+)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_animal_notification: Object.freeze({
    key: 'property_animal_notification',
    category: 'property',
    rule_citation: 'R 400.1937',
    label: 'Animal/pet notification to parents',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'low',
    data_state: 'not_yet_modelled',
    applicability: {
      // §2a: default unknown until Phase 3 onboarding resolves.
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      autoDefault: APPLICABILITY_RESULT.UNKNOWN,
    },
    state_resolver: patternENotYetModelled,
  }),

  property_smoking_prohibition_posted: Object.freeze({
    key: 'property_smoking_prohibition_posted',
    category: 'property',
    rule_citation: 'R 400.1934',
    label: 'Smoking prohibition posted',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),

  property_licensing_notebook_archive: Object.freeze({
    key: 'property_licensing_notebook_archive',
    category: 'property',
    rule_citation: 'R 400.1906(3)',
    label: 'Licensing notebook archive on file',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'not_yet_modelled',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: patternENotYetModelled,
  }),
})

// -----------------------------------------------------------------------------
// Internal helpers (registry-side)
// -----------------------------------------------------------------------------

function mostRecentByCategory(records, caregiverId, category) {
  const list = (records || [])
    .filter(r => r.caregiver_id === caregiverId && r.category === category)
  if (list.length === 0) return null
  list.sort((a, b) => {
    const am = parseTimestampMs(a.completed_on) || parseTimestampMs(a.created_at) || 0
    const bm = parseTimestampMs(b.completed_on) || parseTimestampMs(b.created_at) || 0
    return bm - am
  })
  return list[0]
}

// -----------------------------------------------------------------------------
// Public API — pure verdict functions (§1)
// -----------------------------------------------------------------------------

/**
 * Resolves the applicability of a single requirement for a given
 * (child, provider) context. Pure.
 *
 * Resolution order (per parent scope §4):
 *   1. Explicit override (Phase 3 seam — empty in Phase 1).
 *   2. Regulatory-universal (`universalFor`) + optional `childGate`.
 *   3. Data-inferred (`inferFromData`).
 *   4. `autoDefault` (or `'unknown'`).
 *
 * §2a governs the fallback: any branch that can't affirmatively
 * classify resolves to `'unknown'`, never `'does_not_apply'`.
 */
export function resolveApplicability({
  requirement,
  child = null,
  provider = null,
  sourceRows = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!requirement || !requirement.applicability) {
    return APPLICABILITY_RESULT.UNKNOWN
  }
  const rule = requirement.applicability

  // 1. Explicit override (Phase 3 seam).
  if (overrides && typeof overrides.has === 'function' && overrides.has(requirement.key)) {
    const v = overrides.get(requirement.key)
    if (v === APPLICABILITY_RESULT.APPLIES || v === APPLICABILITY_RESULT.DOES_NOT_APPLY) {
      return v
    }
  }

  const nowDate = toDate(now)

  // 2. Regulatory-universal.
  if (rule.universalFor && Array.isArray(rule.universalFor)) {
    const license = provider && provider.license_type
    if (!license || !rule.universalFor.includes(license)) {
      return APPLICABILITY_RESULT.DOES_NOT_APPLY
    }
    if (typeof rule.childGate === 'function' && child) {
      const childResult = rule.childGate({ child, provider, sourceRows, now: nowDate })
      if (childResult === APPLICABILITY_RESULT.DOES_NOT_APPLY) return APPLICABILITY_RESULT.DOES_NOT_APPLY
      if (childResult === APPLICABILITY_RESULT.UNKNOWN) return APPLICABILITY_RESULT.UNKNOWN
      // childGate === APPLIES → fall through to autoDefault check (if any)
      // or to step 4. But for clarity: a universalFor + APPLIES childGate
      // means applies, unless autoDefault explicitly overrides.
    }
    // If autoDefault is set, it can downgrade APPLIES to UNKNOWN
    // (the §6 case where a row is universal in scope but provider input
    // is still needed — e.g., property_animal_notification: universal
    // for licensed homes, but autoDefault = unknown until Phase 3).
    if (rule.autoDefault === APPLICABILITY_RESULT.UNKNOWN) {
      return APPLICABILITY_RESULT.UNKNOWN
    }
    return APPLICABILITY_RESULT.APPLIES
  }

  // 3. Data-inferred.
  if (typeof rule.inferFromData === 'function') {
    const inferred = rule.inferFromData({ child, provider, sourceRows, now: nowDate })
    if (inferred === APPLICABILITY_RESULT.APPLIES || inferred === APPLICABILITY_RESULT.DOES_NOT_APPLY) {
      return inferred
    }
    // inferred === UNKNOWN — fall through to autoDefault.
  }

  // 4. Auto fallback or unknown.
  if (rule.autoDefault) return rule.autoDefault
  return APPLICABILITY_RESULT.UNKNOWN
}

/**
 * Pure verdict — returns the RequirementState for a single
 * requirement given the loaded source rows + context.
 *
 * Pipeline:
 *   1. Resolve applicability.
 *   2. If 'does_not_apply' → state = not_applicable.
 *   3. If 'unknown' → state = unknown (with reason: 'awaiting-provider-input').
 *   4. If 'applies' → call requirement.state_resolver(...).
 *
 * The state_resolver is ONLY called when applicability is 'applies'.
 * This is what enforces §2a's invariant — an `unknown` applicability
 * NEVER falls through to a state_resolver that might silently report
 * on_file (or anything else).
 */
export function getRequirementState({
  requirement,
  child = null,
  provider = null,
  sourceRows = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!requirement) {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'no-requirement-supplied' }
  }

  const applicability = resolveApplicability({ requirement, child, provider, sourceRows, overrides, now })

  if (applicability === APPLICABILITY_RESULT.DOES_NOT_APPLY) {
    return { kind: REQUIREMENT_STATE_KIND.NOT_APPLICABLE, reason: 'not-applicable-by-rule' }
  }

  if (applicability === APPLICABILITY_RESULT.UNKNOWN) {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'awaiting-provider-input' }
  }

  // applicability === APPLIES — defer to the row's state_resolver.
  const nowDate = toDate(now)
  if (typeof requirement.state_resolver !== 'function') {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'no-state-resolver' }
  }
  return requirement.state_resolver({ child, provider, sourceRows, now: nowDate })
}

// -----------------------------------------------------------------------------
// Rollups — per-child + per-provider
// -----------------------------------------------------------------------------

function emptyCategoryState() {
  return {
    requirements: [],
    applicable_count: 0,
    on_file_count: 0,
    expired_count: 0,
    missing_required_count: 0,
    pending_parent_count: 0,
    not_applicable_count: 0,
    unknown_count: 0,
  }
}

function emptyTotals() {
  return {
    applicable: 0,
    on_file: 0,
    expired: 0,
    missing_required: 0,
    pending_parent: 0,
    not_applicable: 0,
    unknown: 0,
  }
}

function tallyState(catState, totals, applicability, state) {
  catState.requirements.push({ applicability, state })
  if (applicability === APPLICABILITY_RESULT.APPLIES) {
    catState.applicable_count += 1
    totals.applicable += 1
  }
  switch (state.kind) {
    case REQUIREMENT_STATE_KIND.ON_FILE:          catState.on_file_count += 1;          totals.on_file += 1;          break
    case REQUIREMENT_STATE_KIND.EXPIRED:          catState.expired_count += 1;          totals.expired += 1;          break
    case REQUIREMENT_STATE_KIND.MISSING_REQUIRED: catState.missing_required_count += 1; totals.missing_required += 1; break
    case REQUIREMENT_STATE_KIND.PENDING_PARENT:   catState.pending_parent_count += 1;   totals.pending_parent += 1;   break
    case REQUIREMENT_STATE_KIND.NOT_APPLICABLE:   catState.not_applicable_count += 1;   totals.not_applicable += 1;   break
    case REQUIREMENT_STATE_KIND.UNKNOWN:          catState.unknown_count += 1;          totals.unknown += 1;          break
    default: break
  }
}

/**
 * Per-child rollup over the registry's child-subject requirements.
 */
export function getChildComplianceState({
  child,
  provider,
  sourceRows = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!child) return null

  const per_category = {}
  for (const c of CATEGORIES) per_category[c] = emptyCategoryState()
  const totals = emptyTotals()

  for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
    const req = REQUIREMENT_REGISTRY[key]
    if (req.subject_type !== 'child' && req.subject_type !== 'medication_authorization') continue
    // medication_authorization rows are scoped to the auths of THIS child.
    let childScopedSourceRows = sourceRows
    if (req.subject_type === 'medication_authorization') {
      const auths = (sourceRows.medication_authorizations || []).filter(a => a.child_id === child.id)
      childScopedSourceRows = { ...sourceRows, medication_authorizations: auths }
    }
    const applicability = resolveApplicability({ requirement: req, child, provider, sourceRows: childScopedSourceRows, overrides, now })
    const state = getRequirementState({ requirement: req, child, provider, sourceRows: childScopedSourceRows, overrides, now })
    const catState = per_category[req.category] || emptyCategoryState()
    per_category[req.category] = catState
    tallyState(catState, totals, applicability, { ...state, requirement_key: req.key })
  }

  const any_gap =
       totals.expired > 0
    || totals.missing_required > 0
    || totals.pending_parent > 0
  const any_unknown_input = totals.unknown > 0

  return {
    child_id: child.id,
    per_category,
    totals,
    any_gap,
    any_unknown_input,
  }
}

/**
 * Per-provider rollup. Aggregates per-child results PLUS the
 * provider-level requirements (drills, property, staff, miregistry,
 * funding_docs, cdc_compliance, attendance).
 */
export function getProviderComplianceState({
  provider,
  children = [],
  sourceRows = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!provider) return null

  // Per-child rollups.
  const per_child = children.map(child =>
    getChildComplianceState({ child, provider, sourceRows, overrides, now })
  )

  // Provider-level requirements.
  const provider_level = { per_category: {} }
  for (const c of CATEGORIES) provider_level.per_category[c] = emptyCategoryState()
  const providerTotals = emptyTotals()

  for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
    const req = REQUIREMENT_REGISTRY[key]
    if (req.subject_type !== 'provider' && req.subject_type !== 'caregiver' && req.subject_type !== 'funding_source' && req.subject_type !== 'attendance_day') {
      continue
    }
    const applicability = resolveApplicability({ requirement: req, child: null, provider, sourceRows, overrides, now })
    const state = getRequirementState({ requirement: req, child: null, provider, sourceRows, overrides, now })
    const catState = provider_level.per_category[req.category] || emptyCategoryState()
    provider_level.per_category[req.category] = catState
    tallyState(catState, providerTotals, applicability, { ...state, requirement_key: req.key })
  }

  // Aggregate totals: sum of per-child totals + provider-level totals.
  const totals = emptyTotals()
  for (const pc of per_child) {
    if (!pc) continue
    for (const k of Object.keys(totals)) totals[k] += pc.totals[k] || 0
  }
  for (const k of Object.keys(totals)) totals[k] += providerTotals[k] || 0

  return {
    provider_id: provider.id,
    per_child,
    provider_level,
    totals,
    any_gap:           totals.expired > 0 || totals.missing_required > 0 || totals.pending_parent > 0,
    any_unknown_input: totals.unknown > 0,
  }
}

// -----------------------------------------------------------------------------
// Misc exports for consumers / tests
// -----------------------------------------------------------------------------

/**
 * Defensive enum of `data_state` values. `shipped` = the source data
 * exists in production; `not_yet_modelled` = registered as catalog
 * entry but the source substrate isn't built yet (Pattern E).
 */
export const DATA_STATE = Object.freeze({
  SHIPPED:          'shipped',
  NOT_YET_MODELLED: 'not_yet_modelled',
})

/**
 * Total registry row count — exported for the test that locks the
 * expected catalog size (52 rows; row 19 deferred).
 */
export const REGISTRY_ROW_COUNT = Object.keys(REQUIREMENT_REGISTRY).length

/**
 * Per-occurrence consent types — re-exported for consumer convenience.
 */
export { PER_OCCURRENCE_CONSENT_TYPES }
