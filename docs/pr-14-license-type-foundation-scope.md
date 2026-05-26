# PR #14 — License-Type Foundation: Implementation Scope (2026-05-24)

**Implemented in PR #14 (2026-05-25)** on branch `feature/pr-14-license-type-foundation`
— migration 022 (`license_type` + `license_type_review_needed` + backfill),
modules.js gate rewrite, ternary capture (modal + BusinessInfoPage +
onboarding wizard), and the dashboard review banner. See the PR commit for
the file inventory.

**Scoping pass only. No code was changed, no branch created, no migration
run.** This document is the spec for a follow-on implementation pass.

**Decision being implemented** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ3 — *not
re-litigated here*): add `profiles.license_type` as the compliance source
of truth with values `'family_home'` / `'group_home'` / `'license_exempt'`;
backfill from existing signals, flagging ambiguous rows for human review;
gate compliance modules on it; extend `LicenseStatusPromptModal` from
binary to ternary; add a `BusinessInfoPage` editor; keep `provider_type`
as the CDC-billing concept it already is.

PR #14 blocks PRs #15–#21 (`docs/licensed-home-compliance-decisions-2026-05-23.md`
§ Updated PR sequence). It is itself preceded by PR #13
(`children.archived_at` hygiene), which is independent of this work.

Rule citations use the `R 400.19xx` style per
`docs/regulatory-rule-mapping.md`. The licensed-home compliance rules are
`R 400.1901–1951` (adopted 2026-04-27); family-home capacity/ratio is
`R 400.1925`/`R 400.1927`, group-home `R 400.1928` (the family-vs-group
distinction this field encodes).

---

## 0. Headline findings (drive the whole plan)

1. **`is_license_exempt` is read in ~10 production call sites; `license_type`
   must not orphan them.** Rather than rip-and-replace, **keep
   `is_license_exempt` as a derived mirror** of `license_type`
   (`is_license_exempt = (license_type === 'license_exempt')`), written in
   lockstep at every write site. Existing readers keep working untouched;
   only the *compliance gates* and *capture UIs* change. This is the
   lowest-risk path for a foundation PR and is the spine of this plan
   (detail in §B, §C).

2. **`license_type` has no naming collision.** No existing Postgres type is
   named `license_type` (`create type` audit across all migrations: only
   `funding_source_type/status`, `billing_period_status`,
   `funding_document_type`, `regulatory_role`, `staff_training_category`,
   `miregistry_status`, `background_check_status`,
   `miregistry_training_source`, `requirement_cadence/condition`). Safe to
   create. **But note** the sibling column `provider_type` is *not* an ENUM
   — it's `text` + a `CHECK` constraint (migration 018). See §A for the
   resulting convention question.

3. **The two compliance module gates currently gate nothing.**
   `MODULE_KEYS.LICENSED_COMPLIANCE` (`modules.js:117`, keyed on
   `michigan_license_number`) and `LICENSE_EXEMPT_COMPLIANCE`
   (`modules.js:118`, keyed on `is_license_exempt`) are defined and set,
   but **no nav item, page, or banner reads them** (Sidebar gates on
   `MIREGISTRY_TRACKER` / `STAFF_TRAINING` / `CDC` only). They are inert
   today — so re-pointing them at `license_type` is low-blast-radius.

4. **`provider_type` is read for compliance in exactly ZERO places.** Its
   only functional read is `src/lib/iBilling.js:719` (CDC fingerprint-reprint
   rule, LEP-unrelated) — a CDC-billing use that **stays as-is**. No
   compliance code reads it. So the decision's "keep `provider_type` for
   billing, `license_type` for compliance" split has no migration cost on
   the read side.

5. **There are THREE capture surfaces for license status, not two.** The
   prompt names the modal and BusinessInfoPage; the **onboarding wizard**
   (`src/lib/onboarding.js`) is a third writer (`getWriteTargets`
   `'license_status'` → `is_license_exempt`, plus `getMissingFields` /
   `reconstructAnswers` readers). All three must be reconciled or the
   wizard will keep writing a binary signal that disagrees with
   `license_type` (detail in §D).

6. **`api/` reads none of these signals.** All license logic is
   client-side (grep of `api/` for `provider_type`/license = only
   "licensee" hits). No serverless function changes needed.

---

## Step 2 — Deep-dive of the existing license signals

### `profiles.is_license_exempt`

- **Introduced:** migration `004_provider_program_settings.sql:33`
  (`add column if not exists is_license_exempt boolean`).
- **Type / nullability / default:** `boolean`, **nullable, no default**
  (three-state: `true` = LEP, `false` = licensed, `null` = unanswered).
- **Known quirk:** "indefinitely null" — a provider who keeps picking
  "ask me later" never gets a value (`docs/tech_debt.md` § "License status
  indefinitely null"; also § "License-exempt provider self-identification
  is invisible").
- **Write sites (3):**
  - `src/components/funding/LicenseStatusPromptModal.jsx:46` — the
    post-CDC-source modal.
  - `src/pages/BusinessInfoPage.jsx:353` — Licensing tab
    (`saveLicenseStatus`).
  - `src/lib/onboarding.js:487` — wizard `getWriteTargets('license_status')`.
- **Read sites (functional, non-test):**
  | Site | Purpose | Category |
  |---|---|---|
  | `src/lib/modules.js:91` | `miregistry_tracker` activation (LEP) | CDC/training |
  | `src/lib/modules.js:112` | `staff_training` activation (`=== false`) | compliance-adjacent |
  | `src/lib/modules.js:118` | `LICENSE_EXEMPT_COMPLIANCE` gate | **compliance** |
  | `src/hooks/useActiveModules.js:47` | selects column for the above | (loader) |
  | `src/components/miregistry/MiRegistryWarningBanner.jsx:36,71` | LEP banner gate | CDC/training |
  | `src/components/dashboard/AnnualTrainingBanner.jsx:67,71` | LEP Dec-16 deadline gate (`R 400.1924`) | CDC/training |
  | `src/components/funding/FundingSourceForm.jsx:403,514` | CDC 2016-hour cap rule | CDC billing |
  | `src/components/funding/FundingDocumentSlot.jsx:171` | CDC doc validation | CDC billing |
  | `src/pages/MiRegistryPage.jsx:114,198` | LEP full-vs-stripped view | CDC/training |
  | `src/pages/BusinessInfoPage.jsx:157,339,391` | load + switch-confirm + "done" badge | capture |
  | `src/lib/onboarding.js:422,567` | `getMissingFields` branch, `reconstructAnswers` | onboarding |
  | `src/lib/licenseStatusPrompt.js:33` | modal fire condition | capture |
- **Behavior that depends on it:** MiRegistry tracker visibility, staff
  training module visibility, the Dec-16 annual-training banner, the CDC
  2016-hour authorization cap, the onboarding next-step prompt, and the
  license-status prompt's own fire logic.

### `profiles.provider_type`

- **Introduced:** migration `018_provider_cdc_billing_settings.sql:33`
  (`add column if not exists provider_type text`) with a CHECK
  (`018:46–51`): `'lep_related' | 'lep_unrelated' | 'licensed_family' |
  'licensed_group' | 'licensed_center'`. **`text` + CHECK, not an ENUM.**
- **Type / nullability / default:** `text`, **nullable, no default**.
- **Write sites:** none found in `src/` or `api/` — there is **no UI that
  writes `provider_type` today**. It is set out-of-band / reserved for the
  CDC billing surfaces (the column comment at `018:93` describes its
  intended use). Confirm in production whether Venessa's row has a value
  (test-data note in §G).
- **Read sites:** `src/lib/iBilling.js:719` (passed to
  `getFingerprintReprintState`, `cdcProviderCompliance.js` — LEP-unrelated
  fingerprint window). That is the **only** functional read. (`iBilling.test.js:668–669`
  uses it in fixtures; `cdcProviderCompliance.js:163` is a JSDoc mention.)
- **Behavior that depends on it:** the CDC fingerprint-reprint banner only.
  **No compliance behavior.**
- **Relevance to PR #14:** it already encodes family-vs-group
  (`licensed_family` / `licensed_group`) and is the **primary backfill
  source** for `license_type` (§A). It keeps its CDC-billing meaning and
  its single read site is **unchanged**.

### `profiles.michigan_license_number`

- **Introduced:** migration `004_provider_program_settings.sql:29` (`text`,
  nullable, no default).
- **Write sites:** `src/lib/onboarding.js:496` (wizard `license_number`
  answer). No dedicated editor on BusinessInfoPage yet (the page comment at
  `BusinessInfoPage.jsx:143–144` names it as a *future* edit surface).
- **Read sites:** `src/lib/modules.js:117` (drives
  `LICENSED_COMPLIANCE`); `src/lib/onboarding.js:429,572` (missing-field
  check + reconstruct). Tests at `modules.test.js:238–243`.
- **Quirk:** "may be blank for a while even for a licensed provider"
  (`docs/staff_training_tracking_spec.md:417`) — which is exactly why
  `STAFF_TRAINING` keys on `is_license_exempt === false` rather than this
  column. **Implication:** `LICENSED_COMPLIANCE` keying on this column is
  *weaker* than keying on `license_type` — a licensed provider with no
  number entered gets no compliance modules. PR #14 fixes that by
  re-pointing the gate at `license_type` (§C).

### `MODULE_KEYS.LICENSED_COMPLIANCE` / `LICENSE_EXEMPT_COMPLIANCE`

- Defined `src/lib/modules.js:17–18`. Set at `modules.js:117–118`. **Gate
  nothing in the UI today** (no Sidebar item, no page redirect, no banner
  reads them — confirmed across `src/`). They exist so this PR (and
  #15–#21) have a gate to hang behavior on.
- `program_settings.licensed_compliance` / `license_exempt_compliance`
  (migration `004:26–27`, `boolean|null`) are **vestigial**: `modules.js`
  does *not* read them (the `force_on`/`force_off` override loop,
  `modules.js:77–81`, applies only to `cdc`/`tri_share`/`gsrp` via
  `GATEABLE_MODULE_KEYS`). Leave them alone (do not expand scope); note in
  the migration header that they are unused.

### `src/lib/licenseStatusPrompt.js` + `LicenseStatusPromptModal.jsx`

- `shouldFireLicenseStatusPrompt({ profile, savedSource })`
  (`licenseStatusPrompt.js:26`): fires when the saved source is
  `cdc_scholarship` AND `is_license_exempt` is neither `true` nor `false`.
  Called from `FundingSourceForm`'s post-save path.
- Modal (`LicenseStatusPromptModal.jsx`): two radios (`'license_exempt'` /
  `'licensed'`), writes `is_license_exempt` boolean (`:46`), cannot be
  dismissed except Save or "ask me later" (`:110`).

### `src/pages/BusinessInfoPage.jsx` (Licensing tab)

- Loads `is_license_exempt` (`:157`); `saveLicenseStatus` writes it (`:353`)
  with a `window.confirm` on a *switch* (`:340–347`,
  `LICENSE_SWITCH_CONFIRM` at `:1052`). `LicensingSection`
  (`:1066–1148`) renders the binary radio; section header is titled
  "Provider Type" (note: a copy label, **not** the `provider_type` column).

---

## Step 3 — Implementation plan

### A. Migration design

New migration (next sequential number — **verify the highest applied number
in production first**; repo currently has through `020`, so likely `021`,
but PR #13 may take `021` — coordinate ordering so PR #13's
`children.archived_at` migration and this one don't both claim the same
number).

```sql
-- Migration NNN: profiles.license_type — compliance source of truth
-- Licensed-home compliance rules R 400.1901–1951 (adopted 2026-04-27).
-- family_home vs group_home per capacity rules R 400.1925 / R 400.1927 / R 400.1928.
-- Distinct from profiles.provider_type (CDC-billing classification,
-- migration 018) which keeps its meaning. See
-- docs/pr-14-license-type-foundation-scope.md.
```

**Column + value set.** Per the OQ3 decision, three values:
`'family_home'`, `'group_home'`, `'license_exempt'`. **Nullable, no
default** (explicit set required; null = unanswered, drives the prompt).

- **ENUM vs text+CHECK — flagged, see Open Questions.** The decision says
  "ENUM." A real Postgres ENUM matches migrations 003/008/012. **However**,
  the immediately-adjacent sibling column `provider_type` uses `text` +
  `CHECK` (migration 018), and text+CHECK is easier to extend later (adding
  a value to a live ENUM needs `ALTER TYPE … ADD VALUE`, which can't run
  inside some transaction contexts). Recommendation: **follow the decision
  (ENUM)** unless the owner prefers column-shape consistency with
  `provider_type`. Either is implementable; this is a 5-minute decision, not
  a blocker.

```sql
-- ENUM form (per decision):
do $$ begin
  if not exists (select 1 from pg_type where typname = 'license_type') then
    create type public.license_type as enum ('family_home', 'group_home', 'license_exempt');
  end if;
end $$;

alter table public.profiles
  add column if not exists license_type public.license_type,
  add column if not exists license_type_review_needed boolean not null default false;
```

**Review-flag mechanism.** Add `license_type_review_needed boolean not null
default false` (recommended over a UI-only derived flag) so the backfill
can distinguish three null cases:
- null + `review_needed = false` → brand-new / no signal → normal; the
  capture prompt will handle it.
- null + `review_needed = true` → had ambiguous/conflicting/out-of-scope
  signals → **needs explicit human confirmation** (the rollout review
  query keys off this).
- non-null → backfill resolved it.

**Backfill (transactional, with row-count SELECT per `docs/tech_debt.md`
§ "Transactional backfills").** Derive in priority order:

```sql
begin;

-- 1. Licensed family/group from provider_type (highest-confidence signal).
update public.profiles set license_type = 'family_home'
  where provider_type = 'licensed_family' and license_type is null;
update public.profiles set license_type = 'group_home'
  where provider_type = 'licensed_group' and license_type is null;

-- 2. licensed_center is out of milittlecare scope → flag, do not set.
update public.profiles set license_type_review_needed = true
  where provider_type = 'licensed_center' and license_type is null;

-- 3. License-exempt: is_license_exempt = true AND not a licensed provider_type.
update public.profiles set license_type = 'license_exempt'
  where is_license_exempt = true
    and (provider_type is null or provider_type in ('lep_related','lep_unrelated'))
    and license_type is null;

-- 4. Conflict guard: is_license_exempt = true BUT provider_type is licensed_* → flag.
update public.profiles set license_type_review_needed = true
  where is_license_exempt = true
    and provider_type in ('licensed_family','licensed_group','licensed_center')
    and license_type is null;

-- 5. Licensed-by-boolean but no provider_type granularity:
--    is_license_exempt = false with no licensed provider_type → cannot tell
--    family vs group → flag for human review (cannot guess; CLAUDE.md
--    "future backfills must not assume a default — flag for review").
update public.profiles set license_type_review_needed = true
  where is_license_exempt = false
    and (provider_type is null or provider_type not in ('licensed_family','licensed_group'))
    and license_type is null;

-- Everything else (is_license_exempt null, no provider_type) stays null,
-- review_needed false → handled by the capture prompt.

select
  count(*) filter (where license_type = 'family_home')    as family_home,
  count(*) filter (where license_type = 'group_home')     as group_home,
  count(*) filter (where license_type = 'license_exempt') as license_exempt,
  count(*) filter (where license_type is null and license_type_review_needed) as needs_review,
  count(*) filter (where license_type is null and not license_type_review_needed) as unanswered
from public.profiles;

commit;
```

Note case 5 is the important one for **Venessa**: she is a licensed Group
Home, so the hoped-for outcome is `provider_type = 'licensed_group'` →
`group_home`. **If her `provider_type` is null** (likely, since no UI writes
it), she will fall into case 5 (`is_license_exempt = false` →
`review_needed = true`) and must confirm manually. Pre-flight her row
(§G/§H).

- **No index needed.** `license_type` is read per-current-user (single-row
  profile fetch), never filtered across rows in a hot path. Skip the index
  (matches how `is_license_exempt`/`provider_type` are indexed — they
  aren't).
- **Down migration:** drop the two columns; `drop type if exists
  public.license_type` (only after the column is dropped). Document that
  the backfill is non-destructive (it only *adds* `license_type`; it never
  modified `is_license_exempt`/`provider_type`), so rollback is just the
  column/type drops.
- **`CREATE POLICY` n/a** (no new table; `profiles` RLS already exists).
- **Table-name availability check (CLAUDE.md):** done — `license_type` type
  name is free (finding #2). Re-confirm against production with the
  `pg_type` query in the runbook before applying.

### B. App-code audit (schema-migration-paired-with-app-code, per `docs/tech_debt.md` 2026-05-22)

The governing decision: **`license_type` is the new write target;
`is_license_exempt` becomes a derived mirror written in lockstep** so every
existing reader keeps working. Per-call-site:

| Call site | Reads/Writes | Change in PR #14? |
|---|---|---|
| `LicenseStatusPromptModal.jsx:46` | writes `is_license_exempt` | **YES** → write `license_type` (ternary) **and** mirror `is_license_exempt` |
| `BusinessInfoPage.jsx:353` (`saveLicenseStatus`) | writes `is_license_exempt` | **YES** → write `license_type` + mirror |
| `onboarding.js:487` (`getWriteTargets`) | writes `is_license_exempt` | **YES** → also emit a `license_type` write target (see §D) + mirror |
| `modules.js:118` `LICENSE_EXEMPT_COMPLIANCE` | reads `is_license_exempt` | **YES** → read `license_type === 'license_exempt'` |
| `modules.js:117` `LICENSED_COMPLIANCE` | reads `michigan_license_number` | **YES** → read `license_type in (family_home, group_home)` |
| `modules.js:91` `miregistry_tracker` | reads `is_license_exempt === true` | **NO** (mirror keeps it valid; optional align to `license_type` later) |
| `modules.js:112` `staff_training` | reads `is_license_exempt === false` | **NO** (mirror keeps it valid; optional align) |
| `useActiveModules.js:47` | selects profile columns | **YES** → add `license_type` (and `license_type_review_needed`) to the `select` |
| `AnnualTrainingBanner.jsx:67,71` | `is_license_exempt === true` (LEP Dec-16) | **NO** (CDC/training, mirror valid) |
| `MiRegistryWarningBanner.jsx:36,71` | `is_license_exempt` (LEP) | **NO** (CDC/training) |
| `MiRegistryPage.jsx:114,198` | `is_license_exempt === true` | **NO** (CDC/training) |
| `FundingSourceForm.jsx:403,514` | `is_license_exempt` (CDC cap) | **NO** (CDC billing) |
| `FundingDocumentSlot.jsx:171` | `is_license_exempt` (CDC docs) | **NO** (CDC billing) |
| `licenseStatusPrompt.js:33` | `is_license_exempt` not-yet-answered | **MAYBE** → fire condition should test `license_type IS NULL` instead, so the ternary prompt re-fires correctly (see §D) |
| `onboarding.js:422,567` (`getMissingFields`/`reconstruct`) | `is_license_exempt` | **YES (wizard reconciliation)** → branch on `license_type` (see §D) |
| `iBilling.js:719` | `provider_type` | **NO** (CDC billing, unchanged) |

**Why the mirror, not a rip-and-replace:** 6 of the `is_license_exempt`
reads are genuinely CDC/LEP-billing concepts (`license_exempt` ⟺ LEP),
not licensed-home compliance. Forcing them onto `license_type` adds churn
and risk to a foundation PR for no behavior change. Keeping
`is_license_exempt` correct-by-construction (derived) is the conservative
move. **Document the invariant** (`is_license_exempt === (license_type ===
'license_exempt')` when `license_type` is non-null) in the migration header
and in `modules.js`.

### C. `modules.js` wiring

Change only the two compliance gates; add a `license_type` argument path:

```js
// Compliance modules now gate on license_type (compliance source of truth).
if (safeProfile.license_type === 'license_exempt')
  modules.add(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)
if (safeProfile.license_type === 'family_home' ||
    safeProfile.license_type === 'group_home')
  modules.add(MODULE_KEYS.LICENSED_COMPLIANCE)
```

- Drop the `michigan_license_number`-keyed `LICENSED_COMPLIANCE` activation
  (or keep it as an OR-fallback during transition — recommend dropping,
  since `license_type` is now authoritative and the number-blank quirk is
  exactly the weakness we're removing). Update `modules.test.js:238–251`.
- **Pattern for PRs #16–#21 (the six categories):** the licensed-home
  category modules gate on `license_type in ('family_home','group_home')`;
  LEP-only surfaces gate on `license_type === 'license_exempt'`. Add the
  category `MODULE_KEYS` in their own PRs; PR #14 just establishes the gate
  field and the convention. **Open question:** confirm none of A–F also
  applies to license-exempt providers (these are *licensing* rules, so
  presumably not — but flag for owner, §4 OQ).
- `useActiveModules.js:47` adds `license_type, license_type_review_needed`
  to the `select`. `getActiveModules` stays pure; add `license_type` tests.
- Downstream of `getActiveModules`: `Sidebar.jsx` (Compliance section) and
  any future category pages — no change in PR #14 since the two gates are
  currently inert; the change is invisible until #16–#21 add nav items.

### D. `LicenseStatusPromptModal` extension (+ onboarding reconciliation)

**Modal → ternary.** Three radios:
- "I hold a Michigan **Family** Child Care Home license (≤6 children)" →
  `family_home`
- "I hold a Michigan **Group** Child Care Home license (≤12 children)" →
  `group_home`
- "I'm a **license-exempt** provider (registered with MDHHS, not licensed)"
  → `license_exempt`

Write `license_type` + mirror `is_license_exempt = (choice ===
'license_exempt')`. Keep the no-silent-dismiss behavior and "ask me later"
(leaves `license_type` null → re-prompts). Reuse the existing radio styles.
Confirmation copy: branch three ways (the existing
`CONFIRM_LICENSE_EXEMPT` MiRegistry copy for `license_exempt`; a
licensed-compliance-oriented confirm for family/group).

**Fire condition.** Update `licenseStatusPrompt.js` to test `license_type
== null` (not `is_license_exempt`), so a provider who answered the old
binary as "licensed" (→ `is_license_exempt = false`, but `license_type`
possibly null/`review_needed` after backfill case 5) is re-prompted to pick
family vs group. **This is the mechanism that resolves backfill case 5 for
real users** — flag the interaction with the review flag (a `review_needed`
row should also trigger the prompt).

**Onboarding wizard (third surface — must reconcile).** In
`src/lib/onboarding.js`:
- `getWriteTargets('license_status', …)` (`:487`): the wizard currently
  offers a binary license_status. **Decision needed (§4 OQ):** either (a)
  expand the wizard's license_status question to the same ternary and write
  `license_type` (+ mirror), or (b) leave the wizard binary for now and
  have it write only `is_license_exempt`, accepting that licensed wizard
  users land in `review_needed` and get the ternary prompt later.
  Recommendation: **(a)** for consistency, but it touches
  `onboardingReducer`, `QuestionScreen`, and the wizard specs — scope it
  explicitly so it isn't a surprise.
- `getMissingFields` (`:422`) and `reconstructAnswers` (`:567`) branch on
  `is_license_exempt`; update to branch on `license_type` (or keep reading
  the mirror — lower churn, acceptable since the mirror is maintained).

### E. `BusinessInfoPage` editor

- `LicensingSection` (`:1066`) → ternary radios (same three options as the
  modal; copy identical, per the existing "intentionally identical copy"
  note at `:1064`). Rename the displayed header from "Provider Type" to
  **"License Type"** to stop conflating it with the `provider_type` column.
- `saveLicenseStatus` (`:338`) → accept the ternary value, write
  `license_type` + mirror `is_license_exempt`. Update the switch-confirm
  (`LICENSE_SWITCH_CONFIRM`, `:1052`) to cover the new transitions.
- Load (`:157`) → select `license_type` (and `license_type_review_needed`
  to show a "please confirm your license type" nudge when flagged).
- The section "done" badge (`:390`) → `license_type != null`.
- **Validation / transition rules:** allow any transition (family↔group↔
  exempt) — providers do re-license. **Switching *away* from
  family/group_home to license_exempt** should warn that licensed-home
  compliance surfaces (drills/medication/etc., once #16–#21 ship) will
  hide; **switching *to* exempt** mirrors today's
  `licensedToExempt` confirm (turns on MiRegistry tracker). Per OQ6/audit,
  no compliance *records* are deleted on switch (soft-delete / retention
  rules still apply) — note this explicitly. **Decision (§4 OQ):** does
  changing license type need any cleanup beyond hiding modules? Recommend
  no — records persist for audit retention; only visibility changes.

### F. `provider_type` relationship (documentation task)

- Add a comment to the new migration header and to `modules.js` stating:
  **`license_type` = compliance source of truth; `provider_type` = CDC
  billing classification (migration 018) — they are intentionally separate
  and must not be conflated.**
- Audit confirms **no compliance code reads `provider_type`** today
  (finding #4), and **no code reads `is_license_exempt` for licensed-home
  compliance** (the `is_license_exempt` compliance read is only
  `LICENSE_EXEMPT_COMPLIANCE`, which we're switching). So the only
  "switch these to `license_type`" work is the two `modules.js` gates —
  already covered in §C. The `iBilling.js:719` `provider_type` read stays.

### G. Test plan

- **Pure unit (`modules.test.js`):** `license_type` `'family_home'` /
  `'group_home'` → `LICENSED_COMPLIANCE` on, `LICENSE_EXEMPT_COMPLIANCE`
  off; `'license_exempt'` → inverse; `null` → neither. Regression: with
  `license_type` set, the mirror-dependent gates (`miregistry_tracker`,
  `staff_training`) still behave (drive them off the mirrored
  `is_license_exempt`).
- **Backfill (run against a copy / representative fixture):** the five
  derivation cases produce the expected `license_type` /
  `review_needed` counts; the trailing `SELECT` matches hand-computed
  expectations; `is_license_exempt`/`provider_type` are **unmodified**.
- **`licenseStatusPrompt` unit:** fires when `license_type == null`
  (extend `licenseStatusPrompt.test.js`); does not fire when set.
- **UI (when React Testing Library lands — currently none, per repeated
  tech-debt notes):** modal renders three radios, Save writes both columns;
  BusinessInfoPage ternary save + switch-confirm.
- **Smoke (manual, documented in the review doc):** a `license_exempt`
  provider sees MiRegistry but no licensed-home category nav (once #16+
  ship); a `family_home`/`group_home` provider sees `LICENSED_COMPLIANCE`
  active; a `review_needed` provider gets the re-prompt.
- **Test-data need:** confirm what `provider_type` / `is_license_exempt`
  values exist on real production rows (esp. Venessa) so the backfill's
  branch coverage matches reality — see §H.

### H. Rollout plan

1. **Pre-flight production introspection** (Supabase web SQL editor, user-run
   per `CLAUDE.md` § Schema verification + `docs/tech_debt.md` verification-gap):
   ```sql
   select id, is_license_exempt, provider_type, michigan_license_number
   from public.profiles
   order by is_license_exempt nulls last;
   ```
   Specifically confirm Venessa's row (expected: licensed group home).
2. **Apply order — app code first is NOT required here, but be deliberate.**
   Unlike migration 019 (which broke `main`-side upserts), this migration
   only *adds* columns and a *derived* backfill; existing `is_license_exempt`
   writers keep working before the app deploys. Recommended order: apply
   migration → verify backfill counts (screenshot, per the verification-gap
   rule) → deploy app (ternary capture + `modules.js` gates). The app's new
   writes target `license_type`; pre-deploy writes target only
   `is_license_exempt` and are reconciled by the next save or the prompt.
3. **Backfill review query** (the human-review surface):
   ```sql
   select id, is_license_exempt, provider_type, michigan_license_number
   from public.profiles
   where license_type is null and license_type_review_needed = true;
   ```
   Each row gets a human decision; in practice the re-prompt (§D) collects
   it in-app on next login.
4. **Communicate to Venessa:** "We've added a License Type field. We think
   you're a **Group Child Care Home** — please confirm in Business Info →
   License Type." (Her row likely needs confirmation if `provider_type`
   is null → backfill case 5.)
5. **Runbook entry** (`docs/runbook.md`) per CLAUDE.md § 5: what the
   migration does, dependency on PR #13's numbering, expected verification
   output, rollback steps.
6. **Same-PR doc discipline (CLAUDE.md):** update `CLAUDE.md` § Module
   Architecture / Critical Domain Knowledge to record `license_type` as the
   compliance source of truth vs `provider_type` for billing; add any new
   tech debt (e.g. the wizard-ternary follow-up if deferred).

---

## Step 4 — Open questions & unexpected findings

### Open questions for the owner (answer before implementation)

1. **ENUM vs `text` + CHECK for `license_type`?** The OQ3 decision says
   ENUM; the sibling `provider_type` (migration 018) uses `text` + CHECK,
   which is easier to extend (e.g. if `licensed_center` ever comes in
   scope). Confirm ENUM, or match `provider_type`'s shape for consistency.
   *(Recommendation: ENUM per decision, unless you value column-shape
   parity.)*
2. **Onboarding wizard scope.** Expand the wizard's `license_status`
   question to the same ternary now (touches `onboarding.js`,
   `onboardingReducer`, `QuestionScreen`, and the wizard specs), or leave it
   binary and let licensed wizard users get the ternary re-prompt later?
   *(Recommendation: expand now for consistency, but it must be explicit
   scope — it's the one place this PR grows beyond "two capture surfaces.")*
3. **Do any of the six compliance categories (A–F) also apply to
   license-exempt providers?** The plan assumes the category modules gate on
   `license_type in ('family_home','group_home')` only (they're *licensing*
   rules). Confirm LEPs are excluded so the gating pattern is right from the
   start.
4. **Keep `michigan_license_number` as an OR-fallback for
   `LICENSED_COMPLIANCE`, or drop it cleanly?** *(Recommendation: drop —
   `license_type` is authoritative and the blank-number quirk is the
   weakness we're removing.)*
5. **License-type change cleanup.** Confirm that switching license type only
   hides/shows modules and never deletes compliance records (audit
   retention; soft-delete). *(Recommendation: confirm "visibility only,"
   matching the existing MiRegistry switch behavior.)*

### Unexpected findings

- **`provider_type` has no writer anywhere in the app.** It's a
  CHECK-constrained column set out-of-band (or not at all). So for live
  rows it may be **null even for licensed providers** — meaning the
  high-confidence backfill (cases 1–2) may match *few or zero* rows, and
  most licensed providers (incl. possibly Venessa) land in the
  `review_needed` case 5. The re-prompt is therefore not an edge case — it's
  the **main** path to populating `license_type`. Plan UX accordingly.
- **The two compliance module gates are inert today** (finding #3) — good
  news: re-pointing them carries almost no regression risk because nothing
  consumes them yet.
- **Three capture surfaces, not two** (finding #5) — the onboarding wizard
  is easy to miss and will silently keep writing a binary signal if not
  reconciled.
- **`program_settings.licensed_compliance` / `license_exempt_compliance`
  are dead keys** — defined in migration 004, never read by `modules.js`.
  Left as-is (don't expand scope), but worth a one-line note so a future
  reader doesn't assume they're wired.
- **Copy debt:** `BusinessInfoPage`'s Licensing section is titled "Provider
  Type" — actively confusing now that a real `provider_type` column exists
  and a `license_type` is arriving. Rename to "License Type" in this PR.

### Schema-debt concerns specific to this PR

- **Migration numbering coordination with PR #13.** Both PR #13
  (`children.archived_at`) and PR #14 add migrations after `020`. Sequence
  the numbers so they don't collide (`docs/tech_debt.md` § migrations
  out-of-sync; the migration history is already fragile).
- **Production schema still largely uncaptured.** `profiles` has had columns
  added out-of-band before (`docs/tech_debt.md`). Pre-flight the live
  `profiles` columns before authoring the `ALTER TABLE` so the
  `add column if not exists` set doesn't surprise.
- **Verification-gap rule applies** (`docs/tech_debt.md` 2026-05-15): the
  backfill counts must be screenshotted from the Supabase dashboard by the
  user before the runbook entry is written. A Claude/CLI report is not
  evidence.

---

## Files read for this scope

`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `docs/claude_code_pr_14_scoping_prompt.md`,
`CLAUDE.md`, `docs/tech_debt.md`;
`supabase/migrations/004_provider_program_settings.sql`,
`supabase/migrations/018_provider_cdc_billing_settings.sql` (+ `create type`
audit across all migrations);
`src/lib/modules.js`, `src/lib/modules.test.js`, `src/hooks/useActiveModules.js`,
`src/lib/licenseStatusPrompt.js`, `src/components/funding/LicenseStatusPromptModal.jsx`,
`src/pages/BusinessInfoPage.jsx` (Licensing tab + load/save),
`src/lib/onboarding.js` (license_status read/write paths),
`src/lib/iBilling.js` (provider_type read), `src/lib/cdcProviderCompliance.js`;
plus grep sweeps of `src/` and `api/` for `is_license_exempt`,
`provider_type`, `michigan_license_number`, and the compliance module keys.

*No source files modified. No branches. No migrations run.*
