# MILittleCare: Staff Training Tracking for Licensed Providers Spec

**Status:** Draft for PR #8. Open questions in § 9 — recommendations given,
not yet resolved. Several § 7 reference values are explicitly **unconfirmed**
and must not be implemented as fact.
**Goal:** Give a *licensed* provider one place to track training compliance
for every caregiver working under their license — themselves, co-providers,
and assistants — and to see, at a glance, who is missing what.

This spec mirrors `docs/miregistry_tracker_spec.md` and
`docs/cdc_pay_periods_spec.md`. It closes the gap recorded in
`docs/tech_debt.md` § "Staff training tracking for licensed providers is
unmodeled", surfaced 2026-05-15 by Seth.

> **Regulatory caution.** MILittleCare's repo contains the *License-Exempt*
> Scholarship Handbook (MDHHS / CDC) — **not** the licensed-home rules.
> Specific training requirements for Michigan licensed Family and Group
> Child Care Homes (hours, deadlines, curricula, role applicability) are
> **not verified in this draft.** Where a specific is needed it is written
> as "[TBD — regulatory confirmation]" and raised in § 9. Per the build
> discipline for a regulatory product: an unsourced "the state requires X"
> is dangerous misinformation and is not written here.

---

## 1. Context

### 1.1 The problem

PR #4 (the MiRegistry deadline tracker) is built on one assumption: **one
auth user = one provider tracking their own training.** That is exactly
right for a license-exempt CDC provider — a single individual, no staff,
their own MiRegistry account, the December 16 deadline, the Level 1/2 pay
rates. `miregistry_tracker_spec.md` § 3.4 even acknowledges the assumption
and gives licensed providers only a stripped-down view.

It is **wrong for a licensed provider.** A Michigan licensed Family or Group
Child Care Home (e.g. Venessa) employs other people who provide care —
co-providers, assistants, substitutes. Each of them has their own training
obligations, and **the licensee is accountable for all of them.** The state
inspects the licensee's records, not each individual's, during license
renewal and complaint investigations. A tracker that only ever shows "your
own training" cannot serve a licensed provider at all.

### 1.2 Regulatory stakes

Licensed child care in Michigan is governed by licensing rules administered
by a state body — **referred to here as "LARA"** (see § 9, OQ15: the
administering department should be confirmed; Michigan reorganized
early-childhood functions into the new MiLEAP department in 2023–2024 and
child care licensing may now sit there rather than under LARA proper).

What is reasonably certain — the *categories* of caregiver training a
licensed home must maintain (the specifics of each are § 7 / OQ material):

- **Initial orientation** — a licensing-specific curriculum required before
  or shortly after a caregiver begins. This is **not** the CDC LEPPT;
  license-exempt LEPPT does not satisfy a licensed home's orientation rule.
- **CPR / First Aid** — required for caregivers; a **certification that
  expires** (typically a fixed term from the issue date), unlike a
  calendar-deadline obligation.
- **Annual ongoing health & safety training** — a recurring requirement on
  a cycle that is **distinct from MiRegistry's December 16 CDC deadline**.
- **Activity-specific training** — e.g. food handling where the home
  prepares meals; possibly medication administration, water safety, etc.

Consequences of gaps are real: licensing violations, citations on the
public license record, conditions on renewal, and in serious cases
suspension. The financial and reputational blast radius lands on the
licensee.

### 1.3 Why this is a product wedge

`docs/strategy.md` frames the durable moat as the **intelligence layer** and
names "multi-program coordination ... and licensing in one view" and
"staff compliance" (Operations Premium tier) as priorities. Licensed
providers are a structurally different, higher-ACV segment than the
license-exempt CDC market the product has served so far:

- They carry **multi-person compliance** — inherently more record-keeping
  pain than a solo license-exempt provider has.
- Nothing else in their stack does this well; the state's MiRegistry holds
  the *individual's* transcript but gives the *licensee* no roster-level
  oversight tool.
- It compounds: every program module already shipped (CDC, MiRegistry,
  funding docs) becomes more valuable to a licensed home that also has
  staff-compliance coverage in the same product.

`docs/tech_debt.md` calls this gap "potentially a meaningful product wedge
for licensed providers — possibly more valuable than [the] CDC pay period
catalog." This spec treats it as a first-class feature, not a polish item.

---

## 2. Data Model

### 2.1 What already exists

| Object | Relevant fields | Role here |
| --- | --- | --- |
| `profiles` (one per auth user) | `is_license_exempt`, `michigan_license_number`, `michigan_provider_id`, `miregistry_id`, `program_settings` | Licensee identity + activation inputs. Every staff member also has a `profiles` row. |
| `staff_memberships` | `staff_user_id`, `licensee_id`, `role`, `status`, `is_18_or_older`, `revoked_at` | The roster. One active row per staff member under a licensee. |
| `staff_invitations` | `licensee_id`, `recipient_email`, `intended_role`, `status` | How staff are added. |
| `miregistry_training_entries` | per `user_id`; `source` enum (`leppt`, `annual_ongoing`, …) | The **CDC / license-exempt** training log. Not reused — see § 2.3. |

Key facts confirmed by reading the staff flow
(`api/accept-staff-invitation.js`, `src/hooks/useRole.jsx`):

- A staff member who accepts an invitation **gets their own
  `auth.users` + `profiles` row** — staff identity is the browser session,
  not a record the licensee owns.
- The licensee's roster is: **the licensee themselves** (who is also a
  caregiver) **plus** every `staff_memberships` row with
  `status = 'active'` and `licensee_id = <licensee>`.
- Roles: `licensee`, `adult_staff` ("Co-Provider"), `assistant` ("Daily
  Helper", may be 14–17 — `is_18_or_older` flag), `view_only`.

### 2.2 Model decision — A vs B vs C

| Model | Shape | Verdict |
| --- | --- | --- |
| **A** | Each person tracks only their own training; licensee sees nothing aggregate. | Current state. Broken for licensed providers — no oversight. Rejected. |
| **B** | Each person owns their training records; the licensee **also** sees an aggregate staff-compliance dashboard. | **Recommended.** |
| **C** | The licensee owns and enters all records; staff have no records of their own. | Simpler RLS, but contradicts reality — MiRegistry accounts are per-individual, training follows the *person* across employers, and a departing staff member's records should travel with them. Rejected as the storage model. |

**Recommendation: Model B.** It matches how training actually works (the
person owns it; it is portable across homes) *and* gives the licensee the
oversight the regulator demands. It also composes with the existing fact
that staff already have their own `profiles` rows.

Model B leaves **two residual questions B does not by itself answer** —
*who performs data entry* and *whether the licensee sees entries
immediately or after an approval step* — which are real and deferred to
§ 9 (OQ4, OQ5). Picking B does not pre-decide those.

### 2.3 New table: `staff_training_records`

LARA training is a **different regime** from MiRegistry CDC training and
gets its **own table** — not a polymorphic extension of
`miregistry_training_entries` (OQ1). Reasons:

- The MiRegistry `source` enum is CDC-specific (`leppt`, `annual_ongoing`
  meaning the Dec-16 refresher, `level_2_approved`). None map cleanly to
  LARA categories.
- LARA records need an **`expires_on`** date (CPR/First Aid expires);
  MiRegistry entries never expire. Polymorphism would mean columns that are
  meaningful in only one regime.
- RLS differs: MiRegistry entries are strictly owner-only; LARA records
  must be **readable by the licensee** of the person's active membership
  (Model B). Different policy shapes on one table is avoidable complexity.

The record belongs to the **person**, not to the licensee — so the same CPR
certification is one record regardless of how many homes the person works
at (handles multi-home staff naturally, OQ8).

```sql
-- migration 012_staff_training_records.sql
-- (012 assumes PR #6's 010 and PR #7's 011 land first; otherwise the next
--  free sequential number.)

create type public.staff_training_category as enum (
  'initial_orientation',   -- LARA licensing orientation curriculum (NOT LEPPT)
  'cpr_first_aid',         -- expiring certification
  'annual_health_safety',  -- recurring LARA ongoing training
  'food_handling',         -- activity-specific (home prepares meals)
  'other'                  -- anything the provider wants on record
);

create table public.staff_training_records (
  id                  uuid default gen_random_uuid() primary key,
  user_id             uuid references auth.users(id) on delete cascade not null,
  category            public.staff_training_category not null,
  title               text not null,
  completed_on        date not null,
  expires_on          date,                    -- null = does not expire
  hours               numeric(5,2),            -- null where not hour-denominated
  issuer              text,                    -- e.g. "American Red Cross"
  reference_code      text,                    -- certificate / MiRegistry event id
  notes               text,
  -- Provenance: who entered this row (staff self vs licensee on their
  -- behalf). Supports the entry-ownership + approval questions (OQ4/OQ5).
  entered_by          uuid references auth.users(id) on delete set null,
  archived_at         timestamptz,
  archived_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index staff_training_records_user_idx
  on public.staff_training_records (user_id, completed_on desc)
  where archived_at is null;

create index staff_training_records_user_category_idx
  on public.staff_training_records (user_id, category, expires_on)
  where archived_at is null;
```

RLS — select / insert / update only, soft-delete via `archived_at`
(matching migrations 003 / 008 / 009). The **non-trivial policy** is the
licensee read path:

- A user may select / insert / update **their own** records
  (`auth.uid() = user_id`).
- A user may **select** records whose `user_id` belongs to a person with an
  **active `staff_memberships` row pointing at the calling user** as
  `licensee_id`. This is the Model B oversight read.
- Whether a licensee may also **insert/update** on a staff member's behalf
  depends on OQ4 — V1 RLS should be written for the chosen answer, not
  both.

### 2.4 Requirement catalog — reference data

"Who needs which training, how often, with what expiration" is **reference
data**, structurally like `cdc_pay_period_catalog` (PR #6). But unlike the
CDC pay schedule — which is published and transcribable — the LARA
requirement values are **not confirmed** (§ 7). Recommendation:

- **V1 ships the *engine*, not unverified values.** A
  `lara_training_requirements` catalog (table or seeded JS constant — OQ9)
  defines, per `(category, role)`: required? / frequency / expiration term.
- Until the values are regulatory-confirmed, the catalog is seeded with a
  clearly-marked **placeholder** set and the "compliant? / overdue?"
  rollup is **gated** behind a confirmed-data flag (§ 7.3). Expiration
  tracking for CPR/First Aid works *without* the catalog — an `expires_on`
  date is self-contained.

### 2.5 Derived state (computed in app code)

Pure functions in `src/lib/staffTraining.js` (Vitest-tested, the pattern of
`miregistry.js` / `cdcPayPeriods.js`):

- **`getRecordStatus(record, today)`** → `valid` / `expiring_soon` /
  `expired` / `none` — purely from `completed_on` + `expires_on`.
- **`getStaffComplianceMatrix({ roster, records, requirements, today })`**
  → per-person, per-requirement status, plus a per-person rollup.
- **`getExpiringSoon({ records, today, windowDays })`** → the licensee's
  "needs attention" list.

These do not depend on a database; the requirement set is passed in.

---

## 3. UI / UX

### 3.1 Where it lives

**New page:** `src/pages/StaffTrainingPage.jsx` at route
`/staff-training`, in the sidebar **Compliance** section (alongside
MiRegistry and CDC Pay Periods), gated to licensed providers (§ 5).

Three surfaces, one page, role-aware:

1. **Licensee view** — the aggregate roster compliance dashboard + drill-in
   to any one person's log.
2. **Staff view** — a staff member opening the same route sees **only their
   own** training log and entry form (Model B; OQ3 covers whether staff get
   write access at all).
3. **Entry form** — a modal to add/edit one training record.

### 3.2 Licensee dashboard (ASCII mock)

A roster grid: one row per caregiver (the licensee + active staff), one
column per training category, each cell a status.

```
┌─ Staff Training ──────────────────────────────────────────────────┐
│  Compliance for caregivers under license #FH-820194               │
│                                                                    │
│  ⚠ 2 items need attention                                          │
│  • Maria R. — CPR/First Aid expired Mar 2, 2026                    │
│  • Dana K. — initial orientation not on record                     │
│                                                                    │
│  ┌────────────┬──────────┬───────────┬───────────┬──────────────┐ │
│  │ Caregiver  │ Orient-  │ CPR /     │ Annual    │ Food         │ │
│  │            │ ation    │ First Aid │ H&S       │ Handling     │ │
│  ├────────────┼──────────┼───────────┼───────────┼──────────────┤ │
│  │ You        │ ✓        │ ✓ exp     │ ✓ 2026    │ ✓            │ │
│  │ (licensee) │          │ Aug 2027  │           │              │ │
│  │ Maria R.   │ ✓        │ ✗ EXPIRED │ ✓ 2026    │ ✓            │ │
│  │ (co-prov.) │          │ Mar 2026  │           │              │ │
│  │ Dana K.    │ — none   │ ✓ exp     │ — none    │ n/a          │ │
│  │ (assistant)│          │ Jan 2027  │           │              │ │
│  └────────────┴──────────┴───────────┴───────────┴──────────────┘ │
│  ✓ on record   ⚠ expiring ≤ 60 days   ✗ expired/overdue           │
│  — not on record   n/a not required for this role                 │
│                                                                    │
│  ⓘ Requirement rules shown here are placeholders pending           │
│     confirmation of Michigan licensing rules — see your licensing  │
│     consultant. Expiration dates you enter are always accurate.    │
│                                                                    │
│  [ View a caregiver's full log ]      [ Add a training record ]    │
└────────────────────────────────────────────────────────────────────┘
```

The `ⓘ` disclaimer is **load-bearing** while § 7 values are unconfirmed:
the grid must not imply MILittleCare authoritatively knows the rules. Cells
driven only by an entered `expires_on` (CPR) are trustworthy; cells driven
by the requirement catalog ("orientation required for assistants?") carry
the disclaimer until § 7.3 is satisfied.

### 3.3 Per-staff training log (ASCII mock)

Reached by drilling into a caregiver (licensee view) or as a staff member's
own page. Mirrors the MiRegistry entries list.

```
┌─ Maria R. — Training log ──────────────────────────────────────────┐
│  Co-Provider · MiRegistry ID 4471902 · joined Sep 2025             │
│                                                                    │
│  ⚠ CPR / First Aid expired March 2, 2026. A renewal must be        │
│    completed and logged to restore compliance.                     │
│                                                                    │
│  [ Add a training record ]                       [ Show archived ] │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Feb 2024  CPR & First Aid (Red Cross)   expires Mar 2, 2026 ✗│ │
│  │ Oct 2025  Licensing Orientation         no expiry           ✓│ │
│  │ Nov 2025  Annual Health & Safety        cycle 2026          ✓│ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### 3.4 Entry form

A modal (the `TrainingEntryForm` pattern from PR #4): category radio,
title, `completed_on`, `expires_on` (shown when the category expires —
CPR/First Aid — or always available), optional hours / issuer /
reference_code / notes. Date handling uses the `todayYMD()` local-date
pattern. Inline help per category. Validation: `completed_on` ≤ today;
`expires_on` ≥ `completed_on` when present.

### 3.5 Empty states

- **Licensed provider, no staff yet** — the dashboard still renders with
  the licensee as the only row; copy invites them to add staff and explains
  that their own training is tracked here too.
- **Staff member, nothing logged** — empty log with a "start with your most
  recent" prompt (the PR #4 pattern).
- **Requirement catalog unconfirmed** — the rollup columns render in a
  visibly provisional style with the § 3.2 disclaimer; expiration tracking
  is unaffected.

---

## 4. Trigger Conditions

### 4.1 Activation

The Staff Training feature is for **licensed** providers. It activates when
`profiles.is_license_exempt === false` — the value PR #5's license-status
prompt (and PR #7's onboarding wizard) captures. See § 5 for the module
mechanics.

It activates **even with zero staff**: a licensed licensee is themselves a
caregiver with their own training obligations, and the feature is where
they will add staff. "No staff" is an empty state (§ 3.5), not a reason to
hide the feature (OQ6).

### 4.2 The `null` and license-exempt cases

- **`is_license_exempt` is `null`** — unanswered. The feature stays off;
  the PR #5 prompt / PR #7 wizard exists to resolve `null`. No separate
  nudge here.
- **`is_license_exempt === true`** (license-exempt) — feature off. A
  license-exempt CDC provider uses the MiRegistry tracker, not this.

### 4.3 Regulatory edge case — license-exempt providers with helpers

A license-exempt CDC provider is generally a single individual. But some
**do have helpers**, and MDHHS may have its own rules about who may be
present and what they must complete. This is a **genuine regulatory gray
area not covered by the repo's reference docs.** This spec does **not**
guess. Flagged as OQ12: V1 scopes the feature to *licensed* providers only;
license-exempt-with-helpers is explicitly out of scope pending regulatory
clarification.

### 4.4 Role gate

Only the **licensee** sees the aggregate dashboard. A staff member at
`/staff-training` sees only their own log (§ 3.1). `view_only` users see
nothing (they are not caregivers — § 6). Gating uses `useRole()`.

---

## 5. Module Activation

### 5.1 A new module key

`src/lib/modules.js` already defines `MODULE_KEYS.LICENSED_COMPLIANCE`,
activated today when `profile.michigan_license_number` is set. Staff
training is the **first concrete feature inside that licensed-compliance
space**, but bundling everything licensed under one key is coarse.

Recommendation (OQ10): add a dedicated `MODULE_KEYS.STAFF_TRAINING`,
activated when **`profile.is_license_exempt === false`**. Rationale for
keying on `is_license_exempt` rather than `michigan_license_number`:

- `is_license_exempt = false` is the **affirmative "I am a licensed
  provider" answer** captured by PR #5 / PR #7 — it exists from onboarding.
- `michigan_license_number` may be blank for a while even for a licensed
  provider (they skipped that wizard question, OQ in PR #7). Gating on it
  would hide the feature from a licensed provider who has not yet typed
  their number.

So: `if (safeProfile.is_license_exempt === false)
modules.add(MODULE_KEYS.STAFF_TRAINING)`. This is a small, additive change
to `getActiveModules`, covered by new unit tests — unlike PR #6, this PR
*does* touch `modules.js`.

### 5.2 Relationship to the MiRegistry tracker

The MiRegistry tracker (`MIREGISTRY_TRACKER`) and Staff Training **coexist
but address different regimes**:

- `MIREGISTRY_TRACKER` — MDHHS / CDC, license-exempt, the December 16
  deadline, Level 1/2 pay. Activates on `miregistry_id` or
  `is_license_exempt === true`.
- `STAFF_TRAINING` — LARA, licensed, multi-person, expiring certifications.
  Activates on `is_license_exempt === false`.

Because the two activation conditions are mutually exclusive on
`is_license_exempt`, a provider sees **one or the other**, not both — which
is correct.

**Where does a licensed licensee's own training go?** Into Staff Training
(they appear as a row in their own roster). The licensed-provider
*stripped-down MiRegistry view* described in `miregistry_tracker_spec.md`
§ 3.4 becomes **redundant** once this feature ships — a licensed provider
should be sent here, not to a degraded MiRegistry page. Recommendation
(OQ11): deprecate that § 3.4 stripped view when Staff Training ships, and
update `miregistry_tracker_spec.md` accordingly in the same PR. Each
caregiver still needs a personal **MiRegistry account/ID** (the state
registry of record) — `profiles.miregistry_id` stores it per person — but
the *licensed-home tracking UI* is Staff Training.

---

## 6. Role-Aware Training Requirements

Different roles carry different obligations. The **structure** is a
`(category × role) → requirement` matrix; the **values** are § 7 / OQ
material and not asserted here.

| Role (display) | Caregiver? | Training expectation (structure only) |
| --- | --- | --- |
| `licensee` (Licensee) | Yes — operator **and** caregiver | The fullest set: caregiver training **plus** any operator/licensee-specific obligations. [Specifics TBD — OQ13] |
| `adult_staff` (Co-Provider) | Yes — full caregiver | Full caregiver training set. [Specifics TBD] |
| `assistant` (Daily Helper) | Yes — limited caregiver; may be 14–17 | A **subset**. Age matters: an assistant under 18 cannot administer medication (Michigan R 400.1918, already encoded in `useRole`'s `hasMedicationPermission`), and some training may be age- or supervision-gated. [Specifics TBD — OQ13, OQ14] |
| `view_only` (View-only) | No | **None.** `view_only` exists for accountants / read-only access; they provide no care. Confirmed by the `useRole` permission map (no `log_attendance` / `log_incidents`). |

What is safe to state now: **CPR/First Aid applies to everyone who provides
care** (licensee + adult_staff + assistant) — broadly known and consistent
with the task brief. **`view_only` requires nothing.** Everything more
specific — which categories an assistant is exempt from, whether a minor
assistant has a reduced set, the licensee's operator-only obligations — is
**not confirmed** and is OQ13 / OQ14.

The requirement engine (§ 2.4) is built to take this matrix as data, so
when the confirmed values arrive they are seeded, not coded.

---

## 7. Reference Data — LARA Training Catalog

### 7.1 What is knowable

The **categories** in § 1.2 and the `staff_training_category` enum are a
reasonable, conventional framing of licensed-home caregiver training and
are safe to build the data model around. The **expiration model** for
CPR/First Aid (a certification with a fixed-term expiry) is a property of
those certifications themselves and is safe.

### 7.2 What is NOT knowable from the repo or general knowledge

The repo has **no LARA licensed-home training reference document** — the
`docs/reference/` handbook is the MDHHS *License-Exempt* Scholarship
Handbook, a different regime. The following must come from Michigan's child
care licensing rules (the R 400.1900-series administrative rules for Family
and Group Child Care Homes) and/or a licensing consultant **before they are
implemented as fact**:

| Unknown | Why it matters |
| --- | --- |
| Required **hours** per category | Drives "complete?" logic |
| **Deadline / frequency** of annual ongoing H&S training | Drives the recurring-due calculation; explicitly *not* Dec 16 |
| **CPR/First Aid term length** | Whether 1 or 2 years, pediatric-specific requirement |
| Exact **orientation curriculum** name, length, timing (before vs within N days of starting) | Drives the orientation requirement |
| **Role applicability** — which categories bind which roles, and any minor-assistant carve-outs | The § 6 matrix |
| Whether **food handling** is mandatory only when meals are prepared on-site | Drives `n/a` cells |
| **Record-retention period** LARA expects post-employment | OQ7 |
| The **administering department** (LARA vs MiLEAP vs other) and current rule citations | OQ15 |

### 7.3 V1 posture toward unconfirmed data

V1 must ship **honestly**:

1. The **data model, entry, and expiration tracking** ship fully — these
   do not depend on the unknowns. A provider can log records and the
   feature will correctly flag an expired CPR card.
2. The **requirement catalog** ships with a clearly-labelled **placeholder**
   set. The compliance rollup ("required / overdue / n/a" cells) renders in
   a provisional style with the § 3.2 disclaimer until a confirmed catalog
   replaces the placeholder.
3. No screen states "Michigan requires X" for any X that is not confirmed.
4. Replacing placeholders with confirmed values is a **data update** (seed
   migration or config change), not a code change — that is the point of
   making the requirement set reference data (§ 2.4).

This mirrors how `miregistry_tracker_spec.md` § 5.3 refused to compute a
Level-2 progress bar it could not compute correctly: surfacing a confident
wrong answer in a compliance product is worse than surfacing an honest
"confirm this."

---

## 8. State Modernization Survival

Assessed against `docs/strategy.md` § "State modernization hedge" and the
`cdc_pay_periods_spec.md` § 6 pattern.

### Durable — survives modernization

- **The per-caregiver training record store.** A clean, queryable history
  of who completed what and when certifications expire is reference /
  temporal intelligence. It keeps powering reminders, the compliance
  rollup, and audit-packet generation no matter what the state's systems
  look like.
- **The roster compliance rollup.** Turning many individual records into
  one licensee-level "who needs what" view is exactly the multi-program /
  staff-compliance intelligence `strategy.md` names as the durable moat.
  The state does not offer the licensee this view; it is MILittleCare's to
  own.
- **Expiration awareness** — CPR/First Aid countdowns, "expiring in N days"
  — is compliance intelligence. Durable.
- **Inspection-readiness / audit-packet generation** — a one-click bundle
  of a license's training records for a LARA renewal or complaint
  investigation. Durable, and high-value.

### State-mimicry to avoid

- There is **no LARA portal to "submit" staff training to** — individuals
  log training in MiRegistry; LARA *inspects*. So the temptation to
  replicate a submission UI mostly does not arise. Do not invent one.
- If MiRegistry exposes an API, **importing** each caregiver's transcript
  is a V2 hook (`reference_code` is the seam) — that is durable
  intelligence, not mimicry.

### Verdict

**100% of V1 is durable.** Staff training tracking is caregiver-record
intelligence and inspection-readiness — the layer `strategy.md` says to
invest in. No part of V1 is state-portal mimicry. The only forward caution
is the usual one: do not drift into "we file your licensing paperwork."

---

## 9. Open Questions

Recommendations are given; none are resolved. Format follows
`cdc_pay_periods_spec.md` § 9.

1. **One table or polymorphic on `miregistry_training_entries`?**
   *Recommendation: a separate `staff_training_records` table* (§ 2.3) —
   different categories, an `expires_on` column with no MiRegistry analogue,
   and a different RLS shape (licensee read). Polymorphism would force
   regime-specific nullable columns onto one table.

2. **Model A / B / C.**
   *Recommendation: Model B* (§ 2.2) — person-owned records plus a licensee
   aggregate dashboard. Matches reality (training follows the person across
   employers; MiRegistry accounts are per-individual) and gives the
   regulator-facing oversight. A and C are rejected with reasons in § 2.2.

3. **Do staff get write access to their own records, or is it read-only to
   them?** *Recommendation: staff can add/edit their own records*, since
   the record is theirs and they hold the certificate. But this is genuinely
   open — some licensees will want sole control of what counts. Tie-break
   with OQ4/OQ5.

4. **Who performs data entry — staff, licensee, or both?**
   *Recommendation: both* — staff may enter their own; the licensee may
   enter on a staff member's behalf (common when onboarding someone who
   isn't logged in yet). `entered_by` records which. RLS must then permit a
   licensee insert/update on a member's records; write the policy for the
   chosen answer, not both.

5. **Does the licensee see a staff-entered record immediately, or is there
   an approval/verification step?** *Recommendation: immediate visibility,
   no approval gate in V1.* An approval workflow is real (the licensee is
   accountable and may want to verify a certificate) but adds a state
   machine; defer to V2. `entered_by` already lets the UI show "entered by
   the staff member" vs "entered by you" so the licensee can eyeball it.

6. **No staff yet — show the feature?** *Recommendation: yes* (§ 4.1) — the
   licensee is themselves a tracked caregiver, and it is where they will add
   staff. "No staff" is an empty state.

7. **Retention when a staff member leaves (membership revoked).**
   *Recommendation: never hard-delete; the record stays person-owned and
   persists.* The licensee should keep read access to a former staff
   member's records for the regulator's look-back window — but the **exact
   retention period and whether a departed person's licensee-visibility
   should end** are regulatory unknowns (§ 7.2). Recommend: keep former
   staff in an "archived caregivers" section of the dashboard; confirm the
   retention period before writing any purge logic. Flagged.

8. **Staff working at multiple licensed homes.**
   *Recommendation: person-keyed records (`user_id`) handle this cleanly* —
   one CPR record, visible to every licensee with an active membership for
   that person. Open sub-question: should each licensee see *all* the
   person's records or only categories relevant to their home? Recommend
   *all* for V1 (simpler, and training is not sensitive); revisit if a
   provider objects.

9. **Requirement catalog — seeded table or JS constant?**
   *Recommendation: a seeded catalog table* (`lara_training_requirements`),
   parallel to `cdc_pay_period_catalog` — so confirmed values land as a
   data update, not a deploy, and can carry effective-dated rule changes. A
   JS constant is acceptable for the very first placeholder set if it ships
   faster; convert to a table before real values are entered.

10. **Module key — new `STAFF_TRAINING` or reuse `LICENSED_COMPLIANCE`?**
    *Recommendation: a new `STAFF_TRAINING` key* keyed on
    `is_license_exempt === false` (§ 5.1). `LICENSED_COMPLIANCE` stays as
    the broader space; a dedicated key keeps activation legible as more
    licensed features arrive.

11. **Deprecate the MiRegistry licensed-provider stripped-down view?**
    *Recommendation: yes* — once Staff Training ships, route licensed
    providers here and retire `miregistry_tracker_spec.md` § 3.4's degraded
    view, updating that spec in the same PR. Confirm there is no licensed
    provider relying on the MiRegistry page for a personal MiRegistry ID
    they entered.

12. **License-exempt providers who have helpers.**
    *Recommendation: out of scope for V1; flagged, not guessed* (§ 4.3).
    Whether a license-exempt CDC provider with helpers has MDHHS training
    obligations for those helpers is a regulatory unknown the repo cannot
    answer. V1 serves licensed providers only.

13. **The actual role × category requirement matrix.**
    *No recommendation — regulatory unknown* (§ 6, § 7.2). The matrix must
    be filled from Michigan licensing rules / a consultant. V1 builds the
    engine and ships a labelled placeholder (§ 7.3).

14. **Minor (14–17) assistants — reduced or age-gated requirements?**
    *No recommendation — regulatory unknown.* The `is_18_or_older` flag on
    `staff_memberships` is available to drive any age-conditional rule once
    the rule is known. Flagged.

15. **Which department administers licensed-home training rules, and the
    current rule citations.** *Recommendation: confirm before any § 7 value
    is implemented.* The task brief says "LARA," but Michigan moved
    early-childhood functions into the new **MiLEAP** department in
    2023–2024 (the CDC program already cites michigan.gov/mileap). The
    administering body, the current rule numbers, and the public-facing
    name to use in copy must be verified. Until then this spec uses "LARA"
    as a placeholder label.

16. **Interaction with PR #7's onboarding wizard for staff.**
    PR #7 (`onboarding_wizard_spec.md` § OQ5) deliberately gives staff *no*
    structural-identity wizard. *Recommendation:* keep that — but when a
    staff member first logs in, a **lightweight prompt** on
    `/staff-training` ("add your current training records") is reasonable,
    distinct from the licensee's structural wizard. Whether to build that
    prompt in V1 or defer is open; recommend defer to V2 and let the
    licensee-driven dashboard carry V1.

---

## Appendix — V1 scope summary

| Ships in V1 | Deferred / gated |
| --- | --- |
| `staff_training_records` table + RLS + indexes (migration 012) | Confirmed LARA requirement values (§ 7.3 — placeholder until verified) |
| `staff_training_category` enum | Approval/verification workflow (OQ5) |
| Per-person entry form, edit, soft-delete | MiRegistry transcript import (V2 — `reference_code` seam) |
| Expiration tracking for CPR/First Aid (no catalog needed) | Audit-packet generation (V2 — durable, § 8) |
| Licensee roster compliance dashboard (rollup gated by § 7.3) | Email reminders for expiring certs (V2 — needs email infra) |
| Per-staff training log; staff self-view | License-exempt-with-helpers (OQ12) |
| `MODULE_KEYS.STAFF_TRAINING` + `modules.js` change + tests | Minor-assistant age-gated rules (OQ14) |
| `src/lib/staffTraining.js` pure helpers + Vitest | Staff first-login training prompt (OQ16) |
| Runbook entry for migration 012; `tech_debt.md` update; `miregistry_tracker_spec.md` § 3.4 deprecation note (OQ11) | |

V1 explicitly is **not**: a LARA submission portal, an authoritative
statement of Michigan licensing rules, or a feature for license-exempt
providers.
