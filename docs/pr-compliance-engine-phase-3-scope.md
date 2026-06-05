# PR Scope — Compliance Engine Phase 3: Checklist Surface + Applicability Resolution

**Date:** 2026-06-05
**Status:** Scope — **DRAFT for review.** Three load-bearing decisions
need Seth's input before this becomes the build: (a) the
`compliance_applicability_overrides` table shape (§2), (b) **where
the applicability questions live in the product** (§3 — recommendation
locked toward Business Info, but a "first-open Compliance gets a
mini-prompt" wrinkle is Seth's call), and (c) **how the checklist
presents catalog rows whose capture surface hasn't shipped yet**
(§4 — the load-bearing UX call, recommendation included). Decisions
1, 4, 5, 6 are LOCKED by Phase 1's shipped engine + the parent scope
doc; the others are mechanical.
**Parent docs (authoritative — read first):**
`docs/pr-compliance-engine-scope.md` (the three-faces design, §2 +
§8 sequencing this slots into), `docs/pr-compliance-engine-phase-1-scope.md`
(the engine this consumes), `docs/pr-compliance-engine-phase-2-scope.md`
(the consumer-refactor work that runs in parallel; Phase 3 is the
first user-visible surface). The engine itself —
`src/lib/complianceState.js` (52 rows, 6 states, the `'auto'`
defaults, the §2a governing principle) and
`src/lib/complianceStateLoader.js` (the impure fan-out) — is on
`main` as of 2026-06-04. The 1201-test suite in
`src/lib/complianceState.test.js` is the regression net.
**Branch (suggested):** `feature/compliance-engine-phase-3`. A
single build covering: the new table, the loader extension, the
provider input surface in Business Info, and the checklist
surfaces (provider-wide + per-child).
**Schema change:** **ONE NEW TABLE** —
`compliance_applicability_overrides`. Plus a small extension to
the loader to populate the overrides Map the pure engine already
accepts. No engine API change. No change to the 52 registry rows.

---

## Summary

Phase 1 shipped the engine **dormant from the UI**. The registry
runs against real data via tests; no provider has ever seen its
output. Phase 2 wires existing parent surfaces into the engine
(refactor + the three known consent bugs). Phase 3 is the
**first user-visible compliance surface** plus the **applicability
resolution mechanism** the engine deliberately left as a seam.

Two halves, one PR:

1. **Applicability resolution.** The engine ships three
   requirements with `autoDefault: APPLICABILITY_RESULT.UNKNOWN`
   (`consent_transportation_routine_annual`,
   `consent_water_activities_on_premises_seasonal`,
   `property_animal_notification`) and one row deferred entirely
   (`consent_religious_objection_emergency_medical`). Those rows
   honestly report **unknown** until the provider tells us. Phase 3
   gives the provider a place to answer the questions (Business
   Info → "What applies to my program?"), stores the answers in a
   new `compliance_applicability_overrides` table, and routes them
   into the pure engine's existing `overrides: Map` parameter. The
   engine's §2a governing principle — *never silently resolve to
   `not_applicable` without affirmative basis* — is preserved
   because the override IS the affirmative basis.

2. **The readiness checklist surface.** Two surfaces, one engine:
   a **provider-wide** view at `/compliance` (provider-level
   categories: drills, property, staff, MiRegistry mirror, funding
   docs, CDC compliance) and a **per-child** Compliance tab inside
   the existing family modal (child_files, consents, medication,
   attendance per child). Both render the six engine states with
   per-category rollups. Read-only — Phase 3 displays state and
   resolves applicability; it does **not** ship the deep-link-to-
   fix or the score (Phase 4 onward).

The third design call is the catalog-vs-capture-surface
problem: the registry deliberately includes 12 `data_state:
'not_yet_modelled'` rows (drills, property, three staff gaps)
that return `{ kind: 'unknown', reason: 'feature-not-yet-shipped' }`.
The checklist WILL surface these. The doc proposes a **distinct
visual treatment** that names what's coming and what to do today —
not raw "unknown" rows the provider can't act on, and not hidden
rows that disappear from the inspector-prep view.

What this scope does NOT do: ship the compliance health score
(Phase 4); ship the auditor access mode (Phase 5); refactor the
provider-side consumers (Phase 2 / future optional pass); add new
ACK_TYPES or registry rows; modify the engine's pure API.

---

## DECISIONS — RESOLVED (and the three genuinely open ones)

The table follows the Phase 1 + Y1 format. For Seth's calls (#2,
#3, #4), the options are presented inline below with the
recommendation; the table entry says "Seth's call — see §X."

| # | Decision | Resolution |
|---|---|---|
| 1 | Engine API is locked. | **LOCKED.** Phase 1 shipped `resolveApplicability` accepting `overrides: Map<requirement_key, 'applies'|'does_not_apply'>` as layer 1 of the four-layer resolver (§2 of phase-1 doc). Phase 3 populates that Map; the pure verdict is untouched. ZERO engine API change. |
| 2 | `compliance_applicability_overrides` table shape. | **Seth's call — see §2.** Recommendation: per-provider row keyed `(provider_id, requirement_key)`, `mode` enum `applies` / `does_not_apply`. Per-family + per-child columns nullable but **NOT YET USED IN UI** (forward-compat seam for the deferred religious-objection consent and the rare per-child override). Soft-delete via `archived_at` per `CLAUDE.md` retention. |
| 3 | Where do the applicability questions live? | **Seth's call — see §3.** Recommendation: a new "What applies to my program?" section inside `BusinessInfoPage` (collapsed by default, expanded by a deep-link from any `unknown` checklist row). NOT in the structural-identity onboarding wizard — those are different questions for a different reader. Provider can edit answers anytime from the same surface. Optional sweetener: first-time-on-Compliance "mini-prompt" — recommend deferring to a polish pass. |
| 4 | Catalog-vs-capture-surface presentation. | **Seth's call — see §4 — THE load-bearing UX call.** Recommendation: a **distinct fourth visual state** alongside on_file / expired / missing / pending / not_applicable / awaiting_input — call it **"tracking_not_yet_available"**. Engine state stays `{ kind: 'unknown', reason: 'feature-not-yet-shipped' }`; the checklist UI treats that reason as a distinct row with copy "Tracking lands with PR #N — keep paper records for now." Compared to (B) hide-until-PR-ships (manufactures false-green for items an auditor will ask about) and (C) plain unknown (confuses with "tell us your situation"). |
| 5 | Engine `data_state` flag drives the presentation. | **LOCKED.** Every registry row already carries `data_state: 'shipped' | 'not_yet_modelled'` (per phase-1 §4). The checklist projection layer reads this flag and renders the "tracking_not_yet_available" surface for `'not_yet_modelled'` rows; everything else uses the standard six-state rendering. When PR #17/#18/#19/#20/#21 lands and a row flips to `data_state: 'shipped'`, the checklist picks up automatically — no Phase 3 change required. |
| 6 | Read-only vs actionable scope. | **LOCKED: Phase 3 is read-only.** Each row's "click to fix" deep-link to the existing capture modal (Intake modal, EnrollmentConsentsModal, MedicationModal) is **deferred** — small additive future PR (or rides with Phase 4). Phase 3 ships the display + applicability resolution; the existing capture modals continue to work via their existing paths in Families. Why: the read-only cut keeps Phase 3 shippable in isolation and lets us tune the checklist against real provider use before wiring action buttons that might fragment the existing capture flows. |
| 7 | Per-child vs provider-level surface placement. | **LOCKED.** Provider-level requirements (drills, property, staff, MiRegistry mirror, funding_docs, CDC compliance) live at a NEW sidebar item `/compliance` (under the Compliance section). Per-child requirements (child_files, consents, medication, attendance per child) live as a NEW "Compliance" tab inside each child's profile in Families. Provider-wide view links into per-child via the child's row. Matches the parent scope doc §6 layout recommendation. |
| 8 | Opt-in / default ON for new providers. | **LOCKED per `CLAUDE.md`'s "opt-in, default OFF" doctrine for compliance score/GSQ — but TWEAKED for the checklist.** The CHECKLIST is the explanation layer; hiding it by default defeats its purpose. Default ON for new providers (the differentiator on the box). Default OFF for existing providers during rollout (Vanessa included) — they opt in explicitly from Settings. The provider-wide sidebar item respects the opt-in: hidden when off. Per-child tabs respect the opt-in too. |
| 9 | Type 1 (MiRegistry mirror) handling. | **LOCKED per parent scope doc decision 11.** Type 1 rows render in the checklist with a small **"MiRegistry"** badge and the disclaimer "Verify in MiRegistry — we mirror what you entered" per `CLAUDE.md` Type 2-vs-Type 1 distinction. Phase 3 does NOT add the Type 1 inclusion sub-toggle (that's a Phase 4 concern for the score). The checklist shows Type 1 unconditionally. |
| 10 | Reminders integration. | **DEFERRED.** Whether the checklist surfaces a "turn on reminder for this requirement" CTA per row is parked for after Phase 3 lands and we have real usage signal. The reminders system (PR #15) exists and could integrate, but threading it through every checklist row is a polish move best made when we see what providers click on. |
| 11 | Inspection-prep print/export. | **DEFERRED.** Parent scope doc names this as a checklist feature (§6); recommend pushing it to a Phase 3.1 polish PR after the read-only checklist proves itself. Browser-printable is the V1 fallback (the existing print stylesheet covers it). PDF generation is its own scope. |
| 12 | Verification gate. | **LOCKED — see §7.** Phase 3 is the first user-visible compliance surface; the gate is partly live. Three classes of test: (a) applicability overrides produce the correct state transitions (set "applies" → unknown → missing/on_file as data dictates; set "does_not_apply" → not_applicable; delete the override → returns to auto default); (b) §2a invariant holds (no row silently resolves to `not_applicable` without affirmative basis); (c) `not_yet_modelled` rows render with the distinct "tracking_not_yet_available" copy. Live-verify against Vanessa's real data. |
| 13 | Schema migration is one table. | **LOCKED.** ONE new table only. No alter to any existing table. The loader gains a query against the new table + the conversion to the Map shape; the pure engine API is unchanged. |
| 14 | Backward compatibility. | **LOCKED.** Every existing helper continues to return its current shape. Phase 3 adds new surfaces; it does not modify existing ones. The Families page's existing per-child modal is unchanged; the Compliance tab is additive. |
| 15 | Build vs scope separation. | **LOCKED.** This document is **scope only** — it describes the migration, the loader extension, the Business Info surface, and the checklist UI without committing any of them. The build PR follows after Seth signs off on the three open calls. |

---

## §1. What ships (the build contract)

Phase 3 ships, in one PR:

1. **Migration** — `compliance_applicability_overrides` table (§2),
   written but NOT applied (Seth applies after review).
2. **Loader extension** — `complianceStateLoader.js` learns to
   read the overrides table and produces the `Map` shape the
   pure engine already accepts. Helper function:
   `loadApplicabilityOverrides({ providerId }) →
   Map<requirement_key, 'applies' | 'does_not_apply'>`.
3. **Provider input surface** — new "What applies to my program?"
   section inside `BusinessInfoPage`. Three initial questions
   (transportation routinely, water on premises, animals on
   premises). Optionally expandable as more `'auto': unknown`
   rows enter the registry (the section reads the registry to
   know what to ask — not hardcoded).
4. **Checklist UI — provider-wide** — new `/compliance` route +
   sidebar item under the Compliance section. Renders provider-
   level categories with per-category rollups.
5. **Checklist UI — per-child** — new "Compliance" tab inside
   each child's profile in Families. Renders the child-scoped
   categories.
6. **Opt-in toggles** — settings rows in `BusinessInfoPage` (or
   the existing `RemindersSettingsPage` if that's the cleaner
   home for opt-in toggles — see §3.3). Default ON for new
   providers, OFF for existing during rollout.

### Module API additions (loader + projection helpers)

The pure engine API does NOT change. The loader gains:

```js
// src/lib/complianceStateLoader.js — new exports

/**
 * Load every applicability override row for a provider. Returns
 * the Map shape the pure `resolveApplicability` expects as the
 * `overrides` parameter.
 *
 * Soft-delete aware: rows where archived_at IS NOT NULL are
 * skipped (the provider has "reset" that answer back to auto).
 */
export async function loadApplicabilityOverrides({ providerId }):
  Promise<Map<string, 'applies' | 'does_not_apply'>>

/**
 * Convenience wrapper that fans out source rows + overrides + the
 * full provider rollup in one async call. Replaces Phase 1's
 * `computeProviderComplianceState` for any consumer that wants the
 * overrides honored (which is "all Phase 3 consumers and later").
 */
export async function computeProviderComplianceStateWithOverrides({
  providerId,
  childIds,    // optional — defaults to all active children
  now,         // optional — defaults to wall clock
}): Promise<ProviderComplianceState>

/**
 * Mutation helper for the BusinessInfo surface. Upserts an
 * override row (or archives the row to "reset to auto").
 */
export async function setApplicabilityOverride({
  providerId,
  requirementKey,
  mode,          // 'applies' | 'does_not_apply' | null (null = archive)
  familyId,      // optional, forward-compat
  childId,       // optional, forward-compat
}): Promise<void>
```

### Projection helpers (pure — for the checklist UI)

```js
// src/lib/complianceState.js — NEW pure projection helpers

/**
 * Filter a ProviderComplianceState to only the rows whose data_state
 * is 'shipped'. Used by the score (Phase 4) to exclude not-yet-
 * modelled requirements from the tally. Also used by the checklist
 * to separate the "what we track today" cards from the "tracking
 * lands with PR #N" cards.
 */
export function filterByDataState({
  state,       // ProviderComplianceState
  dataState,   // 'shipped' | 'not_yet_modelled'
}): ProviderComplianceState

/**
 * Filter a PerChildComplianceState to a single category. Already
 * sketched in Phase 2 scope decision 9 — promote here if Phase 2
 * doesn't land first. Cheap, pure, no overlap with Phase 2's work
 * (both refer to the same helper).
 */
export function getChildComplianceStateForCategory({
  state,       // PerChildComplianceState
  category,    // one of CATEGORIES
}): CategoryState

/**
 * Helper to classify an `unknown`-state row for UI rendering.
 * Returns 'awaiting_input' | 'feature_not_yet_shipped' | 'data_anomaly'
 * based on the row's state.reason. Pure.
 */
export function classifyUnknownReason({ state, requirement }):
  'awaiting_input' | 'feature_not_yet_shipped' | 'data_anomaly'
```

`classifyUnknownReason` is the load-bearing helper for §4 — it
turns the engine's `state.reason` strings into the distinct UI
states the checklist renders.

---

## §2. The `compliance_applicability_overrides` table

### Recommended shape

```sql
create table public.compliance_applicability_overrides (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references public.profiles(id) on delete cascade,
  requirement_key     text not null,
  -- The override value. NULL means "no override" — but a NULL row
  -- shouldn't exist; archive the row instead. CHECK below enforces.
  mode                text not null check (mode in ('applies', 'does_not_apply')),
  -- Forward-compat scope columns. Phase 3 UI writes both NULL; the
  -- loader treats a per-family or per-child row as "narrower than
  -- the provider-wide row" if both exist (future feature). Phase 3
  -- only reads/writes the provider-wide row.
  family_id           uuid references public.families(id) on delete cascade,
  child_id            uuid references public.children(id) on delete cascade,
  -- Audit + retention per CLAUDE.md (never hard-delete).
  set_at              timestamptz not null default now(),
  set_by_user_id      uuid references auth.users(id) on delete set null,
  notes               text,
  archived_at         timestamptz,
  archived_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Partial-unique: one active row per (provider_id, requirement_key,
-- family_id, child_id). Same pattern as
-- consent_templates_active_unique + acknowledgments_active_unique.
create unique index compliance_overrides_active_unique
  on public.compliance_applicability_overrides
    (provider_id, requirement_key,
     coalesce(family_id, '00000000-0000-0000-0000-000000000000'::uuid),
     coalesce(child_id,  '00000000-0000-0000-0000-000000000000'::uuid))
  where archived_at is null;

-- Lookup by provider for the loader.
create index compliance_overrides_by_provider
  on public.compliance_applicability_overrides (provider_id)
  where archived_at is null;

-- Audit trail of edits: set_updated_at trigger from migration 001.
create trigger compliance_overrides_set_updated_at
  before update on public.compliance_applicability_overrides
  for each row execute function public.set_updated_at();

-- RLS — provider owns their overrides.
alter table public.compliance_applicability_overrides enable row level security;

create policy "Providers can view their own applicability overrides"
  on public.compliance_applicability_overrides for select to authenticated
  using (provider_id = auth.uid());

create policy "Providers can insert their own applicability overrides"
  on public.compliance_applicability_overrides for insert to authenticated
  with check (provider_id = auth.uid());

create policy "Providers can update their own applicability overrides"
  on public.compliance_applicability_overrides for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- No DELETE policy — soft-delete via archived_at per CLAUDE.md
-- never-hard-delete rule.
```

### Why these columns

- **`(provider_id, requirement_key, mode)`** — the load-bearing
  tuple. Per-provider scope. `requirement_key` references a row
  in `REQUIREMENT_REGISTRY`; no FK enforcement (the registry is
  in code, not the DB — same posture as the consent_type and
  ack type catalogs).
- **`mode CHECK IN ('applies', 'does_not_apply')`** — the engine
  only accepts these two; the third state ('unknown') is
  represented by the **absence of a row** (or an archived row),
  which falls back to the registry's `autoDefault`. This keeps
  the table's existence-test cheap and the engine's contract
  clear.
- **`family_id` / `child_id` (nullable)** — forward-compat. The
  parent scope doc § Applicability mentions per-family overrides
  for religious-objection statements; per-child overrides for
  rare cases. Phase 3 UI writes both NULL; the loader treats
  a narrower row as overriding a wider row when present
  (future feature). Including the columns now means the future
  Phase doesn't need a schema migration.
- **`archived_at` / `archived_by`** — soft-delete. The UI "Reset
  to auto" action archives the row; a future `SELECT … WHERE
  archived_at IS NULL` returns the unset state, which falls back
  to `autoDefault`. The audit trail of "what did the provider
  say before" is preserved per the never-hard-delete rule.
- **`notes`** — provider-authored optional context ("Pool was
  removed 2026-04-15"). Not consumed by the engine; visible in
  the BusinessInfo surface.

### Why per-provider in Phase 3 only

The three `'auto': unknown` rows in Phase 1 are all
**provider-shape** questions:

- "Do you routinely transport children?" — provider-level
  (consent #14).
- "Do you have a pool / water feature?" — provider-level
  (consent #15).
- "Do you have animals on premises?" — provider-level (#51).

The deferred row (consent #19 religious-objection) IS per-family
when it lands — but it's deferred. Per-child overrides are rare
edge cases that don't have a real use today.

Recommendation: ship per-provider scope only in the UI. Leave
the `family_id` / `child_id` columns nullable for the future
without exposing them in this PR. The loader honors a narrower
row if one ever exists; the UI doesn't write one.

### Loader query

```js
// In complianceStateLoader.js — new function.
export async function loadApplicabilityOverrides({ providerId }) {
  const { data, error } = await supabase
    .from('compliance_applicability_overrides')
    .select('requirement_key, mode, family_id, child_id')
    .eq('provider_id', providerId)
    .is('archived_at', null)

  if (error) {
    // Same defensive shape as the rest of the loader — return
    // empty Map on error; the engine falls back to autoDefault
    // for every row. Logs for visibility.
    console.error('loadApplicabilityOverrides failed', error)
    return new Map()
  }

  // For Phase 3, only honor provider-wide rows (family_id IS NULL
  // AND child_id IS NULL). Narrower rows are forward-compat; the
  // narrower-overrides-wider logic ships when the per-family or
  // per-child writers do.
  const map = new Map()
  for (const row of (data || [])) {
    if (row.family_id || row.child_id) continue  // forward-compat skip
    if (row.mode === 'applies' || row.mode === 'does_not_apply') {
      map.set(row.requirement_key, row.mode)
    }
  }
  return map
}
```

### Verification (the §2a guarantee)

The pure engine's `resolveApplicability` already implements the
correct layering — overrides Map is checked first, then universal,
then data-inferred, then autoDefault. If an override row is absent
for a `'auto': unknown` row, the engine returns
`APPLICABILITY_RESULT.UNKNOWN` — exactly what §2a requires. The
override IS the affirmative basis.

This means **the engine code does not change.** Phase 3 is the
loader + the UI + the migration. The 1201 Phase 1 tests already
prove the override behavior; new tests (§7 verification gate) prove
the loader-to-engine round-trip.

---

## §3. The provider input surface — "What applies to my program?"

### Recommended placement: BusinessInfoPage

`BusinessInfoPage` already hosts the conceptually-similar
provider-shape questions (license type, payment methods, hours,
holidays). Adding a "What applies to my program?" section there:

- **Aligns conceptually** — these are program-shape questions for
  the same reader.
- **Discoverable from the checklist** — any `unknown` row on the
  checklist with `reason: 'awaiting-provider-input'` deep-links
  here.
- **Editable later** — provider returns to BusinessInfo any time
  to change an answer. The override row updates; the engine
  picks up the new mode on next read.
- **Survives onboarding-wizard re-runs** — a future wizard
  question pre-fills from this surface (and vice-versa) if both
  paths exist.

### NOT recommended: structural-identity onboarding wizard

The wizard captures **structural identity** (license type,
program participation, MiRegistry ID). The applicability
questions are **operational shape** — they change over the life
of the business (provider gets a pool; provider stops doing
trips). Mixing them muddles two distinct reader contexts and
forces existing providers to re-run the wizard.

If Seth wants these questions in the wizard too, the recommendation
is to add ONE wizard question — "Tell us about your program shape"
— that links to the BusinessInfoPage section. The BusinessInfo
section is the canonical store; the wizard's job is to make sure
the provider sees it.

### Section design

```
┌─────────────────────────────────────────────────────────────┐
│  What applies to my program?                       [expand] │
│  These answers shape which compliance items you see on the  │
│  Compliance checklist. You can change them anytime.          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Do you routinely transport children?                       │
│  R 400.1952(1)(a) — provides an annual consent floor for    │
│  any routine transport (same day/time/destination weekly).  │
│  ( ) Yes  ( ) No  ( ) Skip — ask me later                  │
│                                                             │
│  Do you have a pool, kiddie pool, or other water feature    │
│  on your premises?                                          │
│  R 400.1934(10)(b) — covers seasonal on-premises water       │
│  activities. (Water-tables, slip-and-slides, wading pools,  │
│  and sprinklers are NOT included per R 400.1901(1)(yy).)    │
│  ( ) Yes  ( ) No  ( ) Skip — ask me later                  │
│                                                             │
│  Do you have any animals on premises?                       │
│  R 400.1937 — requires per-family notification when there's │
│  a pet or other animal where children are present.          │
│  ( ) Yes  ( ) No  ( ) Skip — ask me later                  │
│                                                             │
│  [Save answers]                                             │
└─────────────────────────────────────────────────────────────┘
```

Three states per question map directly to the engine:

| UI answer | Override row | Engine returns |
|---|---|---|
| Yes | `mode = 'applies'` | APPLIES → state_resolver runs → on_file/expired/missing/etc. |
| No | `mode = 'does_not_apply'` | DOES_NOT_APPLY → state = `not_applicable` |
| Skip — ask me later | no row (or archived row) | falls back to `autoDefault: unknown` → state = `unknown` with reason `awaiting-provider-input` |

The "Skip" path explicitly stays at the engine's safe default.
**The §2a invariant is preserved**: no answer = no override =
state stays `unknown`. The provider can never silently lock a
real obligation into `not_applicable` without an explicit "No"
click. The "No" click itself is the audit-trail event — the
override row records `set_by_user_id` + `set_at` + `notes`.

### The question list is registry-driven, not hardcoded

```js
// Pseudo-code for the section's render path.
const askable = Object.values(REQUIREMENT_REGISTRY).filter(req =>
  req.applicability.autoDefault === APPLICABILITY_RESULT.UNKNOWN
  && req.data_state === 'shipped'    // ask only for rows with a capture surface
)
// Today: 2 of 3 (animals row is data_state='not_yet_modelled'
// pending PR #21). Ask animals anyway? See §3.2 below.
```

This means as future registry additions ship with
`'auto': unknown` defaults, they automatically join the section
— no UI change required.

### §3.1 — should we ask the animals question now, even though PR #21 isn't shipped?

The `property_animal_notification` row has BOTH
`autoDefault: UNKNOWN` AND `data_state: 'not_yet_modelled'`. Two
distinct reasons the requirement reports `unknown`: applicability
not yet declared, and substrate not yet shipped.

If Seth answers "Yes, we have a dog" in BusinessInfo before
PR #21 ships:

- The override row sets `mode = 'applies'`.
- The engine still returns `state = unknown, reason =
  'feature-not-yet-shipped'` because the row's `state_resolver`
  is Pattern E.
- The checklist shows the requirement under the
  "tracking_not_yet_available" surface (§4) — "We know it applies;
  we just don't have a place to track it yet."

**Recommendation:** ask the question NOW. The provider's answer
isn't wasted — it pre-resolves applicability, so when PR #21
ships and the row's `data_state` flips to `'shipped'`, the
checklist immediately knows whether to surface it (or treat it
as N/A for providers who said "No animals").

The alternative (defer asking until PR #21 ships) means PR #21
ships and EVERY licensed home suddenly has an unanswered
"unknown" row.

### §3.2 — Should the first-load of /compliance show a mini-prompt with the questions?

Open call. Two options:

**Option A — Just deep-link.** Any `unknown` row in the checklist
with `reason: 'awaiting-provider-input'` shows a "Tell us about
this" button that scrolls to/expands the BusinessInfo section.
Provider goes there, answers, returns to the checklist.

**Option B — First-open inline mini-prompt.** On first opening
`/compliance`, if any `unknown awaiting-provider-input` rows
exist, show a small banner with the three questions inline
before the full checklist renders. Once any are answered (or
dismissed), the banner doesn't re-show.

**Recommendation: Option A for V1.** Simpler; one place to edit
answers; the deep-link works fine. Option B is a polish move
worth considering after V1 lands and we see whether providers
actually click the deep-link or get stuck.

### §3.3 — Where do the opt-in toggles live?

Two opt-ins for the checklist:

- "Show the Compliance checklist on my dashboard / sidebar."
- "Include MiRegistry mirror data in my checklist." (Phase 4
  reuses this for the score; Phase 3 makes the toggle exist —
  default ON for checklist, OFF for score in Phase 4.)

Two reasonable homes:

**Option A — `BusinessInfoPage` Settings tab.**
Conceptually aligned with the "What applies" section that
also lives here.

**Option B — `RemindersSettingsPage` (`/reminders`).**
The reminders page already has per-category opt-in toggles.
Adding "Compliance checklist" as a tab there fits the
"things that show up automatically" mental model.

**Recommendation: BusinessInfoPage** — keeps everything
program-shape adjacent in one place. The reminders page is
about notifications (in-app + email cadence); compliance
checklist visibility is a UI surface choice, not a
notification choice.

---

## §4. The catalog-vs-capture-surface presentation — THE load-bearing UX call

### The problem

The registry has 12 `data_state: 'not_yet_modelled'` rows that
return `{ kind: 'unknown', reason: 'feature-not-yet-shipped' }`:

- 4 drill rows (PR #19 ships fire / tornado / other / emergency
  plan).
- 7 property rows (PR #21 ships radon / heating / CO / smoke /
  extinguishers / animals / smoking / notebook archive).
- 3 staff-file gaps (physician attestation, discipline ack at
  hire — PR #17 surface — and non-app-user arrival/departure
  log — PR #18 surface).

The checklist must surface these. An auditor walks in and asks
about drills; a provider whose checklist doesn't mention drills
is set up to fail. But the checklist also can't pretend to track
them — there's no place to capture the data today.

### Three options, evaluated

**Option A — Distinct visual state: "Tracking not yet available."**

Render `not_yet_modelled` rows as a fourth-class surface alongside
on_file / expired / missing / not_applicable / awaiting_input.
Distinct icon (e.g., 🛠 or ⏳), distinct color (informational gray,
not "missing red"), copy template:

> **Fire drills (quarterly)** — R 400.1939
> Tracking ships with PR #19. Until then, keep your drill log on
> paper. An auditor will ask to see it.

The provider knows the requirement exists, what they need to do
today (paper), and when an in-app surface lands.

**Option B — Hide until the PR ships.**

Filter `not_yet_modelled` rows out of the checklist entirely.
When PR #19/#21/etc. ships, the rows appear.

Manufactures a **false-green failure mode**: the checklist looks
complete when it isn't. The provider treats it as exhaustive; the
auditor cites them for the rows the app never mentioned.
This is the worst failure mode for a compliance tool — same
asymmetry §2a names for `not_applicable`.

**Option C — Show as plain unknown with the standard
"awaiting input" copy.**

Render `not_yet_modelled` rows identically to `awaiting-provider-
input` rows: "Tell us about this." Provider clicks; nothing to
tell; the row remains unknown.

Confusing — the provider has nothing to enter. The deep-link goes
nowhere. The UI implies an action the provider can't take.

### Recommendation: Option A, with one explicit policy

Render `not_yet_modelled` rows as a **distinct fourth surface
state** with:

- A 🛠 (or similar) icon that's distinct from the standard
  warning/missing icons.
- Informational color (the same neutral-gray treatment that
  `not_applicable` rows get when expanded, NOT the red /
  yellow / orange of the "you need to act" states).
- Copy template: "Tracking ships with PR #N — keep paper records
  for now." Each registry row already names its rule citation;
  the UI surfaces both.

**Implementation seam:** `classifyUnknownReason` (helper in §1)
returns `'feature_not_yet_shipped'` when the engine state's
reason matches. The checklist's row renderer reads that and
picks the distinct surface treatment.

**Engine state stays exactly as Phase 1 ships it.** No new state
kind, no registry change. The UI does the categorization based
on the existing `state.reason` string. When PR #N ships and the
registry row flips to `data_state: 'shipped'` + a real
`state_resolver`, the row automatically migrates from
"Tracking not yet available" to whatever its real state is
(on_file / missing / expired / etc.).

### Policy: what the inspection-prep print/export shows

Even though the print/export is deferred (§decisions table #11),
the principle here matters: **`not_yet_modelled` rows MUST appear
in any inspection-prep view.** Hiding them from a printed
checklist re-creates Option B's false-green failure mode on
paper.

### Policy: how the score treats these (Phase 4 preview)

Phase 4 should **exclude `not_yet_modelled` from the score
denominator entirely.** A score that drops because we
haven't shipped tracking yet would punish providers for
MILittleCare's roadmap. Same posture as Type 1 data: shown in
the checklist for visibility; excluded from the score's tally
by default.

### Should the section be collapsible? Yes — but expanded by default

The "Tracking not yet available" section sits under the
six-state surface for each category. Default: **expanded**, so
the provider sees what's coming. Collapsible so once they've
read it, they can fold it away without losing their place.

---

## §5. The checklist surface — provider-wide + per-child

### §5.1 Provider-wide checklist (`/compliance` route)

**Placement:** new sidebar item under the Compliance section,
between "Parent Acknowledgments" and "CDC Pay Periods" (or
wherever fits the existing visual rhythm). Gated by the opt-in
toggle (§3.3) AND by `license_type IN ('family_home',
'group_home')` (the licensed-home compliance modules don't
apply to LEPs — same gate the Phase 1 registry uses via
`universalFor`).

**Layout:**

```
/compliance — Compliance Checklist (provider-wide)

┌─── Provider-level categories ────────────────────────────┐
│                                                          │
│ ┌─ Drills ──────────────────────── 🛠 Tracking ships ──┐ │
│ │ Fire (quarterly)      🛠 PR #19 — keep paper        │ │
│ │ Tornado (seasonal)    🛠 PR #19 — keep paper        │ │
│ │ Other emergencies     🛠 PR #19 — keep paper        │ │
│ │ Emergency response    🛠 PR #19 — keep paper        │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ Property records ─────────── 7 rows: tracking later ┐ │
│ │ (collapsed by default; same pattern as drills)      │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ Staff files ───────── 6 on file / 0 missing / 3 ⏳ ─┐ │
│ │ Background-check eligibility   ✓ Vanessa, J. Doe… │ │
│ │ CPR / First Aid current        ✓ all 4 caregivers │ │
│ │ Physician attestation annual   🛠 PR #18           │ │
│ │ Discipline policy ack at hire  🛠 PR #17           │ │
│ │ Daily arrival/departure log    🛠 PR #18 (partial) │ │
│ │ ...                                                  │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ MiRegistry mirror ─── 1 on file / 1 expired ──🏷 MiR┐ │
│ │ Annual ongoing training   ✓ on file 2026-11-04 (Dec │ │
│ │                              16 deadline 2026-12-16) │ │
│ │ Level 2 currency          ⚠ EXPIRED 2026-04-12       │ │
│ │                                                       │ │
│ │ 🏷 We mirror what you entered. Verify in MiRegistry. │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ Funding docs + CDC compliance ── 4 of 4 on file ────┐ │
│ │ ...                                                   │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                          │
│ Want to print this for an upcoming inspection? Use your  │
│ browser's print (Cmd/Ctrl-P). PDF export coming.         │
└──────────────────────────────────────────────────────────┘
```

**Per-child section:**

```
┌─── Per-child rollup ─────────────────────────────────────┐
│ Family A — Audrey, age 4                                │
│   Child files: 11 of 11 on file ✓                       │
│   Consents:    3 of 3 applicable; 1 ⏱ awaiting input    │
│   Medication:  No active authorizations                 │
│   Attendance:  47 of 47 ack'd in last 30 days ✓        │
│   [Open Audrey's compliance tab →]                      │
│                                                          │
│ Family B — Becky, age 6                                 │
│   ...                                                    │
└──────────────────────────────────────────────────────────┘
```

The per-child row is a summary; the "Open … compliance tab"
link deep-links into the Families page modal at Audrey's
Compliance tab.

### §5.2 Per-child Compliance tab (Families modal)

**Placement:** new tab inside the existing child detail panel
in `FamiliesPage`. Same tab strip as the existing Children /
Funding / Consents / Medications affordances. Gated identically.

**Layout:**

```
Audrey's compliance file

┌─ Child files (R 400.1907) ── 11 of 11 on file ─────────┐
│ Child-in-care statement envelope     ✓ 2026-03-12       │
│ Lead-paint disclosure                ✓ 2026-03-12       │
│ Firearms disclosure                  ✓ 2026-03-12       │
│ Food provider agreement              ✓ 2026-03-12       │
│ ... (all 11 child_files rows)                            │
└──────────────────────────────────────────────────────────┘

┌─ Consents ── 3 applicable / 1 awaiting input ─────────┐
│ Field trip permission        ✓ 2026-03-12               │
│ Routine transportation       ⏱ Tell us about this       │
│   ↳ "Do you routinely transport?" — answer in           │
│      Business Info → What applies to my program?         │
│ Water on-premises seasonal   ✓ 2026-04-01 (renews Oct 1)│
│ Photo sharing                ✓ 2026-03-12               │
│ Per-trip transport (recency) ↳ N/A — no trips recorded  │
│ Per-trip water (recency)     ↳ N/A — no trips recorded  │
└──────────────────────────────────────────────────────────┘

┌─ Medication ── No active authorizations ────────────────┐
│ (Empty by design — no per-authorization rows yet.)      │
└──────────────────────────────────────────────────────────┘

┌─ Attendance (last 30 days) ── 47 of 47 ack'd ──────────┐
│ ...                                                      │
└──────────────────────────────────────────────────────────┘

[Tabs: Profile | Funding | Consents | Medications | Compliance]
```

### §5.3 The six engine states → UI rendering

| State | Icon | Color | Copy template |
|---|---|---|---|
| `on_file` | ✓ | green | "On file (since YYYY-MM-DD)" + optional "renews YYYY-MM-DD" |
| `expired` | ⚠ | red | "Expired YYYY-MM-DD — renew now" |
| `missing_required` | ✗ | red | "Missing — needs [parent signature / your attestation / record]" |
| `pending_parent` | ⏱ | amber | "Pending parent signature — sent YYYY-MM-DD" |
| `not_applicable` | ↳ | gray (collapsed by default) | "Doesn't apply" with reason; collapsible group at the bottom of each category |
| `unknown` | (reason-dependent) | (reason-dependent) | See §5.4 |

The "[parent signature / your attestation / record]" tail
comes from the requirement's `subject_type` + the channel-
satisfaction rules — the engine already knows this (Phase 1
Pattern A).

### §5.4 The `unknown` state has three sub-renderings

Per `classifyUnknownReason`:

- **`awaiting_input`** (engine reason: `awaiting-provider-input`):
  amber icon ⏱, copy "Tell us about this", deep-link to
  BusinessInfo "What applies" section.
- **`feature_not_yet_shipped`** (engine reason:
  `feature-not-yet-shipped`): gray informational icon 🛠, copy
  "Tracking ships with PR #N — keep paper records for now."
  No actionable link.
- **`data_anomaly`** (engine reasons:
  `unparseable-date` / `completion-date-in-future` /
  `source-not-loaded` / `no-state-resolver`): gray icon (?),
  copy "Data anomaly — please contact support." Logs the
  reason for visibility.

### §5.5 The `not_applicable` state — hidden by default

`not_applicable` rows are HIDDEN by default in both views.
Reason: an inspection-ready checklist shouldn't be cluttered
with "doesn't apply" rows.

A small expandable "Show rows that don't apply" link at the
bottom of each category exposes them on demand. Useful for the
provider to verify the engine isn't WRONGLY classifying
something as N/A.

This is **load-bearing for the §2a sanity check**: if the
provider notices a real requirement was classified as N/A
when it shouldn't be, they can spot it and contact support.
The hiding is for visual cleanliness, not concealment.

### §5.6 Type 1 (MiRegistry mirror) badge

Per `CLAUDE.md` Type 1 / Type 2 distinction and parent scope
doc decision 11:

- Every `data_authority: 'miregistry'` row carries a small
  **"🏷 MiR"** (or similar) badge.
- Section-level disclaimer at the bottom of any category with
  Type 1 rows: "We mirror what you entered in MiRegistry. An
  auditor verifies these in MiRegistry per R 400.1922."
- Counted in the checklist's "X on file / Y missing" totals
  (the checklist's job is visibility).
- NOT counted in Phase 4's score by default (the score's job
  is risk).

---

## §6. Read-only vs actionable scope — Phase 3 is read-only

### What "read-only" means

- Each row shows state. No buttons that say "fix this now."
- No deep-link from a `missing_required` row into a capture
  modal. The provider navigates manually back to Families →
  child profile → the appropriate capture flow.
- The `awaiting_input` rows DO deep-link to the BusinessInfo
  "What applies" section (§3) — that's data-entry on the
  applicability question, not on the requirement itself.
- The opt-in / opt-out toggles for the checklist itself ARE
  actionable — they're settings, not capture.

### Why this cut

Three reasons:

1. **Shippable in isolation.** A read-only checklist is a
   demo-able, gate-able piece. Adding "click to fix" buttons
   per row means designing the click-throughs for every
   capture modal, which fragments the existing capture flows
   and adds regression surface.
2. **Real usage signal before committing to the action paths.**
   We don't know yet whether providers want a "fix from
   checklist" path or whether they prefer the existing
   Families-based capture. Ship read-only; observe; design
   the actionable path against real signal in Phase 3.1.
3. **Phase 4 (score) doesn't depend on actionable.** The
   score reads the same engine state the checklist reads.
   Both phases can ship without per-row action buttons.

### What rides as Phase 3.1 (or later)

- Click-to-fix deep-links per missing row.
- Inspection-prep PDF export.
- Per-row "turn on reminder for this" CTA (PR #15
  integration).
- A "history" view per requirement (when it was last
  on-file, when it expired, archived rows from the audit
  trail).

These are polish/sweetener features that benefit from
deferring until V1 of the checklist proves itself.

---

## §7. The verification gate

Phase 3 is the first user-visible compliance surface. The
verification has three classes of test: pure (the engine via
its existing 1201-test suite plus new tests for the loader),
integration (the loader-to-engine round-trip), and live
(the BusinessInfo + checklist surfaces against Vanessa's real
data).

### §7.1 Pure tests (Vitest)

New tests in `src/lib/complianceState.test.js` +
`src/lib/complianceStateLoader.test.js` (new file):

1. **Override Map → engine → state transitions** — for each of
   the three `'auto': unknown` rows, exercise:
   - No override row → applicability = UNKNOWN → state =
     `unknown` reason `awaiting-provider-input`.
   - Override `mode='applies'`, no satisfying data → state =
     `missing_required`.
   - Override `mode='applies'`, satisfying ack present →
     state = `on_file`.
   - Override `mode='does_not_apply'` → state =
     `not_applicable` reason `not-applicable-by-rule`.
   - Archived override row (archived_at NOT NULL) → loader
     returns no Map entry → engine falls back to autoDefault →
     state = `unknown`. **(Soft-delete reset path.)**

2. **§2a invariant** — assert across every row in the registry
   that with `overrides = new Map()` and empty source rows, NO
   row ever returns `not_applicable` unless its applicability
   rule has affirmative basis (regulatory-universal negative,
   data-inferred negative, child-gate negative). The Phase 1
   test suite already covers this; Phase 3 re-runs it as a
   regression net.

3. **`classifyUnknownReason` helper** — pure unit tests for
   the new helper. Each engine `reason` value maps to the
   correct UI surface state.

4. **`filterByDataState` helper** — pure unit tests. Filtering
   to `'shipped'` produces the rollup the score will use;
   filtering to `'not_yet_modelled'` produces the
   "Tracking not yet available" surface set.

5. **`getChildComplianceStateForCategory` helper** — pure
   tests if not already shipped by Phase 2.

### §7.2 Integration tests

The loader-to-engine round-trip with a real (test) Supabase
schema:

1. Insert an override row via `setApplicabilityOverride`,
   load via `loadApplicabilityOverrides`, confirm the Map has
   the expected entry.
2. Archive the override row, re-load, confirm the Map
   no longer has the entry.
3. Insert a `mode='applies'` override on a `'auto': unknown`
   requirement, then assert the full pipeline (loader →
   engine → state) reports `missing_required` for the
   requirement.
4. Confirm RLS: insert an override as Provider A, attempt to
   `SELECT` it as Provider B — gets zero rows.

### §7.3 Live verification gate (against Vanessa's data)

Once Seth applies the migration, the gate runs on a real
provider account:

1. **Baseline.** Open `/compliance` as Vanessa. With no
   overrides set, the three `'auto': unknown` rows
   (transport routine, water on-premises seasonal, animals)
   show as `unknown` with the "Tell us about this" treatment.
2. **Set override = applies** for `consent_transportation_routine_annual`.
   The row should immediately reclassify to
   `missing_required` (Vanessa has no transportation-routine
   ack on file).
3. **Set override = does_not_apply** for the same row.
   The row should reclassify to `not_applicable` and hide
   from the default view.
4. **Reset to auto** (archive the override). The row returns
   to `unknown` reason `awaiting-provider-input`.
5. **§2a sanity check.** Walk through every category in
   Vanessa's checklist and confirm NO row shows
   `not_applicable` without one of: (a) regulatory-universal
   exclusion (license_type), (b) data-inferred negative (no
   precondition row), (c) provider override = does_not_apply.
6. **Not-yet-modeled rendering.** Confirm every drill row,
   every property row, the staff-file gap rows render with
   the 🛠 "Tracking ships with PR #N" treatment — distinct
   color, no red, no action link.
7. **Type 1 rendering.** Confirm the MiRegistry annual
   ongoing + Level 2 currency rows render with the "MiR"
   badge and the section disclaimer.
8. **Per-child view.** Open Audrey's Compliance tab. Same
   rules apply scoped to that child. Per-trip recency rows
   for a child with no trip-acks show as `not_applicable`
   (correct: data-inferred negative).
9. **Cross-tenant.** Sign in as a different provider; confirm
   RLS denies access to Vanessa's `compliance_applicability_overrides`
   rows (zero results, no error).

### §7.4 Performance check

Vanessa's data is small (3 active children, ~4 caregivers).
The loader runs ~12 Supabase queries in parallel. The pure
verdict runs in <50ms in unit tests. Confirm against the live
load that `/compliance` first-paint is <500ms; if not, add a
React-side memoization layer on the rollup (the engine itself
is stateless — memoization happens at the consumer).

### §7.5 Acceptance

Phase 3 ships if and only if all of §7.1–§7.3 pass on the
preview environment with Seth's eyes on the dashboard for
the live gate. Per `CLAUDE.md` verification-gap rule, the
migration runbook entry is NOT written until §7.3 produces
screenshot evidence.

---

## §8. Dependencies on PRs #17–#21

Phase 3 does NOT block on PRs #17–#21 — but it does interact
with each of them in a specific way.

### When PR #17 (discipline policy) ships

- Registry rows `intake_discipline_policy_receipt` (already
  shipped per data_state='shipped') and
  `caregiver_discipline_policy_ack_at_hire` (currently
  `not_yet_modelled`) — the second one's `data_state` flips to
  `'shipped'` and its `state_resolver` swaps in.
- The checklist's `not_yet_modelled` surface automatically
  migrates that row to the normal six-state rendering.

### When PR #18 (staff file gaps) ships

- Three rows flip: `caregiver_physician_attestation_annual`,
  `caregiver_daily_arrival_departure` (partial — non-app-user
  arrival/departure), and the discipline ack (if not already
  covered by #17). Same auto-migration as above.

### When PR #19 (drills + emergency plan) ships

- Four rows flip: fire drill, tornado drill, other emergencies,
  emergency response plan. The checklist's "Tracking ships
  with PR #19" category section disappears as those rows
  migrate to normal rendering.

### When PR #21 (property records) ships

- Eight rows flip (radon, heating, CO, smoke, extinguishers,
  animals, smoking-posted, notebook-archive). Note: the
  `property_animal_notification` row has BOTH
  `'auto': unknown` AND `data_state: 'not_yet_modelled'`. When
  PR #21 ships, the row's `state_resolver` activates. Phase 3's
  applicability question (§3.1) **already resolves the
  applicability**, so the moment PR #21 lands, providers who
  answered "Yes, we have animals" see the requirement state
  surface; providers who answered "No" see N/A; providers who
  haven't answered see `unknown awaiting-provider-input`.

### The "what changes for Phase 3 when each PR ships" list

For each future PR:

- **No engine API change.** The registry row's
  `state_resolver` is updated; the registry's `data_state`
  flag flips to `'shipped'`.
- **No Phase 3 UI change.** The checklist's existing
  rendering picks up the new state.
- **Possibly a new applicability question.** If a future
  registry addition arrives with `'auto': unknown`, the
  BusinessInfo "What applies" section automatically asks the
  question (per §3, the section is registry-driven).

This is the seam that makes Phase 3 future-proof: the
catalog grows; the checklist surfaces grow; no surgery on
either the engine or the checklist UI.

---

## §9. Cross-cutting

### Retention + audit trail

- `compliance_applicability_overrides` follows the
  `CLAUDE.md` never-hard-delete rule. The UI's "Reset to
  auto" action archives the row. The audit trail of
  what-the-provider-said-when is preserved.
- An auditor (Phase 5) reads provider overrides as part of
  the boundary — but the auditor sees the CURRENT
  applicability resolution, not the history. Override
  history is internal-only audit data.

### Module activation

- The provider-wide `/compliance` route + sidebar item is
  gated by `MODULE_KEYS.LICENSED_COMPLIANCE` (licensed homes
  only). LEPs see no compliance UI per `CLAUDE.md`'s
  "module activation principle" + PR #14's gate.
- The per-child Compliance tab in Families is gated the
  same way.
- The applicability questions in BusinessInfo are gated the
  same way — LEPs don't see them either.

### Type 1 (mirror) handling — recap

- Checklist always shows Type 1 rows, badged + disclaimed.
- Score (Phase 4) excludes Type 1 by default with a per-
  category sub-toggle.
- Auditor view (Phase 5) always shows Type 1, badged.

### Opt-in defaults

- Checklist visibility: default ON for new providers (the
  differentiator on the box), default OFF for existing
  providers during rollout. Settings toggle in
  `BusinessInfoPage`.
- The "What applies to my program?" section is always
  visible to licensed-home providers regardless of the
  checklist opt-in — the applicability data is foundational
  for Phase 2's bug fixes too (consent surfaces read the
  same overrides via the engine).
- Per-category Type 1 inclusion in the score: deferred to
  Phase 4.

### State-modernization-hedge alignment

Per `strategy.md`'s "compliance intelligence survives state
modernization" priority:

- The applicability resolver + the override table together
  IS "compliance intelligence per provider."
- The checklist surface IS "compliance audit packet
  generation" in its read-only form.
- Both are durable moats — the state can modernize
  I-Billing, MiRegistry, the licensing portal; the question
  "what's compliant per my home" remains MILittleCare's
  layer.

### Notes on the deferred religious-objection consent

Phase 1 explicitly deferred the
`consent_religious_objection_emergency_medical` row (PR scope
doc Phase 1 §6, decision: not in the Phase 1 registry —
revisits when the ACK type and capture flow ship). When that
row eventually joins the registry:

- It will be `'auto': unknown` per §2a (engine can't tell
  which families have invoked it without provider input).
- The override table needs the `family_id` column already
  in place (§2 recommended schema) — per-family scope.
- The BusinessInfo "What applies" section gains a per-family
  question once a family's intake bundle is captured.

This is the case where the per-family columns in §2's
recommended schema earn their keep. Shipping them now (even
unused in Phase 3 UI) avoids a schema migration later.

---

## §10. Out of scope (explicitly deferred)

- **Compliance health score (Phase 4).** Reads the same
  engine + override Map; its own scope doc.
- **Auditor access mode (Phase 5).** Separate scope doc.
- **Inspection-prep PDF export.** Browser-print works for
  V1; PDF generation is its own scope (parent scope §11).
- **Per-row "click to fix" deep-links.** Phase 3.1 or
  later.
- **Per-row reminder integration.** PR #15 substrate
  exists; the wiring is polish.
- **Per-row history view.** The audit trail of when a
  requirement was on-file / expired / re-acknowledged is
  internal data; surfacing it is later.
- **Materialized state cache.** Compute on-read (parent
  scope doc decision 3); revisit if perf proves an issue.
- **Score-driven enforcement.** The engine REPORTS state;
  it does not block billing / attendance / messaging based
  on score. The funding-docs `blocks_billing` hook
  (separate scope per `strategy.md`) is enforcement; the
  checklist is reporting.
- **CCBC / MiRegistry API integration.** Per audit decisions,
  Type 1 data stays manual capture. The checklist consumes
  whatever the existing tables hold.
- **Per-family / per-child override UI.** The schema
  supports it; Phase 3 UI doesn't.
- **First-open mini-prompt for unanswered applicability
  questions** (§3.2 Option B). Polish — V1 uses the
  deep-link.
- **Score / GSQ readiness widget.** Separate scopes.

---

## §11. Open questions for Seth

Numbered for reference; each names the default if Seth has
no preference.

1. **Override table shape (§2).** Default: per-provider with
   `family_id` + `child_id` columns nullable but ungranted in
   Phase 3 UI (forward-compat). Alternative: ship only
   per-provider columns and migrate later. Recommendation:
   take the column hit now to avoid the later migration.

2. **Applicability questions placement (§3).** Default:
   BusinessInfoPage "What applies to my program?" section.
   Alternative: extend the structural-identity onboarding
   wizard. Recommendation: BusinessInfo as canonical store;
   wizard can deep-link there if Seth wants the wizard prompt.

3. **Catalog-vs-capture-surface presentation (§4).**
   Default: **Option A** — distinct "Tracking not yet
   available" visual state with PR-name copy and an
   informational icon. The load-bearing UX call for Phase 3.
   Recommendation: A; Options B (hide) and C (plain unknown)
   manufacture failure modes.

4. **Ask the animals question now or wait for PR #21
   (§3.1).** Default: ask now. The provider's answer
   pre-resolves applicability for the moment PR #21 ships.
   Recommendation: ask now.

5. **First-open mini-prompt (§3.2).** Default: defer —
   deep-link from `unknown` rows in V1. Recommendation:
   defer to polish.

6. **Opt-in toggle home (§3.3).** Default: BusinessInfoPage
   Settings tab. Alternative: RemindersSettingsPage.
   Recommendation: BusinessInfo.

7. **Read-only vs actionable scope (§6).** Default:
   read-only. Recommendation: read-only.

8. **Default ON / OFF (§decisions table #8).** Default:
   ON for new providers, OFF for existing providers during
   rollout. Settings toggle either way.

9. **Sidebar placement of `/compliance`.** Default: in the
   Compliance section, between "Parent Acknowledgments" and
   "CDC Pay Periods." Recommendation: match the existing
   visual rhythm.

10. **Print/export V1.** Default: browser-printable (no PDF
    generation in Phase 3). Recommendation: defer PDF to
    Phase 3.1.

---

## §12. Halt for review — what Seth reads next

This doc, with focus on:

1. **§4 (catalog-vs-capture-surface).** The Option A
   recommendation is the load-bearing UX call. If Seth
   disagrees, the checklist's rendering layer rebuilds.
2. **§2 (override table shape).** Per-provider with
   forward-compat columns is the recommendation; the
   alternative is a leaner schema now + a migration
   when the future per-family or per-child writer arrives.
3. **§3 (input surface placement).** BusinessInfoPage vs
   onboarding wizard. The recommendation keeps the wizard
   focused on structural identity.
4. **§7 (verification gate).** Live testing against
   Vanessa's data is the build-PR gate. Seth's eyes on the
   dashboard for the §2a invariant check.

After Seth reacts to those four, the build PR follows the
Phase 1 + Y1 cadence: branch off main, single PR covering
the migration + loader + BusinessInfo section + checklist
UIs + tests, migration NOT applied until verification gate
passes on preview.

Status remains **DRAFT for review** until that next round.

---

**End of compliance-engine Phase 3 scope doc — DRAFT.**
No code, no migration, no commit. Pending Seth review on §4,
§2, §3.
