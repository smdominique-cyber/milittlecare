# PR #21 — Property Records (Rules 13, 15, 17, 18, 45, 48): Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative. **Document-vault decision locked to Option B:** new
sibling `compliance_documents` table (NOT a generalization of
`funding_documents`); see § A.2.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § Updated PR
sequence): PR #21 is the last of the six compliance categories. It
reuses the document-vault pattern from PR #2 (`funding_documents`) +
PR #15's reminder schedule engine + PR #16's acknowledgments table
(for parent disclosures like animal/pet).

**Rule citations:**
- **R 400.1913 (Rule 13) — Child care home maintenance and safety.**
  Premises maintenance. Indirectly drives the lead-paint disclosure for
  pre-1978 homes (parent acknowledgment; handled by PR #16 + this PR's
  facility flag).
- **R 400.1915 (Rule 15) — Heating, ventilation, lighting, radon.**
  Radon test before initial license + every 4 years. Carbon monoxide
  detector on every level used for child care.
- **R 400.1917 (Rule 17) — Animals and pets.** Parent notification of
  pets on premises.
- **R 400.1918 (Rule 18) — Smoking or vaping.** Prohibition posted.
- **R 400.1945 (Rule 45) — Heat-producing equipment.** Furnace /
  heating inspection every 4 years.
- **R 400.1948 (Rule 48) — Smoke detectors, fire extinguishers.** Smoke /
  heat detectors on every floor + sleeping areas; one multipurpose fire
  extinguisher (2A-10BC or larger) per floor of child-use space.

---

## 0. Headline findings (drive the whole plan)

1. **No property/facility schema exists.** Confirmed in the audit.
   Greenfield. The substrate to reuse: PR #2's `funding_documents` + its
   private Storage bucket pattern, generalized.

2. **Two natural tables: `property_records` (per-attribute / per-event)
   and a documents store (the licensing notebook + compliance PDFs).**
   The records table holds the structured data (radon test on date X,
   heating inspection on date Y, detector counts per floor, etc.); the
   documents store holds the artifacts (radon test PDF, inspection
   report, etc.).

3. **Generalize `funding_documents` rather than duplicate the pattern.**
   The vault already supports per-source `document_type` enum,
   `retention_until`, soft delete, retention-sweep index, RLS by
   `auth.uid()`. Either:
   - **A. Add new document types to `funding_documents`'s enum** (e.g.
     `radon_report`, `heating_inspection`, `licensing_notebook_letter`) and
     untangle the funding-only assumption (the table's
     `funding_source_id` would become nullable for non-funding docs).
   - **B. Create a sibling table `compliance_documents`** with the same
     shape but no `funding_source_id`.
   Recommend **B** (cleaner separation of concerns; the two stores have
   different parent entities) but the migration cost is small.

4. **Recurring 4-year schedule engine.** Same shape as PR #19's drill
   schedule: pure function returns next-due-date from `last_performed_on`
   + cadence. The `drillSchedule.js` helper (or a generalized
   `recurringSchedule.js` extracted from it) covers radon and heating
   inspections.

5. **Detector and extinguisher tracking — checklist + attestation.** Not
   a date stream; one row per detector / extinguisher with a
   per-instance `last_checked_on` date and a per-property summary
   (counts vs requirements). Rule 48 says one per floor + sleeping
   areas, so the data model can be as simple as
   `{ kind, location_label, installed_on, last_checked_on }`.

6. **Pet / smoking disclosures.** Pet disclosure uses PR #16's
   acknowledgments table (per-family, type=`pet_disclosure`). Smoking
   prohibition is a posted notice in the home, not a captured signature
   per Rule 18 — but a "smoking prohibition posted" attestation by the
   licensee is a useful product affordance.

---

## Step 2 — Inventory of what exists

**Nothing in code for property.** Adjacent substrate:
- `funding_documents` (PR #2) — the vault pattern (storage bucket + per
  row metadata).
- `acknowledgments` (PR #16) — parent-side pet disclosure.
- `archived_at` convention (PR #13).
- PR #15 reminder system — radon/heating due dates.

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 029** (post-PR-20's 028).

#### A.1 `property_records`

```sql
create table public.property_records (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- The kind of record: a one-time event (test/inspection) or a
  -- standing fact (detector / extinguisher / smoking prohibition).
  record_type              text not null check (record_type in (
                             'radon_test',
                             'heating_inspection',
                             'carbon_monoxide_detector',
                             'smoke_detector',
                             'fire_extinguisher',
                             'smoking_prohibition_posted',
                             'pets_on_premises',
                             'other'
                           )),

  -- Event fields (radon / heating / pet onboarding):
  performed_on             date,                   -- date of test/inspection/attestation
  performed_by             text,                   -- "ABC Inspections, LLC"
  result                   text,                   -- "pass", "fail", "level: 2.1 pCi/L"
  next_due_on              date,                   -- computed by app at write time

  -- Standing fields (detector / extinguisher):
  location_label           text,                   -- "kitchen", "basement", "main floor"
  installed_on             date,
  last_checked_on          date,

  -- Documents pointer (one-to-many resolved via compliance_documents):
  -- not stored here; queried separately.

  notes                    text,
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_property_records_provider_type
  on public.property_records (provider_id, record_type)
  where archived_at is null;

-- Next-due lookup for the reminder scheduler.
create index idx_property_records_next_due
  on public.property_records (provider_id, next_due_on)
  where archived_at is null and next_due_on is not null;
```

`next_due_on` is computed at write time by the app:
- `radon_test`: `performed_on + interval '4 years'`
- `heating_inspection`: `performed_on + interval '4 years'`
- Others: null (event records don't recur).

#### A.2 `compliance_documents` (option B from § 0.3)

```sql
create table public.compliance_documents (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- What this document is about.
  document_kind            text not null check (document_kind in (
                             'radon_report',
                             'heating_inspection_report',
                             'licensing_notebook_inspection',
                             'licensing_notebook_investigation',
                             'licensing_notebook_corrective_action',
                             'licensing_notebook_approval_letter',
                             'other'
                           )),

  -- Optional pointer to the structured record this document evidences.
  property_record_id       uuid references public.property_records(id) on delete set null,

  storage_path             text not null,
  original_filename        text not null,
  content_type             text not null,
  file_size_bytes          bigint not null check (file_size_bytes > 0),

  uploaded_at              timestamptz not null default now(),
  uploaded_by_user_id      uuid references auth.users(id) on delete set null,

  retention_until          date not null default (current_date + interval '4 years')::date,
  archived_at              timestamptz,
  archived_by              uuid references auth.users(id) on delete set null,

  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_compliance_documents_provider_kind
  on public.compliance_documents (provider_id, document_kind)
  where archived_at is null;
```

**Storage bucket:** new private bucket `compliance-documents`, same RLS
template as `funding-documents` (migration 008): first path segment ==
`auth.uid()`. Path: `<user_id>/<property_record_id or 'general'>/<uuid>.<ext>`.

### B. App-code structure

#### B.1 Pure helpers (`src/lib/propertyRecords.js`, new)

- `getRadonState(records, today)` → severity ladder based on
  `next_due_on` (info / warning / urgent / critical / expired).
- `getHeatingInspectionState(records, today)` → same shape.
- `getDetectorCoverage(records, providerContext)` → returns
  `{ smokeDetectorsCount, coDetectorsCount, fireExtinguishersCount,
     floorsExpected, coverageStatus }`. `providerContext` carries the
  declared floor / sleeping-area count (a new BusinessInfoPage facility
  section captures this).
- `getNextDue(record_type, performedOn)` → encodes the 4-year cadence.

#### B.2 Generalize the schedule engine (`src/lib/recurringSchedule.js`)

Lift the recurring-fixed-interval helper out of `drillSchedule.js`
(PR #19) into a shared `recurringSchedule.js`:
- `nextOccurrenceFromInterval(lastOn, intervalYears, today)`.
- Used by both fire drills (PR #19, 3 months) and radon / heating
  (PR #21, 4 years).

#### B.3 Property records page (`src/pages/PropertyRecordsPage.jsx`, new)

Three sub-sections:
1. **Tests and inspections** — radon, heating. List + "Record" button
   per type.
2. **Detectors and extinguishers** — per-instance list with edit/delete +
   coverage summary ("3 smoke detectors on 2 floors; required: 2 +
   sleeping areas").
3. **Disclosures and postings** — toggle attestations: smoking
   prohibition posted (boolean), pets on premises (boolean + species
   list).

Each entry can optionally link an uploaded compliance document
(via `compliance_documents`) — the slot reuses `FundingDocumentSlot`'s
component pattern with a generalized prop set.

#### B.4 Licensing notebook surface

A dedicated section under the property page (or its own route, sidebar
"Compliance → Licensing Notebook"): chronological list of inspection
reports, investigation letters, corrective actions, approval letters
from MDHHS/MiLEAP. Each is a `compliance_documents` row with
`document_kind` set to one of the four `licensing_notebook_*` values.
Filter by year + kind.

**"Available to parents" toggle (per OQ3 resolution: parent-portal
entry V1, no public shareable link).** Toggling a document on flips a
`parent_accessible boolean` column on the `compliance_documents` row.
Parent portal renders a "Licensing notebook" section listing only the
documents the licensee has marked parent-accessible. The rule's
"accessible to parents during operation" requirement is satisfied by
the auth'd portal view — no public URL is generated.

#### B.5 Pet disclosure (PR #16 consumer)

Per OQ4 resolution: **per-family** (the disclosure is about the
premises, not the child). When the provider toggles "pets on premises"
true on the property page, a new acknowledgment requirement appears for
each family:
`type = 'pet_disclosure'`, `subject_type = 'family'`,
`subject_id = families.id`. Existing families flip to "needs pet
disclosure ack" until captured. Same three channels as other PR #16
acknowledgments.

#### B.6 Reminder integration (PR #15)

PR #21 contributes three categories to PR #15's `REMINDER_CATEGORIES`
catalog (names match PR #15 exactly):
- `radon_test_due` — 30 days before `next_due_on`. subject_type =
  `property_record`, subject_id = the radon record.
- `heating_inspection_due` — 30 days before `next_due_on`. Same shape.
- `detector_check_overdue` — annual default per OQ2 resolution; the
  rule (R 400.1948) requires presence + working but doesn't specify
  ongoing-check cadence. The reminder is a product-added best practice;
  default lead time is **annual**, configurable per provider via PR #15's
  preferences UI.

#### B.7 BusinessInfoPage facility section

New small section on `BusinessInfoPage` capturing facility attributes:
- Number of floors used for child care
- Number of sleeping/bedroom areas
- Pets on premises (boolean — drives § B.5)
- Smoking prohibition posted (boolean — the attestation)

These attributes feed `getDetectorCoverage` and the disclosure flow.

#### B.8 Audit-state helper (`getPropertyRecordsAuditState(licenseeId)`, new — cross-cutting requirement)

```js
export async function getPropertyRecordsAuditState(licenseeId) {
  return {
    domain: 'property_records',
    type: 'type_2',                          // MILittleCare-owned.
    radon_test_last_performed_on: null,
    radon_test_next_due_on: null,
    radon_test_overdue: false,
    heating_inspection_last_performed_on: null,
    heating_inspection_next_due_on: null,
    heating_inspection_overdue: false,
    smoke_detectors_count: 0,
    co_detectors_count: 0,
    fire_extinguishers_count: 0,
    detector_coverage_status: 'unknown',     // 'ok' | 'insufficient' | 'unknown'
                                              // — vs floors_used + sleeping_areas
    smoking_prohibition_posted: false,
    pets_on_premises: false,
    families_with_pet_disclosure_missing_count: 0, // when pets_on_premises = true
    licensing_notebook_documents_count: 0,
    licensing_notebook_parent_accessible_count: 0,
  }
}
```

Read-only, single round-trip. Consumed by PR #22.

### C. UI surfaces

- **Compliance → Property Records** (sidebar nav, gated on
  LICENSED_COMPLIANCE).
- **Compliance → Licensing Notebook.**
- **BusinessInfoPage → Facility** (new section).
- **Family modal.** Pet-disclosure pill when applicable.
- **Reminders settings.** Three new toggles.
- **Parent portal.** Licensing notebook section (if the
  parent-accessible toggle is on for a given document).

### D. Module gating

`MODULE_KEYS.LICENSED_COMPLIANCE`. LEPs see nothing.

### E. Tests

- **Pure unit (`propertyRecords.test.js`):** state ladder for radon and
  heating; detector coverage math against various floor counts.
- **Pure unit (`recurringSchedule.test.js`):** generalized
  `nextOccurrenceFromInterval` across years; leap-year edge.
- **Migration test:** CHECK constraints reject invalid record_type /
  document_kind values.
- **Smoke (manual):** record a radon test, observe next_due_on; add
  detectors, observe coverage status; toggle pets-on-premises, observe
  family acks flip to incomplete.
- RTL render tests deferred.

### F. Documentation

- `docs/runbook.md` — migration 029 entry template.
- `docs/tech_debt.md` — generalize the document-vault note from PR #2 if
  the lift to `compliance_documents` reveals shared concerns.
- `CLAUDE.md` — append: "Property records and the licensing notebook
  live in `property_records` and `compliance_documents`. The licensing
  notebook is the audit-trail artifact for inspections / investigations
  / corrective actions / approval letters and must remain accessible to
  parents during operation per Rule 7."

### G. Rollout

1. Apply migration 029 + create the storage bucket. Verify via dashboard.
2. Deploy app; the property page and licensing notebook are live.
3. **Communicate to Venessa:** "Record your most recent radon test and
   heating inspection. Set up detectors. Upload your MiLEAP inspection
   PDFs to the Licensing Notebook so parents can see them."

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **Generalize `funding_documents` (option A) vs new
   `compliance_documents` table (option B)?** **RESOLVED — Option B,
   sibling `compliance_documents` table.** Cleaner separation; zero
   risk to PR #2's funding-document RLS. New private storage bucket
   `compliance-documents` with the same RLS template.

2. **Detector/extinguisher checks — required cadence in code?**
   **RESOLVED — annual default, configurable per provider via PR #15.**
   The rule (R 400.1948) requires presence + working but doesn't specify
   ongoing-check cadence; the annual default is a product-added best
   practice. Provider can adjust lead time on the reminders settings
   page.

3. **"Parent-accessible" toggle on licensing notebook — public URL or
   parent-portal entry?** **RESOLVED — parent-portal entry V1, no public
   shareable link.** Per-document `parent_accessible boolean` toggle on
   `compliance_documents`; parents see the marked documents in the
   portal's Licensing Notebook section.

4. **Pet disclosure: per-family or per-child?** **RESOLVED — per-family.**
   The disclosure is about the premises, not the child.
   `type='pet_disclosure'`, `subject_type='family'`,
   `subject_id=families.id`.

5. **Radon levels — capture the actual reading or just pass/fail?**
   **RESOLVED — free-text `result` V1.** Structured numeric measurement
   is a V2 add when usage demands it.

6. **Will providers want to attach a photo of each detector for
   evidence?** **RESOLVED — out of scope V1.** The structured property
   record is the audit signal. A photo attachment via
   `compliance_documents` could be added later.

---

## Step 5 — Effort estimate

**M.** Modest:
- Two new tables (small, follow established patterns).
- One generalized helper module.
- One new page (three sub-sections — not as deep as PR #19's plan
  editor).
- BusinessInfoPage extension.
- Three reminder categories.
- Document slot reuse (PR #2 component pattern).

The licensing notebook is the prominent new audit surface but mechanically
a list view over `compliance_documents` rows.

---

## Step 6 — Out of scope (future PRs)

- **Public shareable licensing-notebook link** for parents without
  portal access.
- **Radon numeric measurement structured field.**
- **Detector / extinguisher photo evidence.**
- **Auto-extract inspection findings from uploaded PDFs.**
- **Cross-licensee comparison / dashboards** (the audit packet flow,
  which is its own future PR).

---

## Step 7 — Dependencies on prior PRs

- **PR #14 (license_type) — REQUIRED.** All surfaces gate on it.
- **PR #15 (reminders) — REQUIRED.** Radon and heating reminders are the
  primary value.
- **PR #16 (acknowledgments) — REQUIRED for pet disclosure.**
- **PR #2 (funding_documents) — pattern reference.**
- **PR #13 (archived_at convention) — pattern reference.**

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template),
`docs/pr-15-opt-in-reminder-system-scope.md`,
`docs/pr-16-child-files-scope.md`,
`docs/pr-19-drills-emergency-plan-scope.md` (sibling, schedule engine);
`supabase/migrations/008_funding_documents.sql`,
`src/components/funding/FundingDocumentSlot.jsx`,
`src/pages/BusinessInfoPage.jsx`.

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
