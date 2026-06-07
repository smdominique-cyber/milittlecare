# PR Scope — Compliance Engine loader shape change (§2a three-way: loaded-empty vs absent)

**Date:** 2026-06-06
**Status:** Scope — **DRAFT.** Doc only. The Part 1 blast-radius
audit is the primary deliverable; Part 2's design is the
recommendation, not a build contract yet.
**Parent context:** `docs/Compliance Corrections.md` Phase 1 found
that the §2a three-way fix on the CDC-gated rows (G2, G3, H1, and
the now-deleted G1) is blocked by a loader limitation. The
H1-corrections branch (`feature/h1-cdc-gating`, commit `01a33ee`)
documents the limitation in worksheet Maintenance Note #4 and ships
the other six corrections, but Part 1's §2a fix waits on the
loader change scoped here.
**Branch (suggested for the eventual build):**
`feature/compliance-loader-loaded-signal` — single PR covering the
loader change + the resolver opt-in plumbing per Part 2's
recommendation.
**Schema change:** **ZERO.** This is a loader-shape change in the
JS layer. No DB column, no migration, no RPC, no table.

---

## Summary

`src/lib/complianceStateLoader.js`'s `safeQuery` helper (lines 43-56)
returns `[]` for three structurally indistinguishable cases:

1. **Genuine empty result set** — the query ran successfully and
   the table truly has zero rows for this provider (e.g., a
   private-pay-only provider's `funding_sources` filter for
   `type='cdc_scholarship'` returns zero).
2. **PostgREST error** — RLS rejection, schema mismatch, malformed
   filter, etc. `result.error` is non-null, the helper returns
   `[]`.
3. **Thrown exception** — network blip, supabase-js bug, etc. The
   `catch (err)` returns `[]`.

The resolver downstream sees `sourceRows.<table> = []` in all
three cases and cannot distinguish them. **For every requirement
whose applicability or state depends on a sourceRows table,** the
§2a principle ("never silently resolve a real regulatory
requirement to `not_applicable` without affirmative basis") is
silently violated whenever case (2) or (3) fires. The four
CDC-gated rows are the immediate motivation, but the violation
exists across the full registry — Part 1's audit below quantifies
it.

This doc has two halves:

- **PART 1 — blast-radius audit** (the load-bearing deliverable).
  Per-requirement table of every sourceRows table read, what `[]`
  currently means for that row, and what changes under a
  loaded/failed signal.
- **PART 2 — design recommendation.** Three loader-shape options
  with trade-offs, plus the narrow-fix evaluation Seth asked
  about: can we fix `funding_sources` only and leave everything
  else untouched?

The audit's central finding (previewed here): the §2a violation
hits a much wider surface than just the CDC rows, BUT the
narrow-fix path is viable because most non-CDC violations are
either (a) already correctly absorbed by Pattern E /
not_yet_modelled handling, or (b) presenting as `missing_required`
rather than `not_applicable` — which is the safer failure direction
per §2a. **Recommendation: narrow fix to `funding_sources` first,
extend later if the broader violation proves observable.**

---

## PART 1 — Blast-radius audit

### §1.1 Methodology

Read every requirement in `REQUIREMENT_REGISTRY` and trace, per row:

- **Tables read by `applicability.inferFromData`** — the data-inferred
  layer of applicability resolution.
- **Tables read by `state_resolver`** — the verdict layer.
- **What `[]` produces today** — the actual current behavior when
  the relevant table is empty.
- **What `[]` SHOULD produce under a loader-failure signal** —
  i.e., would the §2a-correct behavior be UNKNOWN, or is the
  current behavior actually already correct?
- **Risk note** — the user-visible regression if the change is
  applied carelessly.

Cross-checked against `src/lib/complianceState.js` line-numbered
grep of every `sourceRows.<table>` access and against
`src/lib/complianceStateLoader.js`'s return shape (`return { ...,
sourceRows: { acks, medication_authorizations,
medication_admin_events, caregivers, staff_training_records,
health_safety_updates, funding_sources, funding_documents,
miregistry_training_entries, attendance_acks, drill_logs,
property_records } }` at lines 268-282).

### §1.2 sourceRows table inventory

The loader produces 12 keys in `sourceRows`:

| Key | Shape today | Read by | Notes |
|---|---|---|---|
| `acks` | `[]` (merged from child-subject acks + medication-subject acks; safeQuery returns `[]` on error) | 19 requirements across child_files, consents, medication permissions | Highest-traffic table |
| `medication_authorizations` | `[]` | 6 medication rows (applicability + state) | Applicability is data-inferred from existence |
| `medication_admin_events` | `[]` | medication_role_gate_integrity, medication_dose_log_retention | |
| `caregivers` | `[]` (with `.archived_at` filter at the loader) | All 9 staff_files rows (state); not used in applicability | Applicability is universalFor `license_type` |
| `staff_training_records` | `[]` | 6 staff_files rows | |
| `health_safety_updates` | `[]` | `caregiver_health_safety_update_acked` | |
| `funding_sources` | `[]` | G2, G3, G4, H1 — **the §2a-violating group** | Applicability is data-inferred from CDC source existence |
| `funding_documents` | `[]` | G2 (enrollment agreement state) | Applicability is `funding_sources` (above) — funding_documents only contributes to state |
| `miregistry_training_entries` | `[]` | F1 (annual ongoing) state | Applicability is provider columns; only state reads the table |
| `attendance_acks` | `[]` | H1 state | Applicability now gates on `funding_sources` (per H1 fix-forward); the table feeds state |
| `drill_logs` | `null` (intentional Pattern E sentinel) | None — Pattern E resolvers don't read the table | **NOT affected by this change** |
| `property_records` | `null` (intentional Pattern E sentinel) | None — Pattern E resolvers don't read the table | **NOT affected by this change** |

Plus `provider` (an object, not a table) and `children` (a list).
Neither is a "table" in the safeQuery sense for this analysis;
they're loaded once via `safeMaybeSingle` / direct query and have
their own absent-vs-empty handling separate from this audit.

### §1.3 The audit table (per requirement)

Below: every applicability+state reference to a sourceRows table,
the current `[]`-behavior, and the would-change verdict under a
new loaded/failed signal.

Columns:
- **Key** — requirement_key
- **App tables read** — sourceRows tables read in `applicability.inferFromData`
- **State tables read** — sourceRows tables read in `state_resolver`
- **Empty today (state)** — what state results from `[]`
- **§2a-correct under loaded=false** — what state SHOULD result
  from a load-failure signal
- **Would change under new signal?** — YES if behavior differs;
  NO if current behavior is already correct
- **Risk** — what the provider would see if changed carelessly

#### Group A — child_files (12 rows)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `child_in_care_statement_envelope` | none (universalFor license_type) | `acks` | `missing_required` (no envelope captured) | `unknown` (we don't know if the envelope is on file) | **YES** | First-load flicker on `acks` failure: every intake row flips Missing → Unknown. **HIGH visual-noise risk.** |
| `intake_lead_disclosure` | none (provider column gate) | `acks` | `missing_required` if applies; data-inferred neg from `provider.home_built_before_1978` | same as envelope | **YES** | Same as envelope |
| `intake_firearms_disclosure` | none (provider column gate) | `acks` | same | same | **YES** | Same |
| `intake_food_provider_agreement` | none (universalFor) | `acks` | `missing_required` | `unknown` | **YES** | Same |
| `intake_licensing_notebook_availability` | none (universalFor) | `acks` | same | same | **YES** | Same |
| `intake_licensing_rules_offered` | none (universalFor) | `acks` | same | same | **YES** | Same |
| `intake_infant_safe_sleep` | none (childGate on age) | `acks` | same | same | **YES** | Same |
| `intake_health_condition` | none (universalFor) | `acks` | same | same | **YES** | Same |
| `intake_discipline_policy_receipt` | none (universalFor) | `acks` | same | same | **YES** | Same |
| `child_immunization_record` | none (universalFor) | none (`child.immunization_status`) | n/a — reads child column | n/a | **NO** | Not affected by loader-table signal |
| `child_annual_record_review` | none (universalFor) | none (`child` columns) | n/a — reads child columns | n/a | **NO** | Not affected |
| `child_in_care_statement_envelope_drift` | none (DI on envelope existence) | `acks` (envelope + sub-types) | `not_applicable` when no envelope; `pending_parent` when drift | `unknown` if acks loaded=false | **YES** | Same first-load flicker risk |

**Subgroup verdict:** 10 rows would change behavior under the new signal (acks reads). 2 rows unaffected (child-column-only). First-load flicker risk is **significant** if applied to acks.

#### Group B — consents (6 rows)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `consent_field_trip_permission` | none (autoDefault APPLIES) | `acks` | `missing_required` | `unknown` | **YES** | Same flicker risk as intake |
| `consent_transportation_routine_annual` | none (autoDefault UNKNOWN — Phase 3 applies override Map) | `acks` | depends on Phase 3 override + acks | `unknown` if acks failed | **YES** | Same |
| `consent_water_activities_on_premises_seasonal` | none | `acks` | same | same | **YES** | Same |
| `consent_transportation_nonroutine_per_trip_recency` | DI on `acks` (per-trip-ack existence in last 12 mo) | `acks` | `not_applicable` when no recent trip acks | **UNKNOWN if loaded=false** | **YES** | **Subtle: applicability itself flips on `acks` load failure.** A provider who legitimately has done no trips would suddenly see "unknown" — confusing. |
| `consent_water_activities_off_premises_per_trip_recency` | DI on `acks` | `acks` | same | same | **YES** | Same |
| `consent_photo_sharing` | none (autoDefault APPLIES) | `acks` (with revocation-pair logic) | `missing_required` if no ack | `unknown` | **YES** | Same flicker |

**Subgroup verdict:** 6 rows. C4/C5 are particularly subtle —
their applicability ITSELF depends on `acks` data, so the
loaded/failed signal would change applicability decisions, not
just state verdicts. **Risk: C4/C5 are correctly "not applicable"
when truly no trips exist; flipping them to UNKNOWN on transient
ack-load failure creates a worse provider experience than the
current behavior.**

#### Group C — medication (6 rows)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `medication_authorization_for_authorization` | `medication_authorizations` | `medication_authorizations` | `not_applicable` when no auths | **UNKNOWN if loaded=false** | **YES** | Subtle: applicability flips on `medication_authorizations` load failure. A child taking no meds would see "unknown" instead of "doesn't apply." |
| `medication_permission_per_authorization` | `medication_authorizations` (non-OTC filter) | `acks` + `medication_authorizations` | `not_applicable` or `missing_required` per auth | **UNKNOWN if either loaded=false** | **YES** | Same; doubly affected (two tables) |
| `medication_permission_otc_blanket` | `medication_authorizations` (OTC filter) | `acks` | same | same | **YES** | Same |
| `medication_role_gate_integrity` | `medication_authorizations` (non-OTC events filter) | `medication_admin_events` + `medication_authorizations` + `caregivers` | depends; can be `not_applicable` (no events) | UNKNOWN if any failed | **YES** | This row currently produces actionable evidence; "unknown" on transient failure would hide real violations |
| `medication_original_container_attestation` | `medication_authorizations` | `medication_authorizations` | `missing_required` per auth missing flag | UNKNOWN if failed | **YES** | Same |
| `medication_dose_log_retention` | `medication_authorizations` (non-OTC + has-event filter) | `medication_admin_events` + `medication_authorizations` | usually `on_file` (DB-enforced); rare anomaly states | UNKNOWN if failed | **YES** | Same |

**Subgroup verdict:** All 6 medication rows would change. The
applicability layer reads `medication_authorizations` in every
row, so a load failure on that one table changes ALL six rows'
applicability. **Same §2a concern as funding_sources** — just
for a different precondition table.

#### Group D — staff_files (9 rows)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `caregiver_background_check_eligibility` | none (universalFor license_type) | `caregivers` + `staff_training_records` | `missing_required` reason `no-active-caregivers` if empty | UNKNOWN if caregivers loaded=false | **YES** | A licensed home with NO caregivers IS a legitimate compliance issue (someone has to staff the home); flipping to unknown on transient failure would hide that |
| `caregiver_cpr_first_aid_current` | universalFor (per role) | `caregivers` + `staff_training_records` | same | same | **YES** | Same |
| `caregiver_new_hire_training_complete` | universalFor | `caregivers` + `staff_training_records` | same; or `needs_provider_data` for missing-date-of-hire | same | **YES** | Same; plus the needs_provider_data path could mask under unknown |
| `caregiver_miregistry_account` | universalFor | `caregivers` + `staff_training_records` | same | same | **YES** | Same |
| `caregiver_professional_development_hours` | universalFor | `caregivers` + `staff_training_records` | same | same | **YES** | Same |
| `caregiver_health_safety_update_acked` | DI on `health_safety_updates` (any published updates) | `caregivers` + `staff_training_records` + `health_safety_updates` | `not_applicable` if no published updates; data-inferred negative is legit | UNKNOWN if health_safety_updates failed | **YES** | The "no updates published" case is legitimately N/A; flipping to UNKNOWN on transient failure creates noise |
| `caregiver_physician_attestation_annual` | universalFor | none (Pattern E) | `unknown reason='feature-not-yet-shipped'` | unchanged | **NO** | Pattern E rows are unaffected |
| `caregiver_discipline_policy_ack_at_hire` | universalFor | none (Pattern E) | same | unchanged | **NO** | Same |
| `caregiver_daily_arrival_departure` | universalFor | none (Pattern E) | same | unchanged | **NO** | Same |

**Subgroup verdict:** 6 rows would change (read `caregivers` and/or
`staff_training_records` and/or `health_safety_updates`). 3 rows
unaffected (Pattern E). The `no-active-caregivers` case is the
notable one — that result is currently actionable (the licensed
home needs to add caregivers), and flipping to UNKNOWN on
transient load failure would mask it.

#### Group E — miregistry (2 rows)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `provider_miregistry_annual_ongoing` | none (provider columns) | `miregistry_training_entries` | `missing_required` if no `annual_ongoing` entries; `expired` if old | UNKNOWN if loaded=false | **YES** | An LEP genuinely missing their Dec 16 training would see UNKNOWN on transient failure — masks real urgency. **Medium risk** — F1 is critical-severity. |
| `provider_miregistry_level_2_currency` | none (provider columns) | none (`provider.miregistry_level_2_expires_on`) | n/a — reads provider column | n/a | **NO** | Not affected |

**Subgroup verdict:** F1 changes; F2 unaffected.

#### Group F — funding_docs + cdc_compliance (3 rows after G1 removal; 4 if G1 still present on main)

This is the immediate-motivation group. Note: G1 (`funding_dhs_198_on_file`)
is removed on `feature/h1-cdc-gating` commit `01a33ee` but still
present on main pending merge. Row counts assume the post-corrections
state.

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `funding_enrollment_agreement_on_file` (G2) | `funding_sources` (CDC + licensed-billing-basis filter) | `funding_sources` + `funding_documents` | `not_applicable` if no matching sources | **UNKNOWN if funding_sources loaded=false** | **YES** | **The original §2a violation.** A transient funding_sources load failure silently classifies a CDC provider's row as "doesn't apply" — exactly what §2a prohibits |
| `cdc_authorization_currency` (G3) | `funding_sources` (CDC filter) | `funding_sources` | `not_applicable` if no CDC sources | **UNKNOWN if funding_sources loaded=false** | **YES** | Same |
| `cdc_fingerprint_reprint_currency` (G4) | `funding_sources` (CDC filter) + provider columns | none (`provider.fingerprint_date`) | `not_applicable` if no CDC; data-inferred negative | **UNKNOWN if funding_sources loaded=false** | **YES** | Same; plus the rare case where license_type is unanswered (already UNKNOWN today) |

**Subgroup verdict:** All 3 CDC rows would change. **This is the
motivating violation.**

#### Group G — attendance (1 row)

| Key | App tables | State tables | Empty today (state) | §2a under loaded=false | Would change? | Risk |
|---|---|---|---|---|---|---|
| `attendance_parent_acknowledgment_per_day` (H1) | `funding_sources` (CDC filter, per H1 fix-forward) | `attendance_acks` (CDC-child-filtered) | `not_applicable` if no CDC sources; state varies | **UNKNOWN if funding_sources loaded=false** | **YES** | Same §2a violation as G2/G3/G4; also subtly affected if `attendance_acks` fails (state-level only — applicability holds) |

**Subgroup verdict:** Same as the CDC group.

#### Pattern E rows (12 rows total — drills + property + 3 staff gaps)

All Pattern E rows return `unknown reason='feature-not-yet-shipped'`
**without reading any sourceRows table.** They are **unaffected
by this loader change.** This is a useful property: the
not_yet_modelled subset is already correctly handling the
"no data available" case via a different mechanism. The loader
change doesn't need to touch them.

### §1.4 First-load flicker analysis

The biggest practical risk of a broad loader-shape change is the
**first-load-flicker regression** — when the provider opens
`/compliance`, the UI mounts, the loader fires, and during the
async window before any data arrives, every requirement could
render as "unknown" if the resolver reads loaded=false.

**Does the UI already gate on a loading state?** YES. Both
consumers of the engine (`ComplianceChecklistPage.jsx` and
`FamilyComplianceTab.jsx`, post-Phase-3) use the existing
convenience wrappers (`computeProviderComplianceStateWithOverrides`,
`computeChildComplianceStateWithOverrides`) which `await
loadComplianceSourceRows` to completion before passing
`sourceRows` to the pure engine. Per
`ComplianceChecklistPage.jsx` (verified post-Phase 3):

```js
const [state, setState] = useState(null)
const [loading, setLoading] = useState(true)
// ...
if (loading) return <LoadingScreen />
```

The page renders a Loading… state until the loader returns. **The
flicker risk is contained at the page level today.**

BUT: if a non-page consumer of the engine (a future dashboard
widget, a reminder banner, a check-on-mount banner) calls the
engine without gating on a loading state, the flicker would
appear. The loader-shape change increases the surface area of
"misuse risk" because more states become possible. Worth
calling out as a design consideration in Part 2.

### §1.5 Audit summary

Total registry rows: **52** on main (51 post-G1-removal on
`feature/h1-cdc-gating`).

| Row class | Count | Would change under new signal | Risk profile |
|---|---:|---:|---|
| **CDC / subsidy** (G2, G3, G4, H1 — and G1 if still present) | 3–4 | All | **MOTIVATING** — §2a violation hits these directly |
| **Medication** (D1–D6) | 6 | All | Same §2a issue for a different precondition table |
| **Child files — acks-driven** (A1–A9, A12) | 10 | All | Medium-high flicker risk if not page-gated |
| **Consents — acks-driven** (C1–C6) | 6 | All | C4/C5 applicability flip is subtle |
| **Staff files — caregivers-driven** (E1–E6) | 6 | All | `no-active-caregivers` masking is a real issue |
| **MiRegistry annual** (F1) | 1 | Yes | F2 unaffected (provider columns) |
| **Child files — column-driven** (A10, A11) | 2 | No | Not affected (read child columns) |
| **F2 + G4 partial** (provider-column state) | 2 (partial) | Partial | State unaffected; applicability flips for G4 |
| **Pattern E** (drills + property + 3 staff gaps) | 12 | No | Pattern E sidesteps the question entirely |
| **TOTAL "would change"** | **~33–34** | | — |

**Bottom line:** the §2a violation hits **about 33 of 52
registry rows** (~63%) when the loader fails. **A truly comprehensive
fix would re-plumb every resolver that reads a sourceRows table.**
That's a significant blast radius.

**But the narrowing wedge:** the violation only PRACTICALLY MATTERS
where the current `[]`-behavior is `not_applicable`. When the
current `[]`-behavior is `missing_required`, the row is already
surfacing a gap — turning that into `unknown` on transient
failure makes things FUZZIER but doesn't silently hide a
regulatory obligation. The §2a violation (the dangerous one)
specifically happens when an empty array silently produces
`not_applicable`.

Counting the "silently → not_applicable" rows specifically:

| Row | Currently produces `not_applicable` on `[]`? |
|---|---|
| G2, G3, G4, H1 — CDC group | **YES** (data-inferred not_applicable) |
| D1, D2, D3, D4, D5, D6 — medication | **YES** (all gated on medication_authorizations presence) |
| C4, C5 — per-trip recency | **YES** (data-inferred not_applicable on no recent trips) |
| E6 — caregiver_health_safety_update_acked | **YES** (data-inferred not_applicable on no published updates) |

**12 rows currently silently produce `not_applicable` from empty
data.** **These are the actual §2a-violating rows.** The other
~21 rows that "would change" produce `missing_required` from
empty — flipping those to `unknown` is fuzzier but not a §2a
violation.

This is the key insight for Part 2: **the narrow fix that
actually closes the §2a hole only needs to cover those 12 rows
— and 4 of them are funding_sources-driven (CDC + H1).**

---

## PART 2 — Design

### §2.1 Three loader-shape options

#### Option A — Per-table `{ rows, loaded }` envelope

Wrap every sourceRows table in a small envelope:

```js
sourceRows: {
  acks:                       { rows: [...], loaded: true },
  medication_authorizations:  { rows: [...], loaded: true },
  funding_sources:            { rows: [],    loaded: false },  // failed
  // ...
  drill_logs:                 null,  // Pattern E sentinel preserved
}
```

**Pros:**
- Self-describing: every consumer sees the loaded signal next to
  the rows.
- Type-uniform: every "real" table has the same shape.
- Easy to consume defensively: `(sourceRows.acks?.rows || [])`.

**Cons:**
- **Touches every resolver** that reads a sourceRows table — ~33
  rows. Each one needs a one-line refactor: `sourceRows.acks`
  → `sourceRows.acks?.rows || []`. Mechanical but pervasive.
- Tests and fixtures (the `makeSourceRows()` helper used in
  ~50 tests) all need to adopt the new shape.
- The "narrow fix" version of this can't work — once we change
  the shape for one table, we've adopted a heterogeneous shape
  (some tables wrapped, others not).

#### Option B — Sibling `loadedKeys: Set<string>` (alongside the existing rows)

Keep the existing `sourceRows.<table> = []` shape; add a sibling
that lists which tables loaded successfully:

```js
sourceRows: {
  acks:                       [...],
  medication_authorizations:  [...],
  funding_sources:            [],   // could be empty OR failed
  // ...
  drill_logs:                 null,
},
loadedKeys: new Set(['acks', 'medication_authorizations', /* funding_sources NOT in set — failed */, ...])
```

Or as a parallel object: `sourceRowsLoaded: { acks: true,
medication_authorizations: true, funding_sources: false, ... }`.

**Pros:**
- **Existing consumers continue to work unchanged** — no
  rewriting `sourceRows.acks` accesses.
- The loaded signal is opt-in: a resolver consults it only if it
  cares.
- The narrow fix is straightforward: only the resolvers that
  currently silently produce `not_applicable` from `[]` opt in.
- Test fixtures don't need to change in bulk — only the tests
  for the resolvers that opt in.

**Cons:**
- Two parallel data structures to keep in sync — the loader has
  to set both correctly.
- "Loaded" is a misnomer if the loader returns `[]` for a table
  AND `loadedKeys` doesn't include it; ambiguity is centralized
  on the loader's discipline.

#### Option C — Make `[]` mean "loaded-empty" and `null` mean "absent/failed"

Reuse the existing convention from Pattern E (where `drill_logs:
null` means "not yet shipped, no data to consider"). Extend the
loader: a failed query returns `null` for that table; a successful
empty returns `[]`.

```js
sourceRows: {
  acks:                       [],     // loaded, empty
  medication_authorizations:  [...],  // loaded, populated
  funding_sources:            null,   // failed to load
  // ...
  drill_logs:                 null,   // unchanged — Pattern E sentinel
}
```

**Pros:**
- **Minimal new vocabulary.** The `null` sentinel already exists
  in the loader for Pattern E.
- Existing consumers that use `sourceRows.acks || []` already
  handle null gracefully (the `|| []` falls through to empty,
  which is the "I don't have data" path — though that's not
  quite §2a-correct, see Cons).
- The "loaded vs failed" distinction is co-located on the same
  value.

**Cons:**
- **Conflates Pattern E (intentional null) with load failure
  (accidental null).** A resolver that sees `sourceRows.drill_logs
  = null` and a resolver that sees `sourceRows.acks = null` need
  to treat them differently — Pattern E should still produce
  `feature-not-yet-shipped`, while a load failure should produce
  `loader-failed`. The single-value sentinel can't distinguish.
- Every existing resolver using `|| []` masks the failure as
  empty — defeats the §2a fix. Each resolver would need a refactor
  to check `=== null` explicitly. Same blast radius as Option A,
  with worse semantics.
- The "narrow fix" version requires changing the loader's
  behavior for one table (funding_sources returns null on failure,
  everything else returns []) — heterogeneous loader behavior,
  hard to reason about.

### §2.2 Recommendation — Option B, narrow fix to `funding_sources` first

**Recommend Option B (sibling loadedKeys / sourceRowsLoaded)
because it's the only option that supports the narrow fix
cleanly.** And recommend the narrow fix path:

1. **Loader change (minimal):**
   - `safeQuery` learns a per-call success/failure return:
     ```js
     async function safeQueryWithLoaded(label, fn) {
       try {
         const result = await fn()
         if (result && result.error) return { rows: [], loaded: false }
         return {
           rows: Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []),
           loaded: true,
         }
       } catch (err) {
         return { rows: [], loaded: false }
       }
     }
     ```
     Used initially only for `funding_sources`. Every other table
     continues using the existing `safeQuery` and gets the same
     `[]` they get today.
   - `loadComplianceSourceRows` includes a `sourceRowsLoaded:
     { funding_sources: true | false }` object in its return.
     Other tables omitted from this object — they're considered
     "always loaded" for the narrow fix.
   - The convenience wrappers (`computeProviderComplianceStateWithOverrides`,
     etc.) pass `sourceRowsLoaded` through into the engine call.

2. **Engine change (also minimal):**
   - `resolveApplicability` accepts a new optional argument
     `sourceRowsLoaded` (defaults to `{}` for backward compat).
   - Each of the four CDC-gated rows' `inferFromData` opts in:
     ```js
     inferFromData: ({ sourceRows, sourceRowsLoaded }) => {
       // §2a: if the funding_sources signal is unavailable, we
       // can't determine whether CDC applies → UNKNOWN.
       if (sourceRowsLoaded && sourceRowsLoaded.funding_sources === false) {
         return APPLICABILITY_RESULT.UNKNOWN
       }
       const cdcSources = (sourceRows.funding_sources || [])
         .filter(f => !f.archived_at && f.type === 'cdc_scholarship')
       return cdcSources.length > 0
         ? APPLICABILITY_RESULT.APPLIES
         : APPLICABILITY_RESULT.DOES_NOT_APPLY
     },
     ```
   - No other registry row needs to change.

3. **The other 8 §2a-violating rows** (medication group + C4/C5
   per-trip + E6 health-safety) **stay on the legacy `[]`
   behavior** for this PR. They are a known §2a violation but
   are deferred because:
   - The medication group's "no auths → not applicable" is
     legitimately data-inferred negative when loaded — the silent
     failure only bites on load errors, which are themselves
     rare and increasingly observable post-Phase 3 (the loader
     now logs to console.error on RLS rejection).
   - C4/C5/E6 likewise.
   - Extending the loader-loaded signal to those tables follows
     the same shape; doing so later is a small additive PR per
     table.

**Why narrow first:** the §2a violation the user actually saw
fires on funding_sources. Closing the four CDC rows is a 4-row
change to the engine + 1-table change to the loader + ~6 tests.
The "fix all 12 rows" alternative is 12-row engine change + many-
table loader change + many tests + many existing-test fixture
updates. **Narrow first, broaden by demand.**

### §2.3 First-load-flicker handling

Both UI consumers (`ComplianceChecklistPage`, `FamilyComplianceTab`)
already gate rendering on a `loading` state at the page level —
they don't render the engine output until `await
computeProviderComplianceStateWithOverrides` returns. So the
"loaded=false" signal would only ever reach the engine AFTER the
page has data; the engine result wouldn't be rendered mid-flight.
**No additional gating needed at the page layer.**

But: future consumers (a dashboard banner, a `/dashboard`
"compliance summary" widget) might call the engine without
page-level loading gating. The recommendation:

- The convenience wrappers SHOULD return a `loaded: boolean` on
  their result envelope so direct consumers can short-circuit
  rendering during the loading window. Example:
  ```js
  const result = await computeProviderComplianceStateWithOverrides({ providerId })
  if (!result || !result.loaded) return <LoadingScreen />
  ```
- The narrow fix doesn't strictly require this (the four CDC
  rows degrade gracefully on `loaded=false` by returning UNKNOWN,
  which is visually distinct), but documenting it is part of
  the design discipline.

### §2.4 Test plan

For the narrow fix:

**Loader tests** (new file `complianceStateLoader.test.js` or
extension of existing — neither exists today; the loader has
no pure-testable surface).

- `loadApplicabilityOverrides` failure → returns empty Map (existing).
- **NEW:** loader's safeQueryWithLoaded for `funding_sources`:
  - Success path with rows → `loaded: true`, rows populated.
  - Success path with zero rows → `loaded: true`, rows: [].
  - PostgREST error → `loaded: false`, rows: [].
  - Thrown exception → `loaded: false`, rows: [].
- **NEW:** `loadComplianceSourceRows` populates
  `sourceRowsLoaded.funding_sources` correctly per the underlying
  query result.

**Engine tests** (in existing `complianceState.test.js`):

- Each CDC row (G2, G3, G4, H1) gets three new cases:
  - `sourceRowsLoaded.funding_sources === true` + CDC sources
    present → APPLIES (existing).
  - `sourceRowsLoaded.funding_sources === true` + zero CDC sources
    → DOES_NOT_APPLY (existing).
  - `sourceRowsLoaded.funding_sources === false` → **UNKNOWN**
    (new — the §2a-correct behavior).
- The absence of `sourceRowsLoaded` (backward-compat) →
  current behavior preserved (treats `[]` as DOES_NOT_APPLY).
- The §2a invariant tests already in the suite continue to pass.

**Live-gate test** (against a real provider):

- Sign in as a CDC-enrolled provider. In devtools `window.supabase`,
  simulate a `funding_sources` load failure (revoke RLS on
  `funding_sources` temporarily, OR mock the query to return an
  error). Reload `/compliance`.
- Confirm the four CDC rows render as **UNKNOWN** (the engine's
  loaded=false branch), NOT as "doesn't apply" — visible
  treatment per the Phase 3 `classifyUnknownReason` 'data_anomaly'
  bucket (gray "data anomaly — contact support" copy).
- This is the live proof that the §2a violation is closed.

### §2.5 Decisions for Seth

The doc presents two genuinely open calls:

1. **Narrow first vs broad fix.** Recommend narrow (4 CDC rows).
   The broad fix (all 33 affected rows) is technically more
   correct but ships a much bigger refactor + risks first-load
   flicker on rows that aren't currently §2a-violating. If Seth
   wants the broader fix, the loader change is the same shape;
   the engine change extends to more rows.

2. **Where the loaded signal lives — wrappers vs raw engine
   output.** The convenience wrappers
   (`computeProviderComplianceStateWithOverrides`) currently
   return the engine's state directly. The Phase 3 fix-forward
   added a `{ state, children }` envelope for the per-child
   rollup. Extending that envelope to include `loaded: boolean`
   would let UI consumers branch without re-implementing the
   detection. Recommend: yes, add `loaded` to the wrapper return
   for consistency with the existing `state, children` shape.

3. **Out-of-scope for this PR:** the medication group (D1-D6),
   C4/C5, E6 — same §2a issue different table. Add their
   loader+engine plumbing in a follow-up PR per table-or-group,
   each with the same shape as the narrow fix.

---

## Constraints + posture

- **No schema change.** No migration. No new column. No RPC.
- **No UI change.** The Phase 3 surfaces continue rendering the
  engine output; the `classifyUnknownReason` 'data_anomaly'
  bucket already handles the UNKNOWN-with-loader-failed-reason
  case visually (gray "contact support" copy).
- **Backward compatibility.** Resolvers that don't opt into the
  loaded signal continue working exactly as today. The
  `inferFromData` arg destructure of `sourceRowsLoaded` defaults
  to `{}`; missing-key access is `undefined`, which never matches
  `=== false`, so the legacy `[]`-as-does_not_apply path is
  preserved.
- **Test discipline.** The existing 1283-test suite continues to
  pass without modification. The narrow fix adds ~12-15 new
  tests (engine-side per-row + loader-side per-path) and zero
  test removals.
- **Run discipline.** Build clean. `npm run test:run` green
  before merge. No live-gate dependency — the loader change is
  testable from unit + integration tests; the live gate is a
  proof step, not a merge gate (unlike the parent boundary
  gates).

---

## Halt — what Seth reads next

This doc, with focus on:

1. **§1 — the audit table.** Confirm the 33-row "would change"
   count matches your expectation. Confirm the 12-row
   "silently → not_applicable" sub-count is the real §2a
   violation.
2. **§2.2 — the narrow-fix recommendation.** Approve / reject
   the funding_sources-only first cut. If approved, build PR
   follows.
3. **§2.5 — open decisions.** Particularly question #1 (narrow
   vs broad).

After Seth reacts, the build PR follows the standard Phase
discipline: single feature branch, scope-locked engine + loader
change, gated by §2.4 tests, no merge until tests pass and Seth
confirms the live gate visually.

Status remains **DRAFT** until that next round.

---

**End of compliance-loader-shape scope doc — DRAFT.** No code, no
migration, no merge. Halting per Phase 2 instruction.
