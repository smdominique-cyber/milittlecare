# PR #15 — Opt-in Reminder System: Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` §§ OQ4 + Updated
PR sequence): build the opt-in reminder system as a foundation PR
**before** the six compliance category PRs (#16–#21). Channels: in-app
banners **and** email — **both are V1 scope** (post-review decision; not
a follow-up). All reminders opt-in per category, all defaults OFF,
configurable lead time, per-channel selection (in-app only / email only /
both).

**Vercel Pro is assumed active** by the implementation pass. PR #15 ships
two cron entries in the same deploy: **re-enables**
`/api/cron-send-acknowledgment-digest` (disabled in `vercel.json` per
`docs/tech_debt.md` 2026-05-22) and **adds**
`/api/cron-dispatch-reminders`. Total Vercel cron count post-deploy = 4.

**Cross-PR constraint A (general-purpose):** the reminder system must
serve **arbitrary** reminder types — not just licensed-home compliance.
Post-July, the same infrastructure must carry CDC redetermination
reminders, "remember to bill" reminders, MiRegistry deadline reminders,
funding-source-expiration reminders, and other non-compliance use cases
without schema refactor. The data model must accommodate this from day one
(`category` + `subject_id` discriminator pattern below).

PR #15 blocks PRs #19 (drill due dates), #20 (medication scheduling — to a
lesser extent), and #21 (radon/heating recurring-due). PR #18 reuses it
for CPR/First Aid/physician-attestation expirations. PRs #16 and #17 may
optionally use it for annual review prompts but do not depend on it.

Rule citations use the `R 400.19xx` style per
`docs/regulatory-rule-mapping.md`. The reminder system itself has no
single rule citation — it is enabling infrastructure for the rules that do.

---

## 0. Headline findings (drive the whole plan)

1. **The banner pattern already exists and is excellent — generalize, don't
   reinvent.** `src/lib/cdcProviderCompliance.js` has pure
   `date → {severity, label, daysUntilDeadline}` helpers
   (`getAnnualTrainingDeadlineState`, `getFingerprintReprintState`) with an
   `info / warning / urgent / critical / expired` severity ladder, fed into
   self-loading React banners (`AnnualTrainingBanner.jsx`,
   `MiRegistryWarningBanner.jsx`) that stack on `DashboardPage` and in the
   Families modal. PR #15 lifts this shape into a reusable
   `complianceReminders.js` and a generic `ReminderBanner` host. Every
   future category-specific helper plugs into the same banner.

2. **The email channel exists but is dormant.** PR #12's
   `api/cron-send-acknowledgment-digest.js` is fully implemented but
   **removed from `vercel.json`'s `crons` array** because the project is
   on **Vercel Hobby (2-cron limit)** and both slots are already taken
   (`docs/tech_debt.md` 2026-05-22). Decisions § OQ4 says **Vercel Pro
   upgrade happens this week**, removing the cap; PR #15 re-enables the
   ack-digest cron AND adds the reminder dispatcher cron in the same
   deploy. Per `notification_log` (production-only table per
   `tech_debt.md`), the log/sent-receipt substrate already exists; PR #15
   reuses it.

3. **The reminder-type schema is the load-bearing decision.** Per
   constraint A, the table must support both compliance (one-shot:
   "tornado drill due", "physician attestation expires") and
   non-compliance (recurring: "weekly bill reminder"; relational:
   "redetermination window opens for child X on date Y") with no schema
   churn. The design below uses a `(category, subject_type, subject_id,
   trigger_at)` quad — flexible enough to bind a reminder to any of
   children, funding_sources, caregivers, profiles, or arbitrary URLs.
   Scheduling logic is per-category code, not stored in the table — the
   row only holds the next trigger time.

4. **Two distinct concepts must not be conflated: "what I want to be
   reminded about" (preference) and "the actual scheduled fire"
   (instance).** A provider opting into "drill reminders" is a preference;
   the fact that "fire drill #4 due 2026-08-12" is a scheduled instance.
   PR #15 has both tables; the cron dispatcher reads instances filtered by
   preferences. This separation is what lets the same provider have, e.g.,
   four pending fire-drill reminders without four toggle rows.

5. **Vercel cron capacity decision is locked.** Per OQ4: Pro upgrade
   removes the 2-cron limit. PR #15 ships **one new cron**
   (`/api/cron-dispatch-reminders`, hourly) regardless. After Pro
   re-enables the ack-digest cron, total cron count is three —
   well within Pro's allowance.

---

## Step 2 — Inventory of what exists

### Banner pattern (the reuse target)

- `src/lib/cdcProviderCompliance.js` — pure helpers. Severity ladder
  constant `TRAINING_LADDER`. Returns
  `{ severity, label, daysUntilDeadline }` or `null`. `today` is a
  parameter for deterministic tests.
- `src/components/dashboard/AnnualTrainingBanner.jsx` — self-loading
  banner. Fetches `profiles.is_license_exempt` to gate, then
  `miregistry_training_entries` for the data, then calls
  `getAnnualTrainingDeadlineState`. Renders a severity-tinted banner with
  `SEVERITY_STYLES` lookup.
- `src/components/dashboard/LicenseTypeReviewBanner.jsx` (PR #14) — second
  instance of the self-loading pattern, with an embedded auto-opening
  modal. Newer pattern; PR #15's host can subsume both.
- `src/components/miregistry/MiRegistryWarningBanner.jsx` — third
  instance, surfaced in the Families modal (per-family fetch — flagged in
  `tech_debt.md` as a future shared-context fix).
- Banner stack lives on `DashboardPage.jsx` between `InstallBanner` and
  `TodayWidget` (post-PR-14 ordering: install → onboarding →
  license-type-review → annual-training).

### Notification + scheduling infra (the email/cron target)

- `src/lib/notifications.js` — thin client for event-driven notifications;
  POSTs `/api/notify-state-change` with `change_type`, `family_id`, etc.
- `api/notify-state-change.js` — server endpoint; writes a
  `notification_log` row and sends via Resend.
- `notification_log` table (production-only schema per `tech_debt.md`;
  reused by PR #12) — columns `recipient_type`, `recipient_id`,
  `change_type`, `change_description`, `changed_by_user_id`, `family_id`,
  `child_id`, `email_sent boolean`, `email_sent_at`, `email_id`,
  `metadata jsonb`. PR #15 keeps using this table for the audit/sent-log
  trail (one row per email actually sent); the new reminder tables are
  separate.
- `api/cron-send-acknowledgment-digest.js` — Vercel cron handler, hourly
  schedule, fires per provider when local-time `(day, hour)` matches the
  configured window. Currently DISABLED in `vercel.json` per
  `tech_debt.md`. The TZ + DST + day-of-week midnight quirk handling lives
  in `src/lib/acknowledgmentDigest.js#shouldSendDigestNow` — reusable
  shape for the new dispatcher.
- `vercel.json` `crons` array — currently two entries
  (`cron-generate-autopay-invoices`, `cron-charge-autopay`); after Pro
  upgrade, PR #15 adds a third (`cron-dispatch-reminders`) and re-adds
  the fourth (`cron-send-acknowledgment-digest`).

### Provider preferences precedent

The closest existing pattern is PR #12's six `acknowledgment_*` columns on
`public.profiles` (`acknowledgment_cadence`,
`acknowledgment_strictness`, `acknowledgment_email_enabled`,
`acknowledgment_email_send_day`, `acknowledgment_email_send_hour`,
`acknowledgment_email_timezone`). That ad-hoc approach **does not scale**
to N reminder categories — N×6 columns is the wrong shape. PR #15 lifts
preferences into a dedicated table.

### What's deliberately not here

- No CDC-redetermination-specific schema (post-July; the docs
  `docs/customer-research-2026-05-23.md` and
  `docs/redetermination-ownership-spec.md` referenced from
  `CLAUDE.md` / backlog **do not yet exist in the repo** — flag for owner).
  PR #15 must accommodate that future use case via the generic shape.

---

## Step 3 — Implementation plan

### A. Migration design

**Two new tables + one ENUM. Migration number 023** (post-PR-14's 022;
verify against the latest migration number in `supabase/migrations/` at
implementation time per the table-name-availability convention).

```sql
-- Migration 023: opt-in reminder system (PR #15)
-- See docs/pr-15-opt-in-reminder-system-scope.md.
-- General-purpose infrastructure: serves licensed-home compliance
-- (PRs #18–#21), plus future non-compliance use cases (CDC redetermination,
-- billing nudges, MiRegistry deadlines).
```

**ENUM: `reminder_channel`** (text + CHECK, matching the
license_type / provider_type house pattern; see PR #14 scope § A
rationale):

```sql
-- 'in_app' | 'email' | 'both' — per-preference channel selection.
alter table ... -- conceptually, but reminder_channel is a column-level
                -- CHECK, not a separate type. See preferences table below.
```

**Table 1: `reminder_preferences`** — one row per
`(provider_id, category)` capturing the provider's opt-in choice for that
category. Default: no row = opted out (matches OFF-by-default constraint H).

```sql
create table public.reminder_preferences (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references auth.users(id) on delete cascade,
  category        text not null,
  channel         text not null default 'in_app'
                    check (channel in ('in_app', 'email', 'both')),
  lead_time_days  integer not null default 7
                    check (lead_time_days between 0 and 365),
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider_id, category)
);

-- Category is a text discriminator (not an ENUM) for the same evolution
-- reason as license_type in PR #14: future categories (cdc_redetermination,
-- billing_overdue, miregistry_level2_expiration, etc.) can be added without
-- ALTER TYPE in a transaction.
--
-- The application maintains the authoritative category catalog in
-- src/lib/reminderCategories.js; DB writes are validated against that.
-- A row's mere existence does not mean "enabled" — `enabled = true` does.
-- A toggle-off flips `enabled` to false rather than deleting the row, so
-- a re-enable preserves the configured lead_time_days and channel.
```

**Table 2: `reminder_instances`** — the scheduled fire log. One row per
distinct "X is due on date Y" event. Per-category code (e.g. a drill
scheduler in PR #19) inserts rows; the dispatcher cron reads them.

```sql
create table public.reminder_instances (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references auth.users(id) on delete cascade,
  category        text not null,
  subject_type    text,   -- 'child' | 'caregiver' | 'funding_source' |
                          -- 'property_record' | 'drill_log' | 'medication_authorization'
                          -- | null (provider-level, no subject)
  subject_id      uuid,   -- the referenced row's id, when applicable
  trigger_at      timestamptz not null,   -- when this reminder should fire
  due_at          timestamptz,            -- the underlying deadline (informational)
  title           text not null,          -- short label for the banner / email subject
  body            text,                   -- longer copy for email body
  cta_path        text,                   -- in-app route to take the provider to (e.g. '/i-billing')
  fired_at        timestamptz,            -- set by the dispatcher when delivered
  fired_via       text check (fired_via is null or fired_via in ('in_app', 'email', 'both')),
  dismissed_at    timestamptz,            -- in-app banner dismissal
  resolved_at     timestamptz,            -- the underlying deadline was satisfied
  archived_at     timestamptz,            -- soft delete (constraint F)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A provider sees at most one pending instance per (category, subject_type, subject_id, trigger_at).
  unique (provider_id, category, subject_type, subject_id, trigger_at)
);

-- Hot path: dispatcher reads pending instances grouped by provider.
create index idx_reminder_instances_pending
  on public.reminder_instances (provider_id, trigger_at)
  where fired_at is null and resolved_at is null and archived_at is null;

-- Banner host: per-provider active instances ordered by trigger.
create index idx_reminder_instances_active
  on public.reminder_instances (provider_id, category, trigger_at)
  where dismissed_at is null and resolved_at is null and archived_at is null;
```

**RLS:** standard provider-scoped (`provider_id = auth.uid()`) for both
SELECT/UPDATE. INSERT is service-role-only on
`reminder_instances` (the dispatcher writes via a service-role key from
the cron handler; per-category schedulers also run server-side); the
client never inserts. UPDATE-by-provider is allowed for
`dismissed_at` and `resolved_at` only — enforced via a column-level
update policy or a SECURITY DEFINER RPC. Recommend the RPC (cleanest);
detail in § B.

**No backfill.** Existing providers see no reminders until they opt in
per category (constraint H).

**Down migration:** drop tables (no destructive data — preferences and
instances are fully re-creatable). Commented per house pattern.

### B. App-code structure

#### B.1 Category catalog (`src/lib/reminderCategories.js`, new)

A frozen object enumerating every category the system supports.
Each entry: `key`, `label`, `description`, `default_lead_time_days`,
`license_type_gating` (which `license_type` values activate the category),
`scheduler` (a reference to the per-category code that inserts instances),
optional `subject_type` if reminders are always bound to a subject.

```js
export const REMINDER_CATEGORIES = Object.freeze({
  // ── PR #16 — Child files (R 400.1907) ──────────────────────────────
  child_annual_review:              { /* per-child annual records review */ },

  // ── PR #17 — Discipline policy (R 400.1942) ────────────────────────
  staff_discipline_policy_ack_pending: { /* per-caregiver, fires when a new
                                            hire has no discipline-policy ack
                                            on file */ },

  // ── PR #18 — Staff files (R 400.1920, R 400.1933) ──────────────────
  cpr_first_aid_expiration:         { /* per-caregiver, cert expiry */ },
  physician_attestation_expiration: { /* per-caregiver, annual */ },

  // ── PR #19 — Drills (R 400.1939) ───────────────────────────────────
  drill_fire:                       { /* every 3 months from last_completed_on */ },
  drill_tornado:                    { /* 2× annually in March–November */ },
  drill_other:                      { /* annual catch-all: lockdown,
                                          shelter-in-place, reunification */ },

  // ── PR #20 — Medication (R 400.1931) ───────────────────────────────
  medication_authorization_renewal: { /* per-authorization, fires near
                                          ends_on or on schedule change */ },

  // ── PR #21 — Property records (R 400.1915, R 400.1945, R 400.1948) ─
  radon_test_due:                   { /* 4-year recurring per radon test */ },
  heating_inspection_due:           { /* 4-year recurring per inspection */ },
  detector_check_overdue:           { /* annual default; smoke + CO detectors */ },

  // ── LEP / CDC categories (existing surfaces this PR optionally migrates):
  miregistry_annual_training:       { /* R 400.1924 / Dec 16, LEP only */ },
  fingerprint_reprint:              { /* LEP-Unrelated, 5-yr */ },

  // ── Future non-compliance categories (placeholders documented so the
  //    schema design is validated; not implemented in PR #15):
  // cdc_redetermination:           { /* post-July; "parent responsibility"
  //                                     ack + escalating reminder series */ },
  // billing_overdue:               { /* "remember to bill" — provider feedback */ },
})
```

Each entry carries: `key`, `label`, `description`,
`default_lead_time_days`, `license_type_gating` (the `license_type`
values that activate the category), `subject_type` (when always bound),
and an optional `severity_thresholds` override. Names above match
exactly the strings other scope docs reference; do not rename without
updating the consumers (`docs/pr-17-…`, `docs/pr-18-…`, `docs/pr-19-…`,
`docs/pr-20-…`, `docs/pr-21-…`).

This catalog is what `useReminderPreferences` and the settings UI
enumerate; the dispatcher cron does not consult it directly (it reads
`reminder_instances` rows whose `category` field is a string).

#### B.2 Pure scheduler helper (`src/lib/reminderSchedule.js`, new)

Date math shared across all per-category schedulers:
`nextOccurrence(rule, today)` for recurring categories;
`shouldRemindNow(due_at, lead_time_days, today)` predicate; reuse the
`todayYMD` / `daysBetweenYMD` helpers from `cdcProviderCompliance.js`
(extract to `src/lib/dates.js` finally, per the standing tech-debt note).

#### B.3 Severity helper (`src/lib/reminderSeverity.js`, new)

Generalizes `cdcProviderCompliance.js`'s severity ladder so any
category's banner gets the same `info/warning/urgent/critical/expired`
treatment without re-deriving thresholds. Per-category override is via
the `REMINDER_CATEGORIES` entry's optional `severity_thresholds` field.

#### B.3a Audit-state helper (`getReminderSystemAuditState()`, new — cross-cutting requirement)

Per the post-review **audit-state mandate**: every domain PR exposes a
`getXxxAuditState(licensee_id)` pure helper returning a structured
signal-object consumed by the future PR #22 (Compliance Health Score).
For PR #15 the helper lives in `src/lib/reminderSystem.js` and returns:

```js
// Signature (illustrative).
export async function getReminderSystemAuditState(licenseeId) {
  return {
    domain: 'reminder_system',
    type: 'type_2',                    // MILittleCare-owned (vs PR #18 type_1
                                        // mirror data). Documented in
                                        // CLAUDE.md per the audit-state mandate.
    preferences_configured_count: 0,    // distinct categories the provider
                                        // enabled
    pending_instances_count: 0,         // active reminder_instances rows
    overdue_instances_count: 0,         // pending AND trigger_at < now
    last_dispatch_at: null,             // most recent notification_log
                                        // entry for change_type LIKE 'reminder_%'
    email_channel_enabled: true,        // derived from any preference with
                                        // channel IN ('email','both')
  }
}
```

The helper is read-only, single round-trip, and exists from V1 of PR #15
so PR #22 can compose all seven domain helpers without retrofit.

#### B.4 `useReminderPreferences` hook (`src/hooks/useReminderPreferences.js`, new)

Loads the current user's `reminder_preferences` rows, exposes
`{ preferences, byCategory, update(category, patch), enable(category),
disable(category), loading, error }`. Single round-trip on mount; writes
upsert one row at a time.

#### B.5 `useActiveReminders` hook (`src/hooks/useActiveReminders.js`, new)

Loads `reminder_instances` filtered to the current provider where
`dismissed_at is null and resolved_at is null and archived_at is null
and trigger_at <= now + lead_time_days` (via the preferences join).
Used by the dashboard banner host.

#### B.6 Banner host component (`src/components/dashboard/ReminderBanners.jsx`, new)

Replaces / subsumes `AnnualTrainingBanner`, `LicenseTypeReviewBanner`
ordering. Reads `useActiveReminders`, renders one stacked banner per
active instance, using `reminderSeverity` for tinting and per-category
metadata for icons / CTA paths.

PR #15 V1 keeps the legacy bespoke banners (`AnnualTrainingBanner`,
`LicenseTypeReviewBanner`) in place to avoid migrating their behavior in
this PR. Document in `tech_debt.md` as a follow-up consolidation.

#### B.7 Settings page (`src/pages/RemindersSettingsPage.jsx`, new)

One row per category from `REMINDER_CATEGORIES`, gated by
`license_type` (constraint C). Each row: toggle + lead-time selector
(0 / 1 / 7 / 14 / 30 days, dropdown) + channel selector
(`in_app` / `email` / `both`, dropdown). Save-on-change with
optimistic UI + rollback on error. Empty state when no categories are
gated active for this license_type. Sidebar nav entry under "Settings".

#### B.8 Dispatcher cron handler (`api/cron-dispatch-reminders.js`, new)

Hourly schedule. For each pending `reminder_instances` row where
`trigger_at <= now()`, joined to `reminder_preferences` for the
matching provider/category:

1. If no preference row → skip (default OFF).
2. If preference.enabled = false → skip.
3. Compose email + in-app surface per `preference.channel`.
4. Email path: call Resend; write `notification_log` row
   (reuse PR #12's pattern); set `fired_at` + `fired_via` on the
   instance.
5. In-app path: setting `fired_at` is enough — the banner host queries
   active instances.
6. Failures: leave `fired_at` null so the next tick retries; bounded
   retry by `created_at` age (drop / archive after 7 days).

Service-role auth (the cron secret is a Vercel env var; the handler
verifies it). One database transaction per provider to bound row-lock
contention.

#### B.9 Per-category scheduler shims

Each category-owning PR (#18 CPR, #19 drills, #21 radon/heating)
implements its own scheduler that inserts `reminder_instances` rows.
PR #15 ships one **example** scheduler — the `miregistry_annual_training`
re-implementation — to validate the contract end-to-end. The existing
`AnnualTrainingBanner` stays in place; the new scheduler writes parallel
instances that the new banner host renders, providing the migration
template.

### C. UI surfaces (in plain words)

- **Settings → Reminders.** A list of opt-in toggles, one per category
  relevant to this provider's `license_type`. Each toggle reveals lead-time
  and channel dropdowns when on. Defaults: lead time 7 days, channel
  `in_app`. Save inline. Inline help (per CLAUDE.md) explains what each
  category notifies and what triggers it.
- **Dashboard banner stack.** One banner per active reminder, severity-
  tinted, with a CTA button taking the provider to the relevant page
  (drill log, medication log, etc.). Dismiss-X on each banner clears it
  until the next scheduled tick. The existing `AnnualTrainingBanner` and
  `LicenseTypeReviewBanner` stack above this in PR #15 V1.
- **Email** (when channel=`email` or `both`). One email per fired
  instance, subject = `title` field, body = `body` field + a deep link.
  Sender / Resend template reuse PR #12's setup.

### D. Module gating

Per constraint C, every compliance category gates on
`license_type IN ('family_home', 'group_home')`. PR #15's settings page
filters `REMINDER_CATEGORIES` accordingly. The CDC/LEP categories
(`miregistry_annual_training`, `fingerprint_reprint`) gate on
`license_type = 'license_exempt'`. Non-compliance future categories
(redetermination, billing) are LEP+licensed (`license_type IS NOT NULL`)
when they ship.

PR #15 adds a new module key: `MODULE_KEYS.REMINDERS = 'reminders'` in
`src/lib/modules.js`. Active when `license_type IS NOT NULL` (any
provider with a confirmed license type can configure reminders). Sidebar
nav entry: `Settings → Reminders`.

### E. Tests

- **Pure unit (`reminderSchedule.test.js`):** `nextOccurrence` for the
  three recurrence shapes (every-N-months, seasonal-window, annual);
  `shouldRemindNow` predicate with various `lead_time_days`.
- **Pure unit (`reminderSeverity.test.js`):** severity ladder thresholds.
- **Migration test:** unique constraint on
  `(provider_id, category, subject_type, subject_id, trigger_at)`
  rejects duplicates; the partial indexes exist.
- **Dispatcher unit:** mock supabase + Resend; verify pref-off skips,
  channel routing, `fired_at` write, `notification_log` write.
- **End-to-end smoke:** insert a manual instance, run the dispatcher,
  observe `notification_log` row and `fired_at` set. Manual verification
  step per CLAUDE.md schema-verification rule.
- RTL render tests deferred per house convention.

### F. Documentation

- `docs/runbook.md` — migration 023 entry template
  (pending user-run verification per CLAUDE.md).
- `docs/tech_debt.md` — note the bespoke-banner / new-banner-host overlap
  (V1 ships both; a follow-up PR consolidates).
- `CLAUDE.md` — add a one-line convention note under § Critical Domain
  Knowledge: "Reminders are opt-in per category, default OFF. Categories
  are catalogued in `src/lib/reminderCategories.js`."

### G. Rollout

1. **Pre-flight:** Vercel Pro is assumed active. Re-add the disabled
   `cron-send-acknowledgment-digest` schedule entry to `vercel.json`
   alongside the new `cron-dispatch-reminders` entry in the same deploy.
2. Apply migration 023; verify columns + indexes + RLS via dashboard
   screenshot per CLAUDE.md.
3. Deploy app; the new settings page is live, all categories default off,
   no behavior changes for existing users.
4. **Communicate to Venessa:** "Reminders settings page is live; turn on
   the ones you want."

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **In-app banner dismissal semantics — until next tick, or permanent?**
   **RESOLVED — "until next tick" for recurring categories; "until
   resolved" for one-shot.** For recurring (drills, radon, heating), the
   dispatcher writes a new `reminder_instances` row on the next cadence
   tick and the banner reappears. For one-shot (a specific
   medication-authorization renewal, a child's first annual review),
   `resolved_at` is set when the underlying deadline is satisfied
   (category-specific code, NOT the banner). Dismissing a one-shot
   banner suppresses display until `resolved_at` is set — at which point
   the banner disappears permanently.

2. **Per-recipient or provider-only?** **RESOLVED — provider-only for
   V1.** Schema carries `provider_id` only. `recipient_user_id` is
   **deferred** to a future PR (staff-self-clock + staff-self-MiRegistry
   flows will be its first consumers). No schema change in PR #15.

3. **`subject_type` enumeration — pre-declare in CHECK, or stay
   free-text?** **RESOLVED — defer to Claude Code at implementation
   time.** The implementation pass picks the shape that fits best given
   the up-to-the-minute set of consumers; both shapes are acceptable per
   constraint A. Document the choice in the migration header.

4. **Replacing legacy banners (`AnnualTrainingBanner`,
   `LicenseTypeReviewBanner`, `MiRegistryWarningBanner`) in this PR or a
   follow-up?** **RESOLVED — follow-up PR.** V1 keeps the bespoke
   banners stacked alongside the new host. Consolidation is a separate
   small later PR once the host has soaked.

5. **Customer-research and redetermination-ownership spec docs are
   referenced but absent.** **RESOLVED — leave as dead references for
   now.** PR #15's design accommodates the future CDC-redetermination
   use case based on verbal description in the bulk-scoping prompt and
   `CLAUDE.md` § Critical Domain Knowledge. Authoring those docs is
   tracked separately; not a blocker for PR #15.

---

## Step 5 — Effort estimate

**M.** Two new tables (modest), one cron handler (the dispatcher is the
new code; the existing ack-digest is a template), one settings page,
two new hooks, three new pure helpers, one banner host. Most of the
design is *parameterizing* an existing pattern (`cdcProviderCompliance.js`
→ `reminderSeverity.js`) and *generalizing* an existing cron
(`cron-send-acknowledgment-digest.js` → `cron-dispatch-reminders.js`).
The DB design is the load-bearing decision, not the code.

---

## Step 6 — Out of scope (future PRs)

- **Per-recipient targeting** (`recipient_user_id`) — OQ #2 resolved
  to deferred.
- **Replacement of `AnnualTrainingBanner` / `LicenseTypeReviewBanner` /
  `MiRegistryWarningBanner`** with the new host — OQ #4 resolved to
  follow-up PR.
- **CDC redetermination reminders** (post-July, per backlog). The PR #15
  schema accommodates without change.
- **"Remember to bill" reminders** (post-July).
- **SMS channel** — V1 ships in-app + email only.
- **Reminder snoozing UX** (a dropdown to push a single instance by N
  days) — deferred to a follow-up.
- **Reminder digest / consolidation** (one email summarizing N pending) —
  PR #12's ack-digest pattern is the template if/when needed; not in V1.
- **`src/lib/dates.js` extraction** — standing tech-debt; touched
  *but not introduced* by this PR.

---

## Step 7 — Dependencies on prior PRs

- **PR #14 (license_type) — REQUIRED.** Settings page gates on it; module
  gates use it.
- **PR #13 (children.archived_at) — soft dependency.** Not directly
  needed by this PR, but the convention applies to the new tables.
- **Vercel Pro — ASSUMED ACTIVE** (operational, not a PR). Per the
  2026-05-26 review decisions; email channel ships in V1.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template);
`src/lib/cdcProviderCompliance.js`, `src/lib/modules.js`,
`src/lib/notifications.js`,
`src/components/dashboard/AnnualTrainingBanner.jsx`,
`src/components/dashboard/LicenseTypeReviewBanner.jsx` (PR #14),
`api/cron-send-acknowledgment-digest.js`, `vercel.json` (referenced from
`tech_debt.md`), `notification_log` shape via PR #12 build summary.

*No source files modified. No branch other than `docs/pr-15-21-scoping`.
No migrations run.*
