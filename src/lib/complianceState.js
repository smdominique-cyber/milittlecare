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
// staffTraining.js is pure (no Supabase imports — see its header), so
// unlike childFiles.js it is safe to import from this PURE module.
import { getEffectiveRequirements } from './staffTraining'
// PR #19 (mig 044) — drill schedule helpers. drillSchedule.js is pure
// (it wraps the pure reminderSchedule.js's nextOccurrence). The three
// drill registry rows use these summaries to resolve from drill_logs.
import {
  getFireDrillSummary,
  getTornadoDrillSummary,
  getOtherEmergencyDrillSummary,
} from './drillSchedule'

// Channel rule for parent-signed satisfaction. Duplicated from
// childFiles.js's PARENT_SIGNED_SATISFYING_CHANNELS rather than
// imported, because childFiles.js eagerly imports `./supabase` (it
// hosts the impure audit-state helper too), which would make this
// PURE module require Supabase env vars at import time and break
// downstream unit-test mocking. The two constants MUST stay in
// lockstep — if childFiles.js's set changes (e.g., a new channel
// added to PARENT_SIGNED_SATISFYING_CHANNELS), update here too.
// A third copy also lives in src/lib/medication.js for the same
// reason. The duplication is a tested invariant:
// complianceState.test.js's backward-compat smoke asserts that
// the engine treats every member of the satisfying set the same.
//
// Phase Y1 (2026-06-04): 'parent_portal_esign' added — the parent's
// typed-name signature with the snapshotted template body on the
// same acknowledgments row IS the parent's affirmative signature.
const PARENT_SIGNED_SATISFYING_CHANNELS = Object.freeze([
  'parent_portal',
  'in_person_paper',
  'parent_portal_esign',
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

/**
 * Resolver builder for rows backed by the compliance_documents store
 * (substrate from migration 038; document_type list extended by
 * migration 039; next_due_on column added by migration 040).
 *
 * Two modes, selected via `options.requiresDueDate`:
 *
 *   default (requiresDueDate=false) — used by fingerprint (G4) and
 *   licensing-notebook (J8). The row is satisfied by the EXISTENCE
 *   of a non-archived doc of the requested type. No freshness math.
 *
 *   cycle (requiresDueDate=true) — used by radon (J1) and heating
 *   (J2). The row reads `next_due_on` from the active doc and
 *   compares against today (UTC Y-M-D, lexicographic compare on
 *   ISO date strings — calendar-correct without timezone juggling).
 *     - next_due_on >= today → ON_FILE (expires_at = next_due_on).
 *       The == case is "due today still current" per the task's
 *       boundary rule.
 *     - next_due_on <  today → EXPIRED (expired_at = next_due_on).
 *     - next_due_on is NULL → MISSING_REQUIRED with reason
 *       'due-date-missing'. Pre-040 rows (uploaded before the
 *       column existed) and any future row whose write skipped
 *       the date land here — the engine never claims currency it
 *       can't see. Provider re-uploads via the slot to enter a
 *       date.
 *
 * Both modes honor the §2a load-failure guard: when
 * `sourceRowsLoaded.compliance_documents === false`, the resolver
 * returns UNKNOWN with reason 'compliance-documents-load-failure'
 * rather than reading the possibly-empty array as "no documents on
 * file."
 *
 * Used by the J1/J2/J8 property batch (2026-06-14). The G4
 * fingerprint resolver still reads `provider.fingerprint_date` (the
 * pre-substrate field); migrating G4's resolver to this builder is
 * a follow-up flagged in the batch's commit message.
 */
function buildComplianceDocResolver(documentType, options = {}) {
  const requiresDueDate = !!options.requiresDueDate
  return ({ sourceRows, sourceRowsLoaded, now }) => {
    if (sourceRowsLoaded && sourceRowsLoaded.compliance_documents === false) {
      return {
        kind: REQUIREMENT_STATE_KIND.UNKNOWN,
        reason: 'compliance-documents-load-failure',
      }
    }
    const docs = (sourceRows && sourceRows.compliance_documents) || []
    const active = docs.find(d => d && d.document_type === documentType && !d.archived_at)
    if (!active) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
    if (!requiresDueDate) return { kind: REQUIREMENT_STATE_KIND.ON_FILE }

    // Cycle branch. mig 040 added compliance_documents.next_due_on
    // as a nullable date the provider enters via the slot. The
    // resolver compares it as an ISO date string against today's
    // ISO date string — both UTC for tests to be deterministic
    // across timezones. The 1-day boundary skew vs local time is
    // negligible for a quadrennial cycle and keeps the compare
    // pure-string.
    const dueOn = active.next_due_on
    if (!dueOn) {
      return {
        kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED,
        reason: 'due-date-missing',
      }
    }
    const today = now || new Date()
    const todayYmd = today.toISOString().slice(0, 10)
    // dueOn is a PostgreSQL date which PostgREST returns as a YYYY-MM-DD
    // string; lexicographic compare of two ISO Y-M-D strings is
    // calendar-correct. >= keeps "due today" on the on-file side
    // (the task's explicit boundary rule).
    if (dueOn >= todayYmd) {
      return { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: dueOn }
    }
    return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: dueOn }
  }
}

/**
 * PR #19 (mig 044) — resolver builder for the three drill compliance
 * rows. Reads sourceRows.drill_logs and computes state via
 * src/lib/drillSchedule.js, which itself wraps the pure
 * src/lib/reminderSchedule.js nextOccurrence helper that the
 * reminder system already uses. Both sides feed the SAME rule
 * shapes through the SAME helper, so compliance and reminder
 * due-dates cannot drift; the consistency test net in
 * drillSchedule.test.js pins this.
 *
 * §2a load-failure guard: if sourceRowsLoaded.drill_logs === false,
 * return UNKNOWN with reason 'drill-logs-load-failure' rather than
 * silently MISSING_REQUIRED. Mirrors buildComplianceDocResolver.
 *
 * @param {'fire' | 'tornado' | 'other_emergency'} kind
 * @returns {(ctx: { sourceRows, sourceRowsLoaded, now }) => RequirementState}
 */
function buildDrillResolver(kind) {
  return ({ sourceRows, sourceRowsLoaded, now }) => {
    if (sourceRowsLoaded && sourceRowsLoaded.drill_logs === false) {
      return {
        kind: REQUIREMENT_STATE_KIND.UNKNOWN,
        reason: 'drill-logs-load-failure',
      }
    }
    const drillLogs = (sourceRows && sourceRows.drill_logs) || []
    const today = now || new Date()
    const todayYmd = today.toISOString().slice(0, 10)

    if (kind === 'fire') {
      const summary = getFireDrillSummary({ drillLogs, today: todayYmd })
      if (!summary.hasAny) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
      const dueOn = summary.nextDueOn
      if (!dueOn || dueOn >= todayYmd) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: dueOn }
      }
      return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: dueOn }
    }

    if (kind === 'tornado') {
      const summary = getTornadoDrillSummary({ drillLogs, today: todayYmd })
      // Per the spec: row is satisfied when 2 drills are logged in the
      // current Mar-Nov window. Otherwise surfaces as due/incomplete.
      if (summary.satisfiedForCurrentYear) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      }
      // Year incomplete. nextDueOn === null AND not satisfied means the
      // window has closed for the year — explicit EXPIRED so the row
      // reads loudly. nextDueOn !== null (today, or window-start) means
      // there is still a way to satisfy → MISSING_REQUIRED.
      if (summary.nextDueOn === null) {
        return { kind: REQUIREMENT_STATE_KIND.EXPIRED }
      }
      return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
    }

    if (kind === 'other_emergency') {
      const summary = getOtherEmergencyDrillSummary({ drillLogs, today: todayYmd })
      if (!summary.hasAny) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED }
      const dueOn = summary.nextDueOn
      if (!dueOn || dueOn >= todayYmd) {
        return { kind: REQUIREMENT_STATE_KIND.ON_FILE, expires_at: dueOn }
      }
      return { kind: REQUIREMENT_STATE_KIND.EXPIRED, expired_at: dueOn }
    }

    // Defensive — unknown kind never silently passes.
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'unknown-drill-kind' }
  }
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
    // Verified against the 2026 Family/Group Home TA Manual (May 2026)
    // and CCL-3900. Lead-paint disclosure is both an intake-disclosure
    // requirement (R 400.1907(1)(b)(vi)) AND a substantive lead-safety
    // duty (R 400.1932(7)).
    rule_citation: 'R 400.1907(1)(b)(vi) AND R 400.1932(7)',
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
    // 2026-06-18 — citation corrected. The intake-disclosure obligation
    // is R 400.1907(1)(b); the substantive firearms rule under the
    // 2026 manual (R 400.1901-1963, eff April 27 2026, 2026 MR 8) is
    // R 400.1916 (Firearms). The pre-correction "R 400.1935(1)-(2)"
    // was wrong: R 400.1935 is "Diapering and toilet learning" in the
    // 2026 numbering, per docs/regulatory-rule-mapping.md. The
    // user-visible guidance copy already cites R 400.1916 — this fix
    // brings the registry citation in line with the displayed copy.
    rule_citation: 'R 400.1907(1)(b) AND R 400.1916',
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
    // Verified against the 2026 Family/Group Home TA Manual (May 2026).
    // Pre-Pass-2: was '(1)(b)(i)' — A8/A9 had been transposed; the
    // child health-condition disclosure is the (ii) sub-clause, the
    // discipline-policy receipt is the (i) sub-clause.
    rule_citation: 'R 400.1907(1)(b)(ii)',
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
    // Verified against the 2026 Family/Group Home TA Manual (May 2026).
    // Pre-Pass-2: was '(1)(b)(iv)' — A8/A9 had been transposed; the
    // discipline-policy receipt is the (i) sub-clause.
    rule_citation: 'R 400.1907(1)(b)(i)',
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
    // Verified against the 2026 Family/Group Home TA Manual (May 2026).
    // The three accepted statuses below correspond to R 400.1907(1)(c)(i),
    // (ii), and (iii) — completed / in progress / waiver. "in progress"
    // IS an accepted status; the VALID set preserves all three.
    rule_citation: 'R 400.1907(1)(c)',
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
    rule_citation: 'R 400.1952(1)',
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
      inferFromData: ({ child, sourceRows, sourceRowsLoaded, now }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        // §2a loader-shape guard (2026-06-09). If the acks table
        // failed to load, "no per-trip ack" is indistinguishable from
        // "load failed" — we can't safely conclude does_not_apply.
        if (sourceRowsLoaded && sourceRowsLoaded.acks === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
      inferFromData: ({ child, sourceRows, sourceRowsLoaded, now }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        // §2a loader-shape guard. Same shape as C4 above.
        if (sourceRowsLoaded && sourceRowsLoaded.acks === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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

  // ─── medication (5) ──────────────────────────────────────────────

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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard. "No auths" is indistinguishable
        // from "load failed" without the sibling signal.
        if (sourceRowsLoaded && sourceRowsLoaded.medication_authorizations === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard.
        if (sourceRowsLoaded && sourceRowsLoaded.medication_authorizations === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
      inferFromData: ({ child, sourceRows, sourceRowsLoaded }) => {
        if (!child) return APPLICABILITY_RESULT.UNKNOWN
        // §2a loader-shape guard.
        if (sourceRowsLoaded && sourceRowsLoaded.medication_authorizations === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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

  // medication_role_gate_integrity (D4) RETIRED 2026-06-10. R 400.1931(1)
  // is enforced at entry instead of detected after the fact: the
  // administered-by dropdown filters to eligible roles
  // (eligibleCaregiversForAdministration, src/lib/medication.js) AND the
  // DB trigger medication_event_caregiver_role_check() blocks ineligible
  // INSERTs (migration 028). The detection row evaluated doses against
  // caregivers' CURRENT roles, so a dose that was legal when administered
  // would read as a critical violation after a later role reclassification
  // — a false positive with no role-history table to fix it honestly.

  medication_original_container_attestation: Object.freeze({
    key: 'medication_original_container_attestation',
    category: 'medication',
    // Verified against the 2026 Family/Group Home TA Manual (May 2026).
    // R 400.1931(3) is the original-container + storage + named-child
    // labeling rule; (4) is the prescription-specific addition of the
    // pharmacy label (physician name, child's name, instructions,
    // strength). Cite both since this attestation covers both.
    rule_citation: 'R 400.1931(3)+(4)',
    label: 'Original container attestation (per non-OTC authorization)',
    subject_type: 'medication_authorization',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard.
        if (sourceRowsLoaded && sourceRowsLoaded.medication_authorizations === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard. Mirrors D4 — BOTH tables are
        // precondition; "no non-OTC events" is unsound when either
        // half failed to load.
        if (sourceRowsLoaded && (
             sourceRowsLoaded.medication_admin_events    === false
          || sourceRowsLoaded.medication_authorizations  === false
        )) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
    state_resolver: ({ sourceRows, sourceRowsLoaded }) => {
      // §2a load-failure guards (before the empty-checks, so genuine
      // empties keep their current behavior).
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && sourceRowsLoaded.staff_training_records === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'staff-training-records-load-failure' }
      }
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
    state_resolver: ({ sourceRows, sourceRowsLoaded, now }) => {
      // §2a load-failure guards.
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && sourceRowsLoaded.staff_training_records === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'staff-training-records-load-failure' }
      }
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
    state_resolver: ({ sourceRows, sourceRowsLoaded, now }) => {
      // §2a load-failure guards.
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && sourceRowsLoaded.staff_training_records === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'staff-training-records-load-failure' }
      }
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
    state_resolver: ({ sourceRows, sourceRowsLoaded }) => {
      // §2a load-failure guards.
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && sourceRowsLoaded.staff_training_records === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'staff-training-records-load-failure' }
      }
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
    state_resolver: ({ sourceRows, sourceRowsLoaded, now }) => {
      // Role-based annual minima per R 400.1924(1)-(4), read from the
      // training_requirements catalog (migration 013) through the same
      // strictest-wins rollup the staff-training matrix uses
      // (getEffectiveRequirements, staff_training_tracking_spec § 6.3).
      // Replaces the Phase 1 flat 16-hour placeholder, which matched
      // none of the licensing minima (licensee 10 / personnel 5 /
      // volunteer 1 / driver 1).
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && (
           sourceRowsLoaded.staff_training_records === false
        || sourceRowsLoaded.training_requirements  === false
      )) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'training-data-load-failure' }
      }
      const caregivers = (sourceRows.caregivers || []).filter(c => !c.archived_at)
      if (caregivers.length === 0) return { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: 'no-active-caregivers' }
      const catalog = sourceRows.training_requirements || []
      if (!catalog.some(r => r && r.category === 'professional_development')) {
        // The catalog is statewide seed data (migration 013). Without
        // it no caregiver's minimum is determinable — never silently
        // pass (§2a asymmetry).
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'training-requirements-catalog-empty' }
      }
      const records = (sourceRows.staff_training_records || [])
        .filter(r => r.category === 'professional_development')
      const year = now.getUTCFullYear()
      const yearStartMs = Date.UTC(year, 0, 1)
      let worst = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
      const rank = { on_file: 0, missing_required: 1, expired: 2, unknown: 3 }
      for (const c of caregivers) {
        const roleNames = (c.regulatory_roles || []).filter(Boolean)
        let state
        if (roleNames.length === 0) {
          // No regulatory roles recorded — the minimum is
          // undeterminable. Provider-fixable on the Staff page
          // (NEEDS_PROVIDER_DATA_REASONS); never silently pass.
          state = { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'no-regulatory-roles' }
        } else {
          const effective = getEffectiveRequirements({
            regulatoryRoles: roleNames.map(role => ({ regulatory_role: role })),
            requirements: catalog,
          })
          const pd = effective.get('professional_development')
          const requiredHours = pd && pd.requiredHours != null ? Number(pd.requiredHours) : null
          if (requiredHours == null) {
            // Roles recorded, but none carries an hour requirement in
            // the catalog (supervised_volunteer — the adopted rules
            // are silent, spec § 6.2/§ 7.3). Affirmatively no PD
            // obligation for this caregiver. No reason string: passing
            // states never emit reasons, and worst-across aggregation
            // would drop it anyway (ties never replace the seed).
            state = { kind: REQUIREMENT_STATE_KIND.ON_FILE }
          } else {
            const total = records
              .filter(r => r.caregiver_id === c.id && (parseTimestampMs(r.completed_on) || 0) >= yearStartMs)
              .reduce((sum, r) => sum + (Number(r.hours) || 0), 0)
            state = total >= requiredHours
              ? { kind: REQUIREMENT_STATE_KIND.ON_FILE }
              : { kind: REQUIREMENT_STATE_KIND.MISSING_REQUIRED, reason: `hours-${total}-of-${requiredHours}` }
          }
        }
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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard.
        if (sourceRowsLoaded && sourceRowsLoaded.health_safety_updates === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
        const updates = sourceRows.health_safety_updates || []
        return updates.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, sourceRowsLoaded }) => {
      // §2a load-failure guards. caregivers especially: the empty-check
      // below collapses to NOT_APPLICABLE, so a failed caregivers load
      // would silently vanish this row (the dangerous false pass).
      if (sourceRowsLoaded && sourceRowsLoaded.caregivers === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'caregivers-load-failure' }
      }
      if (sourceRowsLoaded && sourceRowsLoaded.staff_training_records === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'staff-training-records-load-failure' }
      }
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
    // Staff-file copy filed under R 400.1906(1)(c).
    rule_citation: 'R 400.1933(1)-(2)',
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
    // Was 'R 400.1923' — that's the new-hire training rule, NOT the
    // staff discipline policy acknowledgment. Corrected 2026-06-06
    // per Seth's verification pass against the 2026 sources. The
    // staff acknowledgment of the home's discipline policy at hire
    // is governed by R 400.1906(1)(e)(iii); the rule on which the
    // PR #17 capture surface will be built.
    rule_citation: 'R 400.1906(1)(e)(iii)',
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
    rule_citation: 'CDC Scholarship Handbook for LEP — Annual Ongoing Health & Safety Training (Dec 16 deadline)',
    label: 'MiRegistry annual ongoing training (Dec 16 deadline)',
    subject_type: 'provider',
    data_authority: 'miregistry',  // Type 1 — verify in MiRegistry
    gsq_relevant: false,
    severity: 'critical',
    data_state: 'shipped',
    // FIRST-YEAR LEP NUANCE (2026-06-06 CDC-layer correctness pass
    // Part 3). The obligation begins the calendar year AFTER
    // enrollment/reenrollment — a brand-new LEP is not subject to
    // the Dec 16 deadline in their first partial year. The engine
    // CANNOT precisely identify first-year LEPs today: no field on
    // `profiles` records the LEP enrollment date with MDHHS, and
    // `profile.created_at` is when the MILittleCare account was
    // created (a long-time LEP who joined MILC last week would
    // falsely read as "first year"). Two paths forward, neither
    // taken in this pass:
    //   - Add `profiles.lep_enrollment_calendar_year` via a future
    //     migration + a Business Info question; the applicability
    //     here would then compare it to the current year.
    //   - Render the nuance in the in-app GUIDANCE COPY only ("If
    //     you enrolled this calendar year, the Dec 16 deadline
    //     begins next year — verify against your records"). The
    //     consultant worksheet entry for F1 documents this; the
    //     guidance content map (Phase 3.1) will carry it.
    // The applicability below stays LEP-gated; the first-year case
    // is handled in guidance, not in engine state, until a
    // migration is approved.
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
    state_resolver: ({ sourceRows, sourceRowsLoaded, now }) => {
      // §2a load-failure guard: a failed load must not read as a
      // missed Dec-16 deadline (the scariest false red for an LEP).
      if (sourceRowsLoaded && sourceRowsLoaded.miregistry_training_entries === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'miregistry-training-entries-load-failure' }
      }
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
    rule_citation: 'CDC Scholarship Handbook for LEP (Level 2 pay-rate tier)',
    label: 'MiRegistry Level 2 currency (advisory — pay-rate tier)',
    subject_type: 'provider',
    data_authority: 'miregistry',  // Type 1
    gsq_relevant: false,
    // ADVISORY, not a compliance delinquency. Level 2 is OPTIONAL —
    // an LEP earns the higher pay tier by completing 10 approved
    // training hours/year. When the Level 2 clock "expires," the
    // consequence is the provider DROPS TO THE LEVEL 1 (base) PAY
    // RATE — they have NOT fallen out of compliance, the CDC
    // account is NOT closed, and they are NOT in violation. The
    // engine doesn't have an explicit `advisory` state kind today;
    // the closest existing knob is severity, so this row uses
    // severity='low' to render in the subtle/link-style treatment
    // per the Phase 3.1 component contract (§1) rather than the
    // amber/red of a real delinquency. Re-cited 2026-06-06 from
    // "LEP Handbook p.13" to the CDC Scholarship Handbook framing
    // because the obligation is CDC-pay-rate-tier, not a
    // licensing/compliance rule.
    //
    // If a future engine pass adds an explicit `informational` /
    // `advisory` state kind, this row should adopt it.
    severity: 'low',
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

  // funding_dhs_198_on_file — REMOVED 2026-06-06 per the CDC-layer
  // correctness pass (docs/Compliance Corrections.md Part 2). The
  // DHS-198 is MDHHS's authorization NOTICE TO the provider, not a
  // document the provider fills out, signs, or uploads — it's an
  // INPUT they receive, not an obligation they fulfill, so it never
  // belonged on a compliance checklist. The funding-document vault
  // feature (migration 008 + FundingDocumentSlot UI + funding-docs
  // reminder catalog rows) still ships and remains valuable; it just
  // doesn't surface as a compliance-checklist requirement.

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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard. The CDC-funding-source presence
        // determines whether this licensed CDC-billing-basis row
        // applies; if funding_sources failed to load, "no CDC sources"
        // is indistinguishable from a load failure.
        if (sourceRowsLoaded && sourceRowsLoaded.funding_sources === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
        const fs = (sourceRows.funding_sources || []).filter(f =>
             !f.archived_at
          && f.type === 'cdc_scholarship'
          && f.details && f.details.billing_basis === 'enrollment'
        )
        return fs.length > 0 ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, sourceRowsLoaded, now }) => {
      // §2a load-failure guard: a failed funding_documents load would
      // read every enrollment-basis source as missing its agreement.
      if (sourceRowsLoaded && sourceRowsLoaded.funding_documents === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'funding-documents-load-failure' }
      }
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
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard.
        if (sourceRowsLoaded && sourceRowsLoaded.funding_sources === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
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
    rule_citation: 'CDC Scholarship Handbook (5-year cycle, all CDC providers)',
    label: 'CDC fingerprint reprint currency (5-year cycle)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    data_state: 'shipped',
    applicability: {
      // CORRECTED 2026-06-06 per CDC-layer correctness pass Part 6.
      // Pre-correction: this row was LEP-only. That was wrong — per
      // the CDC Scholarship Handbook, all CDC providers/staff/household
      // members fingerprinted prior to April 2024 need a 5-year
      // re-fingerprint. Licensed Family/Group Home providers with CDC
      // are equally subject; the rule is CDC-tied, not LEP-tied. The
      // applicability below now gates on CDC enrollment only (plus
      // license-status being answered, otherwise unknown).
      inferFromData: ({ provider, sourceRows, sourceRowsLoaded }) => {
        if (!provider) return APPLICABILITY_RESULT.UNKNOWN
        // license_type AND is_license_exempt are both unanswered →
        // we can't tell whether this provider exists in a context
        // where the obligation applies. §2a: unknown, never silent
        // does_not_apply.
        const licenseStatusAnswered =
             provider.license_type != null
          || provider.is_license_exempt === true
          || provider.is_license_exempt === false
        if (!licenseStatusAnswered) return APPLICABILITY_RESULT.UNKNOWN
        // §2a loader-shape guard. License status is answered; the
        // remaining gate is "does this provider have CDC?" — which
        // depends on funding_sources loading cleanly.
        if (sourceRowsLoaded && sourceRowsLoaded.funding_sources === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
        const hasCdc = (sourceRows.funding_sources || []).some(f => !f.archived_at && f.type === 'cdc_scholarship')
        return hasCdc ? APPLICABILITY_RESULT.APPLIES : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    // 2026-06-14: closes the G4 resolver loop. The pre-038 resolver
    // read provider.fingerprint_date and emitted MISSING_REQUIRED /
    // ON_FILE / EXPIRED off a 5-year cycle. Migration 038 + the
    // ComplianceDocumentSlot on Business Info → Licensing introduced
    // an upload that writes compliance_documents, but the resolver
    // was never moved over — so uploading a fingerprint receipt
    // didn't actually flip the row. (Flagged as a known follow-up in
    // the J1/J2/J8 batch commit on 2026-06-14.)
    //
    // Plain-mode swap per the task brief: the slot doesn't capture a
    // next-due date today, so the resolver checks existence only.
    // ON_FILE when a non-archived fingerprint_reprint doc exists,
    // MISSING_REQUIRED otherwise, UNKNOWN under the §2a guard. The
    // EXPIRED / 'unparseable-fingerprint-date' / expiring_soon paths
    // the legacy resolver carried are intentionally dropped here;
    // re-adding 5-year cycle tracking is a separate piece of work
    // (mig 040's requiresDueDate option is the obvious extension
    // point when a date capture lands on the fingerprint slot).
    state_resolver: buildComplianceDocResolver('fingerprint_reprint'),
  }),

  // ─── attendance (1) ──────────────────────────────────────────────

  attendance_parent_acknowledgment_per_day: Object.freeze({
    key: 'attendance_parent_acknowledgment_per_day',
    category: 'attendance',
    // CDC subsidy audit trail, not a R 400 licensing requirement
    // (re-cited 2026-06-06 from 'R 400.1906' per the Phase 3.1
    // consultant-worksheet H1 question + the CDC-subsidy-layer
    // gating audit). The daily-parent-ack obligation derives from
    // MDHHS's CDC billing audit-trail expectations; it does NOT
    // apply to private-pay-only families or to LEPs / licensed homes
    // who have no children on CDC. Gating below now mirrors the
    // existing G1/G2/G3/G4 CDC-funding-source pattern.
    rule_citation: 'CDC Handbook (daily attendance audit trail)',
    label: 'Daily attendance parent acknowledgment',
    subject_type: 'attendance_day',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    data_state: 'shipped',
    applicability: {
      // Gate on existence of ≥1 active CDC funding source. The
      // CDC-subsidy-layer audit (2026-06-06) found H1 was the only
      // CDC-derived requirement that wasn't CDC-gated — every other
      // CDC row (G1-G4) already filters funding_sources by
      // type='cdc_scholarship'. With this change H1 joins them and
      // becomes does_not_apply for private-pay-only providers.
      //
      // §2a posture: the absence-of-data case (no funding_sources
      // rows at all) collapses to DOES_NOT_APPLY here, matching
      // G1/G2/G3 verbatim. A provider who hasn't entered ANY funding
      // sources reads as "no CDC kids" — affirmative, not unknown —
      // because the funding-source-entry surface in Families is the
      // single capture point and absence IS the answer. (This
      // engine-wide loader-default behavior is consistent across
      // all four CDC rows; if §2a tightening is wanted, do it once
      // across all four.)
      inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
        // §2a loader-shape guard (2026-06-09). Same shape as G2/G3/G4
        // above. The H1-specific comment block immediately above
        // notes the legacy "absence-of-data → DOES_NOT_APPLY" path
        // and flags it for §2a tightening "once across all four";
        // this is that tightening.
        if (sourceRowsLoaded && sourceRowsLoaded.funding_sources === false) {
          return APPLICABILITY_RESULT.UNKNOWN
        }
        const cdcSources = (sourceRows.funding_sources || [])
          .filter(f => !f.archived_at && f.type === 'cdc_scholarship')
        return cdcSources.length > 0
          ? APPLICABILITY_RESULT.APPLIES
          : APPLICABILITY_RESULT.DOES_NOT_APPLY
      },
    },
    state_resolver: ({ sourceRows, sourceRowsLoaded }) => {
      // §2a load-failure guard. The empty-check below collapses to
      // NOT_APPLICABLE, so a failed attendance_acks load would
      // silently vanish this row from a CDC provider's checklist
      // (the dangerous false pass).
      if (sourceRowsLoaded && sourceRowsLoaded.attendance_acks === false) {
        return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'attendance-acks-load-failure' }
      }
      // Per-child filter: only attendance acks for children on an
      // active CDC funding source count toward the verdict. Private-
      // pay children's attendance acks don't move this requirement's
      // needle even when present.
      //
      // funding_sources.child_id is the hybrid-FK target for every
      // non-private-pay type per migration 003 lines 71-103 (CHECK
      // constraint: type='cdc_scholarship' → child_id NOT NULL +
      // family_id NULL). Confirmed via grep against
      // supabase/migrations/003_funding_sources.sql before this edit.
      const cdcChildIds = new Set(
        (sourceRows.funding_sources || [])
          .filter(f => !f.archived_at && f.type === 'cdc_scholarship')
          .map(f => f.child_id)
          .filter(Boolean)
      )
      const acks = (sourceRows.attendance_acks || []).filter(a =>
           !a.archived_at
        && cdcChildIds.has(a.child_id)
      )
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
    // 2026-06-17 PR #19 (mig 044): flipped from 'not_yet_modelled' to
    // 'shipped'; resolver reads drill_logs and computes next-due via
    // src/lib/drillSchedule.js → src/lib/reminderSchedule.js
    // nextOccurrence (every_n_months, intervalMonths: 3). The
    // consistency test net in drillSchedule.test.js pins that
    // compliance + reminder due-dates can't drift.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildDrillResolver('fire'),
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
    // 2026-06-17 PR #19 (mig 044): seasonal_window mode — 2 drills in
    // current Mar-Nov window → ON_FILE; <2 with window open or
    // upcoming → MISSING_REQUIRED; <2 with window closed for the year
    // → EXPIRED.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildDrillResolver('tornado'),
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
    // 2026-06-17 PR #19 (mig 044): annual mode. Lockdown,
    // shelter_in_place, reunification, or 'other' subtype any of which
    // satisfies the rule. Latest log + 1 year = next due.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildDrillResolver('other_emergency'),
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
    // 2026-06-17 PR #19 (mig 044): the ERP is a written document.
    // Uses the existing compliance_documents substrate (same as
    // radon, heating, notebook, and the PR #21 inventory batch).
    // The three drill rows above use drill_logs (different substrate).
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('emergency_response_plan'),
  }),

  // ─── property (8 — Pattern E) ────────────────────────────────────

  property_radon_test_quadrennial: Object.freeze({
    key: 'property_radon_test_quadrennial',
    category: 'property',
    // 2026-06-18 — citation corrected against the 2026 manual
    // (R 400.1901-1963, eff April 27 2026, 2026 MR 8). The radon test
    // cadence is R 400.1915(4); R 400.1915(5) sets the 4 pCi/L
    // standard and (6) covers mitigation / the 12-month retest. The
    // pre-correction blend "R 400.1934/1932" carried forward a Phase 1
    // placeholder — R 400.1934 is now water hazards and R 400.1932 is
    // biocontaminants in the 2026 numbering (see
    // docs/regulatory-rule-mapping.md). Radon lives in Rule 15 with
    // heating/ventilation/lighting.
    rule_citation: 'R 400.1915(4)',
    label: 'Radon test (every 4 years)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    // 2026-06-14 batch (mig 038/039): flipped from 'not_yet_modelled'
    // to 'shipped'; resolver reads compliance_documents.
    // mig 040 followup: now cycle-aware. The provider enters the
    // next-due date directly via the slot; the resolver does a
    // straight today-vs-due compare. Replace flow rotates the
    // doc — the new row carries the new next_due_on the provider
    // attests to.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_radon_test', { requiresDueDate: true }),
  }),

  property_heating_inspection_quadrennial: Object.freeze({
    key: 'property_heating_inspection_quadrennial',
    category: 'property',
    // 2026-06-18 — citation corrected against the 2026 manual. The
    // heating-equipment inspection requirement is R 400.1945(4); the
    // every-4-years-at-license-renewal cadence is R 400.1945(5). Rule
    // 45 (R 400.1945) is "Heat-producing equipment" — distinct from
    // R 400.1915 (heating/ventilation/lighting/radon) where general
    // heating safety lives. The pre-correction "R 400.1932" was wrong:
    // R 400.1932 is biocontaminants in the 2026 numbering. See
    // docs/regulatory-rule-mapping.md.
    rule_citation: 'R 400.1945(4)-(5)',
    label: 'Heating equipment inspection (every 4 years)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'high',
    // 2026-06-14 batch: see radon for the same migration. mig 040
    // followup: cycle-aware same as radon.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_heating_inspection', { requiresDueDate: true }),
  }),

  property_co_detectors_per_level: Object.freeze({
    key: 'property_co_detectors_per_level',
    // 2026-06-17 — citation corrected. The blanket 'R 400.1934'
    // citation in the pre-2026-06-17 row was an artifact of seven
    // property rows all sharing the same placeholder during Phase 1
    // scaffolding. Initial correction attempt cited 'R 400.1934(3)'
    // (assuming CO was a subrule of the water-hazards rule); the
    // real rule is R 400.1915(3) — 'Heating; ventilation; lighting;
    // radon' subrule (3) requires an operational carbon-monoxide
    // detector bearing a recognized-laboratory safety mark on all
    // levels approved for child care. The ruleset groups CO with
    // its hazard source (combustion / heating) rather than with
    // smoke + fire detectors. R 400.1948 is detectors-and-
    // extinguishers and applies to smoke + fire only.
    rule_citation: 'R 400.1915(3)',
    category: 'property',
    label: 'Carbon-monoxide detectors per level',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    // 2026-06-17 PR #21 inventory batch (mig 043): flipped from
    // 'not_yet_modelled' to 'shipped'; resolver reads compliance_documents
    // of type 'property_co_detectors_per_level'.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_co_detectors_per_level'),
  }),

  property_smoke_detectors_per_floor: Object.freeze({
    key: 'property_smoke_detectors_per_floor',
    // 2026-06-17 — citation corrected from 'R 400.1934' (water hazards)
    // to 'R 400.1948' (the smoke detectors + fire extinguishers rule).
    // 2026-06-18 — narrowed to R 400.1948(1) (the smoke-detectors-per-
    // floor subrule). R 400.1948(3) is the fire-extinguisher-per-floor
    // subrule, which the sibling row cites. The pinning test below
    // asserts smoke ≠ extinguisher subrule. See
    // docs/regulatory-rule-mapping.md.
    rule_citation: 'R 400.1948(1)',
    category: 'property',
    label: 'Smoke detectors per floor',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    // 2026-06-17 PR #21 inventory batch (mig 043).
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_smoke_detectors_per_floor'),
  }),

  property_fire_extinguishers_per_floor: Object.freeze({
    key: 'property_fire_extinguishers_per_floor',
    // 2026-06-17 — citation corrected from 'R 400.1934' (water hazards)
    // to 'R 400.1948' (the smoke detectors + fire extinguishers rule).
    // 2026-06-18 — narrowed to R 400.1948(3) (the fire-extinguisher-
    // 2A-10BC-per-floor subrule). R 400.1948(1) is the smoke-detectors
    // subrule, which the sibling row cites. See
    // docs/regulatory-rule-mapping.md.
    rule_citation: 'R 400.1948(3)',
    category: 'property',
    label: 'Fire extinguishers per floor (2A-10BC+)',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'critical',
    // 2026-06-17 PR #21 inventory batch (mig 043).
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_fire_extinguishers_per_floor'),
  }),

  property_animal_notification: Object.freeze({
    key: 'property_animal_notification',
    // 2026-06-17 — citation corrected from 'R 400.1937' (food allergy
    // plan, the WRONG rule) to 'R 400.1917' (animals and pets, per
    // docs/regulatory-rule-mapping.md and user directive). The food-
    // allergy rule cross-pollinated into this row during Phase 1
    // scaffolding; correcting before any provider has acted on it.
    rule_citation: 'R 400.1917',
    category: 'property',
    label: 'Animal/pet notification to parents',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'low',
    // 2026-06-17 PR #21 inventory batch (mig 043). The applicability
    // autoDefault below stays as UNKNOWN per §2a — the row reaches
    // the resolver only once the provider answers "do you have
    // animals?" YES on the What-applies questionnaire. If they
    // answer NO, applicability resolves to does_not_apply; if YES,
    // the resolver looks for a 'property_animal_notification' doc.
    data_state: 'shipped',
    applicability: {
      // §2a: default unknown until Phase 3 onboarding resolves.
      universalFor: LICENSED_HOME_LICENSE_TYPES,
      autoDefault: APPLICABILITY_RESULT.UNKNOWN,
    },
    state_resolver: buildComplianceDocResolver('property_animal_notification'),
  }),

  property_smoking_prohibition_posted: Object.freeze({
    key: 'property_smoking_prohibition_posted',
    // 2026-06-17 — citation corrected from 'R 400.1934' (water hazards)
    // to 'R 400.1918' (smoking or vaping, per docs/regulatory-rule-
    // mapping.md and user directive).
    rule_citation: 'R 400.1918',
    category: 'property',
    label: 'Smoking prohibition posted',
    subject_type: 'provider',
    data_authority: 'milittlecare',
    gsq_relevant: false,
    severity: 'medium',
    // 2026-06-17 PR #21 inventory batch (mig 043).
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_smoking_prohibition_posted'),
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
    // 2026-06-14 batch: flipped to 'shipped' alongside radon +
    // heating. The notebook archive is a single replace-as-needed
    // PDF; no cycle-tracking required.
    data_state: 'shipped',
    applicability: { universalFor: LICENSED_HOME_LICENSE_TYPES },
    state_resolver: buildComplianceDocResolver('property_licensing_notebook'),
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
  // §2a loader-shape change (2026-06-09). Sibling signal indicating
  // which sourceRows tables loaded cleanly vs. failed. Currently five
  // tables opt in via the loader: funding_sources,
  // medication_authorizations, medication_admin_events, acks,
  // health_safety_updates. Resolvers for those tables' twelve
  // §2a-violating rows read this to return UNKNOWN on
  // `sourceRowsLoaded[<table>] === false` instead of silently
  // resolving to DOES_NOT_APPLY. Resolvers that don't read it behave
  // exactly as before (`undefined !== false`). Defaults to `{}`,
  // which preserves pre-fix behavior across the board.
  // See docs/pr-compliance-loader-shape-scope.md.
  sourceRowsLoaded = {},
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
    const inferred = rule.inferFromData({ child, provider, sourceRows, sourceRowsLoaded, now: nowDate })
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
  sourceRowsLoaded = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!requirement) {
    return { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason: 'no-requirement-supplied' }
  }

  const applicability = resolveApplicability({ requirement, child, provider, sourceRows, sourceRowsLoaded, overrides, now })

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
  return requirement.state_resolver({ child, provider, sourceRows, sourceRowsLoaded, now: nowDate })
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
  sourceRowsLoaded = {},
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
    const applicability = resolveApplicability({ requirement: req, child, provider, sourceRows: childScopedSourceRows, sourceRowsLoaded, overrides, now })
    const state = getRequirementState({ requirement: req, child, provider, sourceRows: childScopedSourceRows, sourceRowsLoaded, overrides, now })
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
  sourceRowsLoaded = {},
  overrides = new Map(),
  now = new Date(),
} = {}) {
  if (!provider) return null

  // Per-child rollups.
  const per_child = children.map(child =>
    getChildComplianceState({ child, provider, sourceRows, sourceRowsLoaded, overrides, now })
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
    const applicability = resolveApplicability({ requirement: req, child: null, provider, sourceRows, sourceRowsLoaded, overrides, now })
    const state = getRequirementState({ requirement: req, child: null, provider, sourceRows, sourceRowsLoaded, overrides, now })
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

// -----------------------------------------------------------------------------
// Phase 3 — pure projection helpers (§1 of phase-3 scope doc).
//
// These are PROJECTIONS over the existing engine output. They do NOT
// change the engine API, the registry, or the resolver. Each is pure;
// the consumer composes them as needed.
// -----------------------------------------------------------------------------

/**
 * Reasons that mean "a record exists but is missing a field the
 * provider can supply themselves." These map to the
 * `needs_provider_data` bucket — actionable copy, NOT
 * "contact support." Added 2026-06-05 from a Phase 3 live-gate
 * finding: the staff "New-hire 14-topic training" row showed up
 * as "Data anomaly — please contact support" with reason code
 * `caregiver-missing-date-of-hire`, when the provider could just
 * add the hire date.
 *
 * Frozen list — every entry added here must have matching
 * actionable copy in the consumer (ChecklistRow.jsx); a reason
 * with no copy fallback would still surface the generic
 * needs_provider_data message, but the explicit map keeps the
 * intent legible.
 *
 * If a future engine addition emits a new self-fixable reason
 * code, add it here AND add the copy in ChecklistRow's
 * NEEDS_PROVIDER_DATA_COPY map.
 */
export const NEEDS_PROVIDER_DATA_REASONS = Object.freeze(new Set([
  'caregiver-missing-date-of-hire',
  'no-authorization-end-on-funding-source',
  'no-regulatory-roles',
]))

/**
 * Reasons that mean "a source table failed to LOAD" — the resolver
 * could not see the data, so the state is unknowable this render, not
 * wrong. These map to the `load_failure` bucket so Phase 3.1 guidance
 * can render "couldn't verify — refresh to retry" instead of the
 * data_anomaly bucket's "contact support."
 *
 * 2026-06-18 — classification is now SUFFIX-BASED. Any UNKNOWN reason
 * matching the regex `/^.+-load-failure$/` routes to the load_failure
 * bucket regardless of whether it appears in this Set. The Set itself
 * is the canonical inventory of CURRENTLY-EMITTED reasons — useful for
 * docs, tests, and exhaustiveness audits — but it is no longer
 * load-bearing for classification. Two reasons were missing from the
 * previous enumeration (`compliance-documents-load-failure` from
 * buildComplianceDocResolver and `drill-logs-load-failure` from
 * buildDrillResolver) and both shipped to production misclassified as
 * data_anomaly. The suffix-based rule ends that recurrence by removing
 * the foot-gun: a new `<table>-load-failure` guard is correct the
 * moment it lands, with or without an update here.
 *
 * NOT included: 'training-requirements-catalog-empty' — that fires
 * when the statewide catalog LOADED successfully but contained no PD
 * rows, which is a deployment/seed anomaly (migration 013 missing),
 * not a transient load failure; it stays data_anomaly. (It also lacks
 * the `-load-failure` suffix, so the suffix rule excludes it
 * automatically.)
 *
 * Inventory below — keep in lockstep with the resolver guards. New
 * additions should keep the `<table>-load-failure` shape so the suffix
 * classifier picks them up. The classifyUnknownReason test asserts the
 * suffix rule routes every Set member to 'load_failure'.
 */
export const LOAD_FAILURE_REASONS = Object.freeze(new Set([
  'caregivers-load-failure',
  'staff-training-records-load-failure',
  'training-data-load-failure',
  'miregistry-training-entries-load-failure',
  'funding-documents-load-failure',
  'attendance-acks-load-failure',
  // 2026-06-18 — backfill of two reasons that were emitted by
  // resolvers but missing from this Set (and therefore misclassified
  // as data_anomaly through classifyUnknownReason's Set lookup):
  'compliance-documents-load-failure',  // buildComplianceDocResolver (radon, heating, ERP, ...)
  'drill-logs-load-failure',            // buildDrillResolver (fire / tornado / other-emergencies)
]))

/**
 * Suffix that identifies a load-failure UNKNOWN reason. The
 * classification function tests reasons against this regex first; the
 * Set above is documentation, not authority. Exported so tests can
 * verify the convention is enforced.
 */
export const LOAD_FAILURE_REASON_SUFFIX = /^.+-load-failure$/

/**
 * Classify an `unknown` state into a UI surface bucket. The checklist's
 * row renderer reads this to pick a treatment per the Phase 3 scope's
 * §5.4 mapping (plus the §3 live-gate fix-forward):
 *
 *   - 'awaiting_input'         — provider hasn't answered the
 *                                applicability question yet (resolver
 *                                set reason = 'awaiting-provider-input').
 *                                UI: amber, deep-link to BusinessInfo
 *                                "What applies to my program?" section.
 *   - 'feature_not_yet_shipped'— the requirement is in the catalog but
 *                                the source substrate hasn't shipped
 *                                yet (Pattern E; reason =
 *                                'feature-not-yet-shipped'). Option A
 *                                from §4 of the phase-3 scope. UI: gray
 *                                informational treatment + "tracking
 *                                ships with PR #N" copy.
 *   - 'needs_provider_data'    — a record exists but is missing a field
 *                                the provider can supply (e.g. a
 *                                caregiver row without date_of_hire).
 *                                UI: red/amber actionable, "Needs hire
 *                                date on the staff record" copy.
 *                                NOT "contact support." Reasons live
 *                                in NEEDS_PROVIDER_DATA_REASONS above.
 *   - 'load_failure'           — a source table failed to load, so the
 *                                resolver could not see the data
 *                                (reasons in LOAD_FAILURE_REASONS).
 *                                Transient, not provider-fixable, not
 *                                a support case. UI: "couldn't verify
 *                                — refresh to retry."
 *   - 'data_anomaly'           — every other reason (unparseable-date,
 *                                completion-date-in-future,
 *                                no-state-resolver,
 *                                or no reason at all). UI: gray,
 *                                "contact support."
 *
 * Pure. Returns the bucket string for any input, including states that
 * are not 'unknown' — callers should gate on `state.kind === 'unknown'`
 * before calling.
 */
export function classifyUnknownReason({ state } = {}) {
  const reason = state && state.reason
  if (reason === 'awaiting-provider-input') return 'awaiting_input'
  if (reason === 'feature-not-yet-shipped') return 'feature_not_yet_shipped'
  if (reason && NEEDS_PROVIDER_DATA_REASONS.has(reason)) return 'needs_provider_data'
  // 2026-06-18 — suffix-based routing: any `<table>-load-failure`
  // reason is a transient retry condition. The Set above is now
  // documentation-only; this regex is authority. See the comment block
  // above LOAD_FAILURE_REASONS for the rationale (two previously-
  // missed reasons shipped misclassified as data_anomaly).
  if (reason && LOAD_FAILURE_REASON_SUFFIX.test(reason)) return 'load_failure'
  return 'data_anomaly'
}

/**
 * Filter a ProviderComplianceState rollup down to requirements whose
 * registry row has the given `data_state`. Used by the checklist UI to
 * split "what we track today" from "tracking ships with PR #N", and
 * by future Phase 4 score code to exclude not_yet_modelled rows from
 * the denominator.
 *
 * Pure: builds a NEW rollup object with the same shape as the input;
 * does not mutate. Requirements whose registry row is missing or whose
 * data_state is unknown are treated as 'shipped' (defensive default —
 * filtering should never drop a row the engine reported).
 *
 * @param {object} args
 * @param {object} args.state         ProviderComplianceState from
 *                                    getProviderComplianceState.
 * @param {'shipped'|'not_yet_modelled'} args.dataState
 * @returns {object} A new ProviderComplianceState with the filtered
 *                   per_child + provider_level rollups.
 */
export function filterByDataState({ state, dataState } = {}) {
  if (!state || !dataState) return state || null

  function filterCategoryState(catState) {
    const filtered = (catState.requirements || []).filter(r => {
      const key = r && r.state && r.state.requirement_key
      const req = key ? REQUIREMENT_REGISTRY[key] : null
      if (!req) return dataState === DATA_STATE.SHIPPED  // defensive default
      const rds = req.data_state || DATA_STATE.SHIPPED
      return rds === dataState
    })
    // Recompute counts.
    const next = emptyCategoryState()
    next.requirements = filtered
    for (const r of filtered) {
      if (r.applicability === APPLICABILITY_RESULT.APPLIES) next.applicable_count += 1
      switch (r.state && r.state.kind) {
        case REQUIREMENT_STATE_KIND.ON_FILE:          next.on_file_count += 1;          break
        case REQUIREMENT_STATE_KIND.EXPIRED:          next.expired_count += 1;          break
        case REQUIREMENT_STATE_KIND.MISSING_REQUIRED: next.missing_required_count += 1; break
        case REQUIREMENT_STATE_KIND.PENDING_PARENT:   next.pending_parent_count += 1;   break
        case REQUIREMENT_STATE_KIND.NOT_APPLICABLE:   next.not_applicable_count += 1;   break
        case REQUIREMENT_STATE_KIND.UNKNOWN:          next.unknown_count += 1;          break
        default: break
      }
    }
    return next
  }

  function filterPerChild(pc) {
    if (!pc) return pc
    const per_category = {}
    const totals = emptyTotals()
    for (const c of Object.keys(pc.per_category || {})) {
      const next = filterCategoryState(pc.per_category[c])
      per_category[c] = next
      totals.applicable      += next.applicable_count
      totals.on_file         += next.on_file_count
      totals.expired         += next.expired_count
      totals.missing_required+= next.missing_required_count
      totals.pending_parent  += next.pending_parent_count
      totals.not_applicable  += next.not_applicable_count
      totals.unknown         += next.unknown_count
    }
    return {
      child_id: pc.child_id,
      per_category,
      totals,
      any_gap:           totals.expired > 0 || totals.missing_required > 0 || totals.pending_parent > 0,
      any_unknown_input: totals.unknown > 0,
    }
  }

  const per_child = (state.per_child || []).map(filterPerChild)

  const provider_level = { per_category: {} }
  const providerTotals = emptyTotals()
  for (const c of Object.keys(state.provider_level?.per_category || {})) {
    const next = filterCategoryState(state.provider_level.per_category[c])
    provider_level.per_category[c] = next
    providerTotals.applicable      += next.applicable_count
    providerTotals.on_file         += next.on_file_count
    providerTotals.expired         += next.expired_count
    providerTotals.missing_required+= next.missing_required_count
    providerTotals.pending_parent  += next.pending_parent_count
    providerTotals.not_applicable  += next.not_applicable_count
    providerTotals.unknown         += next.unknown_count
  }

  const totals = emptyTotals()
  for (const pc of per_child) {
    if (!pc) continue
    for (const k of Object.keys(totals)) totals[k] += pc.totals[k] || 0
  }
  for (const k of Object.keys(totals)) totals[k] += providerTotals[k] || 0

  return {
    provider_id: state.provider_id,
    per_child,
    provider_level,
    totals,
    any_gap:           totals.expired > 0 || totals.missing_required > 0 || totals.pending_parent > 0,
    any_unknown_input: totals.unknown > 0,
  }
}

/**
 * Project a PerChildComplianceState down to a single category. Used by
 * the per-child Compliance tab to render one category section at a
 * time without re-running the engine. Also unblocks Phase 2 (the
 * scope doc decision 9 — added here pre-emptively since Phase 2
 * hasn't shipped at Phase-3-build time).
 *
 * Pure. Returns the category sub-rollup or `null` if the category
 * doesn't exist in the supplied state.
 */
export function getChildComplianceStateForCategory({ state, category } = {}) {
  if (!state || !category) return null
  const cat = state.per_category && state.per_category[category]
  return cat || null
}

/**
 * Returns the registry rows that are provider-declared via
 * `'auto': unknown` — the catalog the Phase 3 BusinessInfo
 * "What applies to my program?" section asks about. Future registry
 * additions with the same shape automatically appear in the UI
 * without a code change there (the UI iterates this list).
 *
 * Returns an array of full registry rows (not just keys). Frozen at
 * call time.
 */
export function listProviderDeclaredApplicabilityRequirements() {
  return Object.values(REQUIREMENT_REGISTRY).filter(req =>
    req
    && req.applicability
    && req.applicability.autoDefault === APPLICABILITY_RESULT.UNKNOWN
  )
}
