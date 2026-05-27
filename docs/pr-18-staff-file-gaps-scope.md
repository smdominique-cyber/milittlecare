# PR #18 — Staff File Gaps (Rules 3, 6, 19, 20, 22, 33): Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative. **Production introspection of `staff_time_entries`
complete:** column shape today is `staff_user_id uuid NOT NULL` with no
`caregiver_id` column — the XOR pattern in § A.3 is required to make
non-app-user clock entries possible.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` §§ OQ8 + Updated
PR sequence): PR #8 (staff training tracking) already shipped most of
Category E. This PR fills three remaining gaps identified in the audit:
**physician attestation** (Rule 33), **non-app-user staff arrival/departure
log** (Rule 6, OQ8 decision: provider-entered log is acceptable; expand
`staff_time_entries` to support caregiver_id-keyed manual entries), and a
**registry-clearance discriminator** on background-check eligibility
(Rule 3.r).

**Cross-PR constraint E (MiRegistry as system of record):** PR #18
explicitly does NOT duplicate training content. We track dates only
(annual training completion, professional-development hours,
certification expirations) and link out to MiRegistry. PR #8 already
established this contract; PR #18 inherits it.

**Rule citations:**
- **R 400.1903(1)(r) — Sex offender registry clearance for assistants
  and unsupervised volunteers.** PR #8's `background_check_eligibility`
  records cover this but lack a discriminator separating CCBC eligibility
  from sex-offender-registry clearance.
- **R 400.1906 — Child care home records.** Personnel records must
  include daily arrival and departure times. Today's `staff_time_entries`
  covers app-user staff only; drivers / volunteers / non-app-user
  assistants have no surface.
- **R 400.1919 — Comprehensive background check, fingerprinting.**
  Already covered by PR #8 (manual status capture).
- **R 400.1920 / R 400.1921 — Staff member / assistant employment
  requirements.** CPR/First Aid + age. CPR/First Aid coverage exists in
  PR #8; this PR adds the reminder integration via PR #15.
- **R 400.1922 — MiRegistry.** Already covered by PR #8.
- **R 400.1933 — Communicable disease, immunization, physician
  attestation.** Annual physician attestation that the personnel
  member is physically and mentally healthy. **NEW** — not in PR #8's
  enum; this PR adds it.

---

## 0. Headline findings (drive the whole plan)

1. **PR #8 covers ~80% of Category E; PR #18 is the focused gap-fill.**
   Caregivers, regulatory roles, training records with CPR/First Aid
   `expires_on`, MiRegistry status, background-check eligibility, and the
   `StaffComplianceMatrix` UI all exist. The audit identified three gaps;
   this PR closes them.

2. **Physician attestation is the largest piece.** Rule 33 requires an
   annual physician attestation per personnel member. PR #8's
   `staff_training_category` enum has no `physician_attestation` value;
   adding one is the schema move. The expiration semantics already exist
   (`expires_on` column on `staff_training_records`); we set `+1 year`
   from `completed_on` per the rule.

3. **Non-app-user clock is a structural extension of `staff_time_entries`,
   not a new table.** Per OQ8: today the table is `staff_user_id`-keyed
   (an app user clocking themselves). Add a `caregiver_id` foreign key
   that's mutually exclusive with `staff_user_id` (a CHECK), and an
   `entered_by` field for provider-on-behalf entries. The licensee
   surface (`StaffPage` or a new sub-tab) lets the licensee record arrival
   /departure for non-app-user caregivers.

4. **Registry-clearance discriminator is small but real.** Today's
   `background_check_eligibility` records cover Rule 19 (CCBC) AND
   Rule 3.r (sex offender registry) without distinction. Adding a
   `check_type` discriminator (text + CHECK: `ccbc` | `sex_offender_registry`)
   keeps both queryable. Most providers will record both; the matrix
   shows both columns.

5. **CPR/First Aid expiration reminders need PR #15.** PR #8 stores
   `expires_on` but has no reminder integration — the staff-training
   page surfaces it as a badge. PR #18 adds a scheduler that inserts
   `reminder_instances` rows N days before each cert's
   `expires_on` (per PR #15's `cpr_first_aid_expiration` category, default
   lead 30 days). Same for physician attestation
   (`physician_attestation_expiration` category, lead 30 days).

---

## Step 2 — Inventory of what exists (PR #8)

### Tables

- `caregivers`: id, licensee_id, full_name, email, app_user_id,
  date_of_hire, archived_at, created_at, updated_at.
- `caregiver_regulatory_roles`: caregiver_id, regulatory_role (enum:
  licensee / child_care_staff_member / child_care_assistant /
  unsupervised_volunteer / supervised_volunteer / driver),
  driver_ratio_counted, driver_has_unsupervised_access.
- `staff_training_records`: id, caregiver_id, category (enum:
  new_hire_training / cpr_first_aid / professional_development /
  health_safety_update_acknowledgement / miregistry_account /
  background_check_eligibility / other), title, completed_on, expires_on,
  hours, issuer, reference_code, miregistry_status, background_check_status,
  notes, entered_by, archived_at, archived_by, created_at, updated_at.
- `health_safety_updates`: per-licensee MiLEAP notice tracking
  (R 400.1924(11)).
- `staff_time_entries` (production-only): id, staff_user_id, licensee_id,
  clock_in, clock_out, clock_in_latitude, clock_in_longitude,
  clock_in_location_status, clock_out_*, … (per `StaffClockWidget.jsx`).

### Enums

- `staff_training_category` — no `physician_attestation` value.
- `background_check_status` — pending / eligible / ineligible.
- `miregistry_status` — submitted / materials_received / awaiting_print /
  current / expired.

### UI

- `/staff-training` page with `StaffComplianceMatrix`,
  `ExpiringSoonList`, `CaregiverTrainingLog`, `TrainingEntryForm`,
  `RegulatoryRoleAssignment`.
- `StaffClockWidget` (dashboard) — self clock-in/out for app-user staff.

### Audit-doc reference

`docs/licensed-home-compliance-audit-2026-05-23.md` § Category E:
- **NOT modeled:** physician attestation; non-app-user clock.
- **Partially expressible:** sex-offender-registry clearance via
  `background_check_eligibility` — no discriminator.

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 026** (post-PR-17's 025).

#### A.1 Add `physician_attestation` to `staff_training_category`

Per OQ1 resolution: **run normally**; the fallback two-migration
sequence applies **only if it fails at apply time** (it shouldn't on
modern Supabase Postgres).

```sql
-- staff_training_category is a Postgres ENUM (migration 012). Supabase
-- Postgres supports ALTER TYPE ADD VALUE inside a transaction; we
-- proceed on that basis.
alter type public.staff_training_category add value if not exists 'physician_attestation';
```

Fallback (if apply fails): a no-op "reserve the name" patch first, then
the consuming code in a separate apply. Treat this as a contingency,
not the plan.

#### A.2 Add `check_type` to `staff_training_records` (registry discriminator)

```sql
alter table public.staff_training_records
  add column if not exists check_type text
    check (check_type is null
      or check_type in ('ccbc', 'sex_offender_registry'));

-- check_type is only meaningful for category='background_check_eligibility'.
-- The existing `background_check_status` column stays as-is.
```

**Backfill — automatic** per OQ2 resolution. Existing
`background_check_eligibility` rows get `check_type = 'ccbc'` as the
default. The migration includes a **pre-UPDATE `SELECT` count** so the
provider's screenshot captures how many rows the backfill touched:

```sql
begin;

-- Audit signal: how many rows are about to be backfilled?
select count(*) as rows_to_backfill
from public.staff_training_records
where category = 'background_check_eligibility'
  and check_type is null
  and archived_at is null;

update public.staff_training_records
   set check_type = 'ccbc'
 where category = 'background_check_eligibility'
   and check_type is null
   and archived_at is null;

-- Post-UPDATE check (informational): per-type counts.
select check_type, count(*)
  from public.staff_training_records
 where category = 'background_check_eligibility'
 group by check_type;

commit;
```

A licensee who needs to re-categorize a row as `sex_offender_registry`
can do so via the matrix UI; no migration re-run required.

#### A.3 Extend `staff_time_entries` for non-app-user caregivers

`staff_time_entries` is production-only (no migration file).
**Production introspection complete 2026-05-26:** today's shape is
`staff_user_id uuid NOT NULL` with no `caregiver_id`. The XOR pattern
below is required and correct.

```sql
-- Today's column: staff_user_id uuid NOT NULL. Drop NOT NULL, add caregiver_id.
alter table public.staff_time_entries
  alter column staff_user_id drop not null,
  add column if not exists caregiver_id uuid
    references public.caregivers(id) on delete cascade,
  add column if not exists entered_by uuid
    references auth.users(id) on delete set null;

-- Exactly one of staff_user_id / caregiver_id must be set.
alter table public.staff_time_entries
  add constraint chk_staff_time_subject
  check (
    (staff_user_id is not null and caregiver_id is null)
    or (staff_user_id is null and caregiver_id is not null)
  );

-- The provider-on-behalf entries must be entered by the licensee.
-- For self-clock app-user entries, entered_by = staff_user_id.
-- The CHECK above guarantees subject identity; entered_by is
-- informational + audit.
```

**RLS implications:** the existing per-`staff_user_id` policies need a
parallel branch for `caregiver_id`-keyed rows (licensee can read/write
rows where they own the caregiver). Audit the production policies via
the same introspection step.

### B. App-code structure

#### B.1 `staff_training_category` mapping update

`src/lib/staffTraining.js` enumerates categories with display labels.
Add `'physician_attestation'` with label "Physician attestation
(annual)". Default `expires_on` for this category = `completed_on + 1
year`.

#### B.2 Caregiver clock surface (on `/staff`, per OQ3)

A new sub-tab on `StaffPage` (`/staff`): the licensee picks a non-app-user
caregiver from their roster, enters clock_in / clock_out times (today
or backdated), and the row is written with `caregiver_id` and
`entered_by = auth.uid()`. **Not** on `/staff-training` — the training
matrix carries a presence indicator only, not the detailed log.

The existing `StaffClockWidget` (dashboard) for app-user staff is
unchanged.

#### B.3 Compliance matrix extensions

Add columns to `StaffComplianceMatrix`:
- **Physician attestation** — current/expired/missing per caregiver.
- **Background check (CCBC)** and **Sex offender registry clearance** —
  two separate columns, filtered by the new `check_type`.
- **Daily clock log** — a presence indicator (has the last 30 days got
  entries?) per caregiver.

#### B.4 Reminder integration (PR #15)

New categories in `REMINDER_CATEGORIES`:
- `cpr_first_aid_expiration` (subject_type=caregiver) — scheduler reads
  `staff_training_records` rows where `category='cpr_first_aid'` and
  inserts a `reminder_instances` row at `expires_on - lead_time_days`.
- `physician_attestation_expiration` (subject_type=caregiver) — same
  shape, against `category='physician_attestation'` rows.

PR #18's scheduler shim is per-caregiver, runs on the existing PR #15
dispatcher cron's pre-tick refresh, and is idempotent against the
unique `(provider_id, category, subject_type, subject_id, trigger_at)`
index on `reminder_instances`.

#### B.5 Pure helpers (`src/lib/staffTraining.js` extensions)

- `getPhysicianAttestationState(record, today)` → matches the existing
  `getCprFirstAidState` shape; returns severity ladder. **Per OQ4 the
  attestation is per-personnel including the licensee themselves**
  (PR #8 already models the licensee as a caregiver row via
  `regulatory_role = 'licensee'`).
- `splitBackgroundChecksByType(records)` → returns
  `{ ccbc: [...], sex_offender_registry: [...] }`.
- `getCaregiverClockPresence(entries, days = 30)` → returns
  `{ hasRecentEntries, lastEntryDate }` for the matrix indicator.

#### B.5a Audit-state helper (`getStaffFilesAuditState(licenseeId)`, new — cross-cutting requirement, **Type 1 + Type 2**)

PR #18 is the **only** PR in this scoping pass with mixed-source
data. Per the audit-state mandate and cross-cutting addition B, the
helper distinguishes:

- **Type 1 — MiRegistry mirror data.** Items mirrored from MiRegistry
  (annual ongoing training completion dates, professional-development
  hours, MiRegistry account status). MiRegistry is the system of record
  (constraint E); MILittleCare displays them but **does NOT count them
  in the audit score by default**. PR #22 (Compliance Health Score)
  applies opt-in rules for these.
- **Type 2 — MILittleCare-owned data.** CPR/First Aid expirations the
  provider records here, physician attestations, background-check
  status, clock entries, discipline-policy receipts (PR #17). These ARE
  counted by default.

Helper signature:

```js
export async function getStaffFilesAuditState(licenseeId) {
  return {
    domain: 'staff_files',
    type: 'mixed',                            // signals "see per-field type tags"
    type_1_fields: {                          // MiRegistry mirror — NOT counted by default
      annual_training_completion: { /* per-caregiver completion dates */ },
      professional_development_hours: { /* per-caregiver hours by year */ },
      miregistry_account_status: { /* per-caregiver miregistry_status */ },
      _tag: 'type_1_miregistry_mirror',
    },
    type_2_fields: {                          // MILittleCare-owned — counted
      cpr_first_aid: {
        active_count: 0,
        expiring_within_30d_count: 0,
        expired_count: 0,
      },
      physician_attestation: {
        active_count: 0,
        expiring_within_30d_count: 0,
        expired_count: 0,
        personnel_missing_count: 0,           // caregivers with NO attestation on file
      },
      background_check_ccbc: {
        eligible_count: 0,
        pending_count: 0,
        ineligible_count: 0,
        personnel_missing_count: 0,
      },
      background_check_sex_offender_registry: {
        eligible_count: 0,
        pending_count: 0,
        personnel_missing_count: 0,
      },
      daily_clock_log: {
        caregivers_with_recent_entries_count: 0,
        caregivers_missing_entries_count: 0,  // active caregivers, no entries last 30 days
      },
      _tag: 'type_2_milittlecare_owned',
    },
  }
}
```

The two top-level groups (`type_1_fields`, `type_2_fields`) carry the
`_tag` discriminator PR #22 reads to apply scoring rules. Read-only,
single round-trip.

### C. UI surfaces

- **Staff training matrix.** Three new columns: Physician Attestation,
  Sex Offender Registry, Daily Clock. Each cell renders a badge + a
  drill-in to the caregiver's history.
- **Staff page / Clock log sub-tab.** Per-caregiver clock entry list,
  with an "Add entry" button (provider-on-behalf). App-user caregivers
  show their self-entries here too (read-only when the licensee browses
  someone else's history; editable for the licensee's own).
- **Reminders settings (PR #15 surface).** Two new toggles:
  `cpr_first_aid_expiration` and `physician_attestation_expiration`.
- **Caregiver training form (`TrainingEntryForm`).** Add a category
  option for Physician Attestation, with a help link to MiRegistry's
  professional-development page (constraint E: link out, no
  duplication).

### D. Module gating

All PR #18 surfaces gate on `MODULE_KEYS.STAFF_TRAINING`. **Per OQ5
resolution: this PR migrates the gate from `is_license_exempt === false`
to `license_type IN ('family_home', 'group_home')`** (plus the
`isTrackedStaffCaregiver` self-view path, which stays). The migration is
a one-line change in `src/lib/modules.js`:

```js
// Before (PR #8):
//   if (safeProfile.is_license_exempt === false || isTrackedStaffCaregiver === true) {
//     modules.add(MODULE_KEYS.STAFF_TRAINING)
//   }
// After (PR #18):
if (
  safeProfile.license_type === 'family_home' ||
  safeProfile.license_type === 'group_home' ||
  isTrackedStaffCaregiver === true
) {
  modules.add(MODULE_KEYS.STAFF_TRAINING)
}
```

The post-PR-14 mirror invariant (`is_license_exempt = (license_type ===
'license_exempt')`) means this is a no-op for every existing licensed
provider; the change is about source-of-truth correctness, not behavior.
Update `src/lib/modules.test.js` to reflect.

### E. Tests

- **Pure unit (`staffTraining.test.js` extensions):**
  `getPhysicianAttestationState` (active, expiring soon, expired);
  `splitBackgroundChecksByType` (mixed input).
- **Migration test:** the `chk_staff_time_subject` CHECK rejects rows
  with both subjects set or neither.
- **Smoke (manual):** insert a non-app-user caregiver, record a clock
  entry on their behalf, observe in the matrix.
- RTL render tests deferred per house convention.

### F. Documentation

- `docs/runbook.md` — migration 026 entry template, flagged
  "post-introspection" for `staff_time_entries`.
- `docs/tech_debt.md` — capture the `staff_time_entries` introspected
  shape if not yet documented.
- `CLAUDE.md` — no new convention.

### G. Rollout

1. Apply migration 026. Verify enum value addition + new columns + CHECK
   + the pre-UPDATE backfill row count via dashboard screenshot.
   Production introspection already done at scoping time.
2. Deploy app; matrix gains three columns; clock-log sub-tab is live on
   `/staff`; the STAFF_TRAINING module gate now reads `license_type`.
3. **Communicate to Venessa:** "Two new compliance columns are showing
   for your staff — please record physician attestations and sex
   offender registry clearances. New 'Daily Clock' sub-tab on the Staff
   page supports non-app-user caregivers."

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **ALTER TYPE ADD VALUE compatibility.** **RESOLVED — run normally.**
   Supabase Postgres supports ALTER TYPE ADD VALUE inside a transaction;
   we proceed on that basis. Fallback (two-migration sequence) is a
   contingency only if apply fails — not the plan.

2. **Backfill `check_type='ccbc'` for existing rows — automatic or
   case-by-case?** **RESOLVED — automatic.** The migration sets
   `check_type = 'ccbc'` for all existing `background_check_eligibility`
   rows with `check_type IS NULL`. The migration includes a pre-UPDATE
   `SELECT count(*)` so the verification screenshot captures the affected
   row count. Re-categorize via the matrix UI when needed.

3. **Should the clock log surface be on `/staff` or `/staff-training`?**
   **RESOLVED — on `/staff`.** Staff training matrix gets a presence
   indicator summary only; the detailed log lives at `/staff`.

4. **Is the physician attestation a per-personnel record or a per-licensee
   record?** **RESOLVED — per-personnel including the licensee
   themselves.** The licensee is modeled as a `caregivers` row with
   `regulatory_role = 'licensee'` (PR #8 substrate); the training-record
   shape handles this cleanly.

5. **Staff-training module gate (post-PR-14): keep on `is_license_exempt`
   or move to `license_type`?** **RESOLVED — migrate to `license_type IN
   ('family_home', 'group_home')` in this PR.** See § D.

---

## Step 5 — Effort estimate

**S–M.** This is genuinely the smallest of the six categories. The
substrate (PR #8) is excellent. The new code is:
- One ALTER TYPE
- One ALTER TABLE on `staff_training_records` (new column + backfill)
- One ALTER TABLE on `staff_time_entries` (drop NOT NULL + new columns +
  CHECK)
- One new sub-tab UI on `/staff`
- Three new matrix columns
- Three pure helpers
- Two new PR #15 reminder category integrations

No major new modules. Most of the work is parameterizing what PR #8 built.

---

## Step 6 — Out of scope (future PRs)

- **CCBC API integration** — backlog item (per decisions doc § Backlog
  implications). PR #18 stays manual.
- **Physician attestation document storage** — V1 records the date only;
  uploading the attestation PDF could come later via a per-record file
  attachment.
- **Staff training content** (per constraint E — MiRegistry is system of
  record).
- **Staff ratio module** — explicit backlog item per decisions doc § OQ9.
- **Bulk-import caregivers** — not in V1.

---

## Step 7 — Dependencies on prior PRs

- **PR #8 (staff training tracking) — HARD DEPENDENCY.** The
  `caregivers` / `staff_training_records` substrate is required.
- **PR #14 (license_type) — REQUIRED.** Module gate alignment.
- **PR #15 (reminders) — REQUIRED.** PR #15's catalog includes
  `cpr_first_aid_expiration` and `physician_attestation_expiration`
  (contributed by this PR). The matrix surfaces the data; PR #15's
  dispatcher delivers the proactive notification.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template);
`supabase/migrations/012_staff_training.sql`,
`supabase/migrations/013_training_requirements.sql`;
`src/lib/staffTraining.js`, `src/pages/StaffTrainingPage.jsx`,
`src/pages/StaffPage.jsx`, `src/components/dashboard/StaffClockWidget.jsx`,
`src/components/staffTraining/*` (compliance matrix shape).

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
