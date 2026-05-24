# Licensed Home Compliance Audit — 2026-05-23

**Investigation only. No code was changed.** This report inventories the
milittlecare codebase against Michigan's new Child Care Home Licensing
Rules (adopted 2026-04-27; ~90-day compliance window → roughly late July
2026) and scopes the six compliance PRs plus the two enabling PRs
(license-type foundation, opt-in reminder system).

A note on rule citations: the prompt's "Rule 39 / Rule 31 / Rule 7…"
numbering is the working shorthand. Where the codebase already cites the
Michigan Administrative Code (`R 400.19xx`), this report carries that
citation through. Where I could not confirm the exact `R 400.xxxx` number
from code, I cite the prompt's rule number and flag the precise citation
as an open question rather than invent a number.

---

## Executive summary

**Overall readiness: low for A/B/C/D/F, moderate for E.** Five of the six
compliance categories have **no data model and no UI** today — drills,
medication, discipline policy, child-file completeness, and property
records are all greenfield. The one bright spot is **staff files (Category
E)**, which PR #8 (staff training tracking, already shipped) covers
substantially: `caregivers`, `caregiver_regulatory_roles`,
`staff_training_records`, and `health_safety_updates` already model hire
date, CPR/First Aid expiration, background-check eligibility, MiRegistry
account status, and the 14-topic new-hire training — all role-aware and
verified against `R 400.1901–1963`.

The codebase is unusually well-positioned to *extend* rather than rebuild,
because two reusable patterns already exist and are battle-tested in
production:

1. **The compliance-banner pattern** — a pure date→severity helper
   (`cdcProviderCompliance.js`) feeding a self-loading React banner
   (`AnnualTrainingBanner.jsx`) that stacks at the top of the dashboard.
   Every "X is due in N days" reminder in A–F can ride this exact shape.
2. **The acknowledgment pattern** — PR #12's `attendance_acknowledgments`
   gives us a working parent-signature-with-tamper-detection model that
   the intake/discipline/disclosure acknowledgements (C, D) can be
   generalized from.

**Top 3 risks for the late-July 2026 deadline:**

1. **Schema-history debt is a landmine for every new table.** The repo's
   migrations are *still* out of sync with production (`docs/tech_debt.md`
   § "Migrations folder is out of sync"; ~21 production-only tables remain
   undocumented after PR #8.5a captured only five). Two production
   incidents already came from this (the migration-020 `notification_log`
   name collision; the migration-019 `onConflict` outage). Six new
   compliance PRs each adding 1–3 tables multiplies that exposure. The
   "check table-name availability" and "pair schema migrations with an
   app-code grep" conventions (`docs/tech_debt.md`) are now mandatory for
   every one of these PRs, and they cost real time.

2. **No license-type gating exists yet, so every compliance surface would
   leak to the wrong providers.** Today the app knows `is_license_exempt`
   (boolean, often `null`) and `provider_type` (a *CDC-billing*
   classification that happens to include `licensed_family`/
   `licensed_group`/`licensed_center`). Neither is wired to show/hide
   compliance modules, and `provider_type` is nullable and semantically
   overloaded. The license-type foundation PR is a hard dependency for
   A–F and must land first — otherwise a private-pay or LEP provider sees
   "Tornado drill overdue" banners that don't apply to them.

3. **The opt-in reminder requirement has no home.** There is no
   per-category preferences model and no general settings page for it
   (settings live as ad-hoc columns on `profiles`; the only settings UI is
   `BusinessInfoPage` and the acknowledgment `SettingsCard`). And the one
   scheduled-email channel that exists — the Vercel cron — is **maxed out**
   (Hobby plan, 2-cron limit, both slots used; the acknowledgment digest
   cron is already disabled for this reason, `docs/tech_debt.md`
   2026-05-22). Any "email me 30 days before the radon test is due"
   feature needs a reminder-delivery decision (in-app banner vs. email)
   and, if email, a cron-capacity decision (Vercel Pro, consolidate crons,
   or move to Supabase `pg_cron`).

**Recommended PR sequence** (full rationale in § Recommended PR sequence):

0a. **Foundation — license-type awareness** (blocks everything)
0b. **Opt-in reminder system** (blocks every category's reminders)
1. **Category D — Child file completeness** (extends existing Families
   modal + reuses acknowledgment pattern; highest day-one compliance value
   for Venessa's roster)
2. **Category E — Staff file completeness** (smallest gap; mostly
   extends PR #8)
3. **Category C — Discipline policy & acknowledgement** (shares the
   acknowledgment generalization with D; do right after D)
4. **Category A — Drill log & Emergency Response Plan** (self-contained
   greenfield; high inspector visibility)
5. **Category B — Medication Administration Log** (greenfield; can reuse
   C/D acknowledgment work for parent permission)
6. **Category F — Property records** (greenfield; mostly document storage
   + reminders; reuses the document-vault pattern)

---

## Category-by-category gap analysis

### Category A — Drill log & Emergency Response Plan

**Rule reference:** Rule 39 (exact `R 400.xxxx` not confirmed in
code — flag as OQ).

**Current state:**
- **No existing implementation found.** No drill, emergency-plan, or
  safety-plan table in any of migrations `001`–`020`. The only "emergency"
  object in the schema is `emergency_contacts` (per-family contact list,
  migration 016) — unrelated to drills or the emergency response plan.
- No route, no page, no component references drills, evacuation, tornado,
  shelter-in-place, lockdown, or reunification anywhere in `src/` or
  `api/` (confirmed by repo-wide grep; the only hits are this prompt and
  the `migrations-for-deploy/` copies of 016/019 referencing
  `emergency_contacts`).

**Gaps (everything the rule requires):**
- Written emergency response plan covering the 10 emergency types (fire,
  tornado, accident, water, flood, power, weather, disaster, bomb/man-made,
  intruder/active-shooter) — no storage.
- The nine plan dimensions (evacuation, relocation, shelter-in-place,
  lockdown, family reunification, continuity, infant/toddler
  accommodation, disability accommodation, chronic-medical accommodation)
  — no storage.
- Drill **schedule + log**: fire every 3 months, tornado 2× March–Nov,
  others annually; log with date, time, evacuation duration; **2-year
  retention** — no model.
- Drill due-date reminders — no infrastructure pointed at this.

**Extension vs build:** **Build fresh** for the data model — a
`drill_logs` table (date, time, drill_type, evacuation_duration, notes,
`archived_at` soft-delete for the 2-year retention) and an
`emergency_plan` store (one row per provider, or a documents-vault entry
if the plan is an uploaded PDF rather than structured fields — owner
decision). **Reuse** the banner pattern for "fire drill due" /
"tornado-season drill window open" and the opt-in reminder system from PR
0b. The schedule math (every-3-months, 2×-in-a-window, annual) is a new
pure helper modeled on `cdcProviderCompliance.js`.

**Recommended difficulty:** **L.** Two concepts (structured drill log +
the plan), a recurring-schedule engine with three cadence types, and the
reminder wiring. The plan itself may be reducible to an uploaded-document
slot (lowering it toward M) if the owner accepts "store the PDF" over
"structure all 10×9 plan cells."

**Dependencies:** PR 0a (license-type gating — drills apply to licensed
homes, not LEPs); PR 0b (reminders). Independent of B–F.

---

### Category B — Medication Administration Log

**Rule reference:** Rule 31 (exact `R 400.xxxx` not confirmed in code —
flag as OQ).

**Current state:**
- **No existing implementation found.** No medication, dose, or
  administration table in any migration. The only child-health fields that
  exist are `children.allergies` and `children.medical_notes` (free text,
  migration 016) — captured in the Families → Children tab
  (`FamiliesPage.jsx:858–862`). These are notes, not a per-dose
  administration log.
- No staff-permission gating exists for "who may administer" — the
  `regulatory_role` enum (migration 012) distinguishes
  `child_care_staff_member` / `child_care_assistant` / volunteers, which is
  the *right* substrate for the rule's "only licensee or child care staff
  member may administer (not assistants or volunteers)" restriction, but
  nothing consumes it for medication.

**Gaps:**
- Written parent permission **per medication** — no model. (See
  extension note: this is an acknowledgement, and could ride the
  generalized acknowledgement model from C/D.)
- Original-container check before administering — no field.
- Per-dose log (date, time, dose, medication name, child name,
  administering staff) — no model.
- **2-year retention** — needs `archived_at` soft-delete convention.
- Topical-OTC exemption (sunscreen, repellent, diaper rash) — no
  concept.
- Administering-staff restriction to licensee/staff-member — not
  enforced.

**Extension vs build:** **Build fresh** for `medication_authorizations`
(per child+medication: name, dose, schedule, parent-permission link,
container-checked flag) and `medication_administration_events` (per dose:
timestamp, dose given, administered_by, links to authorization). **Reuse**:
(1) the C/D generalized acknowledgement model for the parent-permission
signature; (2) the `regulatory_role`/`caregiver` model to gate the
administered_by dropdown to eligible roles; (3) `children` for the child
link. The administering surface is a natural **TodayWidget** extension
("log a dose") per the owner's "extend existing surfaces" directive.

**Recommended difficulty:** **L.** Two new tables, role-gated write path,
parent-permission acknowledgement, retention, and the OTC-exemption
branch. Drops toward M if it lands *after* C/D so the acknowledgement
generalization already exists.

**Dependencies:** PR 0a (gating); strongly benefits from Category C/D
(acknowledgement generalization) and Category E (`caregivers`/role data
for administered_by). Sequence B after C/D/E.

---

### Category C — Discipline policy & parent/staff acknowledgement

**Rule reference:** Rules 6, 7, 42 (`R 400.xxxx` not confirmed; staff-side
hire acknowledgement relates to the `R 400.1906`/`R 400.1923` personnel-file
area cited in migration 012, but the discipline-policy rule number is
unconfirmed — flag as OQ).

**Current state:**
- **No discipline-policy storage found anywhere.** No `business_policies`
  field for it that I can confirm (the `business_policies` table is
  production-only and referenced by `Sidebar.jsx` only for
  `messaging_enabled`; its full column list is undocumented — see OQ).
- **A strong, production acknowledgement model exists but is purpose-built
  for attendance.** PR #12's `attendance_acknowledgments` (migration 020)
  records who acknowledged what, when, via which channel
  (`'parent_portal'` | `'provider_override'`), with an
  `attendance_snapshot_hash` for tamper detection and `archived_at`
  soft-delete. There is **no `acknowledgment_type` discriminator** — every
  row is implicitly an attendance-hours acknowledgement, keyed on
  `(child_id, date, segment_index)`. There is a sibling
  `acknowledgment_flags` table for parent disputes.
- **No staff onboarding "policies acknowledged at hire" capture.** PR #8's
  `staff_training_records` has a `health_safety_update_acknowledgement`
  category but nothing for "acknowledged the discipline policy at hire."
  `caregivers.date_of_hire` exists as the anchor a hire-time acknowledgement
  would attach to.

**Gaps:**
- Written discipline policy per Rule 42 (prohibited methods, positive
  discipline, time-out restrictions) — no storage; needs a policy
  document/text store per provider.
- Parent acknowledgement of receipt **at child intake** (Rule 7) — no
  model (this is part of the "child in care statement," see Category D).
- Staff acknowledgement of the policy **at hire** (Rule 6) — no model.

**Extension vs build — the key architectural decision:**
The prompt asks whether `attendance_acknowledgments` /
`acknowledgment_flags` can grow an `acknowledgment_type` field, or whether
a separate model is cleaner. **Recommendation: a separate, general
`acknowledgments` model — do NOT overload `attendance_acknowledgments`.**
Reasons grounded in the code:
- `attendance_acknowledgments` is keyed on `(child_id, date,
  segment_index)` with a partial-unique index and a
  `attendance_snapshot_hash` referencing attendance fields, plus a CHECK
  constraint (`attendance_acknowledgments_channel_shape`) and RLS that
  joins through `attendance`. A discipline-policy or hire acknowledgement
  has no `date`/`segment_index`/attendance row — bolting an
  `acknowledgment_type` on would make half the columns nullable-by-type
  and force the existing tight CHECK/RLS to fork.
- The *pattern* (who/when/channel/snapshot-hash/soft-delete) is exactly
  right and should be **generalized**, not the table reused. A new
  `acknowledgments` table with `subject_type`
  (`'discipline_policy_parent'`, `'discipline_policy_staff'`,
  `'child_in_care_statement'`, `'lead_disclosure'`,
  `'firearms_disclosure'`, `'medication_permission'`…), a polymorphic
  `subject_id`, and an `acknowledged_by_user_id` would serve C, D, and B's
  parent-permission. The hash/tamper-detection helper in
  `src/lib/parentAcknowledgment.js` is already pure and reusable.

**Recommended difficulty:** **M.** Policy storage is small; the
acknowledgement generalization is the real work, but it's a pattern-copy,
not a new invention. Most of the cost is doing the generalization *well*
since D and B will build on it.

**Dependencies:** PR 0a. This PR should **own the acknowledgement
generalization** that D and B then consume — so sequence C right after D's
schema is understood (or fold the generalization into D and have C consume
it; owner's call). Reuses `caregivers.date_of_hire` (Category E) for the
staff-hire acknowledgement.

---

### Category D — Child file completeness

**Rule reference:** Rule 7 (`R 400.xxxx` not confirmed — flag as OQ).

**Current state:**
- `children` table (migration 016) has **11 columns**: `id`, `user_id`,
  `family_id`, `first_name`, `last_name`, `date_of_birth`, `allergies`,
  `medical_notes`, `notes`, `created_at`, `updated_at`. PR #9's migration
  019 added three school-schedule fields (`school_enrolled`,
  `school_name`, `school_bell_schedule_json`) for I-Billing Rule 6.
- The **Families → Children tab** (`FamiliesPage.jsx`, `ChildrenTab` /
  child form ~`749–868`) edits exactly: `first_name`, `last_name`,
  `date_of_birth`, `allergies`, `medical_notes`. Nothing else.
- **No parent-signature capture at intake.** Family modal tabs are
  overview / invitations / children / funding / guardians / emergency /
  attendance (`FamiliesPage.jsx:380–399`). None capture an intake
  statement or signature. The closest signature concept anywhere is the
  attendance acknowledgement (PR #12), which is post-hoc per-day, not an
  intake event.

**Gaps (vs Rule 7, before initial attendance):**
- Child information card (department form or approved substitute) — no
  storage of the form / no structured equivalent.
- **Child in care statement** signed by parent, covering: receipt of
  discipline policy; condition of child's health; acknowledgement that
  licensing rules were offered; food-provision agreement; **firearms
  disclosure**; **lead-based-paint disclosure (homes built before 1978)**;
  notice of licensing-notebook availability — **none of these exist.**
- Immunization records or signed waiver — no field (`medical_notes` is
  free text, not a structured immunization/waiver record).
- Annual review of all child records — no review-date tracking.
- Retention 2 years after child leaves — `children` has **no
  `archived_at`** (note: this is also a latent soft-delete gap vs
  `CLAUDE.md`'s "never hard-delete audit records" rule; flag it).

**Extension vs build:** **Mostly extend** the existing Families →
Children surface (the owner's "extend existing surfaces" directive fits
perfectly here) plus a **new child-intake acknowledgement** built on the
Category C generalized model. Concretely:
- Extend `children` with structured fields: `immunization_status` /
  waiver, `lead_disclosure_*` (home pre-1978 flag + acknowledgement link),
  `firearms_on_premises`, `food_provider`, `records_last_reviewed_on`, and
  add `archived_at` for retention.
- Add a "child in care statement" as a set of acknowledgement rows
  (Category C model) captured in the Children tab at intake.
- Lead-based-paint disclosure mechanism almost certainly does not exist
  today — confirmed no hits in `src/`. New.

**Recommended difficulty:** **M** (assuming the Category C
acknowledgement generalization lands first or with it). Extending the
existing child form is low-risk; the intake-signature flow is the new
surface; the lead/firearms disclosure is a handful of fields + an
acknowledgement.

**Dependencies:** PR 0a; **tightly coupled to Category C** (the child-in-
care statement *is* a bundle of acknowledgements). Build C's
generalization and D together, or C immediately before D.

---

### Category E — Staff file completeness

**Rule reference:** Rules 3, 6, 19, 20, 22, 33 → in code these map to the
`R 400.1901–1963` range cited throughout migration 012 (e.g. background
check `R 400.1919`/`R 400.1903(1)(r)`; CPR/First Aid `R 400.1920(3)`/
`1921(3)`/`1924(8)`; MiRegistry `R 400.1922`; new-hire training
`R 400.1923`; professional development `R 400.1924`).

**Current state — substantially covered by PR #8 (already shipped):**
- `caregivers` (migration 012): the regulatory roster. Has `full_name`,
  `email`, `app_user_id` (links to an auth user when the caregiver is also
  an app user), **`date_of_hire`**, `archived_at` soft-delete. Crucially,
  a caregiver need NOT be an app user — drivers/volunteers are trackable.
- `caregiver_regulatory_roles`: many-to-many person→role over the 6-value
  `regulatory_role` enum (`licensee`, `child_care_staff_member`,
  `child_care_assistant`, `unsupervised_volunteer`, `supervised_volunteer`,
  `driver`), with driver-only attributes for ratio/unsupervised-access.
- `staff_training_records`: per-caregiver log with category enum covering
  **new-hire training (14 topics, 90-day), CPR/First Aid (with
  `expires_on` expiration tracking), professional development,
  health-safety-update acknowledgement, MiRegistry account, background-
  check eligibility**, plus typed `miregistry_status` (R 400.1922) and
  `background_check_status` (pending/eligible/ineligible, R 400.1919).
- `health_safety_updates`: per-licensee MiLEAP notice tracking
  (R 400.1924(11)).
- UI: `/staff-training` page with `StaffComplianceMatrix`,
  `ExpiringSoonList`, `CaregiverTrainingLog`, `TrainingEntryForm`,
  `RegulatoryRoleAssignment`; gated by `MODULE_KEYS.STAFF_TRAINING`
  (active when `is_license_exempt === false` or the user is a tracked
  staff caregiver).
- **Staff daily arrival/departure (Rule 6):** `staff_time_entries`
  (production table; `StaffClockWidget.jsx`) records `clock_in`/
  `clock_out` timestamps + optional GPS per app-user staff member. This is
  a working staff time log.

**Gaps:**
- **Physician attestation of mental & physical health, renewed annually
  (Rule 33 / `R 400.1933`?)** — **not modeled.** No category in the
  `staff_training_category` enum and no field. Could be a new category +
  `expires_on`-driven annual reminder, or a documents-vault entry. New.
- **Daily arrival/departure log for *all* staff (Rule 6).**
  `staff_time_entries` only covers caregivers who are **app users**
  (keyed on `staff_user_id`). Drivers/volunteers/assistants who never log
  in (the exact population `caregivers` was built to track) have **no
  arrival/departure surface.** Gap: a caregiver-keyed manual
  arrival/departure log, or extend the clock concept to non-app-user
  caregivers (provider records it on their behalf).
- **Sex-offender-registry clearance for assistants & volunteers (Rule 3.r
  / `R 400.1903(1)(r)`).** Partially expressible via
  `background_check_eligibility` records, but there's no distinct
  registry-clearance field/status; today it would be an undifferentiated
  background-check row. Minor extension.
- **Discipline-policy acknowledgement at hire (Rule 6)** — covered under
  Category C (staff side).
- **CCBC integration (Rule 19)** — no integration exists; status is
  manual capture via `background_check_status`. Acceptable for V1 (manual),
  but note it's manual.

**Extension vs build:** **Extend PR #8.** Add a physician-attestation
category (or documents slot) with annual expiry; add a caregiver-keyed
arrival/departure log for non-app-user staff; optionally add a
registry-clearance discriminator to background-check records. The
compliance matrix and `ExpiringSoonList` already exist to surface these.

**Recommended difficulty:** **S–M.** This is the smallest gap of the six —
the substrate (caregivers, roles, records, expiry, matrix UI) is shipped.
Physician attestation + the non-app-user arrival log are the only net-new
pieces.

**Dependencies:** PR 0a (it already self-gates via `STAFF_TRAINING`
module, which keys on `is_license_exempt === false` — reconcile with the
new license-type field). Category C provides the staff-hire discipline
acknowledgement. Otherwise independent.

---

### Category F — Property records

**Rule reference:** Rules 7, 13, 15, 17, 18, 45, 48 (`R 400.xxxx` not
confirmed — flag as OQ).

**Current state:**
- **No property/facility table or fields found anywhere.** No radon,
  carbon-monoxide, smoke-detector, fire-extinguisher, heating-inspection,
  pet/animal-notification, or smoking-prohibition concept in any migration
  or `src/` file (confirmed by repo-wide grep — zero hits outside this
  prompt).
- **A reusable document-storage mechanism exists:** the **funding document
  vault** (migration 008) — a private `funding-documents` Storage bucket +
  `funding_documents` table with `document_type` enum, `retention_until`
  (defaults to +4 years), `archived_at` soft-delete, one-active-per-type
  unique index, and a clean `FundingDocumentSlot.jsx` upload/replace/view
  component. This is the obvious template for storing radon reports,
  heating-inspection certificates, and the licensing notebook.

**Gaps (vs the cited rules):**
- Radon test before initial license + every 4 years (Rule 15) — no
  record, no due-date tracking.
- Heating-equipment inspection every 4 years (Rule 45) — none.
- Carbon-monoxide detectors per level (Rule 15) — no checklist/attestation.
- Smoke detectors per floor/basement/sleeping areas (Rule 48) — none.
- Multipurpose fire extinguisher (2A-10BC+) per floor (Rule 48) — none.
- Animal/pet notification to parents (Rule 17) — none (could ride the
  acknowledgement model).
- Smoking/vaping prohibition posted (Rule 18) — no attestation.
- **Licensing notebook** (last 3 years of inspections, investigations,
  corrective actions, approval letters; summary sheet; parent-accessible)
  — no storage; the document vault is the natural home.

**Extension vs build:** **Build a thin `property_records` model**
(per-provider facility attributes + dated inspection/test events:
`record_type`, `performed_on`, `next_due_on`, `result`, optional
document link) and **reuse the document-vault pattern** (generalize
`funding_documents` into a documents store, or add a parallel
`compliance-documents` bucket following the same RLS/retention template)
for radon reports, heating certs, and the licensing notebook. **Reuse**
the banner + opt-in reminder system for "radon test due in 30 days" /
"heating inspection due." Detector/extinguisher presence is a simple
per-property checklist with an attestation date.

**Recommended difficulty:** **M.** No single hard part — a modest table, a
documents store (pattern exists), a few attestation checkboxes, and
reminder wiring. The 4-year recurring-due math reuses the same schedule
helper as Category A.

**Dependencies:** PR 0a (gating); PR 0b (reminders); benefits from the
document-vault generalization. Independent of A–E otherwise.

---

## Cross-cutting infrastructure

### Reminder system (foundation for opt-in compliance alerts)

**What exists:**
- **Event-driven notifications:** `src/lib/notifications.js` →
  `api/notify-state-change.js` → writes `notification_log` and (per build
  history) sends email via **Resend**. Fires immediately on data changes
  (allergy updated, guardian added, etc.). Not schedule-based.
- **Scheduled digest (the closest precedent):**
  `api/cron-send-acknowledgment-digest.js` — a Vercel cron that checks
  each provider's configured send-day/hour/timezone and emails a digest.
  **It is currently DISABLED**: the project is on **Vercel Hobby (2-cron
  limit)** and both slots are taken by the autopay crons
  (`docs/tech_debt.md`, 2026-05-22). The handler, helpers, and migration
  are live; only the schedule entry is removed from `vercel.json`.
- **In-app banner pattern (the strongest reusable asset):**
  `cdcProviderCompliance.js` (pure `date → {severity,label}` helpers with
  an info/warning/urgent/critical/expired ladder) feeding
  `AnnualTrainingBanner.jsx` (self-loading, gated on profile, renders a
  tinted banner). `DashboardPage.jsx` stacks `onboardingBanner` +
  `annualTrainingBanner` at the top (lines ~200–218, ~289–291) — the exact
  slot new compliance banners go. `MiRegistryWarningBanner.jsx` is a
  second instance of the pattern, surfaced in the Families modal.
- The `getFingerprintReprintState` helper shows the precedent for a
  multi-threshold "X is due / overdue" reminder already in the codebase.

**What's missing for "opt-in per category with configurable lead time":**
- **No preferences model.** Provider settings are ad-hoc columns on
  `profiles` (e.g. the six `acknowledgment_*` columns). There is no
  `compliance_reminder_settings` table and no per-category opt-in/lead-time
  store. PR 0b should add one (a per-(provider, category) row: `enabled`,
  `lead_time_days`, `channel`).
- **No settings UI for it.** The only settings surfaces are
  `BusinessInfoPage` and the acknowledgment `SettingsCard` on
  `ProviderAcknowledgmentsPage`. A compliance-reminders settings panel is
  net-new.
- **Channel decision needed.** In-app banners are free and already
  patterned — recommend banners as the default channel (works today, no
  cron). Email reminders hit the **Vercel cron ceiling** and need a
  capacity decision first (upgrade to Pro / consolidate the two autopay
  crons into one dispatcher / move to Supabase `pg_cron`). Recommend PR 0b
  ship **opt-in in-app banners first**, with email as a fast-follow gated
  on the cron-capacity decision.

### License type field on provider profile

**What exists:**
- `profiles.is_license_exempt` (boolean, **nullable**; migration 004).
  Captured via `LicenseStatusPromptModal` after a provider's first CDC
  Scholarship source (`licenseStatusPrompt.js`). It is binary (exempt vs.
  not) and frequently `null` (`docs/tech_debt.md` § "License status
  indefinitely null").
- `profiles.provider_type` (migration 018, **nullable**, CHECK enum):
  `lep_related` | `lep_unrelated` | `licensed_family` | `licensed_group` |
  `licensed_center`. **This already encodes the family-vs-group
  distinction** the owner wants — but it's framed as a *CDC-billing*
  classification (drives the fingerprint-reprint check, care-location
  constraint), is nullable, and is **not** wired to any module gating.
- `profiles.michigan_license_number` (migration 004): drives
  `MODULE_KEYS.LICENSED_COMPLIANCE` (`modules.js:117`).
- `MODULE_KEYS.LICENSED_COMPLIANCE` and `LICENSE_EXEMPT_COMPLIANCE`
  **already exist** in `modules.js` and `program_settings`
  (`licensed_compliance` / `license_exempt_compliance` boolean|null), but
  nothing meaningful renders behind them yet.

**Recommendation — reconcile, don't add a third overlapping field.**
The owner's proposed `license_type` ENUM (`'family_home'`, `'group_home'`,
`'license_exempt'`) overlaps `provider_type` and `is_license_exempt`.
Adding a third independent field risks three sources of truth that can
disagree (a known failure mode in this codebase — see the `notification_log`
collision). Options for the foundation PR:
- **Preferred:** introduce `license_type` as the single
  compliance-gating field, and **derive/migrate** it from the existing
  signals (`provider_type` licensed_family→family_home, licensed_group→
  group_home; `is_license_exempt === true`→license_exempt), with a backfill
  that **flags ambiguous rows for human review** rather than guessing
  (per `CLAUDE.md`'s no-default-funding-type rule, same principle). Keep
  `provider_type` for CDC billing; document `license_type` as the
  compliance source of truth.
- Whichever field wins, the foundation PR must wire it into `modules.js`
  so A–F surfaces gate on it, and add a capture surface (extend
  `LicenseStatusPromptModal` from a yes/no into family/group/LEP, and a
  `BusinessInfoPage` editor).

**Places that must check license type to show/hide compliance surfaces:**
`src/lib/modules.js` (`getActiveModules` — the single chokepoint),
`useActiveModules.js`, `Sidebar.jsx` (Compliance section nav gating),
`DashboardPage.jsx` (banner stack), and each new category page's
module-gate redirect.

### Existing acknowledgement infrastructure (PR #12) — can it be extended?

**Finding:** The *pattern* is excellent and the helper
(`src/lib/parentAcknowledgment.js`: `computeAttendanceHash`,
`getAcknowledgmentState`, etc.) is pure and reusable. But the **table
should not be overloaded** with an `acknowledgment_type` discriminator
(detailed rationale in Category C). `attendance_acknowledgments` is keyed
on `(child_id, date, segment_index)`, carries an attendance-specific
snapshot hash, and has a CHECK + RLS bound to the `attendance` table —
all of which break down for date-less, attendance-less acknowledgements
(discipline policy at hire, lead/firearms disclosure, medication
permission).

**Recommendation:** Build a new general `acknowledgments` table
(`subject_type` + polymorphic `subject_id` + `acknowledged_by_user_id` +
`acknowledged_at` + optional `snapshot_hash` + `archived_at`) that serves
Categories C, D, and B's parent-permission, reusing the existing pure
hash/state helpers. Leave `attendance_acknowledgments` as the
attendance-specialized table it is. This new model is best **owned by the
Category C/D PR** since those are its first consumers.

---

## Recommended PR sequence

Ordered by dependency, then by day-one compliance value and reuse
leverage. The two foundation PRs are hard prerequisites.

1. **PR — License-type foundation (0a).** Add/reconcile the
   compliance-gating license-type field; backfill from `provider_type` /
   `is_license_exempt` with ambiguous rows flagged for review; wire into
   `modules.js`; extend the license-status capture + `BusinessInfoPage`.
   *Blocks A–F.* Difficulty **S–M.**

2. **PR — Opt-in reminder system (0b).** Per-category reminder-preferences
   model + settings UI; generalize the `cdcProviderCompliance.js` banner
   pattern into a reusable compliance-banner host on the dashboard;
   in-app banners as the day-one channel; email deferred pending the
   cron-capacity decision. *Blocks every category's reminders.*
   Difficulty **M.**

3. **PR #14 — Category D, Child file completeness.** Extends the Families →
   Children surface; introduces the **general `acknowledgments` model**
   (the child-in-care statement); adds `children.archived_at`,
   immunization/waiver, lead/firearms disclosure, food-provider,
   annual-review fields. Highest day-one value for Venessa's live roster.
   Difficulty **M.**

4. **PR #15 — Category C, Discipline policy & acknowledgement.** Policy
   storage + parent-at-intake and staff-at-hire acknowledgements,
   consuming the model PR #14 introduced (or this PR introduces it and D
   consumes — owner's call; they must ship adjacent). Difficulty **M.**

5. **PR #16 — Category E, Staff file completeness.** Extends PR #8: add
   physician-attestation (annual expiry), non-app-user caregiver
   arrival/departure log, registry-clearance discriminator. Smallest gap.
   Difficulty **S–M.**

6. **PR #17 — Category A, Drill log & Emergency Response Plan.**
   Self-contained: drill log + schedule engine (3 cadence types) +
   emergency-plan store (structured or uploaded-PDF), reminders via PR 0b.
   Difficulty **L** (M if the plan is a document upload).

7. **PR #18 — Category B, Medication Administration Log.** Reuses the
   acknowledgement model (parent permission), `caregivers`/roles
   (administered_by gating), and TodayWidget (dose logging). Sequenced
   after C/D/E so its dependencies exist. Difficulty **L** (→M after C/D).

8. **PR #19 — Category F, Property records.** `property_records` +
   document store (generalize the funding-document vault) + 4-year
   recurring-due reminders (reuse PR #17's schedule helper). Difficulty
   **M.**

Rationale for ordering A/B after C/D/E despite the prompt's #14–#19
labeling: D and C unlock the acknowledgement generalization that B
depends on; E is the cheapest win and shares the staff-hire acknowledgement
with C. A and F are the most self-contained greenfield builds and benefit
from the reminder/schedule infrastructure being mature by the time they
land. The owner may renumber to match the #14–#19 convention; the
*dependency* order is what matters.

---

## Open questions for the owner

1. **Exact `R 400.xxxx` citations.** The prompt's "Rule 39 / 31 / 7 / 42 /
   45 / 48…" numbers need mapping to the adopted rule set's Administrative
   Code numbers for the runbook/spec docs. Migration 012 cites the staff
   range (`R 400.1919–1924`); the others are unconfirmed in code. Provide
   the rule PDF or a mapping table.
2. **Emergency plan: structured or uploaded document?** Storing the 10
   emergency types × 9 plan dimensions as structured fields is an L; storing
   the written plan as an uploaded PDF (document-vault pattern) is an M.
   Which does the inspector experience require?
3. **License-type field reconciliation.** Confirm the preferred approach:
   add a dedicated `license_type` ENUM as the compliance source of truth
   and derive it from `provider_type`/`is_license_exempt` (recommended), or
   repurpose `provider_type` directly? And how should ambiguous backfill
   rows be surfaced for review?
4. **Reminder channel + cron capacity.** In-app banners only for V1
   (works today), or email too? If email, which cron-capacity path —
   upgrade to Vercel Pro, consolidate the two autopay crons into one
   dispatcher, or move scheduling to Supabase `pg_cron`?
5. **Acknowledgement model ownership.** Build the general `acknowledgments`
   table in the Category D PR (first consumer) or the Category C PR?
   They must ship adjacent regardless.
6. **`children` retention / soft-delete.** `children` has no `archived_at`,
   which is both a Rule 7 retention gap *and* a `CLAUDE.md`
   never-hard-delete violation. Fix inside Category D, or as a standalone
   schema-hygiene migration first?
7. **`business_policies` schema is undocumented.** Its full column list is
   production-only (referenced only for `messaging_enabled`). Before
   Category C declares discipline-policy storage, run the "check
   table-name availability" + production-introspection procedure
   (`docs/tech_debt.md`) — the discipline policy may belong on this
   existing table rather than a new one.
8. **Non-app-user staff arrival/departure (Rule 6).** Should the provider
   record arrival/departure on behalf of drivers/volunteers who never log
   in (the `caregivers` population), and does the rule accept a
   provider-entered log vs. a self-clock?
9. **Staff ratios.** The prompt flags Group Home staff ratios may differ
   from current implementation — no ratio logic for licensed homes was
   found in this audit (the only ratio concept is the I-Billing
   concurrent-children cap and the `ts_ratios` tax helper). Out of scope
   for these six categories, but flag whether a ratio module is needed.

---

## Files audited

Context / docs:
- `docs/prompts/claude_code_licensed_home_compliance_audit.md` (the prompt)
- `docs/backlog.md`
- `docs/tech_debt.md`
- `docs/architecture.md`
- `docs/build-summary-2026-05-21.md`
- `CLAUDE.md` (project instructions, in context)

Migrations:
- `supabase/migrations/001_profiles.sql`
- `supabase/migrations/004_provider_program_settings.sql`
- `supabase/migrations/008_funding_documents.sql`
- `supabase/migrations/012_staff_training.sql`
- `supabase/migrations/016_capture_existing_schema_for_pr_8_5.sql`
  (children, families, guardians, emergency_contacts, attendance)
- `supabase/migrations/018_provider_cdc_billing_settings.sql`
- `supabase/migrations/020_parent_acknowledgment.sql`
- (full migration list `001`–`020` enumerated; remainder scanned by grep
  for drill/medication/property/discipline/license-type terms — no hits)

Application code:
- `src/lib/modules.js`
- `src/lib/notifications.js`
- `src/lib/cdcProviderCompliance.js`
- `src/lib/licenseStatusPrompt.js`
- `src/components/dashboard/AnnualTrainingBanner.jsx`
- `src/components/dashboard/StaffClockWidget.jsx`
- `src/components/dashboard/Sidebar.jsx`
- `src/pages/FamiliesPage.jsx` (tabs + ChildrenTab/child form,
  targeted read)
- `src/pages/DashboardPage.jsx` (banner stack, targeted read)

Repo-wide searches (grep, all of `src/`, `api/`, `supabase/`, `docs/`):
- drill / emergency / evacuation / tornado / shelter / lockdown /
  reunification → only `emergency_contacts` + docs (no drill/plan model)
- medication / dose / administer / prescribe → only docs (no med model)
- discipline / immunization / firearm / lead-paint / intake → only docs
- radon / carbon-monoxide / smoke-detector / fire-extinguisher / heating /
  property / facility / inspection → no property model
- license_type / family_home / group_home / license_exempt → `modules.js`,
  `provider_type` enum (018), onboarding/marketing copy
- cpr / first-aid / background-check / CCBC / hire_date / cert / expir →
  PR #8 staff-training surfaces

*Deliverable saved to `docs/licensed-home-compliance-audit-2026-05-23.md`.
No source files were modified. No branches created.*
