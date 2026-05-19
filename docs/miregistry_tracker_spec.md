# MILittleCare: MiRegistry Deadline Tracker Spec

**Status:** Draft for PR #3
**Goal:** Give license-exempt providers a single screen that answers two
questions: "am I on track to keep my CDC Scholarship account open this
year?" and "do I qualify for the Level 2 pay rate?"

This is a **small, high-leverage** feature. Missing the December 16
Annual Ongoing Training deadline closes a license-exempt provider's
account — they can't bill CDC until they reapply. Letting Level 2 lapse
drops them from $4.40–$4.95/hour back to $2.95/hour. Both have direct
dollar consequences and are entirely preventable with a calendar
reminder and a running hours total.

Authoritative source for every rule cited here is
`docs/reference/Scholarship Handbook for License Exempt Provider.pdf`
(revised 2026-04-01), pages 11–13 (LEP Training Levels and Annual
Ongoing Training) and pages 21–22 (Hourly Rate).

---

## 1. Context

### What MiRegistry is

MiRegistry is the State of Michigan's professional development tracker
for the early childhood workforce. Every license-exempt provider must
have a MiRegistry account with a unique ID; the ID is how MDHHS
verifies completed training and authorizes payment. Training completed
outside MiRegistry doesn't count toward state pay-rate determinations.

### The December 16 Annual Ongoing Training deadline

Per handbook page 12: every license-exempt provider must complete the
**Michigan Ongoing Health & Safety Training Refresher** each year by
**December 16**. This is a free, MiRegistry-hosted training. Providers
who miss the deadline have their accounts **closed**. A closed provider
must **reapply** before they can resume billing CDC. The reapplication
process is multi-week and includes background checks; meaningful lost
income.

### Level 1 vs Level 2 pay rates

Per handbook page 22 (Hourly Rate table), license-exempt providers are
paid by `hours billed × hourly rate`, where the rate depends on the
provider's training level *and* the child's age band:

| Child age band | Level 1 rate | Level 2 rate |
| --- | ---: | ---: |
| Infant/Toddler (birth – age 2) | $2.95 | **$4.95** |
| Preschool (age 2½ – 5) | $2.95 | **$4.40** |
| School-age (age 5+) | $2.95 | **$4.40** |

The Level 2 rate is **49–68% higher** than Level 1. For a provider
billing 1,200 hours per year of infant care, Level 2 vs Level 1 is the
difference between **$5,940 and $2,400** of CDC revenue — over
**$3,500/year** at one child.

### Level 2 mechanics — the rolling expiration date

Per handbook page 13:

- Default: every license-exempt provider is at Level 1 after completing
  the one-time LEPPT (License Exempt Provider Preservice Training).
- To reach Level 2: complete **10 hours of MiRegistry-approved
  training** (each session ≥ 1 hour). LEPPT does NOT count.
- Up to **2 of the 10 hours** can be the Annual Ongoing Training.
- Level 2 rate begins on the **date the provider finishes the 10th
  hour**.
- Each subsequent 10 hours **resets the Level 2 expiration date**.
- If 10 additional hours are not completed before the current
  expiration date, the rate **drops back to Level 1**.
- The expiration date is shown on the provider's MiRegistry LEP
  Training Record. **MiRegistry computes it; we do not.**

The rolling-clock model is the trickiest aspect to communicate. A
provider intuitively expects a calendar-year reset; the actual rule is
"every 10 hours buys you another year from your current expiration."

**LEPPT CPR/first-aid exception (handbook page 12).** Providers who
hold a current pediatric CPR + first-aid card or certificate may opt
out of the CPR/first-aid portion of the face-to-face Level 1 LEPPT by
contacting the Great Start to Quality Resource Center. This is out of
scope for V1 — we don't model partial LEPPT credit — but the entries
table can record whatever the provider was credited. Mentioned here
to close the reasoning gap if a provider asks why their LEPPT entry
hours look smaller than the standard.

---

## 2. Data Model

### 2.1 Existing columns we use

Already on `profiles` from migration `004_provider_program_settings.sql`:

| Column | Type | Use here |
| --- | --- | --- |
| `miregistry_id` | text | The provider's MiRegistry account ID. Null until entered by the provider. Activates the tracker module when set. |
| `is_license_exempt` | boolean | Determines whether annual-deadline + level-rate logic applies. |
| `great_start_star_rating` | integer | Not used by this PR; mentioned for context. |
| `annual_training_completion_date` | date | **Deprecated by this PR** — see § 2.3. |

`profiles.role` and the `program_settings` JSON also exist. Neither is
modified by this PR.

### 2.2 New columns on `profiles`

```sql
alter table public.profiles
  add column if not exists miregistry_current_level text
    check (miregistry_current_level in ('level_1', 'level_2')),
  add column if not exists miregistry_level_2_expires_on    date,
  add column if not exists miregistry_level_last_updated_at timestamptz;
```

All three are nullable; meaningful only for license-exempt providers.
`miregistry_current_level` defaults to `null` (provider hasn't
self-attested to a level yet). The handbook says the source of truth
for the expiration date is the MiRegistry LEP Training Record — we
store what the provider transcribes from MiRegistry, not a derived
value.

`miregistry_level_last_updated_at` is a dedicated timestamp (not a
reuse of `profiles.updated_at`) because the row-level `updated_at`
changes for unrelated edits — fixing a phone number would otherwise
falsely refresh the "Last updated by you on" display in § 3.2 and
make a stale level/expiration look freshly synced. Application code
sets this column only when the level/expiration fields are written
via the Update from MiRegistry modal.

### 2.3 Deprecation: `profiles.annual_training_completion_date`

Migration 004 added this single date column. It models a single
"latest annual training completion" without history, which:

- Loses audit trail (we can't show MiLEAP "I completed Nov 5, 2026" if
  someone overwrites it with the next year's date).
- Doesn't support the case where a provider completed the training in
  late 2025 and wants the system to recognize 2025 *and* track 2026
  separately.

This PR introduces the entries table (§ 2.4) as the source of truth.
The column stays on `profiles` for backward compatibility but is no
longer written to. Tech-debt entry will track its eventual removal.

### 2.4 New table: `miregistry_training_entries`

The source of truth for every completed training. One row per
completion event.

```sql
create type public.miregistry_training_source as enum (
  'leppt',                 -- one-time initial LEP Provider Preservice Training
  'annual_ongoing',        -- Michigan Ongoing Health & Safety Refresher
  'level_2_approved',      -- any other MiRegistry-approved training, ≥ 1 hour
  'other'                  -- training the provider chose to log but doesn't fit above
);

create table public.miregistry_training_entries (
  id                  uuid default gen_random_uuid() primary key,
  user_id             uuid references auth.users(id) on delete cascade not null,
  completed_on        date not null,
  hours               numeric(5,2) not null check (hours > 0 and hours < 100),
  title               text not null,
  source              public.miregistry_training_source not null,
  miregistry_event_id text,                  -- optional: MiRegistry's per-event ID (V2 import hook)
  notes               text,
  archived_at         timestamptz,
  archived_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

Indexes:

```sql
-- Hot-path "is this year covered?" + "level 2 progress" queries.
create index miregistry_entries_user_completed_idx
  on public.miregistry_training_entries (user_id, completed_on desc)
  where archived_at is null;

-- Source-type rollups.
create index miregistry_entries_user_source_idx
  on public.miregistry_training_entries (user_id, source, completed_on)
  where archived_at is null;
```

RLS: select / insert / update only — soft-delete via `archived_at`
update, matching the convention from migrations 003 and 008. No
DELETE policy.

### 2.5 Derived state (no schema, computed in app code)

These are computed from `miregistry_training_entries` on demand:

- **Annual deadline status for year Y** — has any entry with
  `source = 'annual_ongoing'` and `completed_on` between Jan 1 Y and
  Dec 16 Y? (Boolean.)
- **Hours logged in calendar year Y** — sum of `hours` from all
  non-archived entries whose `completed_on` falls in year Y. (Number.)
  This is what we display, and intentionally NOT a measure of Level 2
  progress — see § 5.3 for why we don't pretend to compute that in V1.
- **Level 1 status: LEPPT completed?** — exists any entry with
  `source = 'leppt'`? (Boolean.)

These derivations live in `src/lib/miregistry.js` as pure functions.
Tested with Vitest the same way `modules.js` and `fundingDocuments.js`
are.

---

## 3. UI/UX

### 3.1 Where it lives

**New page:** `src/pages/MiRegistryPage.jsx` at route `/miregistry`.

**Sidebar entry:** "MiRegistry" with a status badge:

| Condition | Badge |
| --- | --- |
| Annual training not done AND today > Dec 16 of current year | red — "OVERDUE" |
| Annual training not done AND ≤ 30 days until Dec 16 | yellow — "DUE SOON" |
| Level 2 expires within 30 days AND no recent training | yellow — "LEVEL 2 EXPIRING" |
| Otherwise | none |

**No dashboard widget in V1.** A widget can be added in V2 once
patterns for the dashboard are settled.

### 3.2 Page layout

Three top status cards, then the entries list, then settings.

```
┌─ MiRegistry Training ─────────────────────────────────────────┐
│                                                                │
│  ┌─ Annual Ongoing Training ─┐  ┌─ Training Level ──────────┐ │
│  │ ✓ Done for 2026           │  │ Level 2                    │ │
│  │ Completed Nov 5, 2026     │  │ Expires May 14, 2027       │ │
│  │ Next deadline:            │  │ Last updated by you        │ │
│  │ Dec 16, 2026  (216 days)  │  │   on May 14, 2026          │ │
│  └───────────────────────────┘  │ [Update from MiRegistry]   │ │
│                                 └────────────────────────────┘ │
│                                                                │
│  ┌─ Training Hours (2026) ───────────────────────────────────┐│
│  │ Hours logged this calendar year:  7.5                    ││
│  │ Hours toward your next Level 2 renewal:                  ││
│  │   check your MiRegistry transcript                       ││
│  └───────────────────────────────────────────────────────────┘│
│                                                                │
│  ─── Logged trainings ─────────────────────────────────────── │
│  [Log a training]                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Nov 5, 2026  Annual Refresher       2.0h  annual_ongoing│ │
│  │ Oct 12, 2026 CPR/First Aid          3.5h  level_2       │ │
│  │ Sep 1, 2026  Trauma-Informed Care   2.0h  level_2       │ │
│  │ ...                                                      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ─── Settings ────────────────────────────────────────────── │
│  MiRegistry ID: 1234567  [Edit]                                │
└────────────────────────────────────────────────────────────────┘
```

**Training Level card affordances:**

- **`[Update from MiRegistry]` button** — opens a modal that lets the
  provider transcribe their current `miregistry_current_level` and
  `miregistry_level_2_expires_on` from their MiRegistry LEP Training
  Record. Save records both fields plus a `level_last_updated_at`
  timestamp displayed back to the provider as "Last updated by you on
  [date]". Source-of-truth lives in MiRegistry; this is a manual sync.
- **"Last updated by you on [date]"** — the timestamp from the most
  recent successful save of the level/expiration fields. Helps the
  provider gauge whether the displayed date is fresh or stale.

**Training Hours card — why two numbers (no single "progress bar"):**

We can compute "hours logged this calendar year" exactly because we
own the entries table. We **cannot** compute "hours toward your next
Level 2 renewal" because:

1. The Level 2 cycle starts from the current expiration date, not
   January 1. The two windows often overlap but are not the same.
2. MiRegistry applies its own cap rules (e.g. ≥ 1 hour per session,
   the 2-hour cap on annual_ongoing) that we'd have to perfectly
   mirror to avoid wrong-number bugs.
3. Trainings logged here aren't necessarily MiRegistry-approved.

Showing a wrong "8.5 / 10" bar would actively mislead. Pointing the
provider at MiRegistry's transcript is honest. V2 may auto-compute
this once the entries table is trusted complete and our accounting
has been verified against MiRegistry's.

### 3.3 Empty states

**No MiRegistry ID set:** the page shows a single card prompting the
provider to enter their ID, with an inline help link explaining where
to find it on miregistry.org. No status cards or entries table render
until an ID is present.

**MiRegistry ID set but no training entries logged:** all three status
cards render with empty/zero values:
- Annual Ongoing Training card → "Not yet completed for 2026"
- Training Level card → "Level 1 (default)" with a help bubble
  explaining how to reach Level 2
- Hours card → "0 / 10 hours"
The entries table shows an empty-state row: "No trainings logged yet.
Start with your most recent — older entries can be added afterward."

### 3.4 Licensed providers

> **DEPRECATED — superseded by Staff Training (PR #8, 2026-05-19).** The
> stripped-down MiRegistry page view for licensed providers described
> below is retired. Per `docs/staff_training_tracking_spec.md` § 5.2 and
> § 9 decision OQ11, a licensed provider's training is now tracked in the
> Staff Training feature (`MODULE_KEYS.STAFF_TRAINING`, `/staff-training`)
> — the licensee appears as a caregiver in their own roster, alongside
> their staff. Each caregiver still needs a personal MiRegistry account /
> ID (the state registry of record), and `profiles.miregistry_id` still
> stores it per person — but the licensed-home *tracking UI* is Staff
> Training, not a degraded MiRegistry page. The text below is kept as the
> historical record of the V1 interim behaviour.

Per CLAUDE.md's module-activation principle, providers who are not
license-exempt should not see Level 1/2 / December 16 messaging — those
rules don't apply to them.

**V1 scope: license-exempt providers only.** Licensed providers who
have set a `miregistry_id` see a stripped-down version of the page:
just the entries log + ID setting. No annual deadline card, no
Level 1/2 card, no Hours-toward-Level-2 card. The status badges in the
sidebar are also suppressed for licensed providers.

Licensed providers have their own continuing-education requirements
(LARA-administered, separate from MiRegistry levels). More fundamentally,
this tracker models *one auth user tracking their own training* — which
does not fit a licensed provider at all. A licensed provider (e.g. a
Family Child Care Home licensee) must track training for **every staff
member** under their license — assistants, substitutes, anyone providing
care — with role-dependent requirements that LARA inspects for. The V1
stripped-down view above only narrows the self-tracking page; it does not
address staff training tracking.

Properly supporting licensed providers needs a **separate spec**. The
likely shape is **Model B — a licensee dashboard that aggregates staff
compliance** (a per-staff role-aware requirement matrix with due dates and
a status rollup), but it is currently unbuilt. See `docs/tech_debt.md`
§ "Staff training tracking for licensed providers is unmodeled".

### 3.5 Edge cases the UI must handle

- **Today is past December 16 and no annual training logged for the
  current year.** Annual card switches to a red alert state: "Annual
  training was due December 16, 2026. Per MDHHS, your provider account
  may be closed and you'll need to reapply before resuming CDC
  billing. Contact MDHHS at [number] for next steps." The "Log a
  training" button is still available so the provider can record what
  they actually did, even if late.
- **Provider hits 10 cumulative Level-2 hours mid-year.** Hours card
  flips to a celebratory state and prompts: "You've completed 10 hours.
  Update your Level 2 expiration date from MiRegistry once it appears
  on your LEP Training Record (allow up to 1 week)." This nudges the
  provider to log into MiRegistry and copy the new date over — we
  don't compute it.
- **Backdated entries.** A provider can log a training with a
  `completed_on` before today (common — they're catching up on
  records). All derived state recomputes from entries; no special case.
- **Entry edited / archived.** Soft-delete only via `archived_at`.
  Archived entries don't count toward derived state. UI surfaces them
  via a "Show archived" toggle (mirroring the funding-source list
  pattern).

---

## 4. Module Activation

The module key `MIREGISTRY_TRACKER` already exists in
`src/lib/modules.js` (added during PR #1) and currently activates when
`profile.miregistry_id` is truthy.

**Proposed change to `getActiveModules`:** also activate when
`profile.is_license_exempt === true`. Rationale: a brand-new
license-exempt provider hasn't entered their MiRegistry ID yet, so
they'd never see the empty-state prompt that asks for it. The current
rule creates a chicken-and-egg.

```js
// modules.js — proposed change
if (safeProfile.miregistry_id) modules.add(MODULE_KEYS.MIREGISTRY_TRACKER)
+if (safeProfile.is_license_exempt === true) modules.add(MODULE_KEYS.MIREGISTRY_TRACKER)
```

Module is **not** auto-activated for licensed providers without a
`miregistry_id`. Licensed providers can still opt in by entering their
ID; the existing rule covers that.

**Combined activation rule** (full logic in one place): the
`miregistry_tracker` module is active iff `profile.miregistry_id` is
set OR `profile.is_license_exempt === true`. The `miregistry_id` path
remains the on-ramp for opt-in licensed providers; the
`is_license_exempt` path is the new safety net for license-exempt
providers who haven't yet entered their ID.

---

## 5. Validation Rules

### 5.1 Training entry — form-level

- `completed_on` is required, must be ≤ today.
- `completed_on` must be ≥ 2020-01-01. Older dates almost certainly
  indicate a typo; soft-block with a warning the provider can override
  by editing.
- `hours` is required, must be > 0 and < 100.
- `title` is required, free-text, ≤ 200 chars.
- `source` is required (radio: LEPPT / Annual Ongoing / Level 2
  Approved / Other).
- `miregistry_event_id` is optional, free-text, ≤ 50 chars. Soft
  validation only — we don't know MiRegistry's event ID format.

### 5.2 Annual Ongoing Training cycle

The handbook says "each year by December 16" — the cycle is **calendar
year**. An entry with `source = 'annual_ongoing'` and `completed_on`
between Jan 1 and Dec 16 of year Y satisfies the deadline for year Y.
An entry completed Dec 17–31 of year Y satisfies **neither** year Y
(the account is already closed) **nor** year Y+1 (which requires its
own training completed within year Y+1). Providers in this state need
to reapply with MDHHS before they can resume billing; once reapplied,
the next year's clock starts fresh.

For V1, only the current year's deadline status is surfaced. Past
years are visible in the entries list but not in the status card.

### 5.3 Hours logged this calendar year (V1)

V1 displays a single, honest number: total `hours` summed across all
non-archived entries whose `completed_on` falls in the current
calendar year, regardless of `source`. This is the "Hours logged this
calendar year" line on the Training Hours card.

V1 deliberately does **not** display a "progress toward next Level 2
renewal" number. Computing that correctly requires perfectly
mirroring MiRegistry's accounting (≥ 1 hour per session rule, 2-hour
cap on annual_ongoing, exclusion of LEPPT, the rolling-expiration
window) — and any drift between our computation and MiRegistry's
record produces wrong-number bugs that could mislead providers about
whether they qualify for Level 2 pay rates. The Hours card directs
the provider to their MiRegistry transcript for the authoritative
Level 2 progress figure.

V2 may add an auto-computed Level 2 progress line once (a) the entries
table is trusted complete for the providers in question and (b) our
accounting has been verified against MiRegistry's by spot-check.

### 5.4 MiRegistry ID

Format unknown to us. Soft-validate: required, trimmed, ≤ 30 chars,
non-empty. No regex enforcement — if MiRegistry changes its format we
don't want a hard rejection blocking valid IDs.

---

## 6. Notifications (out of scope for V1)

V1 ships with **no email notifications**. MILittleCare doesn't have an
email service wired up yet. The countdown surface is the only nudge.

When email is added:

- 60 / 30 / 14 / 7 days before December 16, if Annual Ongoing for the
  current year is not yet logged → reminder email.
- 30 days before `miregistry_level_2_expires_on`, if cumulative Level 2
  hours since last expiration < 10 → reminder email.
- Day after a missed deadline → high-urgency email with reapplication
  guidance.

---

## 7. Integration with Funding Sources

If a license-exempt provider is past December 16 of the current year
without a logged Annual Ongoing Training entry, their CDC Scholarship
funding sources are at risk: MDHHS will close the account, and any
billing submitted afterwards will be rejected.

V1 surface: a warning banner appears at the top of the **Funding tab**
(the per-family section that lists funding sources) for license-exempt
providers in this state. The banner's copy:

> You haven't logged your MiRegistry annual training for 2026, and the
> December 16 deadline has passed. MDHHS closes provider accounts that
> miss this deadline — CDC payments stop, and you must reapply before
> billing resumes. If you completed the training, log it on the
> MiRegistry tab. If you haven't completed it, call MDHHS Child
> Development and Care at 866-990-3227 to discuss reactivation.

(The 866-990-3227 line is the CDC Provider Help line listed throughout
the License Exempt handbook — it's the right number for billing /
account / reactivation questions. The 844-464-3447 number listed
elsewhere in the handbook is for parents asking about authorizations,
not providers.)

This intentionally crosses the module boundary (`miregistry_tracker`
warning surfaced inside the `cdc` module's UI). Justified because the
financial blast radius is the funding source itself; the alert needs
to land where the user is most likely to be looking.

The same banner is suppressed for providers who are not license-exempt
(licensed providers don't have the December 16 rule).

---

## 8. Phasing

### V1 — this PR

1. Migration `009_miregistry_training_entries.sql` — new table, enum,
   RLS, indexes; new columns on `profiles`.
2. Pure helpers in `src/lib/miregistry.js` with Vitest tests:
   `getAnnualDeadlineStatus(year, entries)`,
   `getLevel2HoursThisYear(entries)`,
   `getLeppTCompletion(entries)`.
3. Update `src/lib/modules.js` so `is_license_exempt === true`
   activates the tracker module. New unit tests cover the case.
4. New `src/pages/MiRegistryPage.jsx` — page layout per § 3.2.
5. New `src/components/miregistry/TrainingEntryForm.jsx` — modal for
   add/edit/archive of an entry, type-aware fields, dual-time-zone-safe
   date handling (matches the funding source form's `todayYMD()`
   pattern).
6. New `src/components/miregistry/TrainingEntryList.jsx` — table with
   show-archived toggle, sortable by `completed_on`.
7. Sidebar integration: render the "MiRegistry" link via
   `useActiveModules` gating, with the dynamic badge per § 3.1.
8. Funding tab warning banner per § 7.
9. Inline help everywhere: tooltips on every field, an empty-state
   walkthrough, a help link to miregistry.org. Mirror the FundingSourceForm
   approach.
10. Documentation: this spec in `docs/`, runbook entry for migration
    `009`, tech_debt entries for any deferred work, and a
    `CLAUDE.md` Critical Domain Knowledge bullet about the
    December 16 deadline + Level 2 mechanics.

### V2 — future PRs

- **MiRegistry import.** OAuth/API integration so completed trainings
  flow in automatically. `miregistry_event_id` is the hook.
- **Email reminders** per § 6.
- **Level 2 expiration auto-compute.** Once we trust the entries
  table is complete, derive expiration from the rolling 10-hour cycle.
- **Licensed-provider continuing-education tracking** (LARA rules,
  separate spec).
- **Reapplication tracking.** Workflow + checklist for providers
  whose accounts have been closed.
- **Dashboard widget.** "Next deadline" card on the home dashboard.

---

## 9. Decisions recorded

Resolved in spec review on 2026-05-14:

1. **Deprecate `profiles.annual_training_completion_date`.** Approved.
   Stop writing to it during the implementation PR; remove the column
   in a later cleanup PR. Tracked in `docs/tech_debt.md`.

2. **Module activation on `is_license_exempt = true` even with null
   `miregistry_id`.** Approved. See § 4 for the combined activation
   rule.

3. **Store `miregistry_current_level` rather than derive it.**
   Approved. MiRegistry is authoritative; we hold the transcribed
   value plus a "last updated by you on" timestamp.

4. **Hours card scope.** Override of original lean: show **two
   numbers, not one**. "Hours logged this calendar year" is what we
   compute; "Hours toward your next Level 2 renewal" is "check your
   MiRegistry transcript" because pretending to compute it without
   matching MiRegistry's accounting creates wrong-number bugs. See
   § 3.2 and § 5.3 for the reasoning. V2 may auto-compute once the
   entries table is trusted complete and our math is verified.

5. **Funding-tab warning copy.** Override of original draft. Copy
   uses present tense, accurate consequence language, and a clear
   next step including the 866-990-3227 CDC Provider Help line. See
   § 7 for the final wording.

6. **4-year retention via `archived_at`.** Approved. No
   `retention_until` column for V1.

7. **Stripped-down page view for licensed providers.** Approved per
   § 3.4. Sidebar status badges are also suppressed for licensed
   providers.

8. **Soft-validate MiRegistry ID format.** Approved. Length / non-
   empty only; no regex.

9. **Level 2 expiration date input.** Approved with addition: a small
   "Last updated by you on [date]" timestamp displays next to the
   input so the provider knows whether the value is fresh or stale.
   See § 3.2 Training Level card affordances.

10. **CLAUDE.md update with December 16 + Level 2 mechanics.**
    Approved as mandatory in the same PR as the implementation, per
    `CLAUDE.md` § Documentation Conventions rule 3.

---

## After this PR ships

Recommended next-PR order (unchanged from `funding_source_spec.md`'s
post-PR roadmap, with the MiRegistry tracker landed):

1. CDC I-Billing reconciliation engine.
2. Tri-Share three-way invoice generator.
3. CDC handbook AI assistant.
4. Email-notification infrastructure (powers MiRegistry reminders +
   billing reminders + invoice notifications).
5. MiRegistry import / API integration.
