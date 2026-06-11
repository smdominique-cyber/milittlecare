# PR Scope — Compliance Engine Phase 1: State Model + Requirement Registry

**Date:** 2026-06-03
**Status:** Scope — **FINAL, ready for build.** Seth's applicability
decisions are folded in (§6); the governing safety principle is
recorded (§2a); the level-2 field-name blocker is resolved
(`profiles.miregistry_level_2_expires_on` exists per migration 009 —
requirement #36 stays fully derivable). Phase 3's onboarding
implication is noted (§6a). The registry remains the build contract;
CC can construct from this doc.
**Branch (suggested):** `feature/compliance-engine-phase-1`
**Parent scope:** `docs/pr-compliance-engine-scope.md` (the three-
faces design DRAFT; this implements its §3 + §4 with the locked
decisions).
**Schema change:** **ZERO.** Pure on-read derivation over existing
tables. If a requirement in the catalog turns out to be underivable
from current data, it gets flagged as a Phase-1 blocker (§7 below)
rather than silently triggering a new column.

---

## Summary

Phase 1 ships the **engine without any user-visible surface**: a pure
derivation module `src/lib/complianceState.js` that exports a
**requirement registry** (the catalog of every compliance signal
the app tracks) and **pure verdict functions** that, given the loaded
source rows, return per-requirement state + per-child rollup + per-
provider rollup. A sibling impure module `complianceStateLoader.js`
fans out the Supabase queries.

The pattern is the proven one from `src/lib/childFiles.js` —
`pendingEnrollmentConsentsForChild` is pure and deterministic; the
caller passes pre-filtered rows. We extend that shape to cover every
domain.

**No UI work, no refactor of existing consumers (that's Phase 2),
no migration, no provider-declared override table (that's Phase 3 —
Phase 1 leaves the clean seam).** What ships:

1. The `REQUIREMENT_REGISTRY` — the master catalog.
2. The pure verdict functions over the registry.
3. The impure loader module.
4. Comprehensive unit tests (the pure layer is highly testable;
   every requirement + each applicability branch + each state branch
   gets a test).

The deliverable Seth reviews is **the catalog**. Every requirement
row is a small contract: which rule, what counts as on-file, when
it's expired, when it's not applicable, where the data lives. The
catalog is the build's correctness contract; getting it right is
the load-bearing decision of this phase.

---

## DECISIONS — RESOLVED + PROPOSED

| # | Decision | Resolution |
|---|---|---|
| 1 | Module path + name | **LOCKED:** `src/lib/complianceState.js` (pure verdict + registry) and `src/lib/complianceStateLoader.js` (impure fan-out). Mirrors the `acknowledgments.js` / `childFiles.js` split (pure helpers vs `getXxxAuditState`). |
| 2 | The six requirement states | **LOCKED (per parent scope §3):** `on_file` / `expired` / `missing_required` / `pending_parent` / `not_applicable` / `unknown`. |
| 3 | Pure + impure split | **LOCKED:** `getRequirementState({ requirement, child, provider, sourceRows })` is pure — caller supplies rows. `loadComplianceSourceRows({ providerId, childIds })` is the async fan-out. Same pattern as `pendingEnrollmentConsentsForChild` (pure) + `getChildFilesAuditState` (impure caller). |
| 4 | Applicability resolution order | **LOCKED (per parent scope §4):** (1) explicit override → (2) regulatory-universal → (3) data-inferred → (4) `unknown`. Phase 1 implements layers 2-4; layer 1 is a no-op stub (`overrides = {}`). |
| 5 | Provider-declared `'auto'` default direction | **RESOLVED (2026-06-03) — see §6.** Each provider-declared requirement gets one of three `'auto'` defaults: `applies` (when the regulation reads as unconditional or when a dismissable nag is the lesser failure), `unknown` (when the rule applies to some providers and the cost of guessing wrong is a silent compliance gap), or — never used by Phase 1 — `does_not_apply` (reserved for cases the engine can affirmatively determine; see §2a governing principle). Seth's six rows are folded in below. |
| 6 | Type 1 / Type 2 tagging | **LOCKED:** every registry row carries `data_authority: 'milittlecare' \| 'miregistry'`. Phase 1 reports both; the score (Phase 4) decides what counts. The checklist (Phase 3) tags Type 1 visually. |
| 7 | GSQ-relevance tagging | **LOCKED:** every row carries `gsq_relevant: boolean`. Phase 1 captures the tag; the future GSQ widget consumes the projection. Mostly conservative `false` until GSQ scoping happens. |
| 8 | Requirements that depend on tables NOT YET SHIPPED (drills, property, discipline policy, physician attestation, religious-objection statements) | **PROPOSED:** the registry **lists them** with a `data_state: 'not_yet_modelled'` flag. Their `state_resolver` returns `{ kind: 'unknown', reason: 'feature-not-yet-shipped' }`. The applicability resolver still runs. This keeps the registry COMPLETE (the catalog is the master list); the score / checklist project around the unknowns. Alternative: omit them from Phase 1 entirely. I recommend keeping them with the `not_yet_modelled` flag so the gap is visible to providers and inspectors rather than invisible. |
| 9 | Inputs that DON'T exist today (e.g., `provider_does_routine_transport`, `provider_has_pool`) | **PROPOSED:** these are provider-declared. Without the overrides table (Phase 3), each defaults to my proposed `'auto'` direction per row below. Phase 1 ships the `'auto'` defaults; Phase 3 lets providers override. **Flag for Seth — see §6.** |
| 10 | The clean seam for Phase 3's overrides table | **LOCKED:** the pure verdict functions accept an `overrides: Map<requirementKey, 'applies' \| 'does_not_apply'>` parameter. Phase 1 passes `new Map()`; Phase 3 adds the loader path that fills it from the `compliance_applicability_overrides` table. ZERO refactor required to the verdict logic when Phase 3 lands. |
| 11 | Phase 2 connection (parent-view bugs) | **LOCKED:** Phase 1 does NOT refactor `ParentEnrollmentConsentsPanel`, `EnrollmentConsentsPendingBanner`, or `ChildIntakeModal`. Those switch to consuming `complianceState.js` in Phase 2. Phase 1 only adds the engine + tests. The existing audit-state helpers (`getChildFilesAuditState`, `pendingEnrollmentConsentsForChild`) stay untouched. |
| 12 | Backward compatibility | **LOCKED:** every existing helper continues to return the exact shape it returns today. Phase 1 introduces a NEW module; it does not modify existing modules. |
| 13 | What "compute on-read" means concretely | **LOCKED:** every call to `getProviderComplianceState` re-runs the queries + the pure verdict. No materialization, no caching at the data layer. React-side memoization (e.g., `useMemo`) is appropriate at the consumer; the engine itself is stateless. Same posture as the existing audit-state helpers. |
| 14 | Test coverage requirement | **LOCKED:** every registry row gets at least 4 test cases: on_file, missing_required (or expired), not_applicable (if applicability has a path to it), unknown (if applicability can resolve there). Plus 3+ tests per applicability branch. Plus integration-shaped tests over the rollup functions. Target: ≥90% line coverage for the pure layer. |

---

## §1. Module API (the build contract)

### `src/lib/complianceState.js` (PURE)

```js
// Registry — single canonical catalog of every compliance signal.
// Order doesn't matter; lookup is by `key`. Frozen so consumers
// can't mutate the catalog at runtime.
export const REQUIREMENT_REGISTRY = Object.freeze({ ... })  // see §4

// Categories grouped for the future score subscores.
export const CATEGORIES = Object.freeze([
  'child_files',
  'staff_files',
  'medication',
  'consents',
  'drills',
  'property',
  'funding_docs',
  'cdc_compliance',
  'miregistry',
  'attendance',
])

// Six possible states (per parent scope §3, decision 5).
export const REQUIREMENT_STATE_KIND = Object.freeze({
  ON_FILE:          'on_file',
  EXPIRED:          'expired',
  MISSING_REQUIRED: 'missing_required',
  PENDING_PARENT:   'pending_parent',
  NOT_APPLICABLE:   'not_applicable',
  UNKNOWN:          'unknown',
})

// Applicability constants.
export const APPLICABILITY_RESULT = Object.freeze({
  APPLIES:        'applies',
  DOES_NOT_APPLY: 'does_not_apply',
  UNKNOWN:        'unknown',
})

// ─── Pure verdict — per single requirement ────────────────────────
/**
 * @param {object} args
 * @param {object} args.requirement   Row from REQUIREMENT_REGISTRY.
 * @param {object|null} args.child    children row (null for provider-
 *                                    level requirements).
 * @param {object} args.provider      profile row.
 * @param {SourceRows} args.sourceRows   pre-loaded source data.
 * @param {Map<string, 'applies'|'does_not_apply'>} [args.overrides=new Map()]
 *   Phase-3 seam — empty in Phase 1.
 * @param {Date} [args.now=new Date()]   wall clock (testable).
 * @returns {RequirementState}
 */
export function getRequirementState({ requirement, child, provider, sourceRows, overrides, now }) { ... }

// ─── Pure rollup — per child ──────────────────────────────────────
/**
 * Returns per-child PerChildComplianceState — a category rollup plus
 * the flat list of per-requirement RequirementResult objects.
 *
 * @param {object} args
 * @param {object} args.child
 * @param {object} args.provider
 * @param {SourceRows} args.sourceRows
 * @param {Map} [args.overrides=new Map()]
 * @param {Date} [args.now=new Date()]
 * @returns {PerChildComplianceState}
 */
export function getChildComplianceState({ child, provider, sourceRows, overrides, now }) { ... }

// ─── Pure rollup — per provider ───────────────────────────────────
/**
 * Aggregates across children PLUS provider-level requirements (drills,
 * property, staff). Returns ProviderComplianceState.
 */
export function getProviderComplianceState({ provider, children, sourceRows, overrides, now }) { ... }

// ─── Applicability resolver (exposed for tests) ───────────────────
/**
 * Pure: given a requirement and the context, returns
 * 'applies' | 'does_not_apply' | 'unknown'.
 *
 * Resolution order (per parent scope §4):
 *   1. overrides.get(requirement.key) — explicit provider-declared
 *   2. requirement.applicability.universalFor — regulatory-universal
 *   3. requirement.applicability.inferFromData(...) — data-inferred
 *   4. fallback: requirement.applicability.autoDefault (or 'unknown')
 */
export function resolveApplicability({ requirement, child, provider, sourceRows, overrides, now }) { ... }
```

### `src/lib/complianceStateLoader.js` (IMPURE — Supabase)

```js
/**
 * Fans out the Supabase queries the registry's verdicts need. Returns
 * the SourceRows object the pure verdict functions consume.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {string[]} [args.childIds]   when omitted, all active children.
 * @returns {Promise<SourceRows>}
 */
export async function loadComplianceSourceRows({ providerId, childIds }) { ... }

/**
 * Convenience: load + compute in one call. The thin wrapper most
 * Phase 2 consumers will use.
 *
 * @returns {Promise<ProviderComplianceState>}
 */
export async function computeProviderComplianceState({ providerId }) { ... }
```

### Type sketches

```
type SourceRows = {
  acks:                         AckRow[]
  medication_authorizations:    MedAuthRow[]
  medication_admin_events:      DoseRow[]
  caregivers:                   CaregiverRow[]
  staff_training_records:       StaffTrainingRow[]
  health_safety_updates:        HSUpdateRow[]
  funding_sources:              FundingSourceRow[]
  funding_documents:            FundingDocRow[]
  miregistry_training_entries:  MiRegistryEntryRow[]
  // Future tables (Phase 1 leaves slots null/empty):
  drill_logs?:                  null  // Category A not yet shipped
  property_records?:            null  // Category F not yet shipped
}

type RequirementResult = {
  requirement: {
    key: string,
    category: string,
    rule_citation: string,
    label: string,
    data_authority: 'milittlecare' | 'miregistry',
    severity: 'critical' | 'high' | 'medium' | 'low',
    gsq_relevant: boolean,
  },
  applicability: 'applies' | 'does_not_apply' | 'unknown',
  state: RequirementState,         // see §3
  evidence_id?: string,            // when on_file: the source row id
  expires_at?: string | null,
  expired_at?: string | null,
}

type PerChildComplianceState = {
  child_id: string,
  per_category: {
    [category]: {
      requirements: RequirementResult[],
      applicable_count: number,
      on_file_count: number,
      expired_count: number,
      missing_required_count: number,
      pending_parent_count: number,
      unknown_count: number,
    }
  },
  totals: { applicable, on_file, expired, missing_required, pending_parent, unknown },
  any_gap: boolean,           // expired OR missing_required OR pending_parent
  any_unknown_input: boolean, // unknown count > 0 (drives "tell us your situation" prompts)
}

type ProviderComplianceState = {
  provider_id: string,
  per_child: PerChildComplianceState[],
  provider_level: { per_category: { ... } },   // drills, property, staff, miregistry, funding_docs, cdc_compliance
  totals: { applicable, on_file, expired, missing_required, pending_parent, unknown },
}
```

---

## §2. The applicability resolver — pseudocode

The pure function `resolveApplicability` per parent scope §4. Phase 1
implements layers 2–4; layer 1 is a no-op (empty `overrides` Map).

```
function resolveApplicability({ requirement, child, provider, sourceRows, overrides, now }) {

  // 1. EXPLICIT OVERRIDE (Phase 3 seam — empty in Phase 1).
  if (overrides && overrides.has(requirement.key)) {
    return overrides.get(requirement.key)  // 'applies' | 'does_not_apply'
  }

  const rule = requirement.applicability

  // 2. REGULATORY-UNIVERSAL.
  if (rule.universalFor) {
    if (!rule.universalFor.includes(provider.license_type)) {
      return 'does_not_apply'
    }
    // Universally-applicable for this license type — but the requirement
    // may have a CHILD GATE that narrows further (e.g., infant safe-sleep).
    if (rule.childGate && child) {
      const childResult = rule.childGate({ child, provider, now })
      if (childResult === 'does_not_apply') return 'does_not_apply'
      // childGate returning 'unknown' falls through to layer 4
      if (childResult === 'unknown') return 'unknown'
    }
    return 'applies'
  }

  // 3. DATA-INFERRED.
  if (rule.inferFromData) {
    const inferred = rule.inferFromData({ child, provider, sourceRows, now })
    if (inferred === 'applies' || inferred === 'does_not_apply') {
      return inferred
    }
    // Inferred result was 'unknown' — fall through to layer 4.
  }

  // 4. AUTO-FALLBACK (or unknown).
  if (rule.autoDefault) return rule.autoDefault
  return 'unknown'
}
```

---

## §2a. Governing principle — `unknown` over `does_not_apply` when uncertain

**The engine NEVER silently resolves a real regulatory requirement
to `not_applicable` when it cannot actually determine
applicability.** It resolves to `unknown` instead. `not_applicable`
is reserved for cases the engine can AFFIRMATIVELY determine don't
apply — strict criteria:

- **Data-inferred negative** — the precondition row is genuinely
  absent. Example: a child has no `medication_authorizations` row →
  per-medication permission is genuinely `not_applicable`.
- **Regulatory-universal negative** — the requirement's
  `universalFor` list excludes the provider's `license_type`.
  Example: drill requirements apply to family_home / group_home;
  for a license_exempt provider they are genuinely `not_applicable`.
- **Child-gate negative** — the requirement's `childGate` returns
  `does_not_apply` based on a fact the engine can read. Example:
  child's `date_of_birth` is ≥18 months → infant safe-sleep is
  genuinely `not_applicable`.

**Everything else is `unknown`.** A provider-declared requirement
with no override set, no inferring data, and no regulatory-universal
gate resolves to `unknown` — *unless* the regulation reads as
unconditional (in which case `'auto': applies` is correct, and the
prompt the provider sees is "did you actually do this thing yet?",
not "do you do this thing?").

**Why this matters for a compliance tool.** The cost asymmetry is
sharp:

- False `applies` → dismissable nag. Provider sees "you're missing
  X" they don't actually need. They click dismiss or the BusinessInfo
  toggle. Minor friction.
- False `does_not_apply` → **silent compliance gap.** Provider
  shows green; auditor walks in; they're cited. **The product
  failed at its job.**

A compliance tool that ever quietly resolves a real obligation to
"not applicable" without affirmative basis is worse than no tool —
it manufactures false confidence. The engine MUST refuse that
failure mode.

**Phasing implication:** Phase 1 ships three requirements
(`consent_transportation_routine_annual`,
`consent_water_activities_on_premises_seasonal`,
`property_animal_notification`) with `'auto': unknown`. They will
display as `unknown` in any consumer projection — honest,
non-penalizing ("tell us about this"), not a false green.

The mechanism that resolves those three from `unknown` to
applies/does_not_apply is **Phase 3 onboarding + the
`compliance_applicability_overrides` table** — see §6a below.
**Phase 1 stays ZERO schema change.** The three rows simply
report `unknown` until the overrides table exists and gets
populated.

This principle, once recorded, is non-negotiable for every
future registry addition. Any new requirement that the engine
can't affirmatively classify is `unknown`, not `does_not_apply`.

---

## §3. The state resolvers — common patterns

Each requirement's `state_resolver` is a pure function that, given
the loaded rows + the requirement + the wall-clock `now`, returns one
of the six states. Several patterns recur — captured here so the
registry can name them succinctly.

### Pattern A — single satisfying ack row (parent-signed channel)

Used by every R 400.1907 intake sub-row + every enrollment consent.

```
function ackOnFile({ ackType, subjectType, subjectId, sourceRows, parentSignedRequired = true, now }) {
  const acks = sourceRows.acks.filter(a =>
       a.type === ackType
    && a.subject_type === subjectType
    && a.subject_id === subjectId
    && !a.archived_at
  )
  for (const a of acks) {
    const expired = a.expires_at != null && Date.parse(a.expires_at) <= now.getTime()
    if (expired) continue
    if (parentSignedRequired && !PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    return { kind: 'on_file', evidence_id: a.id, expires_at: a.expires_at }
  }
  // No currently-valid satisfying row. Check for expired satisfying row.
  const expiredSatisfying = acks.find(a =>
       a.expires_at != null
    && Date.parse(a.expires_at) <= now.getTime()
    && (!parentSignedRequired || PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via))
  )
  if (expiredSatisfying) {
    return { kind: 'expired', evidence_id: expiredSatisfying.id, expired_at: expiredSatisfying.expires_at }
  }
  // Check for pending_parent — provider_override row exists but no parent signature.
  const providerOnly = acks.find(a => a.acknowledged_via === 'provider_override')
  if (providerOnly && parentSignedRequired) {
    return { kind: 'pending_parent', evidence_id: providerOnly.id }
  }
  return { kind: 'missing_required' }
}
```

### Pattern B — inform-only ack (any channel satisfies)

Lead disclosure only (R 400.1907(1)(b)(vi)). Same as Pattern A but
with `parentSignedRequired = false`.

### Pattern C — date-driven currency (CPR, CDC authorization, fingerprint)

Used by staff training expirations + CDC authorization end +
fingerprint reprint.

```
function dateCurrencyState({ expiresOn, expiringWindowDays, now }) {
  if (!expiresOn) return { kind: 'missing_required' }
  const expiresMs = Date.parse(expiresOn)
  if (!Number.isFinite(expiresMs)) return { kind: 'unknown', reason: 'unparseable-date' }
  if (expiresMs <= now.getTime()) return { kind: 'expired', expired_at: expiresOn }
  return { kind: 'on_file', expires_at: expiresOn }
}
```

### Pattern D — annual cadence with anchor (MiRegistry annual ongoing, annual record review)

```
function annualCadenceState({ lastCompletedOn, anchorMonth, anchorDay, now }) {
  if (!lastCompletedOn) return { kind: 'missing_required' }
  // Anchor (e.g., Dec 16 for MiRegistry) — current cycle's deadline.
  // Implementation pulled from `src/lib/miregistry.js` patterns.
  const cycle = currentAnchorCycle({ anchorMonth, anchorDay, now })
  if (Date.parse(lastCompletedOn) >= cycle.startMs) {
    return { kind: 'on_file', expires_at: cycle.endIso }
  }
  return { kind: 'expired', expired_at: cycle.endIso }
}
```

### Pattern E — feature not yet modelled

Used by drills, property records, physician attestation, discipline
policy, religious-objection — the requirements that exist in the
registry as catalog entries but whose source tables are not yet
shipped.

```
function notYetModelled() {
  return { kind: 'unknown', reason: 'feature-not-yet-shipped' }
}
```

This is **how Phase 1 keeps the catalog complete without inventing
schema**: the requirements are in the list, providers see them as
"we'll track this when we ship it," and Phase 5's auditor view can
honestly report "this is not yet captured in MILittleCare — verify
out-of-band."

---

## §4. THE REQUIREMENT REGISTRY (the build contract — Seth review)

This is the master catalog. Every row is a contract: the build PR
implements exactly these rows, no more, no less. Seth's review is
applied here.

Legend:
- **Applicability** column shows the resolution: U = universal, DI =
  data-inferred, PD = provider-declared. For PD, the proposed `'auto'`
  default is shown in **bold**.
- **Source** = where the on-file evidence comes from.
- **Type** = `data_authority` (T2 = milittlecare, T1 = miregistry).
- **GSQ** = `gsq_relevant` (default false unless noted).

### Category: child_files (per child)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 1 | `child_in_care_statement_envelope` | R 400.1907(1)(b) | U: family_home / group_home | Pattern A (env row), drift detect | `acks` (`type='child_in_care_statement'`) | T2 | critical |
| 2 | `intake_lead_disclosure` | R 400.1907(1)(b)(vi) | DI: `profile.home_built_before_1978 === true` → applies; `=== false` → does_not_apply; **null → unknown** (drives BusinessInfo prompt) | Pattern B (inform-only) | `acks` (`type='lead_disclosure'`) | T2 | high |
| 3 | `intake_firearms_disclosure` | R 400.1907(1)(b)(v) | DI: `profile.firearms_on_premises` is boolean → applies (copy varies); **null → unknown** | Pattern A | `acks` (`type='firearms_disclosure'`) | T2 | high |
| 4 | `intake_food_provider_agreement` | R 400.1907(1)(b)(ii) | U: family_home / group_home | Pattern A | `acks` (`type='food_provider_agreement'`) | T2 | high |
| 5 | `intake_licensing_notebook_availability` | R 400.1907(1)(b)(vii) | U: family_home / group_home | Pattern A | `acks` (`type='licensing_notebook_offered'`) | T2 | high |
| 6 | `intake_licensing_rules_offered` | R 400.1907(1)(b)(iii) | U: family_home / group_home | Pattern A | `acks` (`type='licensing_rules_offered'`) | T2 | high |
| 7 | `intake_infant_safe_sleep` | R 400.1930 / 1907 | childGate: child.date_of_birth < 18mo at acknowledgment → applies; ≥18mo → does_not_apply; null DOB → unknown | Pattern A | `acks` (`type='infant_safe_sleep'`) | T2 | high |
| 8 | `intake_health_condition` | R 400.1907(1)(b)(i) | U: family_home / group_home | Pattern A | `acks` (`type='health_condition'`) | T2 | high |
| 9 | `intake_discipline_policy_receipt` | R 400.1907(1)(b)(iv) | U: family_home / group_home | Pattern A | `acks` (`type='discipline_policy_receipt'`) | T2 | high |
| 10 | `child_immunization_record` | R 400.1907 | U: family_home / group_home | `children.immunization_status` in (up_to_date, waiver_on_file, in_progress) → on_file; null → missing_required | `children.immunization_status` | T2 | high |
| 11 | `child_annual_record_review` | R 400.1907 | U: family_home / group_home | `children.records_last_reviewed_on >= now - 12 months` → on_file; else expired (or missing if never reviewed); first-year tolerance: if `intake_completed_at < 12 months` → on_file regardless | `children.records_last_reviewed_on` + `intake_completed_at` | T2 | medium |
| 12 | `child_in_care_statement_envelope_drift` | R 400.1907 (derived) | DI: applies when envelope exists AND `requiredSubTypesForChild(child, profile)` changed since acknowledged | If drift → state = `pending_parent` (re-ack needed); else → not_applicable | `acks` + `requiredSubTypesForChild` | T2 | medium |

**Phase 1 derivation status:** ALL DERIVABLE. Patterns A/B + existing
`requiredSubTypesForChild` + `getChildFileCompleteness` (already in
`acknowledgments.js`). No schema change.

### Category: consents (per child — enrollment-level)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 13 | `consent_field_trip_permission` | R 400.1952(2) | **PD: `'auto'` default = applies** (resolved 2026-06-03). The rule reads as unconditional for licensed homes ("at the time of initial enrollment a licensee SHALL obtain written permission…"). Conservative reading is to treat as universal-style. Dismissable nag is the acceptable failure mode for providers who genuinely never do trips — they can flip the toggle in Phase 3's onboarding/settings. | Pattern A | `acks` (`type='field_trip_permission'`) | T2 | medium |
| 14 | `consent_transportation_routine_annual` | R 400.1952(1)(a) | **PD: `'auto'` default = unknown** (resolved 2026-06-03). The rule applies to any provider who routinely transports children; some do, most don't. The engine cannot affirmatively classify either way without provider input. Per §2a's governing principle, `unknown` (not `does_not_apply`) is the correct fallback — a silent gap for a provider who DOES transport is the dangerous failure mode. The Phase 3 onboarding prompt asks the question; until then, the requirement reports as `unknown` (honest, not a false green). | Pattern A (with expiry check) | `acks` (`type='transportation_routine_annual'`) | T2 | high |
| 15 | `consent_water_activities_on_premises_seasonal` | R 400.1934(10)(b) | **PD: `'auto'` default = unknown** (resolved 2026-06-03). R 400.1901(1)(yy) excludes most casual water (water-table play, slip-and-slide, wading pools, sprinklers), so the rule applies narrowly — but some providers DO have qualifying water features. The engine cannot tell from data which is which. Per §2a, `unknown` is the correct fallback. Phase 3 onboarding asks; Phase 1 reports `unknown`. | Pattern A (with expiry check) | `acks` (`type='water_activities_on_premises_seasonal'`) | T2 | high |
| 16 | `consent_transportation_nonroutine_per_trip_recency` | R 400.1952(1)(b) | DI: applies when ≥1 active `transportation_nonroutine_per_trip` ack exists for any child in last 12 months → "applies, currently captured"; else does_not_apply (rule applies BEFORE each trip; absence of trips = absence of requirement) | If applies, recent capture exists → on_file; else not_applicable | `acks` (`type='transportation_nonroutine_per_trip'`) | T2 | medium |
| 17 | `consent_water_activities_off_premises_per_trip_recency` | R 400.1934(10)(a) | DI: same as #16 — applies only when off-premises water trip records exist | Same as #16 | `acks` (`type='water_activities_off_premises_per_trip'`) | T2 | medium |
| 18 | `consent_photo_sharing` | None (provider-protective) | **PD: `'auto'` default = applies** (resolved 2026-06-03). Messaging-with-photos is the default UX; capturing the consent is the prudent default. Provider can dismiss/toggle if they don't share photos. Note: this is provider-protective only (no rule), so a false `applies` is purely a UX nag — no regulatory consequence. | Pattern A + revocation-pair logic (per `pendingEnrollmentConsentsForChild`) | `acks` (`type='photo_sharing_consent'` + `_revoked`) | T2 | low (provider-protective, not licensing) |
| 19 | `consent_religious_objection_emergency_medical` | R 400.1907(1)(d) | **DEFERRED to a future consents PR** (resolved 2026-06-03). The ACK_TYPES constant doesn't exist; the capture flow doesn't exist; adding the JS constant alone produces dead code. The row stays out of the Phase 1 registry. Revisit when the consent's capture flow ships in a future consents PR — at that point the row joins the registry with `applicability: PD, autoDefault: unknown` per §2a (the engine can't tell which families have invoked it without provider input). | (not registered in Phase 1) | (none — type not defined) | T2 | medium |

**Phase 1 derivation status (post-2026-06-03 resolution):** Rows 13–18
in the Phase 1 registry. Rows 13 and 18 default to `applies` (per §6);
rows 14, 15 default to `unknown` (per §2a); rows 16, 17 are
data-inferred. Row 19 is **deferred** — not in the Phase 1 registry;
revisits when the religious-objection ack type and capture flow ship.

### Category: medication (per child × authorization)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 20 | `medication_authorization_for_authorization` | R 400.1931(3-6) | DI: applies per active row of `medication_authorizations` | On_file if row exists + not archived; else N/A | `medication_authorizations` | T2 | (informational; the row IS the requirement) |
| 21 | `medication_permission_per_authorization` | R 400.1931(2) | DI: applies per non-OTC authorization (`is_topical_otc = false`) | Pattern A (ack subject = authorization), with snapshot-hash drift → `pending_parent` | `acks` (`type='medication_permission'`, `subject_type='medication_authorization'`) | T2 | critical |
| 22 | `medication_permission_otc_blanket` | R 400.1931(8) | DI: applies when ≥1 OTC authorization (`is_topical_otc = true`) exists for the child | Pattern A | `acks` (`type='medication_permission_otc_blanket'`, `subject_type='child'`) | T2 | high |
| 23 | `medication_role_gate_integrity` | R 400.1931(1) | DI: applies when ≥1 non-OTC dose event exists | `medication_administration_events` joined to caregiver roles → if any administered_by lacks eligible role → MISSING_REQUIRED (anomaly); else on_file | `medication_administration_events` + caregiver roles | T2 | critical (legal liability) |
| 24 | `medication_original_container_attestation` | R 400.1931(4) | DI: applies per non-OTC authorization | `medication_authorizations.original_container_confirmed === true` → on_file; false → missing_required | `medication_authorizations` | T2 | high |
| 25 | `medication_dose_log_retention` | R 400.1931(9) | DI: applies per non-OTC authorization with ≥1 dose event | Currently always on_file (DB enforces archive-not-delete + 2-year retention); if a dose event somehow disappeared → unknown | `medication_administration_events` | T2 | high |

**Phase 1 derivation status:** ALL DERIVABLE from migration 028 +
`medication.js` helpers. The role-gate trigger guarantees row 23 is
always on_file in current data — but the engine STILL checks
defensively, because the trigger could be bypassed by a future direct
DB write.

### Category: staff_files (per caregiver)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 26 | `caregiver_background_check_eligibility` | R 400.1919 / R 400.1903(1)(r) | U: every active caregiver (per `caregivers.archived_at IS NULL`) | Most recent `background_check_eligibility` record → on_file if status='eligible'; pending → pending_parent (analog: pending review); ineligible → missing_required (with severity-escalation flag) | `staff_training_records` (category=background_check_eligibility) | T2 | critical |
| 27 | `caregiver_cpr_first_aid_current` | R 400.1924(8) | U: per role — required for caregivers with eligible administering roles (licensee, child_care_staff_member) per R 400.1920(3), R 400.1921(3) | Pattern C: most recent CPR record's `expires_on` vs now | `staff_training_records` (category=cpr_first_aid) | T2 | high |
| 28 | `caregiver_new_hire_training_complete` | R 400.1923 | U: every active caregiver hired in the last 90 days OR whose record indicates not yet complete | Within 90 days of `date_of_hire`: must have all 14 topics. Pure: count topics covered vs 14, partial = missing_required, complete = on_file. After 90 days without completion = expired (compliance violation) | `staff_training_records` (category=new_hire_training) | T2 | critical |
| 29 | `caregiver_miregistry_account` | R 400.1922 | U: every caregiver employed >30 days | Most recent `miregistry_account` record's `miregistry_status` IN (submitted, materials_received, awaiting_print, current) → on_file; expired → expired; absent → missing_required | `staff_training_records` (category=miregistry_account) | **T1** | high |
| 30 | `caregiver_professional_development_hours` | R 400.1924 | U: per caregiver; required hour count varies by role | Pure: sum hours in current calendar year vs required threshold for role → on_file/missing | `staff_training_records` (category=professional_development) | **T1** | medium |
| 31 | `caregiver_health_safety_update_acked` | R 400.1924(11) | DI: applies per published `health_safety_updates` row + per applicable caregiver | Has matching `staff_training_records` ack of category=health_safety_update_acknowledgement → on_file | `staff_training_records` + `health_safety_updates` | T2 | medium |
| 32 | `caregiver_physician_attestation_annual` | R 400.1933 (?) | U: every active caregiver, annual | Pattern E: **NOT YET MODELLED.** No category exists in `staff_training_category` enum. State = unknown ('feature-not-yet-shipped'). | (none yet) | T2 | high |
| 33 | `caregiver_discipline_policy_ack_at_hire` | R 400.1923(?) | U: every caregiver, at hire | Pattern E: **NOT YET MODELLED.** ACK_TYPES has `STAFF_DISCIPLINE_POLICY_RECEIPT` defined but no capture flow yet. State = unknown until PR #17 ships. | `acks` (`type='staff_discipline_policy_receipt'`) — table exists, capture flow doesn't | T2 | high |
| 34 | `caregiver_daily_arrival_departure` | R 400.1906 | U: every active caregiver, every operating day | DI: matches `staff_time_entries` (current) OR `caregiver_time_entries` (non-app-user, planned). Phase 1: data-inferred from `staff_time_entries` for app-user caregivers only; for non-app-user caregivers, state = unknown ('feature-not-yet-shipped' for the non-app-user surface) | `staff_time_entries` | T2 | medium |

**Phase 1 derivation status:** Rows 26-31 derivable from PR #8.
Rows 32-34 partially derivable (33 has the ack type, no UI; 32 has
nothing; 34 has app-user clock only). Per decision 8, registry
includes them with `data_state: 'not_yet_modelled'` or 'partial';
state_resolver returns `unknown` with reason.

### Category: miregistry (per provider — Type 1 mirror)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 35 | `provider_miregistry_annual_ongoing` | LEP Handbook p.12 (Dec 16 deadline) | U: license_exempt only | Pattern D: most recent `miregistry_training_entries.completed_on` with `source='annual_ongoing'` vs current Dec-16 cycle | `miregistry_training_entries` | **T1** | critical |
| 36 | `provider_miregistry_level_2_currency` | LEP Handbook p.13 (rolling 10-hour) | DI: applies when `is_license_exempt = true` AND `miregistry_current_level = 'level_2'` (typed enum from migration 009). Else does_not_apply (a level_1 provider isn't tracking level_2 expiry). | Pattern C: `profile.miregistry_level_2_expires_on` (date, migration 009) vs now | `profiles.miregistry_current_level` + `profiles.miregistry_level_2_expires_on` | **T1** | high |

**Phase 1 derivation status (post-2026-06-03 resolution):** Both
rows fully derivable. The level-2 field-name blocker is resolved —
`profiles.miregistry_level_2_expires_on` (typed `date`) and
`profiles.miregistry_current_level` (`'level_1'|'level_2'` enum) both
exist via migration 009 + the migration 009 CHECK constraint
`profiles_miregistry_level_values`. Sibling field
`miregistry_level_last_updated_at` is also present (audit timestamp,
not load-bearing for the verdict).

### Category: funding_docs + cdc_compliance (per provider × funding source)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 37 | `funding_dhs_198_on_file` | CDC Handbook | DI: applies per active `funding_sources.type='cdc_scholarship'` | Active `funding_documents` row of type=DHS-198 + not archived → on_file; expired `retention_until` → expired; absent → missing_required | `funding_documents` (per funding_source_id) | T2 | high |
| 38 | `funding_enrollment_agreement_on_file` | CDC Handbook (licensed-billing-basis only) | DI: applies per active CDC funding source where `details.billing_basis = 'enrollment'` | Same shape as #37, type=Enrollment Agreement | `funding_documents` | T2 | high |
| 39 | `cdc_authorization_currency` | CDC Handbook | DI: applies per active CDC funding source | Pattern C with `EXPIRING_WINDOW_DAYS = 30`: on_file > 30d; expiring 0-30d (reported as on_file with `expiring_soon: true` flag — separate from `expired`); expired ≤ today | `funding_sources.authorization_end` | T2 | high |
| 40 | `cdc_fingerprint_reprint_currency` | CDC Handbook (5-year cycle, LEP only) | DI: license_exempt AND has CDC funding source | Pattern C with multi-band severity (already implemented in `cdcProviderCompliance.js`): info/warning/urgent/critical/expired | `profile.fingerprint_date` | T2 | high (legal eligibility to bill) |

**Phase 1 derivation status:** ALL DERIVABLE from existing helpers
(`cdcAuthorization.js`, `cdcProviderCompliance.js`, `fundingDocuments.js`).
No schema change.

### Category: attendance (per child × day)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 41 | `attendance_parent_acknowledgment_per_day` | R 400.1906 (audit trail) | DI: applies per (child, attendance_date) where attendance exists | Active `attendance_acknowledgments` row with `acknowledged_via` in (parent_portal, in_person_paper) → on_file; provider_override only → pending_parent; absent → missing_required | `attendance_acknowledgments` per attendance row | T2 | medium |

**Phase 1 derivation status:** Derivable from migration 020. The
data volume is high (per-day) — Phase 1's loader provides a knob
for "summary only" (most-recent N days + counts) to avoid loading
every day's ack for every child. Specifies in §5.

### Category: drills (provider-level — NOT YET MODELLED)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 42 | `drill_fire_quarterly` | R 400.1939(?) | U: family_home / group_home | Pattern E: not_yet_modelled | (none yet) | T2 | critical |
| 43 | `drill_tornado_seasonal` | R 400.1939(?) | U: family_home / group_home | Pattern E | (none yet) | T2 | critical |
| 44 | `drill_other_emergencies_annual` | R 400.1939(?) | U: family_home / group_home | Pattern E | (none yet) | T2 | high |
| 45 | `emergency_response_plan_on_file` | R 400.1939(?) | U: family_home / group_home | Pattern E | (none yet) | T2 | critical |

**Phase 1 derivation status:** ALL NOT YET MODELLED. Registry
includes them as catalog entries returning `{ kind: 'unknown',
reason: 'feature-not-yet-shipped' }`. When PR #19 ships the drill
tables, Phase 1's registry rows update their `data_state` flag and
plug in real resolvers — no engine API change required.

### Category: property (provider-level — NOT YET MODELLED)

| # | Requirement key | Rule | Applicability | State resolver | Source | Type | Severity |
|---|---|---|---|---|---|---|---|
| 46 | `property_radon_test_quadrennial` | R 400.1934 / 1932 (?) | U: family_home / group_home | Pattern E | (none) | T2 | high |
| 47 | `property_heating_inspection_quadrennial` | R 400.1932(?) | U: family_home / group_home | Pattern E | (none) | T2 | high |
| 48 | `property_co_detectors_per_level` | R 400.1934 (?) | U: family_home / group_home | Pattern E | (none) | T2 | critical |
| 49 | `property_smoke_detectors_per_floor` | R 400.1934 (?) | U: family_home / group_home | Pattern E | (none) | T2 | critical |
| 50 | `property_fire_extinguishers_per_floor` | R 400.1934 (?) | U: family_home / group_home | Pattern E | (none) | T2 | critical |
| 51 | `property_animal_notification` | R 400.1937 (?) | **PD: `'auto'` default = unknown** (resolved 2026-06-03). Most home daycares don't have animals — but a silent gap for a provider who DOES is the dangerous failure mode. Per §2a's governing principle, `unknown` is the correct fallback. Phase 3 onboarding asks "do you have any animals on premises?"; Phase 1 reports `unknown`. (NOTE: this row is also Pattern E — `not_yet_modelled` for the notification document storage substrate, which is Category F / PR #21. The applicability is still computed; the state resolver still returns `unknown` for the data-substrate reason. Both reasons converge on the same Phase 1 output.) | Pattern E for now (notification doc storage) | (none) | T2 | low |
| 52 | `property_smoking_prohibition_posted` | R 400.1934 (?) | U: family_home / group_home | Pattern E (attestation) | (none) | T2 | medium |
| 53 | `property_licensing_notebook_archive` | R 400.1906(3) | U: family_home / group_home | Pattern E (document storage) | (none — funding-docs pattern reusable) | T2 | medium |

**Phase 1 derivation status:** ALL NOT YET MODELLED. Same posture
as drills.

---

### Registry summary

- **Total catalog rows:** 53.
- **Phase 1 fully derivable from existing data:** ~30 rows
  (categories: child_files [12], consents [5 of 7], medication [6],
  staff_files [6 of 9], miregistry [1 of 2 — pending field check],
  funding_docs+cdc [4], attendance [1]).
- **Not yet modelled (Pattern E — registered, state=unknown):**
  ~20 rows (drills, property, partial staff gaps, religious-
  objection consent).
- **Field gap requiring confirmation:** 1 — see §7.

---

## §5. The loader (`complianceStateLoader.js`)

Async fan-out over Supabase. Returns the `SourceRows` object the
pure verdict consumes.

### Queries

```js
async function loadComplianceSourceRows({ providerId, childIds }) {
  // 1. Profile (provider).
  const { data: provider } = await supabase
    .from('profiles')
    .select('id, license_type, home_built_before_1978, firearms_on_premises, ' +
            'is_license_exempt, fingerprint_date, michigan_provider_id, ' +
            'michigan_license_number, miregistry_id, program_settings, ' +
            'miregistry_current_level, miregistry_level_2_expires_on, ' +
            'miregistry_level_last_updated_at')   // all confirmed against mig 009 + 022 + 024
    .eq('id', providerId)
    .maybeSingle()

  // 2. Children (resolve childIds if not supplied).
  const children = (childIds && childIds.length)
    ? (await supabase.from('children')
        .select('id, family_id, date_of_birth, intake_completed_at, ' +
                'records_last_reviewed_on, immunization_status, food_provider')
        .eq('user_id', providerId)
        .in('id', childIds)
        .is('archived_at', null)).data
    : (await supabase.from('children')
        .select('id, family_id, date_of_birth, intake_completed_at, ' +
                'records_last_reviewed_on, immunization_status, food_provider')
        .eq('user_id', providerId)
        .is('archived_at', null)).data

  const allChildIds = children.map(c => c.id)

  // 3. Acks (every ack for the resolved children).
  const { data: acks } = await supabase
    .from('acknowledgments')
    .select('id, type, subject_type, subject_id, acknowledged_via, ' +
            'acknowledged_at, expires_at, archived_at, snapshot_hash, ' +
            'occurrence_metadata')
    .eq('provider_id', providerId)
    .in('subject_id', allChildIds)
    .is('archived_at', null)

  // PLUS acks where subject_type='medication_authorization' — these
  // need a separate fetch with subject_id resolved via the medication
  // auths loaded below. We fetch by provider_id+type instead:
  const { data: medAcks } = await supabase
    .from('acknowledgments')
    .select('id, type, subject_type, subject_id, acknowledged_via, ' +
            'acknowledged_at, expires_at, archived_at, snapshot_hash')
    .eq('provider_id', providerId)
    .eq('subject_type', 'medication_authorization')
    .is('archived_at', null)

  // 4. Medication authorizations + dose events.
  const { data: medAuths } = await supabase
    .from('medication_authorizations')
    .select('*')
    .eq('provider_id', providerId)
    .in('child_id', allChildIds)
    .is('archived_at', null)

  const { data: doseEvents } = await supabase
    .from('medication_administration_events')
    .select('id, authorization_id, child_id, administered_by_caregiver_id, ' +
            'administered_at, archived_at')
    .eq('provider_id', providerId)
    .is('archived_at', null)

  // 5. Caregivers + staff training + health-safety updates.
  const { data: caregivers } = await supabase
    .from('caregivers')
    .select(`id, full_name, date_of_hire, archived_at,
             caregiver_regulatory_roles ( regulatory_role )`)
    .eq('licensee_id', providerId)
    .is('archived_at', null)

  const { data: staffTraining } = await supabase
    .from('staff_training_records')
    .select('*')
    .eq('licensee_id', providerId)

  const { data: healthSafetyUpdates } = await supabase
    .from('health_safety_updates')
    .select('*')
    .eq('licensee_id', providerId)

  // 6. Funding sources + documents.
  const { data: fundingSources } = await supabase
    .from('funding_sources')
    .select('*')
    .eq('user_id', providerId)
    .is('archived_at', null)

  const { data: fundingDocs } = await supabase
    .from('funding_documents')
    .select('*')
    .eq('user_id', providerId)
    .is('archived_at', null)

  // 7. MiRegistry training entries (provider-level).
  const { data: miregistryEntries } = await supabase
    .from('miregistry_training_entries')
    .select('*')
    .eq('user_id', providerId)
    .is('archived_at', null)

  // 8. Attendance acks (summary only — last 90 days by default).
  //    Volume control: see §5 attendance scope.
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const { data: attendanceAcks } = await supabase
    .from('attendance_acknowledgments')
    .select('id, child_id, date, segment_index, acknowledged_via, archived_at')
    .eq('provider_id', providerId)
    .gte('date', cutoff)
    .is('archived_at', null)

  return {
    provider,
    children,
    acks: [...(acks || []), ...(medAcks || [])],
    medication_authorizations: medAuths || [],
    medication_admin_events: doseEvents || [],
    caregivers: caregivers || [],
    staff_training_records: staffTraining || [],
    health_safety_updates: healthSafetyUpdates || [],
    funding_sources: fundingSources || [],
    funding_documents: fundingDocs || [],
    miregistry_training_entries: miregistryEntries || [],
    attendance_acks: attendanceAcks || [],
    // Not-yet-shipped slots — null so resolvers know.
    drill_logs: null,
    property_records: null,
  }
}
```

### Defensive shape

Same `try/catch` + per-table defensive pattern as
`getChildFilesAuditState`: any table query that errors (e.g.,
migration not applied yet, RLS rejection) returns an empty array;
the resolver continues with the rows it has. The engine never
crashes the page over a missing table — it falls through to
`{ kind: 'unknown', reason: 'source-not-loaded' }`.

### Attendance volume control

Attendance ack volume is the only concern: 365 days × N children
× M segments. Phase 1 defaults to the last 90 days; the loader
accepts an optional `attendanceWindowDays` arg to widen for
inspection-prep workflows.

---

## §6. Provider-declared `'auto'` defaults — RESOLVED 2026-06-03

Per the governing principle in §2a, no row defaults to
`does_not_apply` without affirmative basis. Seth resolved each row
on 2026-06-03; the table below is the locked outcome.

### The locked rows

| # | Requirement | `'auto'` default | Rationale | Phase 1 surface behavior |
|---|---|---|---|---|
| 13 | `consent_field_trip_permission` | **`applies`** | Rule reads as unconditional ("at the time of initial enrollment a licensee SHALL obtain"); a dismissable nag is the acceptable failure for the rare never-do-trips provider. | Reports as `missing_required` until captured; provider can flip via Phase 3 override. |
| 14 | `consent_transportation_routine_annual` | **`unknown`** | The rule applies to providers who routinely transport — some do, most don't. Engine cannot affirmatively classify either way; silent gap is the dangerous failure. §2a governs. | Reports as `unknown` (honest, non-penalizing). Phase 3 onboarding resolves. |
| 15 | `consent_water_activities_on_premises_seasonal` | **`unknown`** | R 400.1901(1)(yy) excludes casual water (water-tables, slip-and-slides, wading pools, sprinklers), but the rule does apply to providers with qualifying pools. Engine cannot tell which is which. §2a governs. | Reports as `unknown`. Phase 3 onboarding resolves. |
| 18 | `consent_photo_sharing` | **`applies`** | Messaging-with-photos is the default UX. A false `applies` is a UX nag (provider-protective category, no rule), not a compliance miss. | Reports as `missing_required` until captured; provider dismisses or captures. |
| 19 | `consent_religious_objection_emergency_medical` | **DEFERRED** | ACK_TYPES constant doesn't exist; capture flow doesn't exist. Per the recommendation to avoid dead-code constants, this row is OUT of Phase 1's registry. Revisit when the consent's capture flow ships. | Not in Phase 1 registry. |
| 51 | `property_animal_notification` | **`unknown`** | Most homes don't have animals — but a silent gap for one that does is the dangerous failure. §2a governs. (Independently, this row is Pattern E — the property-records substrate ships in PR #21; the verdict reports `unknown` for either reason.) | Reports as `unknown`. Phase 3 onboarding resolves applicability; PR #21 ships the state surface. |

### Governing principle reminder

When the engine can't affirmatively classify a real regulatory
requirement, the answer is `unknown` — never `does_not_apply`. See
§2a for the asymmetric cost of being wrong.

---

## §6a. Phase 3 onboarding — the three questions that resolve `unknown`

Three of Seth's resolved rows (#14 routine transport, #15 on-premises
water, #51 animal notification) default to `unknown` in Phase 1 and
require provider input to resolve to `applies` or `does_not_apply`.

**Phase 1 does NOT prompt for these.** It reports `unknown`; the UI
surface that prompts is built in **Phase 3** (the readiness checklist
PR), which introduces the `compliance_applicability_overrides` table
+ the onboarding/settings prompts that fill it.

### The three onboarding questions Phase 3 asks

Recorded here so the Phase 3 scope doc inherits the contract:

1. **Routine transportation** — *"Do you transport children
   routinely — same day of the week, same time, same destination
   (e.g., to/from school)?"* (yes/no/sometimes)
   - yes/sometimes → write `applies` to overrides for #14.
   - no → write `does_not_apply` for #14.
2. **On-premises water** — *"Do you have a pool, kiddie pool larger
   than wading, or other water feature children swim in on the
   home's premises?"* (yes/no) — wording aligns with
   R 400.1901(1)(yy)'s exclusion list.
   - yes → `applies` for #15.
   - no → `does_not_apply` for #15.
3. **Animals on premises** — *"Are there any animals or pets on the
   home's premises?"* (yes/no)
   - yes → `applies` for #51.
   - no → `does_not_apply` for #51.

Each answer writes one row into `compliance_applicability_overrides`
(`provider_id`, `requirement_key`, `mode = applies | does_not_apply`,
`set_at`, `set_by_user_id`). The engine's resolver picks it up at
layer 1 of the resolution order; the row resolves cleanly. The
provider can change their answer later in settings.

**Phase 1 stays ZERO schema change** because Phase 1 doesn't ask
these questions — it just reports `unknown` for the three rows
until the overrides table and the onboarding prompts exist. Phase
1's registry contract for these three rows is "report `unknown`
until overrides supply an answer." The Phase 3 PR is what
operationalizes the answer; the engine itself doesn't change.

### Where Phase 3 surfaces the questions

- **First-login onboarding wizard** (per `docs/strategy.md` §
  "Onboarding as architecture") — captures these alongside the
  other structural-identity fields if/when the wizard ships
  ahead of Phase 3.
- **BusinessInfoPage → "What applies to my program?"** section —
  always available, edit-anytime.
- **The readiness checklist itself** — surfaces the `unknown` rows
  with a "Tell us about this" affordance per row, in-line.

This is recorded so Phase 3's scope doc inherits the question list
verbatim; nothing for Phase 1 to build here.

---

## §7. Phase-1 blockers + field-gap flags — RESOLVED

All blockers identified during the DRAFT pass are now resolved. No
new blockers were introduced by the 2026-06-03 applicability
resolution. None required a migration.

### Blocker 1 — Level-2 MiRegistry field name — **RESOLVED 2026-06-03**

**Verified against the actual schema:** migration
`009_miregistry_training_entries.sql` adds three typed fields to
`public.profiles`:

- `miregistry_current_level` — text, CHECK constraint
  `profiles_miregistry_level_values` enforces `null | 'level_1' |
  'level_2'`.
- `miregistry_level_2_expires_on` — `date` (typed column, not JSON).
- `miregistry_level_last_updated_at` — `timestamptz` (audit
  timestamp, not load-bearing for the verdict).

The Phase 1 DRAFT had the wrong field name (`level_2_expires_on`
without the `miregistry_` prefix). Requirement #36's row and the
loader query in §5 are updated to use the correct names. Requirement
#36 **stays fully derivable** — no Pattern E downgrade needed.

References: `supabase/migrations/009_miregistry_training_entries.sql:131-145`,
`src/pages/MiRegistryPage.jsx:114,307`,
`src/components/miregistry/UpdateLevelModal.jsx`.

### Blocker 2 — Religious-objection ack type — **RESOLVED 2026-06-03 (deferred)**

Row #19 is **DEFERRED** out of Phase 1's registry, per the original
recommendation. The ack type's capture flow doesn't exist; adding
the JS constant without the UI is dead code. Revisits when the
consent's capture flow ships in a future consents PR. At that point
the row joins the registry with `applicability: PD, autoDefault: unknown`
per §2a.

### Field gap — provider-declared input fields (transport / water / animals)

These are the inputs Seth's resolution routes through Phase 3
onboarding (see §6a). Phase 1 needs **none** of them as columns —
the `'auto'` default of `unknown` is the correct Phase 1 behavior
per §2a. Phase 3 adds `compliance_applicability_overrides`
(a single table); the source-of-truth question moves there rather
than scattering booleans across `profiles`.

**Not a Phase 1 blocker.** Confirmed: Phase 1 stays ZERO schema.

### Field gap — `attendance_acknowledgments` polymorphic shape

The existing `attendance_acknowledgments` table (PR #12) is
attendance-specific — separate from the polymorphic
`acknowledgments` table. Requirement #41 reads it directly; this
is fine and matches `getChildFilesAuditState`'s posture (it reads
both tables). Not a blocker.

### Field gap — `caregivers.licensee_id` vs `user_id`

The loader uses `licensee_id` based on `staffTraining.js`'s usage.
This is a minor typo-class risk to confirm during the build PR
(grep the existing helper for ground truth); not a design issue.
Not a blocker.

---

## §8. Tests

Same shape as the existing `acknowledgments.test.js`,
`childFiles.test.js` (per `pendingEnrollmentConsentsForChild`'s
test approach), `medication.test.js`. Vitest. Pure layer is the
target.

### Per-requirement tests (≥4 each, 53 requirements → ~212+ tests)

For each registry row:
1. **on_file path** — supply rows that satisfy the resolver; expect
   `{ kind: 'on_file', ... }`.
2. **missing_required path** — supply no satisfying rows; expect
   `{ kind: 'missing_required' }`.
3. **expired path** (where applicable) — supply rows past
   `expires_at`; expect `{ kind: 'expired', expired_at: ... }`.
4. **not_applicable path** — supply context where applicability
   resolves false; expect `{ kind: 'not_applicable' }`.

For Pattern E rows: only test that `state = unknown` with the
right reason — the data path doesn't exist yet.

### Applicability resolver tests (~30)

For each applicability rule (universal, data-inferred,
provider-declared with auto):

- Universal: with provider's license_type matching the
  universalFor list — applies. With non-matching — does_not_apply.
- Universal with childGate: matching child gate — applies; non-
  matching — does_not_apply; null-context — unknown.
- Data-inferred: precondition data present — applies. Absent —
  does_not_apply. Ambiguous — unknown.
- Provider-declared with auto: overrides empty — auto default.
  Overrides has 'applies' — applies. Overrides has
  'does_not_apply' — does_not_apply.

### Rollup tests (per-child, per-provider)

- All applicable + all on_file → `any_gap: false`.
- One expired → `any_gap: true`, per-category breakdown reflects.
- One pending_parent → `any_gap: true` (counted as a gap).
- All not_applicable → `applicable_count: 0`, `any_gap: false`.
- Unknown only — `any_unknown_input: true`.
- Provider-level: drills/property all unknown → `unknown_count`
  matches catalog count; per-child unaffected.

### Determinism tests

- Two calls with same inputs + same `now` → identical output (object equality after JSON serialization).
- `now` argument controls expiry boundary tests deterministically.

### Backward-compatibility smoke tests

- `getChildFilesAuditState` still returns its existing shape
  (untouched in Phase 1 — confirm via the existing test file
  passing unchanged).
- `pendingEnrollmentConsentsForChild` still returns its existing
  shape (untouched).

### Coverage target

≥90% line coverage for `src/lib/complianceState.js`. The impure
loader is tested via integration tests (single happy path; the
defensive empty-array branches are covered by unit tests with
mocked failures).

---

## §9. What Phase 1 does NOT do (explicitly deferred)

Named so they don't quietly absorb scope.

- **No new database tables.** Phase 1 is pure derivation over
  existing tables.
- **No refactor of existing audit-state consumers.** The parent
  banner, parent panel, intake modal, enrollment-consents modal,
  medication modal continue to call the existing helpers. Phase 2.
- **No applicability_overrides table.** That's Phase 3. The clean
  seam is the `overrides` Map parameter — Phase 1 always passes
  `new Map()`, Phase 3 adds the loader path.
- **No checklist UI.** Phase 3.
- **No score formula.** Phase 4.
- **No auditor access.** Phase 5.
- **No new ACK_TYPES constants.** The religious-objection ack type
  is deferred; the existing types are sufficient.
- **No tightening of any existing constant or table.** Pure
  additive.
- **No backfill of children / acks rows.** The engine reads what
  exists.
- **No reminder-category linking.** Compliance state and reminder
  categories overlap conceptually but stay independent in Phase 1.

---

## §10. Build-PR handoff — what CC reads when picking this up

All open questions from the DRAFT pass are resolved
(2026-06-03). The registry is locked; CC builds against this doc
verbatim. The build PR's surface:

1. **`src/lib/complianceState.js`** — the `REQUIREMENT_REGISTRY`
   (52 rows; row 19 deferred), the `getRequirementState`,
   `getChildComplianceState`, `getProviderComplianceState`, and
   `resolveApplicability` pure functions per §1.
2. **`src/lib/complianceStateLoader.js`** — the impure fan-out
   per §5, using the corrected field names (per Blocker 1
   resolution).
3. **`src/lib/complianceState.test.js`** — the test coverage
   per §8.
4. **No UI changes, no migration, no refactor of existing
   consumers.** Phase 2 owns the consumer refactor; Phase 3
   owns the overrides table + onboarding prompts (§6a).

### Build-PR review checklist

- The three `unknown`-defaulted rows (#14, #15, #51) return
  `{ kind: 'unknown', reason: 'awaiting-provider-input' }` in
  every Phase 1 read path. No silent `does_not_apply` anywhere
  in the code.
- The §2a governing principle is preserved as a code comment in
  `complianceState.js` so future maintainers don't accidentally
  flip a row to `does_not_apply` without affirmative basis.
- The `overrides` Map parameter is present in every pure
  signature; Phase 1 always passes `new Map()`; the layer-1
  override check is wired through but is effectively a no-op
  given the empty Map.
- The level-2 field references use the corrected names
  (`miregistry_current_level`, `miregistry_level_2_expires_on`,
  `miregistry_level_last_updated_at`).
- Row 19 is NOT in the registry.

Status: **FINAL, ready for build.**

---

**End of compliance-engine Phase 1 scope — FINAL.** All
applicability decisions resolved 2026-06-03; the level-2 field-name
blocker resolved by direct schema verification (migration 009).
Zero schema change. Registry locked. No code, no commit, no branch.
Untracked. Halting for the build PR.
