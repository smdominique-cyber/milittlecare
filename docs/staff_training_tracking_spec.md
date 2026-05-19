# MILittleCare: Staff Training Tracking for Licensed Providers Spec

**Status:** Reconciled for PR #8 (2026-05-18). § 9 decisions recorded;
OQ7 / OQ13 / OQ14 / OQ15 resolved against the verified requirements in
`docs/reference/staff_training_tracking_spec.md` (Michigan Administrative
Code R 400.1901–1963, MiLEAP, effective 2026-04-27). OQ12 (license-exempt
providers with helpers) remains the only flagged regulatory unknown.
**Goal:** Give a *licensed* provider one place to track training compliance
for every caregiver working under their license — themselves, co-providers,
and assistants — and to see, at a glance, who is missing what.

This spec mirrors `docs/miregistry_tracker_spec.md` and
`docs/cdc_pay_periods_spec.md`. It closes the gap recorded in
`docs/tech_debt.md` § "Staff training tracking for licensed providers is
unmodeled", surfaced 2026-05-15 by Seth.

> **Regulatory basis.** The training requirements in this spec are verified
> against `docs/reference/staff_training_tracking_spec.md` — the Michigan
> Administrative Code **R 400.1901–1963**, *Licensing Family and Group Child
> Care Homes*, administered by **MiLEAP** (Department of Lifelong Education,
> Advancement, and Potential), Child Care Licensing Bureau, effective
> **April 27, 2026**. Every requirement, deadline, and role restriction in
> §§ 2, 6, 7 carries its `R 400.19xx` citation. The build discipline still
> holds: any behaviour not traceable to that rule text is flagged in § 7.3,
> not invented.

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

Licensed child care in Michigan is governed by **Michigan Administrative
Code R 400.1901–1963**, administered by **MiLEAP** (Department of Lifelong
Education, Advancement, and Potential), Child Care Licensing Bureau,
effective April 27, 2026. The administering agency is confirmed (OQ15
resolved); MiLEAP — not LARA — is used in all user-facing copy.

The training categories a licensed home must maintain, each verified
against the adopted rule text (see § 2.3, § 6, § 7):

- **New hire training** — the home's own curriculum, 14 mandated topics,
  completed within 90 days of being present and before unsupervised care
  (R 400.1923). This is **not** the CDC LEPPT.
- **CPR / pediatric first aid** — required for the licensee and caregivers;
  a **certification that expires** on the date printed on the certification
  card (R 400.1920(3), R 400.1921(3), R 400.1924(8)).
- **Professional development** — a recurring per-**calendar-year** clock-hour
  requirement that varies by role (R 400.1924); **distinct from
  MiRegistry's December 16 CDC deadline**.
- **Health & safety update acknowledgements** — event-driven: when MiLEAP
  publishes an update notice, applicable personnel and unsupervised
  volunteers must read/complete it within the notice's stated timeframe
  (R 400.1924(11)).
- **MiRegistry account & membership** — every staff member must hold a
  MiRegistry account with non-expired membership status and a verified
  employment entry within 30 days of employment (R 400.1922).
- **Background-check eligibility** — an eligibility determination before
  unsupervised contact with children (R 400.1919, R 400.1903(1)(r)).

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

MiLEAP licensed-home training is a **different regime** from MiRegistry CDC
training and gets its **own table** — not a polymorphic extension of
`miregistry_training_entries` (OQ1). Reasons:

- The MiRegistry `source` enum is CDC-specific (`leppt`, `annual_ongoing`
  meaning the Dec-16 refresher, `level_2_approved`). None map cleanly to
  the MiLEAP licensed-home categories.
- These records need an **`expires_on`** date (CPR / first aid expires);
  MiRegistry entries never expire. Polymorphism would mean columns that are
  meaningful in only one regime.
- RLS differs: MiRegistry entries are strictly owner-only; these records
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
  'new_hire_training',                    -- R 400.1923 — 14 mandated topics, 90-day deadline
  'cpr_first_aid',                        -- R 400.1920(3) / 1921(3) — expiring certification
  'professional_development',             -- R 400.1924 — per-calendar-year clock hours, by role
  'health_safety_update_acknowledgement', -- R 400.1924(11) — event-driven MiLEAP-notice acknowledgement
  'miregistry_account',                   -- R 400.1922 — account + non-expired membership + employment entry
  'background_check_eligibility',         -- R 400.1919 / 1903(1)(r) — eligibility before unsupervised contact
  'other'                                 -- anything the provider wants on record
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
- Per § 9 decision 4, a licensee may also **insert/update** on the records
  of a staff member with an active `staff_memberships` row pointing at the
  licensee — `entered_by` records who entered each row.

Two of the enum categories — `miregistry_account` and
`background_check_eligibility` — are **status-bearing** rather than simple
completion records (a MiRegistry membership has a status and an expiry; a
background check has an eligibility determination). `staff_training_records`
as drawn above has no `status` column; whether these categories carry a
status via a new column, via `notes`, or via a separate per-person shape is
a data-model decision deferred to the implementation plan. The
MiRegistry-membership field model is specified in § 7.1.

### 2.4 Requirement catalog — reference data

"Who needs which training, how often, with what expiration" is **reference
data**, structurally like `cdc_pay_period_catalog` (PR #6). Unlike earlier
drafts, the requirement values are now **verified** — transcribed from
R 400.1901–1963 in `docs/reference/staff_training_tracking_spec.md`.

- A `training_requirements` catalog — a **seeded table** (§ 9 decision 9),
  not a JS constant — defines, per `(category, role)`: required? /
  frequency / clock-hours / expiration model, each row carrying its
  `R 400.19xx` citation.
- The catalog is seeded with the **confirmed** values from § 6 / § 7 — no
  longer a placeholder. The "compliant? / overdue?" rollup renders as
  authoritative for the categories the rules address.
- Expiration tracking for CPR / first aid works *without* the catalog — an
  `expires_on` date is self-contained.

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

### 2.6 Record retention

R 400.1906(2): staff and driver records "must be retained for the duration
of the individual's employment and a minimum of 2 years after the
individual has left the employment of the licensee." Staff training records
therefore follow a **retain-while-employed + 2-years-after-termination**
policy.

Records are **never hard-deleted** (`archived_at` soft-delete, § 2.3); a
former staff member's records persist and move to the "archived caregivers"
section of the dashboard (§ 9 decision 7). No automatic purge ships in V1 —
2 years is the regulatory floor, and a purge feature is out of V1 scope.
This 2-year figure is the rule-specific retention for staff and driver
files under R 400.1906(2); it is narrower than the general 4-year
audit-retention guidance in `CLAUDE.md`, which governs funding and
attendance records — a different record class.

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
│  ⓘ Requirement rules are verified against MiLEAP rules             │
│     R 400.1901–1963. A cell marked n/a is a role the adopted        │
│     rules do not address. Expiration dates you enter are exact.    │
│                                                                    │
│  [ View a caregiver's full log ]      [ Add a training record ]    │
└────────────────────────────────────────────────────────────────────┘
```

The `ⓘ` note records the regulatory basis: the requirement rules are
verified against MiLEAP R 400.1901–1963 (§ 7.1). Cells driven by an entered
`expires_on` (CPR / first aid) are exact; cells driven by the requirement
catalog are authoritative for every role the rules address, and render
**n/a** for the roles § 7.3 records the adopted rules as silent on.

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
- **Roles the rules are silent on** — where § 7.3 records the adopted rules
  as silent for a role/category, that cell renders **n/a**, not as a gap;
  expiration tracking is unaffected.

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
- `STAFF_TRAINING` — MiLEAP, licensed, multi-person, expiring
  certifications. Activates on `is_license_exempt === false`.

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

Different roles carry different obligations. The role × category matrix
below is transcribed from R 400.1901–1963; OQ13 (the matrix) and OQ14
(minor-assistant rules) are resolved.

### 6.1 Regulatory roles vs. app roles

R 400.1901–1963 distinguishes six roles relevant to training. Two
definitions govern who a requirement reaches:

- **R 400.1901(1)(ff)** — *"'Personnel' means a licensee, child care staff
  member, and child care assistant. It does not include therapeutic
  professionals and independent service providers."*
- **R 400.1901(1)(pp)** — *"'Staff' means personnel and unsupervised
  volunteers."*

So a rule addressed to "all staff" reaches the licensee, child care staff
members, child care assistants, and unsupervised volunteers — but **not**
supervised volunteers (explicitly not "staff") and **not** drivers (not
"personnel").

| Regulatory role | Age | Closest app `staff_memberships.role` |
| --- | --- | --- |
| Licensee | adult | `licensee` |
| Child care staff member | 16+ (R 400.1920(1)) | `adult_staff` |
| Child care assistant | 14–15 (R 400.1921(1)) | `assistant` |
| Unsupervised volunteer | — | *no app role yet* |
| Supervised volunteer | — | *no app role yet* |
| Driver | — | *no app role yet* |

The app's `staff_memberships.role` enum (`licensee` / `adult_staff` /
`assistant` / `view_only`) does **not** map 1:1 to the six regulatory roles
— a 16–17-year-old is a *child care staff member*, not a regulatory
"assistant" (strictly 14–15) — and a person may hold more than one
regulatory role (a staff member who also drives). V1 therefore needs a
**many-to-many person → regulatory-role** assignment, not a single role
field. That mapping and the role-assignment surface are a data-model item
for the implementation plan.

`view_only` users provide no care and carry **no** training obligations
(confirmed by the `useRole` permission map — no `log_attendance` /
`log_incidents`).

### 6.2 Verified role × category matrix

✔ = required (citation in the cell); — = the adopted rules are silent for
that role (§ 7.3 — not asserted).

| Category | Licensee | Staff member | Assistant | Unsup. volunteer | Sup. volunteer | Driver |
| --- | --- | --- | --- | --- | --- | --- |
| `cpr_first_aid` | ✔ R 400.1902(1)(d) | ✔ before care, R 400.1920(3) | ✔ ≤90 days of hire, R 400.1921(3) | — | — | — |
| `new_hire_training` | ✔ R 400.1923(1) | ✔ R 400.1923(1) | ✔ R 400.1923(1) | ✔ R 400.1923(1) | — | only if ratio-counted, R 400.1951(10) |
| `professional_development` | ✔ 10 hrs/yr, R 400.1924(1) | ✔ 5 hrs/yr, R 400.1924(2) | ✔ 5 hrs/yr, R 400.1924(2) | ✔ 1 hr/yr, R 400.1924(3) | — | ✔ 1 hr/yr, R 400.1924(4) |
| `health_safety_update_acknowledgement` | ✔ R 400.1924(11) | ✔ R 400.1924(11) | ✔ R 400.1924(11) | ✔ R 400.1924(11) | — | only if ratio-counted, R 400.1951(10) |
| `miregistry_account` | ✔ R 400.1922 | ✔ R 400.1922 | ✔ R 400.1922 | ✔ R 400.1922 | — | — |
| `background_check_eligibility` | ✔ R 400.1919(1)(a) | ✔ R 400.1919(1)(c) | ✔ registry clearance, R 400.1903(1)(r) | ✔ R 400.1919(1)(d) | ✔ registry clearance, R 400.1903(1)(r) | ✔ if unsupervised access or ratio-counted, R 400.1951(4) |

Matrix notes:

- `new_hire_training`, `professional_development`,
  `health_safety_update_acknowledgement`, and `miregistry_account` reach
  the licensee, staff members, and assistants because each is "staff" /
  "personnel" (R 400.1901(1)(ff), (pp)). The assistant's
  professional-development figure is the 5-hour "personnel, not the
  licensee" amount (R 400.1924(2)) — the assistant is "personnel."
- CPR / first aid is **not** stated by the adopted rules for volunteers or
  drivers — those cells are "—", not asserted.
- The **driver** column reflects R 400.1951: a ratio-counted driver
  complies with R 400.1923 and R 400.1924 — and *only* those two
  (R 400.1951(10) names exactly those rules). It does **not** pull in
  R 400.1922, so `miregistry_account` is "—" for a driver unless they
  independently hold a staff role (§ 6.3 rollup handles that case).
- A driver's `background_check_eligibility` is conditional under
  **R 400.1951(4)**: a comprehensive background check and eligibility
  determination are required for a driver who **either** has unsupervised
  access to children **or** is counted in child-to-staff ratios — two
  independent triggers, either one sufficient. A driver with neither is not
  subject to it.
- Adult household members are subject to background-check eligibility
  (R 400.1919(1)(b)) but are not a tracked caregiver role on the roster.
- The child care assistant also carries non-training restrictions —
  directly supervised at all times (R 400.1921(4)), no substituting for
  staff (R 400.1921(6)), no driving children (R 400.1921(7)), no
  administering medication (R 400.1931(1)). These bound the role but are
  not training records.

### 6.3 Multi-role rollup

A person may hold several regulatory roles. The compliance engine treats
roles as **many-to-many** and rolls up **strictest-wins per category**: if
any of a person's roles requires a category, the person must satisfy it, at
the most stringent threshold among their roles (e.g. staff member 5 hrs +
driver 1 hr → 5 hrs of `professional_development`).

The rule-text basis is **R 400.1951(10)**: *"If the driver is counted in
child to staff ratios, the driver shall comply with R 400.1923 and
R 400.1924."* — a ratio-counted driver acquires the new-hire-training and
professional-development obligations on top of the driver baseline. The
engine generalises this: obligations accumulate across a person's roles.

The requirement engine (§ 2.4) takes this matrix as seeded data, so a
future rule change is a data update, not a code change.

---

## 7. Reference Data — MiLEAP Training Catalog

### 7.1 Verified source

The requirement values are verified in
`docs/reference/staff_training_tracking_spec.md` — one row per requirement,
quoted from R 400.1901–1963 with its citation. The § 2.3 enum and the § 6
role × category matrix are built directly from it.

**Deadlines / timeframes the catalog and engine must encode:**

| Timeframe | Applies to | Citation |
| --- | --- | --- |
| Before caring for children | Staff member CPR + first aid | R 400.1920(3) |
| Before unsupervised contact | Background-check eligibility | R 400.1919(1) |
| Within 90 days of hire | Assistant CPR + first aid | R 400.1921(3) |
| Within 90 days + before unsupervised care | New hire training | R 400.1923(1) |
| Within 30 calendar days of employment | MiRegistry account + membership + employment entry | R 400.1922 |
| Each calendar year | Professional development (10 / 5 / 1 / 1 clock hrs) | R 400.1924(1)–(4) |
| Per certification-card expiry date | CPR + first aid renewal | R 400.1924(8) |
| Timeframe stated on the MiLEAP notice | Health & safety update acknowledgement | R 400.1924(11) |
| Employment + ≥2 years after termination | Record retention | R 400.1906(2) |

**MiRegistry account & membership tracking (R 400.1922).** A staff
member's MiRegistry standing is tracked as **three fields**, entered
manually by the licensee — there is no MiRegistry API integration in V1:

1. **MiRegistry ID** — already stored as `profiles.miregistry_id`.
2. **Membership status** — one of MiRegistry's values: *Submitted*,
   *Materials Received*, *Awaiting Print*, *Current*, *Expired*. The first
   four satisfy R 400.1922(1)'s "non-expired ... membership status that
   would include materials submitted, received, awaiting print, or
   current"; *Expired* does not.
3. **Membership expiry date** (`expires_on`).

Whether those three live as columns on the person or as a status-bearing
`miregistry_account` record in `staff_training_records` is a data-model
decision for the implementation plan (§ 2.3).

### 7.2 The 2-year on-file → MiRegistry cutover

R 400.1922(3), R 400.1923(4), R 400.1924(7), and R 400.1924(10) all pivot
on **"2 years after the effective date of this rule."** The rule took
effect **April 27, 2026**, so the cutover is **April 27, 2028**. Until
then, training verification is maintained on file at the child care home;
on and after that date, qualifications and professional development must be
reflected as verified in MiRegistry, and all professional-development
training must be MiRegistry-approved (R 400.1924(10)). The engine treats
`2028-04-27` as a named constant.

### 7.3 Remaining silences

The adopted rules are **silent** — not "unconfirmed" — on one point. The
§ 6.2 matrix marks it "—"; the implementation must not assert a requirement
where the rule is silent:

- CPR / first aid for unsupervised volunteers, supervised volunteers, and
  drivers — R 400.1920 and R 400.1921 name only the licensee, child care
  staff member, and child care assistant.

This is a genuine gap in the rule text. If a provider's situation needs it
resolved, confirm with the MiLEAP Child Care Licensing Bureau. It does not
block V1 — it is simply not asserted, consistent with the build discipline:
a confident wrong answer in a compliance product is worse than an honest
"not specified."

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
  of a license's training records for a MiLEAP renewal or complaint
  investigation. Durable, and high-value.

### State-mimicry to avoid

- There is **no MiLEAP portal to "submit" staff training to** — individuals
  log training in MiRegistry; MiLEAP *inspects*. So the temptation to
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

## 9. Decisions Recorded (2026-05-17)

Resolved in spec review on 2026-05-17, then reconciled on 2026-05-18
against the verified requirements in
`docs/reference/staff_training_tracking_spec.md` (R 400.1901–1963, MiLEAP).
Of the 16 questions, **fifteen are now resolved**; only **OQ12**
(license-exempt providers with helpers) remains a flagged regulatory
unknown.

1. **Separate `staff_training_records` table.** Approved. Staff training
   records live in their own table (§ 2.3), not polymorphically on
   `miregistry_training_entries` — different categories, an `expires_on`
   column with no MiRegistry analogue, and a different RLS shape (licensee
   read). Polymorphism would force regime-specific nullable columns onto
   one table.

2. **Model B.** Approved. Person-owned records plus a licensee aggregate
   dashboard (§ 2.2). Training follows the person across employers,
   MiRegistry accounts are per-individual, and the licensee gets the
   regulator-facing oversight. Models A and C are rejected for the reasons
   in § 2.2.

3. **Staff have write access to their own records.** Approved. Staff can
   add and edit their own training records — the record is theirs and they
   hold the certificate. Read-only-to-staff was the alternative; resolved
   together with OQ4/OQ5 in favour of staff write access.

4. **Both staff and licensee can enter data.** Approved. Staff may enter
   their own records; the licensee may enter on a staff member's behalf
   (common when onboarding someone not yet logged in). `entered_by` records
   which. RLS permits a licensee insert/update on a member's records.

5. **No approval gate in V1; immediate visibility.** Approved. A
   staff-entered record is visible to the licensee immediately, with no
   approval/verification step. An approval workflow is real but adds a
   state machine — deferred to V2. `entered_by` lets the UI distinguish
   "entered by the staff member" from "entered by you" so the licensee can
   eyeball it.

6. **Feature shows even with no staff.** Approved (§ 4.1). The licensee is
   themselves a tracked caregiver, and the dashboard is where they add
   staff. "No staff" is simply an empty state.

7. **Never hard-delete; archived caregivers section; 2-year retention.**
   Resolved. When a staff member leaves (membership revoked) the record is
   never hard-deleted — it stays person-owned and persists, and former
   staff move to an "archived caregivers" section of the dashboard. The
   retention period is now confirmed: **R 400.1906(2)** requires staff and
   driver records to be kept "for the duration of the individual's
   employment and a minimum of 2 years after the individual has left the
   employment of the licensee" — see § 2.6. No automatic purge ships in V1.

8. **Person-keyed records; licensees see all of a person's records in V1.**
   Approved. Records are keyed on `user_id`, so staff working at multiple
   licensed homes have one CPR record visible to every licensee with an
   active membership for that person. For V1 each licensee sees **all** of
   the person's records (simpler, and training is not sensitive); revisit
   only if a provider objects.

9. **Seeded catalog table for the requirement catalog.** Approved. The
   requirement catalog is a seeded table (`training_requirements`),
   parallel to `cdc_pay_period_catalog`, so confirmed values land as a data
   update rather than a deploy and can carry effective-dated rule changes.
   A JS constant is not used.

10. **New `STAFF_TRAINING` module key.** Approved. A new `STAFF_TRAINING`
    key keyed on `is_license_exempt === false` (§ 5.1), rather than reusing
    `LICENSED_COMPLIANCE`. `LICENSED_COMPLIANCE` stays as the broader space;
    a dedicated key keeps activation legible as more licensed features
    arrive.

11. **Deprecate the MiRegistry § 3.4 stripped-down view when this ships.**
    Approved. Once Staff Training ships, licensed providers are routed here
    and `miregistry_tracker_spec.md` § 3.4's degraded view is retired, with
    that spec updated in the same PR. Confirm no licensed provider relies on
    the MiRegistry page for a personal MiRegistry ID they entered.

12. **License-exempt providers with helpers — out of scope for V1.**
    *Flagged — regulatory unknown.* Whether a license-exempt CDC provider
    with helpers has MDHHS training obligations for those helpers is a
    regulatory unknown the repo cannot answer (§ 4.3). V1 serves licensed
    providers only; the question is flagged, not guessed.

13. **Role × category requirement matrix.** Resolved. The matrix is built
    in § 6.2 from R 400.1920, R 400.1921, R 400.1922, R 400.1923, and
    R 400.1924, with the "personnel" / "staff" scope set by the definitions
    in R 400.1901(1)(ff) and R 400.1901(1)(pp). Cells the adopted rules are
    silent on are marked "—" (§ 7.3), not invented.

14. **Minor (14–15) assistant rules.** Resolved. A child care assistant is
    14–15 years old (R 400.1921(1)), directly supervised at all times
    (R 400.1921(4)), may not substitute for staff (R 400.1921(6)), may not
    drive children (R 400.1921(7)), and may not administer medication
    (R 400.1931(1)). An assistant provides CPR and pediatric first aid
    certification within 90 days of hire (R 400.1921(3)) and, as
    "personnel" (R 400.1901(1)(ff)), completes 5 hours of professional
    development per calendar year (R 400.1924(2)). See § 6.2.

15. **Administering department — MiLEAP.** Resolved. The administering body
    is the **Department of Lifelong Education, Advancement, and Potential
    (MiLEAP)**, Child Care Licensing Bureau. The governing rules are
    Michigan Administrative Code R 400.1901–1963, *Licensing Family and
    Group Child Care Homes*, effective April 27, 2026. "MiLEAP" is used in
    all user-facing copy; the superseded 2019 LARA rules are not used.

16. **Defer the staff first-login prompt to V2.** Approved. Staff still get
    no structural-identity wizard (consistent with
    `onboarding_wizard_spec.md` § 9 decision 5). A lightweight prompt on
    `/staff-training` ("add your current training records") on a staff
    member's first login is reasonable but is deferred to V2; the
    licensee-driven dashboard carries V1.

---

## Appendix — V1 scope summary

| Ships in V1 | Deferred / gated |
| --- | --- |
| `staff_training_records` table + RLS + indexes (migration 012) | Approval/verification workflow (OQ5) |
| `staff_training_category` enum — 7 verified categories (§ 2.3) | MiRegistry transcript import (V2 — `reference_code` seam) |
| `training_requirements` seeded catalog — verified values (§ 6, § 7) | Audit-packet generation (V2 — durable, § 8) |
| Many-to-many person → regulatory-role assignment (§ 6.1) | Email reminders for expiring certs (V2 — needs email infra) |
| Per-person entry form, edit, soft-delete | License-exempt-with-helpers (OQ12 — flagged regulatory unknown) |
| Expiration tracking for CPR / first aid | Staff first-login training prompt (OQ16) |
| Licensee roster compliance dashboard + multi-role rollup (§ 6.3) | MiRegistry API integration (V2) |
| Per-staff training log; staff self-view | |
| `MODULE_KEYS.STAFF_TRAINING` + `modules.js` change + tests | |
| `src/lib/staffTraining.js` pure helpers + Vitest | |
| Runbook entry for migration 012; `tech_debt.md` update; `miregistry_tracker_spec.md` § 3.4 deprecation note (OQ11) | |

V1 explicitly is **not**: a MiLEAP submission portal, a substitute for the
official rule text, or a feature for license-exempt providers.

---

## Reconciliation log — 2026-05-18

This spec was reconciled against the verified requirements file
`docs/reference/staff_training_tracking_spec.md` (Michigan Administrative
Code R 400.1901–1963, MiLEAP, effective 2026-04-27). Every change and the
rule text that drove it:

| § | Change | Driver / citation |
| --- | --- | --- |
| Status, § 1.2, § 2.3, § 5.2, § 8, § 9, Appendix | "LARA" → "MiLEAP" throughout — copy, comments, headings | OQ15 — administering agency is MiLEAP |
| Regulatory caution | "Regulatory caution" (rules unverified) → "Regulatory basis" (rules verified) | Verified requirements file now in the repo |
| § 1.2 | Category list rewritten to the six verified categories | R 400.1919, R 400.1920–1924 |
| § 2.3 enum | Dropped `food_handling` | Food/allergic-reaction response is a *new-hire-training topic*, not a standalone certification — R 400.1923(2)(i) |
| § 2.3 enum | `initial_orientation` → `new_hire_training` | R 400.1923 — "new hire training," 14 topics, 90-day deadline |
| § 2.3 enum | `annual_health_safety` split into `professional_development` + `health_safety_update_acknowledgement` | R 400.1924 (calendar-year PD hours) vs R 400.1924(11) (event-driven update notices) — two distinct obligations |
| § 2.3 enum | Added `miregistry_account` | R 400.1922 |
| § 2.3 enum | Added `background_check_eligibility` | R 400.1919, R 400.1903(1)(r) |
| § 2.3 | Noted the two new categories are status-bearing; storage model deferred to the implementation plan | They carry a status, not just a completion date |
| § 2.3 RLS | OQ4 phrasing ("depends on OQ4") replaced with the resolved write policy | § 9 decision 4 (recorded 2026-05-17) |
| § 2.4 | Catalog reframed from "placeholder until verified" to verified; table `lara_training_requirements` → `training_requirements` | Requirement values now verified; agency-neutral table name |
| § 2.6 (new) | Added record-retention subsection — employment + ≥ 2 years after termination | R 400.1906(2); resolves OQ7. Note: narrower than the general 4-year figure in earlier drafts / `CLAUDE.md` |
| § 3.2, § 3.5 | Disclaimer reworded from "placeholder / unconfirmed" to "verified; n/a where the rules are silent" | § 7 is now verified |
| § 6 | Rebuilt — § 6.1 regulatory roles + the "personnel" / "staff" definitions, § 6.2 verified role × category matrix, § 6.3 multi-role rollup | R 400.1901(1)(ff), R 400.1901(1)(pp); R 400.1902, 1903, 1919–1924; R 400.1951(10) |
| § 7 | Rebuilt — verified source + deadlines table, MiRegistry 3-field membership model, the 2028-04-27 cutover, remaining silences | R 400.1922, R 400.1924(8), R 400.1922(3) / 1923(4) / 1924(7) / 1924(10), R 400.1906(2) |
| § 9 | OQ7, OQ13, OQ14, OQ15 marked resolved with citations; intro updated to "15 of 16 resolved" | R 400.1906(2); R 400.1919–1924; R 400.1921, R 400.1931(1); R 400.1901–1963 |
| Appendix | V1-scope table updated — the verified catalog and the many-to-many role assignment now ship in V1; resolved OQs removed from "deferred" | This reconciliation |
| § 6.2, § 7.3 (follow-up correction) | Driver cells corrected — `miregistry_account` → "—" (R 400.1951(10) extends only R 400.1923 and R 400.1924 to ratio-counted drivers, not R 400.1922); `background_check_eligibility` → "✔ if unsupervised access or ratio-counted"; the matching § 7.3 "silent" line removed | R 400.1951(4) — driver background-check rule, missed in the first requirements transcription |

**Resolved this pass:** OQ7, OQ13, OQ14, OQ15. **Still flagged:** OQ12 —
license-exempt providers with helpers; out of V1 scope, since the verified
rules govern *licensed* homes only.

**Carried to the implementation plan (engineering, not regulatory gaps):**

1. The `staff_memberships.role` → regulatory-role mapping and the
   many-to-many role-assignment surface (§ 6.1).
2. The status-bearing storage model for `miregistry_account` and
   `background_check_eligibility` (§ 2.3).
3. The existing `useRole` `hasMedicationPermission` comment cites
   `R 400.1918` for the no-medication rule; the verified file gives it as
   **R 400.1931(1)**. Verify and correct that comment when `modules.js` /
   `useRole` are touched.
