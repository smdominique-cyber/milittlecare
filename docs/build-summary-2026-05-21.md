# Build Summary — 2026-05-21

End-of-session consolidation across the five PRs built and applied this cycle. All five migrations are live in production as of the user's verification at the start of this session; the application code lives on five branches awaiting review-then-merge in numerical order.

> **Status snapshot.** Branches: `schema/capture-existing-production-tables` · `feature/cdc-authorization-typing-pr-8-5b` · `feature/provider-cdc-billing-settings-pr-8-5c` · `feature/i-billing-transfer-pr-9` · `feature/parent-acknowledgment-pr-12`. None merged to main yet. Per-PR review docs: `docs/pr-8-5a-review.md`, `docs/pr-8-5b-review.md`, `docs/pr-8-5c-review.md`, `docs/pr-9-review.md`, `docs/pr-12-review.md`. Migrations 016–020 applied to production via Supabase dashboard; schema state matches branch state on all five.

---

## What landed in each PR

### PR #8.5a — Schema capture (`schema/capture-existing-production-tables`)

Migration **016** captures the existing production-only schema for the five out-of-band tables the app was already using: `children`, `families`, `guardians`, `emergency_contacts`, `attendance`. Their `CREATE TABLE` definitions had never lived in `supabase/migrations/`; they were created early via the Supabase dashboard and the codebase's migration history did not reflect them. PR #8.5a closes that gap. Also adds `guardians.archived_at` with the matching `idx_guardians_family_active` partial index. 40 RLS policies enumerated.

### PR #8.5b — CDC typing + lifecycle expansion (`feature/cdc-authorization-typing-pr-8-5b`)

Migration **017** promotes 14 CDC-related fields from `funding_sources.details` JSON into typed columns: `authorization_start`, `authorization_end`, `case_number`, `approved_hours_per_period`, `family_contribution_amount`, `billing_basis`, `shared_provider`, `shared_provider_notes`, etc. Backfill is in the same migration — `NULLIF` only on the text columns (case_number, billing_basis, shared_provider_notes); direct cast on dates/numerics/booleans. Adds `idx_funding_sources_cdc_active_by_end_date`. Expands the `funding_source_status` enum by 4: `pending`, `expired`, `terminated`, `renewed`. The codebase still reads via the typed-columns-first / JSON-fallback pattern (`src/lib/cdcAuthorization.js`) so pre-PR #8.5b rows continue to render correctly.

### PR #8.5c — Provider CDC billing settings (`feature/provider-cdc-billing-settings-pr-8-5c`)

Migration **018** adds 4 CDC billing columns to `profiles`: `bridges_provider_id` (7-digit `CHECK`), `provider_type` (CHECK enum), `care_location` (CHECK enum), `fingerprint_date`. Mid-session, also absorbed 6 PR #12 acknowledgment-settings columns (`acknowledgment_cadence`, `acknowledgment_strictness`, `acknowledgment_email_enabled`, `acknowledgment_email_send_day`, `acknowledgment_email_send_hour`, `acknowledgment_email_timezone`) — moved from migration 020 to 018 so they live with the rest of the provider-profile config columns. PR #12's migration only adds parent-acknowledgment-table-side columns now.

### PR #9 — I-Billing transfer & reconciliation (`feature/i-billing-transfer-pr-9`)

Migration **019** is purely additive on top of the production tables:

1. **Multi-segment attendance.** `attendance.segment_index integer not null default 0`; the existing `(child_id, date)` unique constraint is dropped via `pg_constraint` introspection (the production table was created out-of-band so the constraint name varies) and replaced with `(child_id, date, segment_index)`. Index `attendance_user_date_idx` for the common pay-period query.
2. **`cdc_billing_submissions`** — immutable submission records (no DELETE policy, no `archived_at`). One row per `(provider_id, pay_period_number)`. Carries a `attendance_snapshot_jsonb` so an MDHHS-discrepancy investigation months later can replay exactly what was submitted.
3. **`attendance_validation_overrides`** — append-only audit log of provider overrides on validation rules. Carries `rule_id`, `rule_description`, `override_reason` (required free text), and the optional `attendance_id` / `child_id` it applies to.
4. **School-schedule fields on `children`** — `school_enrolled`, `school_name`, `school_bell_schedule_json` for Rule 6 (billing during school hours).

The application code adds:

- **11-rule validation engine** (`src/lib/iBilling.js`) implementing the CDC LEP Handbook rules — pay-period hours cap, fiscal-year absence cap, consecutive-absence-days cap, concurrent-children cap, billing outside authorization, billing during school hours, overnight not split, missing parent initials (acknowledgment-aware), missing provider name, submission window expired, billing without active CDC.
- **CSV export builder** (`src/lib/iBillingExport.js`) — Format 3, one row per child-day-segment, 15 columns including `validation_flags`.
- **Two PDF builders** (`src/lib/iBillingPdf.js`) — Transfer Sheet (portrait, IN1/OUT1/IN2/OUT2 grid) and Official MiLEAP T&A Record (landscape, 14-row daily grid). T&A PDF pre-fills the Parent Initials column from `attendance_acknowledgments` (PR #12 wiring landed in step 3 of this session): child initials for clean ack, `(override)` for provider attestation, `(re-ack needed)` for tampered, `(awaiting)` for unacknowledged.
- **Five-stage wizard** at `/i-billing`:
  - **Screen 1** PayPeriodPicker — lists candidate periods overlapping any CDC funding source; status-ranked (open_for_billing > current > closed); shows "Already submitted" badge for reconciled periods.
  - **Screen 2** ReviewGrid — children × days table; per-cell worst-severity colouring; per-child + per-day + grand totals; provider-level issue banner; "Continue to export" disabled while any blocking issue exists.
  - **Screen 3** IssueResolutionModal — modal opened from any cell with issues; per-issue Apply Proposed Fix (one-click supabase mutation) OR Override with Note (writes to `attendance_validation_overrides`). The four fix kinds: `remove_segment`, `split_at_midnight` (multi-segment safe), `trim_school_hours` (4 sub-cases including the brackets-school split), `provider_override_acknowledgment` (writes to `attendance_acknowledgments` with `acknowledged_via='provider_override'`).
  - **Screen 4** ExportPanel — CSV + Transfer Sheet PDF + Official T&A PDF download buttons; "Open MDHHS I-Billing in a new window" launcher; numbered walkthrough copy explaining the two-window pattern.
  - **Screen 5** ReconcilePanel — confirmation-number entry; writes one immutable row to `cdc_billing_submissions` with `attendance_snapshot_jsonb`; re-renders in locked state with a CheckCircle2 affordance and the lock icon.

### PR #12 — Parent acknowledgment via portal + Resend (`feature/parent-acknowledgment-pr-12`)

Migration **020** adds two tables and one parent-profiles column:

1. **`attendance_acknowledgments`** — one row per `(child_id, date, segment_index)` (optionally also `attendance_id` for direct linkage). Carries `acknowledged_via` (`'parent_portal'` or `'provider_override'`), `attendance_snapshot_hash` (FNV-1a 32-bit hex string), `acknowledged_by_guardian_id` (nullable), and `archived_at` for soft delete.
2. **`acknowledgment_flags`** — one row per parent-flagged segment; carries `resolution_action` enum (`'edited'`, `'attested'`, `'archived'`).
3. **`parent_profiles.acknowledgment_email_opt_in`** boolean — parents who opt out get no digest emails.

Provider settings (acknowledgment_cadence / strictness / send_day / send_hour / timezone / email_enabled) live on `profiles` per migration 018.

Application code:

- **Pure helpers** in `src/lib/parentAcknowledgment.js`: `computeAttendanceHash` (FNV-1a 32-bit, synchronous, browser/Node identical), `canonicalAttendanceForHash`, `findActiveAcknowledgment`, `findActiveFlag`, `getAcknowledgmentState` (5 states), `getDaysAwaitingParentReview`, `countAcknowledgmentStates`. 31 unit tests + 10 smoke-test phases.
- **Email digest helpers** in `src/lib/acknowledgmentDigest.js` — `shouldSendDigestNow` (TZ + DST + day-of-week with en-US midnight quirk normalised), `digestDateRange`, `buildDigestEmail` (subject/text/HTML).
- **Vercel cron handler** `api/cron-send-acknowledgment-digest.js` — scheduled `0 * * * *` (hourly). Writes one row per fired provider to the existing production `notification_log` table using its real schema (`recipient_type='parent'`, `change_type='acknowledgment_digest'`, `email_sent boolean`, `metadata jsonb`).
- **Parent acknowledgment portal** at `/parent/acknowledge` — week view, per-segment Confirm / Flag actions, email opt-in toggle.
- **Provider acknowledgment dashboard** at `/acknowledgments` — 5-state count strip, active-flags list with resolve modal (3 actions), unacknowledged-segments list with override modal, SettingsCard for the 6 provider acknowledgment fields.
- **Rule 8 upgrade in `src/lib/iBilling.js`** (this session's step 6) — replaces the warning-only single provider-level Rule 8 with one issue per billed segment that is not cleanly acknowledged. Severity driven by `profiles.acknowledgment_strictness`: `warning` (default) or `blocking` (strict mode). Tamper detection via `computeAttendanceHash`. Lives on the PR #9 branch via cherry-picked `parentAcknowledgment.js`; identical content on PR #12 branch makes the eventual merge a no-op.

---

## Production migration application notes

Two surprises landed mid-session; both are now documented as conventions for the next migration.

### Surprise 1 — `CREATE POLICY IF NOT EXISTS` is not valid Postgres syntax (migration 016)

Migration 016 originally used `CREATE POLICY IF NOT EXISTS "name" ON public.table ...` for each of its 40 RLS policies. The first production apply failed with `ERROR: 42601: syntax error at or near "not"` because Postgres supports `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` but **not** `CREATE POLICY IF NOT EXISTS`.

**Fix.** Wrote a small Node script (`scripts/fix-create-policy-if-not-exists.cjs`, since deleted) that rewrote every policy block as `DROP POLICY IF EXISTS "name" ON public.table; CREATE POLICY "name" ON public.table ...`. Verified 0 remaining bad-syntax matches before re-applying. The DROP/CREATE pattern is idempotent: applying twice is a no-op on the second run.

**Carry-forward.** Future migrations creating policies use the DROP/CREATE pattern. Noted in `docs/tech_debt.md` and the convention is now in `CLAUDE.md` for next-Claude / next-Seth.

### Surprise 2 — `notification_log` table pre-existed with a different schema (migration 020)

Migration 020 originally created a fresh `notification_log` table to hold acknowledgment-digest send records. Production already had a `notification_log` table backing `api/notify-state-change.js` — different schema (recipient_type/recipient_id pair, change_type, change_description, changed_by_user_id, changed_by_role, family_id, child_id, email_sent boolean, email_sent_at, email_id, metadata jsonb).

**Fix.** Removed the `CREATE TABLE` / indexes / RLS / policy blocks from migration 020 (replaced with a doc-only stub explaining why). Rewrote `api/cron-send-acknowledgment-digest.js` so its insert payload matches the production schema. Added the `metadata.delivery_status` enum to preserve the more granular outcome that the existing boolean can't carry.

**Carry-forward.** Discovery queries (the user's pre-build dashboard checks) now include a "check table name availability" step — before declaring a new table in a migration, confirm no existing object owns the name. The convention is in `docs/tech_debt.md`.

---

## Decisions made under uncertainty

These are decisions made without round-tripping to Seth (per the user's "no clarifying questions mid-build" rule). Each is recorded in the per-PR review doc; this section is the consolidated map.

| Decision | Choice | Why |
|---|---|---|
| `annual_training_completion_date` column reuse | **Option 2** — keep column dormant per PR #4's deprecation; caller queries `miregistry_training_entries WHERE source='annual_ongoing'` instead | The deprecation rationale (transaction-log source of truth, MiRegistry transcript handling) is still right; un-deprecating would have re-introduced the inconsistency PR #4 was built to remove. Banner queries the entries table directly. |
| `notification_log` reuse | **Reuse existing table**; map cron handler payload to production schema | Creating a parallel "notifications_v2" table fragments where audit trail searches go. The existing schema already covers what we need (recipient_type, change_type, email_sent, metadata.delivery_status enum carried in jsonb). |
| Cron infrastructure | **Vercel cron** (`vercel.json`), not `pg_cron` | Same pattern as existing crons (`cron-generate-autopay-invoices`, `cron-charge-autopay`). Keeps cron orchestration in app code where it's reviewed alongside the logic; the DB never has to know about scheduling. |
| Hash function for tamper detection | **FNV-1a 32-bit** (synchronous, deterministic, browser/Node-safe) over SHA-256 | The threat model is honest-edit detection, not cryptographic integrity. A malicious provider with DB access could rewrite the hash anyway. Synchronous FNV avoids `crypto.subtle.digest` async overhead in the validation hot path. 8-char hex output. |
| Migration ordering | **016 → 017 → 018 → 019 → 020** | Each migration is additive on top of the production tables; pairwise order-independent. The numerical order is the dashboard apply order Seth used. |
| Strict-mode default | **`warning` (not `strict`)** on `profiles.acknowledgment_strictness` | Strict mode blocks I-Billing exports until every day is acknowledged. Defaulting to strict for existing providers would surprise-block their billing on day 1; default to warning, let providers opt into strict. |
| PR #9 / PR #12 branch separation | `parentAcknowledgment.js` cherry-picked onto PR #9 branch so Rule 8 can import the hash function. Identical content on PR #12 branch makes the merge a no-op. | Merge order is PR #9 (019) before PR #12 (020). PR #9 needs to be self-contained — it can't import from a file that won't exist on main until PR #12 also merges. |
| T&A PDF parent-initials display | **Day-level cell**, worst-state-collapse across segments (`awaiting` > `re-ack` > `override` > `clean`) | The MiLEAP form has one Parent Initials column per day, not per segment. A multi-segment day where one segment is awaiting and another is acknowledged-clean displays `(awaiting)` since the parent still needs to confirm the unacked segment. |
| `attendance_validation_overrides` issue suppression | UI **filters** issues whose `(rule_id, child_id)` matches an active override row; audit row stays for compliance | Cleanest V1 — no validation-engine change required. The override is an audit fact, not a permanent silence. On a refresh, the issue would re-fire from raw validation; the orchestrator's `overrideIndex` re-filters it. |

---

## Outstanding follow-up PRs

These were identified during this session and are tracked in `docs/tech_debt.md`:

1. **FK index cleanup.** The Supabase performance advisor flagged several foreign keys without their own indexes (e.g. `cdc_billing_submissions.provider_id` is covered by the unique constraint but not directly; `attendance_validation_overrides.attendance_id` is uncovered). Low-impact for the volumes at this stage, but worth a dedicated migration once the V1 indices stabilise.
2. **`attendance.checked_in_by` CHECK rewrite.** The column accepts free text today; spec called for an enum constraint. PR #8.5a captured the production state as-is rather than altering the type. A follow-up migration can rewrite via a 4-step pattern (add new column → backfill → swap → drop old).
3. **Parent-portal expansion.** `/parent/acknowledge` ships a week view in V1. Future iterations: per-child sub-view, range picker for historical lookback beyond the 30-day banner window, multi-child households, push notifications instead of email digest.
4. **School-calendar integration.** Rule 6 (billing during school hours) reads `children.school_bell_schedule_json` today. Future PR: auto-populate from a published Michigan public-school calendar API so providers don't have to transcribe bell schedules by hand. School holidays / snow days handled via the override-with-note path in V1; a calendar feed would let Rule 6 auto-skip those days.
5. **Pixel-match the MiLEAP T&A printed form.** Current PDF is a "draft layout — verify against MiLEAP form before audit use." Layout matches the form's structure but not its visual identity. A follow-up PR could either bring in the actual MDHHS PDF as a background and overlay form fields, or do a pixel-level redesign once we have a clean copy of the form.
6. **Discrepancy detection for `cdc_billing_submissions`.** `payment_received_amount` / `payment_received_date` / `discrepancy_notes` columns exist on the table for future use. A follow-up PR could surface period-history with a discrepancy banner when the EFT lands and the amount doesn't match `total_billed_amount_estimate`.
7. **`src/lib/dates.js` extraction.** Multiple files duplicate the `todayYMD` / `daysBetweenYMD` / `addDaysYMD` helpers. Tracked in `docs/tech_debt.md`. Cosmetic; the duplication isn't blocking anything.
8. **Daily-cadence digest test coverage.** Smoke test exercises weekly. Daily cadence (cron decides on every hour, sends if `now.hour === provider.send_hour`) is unit-tested at the `shouldSendDigestNow` level but not in the lifecycle walkthrough.

---

## Smoke-test results

See `docs/pr-12-review.md` § "Step 9 — Smoke test results (2026-05-21)" for the per-phase table. Summary:

- **10 phases** of the parent-acknowledgment lifecycle exercised on synthetic Venessa + Mia + Erin fixture.
- All 10 phases pass via `src/lib/parentAcknowledgment.smoke.test.js`.
- 6 pieces remain on the manual-verification list (Resend delivery, cron schedule firing, RLS in production, dashboard render, settings round-trip, notification_log row layout). Each is enumerated in the review doc with the exact verification step.

Full test suites at the end of this session:
- PR #8.5a branch: 13 files / 357 tests (carried forward)
- PR #8.5b branch: same
- PR #8.5c branch: same
- PR #9 branch: **16 files / 456 tests** (includes 5 new T&A PDF parent-initials tests)
- PR #12 branch: **12 files / 367 tests** (includes the 10-phase smoke test)

All green across all five branches.

---

## Recommended merge order

Per migration numerical order (lowest first), matching the production apply order:

1. `schema/capture-existing-production-tables` → main (016 lands)
2. `feature/cdc-authorization-typing-pr-8-5b` → main (017 lands)
3. `feature/provider-cdc-billing-settings-pr-8-5c` → main (018 lands)
4. `feature/i-billing-transfer-pr-9` → main (019 + I-Billing wizard lands)
5. `feature/parent-acknowledgment-pr-12` → main (020 + parent portal lands)

PR #9 carries a copy of `parentAcknowledgment.js`; PR #12 carries the same file. Step 5's merge sees identical content for that file → no conflict. Same for the `iBilling.js` Rule 8 changes — they only live on PR #9 (where the test coverage lives) since the helper they call lives on both branches.

After merge: `npm run build` should produce a clean prod build; `npx vitest run` should report **≥ 456 tests** passing (PR #12's smoke test brings that to ~466 after both branches land). Deploy to Vercel; the new `/i-billing` route, `/acknowledgments` route, `/parent/acknowledge` route, and `cron-send-acknowledgment-digest` cron all activate at deploy time.

---

*End of session, 2026-05-21.*
