# Road to Publishable

The single view of what stands between MILittleCare today and a public launch
to paying providers. Built by reconciling `docs/backlog.md`,
`docs/tech_debt.md`, `docs/runbook.md`, and every `docs/pr-*-scope.md`
against actual code on `main` (`0dd4c02`).

The bucketing is gating-order:

1. **Launch-blocking** — correctness & trust. Stuff that's wrong, broken, or
   unsafe if a paying provider hits it today.
2. **Core features** — the product promise. Stuff the app doesn't deliver
   on without.
3. **Completeness** — required but not blocking day-one. Compliance rows
   still pending implementation.
4. **Branding** — the three-bucket split.
5. **Deferred / housekeeping** — debt, hygiene, and risks below the
   launch-decision line.

Each item carries: one-line description, **verified current status** (from
the reconciliation pass below), dependencies, and a rough size (S / M / L /
project). Items needing a regulatory or business call rather than code are
tagged **[DECISION — Seth]**.

A **RECONCILIATION GAPS FOUND** section at the bottom lists every place a
tracking doc disagreed with the code — these need fixing so the tracking
files become trustworthy again.

---

## 1. Launch-blocking — correctness & trust

### 1.1 ESLint configuration is missing — `npm run lint` errors out
- **Status:** **REAL.** `package.json:lint` calls `eslint .` but there is
  no `.eslintrc*` or `eslint.config.*` file at the repo root. The script
  exits with a config error rather than running. Caught across multiple
  sessions; never fixed.
- **Why it gates launch:** the `--max-warnings 0` posture is the project's
  pre-merge safety net. With the runner broken, every PR ships unlinted.
- **Dependencies:** none.
- **Size:** S (one config file matching the React + JSX rules already
  referenced in CLAUDE.md).

### 1.2 Stripe subscription loop has ZERO automated coverage
- **Status:** **REAL — present but untested.** The webhook exists at
  `api/stripe-webhook.js` (287 lines, handles `checkout.session.completed`,
  `customer.subscription.updated/created/deleted`, `invoice.payment_failed/
  succeeded`). `useSubscription` reads `subscription_status`, `trial_*`,
  `current_period_end`, `cancel_at_period_end`, `stripe_*`, `comped` from
  `profiles`. Tests directory has tests for `consent-attachment-url.js`
  and `cron-dispatch-reminders.js` — **none for `stripe-webhook.js` or
  any auth/onboarding page.** A regression in the access-grant loop would
  ship silently.
- **Why it gates launch:** this is the path from "stranger gives a card" to
  "stranger has access." Untested is not the same as broken, but it's
  unverified, and the only catch today is Seth eyeballing his test
  Stripe events.
- **Dependencies:** none (covered surfaces already exist).
- **Size:** M (one happy-path integration test per webhook event type +
  the trial-vs-paid useSubscription state matrix).

### 1.3 Recent migrations applied to production but NOT recorded in the runbook
- **Status:** **REAL — three migrations.** 038 (`compliance_documents`
  store), 039 (`property_*` document_type CHECK extension), 040
  (`compliance_documents.next_due_on`) were all applied to production per
  session evidence (G4 fingerprint live-gated, property J1/J2/J8 batch
  live-gated, cycle dates live-gated). **None of them appear in
  `runbook.md` Migration History or Pending Application.** Same shape as
  the 026/028 drift from 2026-06-10 that triggered a wasted apply
  investigation; the runbook process note ("promote in the SAME session as
  the apply") was added to prevent exactly this, then broken twice.
- **Why it gates launch:** the database is the source of truth (rule 1 from
  CLAUDE.md), but the runbook is the **operational** source of truth. A
  future "apply 038" investigation will start from "Pending Application
  shows nothing for 038, so it's not applied," and any rollback or
  cross-environment reconstruction reads the runbook first.
- **Dependencies:** none — pure documentation.
- **Size:** S (three History entries with verification queries).

### 1.4 Parent portal — Set-a-password banner may fire spuriously
- **Status:** **LIKELY REAL — needs a 5-minute trace.**
  `ParentDashboardPage.jsx:415` —
  `showPasswordBanner = hasPassword === false && !bannerDismissed`. Feeds
  from `setHasPassword(!!data?.has_password)`. If the
  `parent_profiles.has_password` column was added later and the backfill
  didn't run, existing parent rows show `null` → `!!null = false` → banner
  fires for every legacy parent regardless of whether they've actually set
  a password. The reported symptom ("password-banner firing wrongly") fits.
- **Dependencies:** none.
- **Size:** S (verify schema state of `has_password` column on
  `parent_profiles`; backfill or change the comparison to `=== false`
  with explicit null-handling).

### 1.5 Parent portal — Intake-pending banner not showing
- **Status:** **UNCLEAR — needs trace.** The intake-pending surface is
  driven by `intake_acknowledgment_pending` reminder rows and PR #15's
  opt-in reminder system (default OFF unless category is `transactional`).
  Per CLAUDE.md, `intake_acknowledgment_pending` was added as a transactional
  category in the PR #16 follow-up. If the category catalog has it marked
  non-transactional, the dispatcher silently skips providers who haven't
  opted in. The reported symptom matches a missing `transactional: true`
  flag or a stale `enabled = false` preference row.
- **Dependencies:** none.
- **Size:** S (audit `reminderCategories.js`, confirm the catalog entry +
  default-opt-in shape).

### 1.6 Migration 014 and 015 stuck on "PENDING PRODUCTION APPLICATION"
- **Status:** **DRIFT — unverified.** `runbook.md:703` shows 014
  (`profiles.terms_accepted_at`) and `:782` shows 015
  (`015_security_hardening`) as PENDING PRODUCTION APPLICATION. But
  `backlog.md:17-25` lists 015 as **Resolved 2026-05-19** with
  dashboard-step confirmation. 014's status is silent in backlog. If 014
  is unapplied, the Terms-acceptance audit trail isn't recording — every
  new signup that goes through the legal-pages flow may rely on a missing
  column.
- **Why it gates launch:** legal exposure if terms-acceptance is the basis
  for any T&C dispute. Plus more runbook drift in the same migration-status
  pattern as 1.3.
- **Dependencies:** none.
- **Size:** S (a `to_regclass / information_schema.columns` query for the
  terms_accepted_at column + runbook reconciliation).

---

## 2. Core features — the product promise

### 2.1 Audit Packet Generator (originally "PR #11")
- **Status:** **NOT BUILT.** No `src/components/audit/` directory, no
  `AuditPacket` components, no `audit_packets` table in
  `supabase/migrations/`. Backlog mentions it as an unscheduled
  post-#21 item; this is the artifact the auditor-portal (2.2) is
  meant to expose.
- **Why it's core:** "audit readiness" is one of two product wedges
  (the other is CDC redetermination ownership). Without a packet
  generator, MILittleCare's audit value is "you can find evidence in
  our app" — not "we hand you the artifact." The competitive moat is
  Michigan-rule-shaped packaging.
- **Dependencies:** the audit-state helpers from PRs #15-#21 (most
  partially in place via `complianceState.js`'s row resolvers and the
  37 registered requirement keys).
- **Size:** **project** (data model for stored packets + a PDF / ZIP
  generator + UI to pick the date range + RLS).

### 2.2 Auditor Read-Only Portal (the "future PR #13" entry in backlog)
- **Status:** **NOT BUILT.** No `AuditorPortal*` page, no
  `audit_sessions` / `audit_access_grants` tables. The backlog entry
  notes the historical "PR #13" label collided with the children
  archived_at PR; this is the unscheduled post-#21 auditor portal.
- **Why it's core:** lets a real MDHHS auditor open a time-limited
  share link, see read-only attendance / T&A acks / training /
  DHS-198, without granting full-app access. Becomes critical the
  first time a provider faces an audit.
- **Dependencies:** **depends on 2.1** (the packet is what the
  auditor reads).
- **Size:** **project** (share-link auth model, RLS or service-role-
  scoped read endpoints, audit-of-the-audit logging, UI).
- **[DECISION — Seth]** Auth model (share-link vs temp account vs in-
  app passcode), scope (per-family vs full-roster), access duration
  default, what gets logged.

### 2.3 Intake packet — DISPLAY GROUPING (the collapsed-rows half)
- **Status:** **CAPTURE BUILT, DISPLAY NOT.** Migration 041 +
  `src/lib/intakePackets.js` ship the write side: a packet creates ack
  rows tagged with `packet_id`. The compliance checklist still renders
  every covered element as its own row — there's no "this packet
  covers the next 7 rows" collapse. Stated explicitly in the 041
  commit message and the scoping report as a follow-up PR.
- **Why it's core:** the wall of 8+ separate green/red rows per child
  is the visible reason the per-element model is inferior to a "I
  signed one packet" model. Capture without display is half a
  feature.
- **Dependencies:** 041 applied to production (currently NOT applied
  — see RECONCILIATION GAPS).
- **Size:** M (loader reads `intake_packets` table, ChecklistRow
  consumes a packet_id signal, copy decisions for the collapsed-row
  state).

### 2.4 PR #22 — Compliance Health Score
- **Status:** **NOT BUILT.** Zero `complianceHealthScore*` /
  `ComplianceHealthScore*` / `audit_risk` artifacts in `src/`.
  Backlog has the full design (opt-in, Type 1 / Type 2 split,
  consumes audit-state helpers).
- **Why it's core:** the differentiating "you're at audit risk"
  signal that CCHIRP and Brightwheel don't produce. The audit
  packet (2.1) tells you what you have on file; the health score
  tells you whether what you have is enough.
- **Dependencies:** all of PRs #15-#21 must have shipped (PR #22
  consumes their audit-state helpers). The compliance engine
  registry is in place; what's not in place are the per-helper
  pure functions the score aggregates.
- **Size:** M (per backlog: read-only aggregator + UI widget + a
  small preferences row mirroring PR #15).

### 2.5 CDC Redetermination Ownership — Phase 1 (Authorization tracking)
- **Status:** **NOT BUILT.** Spec is in `backlog.md` (lines 86-119,
  five-phase plan). No `redetermination*` artifacts in `src/`.
- **Why it's core:** customer-validated #1 pain (three Facebook
  threads, ~10 unique respondents). "We don't get notified that
  their case is cut off until we bill and DON'T get paid." This
  is the strongest current product wedge, validated, grounded in
  state docs, not addressed by competitors.
- **Dependencies:** PRs #14 + #16 (both shipped).
- **Size:** M (Phase 1 alone — DHS-198 capture, computed window,
  dashboard view). Phases 2-5 are M-L each.
- **[DECISION — Seth]** Is this in scope for the v1 launch, or is
  it the post-July headline feature it's currently sequenced as?

---

## 3. Completeness — required but not blocking day-one

These are compliance rows the engine currently emits as
`feature_not_yet_shipped` (per `patternENotYetModelled` in
`complianceState.js:356`). The app launches without them — the
guidance copy honestly says "keep paper records" — but each is a
real R 400 obligation.

### 3.1 PR #18 — Staff file gaps (E7 / E8 / E9)
- **Status:** **NOT BUILT, blocked on substrate extension.**
  Three rows: `caregiver_physician_attestation_annual`,
  `caregiver_discipline_policy_ack_at_hire`,
  `caregiver_daily_arrival_departure`. All resolve to
  `patternENotYetModelled`. The first two are document-shaped but
  need `compliance_documents.subject_caregiver_id` (the substrate
  doesn't have per-caregiver scoping today) — flagged as deferred
  in the J1/J2/J8 batch's Step 0 report.
- **Dependencies:** migration extending `compliance_documents` with
  a nullable `subject_caregiver_id` column + RLS revisit.
- **Size:** M (migration + slot-routing extension + per-caregiver
  resolver).

### 3.2 PR #19 — Drills + emergency response plan
- **Status:** **NOT BUILT.** Four rows: `drill_fire_quarterly`,
  `drill_tornado_seasonal`, `drill_other_emergencies_annual`,
  `emergency_response_plan_on_file`. All Pattern E. The first
  three are dated LOGS (not documents); the fourth is a single
  static doc that could ship via the same compliance_documents
  pattern as J1/J2/J8 — flagged as the next clean addition in
  039's commit message.
- **Dependencies:** drill rows need a `drill_logs` data model;
  emergency_response_plan can extend the existing
  `compliance_documents` CHECK.
- **Size:** M (drills capture surface + log model) + S
  (emergency_response_plan slot).

### 3.3 PR #21 — Non-document property rows (the OUT half of the J1/J2/J8 batch)
- **Status:** **NOT BUILT, intentional.** Five rows: CO detectors
  per level, smoke detectors per floor, fire extinguishers per
  floor, animal notification, smoking prohibition posted. The
  J1/J2/J8 batch's Step 0 classified each as NOT-DOCUMENT
  (inventory / per-parent / attestation) so they didn't fit the
  `compliance_documents` substrate.
- **Dependencies:** new data model per row (inventory table per
  property, a per-parent animal-notification ack like the existing
  consent shape, a boolean attestation for smoking prohibition).
- **Size:** M (each row is small individually, but together they're
  a coherent "property attestations" capture surface).

### 3.4 G4 Fingerprint reprint freshness
- **Status:** **HALF-BUILT.** G4 swapped its resolver to
  `buildComplianceDocResolver('fingerprint_reprint')` in plain mode
  (commit `e064b54`). Plain mode is existence-only — a 6-year-old
  uploaded receipt still reads on_file. Cycle tracking
  (`requiresDueDate` mode used by radon/heating) is a known
  follow-up.
- **Dependencies:** add `requiresDueDate: true` to the fingerprint
  config + the slot already supports the date input.
- **Size:** S.

### 3.5 emergency_response_plan as a `compliance_documents` row
- **Status:** **NOT BUILT, FLAGGED.** Same shape as J8 licensing
  notebook — single static document, no cycle. The 039 commit
  message explicitly named it as a clean future addition.
- **Dependencies:** none (one-line CHECK extension + one config
  entry + one slot consumer).
- **Size:** S.

### 3.6 PR #17 — Standalone discipline-policy receipt at hire
- **Status:** **PARTIAL.** The intake-bundle sub-row
  (`discipline_policy_receipt`) ships via `ACK_TYPES.DISCIPLINE_POLICY_RECEIPT`
  in PR #16. The STANDALONE staff discipline policy ack
  (`STAFF_DISCIPLINE_POLICY_RECEIPT`) is enumerated in the catalog
  (`acknowledgments.js:71`) but no capture UI exists. Blocked on the
  same per-caregiver substrate as PR #18.
- **Dependencies:** same as 3.1.
- **Size:** S (once 3.1 lands, this is a slot config + a Staff
  Training surface consumer).

---

## 4. Branding — the three-bucket split

The decision split Seth already made (captured here so it persists out
of session memory):

### 4a. Active portal bug fixes
- **Status:** carried forward as 1.4 and 1.5 above. Same items; the
  branding lens is "before we promote the public URL, the parent
  portal shouldn't have visible bugs."
- **Dependencies:** none.
- **Size:** S each.

### 4b. Cheap near-term — surface existing `daycare_name` in parent-portal header
- **Status:** **NOT BUILT.** Per session notes, the `daycare_name`
  field already exists in the email-sender fallback path. Reading
  it on the parent dashboard and showing it as a header would let
  every provider's portal feel marginally branded without any
  storage / upload work.
- **Dependencies:** none — pure UI consumption of an existing column.
- **Size:** S.

### 4c. Full white-label — logo upload, storage, settings UI, attribution decision
- **Status:** **NOT BUILT.** Post-deadline, its own scope doc.
  Carries the business call about how prominent
  "Powered by MI Little Care" stays.
- **Dependencies:** new bucket, settings UI, every provider-facing
  surface needs the logo slot.
- **Size:** **project**.
- **[DECISION — Seth]** Attribution prominence ("Powered by MI
  Little Care" footer / nothing / opt-in-per-tier). This is a
  pricing-tier decision more than an engineering one.

---

## 5. Deferred / housekeeping

### 5.1 `.git` directory on OneDrive sync — known risk
- **Status:** **REAL.** Working tree is at
  `C:\Users\smdom\Documents\milittlecare\` which is OneDrive-
  synced. Git pack/index corruption risk if OneDrive touches the
  `.git/` directory mid-operation. No incidents yet in session
  history, but multiple sessions have noted it.
- **Dependencies:** none.
- **Size:** S (move repo out of OneDrive, OR add `.git` to
  OneDrive's exclude list — the latter doesn't move history).

### 5.2 Stray untracked working-tree files
- **Status:** **REAL.** `git status` consistently shows multiple
  untracked files that have lingered across many sessions:
  `docs/migration-apply-runbook-026-030.md`,
  `docs/runbook-correction-026-028.md`, `f-file.`, plus the
  encoding-mangled `"taged is what you expect. Then…"` file. The
  last one is especially worth investigating — its name suggests
  truncated terminal output that landed in the working tree.
- **Dependencies:** none.
- **Size:** S (`git status`, decide each file's fate, `git rm` or
  `git add` accordingly, OR add to `.gitignore`).

### 5.3 a11y gaps in ChildForm + a few other forms
- **Status:** **REAL — partially noted in `tech_debt.md`.** The
  ChildForm inputs lack `htmlFor` / `id` pairing (only 2 in
  `FamiliesPage.jsx`; the rest of the form is unlabeled at the AT
  layer). Documented in the B1/B2 commit on `feature/child-record-fields`
  but never fixed. Similar gap likely on other older forms.
- **Why it's not launch-blocking:** sighted-user UX works. But
  accessibility audits and screen-reader providers will trip.
- **Dependencies:** none.
- **Size:** S (label-input pairing pass across `FamiliesPage`,
  `ChildIntakeModal`, `EnrollmentConsentsModal`).

### 5.4 Migration 028 trigger function — rule-4 trailer drift
- **Status:** **REAL — known harmless.** The
  `medication_event_caregiver_role_check()` trigger function in
  production lacks the canonical revoke/grant trailer (the trailer
  was added to the 028 file in commit `50407ff` after 028 was
  already applied; file edits don't re-run applied migrations).
  Practical exposure is nil because trigger functions have no
  PostgREST RPC surface, but documented in `tech_debt.md:986-`.
- **Dependencies:** none.
- **Size:** S (a tiny CREATE OR REPLACE FUNCTION follow-up migration
  with the trailer — do NOT re-run all of 028).

### 5.5 G4 / `getFingerprintReprintState` dead code
- **Status:** **REAL.** `lib/cdcProviderCompliance.js:161` exports
  `getFingerprintReprintState`. Confirmed dead at the import-graph
  level — only its own test file imports it. No component /
  scheduler / page pulls it in. Mentioned as a future cleanup in
  commit `e064b54`. `complianceStateLoader.js:142`'s SELECT still
  requests `profiles.fingerprint_date` — also a dead read.
- **Dependencies:** none.
- **Size:** S (drop the function + test + loader column + 018's
  column comment — eventually the column itself).

### 5.6 Migrations folder out-of-sync with production schema
- **Status:** **REAL — long-standing.** Documented in
  `tech_debt.md:56-` since 2026-05-13. ~25 tables exist in
  production with no in-tree migration file (parent_profiles,
  message_threads, families, autopay_charges, etc.). The repo's
  `001_profiles.sql` + `002_receipts.sql` cannot rebuild a clean
  env.
- **Why it's not launch-blocking:** production works; the bootstrap
  gap only hurts dev-env reproduction.
- **Dependencies:** none.
- **Size:** L (`pg_dump --schema-only` + diff + retroactive
  migration files).

### 5.7 Documentation lag in `backlog.md` and `tech_debt.md`
- **Status:** **REAL.** Backlog lists PR #15-#21 as "Scope
  authoritative on main" without any SHIPPED markers, even though
  PR #14 (`SHIPPED 2026-05-26`), #16 (mig 024 in History), #20
  (mig 028 in History) clearly shipped. The audit-of-the-audit is
  this file; the docs themselves need an update.
- **Dependencies:** none.
- **Size:** S (apply this doc's Step 2 findings to `backlog.md` +
  add a "Shipped" column to the PR table).

### 5.8 Legacy dashboard banners coexist with the new ReminderBanners host (PR #15 Half 2)
- **Status:** **REAL.** `tech_debt.md:3-16`. Three legacy banners
  (`AnnualTrainingBanner`, `LicenseTypeReviewBanner`,
  `MiRegistryWarningBanner`) coexist with the new host until
  per-banner schedulers exist for fingerprint reprint + license-
  type review.
- **Dependencies:** none beyond writing the schedulers.
- **Size:** M.

### 5.9 Vercel cron count + Hobby-plan ack-digest gate (resolved per backlog)
- **Status:** **RESOLVED.** Backlog notes the Pro upgrade
  happened 2026-05-27, the digest cron is re-enabled. Listed
  here for completeness so it's not re-flagged later.
- **Dependencies:** none.
- **Size:** done.

---

## RECONCILIATION GAPS FOUND

These are places the tracking docs disagreed with the code on `main`
(`0dd4c02`). Fix the docs before launch so the tracking files become
trustworthy again. None of these require code changes.

### G1 — Migrations 038, 039, 040 are applied in production but absent from `runbook.md`
- **What:** `grep "Migration 038\|Migration 039\|Migration 040"
  docs/runbook.md` → zero hits. No History entries, no Pending
  Application entries. Per session evidence, all three were
  applied (G4 fingerprint slot live-gated, J1/J2/J8 property batch
  live-gated, radon/heating cycle dates live-gated).
- **Fix:** add three History entries — column shapes / CHECK
  definitions / new RLS policies all already verified during their
  respective live-gates, so the Phase B verification queries from
  each file's header are the canonical screenshots.
- **Process recurrence:** this is the third time the "promote in
  the same session as the apply" runbook rule has been violated.
  026 and 028 in 2026-06-10 was the first; 027 was the second; now
  038/039/040.

### G2 — Migration 041 not in Pending Application
- **What:** 041 (`intake_packets`) was written and pushed in the
  most recent intake-packet PR, explicitly NOT applied. The runbook
  has no Pending Application entry for it.
- **Fix:** add a Pending Application entry with the 7-query
  verification block from the file header. (Or simply note that
  the file is the authoritative reference until applied.)

### G3 — Migration 014 status conflict
- **What:** `runbook.md:703` shows 014 (`profiles.terms_accepted_at`) as
  PENDING PRODUCTION APPLICATION. `backlog.md` is silent on it. PR #14
  ("SHIPPED 2026-05-26") refers to mig 022 (`license_type`), not 014 —
  the labels collide.
- **Fix:** verify whether `profiles.terms_accepted_at` exists in
  production (`information_schema.columns` query). Promote to
  History or confirm pending.

### G4 — Migration 015 status conflict
- **What:** `runbook.md:782` shows 015
  (`015_security_hardening.sql`) as PENDING PRODUCTION APPLICATION.
  `backlog.md:19-25` lists it as **Resolved 2026-05-19**.
- **Fix:** verify against the live database (`pg_proc` for the
  function `search_path` changes, `pg_policies` for the SECURITY
  DEFINER revokes). Promote to History or correct the backlog.

### G5 — `backlog.md` PR table has no Shipped column
- **What:** the PR #13-#21 table at `backlog.md:62-73` shows every
  row as "Scope authoritative on main" with no SHIPPED markers,
  even though #13/#14/#15/#16/#20 are demonstrably shipped on
  main.
- **Fix:** add a Shipped column with the merge commit short-hash
  for each. PRs #17/#18/#19/#21 remain unshipped (see Section 3
  above) — mark accordingly.

### G6 — "Future PR #13 — Auditor Read-Only Portal" label still ambiguous
- **What:** the backlog still uses "PR #13" for the auditor portal
  despite acknowledging the historical collision ("the historical
  'PR #13' label here predated the current numbering scheme").
  Other places in the docs (`docs/Compliance and Audit Scope
  Draft.md`, this file at 2.2) refer to it as a post-#21 unscheduled
  item.
- **Fix:** rename the backlog entry to drop the PR# and adopt
  "Auditor Portal" as the canonical label.

### G7 — `tech_debt.md` lacks an entry for the 038-or-later compliance_documents drift
- **What:** the substrate (`compliance_documents`), 4 document
  types in the CHECK (`fingerprint_reprint`, `property_radon_test`,
  `property_heating_inspection`, `property_licensing_notebook`),
  the `next_due_on` column, and the resolver swap for G4 all
  shipped without a `tech_debt.md` entry capturing the known
  follow-ups (G4 cycle tracking, the per-caregiver substrate
  extension for PR #18, the dead `getFingerprintReprintState`
  helper).
- **Fix:** one consolidated entry capturing all three follow-ups
  with their commit refs.

---

## Quick reference — sizes summary

| Bucket | S | M | L / project |
|---|---|---|---|
| 1. Launch-blocking | 1.1 ESLint • 1.3 runbook entries • 1.4 password banner • 1.5 pending banner • 1.6 014/015 status | 1.2 Stripe coverage | |
| 2. Core features | | 2.3 Display grouping • 2.4 Health score • 2.5 Redetermination Phase 1 | 2.1 Audit Packet • 2.2 Auditor Portal |
| 3. Completeness | 3.4 G4 cycle • 3.5 ERP doc row • 3.6 PR #17 standalone | 3.1 PR #18 staff • 3.2 PR #19 drills • 3.3 PR #21 non-doc property | |
| 4. Branding | 4a portal bugs • 4b daycare_name surface | | 4c full white-label |
| 5. Housekeeping | 5.1-5.5, 5.7 | 5.8 banner consolidation | 5.6 schema dump-and-retroactive |

**The launch-blocking column collapses to one M + five S.** That's the
practical threshold question: when those seven items are done, the
product is shipped-correctness-clean. The core-features column is the
"is this v1 even the v1 we want to charge for" question — and 2.5
(redetermination) is the live customer-validated wedge that backlog
already named as the post-July headline.
