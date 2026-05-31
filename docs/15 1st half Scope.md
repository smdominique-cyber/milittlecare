Implement Half 1 of PR #15 (opt-in reminder system) — the database and pure-logic foundation. This is the first of two passes; the UI, cron, and email wiring come in a separate Half 2 pass and are explicitly OUT OF SCOPE here.
Authoritative spec: docs/pr-15-opt-in-reminder-system-scope.md (on main). Read it first. All open questions in that doc are RESOLVED — follow the resolutions as written.
Branch:
git checkout main
git pull
git checkout -b feature/pr-15-reminder-system
Scope of THIS pass (Half 1 only):

Migration 023 — supabase/migrations/023_reminder_system.sql plus the migrations-for-deploy/ copy per house pattern. Two tables (reminder_preferences, reminder_instances), the indexes, and RLS exactly as specified in scope § A. Before writing, verify the latest migration number in supabase/migrations/ is actually 022 (per the table-name-availability convention); if a higher number exists, use the next available and note it. Do NOT run or apply the migration — that's the user's manual step. Just author the file.

For OQ3 (subject_type CHECK vs free-text): you decide at implementation time per the resolution. Document your choice in the migration header comment with a one-line rationale.
Include the commented down-migration per house pattern.
RLS: provider-scoped SELECT/UPDATE. INSERT on reminder_instances is service-role-only. Provider UPDATE limited to dismissed_at / resolved_at. The scope recommends a SECURITY DEFINER RPC for the provider-side dismiss/resolve updates — author that RPC in this migration too, since it's pure DB.


src/lib/reminderCategories.js — the frozen REMINDER_CATEGORIES catalog. Populate EVERY entry from scope § B.1 with full metadata (key, label, description, default_lead_time_days, license_type_gating, subject_type when always bound, optional severity_thresholds). The category names are load-bearing and referenced by PRs #16-#21 — use the exact strings in the scope doc. Include the commented-out future placeholders (cdc_redetermination, billing_overdue) as documentation.
src/lib/dates.js — extract the shared date helpers (todayYMD, daysBetweenYMD, and whatever else cdcProviderCompliance.js currently holds inline that the reminder helpers need). Update cdcProviderCompliance.js to import from the new dates.js rather than defining them inline. This is the standing tech-debt extraction the scope flags — do it cleanly, keep cdcProviderCompliance.js behavior identical (its existing tests must still pass unchanged).
src/lib/reminderSchedule.js — pure scheduler helpers: nextOccurrence(rule, today) covering the three recurrence shapes (every-N-months, seasonal-window, annual), and shouldRemindNow(due_at, lead_time_days, today). today is always a parameter for deterministic tests.
src/lib/reminderSeverity.js — generalize cdcProviderCompliance.js's severity ladder (info/warning/urgent/critical/expired) so any category gets the same treatment. Per-category override via the catalog's optional severity_thresholds.
src/lib/reminderSystem.js — the getReminderSystemAuditState(licenseeId) audit-state helper, per scope § B.3a signature. Read-only, single round-trip. (It queries the new tables; since the migration won't be applied yet, the helper just needs to be correct against the schema — it won't be exercised live until Half 2.)
Tests:

reminderSchedule.test.js — all three recurrence shapes + shouldRemindNow across various lead_time_days (recent, never, on-the-cusp).
reminderSeverity.test.js — ladder thresholds.
Confirm the existing cdcProviderCompliance tests still pass after the dates.js extraction.



OUT OF SCOPE for this pass (Half 2 — do NOT build):

useReminderPreferences, useActiveReminders hooks
RemindersSettingsPage.jsx, sidebar nav, MODULE_KEYS.REMINDERS
ReminderBanners.jsx host
api/cron-dispatch-reminders.js and any vercel.json changes
The miregistry_annual_training example scheduler
Dispatcher tests, end-to-end smoke
Re-enabling the ack-digest cron

Do not touch vercel.json at all in this pass.
Operating rules:

Do NOT apply or run migration 023. Author the file only. The user applies and verifies it manually in the Supabase dashboard before Half 2 (per CLAUDE.md schema-verification rule).
Do not modify production. No migrations run.
Plain ASCII in any doc edits (the CLAUDE.md / runbook encoding lesson from prior sessions).
One logical commit, or a small number (e.g. migration / lib / tests). Your call.
Run npx vitest run and npm run build before halting; both must be green.
Stay on feature/pr-15-reminder-system. Push the branch but do NOT open a PR or merge.

Halt criteria:
When all Half 1 items are built, tests + build are green, and the branch is pushed, halt with:

Branch name and commit list
The migration number used + your OQ3 subject_type decision and rationale
Files created/modified
Test results (counts, pass/fail)
Confirmation that existing cdcProviderCompliance tests still pass after the dates.js extraction
A short note on anything you had to decide that the scope left open
Explicit confirmation that vercel.json was NOT touched and the migration was NOT applied

Do NOT proceed to Half 2.