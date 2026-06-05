# MILittleCare — Feature Interaction Map

> **Purpose.** A single reference describing every shipped feature: what it
> does, who interacts with it, the concrete click-path, what the system does
> automatically, current status, and where the behavior is documented.
>
> **Source discipline.** Every claim cites a spec doc, code file, or runbook
> entry. Where the spec and code clearly differ, the discrepancy is flagged
> rather than papered over. Where neither documents the behavior clearly, the
> entry says so explicitly — it does not invent behavior.
>
> **Last verified:** 2026-06-05 against `main` (post-Phase Y1 e-sign + comped
> bypass merges). Routing reference: `src/App.jsx`. Nav reference:
> `src/components/dashboard/Sidebar.jsx`. Module activation reference:
> `src/lib/modules.js`.
>
> **How to read the Status column.** "Shipped" = in production and exercised
> by real users. "Shipped — dormant" = code is in production but a gate
> (cron disabled / opt-in default OFF / no UI yet) keeps it from running.
> "Planned" = scoped but not built.

---

## Map of areas

1. [Account & subscription](#1-account--subscription)
2. [Onboarding & identity capture](#2-onboarding--identity-capture)
3. [Tax tools (the original core)](#3-tax-tools)
4. [Families: people, kids, intake, consents, medication](#4-families)
5. [Funding sources & document vault](#5-funding-sources--document-vault)
6. [CDC programs (pay periods + I-Billing)](#6-cdc-programs)
7. [Compliance: MiRegistry + Staff Training + Compliance Engine](#7-compliance)
8. [Operations: attendance + acknowledgments](#8-operations)
9. [Billing & payments (private pay + autopay)](#9-billing--payments)
10. [Communication: messages + notifications + reminders](#10-communication)
11. [Parent portal & parent self-service](#11-parent-portal--self-service)
12. [System & cron](#12-system--cron)
13. [Planned — not yet built](#13-planned--not-yet-built)
14. [Spec docs consulted](#14-spec-docs-consulted)
15. [Spec ↔ code divergences flagged](#15-spec--code-divergences-flagged)

---

## 1. Account & subscription

### 1.1 Sign-up + authentication

- **What it is.** Magic-link + password authentication via Supabase Auth.
  Public landing page, login page, password reset.
- **Who uses it.** Providers (licensee, adult_staff, assistant, view_only)
  and parents. Two distinct auth surfaces — providers land on `/dashboard`,
  parents on `/parent`.
- **How they interact.**
  - Provider: `/login` → enter email → magic link OR existing-password
    sign-in. `/forgot-password` and `/reset-password` for password recovery.
  - Parent: receives a magic-link invitation from their provider's
    Families tab (Phase X / PR #12) → clicks the link → lands on `/parent`.
- **Automatic vs manual.** Email send is automatic on invite. Session
  refresh is automatic. Password set is manual (and surfaces a banner for
  parents who are still magic-link-only — see §11.1).
- **Status.** **Shipped.**
- **Source.** `src/pages/LoginPage.jsx`, `src/pages/ForgotPasswordPage.jsx`,
  `src/components/auth/ProtectedRoute.jsx`, `src/App.jsx:65-100`,
  `api/send-invitation.js`, `api/accept-invitation.js`.

### 1.2 Subscription paywall

- **What it is.** A Stripe-backed subscription gate. Trial → active →
  expired/canceled lifecycle, with the in-app paywall overlay rendered
  by `PaywallGate` around every authenticated provider route.
- **Who uses it.** Provider (licensee role). Staff roles inherit access
  through their licensee — they don't pay separately.
- **How they interact.**
  - First-login trial automatic.
  - `Settings → Subscription` shows current plan + payment portal.
  - Expired user: paywall overlay blocks the dashboard until they pay or
    sign out. `/subscription` is the only route they can still reach.
- **Automatic vs manual.** Trial countdown derived from
  `profiles.trial_ends_at`. `subscription_status` flips via Stripe webhook
  (`api/stripe-webhook.js`). The user must click through the Stripe
  customer portal manually.
- **Status.** **Shipped.**
- **Source.** `src/components/subscription/PaywallGate.jsx`,
  `src/hooks/useSubscription.js`, `src/pages/SubscriptionPage.jsx`,
  `api/create-checkout-session.js`, `api/create-portal-session.js`,
  `api/stripe-webhook.js`, `src/lib/pricing.js`.

### 1.3 Comped-account paywall bypass

- **What it is.** A `profiles.comped boolean` flag that bypasses the
  paywall regardless of `subscription_status` or `trial_ends_at`.
- **Who uses it.** Provider (the column is on `profiles`). Today only
  Seth (`smdominique`) and Venessa (`nessa7190`) are flipped to `true`.
- **How they interact.** **No UI.** The flag is set via direct
  `UPDATE profiles SET comped = true WHERE id = ...` in the Supabase
  SQL Editor. A comped user simply never sees the paywall overlay.
- **Automatic vs manual.** Manual flip; everything else is automatic
  (`isComped` flows into `useSubscription`'s `hasAccess` derivation).
- **Status.** **Shipped 2026-06-04** (no in-tree migration; production
  schema change recorded in the runbook). Comped is purely operational —
  there is no admin UI to set it.
- **Source.** `src/hooks/useSubscription.js` (the `isComped` OR branch),
  `docs/runbook.md` § "2026-06-04 — Production schema change (manual …)
  profiles.comped paywall bypass".

### 1.4 Roles & team management

- **What it is.** Four provider-side roles — `licensee`, `adult_staff`,
  `assistant`, `view_only` — plus parent. Nav and route access filter by
  role. Staff invites are token-based.
- **Who uses it.** Licensee invites; staff accept; system enforces.
- **How they interact.**
  - Licensee: `Settings → Team` (`/staff`) → "Invite" → enters email +
    picks role → email sent. Sees roster + timesheet view.
  - Staff: clicks invite link → `/staff-invite/:token` → accepts.
- **Automatic vs manual.** Invite expiry + token rotation automatic;
  role gating is in `useRole` + Sidebar.
- **Status.** **Shipped.**
- **Source.** `src/pages/StaffPage.jsx:10-26` (role definitions),
  `src/hooks/useRole.jsx`, `src/components/dashboard/Sidebar.jsx:135-142`
  (role filter), `api/send-staff-invitation.js`,
  `api/accept-staff-invitation.js`.

---

## 2. Onboarding & identity capture

### 2.1 First-login onboarding wizard

- **What it is.** A conversational wizard that captures the nine
  structural-identity fields that drive module activation
  (license type, MiRegistry ID, Michigan license/provider IDs, CDC /
  Tri-Share / GSRP / CACFP participation, rough enrollment count,
  typical weekly hours). Writes into the canonical columns; **does not**
  introduce new system-of-record tables.
- **Who uses it.** Provider (licensee) on first login.
- **How they interact.** Full-screen `/onboarding` route (no sidebar,
  no DashboardLayout per spec §4.1). One question per screen. Skippable.
  After completion (or skip), a persistent `OnboardingCompletionCard` on
  the Dashboard surfaces remaining steps. The dashboard auto-opens the
  wizard at most once per browser session
  (`milc.onboarding.autoOpened` sessionStorage key).
- **Automatic vs manual.** Manual answers. Auto-open is automatic on
  first login. `getWriteTargets()` derives the column writes for each
  answer; `is_license_exempt` is mirrored from `license_type` in
  lockstep (PR #14 invariant).
- **Status.** **Shipped.**
- **Source.** `docs/onboarding_wizard_spec.md`,
  `src/pages/OnboardingPage.jsx`, `src/lib/onboarding.js`,
  `src/components/onboarding/*.jsx` (the wizard components +
  `OnboardingCompletionCard.jsx` live under `onboarding/`, not
  `dashboard/`),
  `src/pages/DashboardPage.jsx:22-24` (auto-open sessionStorage key).

### 2.2 License-status prompt modal (legacy fallback)

- **What it is.** A modal that asks "Are you license-exempt or
  licensed?" — pre-dates the onboarding wizard and now serves as a
  fallback for providers who skipped that question.
- **Who uses it.** Provider.
- **How they interact.** Fires opportunistically when the system needs
  the value (e.g., a CDC funding source is created on a provider whose
  `license_type` is null). User picks one of three values
  (`family_home` / `group_home` / `license_exempt`).
- **Automatic vs manual.** Fire conditions automatic; the answer writes
  three profile fields in lockstep — `license_type` (source of truth),
  `is_license_exempt` (mirror), `license_type_review_needed = false`
  (clears the dashboard nudge banner).
- **Status.** **Shipped.** Per the onboarding spec, this is now a
  fallback — the wizard is the canonical capture point.
- **Source.** `docs/license_status_prompt_spec.md`,
  `src/components/funding/LicenseStatusPromptModal.jsx`,
  `src/components/dashboard/LicenseTypeReviewBanner.jsx`,
  `src/lib/licenseStatusPrompt.js`.

---

## 3. Tax tools

The original core of the product. Receipts → categorized deductions →
T/S ratio computation → year-end tax export.

### 3.1 Receipts

- **What it is.** Per-receipt capture: photo upload, OCR scan, category
  assignment, dollar amount, vendor, date, notes. Roll-up reports.
- **Who uses it.** Provider (licensee + adult_staff). View-only role
  cannot reach Receipts; assistant cannot either.
- **How they interact.** Sidebar → `Tax Tools → Receipts`
  (`/receipts`). Upload or photograph receipts, tag the category, edit
  amount. The "Sparkles" Scan button triggers AI extraction.
- **Automatic vs manual.** Image upload + storage (Supabase Storage
  `receipts` bucket) is automatic. AI scan is automatic on click;
  re-categorization is manual. Image compression is automatic via
  `browser-image-compression`.
- **Status.** **Shipped.**
- **Source.** `src/ReceiptsPage.jsx` (note: at `src/` root, not yet
  moved to `src/pages/` per `CLAUDE.md` File Structure note),
  `api/scan-receipt.js`, `src/lib/storage.js`,
  `supabase/migrations/002_receipts.sql`.

### 3.2 Deductions

- **What it is.** Aggregated view of receipts grouped by deduction
  category. Sums per category. Drives the tax export.
- **Who uses it.** Provider (licensee, adult_staff, view_only).
- **How they interact.** Sidebar → `Tax Tools → Deductions`
  (`/deductions`). Read-mostly. The category list is fixed per
  IRS Schedule C conventions for in-home child care.
- **Automatic vs manual.** Sums + roll-ups automatic; the underlying
  receipts are manual entry.
- **Status.** **Shipped.**
- **Source.** `src/pages/DeductionsPage.jsx`.

### 3.3 T/S Ratio (Time/Space ratio)

- **What it is.** The Time / Space ratio is the IRS deduction
  apportionment for home-based daycare — the fraction of total home
  area × hours used for business that determines what share of mixed
  household expenses (utilities, depreciation) can be deducted.
- **Who uses it.** Provider (licensee, adult_staff, view_only).
- **How they interact.** Sidebar → `Tax Tools → T/S Ratio`
  (`/ts-ratio`). Provider enters home square footage + business-use
  area, hours of operation, weekly attendance. Tool computes the
  ratio for the year.
- **Automatic vs manual.** Computation automatic from entered
  attendance + space values; the inputs are manual.
- **Status.** **Shipped.**
- **Source.** `src/pages/TSRatioPage.jsx`.

### 3.4 Tax export

- **What it is.** Year-end export bundling receipts, deductions, T/S
  ratio, and attendance hours into a single document for the
  provider's accountant.
- **Who uses it.** Provider (licensee, adult_staff).
- **How they interact.** The `TaxExportButton` component is exposed
  on the Deductions / Reports surfaces. Click → produces an export
  (Excel via the `xlsx` package per `CLAUDE.md` Tech Stack).
- **Automatic vs manual.** Export generation automatic on click.
- **Status.** **Shipped.**
- **Source.** `src/components/ui/TaxExportButton.jsx`,
  `src/lib/taxExport.js`.

---

## 4. Families

Central provider workflow. Families page is where children, guardians,
emergency contacts, funding sources, intake bundles, and consents all
live.

### 4.1 Families / Children / Guardians / Emergency Contacts CRUD

- **What it is.** The provider's roster: families (a billing unit),
  children (one or more per family), guardians (parents/legal
  guardians, can be linked to an auth user for portal access), and
  emergency contacts (per family).
- **Who uses it.** Provider (licensee + adult_staff).
- **How they interact.** Sidebar → `Revenue → Families`
  (`/families`). Add family → add children → add guardians → invite
  guardian as a parent portal user (sends magic-link invite via
  `api/send-invitation.js`). Emergency contacts are added per family.
- **Automatic vs manual.** Invite email is automatic on click;
  everything else is manual entry.
- **Status.** **Shipped.**
- **Source.** `src/pages/FamiliesPage.jsx`, `src/lib/children.js`,
  `api/send-invitation.js`.

### 4.2 Child intake bundle (R 400.1907 — Rule 7)

- **What it is.** An eight-acknowledgment bundle that licensed Family /
  Group Home providers must collect from a parent before a child's
  initial attendance: child-in-care statement, lead-paint disclosure
  (homes built before 1978), firearms disclosure, infant safe-sleep,
  immunization record (or waiver), food-provider agreement,
  licensing-rules-offered, licensing-notebook-availability.
- **Who uses it.** Provider initiates; parent confirms.
- **How they interact.**
  - Provider: Families → child profile → "Intake" → fills the
    `ChildIntakeModal`, picks per-bundle parent-signature channel,
    sends. The send writes one polymorphic `acknowledgments` row per
    bundled type (provider_override channel as placeholder) and one
    `reminder_instances` row to surface the to-do for the parent.
  - Parent: receives email with link → `/parent/intake-acknowledge?child=<id>` →
    reads each item → confirms. The `intake_confirm_for_parent` SECURITY
    DEFINER RPC (migration 025) archives the provider_override rows and
    inserts `parent_portal` rows in one atomic transaction, then resolves
    the reminder.
- **Automatic vs manual.** Reminder send + email automatic. Atomic RPC
  resolution automatic. Channel choice + the actual click are manual.
- **Status.** **Shipped.** Gated to `license_type IN ('family_home',
  'group_home')` only — LEPs do not see the intake flow.
  R 400.1907(1)(b)(iii) "licensing rules offered" was added 2026-05-29
  (see roadmap doc).
- **Source.** `docs/pr-16-child-files-scope.md`,
  `docs/milittlecare-roadmap-2026-05-29.md`,
  `src/components/families/ChildIntakeModal.jsx`,
  `src/pages/ParentIntakeAcknowledgePage.jsx`,
  `src/lib/childFiles.js`, `src/lib/acknowledgments.js`,
  `supabase/migrations/025_*.sql` (the RPC).

### 4.3 Enrollment / Operational consents

- **What it is.** Captures the licensing-required operational consents
  beyond the intake bundle — photo sharing (provider-protective, not
  licensing-required), transportation (R 400.1952(1)), field trips
  (R 400.1952(2)), water activities (R 400.1934(10)). Modeled via the
  same polymorphic `acknowledgments` table; Phase C added
  `occurrence_metadata` and an `expires_at` column for per-occurrence
  variants.
- **Who uses it.** Provider records; parent may view their family's
  consents on the parent portal.
- **How they interact.** Provider: Families → child profile → "Consents"
  → opens `EnrollmentConsentsModal` → picks consent type + channel
  → saves. Currently captured via provider attestation
  (provider_override channel) OR `in_person_paper`; medium-risk
  parent-portal e-sign is shipped dormant (see §11.5).
- **Automatic vs manual.** Manual. Snapshot hashing automatic.
- **Status.** **Shipped** for provider-recorded path. Parent-portal
  e-sign path (Phase Y2) **not yet built** — see §13.
- **Source.** `docs/pr-consents-A-scope.md`,
  `docs/pr-consents-B-scope.md`, `docs/pr-consents-C-scope.md`,
  `src/components/families/EnrollmentConsentsModal.jsx`,
  `src/lib/acknowledgments.js`,
  `supabase/migrations/026_acknowledgments_expires_at.sql`,
  `supabase/migrations/027_*.sql`.

### 4.4 Medication authorization + administration log (R 400.1931)

- **What it is.** Per-child medication record: parent permission ack
  per medication, dose log per administration, role-gate restricting
  who may administer (R 400.1931(1) — licensee or
  child_care_staff_member only; topical OTC exempt under (8)).
- **Who uses it.** Provider creates authorization (collects parent
  permission via `acknowledgments` row); caregiver-on-shift records
  each dose.
- **How they interact.** Families → child profile → "Medications" →
  `MedicationModal` to add an authorization (medication, dose,
  schedule, prescriber, OTC flag) + collect parent permission.
  Each administered dose writes a `medication_administration_events`
  row, gated by the DB trigger `medication_event_caregiver_role_check`.
- **Automatic vs manual.** Role gate enforced at DB trigger (defense
  in depth per CLAUDE.md). Re-acknowledgment detection (when an
  authorization's dose/schedule changes) is derived via snapshot-hash
  drift. Recording itself is manual.
- **Status.** **Shipped.**
- **Source.** `docs/pr-20-medication-log-scope.md`,
  `src/components/families/MedicationModal.jsx`,
  `src/lib/medication.js`, `supabase/migrations/028_*.sql`.

### 4.5 Consent attachments

- **What it is.** Optional file attachments (e.g., scanned paper-signed
  consent forms) bound to an `acknowledgments` row or a
  `medication_authorization` row via a polymorphic
  `(target_type, target_id)` pair. Parent can view-only via an Edge
  Function that mints a signed URL.
- **Who uses it.** Provider uploads; parent views.
- **How they interact.** Provider: from the consents modal, attaches
  a file. Parent: from `/parent/acknowledge`, sees the attachment
  link and downloads. **Parents cannot delete** (data-layer enforced
  via RLS + the absence of any DELETE policy at the table or storage
  level).
- **Automatic vs manual.** Signed-URL minting automatic on click;
  upload is manual.
- **Status.** **Shipped.**
- **Source.** `docs/pr-consent-attachments-scope.md`,
  `docs/pr-consent-attachment-ux-scope.md`,
  `src/components/families/ConsentAttachmentSlot.jsx`,
  `src/lib/consentAttachments.js`, `api/consent-attachment-url.js`,
  `supabase/migrations/029_*.sql`, `supabase/migrations/030_*.sql`.

---

## 5. Funding sources & document vault

### 5.1 Funding sources

- **What it is.** A per-child stack of funding source rows (private_pay,
  cdc_scholarship, tri_share, gsrp, head_start, agency_other). Each
  carries its own rules, dates, hours cap, billing basis, and
  type-specific `details` jsonb. **This is the load-bearing data model
  for module activation.**
- **Who uses it.** Provider.
- **How they interact.** Sidebar → `Revenue → Families` → child profile
  → Funding section → `FundingSourceForm` → pick type and fill the
  type-specific fields. The provider's nav bar grows/shrinks as
  funding source types are added/removed (see §6, §7).
- **Automatic vs manual.** Module activation is automatic via
  `getActiveModules()`. Funding source CRUD is manual. Soft-delete via
  `archived_at` only — no hard deletes per `CLAUDE.md` audit-retention
  rule.
- **Status.** **Shipped.**
- **Source.** `docs/funding_source_spec.md`,
  `src/components/funding/FundingSourceList.jsx`,
  `src/components/funding/FundingSourceForm.jsx`,
  `src/lib/modules.js`,
  `supabase/migrations/003_funding_sources.sql`.

### 5.2 Funding document vault

- **What it is.** Per-funding-source document slots for the required
  CDC paperwork (DHS-198 form, enrollment agreement, "other"). Stored
  in the private `funding-documents` storage bucket with owner-only
  RLS. 4-year `retention_until` default. Soft-delete via `archived_at`.
- **Who uses it.** Provider.
- **How they interact.** From a CDC funding source row → "Documents"
  → `FundingDocumentSlot` for each document type → upload a PDF or
  image.
- **Automatic vs manual.** Storage path layout
  (`<user_id>/<funding_source_id>/<uuid>.<ext>`) and retention date
  automatic. Upload is manual. **No delete UI** — soft-delete only
  per audit retention.
- **Status.** **Shipped.**
- **Source.** `src/components/funding/FundingDocumentSlot.jsx`,
  `src/lib/fundingDocuments.js`,
  `supabase/migrations/008_funding_documents.sql`,
  `docs/runbook.md` § "2026-05-13 — Migration 008: funding document
  vault".

---

## 6. CDC programs

Visible only when the CDC module is active — i.e., the provider has
at least one `funding_sources.type='cdc_scholarship'` row or has set
`program_settings.cdc='force_on'`.

### 6.1 CDC Pay Period catalog

- **What it is.** Statewide reference of the 26 biweekly MDHHS CDC pay
  periods per calendar year (2025: 501-526; 2026: 601-626). Each row
  carries period dates, reporting deadline, expected check/EFT date.
  Read-only.
- **Who uses it.** Provider (licensee + adult_staff) with CDC module
  active.
- **How they interact.** Sidebar → `Compliance → CDC Pay Periods`
  (`/cdc-pay-periods`). Sees the schedule for the year, with the
  current pay period highlighted and the next reporting deadline
  surfaced as a count-down.
- **Automatic vs manual.** "Which period are we in?" is automatic
  (date math against the catalog). Everything else is read.
- **Status.** **Shipped.**
- **Source.** `docs/cdc_pay_periods_spec.md`,
  `src/pages/CdcPayPeriodsPage.jsx`, `src/lib/cdcPayPeriods.js`,
  `src/components/cdc/PayPeriodCard.jsx`,
  `src/components/cdc/PayPeriodTable.jsx`,
  `supabase/migrations/010_cdc_pay_period_catalog.sql`.

### 6.2 CDC I-Billing reconciliation

- **What it is.** Four-stage wizard that prepares the data a provider
  enters into MDHHS's external I-Billing portal: pick the pay period,
  review the children × days grid with validation cells, export CSV +
  PDFs, then enter the MDHHS confirmation number to lock the period.
- **Who uses it.** Provider (licensee + adult_staff) with CDC module
  active.
- **How they interact.** Sidebar → `Compliance → CDC I-Billing`
  (`/i-billing`). Stages: `PayPeriodPicker` → `ReviewGrid` (with
  `IssueResolutionModal` for per-cell anomalies) → `ExportPanel`
  (CSV + PDFs) → `ReconcilePanel` (enter confirmation #).
- **Automatic vs manual.** Hours roll-up + validation (10-day absence
  cap, 2016-hour annual cap, etc.) automatic from attendance data.
  CSV + PDF generation automatic. The provider keys the result into
  MDHHS's I-Billing portal manually (the state portal — not in this
  app).
- **Status.** **Shipped.** This is the PR #9 build. The state's
  I-Billing portal itself is NOT integrated by API; we produce the
  data the provider transcribes.
- **Source.** `src/pages/IBillingPage.jsx` (header comment is a
  good summary), `src/lib/iBilling.js`, `src/lib/iBillingExport.js`,
  `src/lib/iBillingPdf.js`, `src/components/iBilling/*.jsx`,
  `docs/pr-9-review.md`.

---

## 7. Compliance

### 7.1 MiRegistry deadline tracker (license-exempt)

- **What it is.** Tracks the December 16 Annual Ongoing Training
  deadline (missing it closes the LEP's CDC account) and the rolling
  Level 1 → Level 2 pay-rate state. Stores the level + expiration as
  transcribed values from the MiRegistry transcript — **MILittleCare
  does not compute them.**
- **Who uses it.** License-exempt provider.
- **How they interact.** Sidebar → `Compliance → MiRegistry`
  (`/miregistry`). Provider enters their MiRegistry ID (activates the
  module if not already), logs training entries via
  `TrainingEntryForm`, updates level via `UpdateLevelModal`
  (transcribes from MiRegistry transcript, doesn't compute).
  `MiRegistryWarningBanner` shows on the dashboard and Families page
  when the December 16 deadline is approaching.
- **Automatic vs manual.** Deadline-countdown banner severity is
  automatic. Level + expiration are transcribed values — entered
  manually. Module activation is automatic when
  `profiles.miregistry_id` is set OR `is_license_exempt = true`.
- **Status.** **Shipped.**
- **Source.** `docs/miregistry_tracker_spec.md`,
  `src/pages/MiRegistryPage.jsx`, `src/lib/miregistry.js`,
  `src/components/miregistry/*.jsx`,
  `supabase/migrations/009_miregistry_training_entries.sql`.

### 7.2 Staff Training tracking (licensed)

- **What it is.** Roster-level compliance matrix for licensed Family
  Home / Group Home providers. Tracks per-caregiver (licensee, co-
  providers, assistants, substitutes) requirements: new-hire 14-topic
  training (R 400.1923), CPR/first aid expiration (R 400.1920/21/24),
  professional development hours (R 400.1924, calendar-year), health
  & safety update acknowledgments (R 400.1924(11)), MiRegistry
  account & verified employment (R 400.1922), background-check
  eligibility (R 400.1919).
- **Who uses it.** Licensee sees the roster; each staff member sees
  their own log.
- **How they interact.** Sidebar → `Compliance → Staff Training`
  (`/staff-training`). Licensee: `StaffComplianceMatrix` (who's
  missing what), `ExpiringSoonList`, drill into one caregiver's
  `CaregiverTrainingLog`, set regulatory roles via
  `RegulatoryRoleAssignment`. Staff: their own log only.
- **Automatic vs manual.** Matrix derivation is automatic via
  `src/lib/staffTraining.js` pure helpers; entries are manual.
  Module activation automatic when
  `profiles.is_license_exempt === false` OR the user appears on
  another provider's `caregivers` roster.
- **Status.** **Shipped.** The page header carries a cutover notice:
  until `ON_FILE_TO_MIREGISTRY_CUTOVER`, verification is on file at
  the home; after that date MiLEAP rules require MiRegistry-verified.
- **Source.** `docs/staff_training_tracking_spec.md`,
  `src/pages/StaffTrainingPage.jsx`, `src/lib/staffTraining.js`,
  `src/components/staffTraining/*.jsx`.

### 7.3 Parent Acknowledgments (provider dashboard for attendance acks)

- **What it is.** Provider-side view of the parent attendance
  acknowledgment system (PR #12): state counts across the last 30
  days, active flag list, override modal for segments the parent
  didn't acknowledge.
- **Who uses it.** Provider (licensee + adult_staff).
- **How they interact.** Sidebar → `Compliance → Parent
  Acknowledgments` (`/acknowledgments`). Sees counts (acknowledged,
  flagged, override, tampered, unacknowledged), opens flag list,
  resolves each via "Edit attendance / Provider explained / Parent
  withdrew flag." Override modal lets the provider attest a segment
  with a required reason.
- **Automatic vs manual.** State derivation
  (`getAcknowledgmentState`) automatic; resolution actions manual.
- **Status.** **Shipped.**
- **Source.** `src/pages/ProviderAcknowledgmentsPage.jsx` (header
  comment is a clean spec summary), `src/lib/parentAcknowledgment.js`.

### 7.4 Compliance Engine — Phase 1 (pure derivation layer)

- **What it is.** A pure JavaScript module (`src/lib/complianceState.js`)
  exporting a 52-row `REQUIREMENT_REGISTRY` and pure verdict
  functions over it. Given source rows, returns per-requirement state
  (`on_file` / `expired` / `missing_required` / `pending_parent` /
  `not_applicable` / `unknown`) + per-child rollup + per-provider
  rollup. The impure loader (`complianceStateLoader.js`) fans out the
  Supabase queries.
- **Who uses it.** **Nobody, directly.** Phase 1 ships **no UI**.
  Existing surfaces (the Families page, the dashboard banners, the
  parent's enrollment-consents panel) do NOT yet read from
  `complianceState.js` — that's Phase 2 (deferred — see §13).
- **How they interact.** No interaction yet. The engine is built and
  tested (1201+ tests, ≥4 per registry row) but dormant from the
  user's perspective.
- **Automatic vs manual.** N/A — pure derivation.
- **Status.** **Shipped — dormant from the UI.** The registry is the
  catalog of every compliance signal the app tracks. Phase 2+ will
  switch consumers over (see §13).
- **Source.** `docs/pr-compliance-engine-scope.md`,
  `docs/pr-compliance-engine-phase-1-scope.md`,
  `src/lib/complianceState.js`,
  `src/lib/complianceStateLoader.js`,
  `src/lib/complianceState.test.js`.

---

## 8. Operations

### 8.1 Attendance

- **What it is.** Daily attendance status per child × day:
  `present`, `absent`, `sick`, `vacation`, `holiday`. In/Out times
  optional. Per-day notes. Week navigator.
- **Who uses it.** Provider. The sidebar config has no explicit
  `roles` array on the Attendance link, so every authenticated
  provider role can navigate to it. **Needs in-product
  verification:** whether server-side write paths are role-gated
  for `view_only` (extrapolated from convention, not confirmed
  against `AttendancePage.jsx`'s save handlers).
- **How they interact.** Sidebar → `Operations → Attendance`
  (`/attendance`). Week grid → click a cell → pick status. Per-day
  sticky-note for notes.
- **Automatic vs manual.** Hours computation from in/out times
  automatic; status assignment is manual. `AttendanceExportButton`
  produces a per-week or per-month export.
- **Status.** **Shipped.**
- **Source.** `src/pages/AttendancePage.jsx`,
  `src/components/ui/AttendanceExportButton.jsx`.

### 8.2 Parent acknowledgment of attendance (daily)

- **What it is.** Parents review and acknowledge each billed
  attendance segment for their family's children. Three states per
  segment: clean acknowledged, flagged (parent dispute), unacknowledged.
  The provider's billing engine reads these state derivations to gate
  whether a segment is billable.
- **Who uses it.** Parent confirms; provider monitors via §7.3.
- **How they interact.** Parent: dashboard banner OR weekly email
  digest → `/parent/acknowledge?tab=attendance` (mobile-first) → card
  per (child × date × segment) → Confirm or Flag (with required
  reason). Confirm writes immediately (no batch submit).
- **Automatic vs manual.** State derivation automatic via
  `getAcknowledgmentState`. Weekly digest cadence configurable per
  provider's `acknowledgment_email_send_day` / `_send_hour`. Digest
  cron currently re-enabled (Vercel Pro reached) per PR #15 Half 2.
- **Status.** **Shipped.**
- **Source.** `src/pages/ParentAcknowledgePage.jsx` (header comment
  is the cleanest spec summary), `src/lib/parentAcknowledgment.js`,
  `api/cron-send-acknowledgment-digest.js`,
  `docs/pr-12-review.md`.

---

## 9. Billing & payments

### 9.1 Private-pay billing (provider-issued invoices)

- **What it is.** Per-family invoice generation against private-pay
  funding sources. Rate-type aware (`hourly` / `daily` / `weekly` /
  `monthly` / `per_session`). Auto-suggests the next invoice period
  based on `invoice_frequency` + `invoice_due_day`.
- **Who uses it.** Provider (licensee + adult_staff).
- **How they interact.** Sidebar → `Revenue → Billing` (`/billing`).
  See per-family invoices, the suggested next period, payment status.
  Send via email (**Needs in-product verification:** Resend is the
  project-wide email provider per `notify-state-change.js`, but the
  exact invoice-send path inside `BillingPage.jsx` was not opened to
  confirm Resend specifically for invoices) or share via copy-link.
  Mark paid for out-of-band methods (cash, check, venmo, zelle,
  other).
- **Automatic vs manual.** Period suggestion + amount computation
  automatic from `getNextInvoicePeriod`/`computeInvoiceAmount`.
  Cron-driven autopay invoice generation (see 9.3) automatic. Sending
  + marking paid are manual.
- **Status.** **Shipped.**
- **Source.** `src/pages/BillingPage.jsx`, `src/lib/billing.js`,
  `src/lib/pricing.js`.

### 9.2 Parent online pay (Stripe)

- **What it is.** Parent pays an invoice with a credit card via
  Stripe Checkout.
- **Who uses it.** Parent.
- **How they interact.** From `/parent` dashboard → invoice card →
  "Pay now" → Stripe-hosted payment surface in a new tab → success
  returns to `/parent?paid=1`. **Needs in-product verification:**
  whether the surface is Stripe Checkout (`api/create-checkout-session.js`)
  or a Stripe Payment Link (`api/create-payment-link.js`) — both
  endpoints exist; `api/parent-pay-invoice.js` was not opened to
  confirm which path it actually invokes.
- **Automatic vs manual.** Stripe session creation
  (`api/parent-pay-invoice.js`) + Stripe webhook
  (`api/stripe-webhook.js`) automatic; the pay click is manual.
- **Status.** **Shipped.**
- **Source.** `api/parent-pay-invoice.js`, `api/stripe-webhook.js`,
  `src/pages/ParentDashboardPage.jsx`.

### 9.3 Autopay enrollment & charges

- **What it is.** Parent enrolls in autopay; the system generates the
  next invoice + charges the saved card weekly via two crons.
- **Who uses it.** Parent enrolls; system charges.
- **How they interact.** Parent: `/parent` → `AutopayEnrollment` →
  "Enroll" → Stripe Setup Intent flow → confirmation. After that,
  invoices auto-generate Mondays 03:00, autopay attempts Mondays
  14:00. Parent can disable from the same surface.
- **Automatic vs manual.** Both crons automatic
  (`/api/cron-generate-autopay-invoices`, `/api/cron-charge-autopay`,
  per `vercel.json`). Enrollment is manual.
- **Status.** **Shipped.**
- **Source.** `src/components/parent/AutopayEnrollment.jsx`,
  `api/create-setup-intent.js`, `api/confirm-autopay-enrollment.js`,
  `api/disable-autopay.js`, `api/cron-generate-autopay-invoices.js`,
  `api/cron-charge-autopay.js`, `docs/runbook.md` § "Vercel cron
  count".

### 9.4 "How Money Works" disclosure

- **What it is.** A plain-English transparency page that explains
  Stripe pricing, what counts toward the FSA statement, and what
  the provider does and doesn't see about parent payment methods.
- **Who uses it.** Provider — informational.
- **How they interact.** Sidebar → `Settings → How Money Works`
  (`/how-money-works`). Read-only.
- **Status.** **Shipped.**
- **Source.** `src/pages/HowMoneyWorksPage.jsx`.

### 9.5 FSA statement (parent)

- **What it is.** Year-end Flexible Spending Account statement for
  the parent — summarizes child care payments per IRS tax-credit
  rules.
- **Who uses it.** Parent.
- **How they interact.** Behavior not clearly specified outside the
  API handler — needs confirmation against the parent UI surface
  where the link is exposed. The handler exists at
  `api/parent-fsa-statement.js`; the parent-side trigger surface
  needs in-product confirmation.
- **Status.** Handler **shipped**; UI surface entry point
  behavior not clearly specified in docs — needs confirmation.
- **Source.** `api/parent-fsa-statement.js` (handler).

---

## 10. Communication

### 10.1 Messages (provider ↔ parent)

- **What it is.** Per-family messaging threads. Provider can include
  photo attachments. Read receipts. Off by default at the provider
  level (`business_policies.messaging_enabled`).
- **Who uses it.** Provider; parent (per family).
- **How they interact.**
  - Provider: enables via a toggle on `Settings → Business Info`
    that writes `business_policies.messaging_enabled = true`.
    Once enabled, sidebar shows `Revenue → Messages`
    (`/messages`). Thread per child or per family with
    `MessageThreadPage`. **Needs in-product verification:** the
    exact tab/section label within Business Info where the
    toggle lives (`BusinessInfoPage.jsx` was not opened far
    enough to confirm the precise click-path string).
  - Parent: `/parent/messages` shows the threads they're party to;
    `/parent/messages/:childId` for thread detail.
- **Automatic vs manual.** Email notification of new messages via
  `api/send-message-notification.js` automatic. Composition manual.
  Sidebar conditionally shows Messages based on the
  `messaging_enabled` toggle (`Sidebar.jsx:56-70`).
- **Status.** **Shipped.**
- **Source.** `src/pages/MessagesPage.jsx`,
  `src/pages/MessageThreadPage.jsx`,
  `src/pages/ParentMessagesPage.jsx`,
  `src/pages/ParentMessageThreadPage.jsx`, `src/lib/messages.js`,
  `api/send-message-notification.js`.

### 10.2 State-change notifications

- **What it is.** A dispatcher that emails the appropriate recipient
  when a meaningful state change happens (allergy update, emergency
  contact change, hours change, rate update, etc.). Each
  notification row in `notification_log` becomes an email via Resend.
- **Who uses it.** System (cron + RPC writers); recipients are
  providers (parent → provider direction) or parents (provider →
  parent direction).
- **How they interact.** No direct UI. The provider's care-critical
  edits in Families page, the parent's edits in My Family page, and
  several SECURITY DEFINER RPCs all write `notification_log` rows;
  the dispatcher reads unread rows and sends.
- **Automatic vs manual.** Automatic on the write path.
- **Status.** **Shipped.**
- **Source.** `api/notify-state-change.js`, `src/lib/notifications.js`,
  `notification_log` table (predates in-tree migrations — see
  `docs/runbook.md` § 2026-06-04 migration 036 entry for the
  authoritative NOT NULL list).

### 10.3 Reminders system (opt-in, multi-category)

- **What it is.** A general-purpose opt-in reminder catalog. Per
  category, the provider opts in, picks a lead time (0/1/7/14/30
  days), and chooses a channel (in-app banner only / email only /
  both). The hourly cron dispatcher fires instances whose trigger
  time has arrived and whose provider has opted in.
- **Who uses it.** Provider configures; the system fires.
- **How they interact.** Sidebar → `Settings → Reminders`
  (`/reminders`). One row per category the provider's
  `license_type` qualifies for (`categoriesForLicenseType`),
  with a toggle, lead-time dropdown, channel dropdown. Optimistic
  save-on-change with rollback on error. In-app banners stack on
  the Dashboard via `ReminderBanners`.
- **Automatic vs manual.** Hourly cron
  (`/api/cron-dispatch-reminders`) automatic. Opt-in is manual.
  **All categories default OFF** except those tagged
  `transactional: true` (the click that creates the instance IS
  the consent — first case: `intake_acknowledgment_pending` per
  PR #16 follow-up; `staff_discipline_policy_ack_pending` is the
  next likely candidate).
- **Status.** **Shipped.**
- **Source.** `docs/pr-15-opt-in-reminder-system-scope.md`,
  `src/pages/RemindersSettingsPage.jsx`,
  `src/lib/reminderCategories.js`, `src/lib/reminderSystem.js`,
  `src/components/dashboard/ReminderBanners.jsx`,
  `api/cron-dispatch-reminders.js`, CLAUDE.md "Reminder categories
  are opt-in by default" bullet.

### 10.4 Legacy dashboard banners (parallel to the host)

- **What it is.** `AnnualTrainingBanner`, `LicenseTypeReviewBanner`,
  `MiRegistryWarningBanner` — three bespoke self-loading dashboard
  banners that pre-date the reminders host and remain mounted
  alongside `ReminderBanners`.
- **Who uses it.** Provider (visible on the Dashboard).
- **How they interact.** Banners appear or disappear based on each
  banner's internal data load.
- **Automatic vs manual.** Automatic.
- **Status.** **Shipped — coexists with the new host pending
  consolidation.** Per `docs/tech_debt.md`, consolidation into the
  host is planned but not blocking PR #15.
- **Source.** `docs/tech_debt.md` § "Legacy dashboard banners
  coexist…", `src/components/dashboard/AnnualTrainingBanner.jsx`,
  `src/components/dashboard/LicenseTypeReviewBanner.jsx`,
  `src/components/miregistry/MiRegistryWarningBanner.jsx`.

---

## 11. Parent portal & self-service

### 11.1 Parent dashboard

- **What it is.** The parent's home page. Shows their families,
  invoices, autopay status, business info (provider hours / closures
  / payment methods), acknowledgment banner for any unacknowledged
  attendance segments, enrollment-consents-pending banner for any
  outstanding intake bundle. Password-set nudge for magic-link-only
  parents.
- **Who uses it.** Parent.
- **How they interact.** `/parent`. Active link via
  `parent_family_links.status='active'`. Pay invoices, view balances,
  jump into acknowledgments, view provider's posted hours/closures.
- **Automatic vs manual.** Data automatic on load. Confirmations
  and pay clicks manual.
- **Status.** **Shipped.** Per `docs/milittlecare-roadmap-2026-05-29.md`
  the password-banner has a known stale-state bug (4b): "shows for
  parents who already have a password" — was on the priority-4 list
  as of 2026-05-29. **Discrepancy flagged in §15.**
- **Source.** `src/pages/ParentDashboardPage.jsx`,
  `src/components/parent/AutopayEnrollment.jsx`,
  `src/components/parent/BusinessInfoSection.jsx`,
  `src/components/parent/AcknowledgmentBanner.jsx`,
  `src/components/parent/EnrollmentConsentsPendingBanner.jsx`.

### 11.2 Parent acknowledgments hub (consolidated)

- **What it is.** One tabbed surface at `/parent/acknowledge` (and
  `/parent/intake-acknowledge`, same component) — Attendance tab
  (the daily ack flow from §8.2) and Intake tab (the intake-bundle
  flow from §4.2). The intake-acknowledge route forces the Intake
  tab to preserve the email CTA `/parent/intake-acknowledge?child=<id>`.
- **Who uses it.** Parent.
- **How they interact.** Email CTA or dashboard banner → lands on
  one of the two tabs → confirms or flags.
- **Status.** **Shipped.** Consolidated surface from PR #16
  follow-up Issue #2.
- **Source.** `src/pages/ParentAcknowledgmentsPage.jsx`,
  `src/App.jsx:88-97`.

### 11.3 Parent self-service: My Family (Phase X — low-risk)

- **What it is.** Parent-side editing of low-risk data they're the
  natural author of: their own contact info, emergency contacts,
  guardians, authorized-pickup list, allergies + medical notes on
  their child, physician + dentist contacts, photo-sharing consent
  (grant/revoke).
- **Who uses it.** Parent.
- **How they interact.** `/parent/family` → tabbed surface; the
  initial tab is `'contact'` per `ParentMyFamilyPage.jsx:26`.
  **Needs in-product verification:** the full tab list (the
  partial code read confirmed the `'contact'` initial state but
  not the complete set of tab keys — the spec implies Contact +
  Children + Guardians + Emergency Contacts, but read the page
  state machine to confirm before quoting in user-facing copy).
  Edits to children's allergies / medical notes route through
  `child_parent_update` SECURITY DEFINER RPC (narrow allowlist of
  columns); photo consent through `parent_photo_consent_set` RPC.
- **Automatic vs manual.** Care-critical change (`allergies` or
  `medical_notes`) fires a `notification_log` row → provider email.
  Per PR migration 036, the notification is now non-fatal to the
  underlying update (a failed notification can't void the medical
  edit). Parents cannot delete anything — RLS lockdown via
  migration 031 + the `block_parent_archive` trigger.
- **Status.** **Shipped** (Phase X, migration 031, merged 2026-06-04).
- **Source.** `docs/pr-parent-self-service-scope.md` § Phase X,
  `src/pages/ParentMyFamilyPage.jsx`,
  `src/lib/parentSelfService.js`,
  `supabase/migrations/031_parent_self_service_phase_x.sql`,
  `supabase/migrations/036_*.sql` (the 036 notification fix).

### 11.4 Parent: view & download records, view consent attachments

- **What it is.** Parents can view their family's existing
  acknowledgments / consent records (history) and download attachments
  via the Edge Function that mints signed URLs.
- **Who uses it.** Parent.
- **How they interact.** `/parent/acknowledge` → consent-history list
  → attachment download link.
- **Status.** **Shipped.**
- **Source.** `api/consent-attachment-url.js`,
  `src/lib/consentAttachments.js`.

### 11.5 Medium-risk e-sign consents (Phase Y1 — DORMANT)

- **What it is.** Parent typed-name e-signature on the three
  licensing-required "written permission" consents: field-trip
  permission, transportation (routine annual + per-trip non-routine),
  water activities (seasonal on-premises + per-trip off-premises).
  Provider opts-in per category in Business settings (default OFF),
  customizes a starter template, sends from a child's record, parent
  types name to sign in the portal. The completed
  `acknowledgments` row (channel `parent_portal_esign`, with
  `typed_signature_text` + `template_snapshot_text` columns) IS the
  compliance evidence artifact, WORM-locked.
- **Who uses it.** Provider would opt-in + send; parent would
  complete. **Today: nobody — Y1 ships the data layer dormant.**
- **How they interact.** **No UI yet.** Y1 shipped the schema +
  three SECURITY DEFINER RPCs (`consent_esign_send`,
  `consent_esign_complete`, `consent_esign_rescind`) + the WORM
  trigger + the supersede-on-template-edit trigger. The Business-tab
  toggles, template editor, provider send modal, and parent
  pending-card are **Y2 — not built** (see §13).
- **Automatic vs manual.** N/A — feature is dormant.
- **Status.** **Shipped — dormant.** All five categories default
  `false` on `profiles.medium_risk_consents_enabled`. The provider
  cannot send because there's no UI. The only callers exercised so
  far are the live-gate manual RPC calls.
- **Source.** `docs/pr-parent-self-service-phase-y-scope.md`,
  `docs/Consents and audit scope Y.md`,
  `supabase/migrations/033_*.sql` through `036_*.sql`,
  `docs/runbook.md` § 2026-06-04 migration 033/034/035/036 entries.

---

## 12. System & cron

### 12.1 Vercel crons

Per `vercel.json` (post-PR #15 Half 2; Vercel Pro is the assumed
plan since 2026-05-27):

1. **`/api/cron-generate-autopay-invoices`** — Mondays 03:00.
   Generates the next-period invoice for autopay-enrolled families.
2. **`/api/cron-charge-autopay`** — Mondays 14:00. Attempts the
   Stripe charge for the invoices generated above.
3. **`/api/cron-send-acknowledgment-digest`** — hourly. Sends weekly
   acknowledgment digests to parents at each provider's configured
   day/hour-of-week. Was disabled while on Vercel Hobby (2-cron
   limit); re-enabled in PR #15 Half 2.
4. **`/api/cron-dispatch-reminders`** — hourly. Reads
   `reminder_instances` ready to fire, checks each provider's per-
   category opt-in preference, dispatches in-app banner and/or
   email per the chosen channel.

Each cron handler verifies a `CRON_SECRET` env var matching the
`Authorization: Bearer …` header before doing work. Required Vercel
env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`. Optional: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
`PUBLIC_APP_URL`.

- **Source.** `vercel.json`, `docs/runbook.md` § "Vercel cron count
  (PR #15 Half 2)".

### 12.2 Stripe webhook

- **What it is.** Inbound webhook from Stripe that updates
  `profiles.subscription_status`, `current_period_end`,
  `cancel_at_period_end` and triggers the appropriate downstream
  state.
- **Source.** `api/stripe-webhook.js`.

### 12.3 Dev-only `window.supabase` console handle

- **What it is.** The authenticated Supabase client is attached to
  `window.supabase` on non-production hostnames only (denylist:
  `milittlecare.com`, `www.milittlecare.com`), so the Y1-style
  authenticated-RPC live-gate testing can run in the browser
  devtools console as the real signed-in user.
- **Who uses it.** Engineers + Seth, during live verification gates.
- **Source.** `src/lib/supabase.js`, `CLAUDE.md` § Engineering
  Discipline rule 3 (the SQL Editor cannot test auth-gated logic).

---

## 13. Planned — not yet built

These appear in scope docs but **do not ship in any user surface
today.** Listed so there's no confusion between what exists and what
is designed.

### 13.1 Compliance Engine Phase 2 — consumer refactor

- **What.** Refactor `ParentEnrollmentConsentsPanel`,
  `EnrollmentConsentsPendingBanner`, and `ChildIntakeModal` to read
  from `complianceState.js` instead of the existing per-domain
  audit-state helpers. Fixes the three parent-view display bugs
  (raw type strings, per-occurrence miscategorization, no per-
  occurrence parent surface) as a side effect of building the
  surfaces correctly.
- **Status.** **Not built.** Phase 2's read-only "per-occurrence
  parent surface" half is also **superseded** by the medium-risk
  e-sign flow (see §11.5 and parent-self-service scope §13).
- **Source.** `docs/pr-compliance-engine-phase-2-scope.md`,
  `docs/pr-parent-self-service-scope.md` decision 13.

### 13.2 Compliance Engine Phase 3 — provider applicability overrides

- **What.** A `compliance_applicability_overrides` table that lets a
  provider mark a requirement `applies` / `does_not_apply` / unset
  for their home (e.g., "we do routine transport"). The pure verdict
  layer already accepts an `overrides: Map` parameter that Phase 1
  passes as empty; Phase 3 fills it from the new table. Zero refactor
  required to the engine.
- **Status.** **Not built.** The clean seam exists; no schema or UI yet.
- **Source.** `docs/pr-compliance-engine-phase-1-scope.md` decision 10.

### 13.3 Compliance Engine Phase 4 — compliance health score

- **What.** A quantified "audit risk" score that consumes the
  registry rollup. **Default OFF per provider** (per `CLAUDE.md`
  domain note — scores can be stressful). Within the score,
  MiRegistry-mirror data inclusion is a per-category sub-toggle
  (default strict — only MILittleCare-owned data counts).
- **Status.** **Not built.**
- **Source.** `CLAUDE.md` § Critical Domain Knowledge ("Compliance
  health score and GSQ readiness are opt-in surfaces, default OFF"),
  the compliance-engine scope outline.

### 13.4 Compliance Engine Phase 5 — GSQ (Great Start to Quality) readiness widget

- **What.** A separate consumer of the same registry data tagged
  `gsq_relevant: true`. Measures the 1-5 star program-quality
  rating's prerequisites. Default OFF.
- **Status.** **Not built.** Registry rows already carry the
  `gsq_relevant` tag.
- **Source.** `CLAUDE.md` § Critical Domain Knowledge ("Audit state
  and GSQ readiness are related but distinct").

### 13.5 Parent self-service Phase Y2 — UI for medium-risk e-sign

- **What.** The Business-tab category toggles, the template editor
  (archive-then-insert; relies on the migration 035 supersede
  trigger), the provider send modal (calls `consent_esign_send`),
  and the parent pending-card on `/parent/acknowledge` (calls
  `consent_esign_complete`). Y1's data layer is locked and ready.
- **Status.** **Not built.** Blocked-by: **finalized template body
  copy from a licensing consultant.** The Y1 seed templates are
  PLACEHOLDER and must NOT ship to providers as final language
  without legal review.
- **Source.** `docs/pr-parent-self-service-phase-y-scope.md` §1.Y2,
  `docs/tech_debt.md` § "Phase Y1 follow-ups — parked items
  (2026-06-04)".

### 13.6 Other PR #17–#21 compliance categories

Per `docs/15-21_Bulk_Scoping.md`:

- **PR #17 — Discipline policy acknowledgments.** Scoped; not yet
  built. Provider posts policy + parent acknowledges receipt at
  intake (and on policy updates).
- **PR #18 — Staff file gaps.** Scoped; not yet built. Extends staff
  training (§7.2) with the harder-to-track items (physician
  attestation, background-check eligibility, MiRegistry membership
  status).
- **PR #19 — Drills + emergency plan.** Scoped; not yet built. Drill
  log per type (fire, tornado, lockdown), drill schedule, emergency
  plan document.
- **PR #21 — Property records.** Scoped; not yet built. Radon
  testing, heating inspection, well/septic if applicable.
- **Sources.** `docs/pr-17-discipline-policy-scope.md`,
  `docs/pr-18-staff-file-gaps-scope.md`,
  `docs/pr-19-drills-emergency-plan-scope.md`,
  `docs/pr-21-property-records-scope.md`.

### 13.7 Tri-Share three-way invoice generator

- **What.** Three-way invoice generation for Tri-Share families
  (employer / state / family). Hub directory + employer billing
  contact integration.
- **Status.** **Deferred indefinitely.** Per
  `docs/funding_source_spec.md` § Roadmap and `CLAUDE.md` Module
  Architecture: revisit when real demand surfaces. CDC reaches ~98k
  Michigan kids; Tri-Share ~1-2k. The data model already exists in
  `funding_sources` (the `tri_share` type, hub linkage, three-way
  split fields). No UI today.
- **Source.** `docs/funding_source_spec.md` § Roadmap.

### 13.8 Branding / white-label

- **What.** Provider business name as portal title (replacing
  hardcoded "MI Little Care"), provider logo upload, "Hosted by"
  attribution, welcome message, event calendar with prep notes,
  expanded photo sharing.
- **Status.** **Not built.** Behind all compliance work in priority.
- **Source.** `docs/milittlecare-roadmap-2026-05-29.md` § Priority 5.

### 13.9 Redetermination-aware CDC authorization tracking

- **What.** A `cdc_authorizations` table attached to CDC-type funding
  sources, tracking each 12-month authorization cycle's DHS-198 source
  document, start/end dates, and redetermination state machine.
  Surfaces "your CDC ends in 30 days" without relying on the
  state's notice.
- **Status.** **Not built.** Named in
  `docs/funding_source_spec.md` § Future, references
  `docs/redetermination-ownership-spec.md` which **does not exist in
  the repo yet** (called out in `docs/pr-16-child-files-scope.md` and
  `docs/backlog.md`). The acknowledgment substrate from PR #16 is
  designed to accommodate the "parent responsibility" ack when this
  ships.
- **Source.** `docs/funding_source_spec.md` § "Future:
  redetermination-aware authorization tracking",
  `CLAUDE.md` § Critical Domain Knowledge (redetermination
  experience bullet).

### 13.10 Reports & Settings pages

- **What.** Currently route to `PlaceholderPages` — they exist as
  placeholders in the router but render placeholder content.
- **Status.** **Placeholder.** Sidebar does not link `/reports` or
  `/settings`; the routes exist but are unreached from the nav.
- **Source.** `src/App.jsx:48-51,138-139`,
  `src/pages/PlaceholderPages.jsx`.

---

## 14. Spec docs consulted

The following spec / runbook / convention docs were read directly to
ground the entries above. Listed alphabetically:

- `docs/architecture.md` *(TBD stub only — does not yet expand on the
  stack)*
- `docs/backlog.md`
- `docs/cdc_pay_periods_spec.md`
- `docs/Compliance and Audit Scope Draft.md`
- `docs/Consent Phase C.md`
- `docs/Consents Attachment Build.md`
- `docs/Consents Phase B Build.md`
- `docs/Consents and audit scope Y.md`
- `docs/findings-operational-protective-consents-2026-05-30.md`
- `docs/funding_source_spec.md`
- `docs/license_status_prompt_spec.md`
- `docs/licensed-home-compliance-audit-2026-05-23.md`
- `docs/licensed-home-compliance-decisions-2026-05-23.md`
- `docs/milittlecare-roadmap-2026-05-29.md`
- `docs/miregistry_tracker_spec.md`
- `docs/onboarding_wizard_spec.md`
- `docs/pr-compliance-engine-scope.md`
- `docs/pr-compliance-engine-phase-1-scope.md`
- `docs/pr-compliance-engine-phase-2-scope.md`
- `docs/pr-consent-attachment-ux-scope.md`
- `docs/pr-consent-attachments-scope.md`
- `docs/pr-consents-A-scope.md`
- `docs/pr-consents-B-scope.md`
- `docs/pr-consents-C-scope.md`
- `docs/pr-12-review.md`
- `docs/pr-14-license-type-foundation-scope.md`
- `docs/pr-15-opt-in-reminder-system-scope.md`
- `docs/pr-16-child-files-scope.md`
- `docs/pr-17-discipline-policy-scope.md`
- `docs/pr-18-staff-file-gaps-scope.md`
- `docs/pr-19-drills-emergency-plan-scope.md`
- `docs/pr-20-medication-log-scope.md`
- `docs/pr-21-property-records-scope.md`
- `docs/pr-9-review.md`
- `docs/pr-parent-self-service-scope.md`
- `docs/pr-parent-self-service-phase-y-scope.md`
- `docs/regulatory-rule-mapping.md`
- `docs/runbook.md`
- `docs/staff_training_tracking_spec.md`
- `docs/strategy.md`
- `docs/tech_debt.md`
- `CLAUDE.md`

Code-side cross-checks:

- `src/App.jsx` — route inventory and the parent-vs-provider tree.
- `src/components/dashboard/Sidebar.jsx` — the canonical nav structure
  + role/module filtering.
- `src/lib/modules.js` — `getActiveModules()` (module activation
  logic).
- `src/pages/*.jsx` — confirmed the click-path for every shipped
  feature.
- `api/*.js` — confirmed the cron + webhook + RPC endpoints.

---

## 15. Spec ↔ code divergences flagged

The following are places where what the spec describes and what the
code or the runbook records aren't fully aligned. Worth surfacing
even though most are minor:

1. **`docs/architecture.md` is a one-line stub.** It promises an
   architecture overview but contains only "TBD: System architecture
   overview…" The conventions live in `CLAUDE.md` and the funding-
   source spec; no separate architecture document exists yet. Not a
   bug — just an unfilled placeholder.

2. **`docs/funding_source_spec.md` § Roadmap and the runbook
   disagree on the GSRP/Head Start status.** The spec carries GSRP
   and Head Start as enum values + module keys, but the roadmap
   defers GSRP to V2 and Head Start is implied-deferred. `modules.js`
   activates the modules if a funding source of those types exists.
   The truth is that the enum + activation work but no UI surfaces
   exist for those funding types beyond the basic `FundingSourceForm`
   stub. Not a discrepancy in code; a "spec describes more than ships"
   situation.

3. **Roadmap doc lists PR #16 parent-home intake banner bug
   (Priority 4a, as of 2026-05-29) as unfixed.** The migration
   history runbook does not record a follow-up fix landing for
   "banner does NOT render on `/parent` home even when the data is
   present." Possible that the consolidated `/parent/acknowledge`
   tabs (PR #16 follow-up Issue #2) made the banner redundant;
   verify in-product before treating either as authoritative.

4. **Roadmap doc lists parent-portal password-banner stale-state bug
   (Priority 4b, as of 2026-05-29) as unfixed.** No corresponding
   commit / runbook entry for a fix. The `ParentDashboardPage`
   code does carry a `checkHasPassword(session.user.id)` call
   (line ~94) and a `bannerDismissed` localStorage key
   (`mlc_pw_banner_dismissed_v1`) — so SOME state is checked.
   Whether it correctly suppresses the banner for parents who have
   already set a password needs in-product confirmation. Behavior
   not clearly specified vs spec; needs live verification.

5. **FSA statement (§9.5) — UI surface not documented.** The
   handler `api/parent-fsa-statement.js` exists but the
   trigger-from-the-parent-UI path isn't documented in any spec
   doc reviewed. Worth confirming whether this is exposed on
   `/parent` today and, if so, where.

6. **`docs/redetermination-ownership-spec.md` is referenced but
   missing.** Named in `docs/funding_source_spec.md` § Future and
   in `docs/pr-16-child-files-scope.md` (cross-PR constraint B).
   Per `CLAUDE.md` it's "named in `docs/backlog.md`" — but the
   spec file itself doesn't exist in the repo as of 2026-06-05.
   Not a bug; documentation gap.

7. **`docs/strategy.md` path quirk.** Per
   `docs/onboarding_wizard_spec.md`, the strategy doc "currently
   lives at the mis-nested path `docs/docs/strategy.md` — a pre-
   existing repo quirk, noted, out of scope here." Verify the
   current location before linking it from anywhere new.

8. **`src/ReceiptsPage.jsx` lives at `src/` root, not
   `src/pages/`.** Called out in `CLAUDE.md` File Structure note
   as "should eventually move into src/pages/. Not urgent." Not
   a bug; cosmetic file-organization debt.

9. **Three legacy dashboard banners coexist with the
   `ReminderBanners` host.** Per `docs/tech_debt.md`, this is
   intentional during the consolidation transition; the legacy
   banners do more than render (self-load data, embed bespoke
   behavior). A provider may see both the legacy
   `AnnualTrainingBanner` and a new `ReminderBanners` entry for
   the same MiRegistry deadline. Acceptable for V1 per the
   tech-debt entry.

10. **Compliance Engine Phase 1's `not_yet_modelled` requirements.**
    Per `docs/pr-compliance-engine-phase-1-scope.md` decision 8,
    the registry includes rows for drills, property records,
    discipline policy, physician attestation, and religious-
    objection statements that all return
    `{ kind: 'unknown', reason: 'feature-not-yet-shipped' }`. So
    the catalog deliberately covers more than the app currently
    captures. Not a divergence; a designed feature of Phase 1's
    catalog-is-canonical posture.
