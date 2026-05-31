Half 2 implementation prompt

Implement Half 2 of PR #15 (opt-in reminder system) — the UI, dispatcher cron, and Vercel cron wiring. Half 1 is shipped (migration 023 applied to production and verified; lib foundation merged to main at 852a48f). This is the second and final pass for PR #15.
Authoritative spec: docs/pr-15-opt-in-reminder-system-scope.md (on main). Read it first. Half 1's artifacts on main are the foundation you build on:

src/lib/dates.js — date helpers (extracted)
src/lib/reminderCategories.js — the frozen catalog
src/lib/reminderSchedule.js — nextOccurrence, shouldRemindNow, addMonthsYMD, addYearsYMD
src/lib/reminderSeverity.js — getSeverity, getSeverityForDueDate, DEFAULT_SEVERITY_THRESHOLDS, SEVERITIES
src/lib/reminderSystem.js — getReminderSystemAuditState
supabase/migrations/023_reminder_system.sql — applied; reminder_preferences + reminder_instances tables, reminder_instance_dismiss() and reminder_instance_resolve() RPCs

Branch:
git checkout main
git pull
git checkout -b feature/pr-15-half-2
Scope of THIS pass (Half 2):
1. Module gating — src/lib/modules.js
Add MODULE_KEYS.REMINDERS = 'reminders'. Activate when license_type IS NOT NULL (any provider with a confirmed license type — family_home, group_home, or license_exempt — can configure reminders). The CDC/LEP categories in the catalog gate further at the per-category level via license_type_gating. Update src/hooks/useActiveModules.js to read the new key. Update src/lib/modules.test.js accordingly.
2. Hooks
src/hooks/useReminderPreferences.js (new). Loads the current user's reminder_preferences rows. Returns { preferences, byCategory, update(category, patch), enable(category), disable(category), loading, error }. Single round-trip on mount; writes upsert one row at a time. Toggle-off flips enabled = false (do not delete the row — preserves the configured lead_time_days + channel for re-enable).
src/hooks/useActiveReminders.js (new). Loads active reminder_instances for the current provider — rows where dismissed_at IS NULL AND resolved_at IS NULL AND archived_at IS NULL AND fired_at IS NOT NULL. Returns { instances, loading, error, dismiss(id), resolve(id) }. The dismiss and resolve methods call the SECURITY DEFINER RPCs (reminder_instance_dismiss, reminder_instance_resolve) via Supabase's rpc() client method.
3. Settings page — src/pages/RemindersSettingsPage.jsx (new)
Lists every category from REMINDER_CATEGORIES filtered by the current user's license_type (via categoriesForLicenseType selector from reminderCategories.js). Each row:

Toggle (enabled/disabled) — enable(category) / disable(category) from the hook
Lead-time dropdown (0 / 1 / 7 / 14 / 30 days) — update(category, { lead_time_days })
Channel dropdown (in_app / email / both) — update(category, { channel })
Inline help: description from the catalog entry

Default for newly-toggled-on categories: lead_time_days: 7, channel: 'in_app' (from the catalog's default_lead_time_days).
Save-on-change with optimistic UI + rollback on error. Empty state when no categories are gated active for the user's license_type. Match the visual style of other settings surfaces in the app (look at existing src/pages/Business*Page.jsx or similar for the pattern).
Route: /reminders or /settings/reminders — wire it through src/App.jsx or wherever routes are defined. Sidebar nav entry under "Settings" gated on MODULE_KEYS.REMINDERS.
4. Banner host — src/components/dashboard/ReminderBanners.jsx (new)
Reads useActiveReminders(). Renders one stacked banner per active instance. Each banner:

Severity-tinted background via reminderSeverity.getSeverityForDueDate(due_at, today) or the cached instance fields
Icon (per-category, look up from catalog or use a default)
title as headline; body as supporting text
CTA button ? cta_path (uses react-router-dom Link or navigate)
Dismiss × button ? calls dismiss(instance.id)

Mount on src/pages/DashboardPage.jsx between the existing LicenseTypeReviewBanner and TodayWidget. The legacy bespoke banners (AnnualTrainingBanner, LicenseTypeReviewBanner, MiRegistryWarningBanner) stay in place per OQ4 resolution — V1 keeps them stacked alongside the new host. A follow-up PR will consolidate.
5. Example category scheduler — src/lib/schedulers/miregistryAnnualTrainingScheduler.js (new)
Implements the contract that future per-category schedulers (PR #18 CPR, PR #19 drills, PR #21 radon/heating) will follow. For each opted-in LEP provider with miregistry_annual_training enabled:

Compute next December 16 deadline from miregistry_training_entries
Check if a reminder_instance already exists for (provider_id, 'miregistry_annual_training', null, null, trigger_at) — skip if so
Insert one if not, with title, body, cta_path = '/miregistry', trigger_at = deadline - lead_time_days

Export a scheduleMiregistryAnnualTrainingReminders(supabaseClient, today) function. The existing AnnualTrainingBanner stays in place; the new scheduler writes parallel instances that the new banner host renders, providing the template for future schedulers.
6. Dispatcher cron — api/cron-dispatch-reminders.js (new)
Hourly Vercel cron handler. Pattern: read existing crons in api/ (especially api/cron-send-acknowledgment-digest.js) to match auth + Resend + notification_log write conventions.
For each pending reminder_instances row where trigger_at <= now() AND fired_at IS NULL AND resolved_at IS NULL AND archived_at IS NULL:

Join to reminder_preferences for the matching (provider_id, category).
If no preference row ? skip (default OFF).
If preference.enabled = false ? skip.
Compose surface per preference.channel:

'in_app' or 'both': just set fired_at = now() on the instance (the banner host queries active instances and renders).
'email' or 'both': call Resend with title as subject, body + deep-link CTA as body; write a notification_log row matching PR #12's schema (change_type = 'reminder_<category>'); set fired_at = now() and fired_via = preference.channel.


Failures: leave fired_at null so next tick retries. Drop or archive instances older than 7 days from created_at.

Auth: cron secret in Vercel env var (CRON_SECRET); verify on every request (match the existing crons' pattern).
Call scheduleMiregistryAnnualTrainingReminders at the top of the dispatcher run so the V1 example scheduler runs hourly. Future per-category schedulers (PR #18-#21) plug in the same way.
7. Re-enable the ack-digest cron — vercel.json
The existing api/cron-send-acknowledgment-digest.js was disabled from vercel.json's crons array per docs/tech_debt.md 2026-05-22 (Hobby 2-cron limit). Vercel Pro is now active. Add two entries to the crons array:

Re-enable cron-send-acknowledgment-digest (recover its original schedule from docs/tech_debt.md or PR #12 history — hourly).
Add cron-dispatch-reminders — hourly schedule, path /api/cron-dispatch-reminders.

Post-deploy cron count = 4 (autopay-invoices, autopay-charge, ack-digest, reminder-dispatch). Within Pro's allowance.
8. Tests

useReminderPreferences.test.js — mock Supabase client; verify load, update, enable, disable.
useActiveReminders.test.js — mock client; verify load, dismiss (RPC call), resolve (RPC call).
miregistryAnnualTrainingScheduler.test.js — pure unit test for the next-deadline computation + idempotency (re-running doesn't double-insert).
cron-dispatch-reminders.test.js — mock Supabase + Resend; verify pref-off skips, channel routing, fired_at write, notification_log write.
Smoke test (manual, document in halt summary): insert a manual reminder_instances row via the Supabase web SQL Editor; run the dispatcher locally (or wait for the hourly Vercel cron after deploy); confirm the fired_at and notification_log rows land.

9. Documentation

Append to docs/runbook.md — short entry under Migration Application Procedure (NOT a new migration entry; PR #15 Half 2 is code-only) noting Half 2 added two crons to vercel.json and the Vercel Pro upgrade prerequisite was satisfied 2026-05-27 (per chat history).
Append to docs/tech_debt.md — note that the bespoke legacy banners (AnnualTrainingBanner, LicenseTypeReviewBanner, MiRegistryWarningBanner) coexist with the new ReminderBanners host in V1; consolidation is a follow-up PR.

Operating rules:

Do NOT touch migration 023 — it's already applied to production. If Half 2 needs additional schema (it should NOT), stop and ask before authoring a new migration.
Plain ASCII in any doc edits (the encoding lesson from prior sessions).
Build incrementally and commit at logical checkpoints (suggested grouping: module gating + hooks / settings page / banner host / scheduler + dispatcher / vercel.json / tests / docs). If the session is interrupted mid-build, progress is preserved per checkpoint.
Run npx vitest run and npm run build before halting; both must be green.
Stay on feature/pr-15-half-2. Push but do NOT open a PR or merge.

Halt criteria:
When all Half 2 items are built, tests + build are green, and the branch is pushed, halt with:

Branch name and commit list
Files created / modified
Test results (counts, pass/fail)
The exact vercel.json diff (specifically what was added to crons)
Confirmation that legacy banners (AnnualTrainingBanner, LicenseTypeReviewBanner, MiRegistryWarningBanner) were NOT modified — they coexist with the new host
Confirmation that migration 023 was NOT modified
A short note on anything you had to decide that the scope or this prompt left open
Smoke test instructions for the user (how to insert a test reminder_instances row and verify it surfaces correctly)

Do NOT deploy. Do NOT open a PR. The user reviews the branch, then applies the vercel.json change and deploys themselves.