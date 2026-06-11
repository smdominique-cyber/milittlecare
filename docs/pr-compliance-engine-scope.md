# PR Scope — Compliance-State Engine (the model behind the score, the checklist, and the auditor view)

**Date:** 2026-06-03
**Status:** Scope — **DRAFT for review.** Big design calls Seth must
react to. The model layer (§3) and the applicability model (§4) are
the load-bearing decisions; the auditor-access mode (§7) is the
highest-risk surface and gets its own boundary-verification gate.
The score formula (§5) is intentionally the least-decided piece —
the inventory shows the signal-count gate is met, but weighting
needs real provider data and is a tunable, not a one-shot.
**Branch (suggested for the first phase):** `feature/compliance-state-engine-phase-1`
(state model + applicability + audit-state expansion). Subsequent
phases (checklist, score, auditor) each on their own branch.
**Builds on:** the existing `acknowledgments` polymorphic table
(migrations 024/026/027), the `acknowledgments_active_unique`
partial-unique index, the channel-aware satisfaction rule
(`PARENT_SIGNED_SATISFYING_CHANNELS`), `src/lib/childFiles.js`'s
`getChildFilesAuditState` + `pendingEnrollmentConsentsForChild`,
`src/lib/medication.js`'s state helpers (`getDoseLogState`,
`medicationConsentSatisfied`), `src/lib/staffTraining.js`'s
expiry/eligibility helpers, `src/lib/cdcProviderCompliance.js`'s
severity ladder, `src/lib/reminderCategories.js`'s catalog shape
(category keys + license_type_gating + subject_type), the
`license_type` foundation (migration 022 + `src/lib/modules.js`),
and the parent-boundary Edge Function pattern
(`api/consent-attachment-url.js`) as the precedent for the auditor-
access boundary.

---

## Summary

The compliance health score (planned V3+), the per-child readiness
checklist (inspection prep), and the auditor access mode (read-only
inspector view) are **three faces of one underlying compliance-state
model**. The model answers, per (child, provider, requirement):

> **what is required, what is on file, what is expired, what is
> missing-and-applicable, and what doesn't apply.**

Design the model once; the three views are projections of it:
- **Score** = the aggregate rollup, opt-in per `CLAUDE.md`.
- **Checklist** = the itemized per-child view for the provider.
- **Auditor view** = a scoped, time-boxed, read-only external
  projection.

The hard problem isn't the SQL or the formula — it's **applicability**.
A field-trip consent isn't "missing" if the provider never does
field trips. An on-premises water consent isn't missing if there's no
pool. A medication permission isn't missing if the child takes no
medication. The model needs a notion of applicability per requirement
per (child, provider) that combines three sources: (a) regulatory
universal, (b) data-inferred, (c) provider-declared. Get this wrong
and the checklist is noise ("you're missing 12 things, most
irrelevant"); get it right and it's useful ("you're missing the 2
things that actually apply").

The shipped signal count clears the strategy's "don't build until
7-10 signals" gate — the audit below counts **~19 shipped, 8
unshipped** compliance-relevant signals (§2 below). The state model
and the checklist are buildable NOW. The score is buildable in
principle now, but its weighting is the part that needs real
provider data and should be tunable rather than locked. The auditor
access mode is buildable now in terms of substrate (the Edge
Function pattern works), but is the highest-risk surface and gets
built/verified last.

What this scope does NOT do: ship any of the four phases. This is
the design document that names the model, locks the decisions Seth
locks, surfaces the decisions Seth must make, and sequences the
build. Each phase becomes its own PR scope.

---

## DECISIONS — RESOLVED (and the ones Seth must make)

Mix of locked decisions and open-options. Where a decision is
genuinely Seth's call (#2 applicability mechanism, #6 score weighting,
#8 auditor access mechanism), the options are presented inline below
with my recommendation; the table entry says "Seth's call — see §X."

| # | Decision | Resolution |
|---|---|---|
| 1 | The unified state model is the right abstraction. | **LOCKED.** The score, the checklist, and the auditor view share so much underlying logic (what's required, what's on file, what's applicable) that designing them as separate features creates three places to fix every bug and three places for "what counts" to drift. One model, three projections. |
| 2 | Applicability model. | **Seth's call — see §4.** Recommendation: **hybrid (a) + (b) + (c)**, layered. Regulatory-universal applies to every (licensed-home, child) row by default; data-inferred adds requirements when their precondition data exists (e.g., a medication row → permission required); provider-declared (toggles in BusinessInfo/profile) is the explicit on/off for ambiguous categories ("we do field trips: yes/no/sometimes"). With sensible defaults so most providers never touch the toggles. |
| 3 | Compute on-read vs materialize. | **LOCKED: compute on-read first.** A pure derivation module (`src/lib/complianceState.js`) over the existing tables. The state model is the projection; the source-of-truth is the underlying rows. Materialization is a performance optimization to revisit if the read pattern proves too expensive — not a foundational architecture choice. Same posture as the existing `getChildFilesAuditState` and `pendingEnrollmentConsentsForChild`. |
| 4 | Module shape. | **LOCKED.** `src/lib/complianceState.js` exports: (1) `REQUIREMENT_REGISTRY` — the static catalog of every compliance requirement with its category, rule citation, applicability rule, type/Type 1-vs-Type 2 tag, severity; (2) `getRequirementState({ requirement, child, provider, sourceRows })` — pure verdict per requirement; (3) `getChildComplianceState({ child, provider, sourceRows })` — per-child rollup; (4) `getProviderComplianceState({ provider, children, sourceRows })` — provider-level rollup; (5) caller-side data-loader functions in a sibling `complianceStateLoader.js` that runs the Supabase queries. **Pure verdict + impure loader split** mirrors the existing `pendingEnrollmentConsentsForChild` pattern (pure verdict, caller supplies the rows). |
| 5 | Per-requirement states. | **LOCKED: 6 states.** `on_file` / `expired` / `missing_required` / `pending_parent` / `not_applicable` / `unknown`. The sixth state — `unknown` — is for "this requirement's applicability cannot yet be determined" (e.g., a provider hasn't answered the field-trip toggle). Unknown ≠ missing; it's "you need to tell us before we can score this." Drives the BusinessInfo prompts. |
| 6 | Score formula + weighting. | **Seth's call — see §5.** Recommendation: **category-bucketed weighted average**, not flat. Each category (Child Files, Staff Files, Drills, Medication, Property, Consents, Funding Docs) gets its own subscore, surfaced separately; the aggregate is the weighted mean of subscores, with licensing-critical categories (Drills, Medication role-gate, Discipline-policy ack at hire) weighted heavier. **Tunable**, not locked — the constants live in `complianceState.js` and update via PR review, not migration. |
| 7 | "Don't build until 7-10 signals" gate. | **LOCKED: cleared.** The audit below (§2) counts ~19 shipped + ~8 unshipped compliance signals. The score is buildable in principle now. **BUT**: I recommend the score ships AFTER the checklist (§9 phasing) because the checklist surfaces the underlying state to the provider FIRST — gives them a chance to correct misclassifications before the score blames them. |
| 8 | Auditor-access mechanism. | **Seth's call — see §7.** Three options laid out. Recommendation: **Option A (signed expiring link, Edge Function as the boundary)**. Lowest auth-surface increase, reuses the consent-attachment Edge Function pattern, no new account type. Cross-tenant denial is the verification gate. |
| 9 | Auditor scope shape. | **LOCKED.** Auditor session row carries: `auditor_session_id`, `provider_id`, `child_id[]` (selected children), `starts_at`, `expires_at` (default: end of day), `accessed_at[]` (audit log of every read), `revoked_at`. The auditor sees ONLY the selected children's compliance records, ONLY within the window, ONLY read. Cross-child and post-expiry are denied at the Edge Function — same caliber as the parent boundary. |
| 10 | All three faces are opt-in surfaces (default OFF). | **LOCKED.** Per `CLAUDE.md`, the compliance health score is enabled in settings; the readiness checklist is its own opt-in surface (some providers find scores stressful); the auditor mode is provider-initiated per session (always opt-in by construction — no auditor link exists until the provider creates one). Per-category MiRegistry-mirror inclusion (Type 1) is a sub-toggle within the score, default strict (Type 1 excluded). |
| 11 | Type 1 (mirror) vs Type 2 (owned) tagging. | **LOCKED per `CLAUDE.md`.** Every requirement in the registry carries a `data_authority: 'milittlecare' | 'miregistry'` tag. Score defaults to Type 2 only; per-category opt-in surfaces Type 1. Checklist shows both but visually distinguishes (a small "MiRegistry" badge). Auditor view always shows both (auditor verifies Type 1 in MiRegistry directly per R 400.1922; we surface it labeled so they know not to take ours as authoritative). |
| 12 | GSQ readiness alignment. | **LOCKED per `CLAUDE.md`.** Each requirement in the registry MAY carry a `gsq_relevant: boolean` tag. The GSQ readiness widget (future, V2/V3+ per `strategy.md`) consumes a different projection of the same registry. The two trackers stay separate surfaces; they share the substrate. |
| 13 | Schema changes for the engine itself. | **LOCKED: minimal.** Phase 1 (state model + applicability) needs: ZERO schema changes — the pure derivation reads what's there. Phase 3 (checklist) needs: a new `applicability_overrides` table (provider-declared yes/no/auto per category, per provider). Phase 4 (score) needs: a new `compliance_score_settings` table for the per-provider opt-in + per-category Type 1 sub-toggles (or extend `profiles`). Phase 5 (auditor) needs: a new `auditor_sessions` table + `auditor_session_access_log` audit trail. |
| 14 | Engine's relationship to parked items (consent parent-view bugs + trips entity). | **LOCKED.** The three parent-view bugs are applicability symptoms — the resolver shows raw type strings because no one taught it which to show per (parent, consent type). The state model resolves this once via §4's applicability layer. The "trips" entity, if/when it materializes, is an applicability INPUT to the model ("does this provider do trips" = does the trips table have rows? = yes → per-occurrence consent applies = yes). The engine welcomes it without restructuring. |
| 15 | Retention + audit-trail. | **LOCKED.** State derivations read through `archived_at IS NULL` for active state. The auditor view reads the SAME source rows under the SAME RLS through the Edge Function — service-role scope check + read-only access. Soft-delete is preserved; auditor can see what was on file during the audit window via the audit-trail rows (`archived_at` rows preserve history). Time-boxing of auditor access means the auditor is scoped to a CURRENT snapshot at most; historical-state audits are a separate scope. |

---

## §2. Signal inventory — what's actually shipped vs not

The strategy doc gates the score on "at least 5-7 (later 7-10)
component signals existing." The point of this section is to count
honestly. The score isn't blocked on count; it can be blocked on
weighting confidence.

### Shipped (production today) — ~19 compliance-relevant signals

**Child files (R 400.1907) — Category D**
1. **Intake bundle envelope + 8 sub-acknowledgments** — lead, firearms, food, safe-sleep, health, discipline-receipt, notebook-availability, rules-offered. `acknowledgments` table + `src/lib/acknowledgments.js` + `src/lib/childFiles.js`. Migrations 024/025.
2. **Enrollment consents Phase A** — field_trip_permission, photo_sharing_consent (+ revoked pair). Migration 024.
3. **Enrollment consents Phase B (annual)** — transportation_routine_annual, water_activities_on_premises_seasonal. Migration 026 (expires_at).
4. **Enrollment consents Phase C (per-occurrence)** — transportation_nonroutine_per_trip, water_activities_off_premises_per_trip. Migration 027.
5. **Children retention** — `children.archived_at` for the Rule 7 2-year retention. Migration 021.
6. **Consent attachments** — signed-paper scans, target_type = acknowledgment | medication_authorization. Migrations 029/030 + Edge Function for parent reads.

**Medication (R 400.1931) — Category B**
7. **Medication authorizations** — per (child, medication), with OTC vs non-OTC discriminant. Migration 028 + `src/lib/medication.js`.
8. **Per-medication parent permission** — `medication_permission` ack type.
9. **OTC-blanket parent permission** — `medication_permission_otc_blanket` per child.
10. **Per-dose log** — `medication_administration_events` with role-gate trigger (DB-level defense-in-depth per `CLAUDE.md`).

**Staff files (R 400.1919–1924) — Category E**
11. **Caregiver roster + regulatory roles** — `caregivers` + `caregiver_regulatory_roles`. Migration 012.
12. **CPR/First Aid expiry + new-hire 14-topic training + professional development + MiRegistry account status + background-check eligibility + health-safety updates** — `staff_training_records` + `health_safety_updates`. Migration 012 + `src/lib/staffTraining.js`.

**Funding & CDC compliance**
13. **Funding source authorization currency** — `cdc_authorization_end`-driven expiring/expired ladder (30d). `src/lib/cdcAuthorization.js`.
14. **CDC fingerprint reprint** — 5-year cycle (reminder at 4.5y, urgent at 5y). `src/lib/cdcProviderCompliance.js`.
15. **Funding document completeness** — DHS-198, Enrollment Agreement, with `retention_until` + `archived_at`. Migration 008. (Future: `blocks_billing`.)
16. **CDC pay period catalog** — Migration 010.

**MiRegistry (R 400.1922 / 1924) — Type 1 (mirror)**
17. **Annual Ongoing Training Dec-16 deadline tracker** — `src/lib/miregistry.js` + `MiRegistryWarningBanner.jsx`.
18. **Level 2 rolling expiry tracker** — 10-hour ladder, rolling reset.

**Attendance (R 400.1906 / I-Billing)**
19. **Attendance acknowledgments** — daily parent/provider channel-aware sign-off. Migration 020.

### Not yet shipped (per audit decisions) — ~8 signals

**Greenfield categories**
- **Drill log + Emergency Response Plan** (PR #19 — Category A, R 400.1939). Drill cadences (fire 3-mo, tornado 2× Mar–Nov, others annual). 2-year retention.
- **Discipline policy storage + parent-at-intake + staff-at-hire acks** (PR #17 — Category C, Rules 6/7/42).
- **Property records** (PR #21 — Category F): radon (4-yr), heating inspection (4-yr), CO detectors per level, smoke detectors per floor, fire extinguishers per floor, pet/animal notification, smoking prohibition posted, licensing notebook archive.
- **Physician attestation** of staff mental & physical health, annual (within PR #18).
- **Non-app-user caregiver arrival/departure log** (within PR #18).

**Foundational tracking gaps**
- **Annual review of child records** — Rule 7 requires a yearly review; `children.records_last_reviewed_on` slot referenced by reminder catalog (`child_annual_review`) but not yet implemented.
- **Religious objection statement** — R 400.1907(1)(d), per-family if applicable.
- **CCBC / MiRegistry API integration** (deferred per audit decision OQ4) — automated mirror of Type 1 data instead of manual capture.

### Signal-count read

Strategy gate: "don't build until 5-7 (→7-10) signals exist."
**19 shipped clears the gate.** The model and the score are
buildable now in terms of count. The reason to *still* land the
checklist before the score isn't signal count; it's that the score
needs the provider to have seen and corrected their state in the
checklist before getting blamed by a number.

---

## §3. The compliance-state model

### Core abstraction — the requirement

A **requirement** is one regulatory or program-policy obligation
with:

```
{
  id:                  'r400_1907_lead_disclosure',          // stable string key
  category:            'child_files' | 'staff_files' | 'medication' | 'drills' | 'property' | 'consents' | 'funding_docs' | 'cdc_compliance',
  rule_citation:       'R 400.1907(1)(b)(i)',                // verbatim cite
  label:               'Lead-based paint disclosure',
  description:         '…short context for UI…',
  subject_type:        'child' | 'caregiver' | 'family' | 'provider' | 'property_record' | 'medication_authorization',
  data_authority:      'milittlecare' | 'miregistry',         // Type 2 vs Type 1 per CLAUDE.md
  gsq_relevant:        boolean,                                // §12 GSQ alignment
  severity:            'critical' | 'high' | 'medium' | 'low', // unweighted bucket; tunable
  applicability:       AppRule,                                // §4
  state_resolver:      (ctx) => RequirementState,              // pure verdict from sourceRows
  expiry_resolver?:    (ctx) => Date | null,                   // for time-bound types
}
```

Each requirement is one row in a frozen `REQUIREMENT_REGISTRY`
exported by `src/lib/complianceState.js`. The registry is the
single canonical list of "what does compliant mean as data."
Adding a category = adding registry entries; nothing else.

### Per-requirement state — six values

```
type RequirementState =
  | { kind: 'on_file', evidence: AckRow | StaffRow | DocRow | ..., expires_at: Date | null }
  | { kind: 'expired', evidence: row, expired_at: Date }
  | { kind: 'missing_required', last_attempted_at: Date | null }
  | { kind: 'pending_parent', request_sent_at: Date }    // intake portal "sent but not signed"
  | { kind: 'not_applicable', reason: string }            // per §4
  | { kind: 'unknown', missing_input: string }            // §4 — toggle not yet answered
```

`unknown` is the state that drives "tell us your situation"
prompts. It is NOT counted as missing. It's the gap that produces
the BusinessInfoPage applicability toggles' "answer this" badges.

### The shape — pure + impure

Mirrors `pendingEnrollmentConsentsForChild`'s pattern from Phase B:

```
// PURE — caller supplies the rows; verdict is deterministic, testable.
//   sourceRows is a typed object of all loaded rows (acks, meds, drills, etc.)
//   keyed by table; the verdict reads only what each requirement's
//   state_resolver needs.
getRequirementState({ requirement, child, provider, sourceRows }): RequirementState
getChildComplianceState({ child, provider, sourceRows }):    PerChildState
getProviderComplianceState({ provider, children, sourceRows }): ProviderState

// IMPURE — separate module (`complianceStateLoader.js`).
loadComplianceSourceRows({ providerId, childIds }): Promise<SourceRows>
```

The pure side is unit-testable without a Supabase mock. The impure
side is a thin async wrapper that fans out the queries (parallel,
deterministic). The two existing patterns (`getChildFilesAuditState`
+ `pendingEnrollmentConsentsForChild`) are folded INTO the new
module as the first migration step — they become projections of
`getChildComplianceState` over the child-files + enrollment-consents
subset of the registry, with the existing return shapes preserved
for backward-compat call sites until those are migrated.

### The aggregate shape

```
PerChildState = {
  child_id: uuid,
  category_states: {
    child_files:   { requirements: RequirementResult[], score: 0-100, status: 'green'|'yellow'|'red' },
    medication:    { ... },
    consents:      { ... },
    ...
  },
  any_pending:        boolean,   // anything not on_file/not_applicable
  any_expired:        boolean,
  any_unknown:        boolean,   // need provider input (drives BusinessInfo prompt)
  applicable_count:   number,
  on_file_count:      number,
  expired_count:      number,
  pending_count:      number,
}

ProviderState = {
  provider_id: uuid,
  per_child: PerChildState[],
  provider_level: {
    // Provider-level requirements (drills, property, staff)
    category_states: { drills: {...}, property: {...}, staff_files: {...}, funding_docs: {...}, cdc_compliance: {...} },
  },
  aggregate: {
    score: 0-100,           // §5 — weighted across categories
    subscores: {            // §5 — surfaced separately
      child_files: 0-100, staff_files: 0-100, medication: 0-100, ...
    },
    health: 'green' | 'yellow' | 'red',
  },
}
```

### What this does NOT do

- Does NOT enforce. A missing requirement does not block billing /
  attendance / messaging. The engine REPORTS state; downstream
  surfaces decide what to do with it (the funding-docs
  `blocks_billing` boolean from `strategy.md` is one enforcement
  hook that exists separately).
- Does NOT mutate. Pure verdicts only. Captures, re-acks, archives
  continue to flow through the existing per-domain helpers
  (`recordIntake`, `recordMedicationPermission`,
  `recordDoseEvent`, etc.).
- Does NOT replace the per-domain audit helpers wholesale. It
  generalizes them. The existing `getChildFilesAuditState` becomes
  a thin wrapper that calls into the unified state model over a
  category subset, with the existing return shape preserved until
  callers migrate.

---

## §4. The applicability problem — the hard one

### Why this is the load-bearing decision

If applicability is wrong, the checklist is noise. The default
should be "the provider sees only what actually applies to them
and their kids." A licensed home doesn't see LEP-only categories;
a private-pay child doesn't surface CDC requirements; a child
with no medication shouldn't show a missing medication permission;
a provider who doesn't do field trips shouldn't see a missing
field-trip consent.

Three sources of applicability, layered:

### (a) Regulatory-universal — applies to every (license_type, child) row

Some requirements apply to every child in a given license context,
unconditionally:

- Licensed home + any child → intake bundle's universal items
  (food-provider, discipline-receipt, infant-safe-sleep IF under
  18mo, notebook-availability, rules-offered).
- Licensed home + provider-level → drill log, emergency response
  plan, licensing notebook, smoke/CO/extinguisher checklist.
- Licensed home + any caregiver → CPR/First Aid expiry, MiRegistry
  account, background-check eligibility.
- License-exempt + provider → MiRegistry annual ongoing training
  (Dec 16), Level 2 expiry tracker if Level 2 claimed.

Already gated via `license_type` in `modules.js` (migration 022).
The state model reads the same gating.

### (b) Data-inferred — applies when a precondition row exists

Some requirements are CONDITIONALLY applicable based on data the
provider has already entered:

- Child has `home_built_before_1978 = true` on the provider's
  profile → lead disclosure applies (currently gated this way in
  `requiredSubTypesForChild`).
- Provider has `firearms_on_premises = true` → firearms disclosure
  applies.
- A `medication_authorization` row exists for a child → the
  per-medication permission applies to that authorization.
- A non-OTC medication authorization exists → the role-gate state
  applies (dose log + caregiver eligibility).
- A `parent_family_links` row exists in `parent_status='active'`
  → photo-consent applies (the consent is meaningful only when a
  parent is reachable in the portal).
- Child has `date_of_birth` putting them under 18 months → safe-
  sleep applies (it's already gated this way in
  `requiredSubTypesForChild`).
- Child has any `attendance` row → daily attendance acknowledgment
  applies (otherwise the child hasn't been in care yet).

The pattern: a requirement's `applicability` rule is a small pure
function `(child, provider, sourceRows) => 'applies' | 'does_not_apply' | 'unknown'`
that reads the same `sourceRows` the state resolver does.

### (c) Provider-declared — explicit yes/no/auto toggles

Some categories don't have a clean data-inferred precondition AND
don't apply universally. The provider has to tell us:

- **Field trips:** do you do non-vehicle field trips? (yes/no/sometimes)
  Today the field-trip consent is in the registry as a Rule 7-class
  enrollment consent; the question of whether IT APPLIES at all to
  this provider is unanswered today.
- **Routine transportation:** do you transport children routinely
  (same day/time/destination per week)? (yes/no)
- **On-premises water activities:** do you have a pool, kiddie
  pool, or other on-premises water feature? (yes/no/seasonal)
- **Off-premises water activities:** do you take children to public
  pools / beaches / etc.? (yes/no)
- **Animal/pet on premises:** R 400.1937(?) — yes/no.
- **Religious objection statements** — applicable per-family if
  the family invokes it. Provider-declared per-family toggle, not
  provider-wide.

#### Three modes per toggle

`'auto'` (default) — let the data infer. If a per-occurrence trip
ack exists, "we do trips" is inferred true; if a medication exists,
"meds applies" is inferred true. `'yes'` — applies regardless of
data. `'no'` — does not apply, regardless of data. The `'auto'`
default keeps existing providers from having to fill out toggles
before they see anything; the explicit modes are for the edge cases.

#### Storage

New table `compliance_applicability_overrides`:

```
id, provider_id, category_or_requirement_key, mode ('auto'|'yes'|'no'),
  per_family_id (null = provider-wide), per_child_id (null = provider-wide),
  set_at, set_by_user_id, notes
```

Per-family granularity is needed for religious-objection-class
statements; per-child granularity is rarely needed but the schema
supports it.

The setting lives in `BusinessInfoPage` under a new "What applies
to my program?" section that's collapsed by default. The
`'unknown'` state in §3 (no toggle answered yet, no data inference,
not regulatory-universal) is what triggers the BusinessInfoPage
prompt to surface the question.

### Recommended applicability resolution order

```
function isApplicable(requirement, child, provider, sourceRows):
  // 1. Explicit override (provider-declared)
  let override = lookupOverride(requirement, provider, child?.family_id, child?.id)
  if (override === 'yes') return 'applies'
  if (override === 'no')  return 'does_not_apply'

  // 2. Regulatory-universal
  if (requirement.applicability.universalFor.includes(provider.license_type)) {
    // optionally narrow by child characteristics (age, etc.)
    if (requirement.applicability.childGate?.(child) === false) return 'does_not_apply'
    return 'applies'
  }

  // 3. Data-inferred
  let inferred = requirement.applicability.inferFromData?.(child, provider, sourceRows)
  if (inferred === 'applies' || inferred === 'does_not_apply') return inferred

  // 4. Unknown — needs provider input
  return 'unknown'
```

### Connection to the parked parent-view bugs

The three parent-view consent bugs (raw type string,
per-occurrence miscategorization, no per-occurrence parent surface)
each reduce to "the parent-side resolver doesn't know which
requirements apply to THIS family's children." The applicability
layer above is that knowledge. When the engine ships, the parent
resolver is one of the consumers — it asks "which requirements
apply to (child, family) where this parent has access?" and
renders only those.

### Connection to a future trips entity

If/when a `trips` table materializes (per the per-occurrence consent
parked design question), it becomes an applicability INPUT:

```
applicability.inferFromData: (child, provider, sourceRows) => {
  if (sourceRows.trips.any(t => t.archived_at === null)) return 'applies'
  return 'unknown'
}
```

No engine restructuring required.

### Recommended decision

**Hybrid — all three layered, in the resolution order above,
defaulting to `'auto'` for any provider-declared toggle.** This
gives existing providers no new prompts they MUST answer to keep
using the app (the audit-state UI works because regulatory-
universal + data-inferred already cover the bulk); it gives
the checklist a clean answer for the unambiguous cases; and it
flags genuinely-ambiguous cases as `'unknown'` so they're prompts,
not silent miscategorizations.

---

## §5. The score — formula sketch + the weighting question

### Locked: shape

- Category subscores (Child Files, Staff Files, Medication, Drills,
  Property, Consents, Funding Docs, CDC Compliance) — each 0-100.
- Aggregate score — weighted mean of subscores.
- Health bands: green ≥ 90, yellow 70-89, red < 70 (tunable).
- Surface: opt-in widget on the dashboard; default OFF per
  `CLAUDE.md`. Per-category Type-1 (MiRegistry mirror) inclusion is
  a sub-toggle within the score's settings, default strict (Type 1
  excluded from the score; visible in the checklist regardless).

### Per-category subscore — formula sketch

```
For each requirement in the category that is applicable for this provider:
  weight =
    + 3 if severity = 'critical'   (drills, role-gate dose, hire-time discipline ack)
    + 2 if severity = 'high'       (medication permission, intake bundle item)
    + 1 if severity = 'medium'     (enrollment consent, annual review)
    + 0.5 if severity = 'low'      (provider-protective only, e.g. photo)

  contribution =
    + weight        if state = 'on_file'
    + 0             if state = 'expired'  or 'missing_required' or 'pending_parent'
    (skipped)       if state = 'not_applicable' or 'unknown'

subscore = sum(contribution) / sum(weight) × 100
```

### Aggregate score

```
aggregate = weighted_mean(subscores, category_weights)

category_weights (tunable, NOT locked):
  child_files:    3  (intake bundle is the spine of Rule 7 compliance)
  staff_files:    3  (R 400.1919-1924, deep regulatory surface area)
  medication:     3  (R 400.1931, real legal exposure on role-gate)
  drills:         2  (R 400.1939, inspector-visible)
  property:       2  (R 400.19xx, mostly periodic)
  consents:       2  (R 400.1907/1934/1952, deep but ack-shaped)
  funding_docs:   1  (CDC documentation; matters when CDC active)
  cdc_compliance: 1  (CDC-only, fingerprint reprint etc.)
```

### Seth's call — weighting

The numbers above are my best first cut. They are NOT load-bearing
for the engine itself — the engine produces the per-requirement
state; the score formula is a layer on top, tunable without
schema changes. Weighting should iterate against real provider
data once the checklist is in use. The doc captures the proposal;
Seth tunes from real reactions.

### Why the score ships AFTER the checklist

Three reasons, in priority order:

1. **The checklist surfaces misclassifications.** If applicability
   is wrong for a provider, the checklist lets them tell us before
   the score blames them.
2. **The score without the checklist is "you're 73%" with no
   explanation.** The checklist IS the explanation. Reverse the
   order and providers will distrust the score because they can't
   see what's wrong.
3. **Weighting needs real data.** Shipping the checklist first
   means we see what providers click on, what they care about, what
   they ignore — the signal for tuning the score's weights.

### Type 1 (MiRegistry mirror) inclusion

Per `CLAUDE.md`'s Type 1 / Type 2 distinction:

- **Score**: Type 1 excluded by default. Per-category sub-toggle
  to include in score; defaults off.
- **Checklist**: Type 1 shown but visually tagged as MiRegistry
  data ("Verify in MiRegistry — we mirror the date you entered").
- **Auditor view**: Type 1 always shown, tagged ("Provider's
  MiRegistry mirror — verify in MiRegistry per R 400.1922").

Rationale: an auditor verifies Type 1 in MiRegistry directly; we
should not pretend our mirror is authoritative.

---

## §6. The readiness checklist — provider self-check

The simplest projection of the state model. Per-child surface
("Audrey's compliance file") + provider-level surface (drills,
property, staff).

### UI shape (sketch)

- Family modal → new "Compliance" tab per child (when
  `license_type in (family_home, group_home)`).
- Shows category cards (Child Files, Consents, Medication if
  applicable, Attendance).
- Each card lists requirements with state:
  - ✓ On file (since YYYY-MM-DD, renews YYYY-MM-DD if expiring)
  - ⚠ Expired YYYY-MM-DD — renew now
  - ✗ Missing — needs (parent signature / your attestation / etc.)
  - ⏱ Pending parent — sent YYYY-MM-DD, awaiting confirmation
  - (Not shown by default) — Not applicable
- Each Missing/Expired item has a one-click action (opens the
  existing capture modal).

- Provider-level surface — new "Compliance" sidebar item under
  the dashboard, with the same shape for provider-level
  categories (Drills, Property, Staff).

### Inspection-prep mode

A "print / export" affordance that produces a clean
PDF / printable view of the checklist for any selected children +
the provider-level categories. Use case: provider prints
the day before an inspection so they can walk in with a paper
binder. Reuses any future PDF rendering substrate; if none
exists, browser print of a clean route is the V1.

### Opt-in surface

Per `CLAUDE.md`: providers can disable the Compliance tab if they
find it stressful. Default state for new providers: ON
(differentiator on the box); existing providers default OFF
during the rollout phase to avoid surprise. Settings toggle in
BusinessInfoPage.

---

## §7. Auditor access mode — the highest-risk piece

### The actor

A Michigan licensing inspector. Until now we have two actor classes:
provider (full-tenant) and parent (cross-tenant, scoped to linked
families). An auditor is a third class: **external, time-boxed,
read-only, child-list-scoped**. The boundary needs the same
caliber of verification as the parent boundary that we just shipped
and verified (consent-attachments).

### Three options for the access mechanism

#### Option A — Signed expiring link via the Edge Function (RECOMMENDED)

The provider, from a BusinessInfoPage "Auditor access" panel,
creates a session: picks which children to expose, picks an
expiry (default end-of-day), picks an optional auditor name/email
for the audit log. The app creates an `auditor_sessions` row and
generates a signed URL of the form:

```
https://milittlecare.com/auditor/inspect?session=<opaque-token>
```

The token is the row's `id` (UUID) plus a HMAC-signed payload
proving it wasn't fabricated client-side. The auditor opens the
link in any browser (no signup, no signin).

The `/auditor/inspect` route is served by a new Edge Function
(`api/auditor-view.js`) that, like the consent-attachments
function, runs service-role and performs scope checks IN CODE:

```
1. Verify the signed token. Decode session_id + signature.
2. Load auditor_sessions row by session_id.
   - Deny if missing.
   - Deny if revoked_at IS NOT NULL.
   - Deny if expires_at <= now().
3. For every read the auditor makes (child detail, ack, attachment,
   medication record, staff record), check the requested resource
   resolves to a child_id IN session.child_id[].
   - Deny anything else (404, NOT 403 — anti-enumeration, same
     pattern as the consent-attachment function).
4. Log every read into auditor_session_access_log (session_id,
   read_resource_type, read_resource_id, read_at, ip_address).
```

**Pros:**
- No new auth concept. The token IS the auth.
- Same shape as the consent-attachment boundary — provable.
- Auditor signs in to nothing; minimum friction.
- Time-bound by construction; expiry enforced server-side.
- Read-only by construction; the function exposes no mutation
  paths.
- Full audit log of every read (a court-quality artifact).

**Cons:**
- A leaked link IS the access. Mitigation: scoped child list +
  short expiry + optional auditor-name/email for the log; auditor
  acknowledges receipt by name in a small "who are you" form on
  first open (recorded for the log, not gating access).
- No two-factor.

**Recommended.** Lowest auth-surface increase, reuses proven
pattern, satisfies all constraints.

#### Option B — Temporary auditor user account

Create a real `auth.users` row with a magic-link login, scoped via
an `auditor_sessions` row that names allowed children + expiry.
Auditor signs in by email magic link.

**Pros:**
- Auditor's identity is captured by the auth system (real email).
- Magic link is replayable but expires quickly.

**Cons:**
- Adds a third user_type to the schema (auth.users now has
  provider / parent / auditor — RLS policies on every table grow
  another branch).
- Magic-link UX is harder for a licensing inspector in the field
  (they need email access on a phone, etc.).
- RLS-driven scope is harder to verify than a single Edge
  Function's scope check.

Not recommended unless Option A's "leaked link is the access"
risk is unacceptable.

#### Option C — Provider screenshares / "show inspector mode"

A read-only mode the provider activates on their own device,
hiding mutation UI; no separate auditor account exists. Like
turning the screen around.

**Pros:**
- No new auth surface at all.

**Cons:**
- The auditor sits with the provider, can't take the link home,
  can't share the link with their supervisor.
- Doesn't satisfy "the inspector sits down later and reviews
  their notes against the app."
- The provider IS the access — every audit is in-person.

The provider can already do this (just navigate to the existing
surfaces with mutations skipped). It is the no-cost fallback if
Option A is deferred; it doesn't replace a real auditor surface.

### Recommended: Option A. Sketched scope below.

### Schema

New tables:

```
auditor_sessions (
  id                     uuid PRIMARY KEY,
  provider_id            uuid NOT NULL REFERENCES profiles(user_id),
  child_id               uuid[] NOT NULL,        -- which children's records
  starts_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,    -- typically end-of-day, capped at +24h
  revoked_at             timestamptz,             -- provider can revoke mid-session
  auditor_label          text,                    -- "Jane Smith, MiLEAP Region 3" (optional)
  auditor_acknowledged_at timestamptz,            -- first-read "who are you" submission
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
)

auditor_session_access_log (
  id                     uuid PRIMARY KEY,
  session_id             uuid NOT NULL REFERENCES auditor_sessions(id),
  read_resource_type     text NOT NULL,           -- 'child' | 'acknowledgment' | 'medication' | 'attachment' | 'staff' | 'drill_log' | etc.
  read_resource_id       uuid NOT NULL,
  read_at                timestamptz NOT NULL DEFAULT now(),
  ip_address             inet,
  user_agent             text
)
```

RLS posture:
- `auditor_sessions`: SELECT/INSERT/UPDATE policies for the
  provider (provider_id = auth.uid()). Auditor itself doesn't
  authenticate against Supabase, so no auditor-side RLS — the
  Edge Function reads with service-role.
- `auditor_session_access_log`: insert-only via the Edge Function.
  Provider SELECT for their own sessions.

### The Edge Function — scope-check shape

```
POST /api/auditor/read
body: { session_token, resource_type, resource_id (optional) }

1. Verify HMAC of session_token against the active signing key.
   If invalid → 401 / 404 collapsed (anti-enumeration).
2. Extract session_id; load auditor_sessions row.
3. If row missing / revoked_at IS NOT NULL / expires_at <= now() → 404.
4. Resolve resource_type to a child_id:
   - 'child'                  → resource_id
   - 'acknowledgment'         → ack.subject_type='child' → ack.subject_id (else deny chain)
   - 'medication_authorization' → med_auth.child_id
   - 'consent_attachment'     → resolve via existing pattern in api/consent-attachment-url.js
   - 'caregiver' | 'drill_log' | 'property_record' → provider-scoped, no child resolution; deny unless session.scope_includes_provider_level (separate boolean on auditor_sessions)
5. Confirm resolved child_id is in session.child_id[]. Else → 404.
6. Read the resource via service-role.
7. Insert auditor_session_access_log row.
8. Return the resource (read-only DTO; never the raw row if it
   contains anything outside scope).
```

The function never accepts mutations. It exposes only typed read
endpoints, each one going through scope check.

### The verification gate

**Same caliber as the parent cross-tenant gate.** Concretely, the
following live tests on the preview environment, against real seed
rows:

1. **Create session A for provider P, children [C1, C2], expires
   in 1 hour.** Auditor opens the link. Confirms they can read
   C1's intake bundle, C2's medications.
2. **Same auditor link → request C3 (not in session).** Server
   returns 404. Log records the denied attempt.
3. **Same auditor link → request P's other child C4 via direct
   child_id.** Returns 404. Log records the denied attempt.
4. **Same auditor link → request a child belonging to a different
   provider entirely (cross-tenant).** Returns 404. Log records
   the denied attempt.
5. **Wait until session expires; same auditor link → any read.**
   Returns 404. Log records the denied attempt.
6. **Provider revokes session mid-test; auditor's next read.**
   Returns 404. Log records the denied attempt.
7. **Tampered token (one byte changed in the signature).**
   Returns 404 BEFORE the session_id is loaded (HMAC fails first).
8. **Re-issue: provider creates a new session for [C1] only.
   Confirm auditor can read C1 again but NOT C2.**

Each test must produce a row in `auditor_session_access_log` so
the audit-of-audits is itself complete.

This gate is the build-PR gate. The auditor mode does NOT ship
until all eight live tests pass on the preview environment with
service-role logging confirming the denial path.

### Phasing this separately

Build the auditor mode as **the last phase** (Phase 5 below) on
its own branch, with its own scope doc, its own verification gate,
its own merge. It depends on the state model (built in Phase 1) and
the checklist projection (Phase 3) but otherwise stands alone.

---

## §8. Build phasing — recommended sequence

Each phase is its own PR scope, its own branch.

### Phase 1 — State model + applicability + audit-state expansion (foundation)

**What ships:**
- `src/lib/complianceState.js` with `REQUIREMENT_REGISTRY` (the
  ~25-30 currently-shipped requirements registered) +
  `getRequirementState` + `getChildComplianceState` +
  `getProviderComplianceState`.
- `src/lib/complianceStateLoader.js` — Supabase fan-out loader.
- New table `compliance_applicability_overrides` (per §4 storage).
- Backward-compat refactor: `getChildFilesAuditState` becomes a
  thin wrapper over `getChildComplianceState`, preserving its
  current return shape. `pendingEnrollmentConsentsForChild` same.
- New BusinessInfoPage section: "What applies to my program?" —
  collapsed by default, with the applicability toggles for the
  ambiguous categories (field trips, routine transport, water
  on-prem, water off-prem, animals, etc.). Default mode = 'auto'.
- Comprehensive test suite over the registry + applicability
  resolver + per-requirement state resolvers + the aggregate
  rollup.

**Schema change:** one new table (applicability overrides).

**No UI surface yet beyond BusinessInfoPage toggles.** This is
foundation; existing surfaces continue working unchanged.

**Difficulty:** **L.** Cataloging the registry is the bulk of it;
the rest is patterns we already have. 1–2 weeks.

**Dependencies:** none other than what's already shipped.

**Risk:** The applicability decisions in §4 must be reviewed
carefully before this lands — they're load-bearing for every
phase after.

### Phase 2 — Audit-state wins (no new UI surface, internal consolidation)

**What ships:**
- Migrate every existing audit-state consumer to call the new
  module (parent banner, parent panel, provider intake modal,
  provider enrollment-consents modal, medication modal, dashboard
  widgets).
- Delete the inline `pickActive` / per-domain audit helpers as
  call sites move over.
- The three parent-view consent bugs (raw type string, per-occurrence
  miscategorization, no per-occurrence parent surface) are fixed
  HERE by virtue of consuming the unified resolver.

**Difficulty:** **M.** Mechanical refactor with careful testing
per call site. 1 week.

**Dependencies:** Phase 1 lands.

### Phase 3 — Readiness checklist (the first user-visible surface)

**What ships:**
- Family modal → new "Compliance" tab per child.
- Dashboard → new "Compliance" sidebar item with provider-level
  categories.
- Per-category cards, per-requirement rows, click-through to
  existing capture modals.
- Inspection-prep print/export view (V1: clean print route, no
  PDF generation).
- Opt-in toggle in settings (per `CLAUDE.md`); default ON for new
  providers, OFF for existing during rollout.

**Schema change:** none.

**Difficulty:** **M.** Mostly UI; the state model and the
applicability layer do the heavy lifting. 1–2 weeks.

**Dependencies:** Phase 1.

### Phase 4 — Compliance health score

**What ships:**
- The score formula + per-category subscores + aggregate +
  banded health (green/yellow/red).
- Dashboard widget showing the score (opt-in).
- Per-category Type-1 inclusion sub-toggles in settings.
- New `compliance_score_settings` table (or columns on profiles)
  for the opt-in + sub-toggles.
- Documentation of the formula in user help (one short page
  explaining what feeds it).

**Difficulty:** **M.** Score math is small once §5 weighting is
locked. The settings UI is the largest piece. 1 week.

**Dependencies:** Phase 3 (the checklist) is in front of providers
first, so they can correct their state before being scored.

**Tunability:** the weights live in code, not in the DB, so
adjusting them is a code change + deploy — same posture as the
severity ladder in `cdcProviderCompliance.js`. They are NOT
per-provider configurable.

### Phase 5 — Auditor access mode (highest-risk, last)

**What ships:**
- New `auditor_sessions` + `auditor_session_access_log` tables
  (§7 schema).
- New Edge Function `api/auditor/read.js` (§7 scope-check shape).
- New BusinessInfoPage panel "Auditor access" for session
  creation / revocation / log review.
- New `/auditor/inspect` route (provider-side none; this is an
  external-facing route that renders the scoped view).
- The eight-step verification gate (§7) runs on preview against
  real seed rows before any merge.

**Difficulty:** **L.** Security-critical; the verification gate
is the gate. 1.5–2 weeks including the live verification.

**Dependencies:** Phase 1 (state model is what gets exposed), and
ideally Phase 3 (the auditor's read view is the checklist's
projection, so we already have the UI building blocks).

**Why last:** new auth surface, new actor class, new attack
surface. Want every other piece stable so the auditor work isn't
debugging engine bugs in addition to access bugs.

### Total elapsed (rough)

5–7 weeks of build for all five phases. Plenty of room inside the
late-July 2026 licensed-home compliance window — assuming the
six core compliance category PRs (#16–#21) land in parallel /
ahead, which is the current sequencing.

---

## §9. Cross-cutting

### Parked items the engine subsumes

- **Three parent-view consent bugs** (raw type string,
  per-occurrence miscategorization, no per-occurrence parent
  surface). Phase 2 resolves them by routing the parent resolver
  through the unified state model. Don't fix them separately
  before then — fix them once, where the applicability layer is.

- **"Trips" entity (per-occurrence consents)**. The model
  treats it as an applicability input (§4); no engine restructuring
  required when/if the trips table materializes.

- **Compliance health score (V3+)** — this engine IS the score's
  substrate.

- **GSQ readiness (V2/V3+)** — separate projection of the same
  registry via the `gsq_relevant` tag (§12).

- **CLAUDE.md "audit state vs GSQ readiness are related but
  distinct"** — the model treats them as two projections of one
  registry; both ship as opt-in default-OFF; the model never
  conflates them.

### State-modernization-hedge alignment

Per `strategy.md`'s "PRIORITIZE features that survive state
modernization":

- **Compliance intelligence (rules engine, blocking conditions,
  scoring)** — THIS engine IS that intelligence.
- **Document intelligence (expiration tracking, requirement engine
  per program)** — the registry's expiry resolvers + applicability
  per program.
- **Audit packet generation (one-click date-range bundle of
  records)** — the inspection-prep export from Phase 3 + the
  auditor view from Phase 5 together cover this.
- **Multi-program coordination (CDC + Tri-Share + CACFP +
  licensing in one view)** — the applicability layer per program
  + the category projections.

The engine IS the durable moat per the strategy. If Michigan
modernizes I-Billing tomorrow, the engine still owns "what's
compliant" — which is the harder problem and the one the state
can't solve for providers.

### Retention + audit-trail implications

- **State reads through `archived_at IS NULL`** for current state.
  Archived rows are preserved per `CLAUDE.md`'s never-hard-delete
  rule and surface in the audit trail (e.g., "this consent was
  revoked YYYY-MM-DD").
- **Score and checklist read current state only.** The score is a
  point-in-time view.
- **Auditor view reads current state by default**, but reads
  historical state for the audit window if the session covers it
  — auditor needs to know what was on file during the period
  being inspected. Specifically: requirements are evaluated as of
  `now()` for the session, but the EVIDENCE rows shown (acks,
  dose log, drill log) include archived rows within the session's
  expressed audit window (a separate session field if/when this
  use case proves real; V1: current state only).
- **The auditor access log itself is retained** per
  `CLAUDE.md`'s never-hard-delete rule. Auditor session log
  becomes part of the provider's own audit trail.

### Type 1 (mirror) vs Type 2 (owned) handling — recap

- Score: Type 1 excluded by default.
- Checklist: Type 1 shown, tagged.
- Auditor view: Type 1 always shown, tagged "verify in MiRegistry."

The data_authority tag on every requirement is the substrate.

### GSQ alignment

Each requirement carries a `gsq_relevant: boolean` tag. The future
GSQ readiness widget consumes a different projection of the same
registry (with its own weighting). The two trackers stay separate;
the substrate is shared.

### Opt-in defaults

Per `CLAUDE.md`:
- Score → opt-in (settings toggle), default OFF.
- Checklist → opt-in (settings toggle), default ON for new
  providers, OFF for existing during rollout.
- Auditor mode → opt-in by construction (no link until the
  provider creates one).
- Per-category Type 1 inclusion in the score → opt-in sub-toggle,
  default OFF (strict).
- Reminder categories tied to compliance state (e.g., "alert me
  when a child's intake bundle expires") → opt-in per
  `reminderCategories.js`'s convention; transactional flag NOT
  applied (these are state-driven, not provider-action-driven).

---

## §10. Open questions for Seth

Big calls Seth needs to make. Each names a default if Seth has no
preference.

1. **Applicability decision (§4).** Default to my recommendation:
   hybrid (a) + (b) + (c) layered, with `'auto'` as default mode
   for provider-declared overrides. If Seth wants pure
   provider-declared (every category requires a toggle answer
   before counting), the engine supports that — set every
   provider-declared category's mode default to `'no'` until
   explicitly answered. Cost: significantly more upfront prompts
   for existing providers.

2. **Score weighting (§5).** Default: the sketched weights above.
   Seth tunes after Phase 3 ships and real provider data lands.

3. **Auditor access mechanism (§7).** Default: Option A (signed
   expiring link via Edge Function). Seth could choose Option B
   (magic-link auditor user account) if "no auditor email
   captured" is unacceptable, but Option B costs significantly
   more in RLS surface area and verification work.

4. **Checklist default state for existing providers.** Default:
   OFF during rollout (existing providers explicitly opt in).
   New providers: ON.

5. **Inspection-prep export format.** V1 default: clean print
   route, browser-printable. PDF generation can come later.

6. **Auditor session length default.** Default: end-of-day in the
   provider's timezone, capped at +24 hours. Settable per session.
   Inspector ought to finish in a day.

7. **Auditor scope_includes_provider_level boolean.** Default:
   true (the auditor needs to see drills, property, staff). The
   session UI just confirms what's included.

8. **Phase 4 (score) vs Phase 5 (auditor) order.** Default: Phase 4
   first (score), Phase 5 last (auditor). If Seth wants the
   auditor mode for an upcoming inspection, Phase 5 can be pulled
   forward — independent of Phase 4.

9. **GSQ-relevance tagging in the registry.** Default: every
   requirement gets a `gsq_relevant: boolean` (mostly conservative
   `false`; specific tags follow when the GSQ surface scopes).

10. **Compliance-score reminder hooks.** Should expiring/missing
    items in the registry auto-suggest reminder categories (e.g.,
    "We notice your drill schedule has a gap — turn on Drill Due
    Soon reminders?"). Default: no auto-prompts in V1; surface in
    a future reminder-recommendations pass.

---

## §11. Out of scope (explicitly deferred)

Named so they're not silently absorbed.

- **Materialized state cache.** Compute on-read (decision 3).
  Revisit if the read pattern proves expensive.
- **Per-provider score weighting.** Weights live in code (one
  set for all providers). Per-provider weight customization is a
  later product call; almost certainly not needed.
- **Score history / trend chart.** "Your score over time" is a
  V2+ visualization on top of point-in-time scores.
- **Auditor-side annotation / sign-off.** The auditor sees the
  records; they don't annotate. Inspection findings are their
  own document outside the app.
- **Multi-auditor concurrent sessions on same children.**
  Allowed by schema (multiple `auditor_sessions` rows can overlap);
  no UI conflict resolution needed in V1.
- **Auditor mobile-optimized view.** Phase 5 V1 is desktop +
  tablet. A licensing inspector typically has a laptop on
  inspection visits.
- **Real-time score updates over websockets.** V1: score
  refreshes on page load + on category-state changes the user
  triggers.
- **Automatic CCBC / MiRegistry API integration.** Per the
  audit decisions, these stay manual capture; the engine consumes
  whatever the existing tables hold.
- **Score-driven enforcement.** The engine REPORTS state; it does
  not block billing / attendance / messaging based on score. The
  funding-docs `blocks_billing` hook (separate scope per
  `strategy.md`) is enforcement; the score is not.
- **GSQ readiness widget itself.** Future PR; the registry tag is
  the only substrate change in this scope.

---

## Halt for review — what Seth reads next

This doc, with these focus areas:

1. **§4 Applicability** — my recommendation (hybrid + `'auto'`
   defaults) is the load-bearing call. If Seth disagrees on
   ANY of the three layers, Phase 1's scope changes.
2. **§7 Auditor access mode (Option A vs B)** — the
   highest-risk decision. Option A is my recommendation; the
   verification gate sketched in §7 is the build-PR gate
   regardless of which option is chosen.
3. **§5 Score weighting** — the proposed weights are a first cut;
   real tuning happens after Phase 3.
4. **§8 Phase sequence** — Phase 1 (foundation) → Phase 2
   (refactor consumers) → Phase 3 (checklist) → Phase 4 (score)
   → Phase 5 (auditor). Seth's call if priorities shift.

After Seth reads + reacts, the immediate next step is **Phase 1's
own scope doc** (`docs/pr-compliance-engine-phase-1-scope.md`)
detailing the registry contents requirement-by-requirement and
the applicability rules for each. That doc becomes the build
contract; the build PR follows.

Status remains **DRAFT for review** until that next round.

---

**End of compliance-engine scope doc — DRAFT.** No code, no
migration, no commit, no branch. Untracked. Halting for review.
