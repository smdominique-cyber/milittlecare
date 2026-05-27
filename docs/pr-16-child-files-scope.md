# PR #16 — Child Files (Rule 7) + General Acknowledgments: Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative. **Parent-portal intake self-sign is now in V1 scope**
(was deferred); effort estimate bumps **M → M+** as a result.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ5 + Updated
PR sequence): PR #16 owns the general `acknowledgments` table because the
child-in-care statement (Rule 7) is the first multi-acknowledgment bundle
that needs it. PR #17 (discipline) is the second consumer.

**Cross-PR constraint B (general acknowledgments):** the new
`acknowledgments` table must support arbitrary acknowledgment types
**beyond** Rule 7 — lead-paint disclosure, firearms disclosure, food
provider agreement, infant safe sleep, discipline policy receipt (PR #17),
and the **post-July CDC redetermination "parent responsibility"
acknowledgment** (per `CLAUDE.md` § Critical Domain Knowledge — the
referenced `docs/redetermination-ownership-spec.md` file does not exist
in the repo yet but is named in `docs/backlog.md`). Design with a
**`subject_type` + `subject_id`** discriminator pair (matching PR #15's
shape) so any acknowledgment can bind to any existing entity without
schema churn.

**Rule citation:** **R 400.1907 (Rule 7) — Child's record.** Requires per
child, before initial attendance:
- Child information card (department form or approved substitute)
- Child in care statement signed by parent, covering:
  - Receipt of the discipline policy (PR #17 consumes this acknowledgment)
  - Condition of child's health
  - Acknowledgement that licensing rules were offered
  - Agreement on who provides food
  - **Firearms on premises disclosure** (if applicable; per R 400.1916)
  - **Lead-based paint disclosure** if home built before 1978 (per
    R 400.1913)
  - Notice of licensing notebook availability
- Immunization records or signed waiver
- Annual review of all child records
- Retention: **2 years after child leaves** (PR #13 added
  `archived_at` for the soft-delete substrate; this PR consumes it).

---

## 0. Headline findings (drive the whole plan)

1. **`children` is 14 columns of free text + dates today; intake compliance
   needs structure.** Migration 016 captured `id, user_id, family_id,
   first_name, last_name, date_of_birth, allergies, medical_notes, notes,
   created_at, updated_at`; PR #9's migration 019 added
   `school_enrolled, school_name, school_bell_schedule_json`; PR #13's
   migration 021 added `archived_at`. Rule 7's "child in care statement"
   has **eight bundled sub-acknowledgments** plus an
   immunization/waiver field plus an annual-review timestamp — these are
   net-new columns + ack-table rows.

2. **The acknowledgments table is the load-bearing decision of this PR.**
   Per the PR #14 scoping doc § C, the existing `attendance_acknowledgments`
   (migration 020) **must not be overloaded** — its CHECK, RLS, and
   `attendance_snapshot_hash` are attendance-specific. The new general
   table mirrors PR #12's *pattern* (who/when/channel/snapshot/soft-delete)
   but with `subject_type` + `subject_id` polymorphism. PR #12's pure
   helpers in `src/lib/parentAcknowledgment.js` (`computeAttendanceHash`,
   `getAcknowledgmentState`, etc.) are the templates; PR #16 generalizes
   the hash to `compute<Subject>Hash` per acknowledgment type.

3. **The intake flow is a new UX moment, not a retrofit.** Today's
   Families → Children tab (`FamiliesPage.jsx`'s `ChildrenTab` /
   `ChildForm`, lines ~749–873 pre-PR-13) collects `first_name,
   last_name, date_of_birth, allergies, medical_notes` — five fields. The
   PR #16 intake flow is a longer guided form that captures Rule 7's full
   set and writes the bundle of acknowledgment rows in one transaction.
   Existing children get an "intake incomplete" badge until their
   acknowledgments exist.

4. **`license_type` gating is binary at the surface level.** Per
   constraint C, the entire Children-tab intake-flow extension is hidden
   for `license_type = 'license_exempt'` providers. LEPs see the legacy
   five-field form. Licensed providers (family/group home) see the full
   intake. The `archived_at` retention is universal (already shipped
   PR #13).

5. **Module key `LICENSED_COMPLIANCE` is the new gating mechanism (PR #14).**
   PR #16 surfaces (intake form expansion, child-file completeness
   indicators, annual-review prompts) check
   `modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)` — which post-PR-14
   means `license_type IN ('family_home', 'group_home')`.

---

## Step 2 — Inventory of what exists

### `children` table (current schema)

From migration 016 + migration 019 + migration 021:

```
children: id, user_id, family_id, first_name, last_name, date_of_birth,
          allergies, medical_notes, notes, created_at, updated_at,
          school_enrolled, school_name, school_bell_schedule_json,
          archived_at
```

What's missing for Rule 7:
- Immunization records / waiver field
- Lead disclosure flag (and the home-built-before-1978 indicator on the
  provider profile or family record — see § A)
- Firearms disclosure flag
- Food provider field (provider / parent / both)
- Annual review timestamp
- Pointer to the child-information-card record (if separate)

### Children tab UI

`src/pages/FamiliesPage.jsx#ChildrenTab` — five-field form; archive +
unarchive (PR #13) + show-archived toggle. The single point of child
write today.

### Acknowledgment substrate (from PR #12)

- `attendance_acknowledgments` (migration 020) — attendance-specific, not
  reusable.
- `acknowledgment_flags` (migration 020) — attendance dispute log.
- `src/lib/parentAcknowledgment.js` — pure helpers, reusable in pattern.
- Provider/parent acknowledgment pages — separate from intake; not
  consumed directly here.

### Audit + retention context

- `docs/tech_debt.md` § "Migrations folder is out of sync" — `children`
  exists pre-001 so its full column inventory must be verified at
  implementation time per the production-introspection convention.
- `archived_at` (PR #13) — present, ready to use for the 2-year retention.

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 024** (post-PR-15's 023; verify before authoring).

Two themes: extend `children` for the structured Rule 7 fields, and
introduce the **general `acknowledgments` table** (per OQ5 + constraint B).

#### A.1 `children` extensions

```sql
alter table public.children
  add column if not exists immunization_status text
    check (immunization_status is null
      or immunization_status in ('up_to_date', 'waiver_on_file', 'in_progress')),
  add column if not exists immunization_record_url text,   -- optional storage pointer
  add column if not exists food_provider text
    check (food_provider is null
      or food_provider in ('provider', 'parent', 'both')),
  add column if not exists records_last_reviewed_on date,  -- annual review
  add column if not exists intake_completed_at timestamptz; -- set when the Rule 7
                                                            -- bundle of acknowledgments
                                                            -- is satisfied
```

Lead-paint disclosure is **per-property** (the home), not per-child —
recommend living on `profiles` (the home-built-before-1978 indicator)
**plus** a per-child acknowledgment row confirming the parent received the
disclosure. So:

```sql
alter table public.profiles
  add column if not exists home_built_before_1978 boolean;
-- nullable; the in-product prompt sets it. Used to decide whether the
-- intake flow requires a lead disclosure acknowledgment.
```

Firearms is **per-property + per-acknowledgment** too: the provider may
or may not have firearms on premises (per Rule 16 / R 400.1916 — secure
storage rules apply only if yes). The disclosure acknowledgment is
required at intake regardless (parent must affirmatively know).

```sql
alter table public.profiles
  add column if not exists firearms_on_premises boolean;
-- nullable; the in-product prompt sets it. The intake flow shows
-- different disclosure copy depending on the answer.
```

#### A.2 General `acknowledgments` table (the load-bearing piece)

```sql
create table public.acknowledgments (
  id                       uuid primary key default gen_random_uuid(),

  -- The provider whose intake / records this acknowledgment lives under.
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- What is being acknowledged. type is a free-text discriminator (PR #14
  -- text+CHECK pattern); subject_type / subject_id is polymorphic.
  type                     text not null,    -- 'child_in_care_statement', 'discipline_policy_receipt',
                                              -- 'lead_disclosure', 'firearms_disclosure',
                                              -- 'food_provider_agreement', 'licensing_notebook_offered',
                                              -- 'infant_safe_sleep', 'staff_discipline_policy_receipt'
                                              -- (PR #17), plus future categories.
  subject_type             text,              -- 'child', 'caregiver', 'family', 'provider'
                                              -- — or null for provider-level.
  subject_id               uuid,              -- references the row of subject_type.

  -- Who acknowledged.
  acknowledged_by_user_id  uuid references auth.users(id) on delete set null,
  acknowledged_by_label    text,              -- when no user row exists (e.g. a
                                              -- parent who signs on paper and
                                              -- the provider records it).
  acknowledged_via         text not null check (
    acknowledged_via in ('parent_portal', 'provider_override', 'in_person_paper')
  ),
  acknowledged_at          timestamptz not null default now(),
  provider_override_reason text,              -- required for 'provider_override'.

  -- Snapshot of what was acknowledged at the time. The hash format is
  -- per-type — child_in_care_statement uses a hash of the intake-form
  -- contents; lead_disclosure hashes the disclosure copy version; etc.
  -- Lets PR #18 / future rules detect drift between acknowledgment and
  -- current value (e.g. did the discipline policy change since the
  -- parent acknowledged it?).
  snapshot_hash            text,
  snapshot_version         text,              -- a policy version identifier when
                                              -- relevant (e.g. discipline_policy_v3).

  archived_at              timestamptz,       -- soft delete (PR #13 convention).
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Channel shape: parent_portal requires a known user; provider_override
  -- requires a reason; in_person_paper requires a label.
  constraint acknowledgments_channel_shape check (
    case acknowledged_via
      when 'parent_portal'
        then acknowledged_by_user_id is not null
             and provider_override_reason is null
      when 'provider_override'
        then provider_override_reason is not null
             and length(trim(provider_override_reason)) > 0
      when 'in_person_paper'
        then acknowledged_by_label is not null
             and length(trim(acknowledged_by_label)) > 0
    end
  )
);

-- One ACTIVE acknowledgment per (provider, type, subject). An older
-- acknowledgment must be soft-archived before a re-acknowledgment lands.
create unique index acknowledgments_active_unique
  on public.acknowledgments (provider_id, type, subject_type, subject_id)
  where archived_at is null;

-- Active acks by subject — banner / completeness queries.
create index acknowledgments_subject_active
  on public.acknowledgments (subject_type, subject_id)
  where archived_at is null;
```

**RLS:**
- Provider sees rows where `provider_id = auth.uid()`. SELECT + INSERT +
  UPDATE (for archive). No DELETE policy (soft-delete only).
- Parents see rows where `subject_type='child' and subject_id in
  (children for their family via parent_family_links)` — same pattern as
  `attendance_acknowledgments` (migration 020).

#### A.3 What this PR deliberately does NOT model in V1

- A separate **versioning history** of disclosure copy (lead/firearms).
  V1 stores `snapshot_version` as a freeform tag; PR #17 may evolve this
  for discipline-policy version tracking.
- A **flags / dispute** equivalent of `acknowledgment_flags` for the new
  table. PR #12's flag mechanism is attendance-specific; intake disputes
  are vanishingly rare (parents disagreeing with whether they signed
  intake). Defer to a future PR if it surfaces.

### B. App-code structure

#### B.1 Pure helpers (`src/lib/acknowledgments.js`, new)

Generalizes `src/lib/parentAcknowledgment.js`'s pattern:
- `computeAckHash({ type, payload })` — type-dispatched hash function
  (FNV-1a 32-bit synchronous, same family as PR #12's helper).
- `computeEnvelopeHash(subRowHashes[])` — composite hash for the
  envelope row of a multi-disclosure bundle (see § A.2 envelope
  decision). Stable across re-orders by sorting sub-row hashes.
- `findActiveAck(acks, { type, subjectType, subjectId })` — selector.
- `getChildFileCompleteness(child, acks)` → returns
  `{ acknowledgmentsPresent: [], acknowledgmentsMissing: [],
  immunizationStatus, recordsReviewDue }` — used by the
  intake-incomplete badge and Children-tab UI.

#### B.1a Audit-state helper (`getChildFilesAuditState(licenseeId)`, new — cross-cutting requirement)

Per the audit-state mandate, PR #16 exposes a pure helper in
`src/lib/childFiles.js`:

```js
export async function getChildFilesAuditState(licenseeId) {
  return {
    domain: 'child_files',
    type: 'type_2',                       // MILittleCare-owned.
    active_children_count: 0,
    intake_complete_count: 0,             // intake_completed_at IS NOT NULL
    intake_incomplete_count: 0,
    annual_review_overdue_count: 0,       // records_last_reviewed_on + 1y < today
    pending_lead_disclosures_count: 0,    // licensee has home_built_before_1978=true
                                          // AND child intake lacks lead_disclosure ack
    pending_firearms_disclosures_count: 0,
  }
}
```

Consumed by future PR #22 (Compliance Health Score). Read-only,
single round-trip.

#### B.2 Intake form expansion (`src/pages/FamiliesPage.jsx#ChildForm` → split)

Refactor: `ChildForm` becomes `ChildBasicsForm` (existing five fields,
unchanged for LEPs). Licensed providers see an additional `ChildIntakeForm`
component below it that captures:
- Immunization status (radio: up_to_date / waiver_on_file / in_progress)
- Food provider (radio: provider / parent / both)
- Annual review date (date input, auto-set on save)
- A guided "Child-in-care statement" capture block that, on save,
  writes the bundle of `acknowledgments` rows in a single transaction:
  - `child_in_care_statement` (the parent envelope)
  - `discipline_policy_receipt` (consumed in PR #17, but ack row exists
    now)
  - `lead_disclosure` (only if `home_built_before_1978 = true`)
  - `firearms_disclosure` (always — copy varies by
    `firearms_on_premises`)
  - `food_provider_agreement`
  - `licensing_notebook_offered`
  - `infant_safe_sleep` (only if child age < 18 months — per R 400.1930)

The bundle is conditional; the guided form only shows the items that
apply. A "Save intake" button persists everything together. **Two
capture channels are supported in V1** (post-review decision — see § B.6
parent-portal extension):

- **Provider-collected** (paper or in-person): `acknowledged_via =
  'in_person_paper'` with a typed parent label, OR `provider_override`
  with a reason.
- **Parent self-sign** (new in V1): provider triggers a portal
  notification; parent acknowledges in the portal at their own time.
  Writes `acknowledged_via = 'parent_portal'` and ties to the parent's
  `auth.users.id`.

**Envelope + 7 sub-rows.** Per OQ4: the bundle is mechanically stored as
**1 envelope row** (`type = 'child_in_care_statement'`,
`snapshot_hash = computeEnvelopeHash(sub-row hashes)`) **plus N
sub-rows** (one per conditional disclosure that applies). The envelope's
existence + match to current envelope-hash is the single completeness
predicate.

`intake_completed_at` on `children` is set when the envelope row exists
active AND its `snapshot_hash` matches the current
`computeEnvelopeHash(...currentSubRowHashes)` value (i.e. nothing has
drifted since acknowledgment).

#### B.3 Completeness badge + indicators

- The Children tab adds an "Intake incomplete" pill on cards where
  `intake_completed_at IS NULL` (licensed providers only).
- Click the pill → opens the guided intake form pre-loaded with whatever
  is already present.
- The Family list card surfaces a per-family "N children with intake
  incomplete" badge.

#### B.4 Annual review reminder

PR #15 category `child_annual_review`. The scheduler inserts a
`reminder_instances` row 30 days before the child's
`records_last_reviewed_on + 1 year` (or, for never-reviewed,
30 days after intake_completed_at). Provider opens the form → confirms
review → updates `records_last_reviewed_on`. The reminder is satisfied
on update.

#### B.5 Lead/firearms disclosure capture (provider profile)

Two new BusinessInfoPage sections (or a single "Premises" section):
- "Was your home built before 1978?" (lead disclosure gate)
- "Are firearms kept on the premises?" (firearms disclosure gate)

These set `profiles.home_built_before_1978` and
`profiles.firearms_on_premises`. The intake form reads these to decide
which acknowledgments to require.

If a provider toggles `home_built_before_1978` from false → true after
existing intakes were captured without lead disclosure, the affected
children flip to "intake incomplete." Same for firearms.

#### B.6 Parent-portal intake extension (NEW IN V1, post-review)

Per OQ1 resolution: **parent self-sign ships in PR #16**, not as a
follow-up. Concretely:
- Extend the existing parent acknowledgment portal page (from PR #12,
  `/parent/acknowledge` or its current path) with an **Intake** tab.
- The tab lists every pending acknowledgment row in
  `public.acknowledgments` where `subject_type = 'child'`,
  `subject_id IN (parent's children)`, and the row is the envelope OR a
  sub-row that the provider has flagged for parent self-sign (the
  provider's UI gets a per-row toggle "collect via portal vs. paper").
- Parent reviews the disclosure copy (the version they're acknowledging)
  and confirms. Writes a new active `acknowledgments` row with
  `acknowledged_via = 'parent_portal'` and the parent's `auth.uid()`.
- The envelope row's `snapshot_hash` is recomputed on the server side
  after all sub-rows land — or, more practically, the parent's "Confirm
  envelope" final step writes the envelope row composing the current
  sub-row hashes.
- **Email notification** is sent via PR #15's reminder dispatcher with
  a new ad-hoc category (`intake_acknowledgment_pending`) — fires when
  the provider triggers portal collection; cleared when the parent
  completes. Optional V2: weekly digest reminder.

The provider's intake form gets a small affordance per acknowledgment
row: a toggle between "I'll collect this on paper" (default) and "Ask
parent via portal" (the new path). When portal is chosen, the row is
stamped "awaiting parent" until acknowledged.

Existing parent-acknowledgment substrate to reuse:
- `parent_family_links` (RLS join path).
- Resend email template scaffolding from PR #12's digest cron.
- `acknowledged_via = 'parent_portal'` (already enumerated in the PR #16
  channel-shape CHECK).

### C. UI surfaces (in plain words)

- **Families → Children tab → Add/Edit child.** Two-section form for
  licensed providers: basics (existing) + Rule 7 intake bundle (new).
  Inline help (per CLAUDE.md) explains each disclosure plainly.
- **Family card.** Per-child intake-incomplete pill.
- **Provider profile → Business Info → Premises.** Two boolean
  disclosures driving intake conditional flows.
- **Dashboard (via PR #15 reminders).** Banner when a child's annual
  review is due.
- **Parent portal — Intake tab (V1, new).** Extension of the existing
  PR #12 parent-acknowledgment page. Lists every pending intake
  acknowledgment for the parent's children with disclosure copy in plain
  language. Parent confirms each, then confirms the envelope. Email
  notification on the provider triggering portal collection (PR #15
  dispatcher).

### D. Module gating

The Rule 7 intake extension and badges gate on
`MODULE_KEYS.LICENSED_COMPLIANCE` (post-PR-14: license_type IN
(family_home, group_home)). LEPs see the legacy five-field form.

The `acknowledgments` table itself is **not** gated — it's general infrastructure.
PR #17's staff-hire acknowledgments will use it without re-introducing the
gate.

### E. Tests

- **Pure unit (`acknowledgments.test.js`):** type-dispatched hash for two
  illustrative types; active-ack selector; `getChildFileCompleteness`
  matrix (children with no acks, partial, all present; lead-required vs
  not).
- **Migration test:** unique constraint rejects a duplicate active ack;
  channel-shape CHECK rejects mis-shaped rows.
- **Smoke (manual):** create child intake, observe bundle of ack rows;
  archive child, observe acks remain (retention); toggle
  `home_built_before_1978` and verify the child flips to incomplete.
- RTL render tests deferred per house convention.

### F. Documentation

- `docs/runbook.md` — migration 024 entry template.
- `docs/tech_debt.md` — note: the `acknowledgments` table is intentionally
  parallel to `attendance_acknowledgments`; a future cleanup PR could
  unify them, but the cost (CHECK / RLS / hash semantics divergence) is
  meaningful; do not unify without explicit need.
- `CLAUDE.md` — append to § Critical Domain Knowledge: "General
  `acknowledgments` table (PR #16) — every non-attendance acknowledgment
  uses this table with a `type` discriminator. Attendance
  acknowledgments stay in `attendance_acknowledgments` for hash/RLS
  reasons."

### G. Rollout

1. Apply migration 024 (extends children + creates acknowledgments).
2. Deploy app; licensed providers see the intake extension; existing
   children show "intake incomplete" until acknowledgments are recorded.
3. **Communicate to Venessa:** "Your existing children need an intake
   sweep — here's how, takes ~3 min per child." Provide the per-child
   open-then-save flow.
4. Within the 90-day compliance window, the intake_completed_at column
   becomes the audit-ready signal.

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **Should the parent-portal extension ship in PR #16 or be deferred?**
   **RESOLVED — INCLUDED in PR #16, not deferred.** Effort bumps from M
   to **M+**. See § B.6 for the implementation plan: extends the
   existing parent portal page from PR #12 with an intake-acknowledgment
   surface; email notification via PR #15 when intake acks are pending;
   parent self-sign channel writes directly to `acknowledgments` with
   `acknowledged_via = 'parent_portal'`.

2. **Annual review enforcement — soft or hard?** **RESOLVED — soft.**
   Reminder + badge only. No billing block. Annual-review hard
   enforcement is explicitly out of scope.

3. **Existing children — backfill strategy?** **RESOLVED — option (a).**
   Existing children flip to "intake incomplete" until the provider
   sweeps. No inference from existing data, no bulk-override button.

4. **Snapshot-hash semantics for the bundle.** **RESOLVED — envelope row
   + sub-disclosure rows with composite hash on the envelope.** One
   envelope row (`type = 'child_in_care_statement'`) carries
   `snapshot_hash = computeEnvelopeHash(sub-row hashes)`; each sub-row
   (lead_disclosure, firearms_disclosure, food_provider_agreement,
   licensing_notebook_offered, infant_safe_sleep, discipline_policy_receipt,
   plus a "health condition" disclosure row — see Rule 7 sub-bullets) has
   its own per-row `snapshot_hash`. Up to 7 sub-rows + the envelope per
   intake. Drift detection compares envelope hash to recomputed
   envelope hash at read time.

5. **`provider_id` denormalization on `acknowledgments`.** **RESOLVED —
   YES, denormalize.** `provider_id` is stored directly on every row
   matching PR #12's pattern; RLS path is simpler and the dashboard
   audit-state helper benefits from the direct index.

---

## Step 5 — Effort estimate

**M+.** Bumped from M after the 2026-05-26 review made the parent-portal
extension V1 scope (OQ1). The new V1 work:
- Extension of the existing PR #12 parent-acknowledgment page with an
  Intake tab.
- Email notification dispatch via PR #15 (`intake_acknowledgment_pending`
  category) when the provider triggers portal collection.
- Per-row "collect via portal vs. paper" toggle on the provider intake
  form.
- Envelope-hash recomputation on parent confirm.

The base PR #16 work (migration, intake form, acknowledgments table,
pure helpers) stays at M. The acknowledgments table is V1-correct from
day one if the `subject_type` / `subject_id` polymorphism lands as
specified. Future consumers (PR #17 discipline, PR #20 medication
parent permission, post-July CDC redetermination) are zero-migration
additions.

---

## Step 6 — Out of scope (future PRs)

- **Hard enforcement of annual review** (OQ2 resolved to soft).
- **Acknowledgment dispute/flag mechanism** for the new table —
  no current demand.
- **Discipline policy storage** — PR #17's scope (PR #16 only seeds the
  ack-row type).
- **Medication parent permission** — PR #20 consumes the table.
- **CDC redetermination parent responsibility ack** — post-July; the
  table accommodates it without change.
- **Snapshot-copy versioning for disclosures** — V1 stores a freeform
  `snapshot_version`; full version history is a future move if disclosure
  copy review cadence demands it.
- **Weekly digest of pending parent-portal intake acks** — PR #15's
  digest substrate could carry it; not in V1.

---

## Step 7 — Dependencies on prior PRs

- **PR #13 (`children.archived_at`) — REQUIRED.** The 2-year retention
  post-attendance-end uses this.
- **PR #14 (license_type) — REQUIRED.** The intake-extension and
  completeness badges gate on it.
- **PR #15 (reminders) — REQUIRED for the V1 parent-portal email
  notification path** (OQ1 resolution). Without PR #15, the portal still
  works but parents don't get the notification email — degrades the V1
  experience meaningfully. PR #15 also powers `child_annual_review`
  reminders.
- **PR #12 (parent acknowledgment) — REQUIRED for the portal extension**
  surface (V1 extends its existing page). The migration scaffolding +
  Resend template are reused.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template);
`supabase/migrations/016_capture_existing_schema_for_pr_8_5.sql`,
`supabase/migrations/019_pr_9_i_billing_schema.sql`,
`supabase/migrations/020_parent_acknowledgment.sql`,
`supabase/migrations/021_children_archived_at.sql`;
`src/pages/FamiliesPage.jsx#ChildrenTab` and `#ChildForm`,
`src/lib/parentAcknowledgment.js` (pattern reference),
`src/lib/modules.js` (LICENSED_COMPLIANCE gate).

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
