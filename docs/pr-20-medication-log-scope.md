# PR #20 — Medication Administration Log (Rule 31): Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § Updated PR
sequence): PR #20 ships after C/D/E so the acknowledgments table
(PR #16) and the `caregivers` / role data (PR #8) are in place. Drops to
M from L once those dependencies exist.

**Rule citation:** **R 400.1931 (Rule 31) — Medication administration.**

### Verbatim subsections this PR consumes (reconciled 2026-06-02)

- **R 400.1931(1):** *"Medication, prescription or nonprescription, must
  be given to a child in care by a licensee or a child care staff member
  only. A child care assistant or supervised volunteer shall not give
  medication to a child in care."* — **role-gate applies to ALL
  medication (prescription AND nonprescription), with the narrow
  exemption (8) carves out below.**
- **R 400.1931(2):** *"Medication, prescription or nonprescription, must
  be given or applied only with prior written permission from a parent."*
  — per-medication parent consent. Applies to every medication including
  topical OTC.
- **R 400.1931(4):** *"Prescription medication must have the pharmacy
  label indicating the physician's name, child's first and last name,
  instructions, and name and strength of the medication."* — captured as
  the `original_container_confirmed boolean` attestation on the
  authorization (label-verification requirement, not structured-capture).
- **R 400.1931(7):** *"A record of the date, time, and the amount of all
  medication given or applied must be maintained."* — per-dose log
  required fields.
- **R 400.1931(8):** *"Topical nonprescription medication, including,
  but not limited to, sunscreen, insect repellant, and diaper rash
  ointment, is exempt from subrules (1) and (7)."* — topical OTC is
  exempt from BOTH the role-gate (1) AND the dose log (7), but NOT
  from parent permission (2).
- **R 400.1931(9):** *"The records required in this rule must be
  retained for a minimum of 2 years."*

### Practical scope of the role-gate (corrected 2026-06-02)

Combining (1) and (8):

| Medication category | Role-gate (1) applies? | Dose log (7) required? | Parent consent (2) required? |
|---|---|---|---|
| Prescription | **YES** — licensee or staff_member only | YES | YES (per-prescription) |
| **Non-topical** nonprescription (e.g., oral Tylenol) | **YES** — licensee or staff_member only | YES | YES |
| **Topical** nonprescription (sunscreen, repellent, diaper rash cream — per (8)) | **NO** — any caregiver may apply | NO (log optional) | YES (OTC-blanket) |

The original "prescription medication only" phrasing in pre-2026-06-02
drafts of this scope was too narrow on the role-gate's scope and
silently mishandled (8)'s exemption — a 2026-06-02 reconciliation
against the rules PDF flagged both as conflicts before the build PR
landed. The trigger function (see § A.2) implements both branches
correctly: skip the role-check when the linked authorization's
`is_topical_otc=true`; enforce it for everything else.

---

## 0. Headline findings (drive the whole plan)

1. **Greenfield: nothing exists.** Confirmed in the audit. No medication
   tables, no per-dose log, no administering-staff gating. `children`
   has `allergies` and `medical_notes` (free text only).

2. **Two-table model: authorizations (one per child × medication) and
   administration events (one per dose).** Distinct lifecycles: an
   authorization can be on file for months while many dose events
   reference it. A dose event without a current active authorization is
   a compliance violation.

3. **Reuse PR #16's `acknowledgments` table for parent permission.**
   Parent permission is conceptually an acknowledgment: who consented,
   when, what version of the medication plan they consented to (snapshot
   the plan into the ack's `snapshot_hash`). One ack per authorization;
   when the authorization changes (dose change, new prescription),
   re-acknowledgment is required. PR #16's
   `type = 'medication_permission'` and `subject_type =
   'medication_authorization'` slot in cleanly.

4. **Role-gated administered_by enforcement.** PR #8's `caregivers` +
   `caregiver_regulatory_roles` substrate provides the legal roles
   (`licensee`, `child_care_staff_member`, `child_care_assistant`,
   `unsupervised_volunteer`, `supervised_volunteer`, `driver`). The
   administered_by dropdown on the dose-log surface filters to roles
   that legally may administer (`licensee` + `child_care_staff_member`).

5. **TodayWidget is the natural daily-workflow surface.** Per the audit:
   "The administering surface is a natural TodayWidget extension ('log a
   dose')." PR #20 adds a per-child medication list to TodayWidget when
   the child has active authorizations with doses due today.

6. **OTC exemption is a per-authorization flag, not a separate model.**
   `is_topical_otc boolean` on the authorization; if true, the per-dose
   log is optional (the UI accommodates "applied as needed" entries but
   doesn't require them).

---

## Step 2 — Inventory of what exists

**Nothing in code for medication.** Adjacent substrate:
- `children.allergies` (free text — informational).
- `children.medical_notes` (free text — informational).
- `caregivers` + `caregiver_regulatory_roles` (PR #8) for the gating.
- `public.acknowledgments` (PR #16) for parent permission.
- PR #15's reminder system for scheduled-dose reminders (optional V1).

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 028** (post-PR-19's 027).

#### A.1 `medication_authorizations`

One row per `(child_id, medication_name)`. Active while
`archived_at IS NULL` and the authorization hasn't been replaced.

```sql
create table public.medication_authorizations (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,
  child_id                 uuid not null references public.children(id) on delete cascade,

  medication_name          text not null,
  dose_text                text,                    -- "5 mL by mouth" — provider/parent free text
  schedule_text            text,                    -- "twice daily, 8a + 8p" — free text
                                                    -- (a structured schedule is V2; the rule
                                                    --  requires permission + per-dose log,
                                                    --  not a structured schedule)
  is_topical_otc           boolean not null default false,
                                                    -- sunscreen / repellent / diaper rash.
                                                    -- When true, per-dose log is optional.
  prescriber_name          text,                    -- doctor / pediatrician (when applicable)
  starts_on                date,
  ends_on                  date,                    -- null = ongoing
  original_container_confirmed boolean not null default false,
                                                    -- per rule: provider attests at intake
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One active medication name per child.
create unique index idx_med_auth_active_per_child_med
  on public.medication_authorizations (child_id, lower(medication_name))
  where archived_at is null;

create index idx_med_auth_provider_child
  on public.medication_authorizations (provider_id, child_id)
  where archived_at is null;
```

#### A.2 `medication_administration_events`

One row per dose. The 2-year retention runs from `administered_at`.

```sql
create table public.medication_administration_events (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,
  authorization_id         uuid not null references public.medication_authorizations(id)
                             on delete restrict,
                             -- restrict (not cascade): a dose log is audit data; deleting
                             -- the authorization MUST keep the log. Provider archives the
                             -- authorization instead.
  child_id                 uuid not null references public.children(id) on delete cascade,
                             -- denormalized for query convenience; matches the
                             -- authorization at insert time (enforced via app code).

  administered_at          timestamptz not null,    -- date + time per Rule 31
  dose_administered_text   text,                    -- "5 mL" — captured even if matches
                                                    -- the authorization, in case dose was
                                                    -- partial.
  administered_by_caregiver_id uuid not null references public.caregivers(id) on delete restrict,
                                                    -- role-gated at insert (CHECK below).
  notes                    text,
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_med_events_child_recent
  on public.medication_administration_events (child_id, administered_at desc)
  where archived_at is null;
```

**Role gating at the DB level:** Postgres CHECK constraints can't easily
reference another table without a trigger. Recommend:
1. App-code gates the dropdown (UI prevents picking an ineligible role).
2. **A trigger function** validates the caregiver has a role in
   (`licensee`, `child_care_staff_member`) at insert; rejects otherwise.
   **EXCEPT** when the linked authorization is `is_topical_otc=true` —
   per R 400.1931(8), topical OTC is exempt from subrule (1)'s
   role-gate, so any caregiver may apply sunscreen / insect repellent
   / diaper rash ointment. The trigger reads the linked authorization
   and skips the role-check for OTC events.

```sql
create or replace function public.medication_event_caregiver_role_check()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_is_topical_otc boolean;
begin
  -- R 400.1931(8): topical OTC is exempt from subrule (1). Resolve
  -- is_topical_otc from the linked authorization (source of truth);
  -- skip the role-gate for those events.
  select is_topical_otc into v_is_topical_otc
    from public.medication_authorizations
   where id = new.authorization_id;

  if coalesce(v_is_topical_otc, false) then
    return new;
  end if;

  -- R 400.1931(1): for everything else (prescription OR non-topical
  -- nonprescription) only licensee or child care staff member may
  -- administer. Assistants and supervised volunteers are prohibited
  -- by the rule's "only" clause; any role outside the whitelist is
  -- rejected.
  if not exists (
    select 1 from public.caregiver_regulatory_roles
     where caregiver_id = new.administered_by_caregiver_id
       and regulatory_role in ('licensee', 'child_care_staff_member')
  ) then
    raise exception 'Only licensee or child care staff member may administer medication (R 400.1931(1))';
  end if;
  return new;
end;
$$;

create trigger trg_medication_event_caregiver_role_check
  before insert on public.medication_administration_events
  for each row execute function public.medication_event_caregiver_role_check();
```

This puts the rule in the DB so a future API endpoint or admin tool
can't bypass it. The OTC branch makes (8)'s exemption legible at the
schema level — a future maintainer reading the trigger sees both
the rule citation and the exact carve-out.

#### A.3 No new types in `acknowledgments`

Just new `type` values used at app layer (per OQ3 resolution: blanket
OTC permission per child + per-prescription acknowledgment for non-OTC):
- `medication_permission_otc_blanket` (subject_type=`child`,
  subject_id=`children.id`) — one row per child; covers sunscreen,
  insect repellent, diaper rash cream collectively. Captured once per
  child.
- `medication_permission` (subject_type=`medication_authorization`,
  subject_id=`medication_authorizations.id`) — one row per non-OTC
  prescription; captures `snapshot_hash` of the authorization's dose +
  schedule at consent time.

Re-acknowledgment is **derived** via `snapshot_hash` comparison from
PR #16's helper (OQ2 resolution): when the authorization's dose or
schedule changes, the stored ack's `snapshot_hash` no longer matches the
current `computeAckHash` of the authorization, and
`getDoseLogState.needsReacknowledgment` flips true.

### B. App-code structure

#### B.1 Pure helpers (`src/lib/medication.js`, new)

- `getActiveAuthorizations(child, authorizations)` — selector.
- `getDoseLogState(authorization, events, today)` → returns
  `{ lastAdministeredAt, dosesToday, needsReacknowledgment }`. The
  re-ack flag is derived via PR #16's `computeAckHash` comparison
  (per OQ2): if the current authorization's hash differs from the
  active acknowledgment's `snapshot_hash`, re-ack is required.
- `mayAdminister(caregiver, roles)` → returns boolean. Used for
  dropdown filtering.
- `isTopicalOtcExempt(authorization)` → just reads
  `authorization.is_topical_otc`.

#### B.1a Audit-state helper (`getMedicationLogAuditState(licenseeId)`, new — cross-cutting requirement)

```js
export async function getMedicationLogAuditState(licenseeId) {
  return {
    domain: 'medication_log',
    type: 'type_2',                          // MILittleCare-owned.
    active_authorizations_count: 0,
    authorizations_needing_reacknowledgment_count: 0, // snapshot_hash drift
    authorizations_missing_parent_permission_count: 0, // active auth, no active ack
    children_with_otc_blanket_count: 0,
    children_missing_otc_blanket_count: 0,   // children with active enrollment
                                              // and no otc_blanket ack
    dose_events_last_30d_count: 0,
    archived_authorizations_with_recent_events_count: 0, // audit anomaly
  }
}
```

Read-only, single round-trip. Consumed by PR #22.

#### B.2 Medication tab on Family modal

A new tab on the family modal alongside Children / Funding / Guardians /
Emergency / Attendance (`FamiliesPage.jsx`). Per-child list of active
authorizations + a button to add a new authorization. Each authorization
shows the dose log (recent N), with a "Log a dose" button.

The authorization form captures all the authorization fields and
**fires the parent permission acknowledgment** via PR #16's table on
save. Parents can self-acknowledge via portal; in-person paper +
provider-override channels also supported (PR #16's three-channel CHECK).

#### B.3 Dose log entry

A small modal: select caregiver (role-filtered), datetime
(default now), dose-administered text (default from authorization),
notes. Save inserts a `medication_administration_events` row.

**Allergies display (per OQ4 resolution).** Both the authorization form
and the dose-log modal **prominently display** the child's
`children.allergies` text near the top — pulled from the existing
column, no schema change. Treated as a safety affordance; rendered in a
warn-styled callout with an `⚠` icon. If `children.allergies` is empty,
the callout is suppressed.

#### B.4 TodayWidget extension

Add a "Medications today" section showing active authorizations across
all enrolled children where a dose is plausibly due today (heuristic:
no event in the last 12 hours for that authorization, ignored for
`is_topical_otc`). Inline "Log a dose" button per row jumps to the
dose-log entry modal.

#### B.5 Reminder integration (PR #15)

PR #20 contributes one category to PR #15's `REMINDER_CATEGORIES`
catalog:
- `medication_authorization_renewal` — fires when an authorization's
  `ends_on` is within `lead_time_days` (default 7) AND when
  `getDoseLogState.needsReacknowledgment` becomes true. Subject_type =
  `medication_authorization`.

The TodayWidget surface remains the primary daily workflow; the
reminder system adds the proactive nudge for renewals and re-acks
without the provider having to open TodayWidget.

#### B.6 Auditor-friendly print view

A per-child medication summary printable: each active authorization +
the full dose log for a date range. Mirrors PR #19's printable plan
pattern.

### C. UI surfaces

- **Family modal → Medications tab.** Per-child authorizations + dose
  logs.
- **TodayWidget → Medications section.** Daily dose-log entry surface.
- **Sidebar → Compliance → Medications (optional).** A top-level
  cross-family view; secondary in V1 (most workflow is per-family).
- **Print view.** Per-child auditor report.

### D. Module gating

`MODULE_KEYS.LICENSED_COMPLIANCE`. LEPs see nothing.

### E. Tests

- **Pure unit (`medication.test.js`):** `getDoseLogState` (recent dose,
  stale, never-administered); `mayAdminister` for each role; topical-OTC
  branch.
- **Migration test:** trigger rejects an `administered_by_caregiver_id`
  whose roles don't include the eligible set.
- **Smoke (manual):** create authorization, parent acks, record doses,
  archive authorization, observe the dose log stays (audit retention).
- RTL render tests deferred.

### F. Documentation

- `docs/runbook.md` — migration 028 entry template.
- `docs/tech_debt.md` — note the trigger-based role gate (and the parallel
  app-code gate) as belt-and-suspenders.
- `CLAUDE.md` — append: "Medication administration is role-gated at the
  DB level (trigger on medication_administration_events). Only licensee
  or child care staff member may administer per R 400.1931."

### G. Rollout

1. Apply migration 028. Verify tables + trigger.
2. Deploy app; the Medications tab is live for licensed providers.
3. **Communicate to Venessa:** "If you administer medication, set up
   authorizations on each child's Medications tab. Parent permission is
   captured the same way attendance acknowledgments are. Log each dose
   as you give it."

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **Free-text schedule vs structured schedule?** **RESOLVED — free
   text V1.** Structured schedule with auto-due-dose reminders is a V2
   move (out of scope, § 6). Providers work from prescription labels for
   V1.

2. **Re-acknowledgment trigger?** **RESOLVED — derived via
   `snapshot_hash` comparison from PR #16.**
   `getDoseLogState.needsReacknowledgment` flips true when the current
   authorization's `computeAckHash` differs from the active
   acknowledgment's stored `snapshot_hash`. Re-ack reuses PR #16's three
   channels (parent_portal, in_person_paper, provider_override).

3. **Topical OTC blanket permission vs per-medication permission?**
   **RESOLVED — blanket OTC permission per child + per-prescription
   acknowledgment for non-OTC.** Two distinct ack types
   (`medication_permission_otc_blanket`, `medication_permission`); see
   § A.3.

4. **Children with allergies — should the medication form display them
   prominently?** **RESOLVED — yes, prominently on the authorization
   form and the dose-log entry modal.** Pulled from `children.allergies`
   (existing column). UI affordance only — no schema change. See § B.3.

5. **Should controlled-substance administration require an additional
   witness?** **RESOLVED — out of scope.** Not required by Rule 31.

---

## Step 5 — Effort estimate

**L (→ M after C/D/E ship).** The L comes from:
- Two new tables + a trigger
- A new family-modal tab with two distinct flows (authorization,
  per-dose log)
- TodayWidget extension
- Print view
- Reminder integration

The dependency reduction (M) is real: PR #16's acknowledgments table
removes the parent-permission design work; PR #8's caregivers/roles
removes the administered_by design work.

---

## Step 6 — Out of scope (future PRs)

- **Structured schedule + auto-due-dose reminders.**
- **Pharmacy / e-prescription integration.**
- **Multi-witness for controlled substances.**
- **Photo of medication container at intake.**
- **Allergic-reaction incident form.**

---

## Step 7 — Dependencies on prior PRs

- **PR #16 (acknowledgments) — HARD DEPENDENCY.** Parent permission
  storage.
- **PR #8 (caregivers / regulatory roles) — HARD DEPENDENCY.** Role-gate
  on administered_by.
- **PR #14 (license_type) — REQUIRED.** Module gating.
- **PR #13 (archived_at convention) — pattern reference.**
- **PR #15 (reminders) — OPTIONAL.** Renewal reminders.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template),
`docs/pr-16-child-files-scope.md` (acknowledgments table this PR
consumes);
`supabase/migrations/012_staff_training.sql` (caregivers + roles);
`src/components/dashboard/TodayWidget.jsx` (extension target),
`src/pages/FamiliesPage.jsx` (modal-tab structure).

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
