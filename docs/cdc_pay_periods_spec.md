# MILittleCare: CDC Pay Period Catalog & Payment Schedule Spec

**Status:** Approved 2026-05-15 — implementation is PR #5. Decisions recorded in § 9.
**Goal:** Give CDC providers a single screen that answers two questions
without leaving MILittleCare: *"what pay period are we in right now?"* and
*"when is the next reporting deadline and the next payment?"*

This is the **lightweight** version promised in
`docs/funding_source_spec.md` § Roadmap item 1 ("CDC pay period catalog +
payment schedule display, ~1 week"). It is deliberately read-only. It is the
**foundation for PR #6** (CDC I-Billing reconciliation), which adds the
per-period money math on top of the calendar this PR establishes.

Authoritative source for every date and rule cited here is
`docs/reference/Scholarship Handbook for License Exempt Provider.pdf`
(revised 2026-04-01): pages 29–30 (CDC 2025 / 2026 Payment Schedules),
page 17 (90-day billing window), page 19 (90-day revision window), and
page 9 (60-day retroactive authorization limit). The full 2025 and 2026
schedules are transcribed in Appendix A.

---

## 1. Context

### 1.1 What a CDC pay period is

CDC Scholarship billing runs on a **biweekly** cycle. MDHHS publishes a
**CDC Payment Schedule** once per calendar year. Each schedule has exactly
**26 pay periods**, and each period carries four facts:

| Fact | Example (period 610) | Meaning |
| --- | --- | --- |
| Pay period dates | May 3 – May 16, 2026 | The 14 days of care this period covers. |
| Pay period number | 610 | MDHHS's identifier. 3 digits; see § 1.2. |
| Reporting deadline | May 21, 2026 | The provider must submit billing in I-Billing by this date. |
| Check/EFT date | May 29, 2026 | The estimated date the payment is issued. |

Providers submit billing **per pay period** through the state's I-Billing
system. There is no per-provider variation: every CDC provider in Michigan
bills against the same 26 periods on the same dates. The schedule is a
**statewide constant**, not provider data.

### 1.2 Pay period numbering

Period numbers encode the year. 2025's periods are `501`–`526`; 2026's are
`601`–`626`. The hundreds digit is `year − 2020` (2025 → 5, 2026 → 6), and
the last two digits are the sequence `01`–`26`. 2027's schedule, once
published, will be `701`–`726`.

This convention matters: `period_number` **alone does not unambiguously
carry the year** without knowing the rule. The data model (§ 2) therefore
stores an explicit `schedule_year` rather than relying on the encoding.

### 1.3 The deadline windows that cost real money

Three handbook rules make this feature financially load-bearing. They are
easy to confuse, so they are stated precisely:

1. **90-day submission window** — handbook p.17: *"To receive payments,
   billing must be submitted within 90 days of care being authorized /
   provided."* Care not billed within 90 days becomes **permanently
   unbillable** — the revenue is simply lost.

2. **90-day revision window** — handbook p.19 (and *Provider Billing
   Help*): *"You may submit revised invoices up to 90 days after the end of
   the pay period."* An already-submitted invoice can be corrected — add a
   back-billed child, fix hours — up to 90 days **after the period ends**.
   After that the period's billing is frozen.

3. **60-day retroactive authorization limit** — handbook p.9: a provider
   *"will not be authorized for payments… back more than 60 days from when
   the MDHHS-4025 is received by MDHHS."* Provider authorization can reach
   back at most 60 days before MDHHS receives the signed MDHHS-4025. (This
   is distinct from the separate 30-day LEPPT rule for license-exempt
   providers — out of scope here.)

There is also a **7-day grace**: handbook p.22 says billing submitted after
the deadline but within 7 days of it is issued the following week. Past 7
days, payment waits until the next biweekly run; past 90 days (rule 1), it
is gone.

### 1.4 Why this matters operationally

The state does not remind providers of deadlines. Providers track pay
periods today on a printed PDF or from memory. A missed reporting deadline
delays cash flow by at least one biweekly cycle; a missed 90-day window is
unrecoverable lost income. For a CDC-primary provider — the norm, not the
exception (see `CLAUDE.md` § Critical Domain Knowledge) — the pay-period
calendar *is* the revenue calendar. Surfacing "where are we, what's next,
how many days left" is high-leverage and low-risk: it is reference data
plus a countdown.

---

## 2. Data Model

### 2.1 What already exists

`billing_periods` was created by migration `003_funding_sources.sql`. Its
columns: `id`, `user_id`, `funding_type`, `period_number`, `start_date`,
`end_date`, `reporting_deadline`, `status` (enum
`upcoming|open|submitted|paid|reconciled`), `submitted_at`,
`expected_payment_date`, `actual_payment_date`, `actual_payment_amount`,
`created_at`, `updated_at`. It has **no `archived_at`** (migration 003
explicitly calls these rows "operational, not audit-retained").

`docs/funding_source_spec.md` § 5 (`BillingPeriod`) describes the original
intent: *"CDC periods seed from the official MiLEAP payment schedule
(publish annually; we hardcode the 2026 schedule for V1)."* That entity is
**per-provider** (`provider_id` / `user_id` not null).

### 2.2 The problem with per-provider seeding

The three seeding options in play:

| Option | Shape | Cost |
| --- | --- | --- |
| (a) Seed 26 rows per CDC provider at first login | per-user `billing_periods` | 26 × every provider; statewide constant duplicated N times |
| (b) Lazy-seed 26 rows on first CDC funding source creation | per-user `billing_periods` | same duplication, just deferred |
| (c) Shared catalog table (no `user_id`) + per-user status table | split | one row per period statewide; status separate |

Options (a) and (b) both copy a **statewide constant** into every
provider's rows. When MDHHS publishes the 2027 schedule, (a)/(b) require
writing 26 rows into *every* provider's `billing_periods` (a backfill
against production — exactly the operation `CLAUDE.md` says to avoid
without review). They also make "is the schedule up to date for this
provider?" a per-provider question, which it is not.

**This PR's V1 is read-only (§ 4).** A read-only display writes nothing,
so it needs **no per-user rows at all**. The only thing V1 needs is the
schedule itself.

### 2.3 Recommendation — a statewide catalog table

Add a new table that holds the published schedule once, statewide, modelled
on `tri_share_hubs` (shared reference data, readable by all authenticated
users, written server-side / by migration only):

```sql
-- proposed migration 010_cdc_pay_period_catalog.sql
create table public.cdc_pay_period_catalog (
  id                      uuid default gen_random_uuid() primary key,
  schedule_year           integer not null,   -- 2025, 2026, …
  period_number           integer not null,   -- 501–526, 601–626, …
  start_date              date not null,
  end_date                date not null,
  reporting_deadline      date not null,
  deadline_is_4pm         boolean not null default false,  -- handbook '*'
  expected_payment_date   date not null,
  payment_may_be_delayed  boolean not null default false,  -- handbook '**'
  created_at              timestamptz not null default now(),
  constraint cdc_pay_period_catalog_dates_ordered
    check (end_date >= start_date),
  unique (schedule_year, period_number)
);

alter table public.cdc_pay_period_catalog enable row level security;

create policy "Authenticated users can view the CDC pay period catalog"
  on public.cdc_pay_period_catalog for select
  to authenticated using (true);
-- No insert/update/delete policies: seeded by migration, maintained
-- server-side. Mirrors tri_share_hubs.
```

The migration also **seeds all 52 rows** (2025 + 2026) inline — the same
pattern as `006_backfill_private_pay.sql`, but inserting a public constant
rather than user data, so it carries no per-provider review risk. The
`deadline_is_4pm` / `payment_may_be_delayed` booleans capture the `*` and
`**` annotations from the handbook so the UI can render "deadline 4:00 PM"
and "payment may be delayed (holiday)" accurately.

**`billing_periods` is left untouched by this PR.** It stays in the schema,
empty, reserved for PR #6 / V2 per-user lifecycle state (§ 8). V1 does not
write to it.

A leaner alternative — shipping the schedule as a static JS constant in
`src/lib/cdcPayPeriods.js` with no table at all — was considered and
rejected: PR #6 reconciliation will want to join period facts in SQL, and
the catalog updates yearly without a code deploy. See § 9 decision 1.

### 2.4 Derived state (no schema; computed in app code)

Everything the UI shows is derived from the catalog by pure functions in
`src/lib/cdcPayPeriods.js` (mirroring `src/lib/miregistry.js`):

- **`getCurrentPeriod(today, catalog)`** — the row whose
  `[start_date, end_date]` contains `today`, searched across all loaded
  `schedule_year`s. May be `null` (see § 7).
- **`getNextPeriod(today, catalog)`** — the row with the smallest
  `start_date > today`.
- **`getPeriodDisplayStatus(period, today)`** — a date-derived label, *not*
  the `billing_periods.status` enum:
  - `upcoming` — `start_date > today`
  - `current` — `start_date ≤ today ≤ end_date`
  - `open_for_billing` — `end_date < today ≤ reporting_deadline`
  - `billing_closed` — `reporting_deadline < today`
- **`getDeadlineCountdown(period, today)`** — whole days until
  `reporting_deadline`.

These are unit-tested with Vitest, like `modules.js` and
`fundingDocuments.js`.

---

## 3. UI / UX

### 3.1 Where it lives

**New page:** `src/pages/CdcPayPeriodsPage.jsx` at route
`/cdc-pay-periods`.

**Sidebar:** a new entry in the existing **Compliance** section of
`src/components/dashboard/Sidebar.jsx` (which already holds "MiRegistry"):

```js
{ label: 'CDC Pay Periods', icon: CalendarClock, path: '/cdc-pay-periods',
  roles: ['licensee', 'adult_staff'], module: MODULE_KEYS.CDC }
```

Naming: the page is **not** called "Payments" and does **not** live on
`/billing`. `/billing` is the parent-invoicing surface; "payment" there
means a family paying the provider. Merging CDC state-reporting into it
would violate the module-activation principle (a private-pay-only provider
on `/billing` must never see "CDC"). The handbook term is "Pay Period," so
the label is "CDC Pay Periods." The word "CDC" in the label is fine here —
the entry only renders for providers with the CDC module active.

**No dashboard widget in V1.** A "current pay period" glance card on the
home dashboard is genuinely useful, but the MiRegistry spec deferred its
widget to V2 for the same reason (dashboard composition patterns aren't
settled), and `docs/strategy.md` puts the aggregate compliance widget at
V3+. Deferred to V2 (§ 8).

### 3.2 Page layout

Two hero cards (current + next), then the full 26-row schedule for the
selected year, with the current period highlighted. ASCII mock, drawn as of
**today, 2026-05-15** (which falls inside period 610):

```
┌─ CDC Pay Periods ──────────────────────────  Year: [ 2026 ▾ ] ─┐
│                                                                  │
│  ┌─ Current pay period ───────────────────────────────────────┐ │
│  │  Period 610            May 3 – May 16, 2026                 │ │
│  │  ● Open — care days in progress                             │ │
│  │  Report by:        Thu May 21, 2026     (6 days left)       │ │
│  │  Est. payment:     Fri May 29, 2026     ⚠ holiday delay     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─ Next pay period ──────────────────────────────────────────┐ │
│  │  Period 611            May 17 – May 30, 2026                │ │
│  │  Report by:        Thu Jun 4, 2026                          │ │
│  │  Est. payment:     Thu Jun 11, 2026                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ─── 2026 schedule — 26 pay periods ──────────────────────────  │
│  ┌─────┬──────────────────────┬───────────────┬───────────────┐ │
│  │  #  │ Pay period dates     │ Report by     │ Est. payment  │ │
│  ├─────┼──────────────────────┼───────────────┼───────────────┤ │
│  │ 601 │ Dec 28 – Jan 10      │ Jan 15        │ Jan 23   ⚠    │ │
│  │  …  │                      │               │               │ │
│  │ 609 │ Apr 19 – May 2       │ May 7         │ May 14        │ │
│  │▶610◀│ May 3 – May 16       │ May 21        │ May 29   ⚠    │ │  ← highlighted
│  │ 611 │ May 17 – May 30      │ Jun 4         │ Jun 11        │ │
│  │  …  │                      │               │               │ │
│  │ 626 │ Dec 13 – Dec 26      │ Dec 29        │ Jan 7, 2027   │ │
│  └─────┴──────────────────────┴───────────────┴───────────────┘ │
│  ⚠ payment may be delayed by a holiday   * deadline is 4:00 PM   │
│                                                                  │
│  ⓘ This schedule is published by MDHHS. MILittleCare shows it    │
│     for reference — you still submit billing in I-Billing.       │
└──────────────────────────────────────────────────────────────────┘
```

Past periods render in a muted style; `current` is highlighted;
`open_for_billing` periods (ended, deadline not yet passed) get a small
"still billable" marker because that is the state a provider most needs to
catch.

### 3.3 Mobile / narrow widths

The 4-column schedule table does not fit a phone. Below ~640px:

- The two hero cards stack vertically (already single-column).
- The schedule table collapses to a **vertical list of compact period
  cards**, one per period: number + date range on the first line, "Report
  by" and "Est. payment" stacked beneath. This mirrors how the funding
  source list degrades on narrow widths.
- The year selector stays pinned at the top.
- No horizontal scrolling of a data table — that pattern tests poorly with
  the target users.

### 3.4 Empty / edge states

- **Provider has no CDC module active** — the page and sidebar entry do not
  render at all (§ 5). Not an empty state; the route would redirect.
- **Selected year has no catalog rows** (e.g. provider opens the app in
  early 2027 before that schedule is seeded) — the page shows an
  explanatory card with this copy: *"MDHHS hasn't published the 2027 CDC
  pay period schedule yet. The 2026 schedule ended with period 626 on
  December 26, 2026. Check Michigan.gov CDC Payment Schedule for the
  latest."* The phrase "Michigan.gov CDC Payment Schedule" links to
  `https://www.michigan.gov/mileap/early-childhood-education/early-learners-and-care/cdc/providers`.
  See § 7.
- **Today is between the last loaded period and the next year's schedule**
  — `getCurrentPeriod` returns `null`; the Current card shows the
  schedule-not-published copy instead of a period.

### 3.5 Inline help (required — `CLAUDE.md` § Documentation Conventions 1)

- An info icon on the page header explaining what a pay period is and that
  MILittleCare displays, but does not submit, billing.
- A tooltip on "Report by" stating the 90-day submission rule in plain
  language and what "4:00 PM deadline" means for starred dates.
- A tooltip on "Est. payment" explaining the `⚠` holiday-delay marker.
- Empty-state copy carries the "what is this / how do I use it" guidance.

---

## 4. V1 Scope — read-only, and why

**Recommendation: V1 is read-only display only. No "Mark submitted," no
"Mark paid," no writes.** This agrees with the stated lean, and the
reasoning is worth recording:

1. **The roadmap promise is satisfied by display alone.**
   `funding_source_spec.md` § Roadmap item 1 asks for providers to see
   "what's the current pay period? when's the next one?" — that is a
   read-only question.

2. **A write needs the whole per-user apparatus.** "Mark submitted" means
   creating `billing_periods` rows on demand, RLS, optimistic UI, and
   conflict handling — real cost, none of it serving the display.

3. **"Mark submitted" without "Mark paid" is half a workflow.** A lone
   boolean that records "I think I submitted this" reconciles nothing. The
   value of submitted/paid tracking only appears when it is checked
   *against* something — billed hours, expected vs actual payment — and
   that is precisely PR #6 (reconciliation).

4. **`docs/strategy.md` says so.** It explicitly deprioritizes "pure
   billing prep without the compliance layer behind it." A status checkbox
   with no reconciliation behind it is that. Ship the calendar; add writes
   when they connect to the compliance layer.

5. **Ship and learn.** Let Venessa use the schedule display for a week of
   real billing. The write actions she actually reaches for will inform V2
   far better than guessing now.

The counter-argument — providers may want to tick periods off for a sense
of progress — is real but weak: that is cosmetic without reconciliation,
and PR #6 delivers the genuine version. **Resolved: read-only V1 — see
§ 9 decision 4.**

---

## 5. Module Activation

**Gated by `MODULE_KEYS.CDC`.** The sidebar entry and route render only
when the CDC module is active for the provider.

The good news: **no change to `src/lib/modules.js` is required.** CDC is
already a module key, and `getActiveModules` already activates it when the
provider has an active, non-archived funding source of type
`cdc_scholarship` (`TYPE_TO_MODULE` mapping), or when
`program_settings.cdc === 'force_on'`. The pay-periods page simply consumes
the existing key. (Contrast PR #4, which had to *add* a `modules.js`
activation branch for the MiRegistry tracker.)

**Not auto-activated for license-exempt status.** This is the deliberate
difference from the MiRegistry tracker. MiRegistry training deadlines apply
to *every* license-exempt provider regardless of how their kids are funded,
so the tracker activates on `is_license_exempt`. Pay periods, by contrast,
are **CDC-specific** — they are meaningless to a provider with no CDC
children. So activation keys off "has CDC funding," not "is license
exempt." A license-exempt provider with zero CDC kids correctly sees
nothing; a *licensed* (non-exempt) provider who bills CDC correctly sees
the page (the 2025/2026 schedule is identical for licensed and
license-exempt providers — see § 9 decision 10).

Net: the activation rule is "provider has the CDC module active," full
stop. Same gate as any other CDC feature.

---

## 6. State Modernization Survival

`docs/strategy.md` § "State modernization hedge" warns that Michigan may
modernize I-Billing in 2–5 years, and that features should live in the
**intelligence layer**, not replicate the state's workflow UI. Assessed
honestly against this PR:

### Durable — survives modernization

- **The pay period catalog itself.** A clean, queryable model of Michigan's
  CDC reporting calendar is reference/temporal intelligence. A modernized
  I-Billing still has pay periods and deadlines; a local catalog keeps
  powering reminders, audit-packet date ranges, reconciliation, and
  revenue forecasting regardless of what the state's portal looks like.
- **Deadline awareness — countdowns, "N days left," the 90-day-window
  warnings planned for V2.** This is compliance intelligence. It survives.
- **The reconciliation hooks PR #6 builds on this calendar** (period ↔
  attendance ↔ billed hours ↔ expected payment). That is squarely the
  "intelligence layer" the strategy says to invest in.

### State-mimicry — avoid or keep deprioritized

- Replicating the I-Billing **submission screens** — period picker styled
  like the portal, a "Submit to MiLEAP" button. V1 is read-only and builds
  none of this; that is the right call. Do not add it.
- A V2 "mark submitted / mark paid" ledger is **conditionally durable**: it
  is worth building *only* as an input to reconciliation/analytics (the
  compliance layer). As standalone box-ticking that mirrors what the state
  portal already records, it is exactly the workflow duplication the
  strategy says to deprioritize — and a modernized I-Billing exposing a
  status API would obsolete it outright. V2 should therefore design those
  writes to be **easily superseded by an import** (the way
  `miregistry_event_id` is a deliberate V2 import hook).

### Explicit verdict

**100% of V1 is durable.** Read-only schedule display + current/next
highlight + deadline countdown is reference data and compliance
intelligence — no part of it is state-UI mimicry. The first feature that
could drift into state-mimicry is the V2 write layer, and § 8 flags it
accordingly.

---

## 7. Validation / Data Integrity — year boundaries

### 7.1 A period "belongs to" a schedule year by its number, not its dates

Period 601 runs **Dec 28, 2025 – Jan 10, 2026** — its care dates straddle
Jan 1 — but it is the first period of the **2026** schedule. So a period's
`schedule_year` is fixed by MDHHS's numbering, not by which calendar year
`start_date` lands in. This is why § 2.3 stores `schedule_year` explicitly.

(Note on the framing in the task: it is **601**, not 526, whose *care
dates* cross the year boundary. Period 526 runs Dec 14–27, 2025 — fully in
2025 — but its *reporting deadline* (Jan 1, 2026) and *payment* (Jan 8,
2026) fall in 2026. Both kinds of boundary-crossing are handled below.)

### 7.2 "Current period" must search across schedule years

Because period 601 covers late December 2025, finding "the period
containing today" cannot be scoped to a single `schedule_year`.
`getCurrentPeriod` searches **all loaded years' rows** for the one whose
`[start_date, end_date]` contains today. The year selector (§ 3.2) controls
only which year's *table* is displayed; it does not constrain the
current/next hero cards.

### 7.3 Deadlines and payments routinely fall in the next calendar year

Period 526's deadline and payment are in January 2026; period 626's payment
(Jan 7, 2027) is in 2027. The UI displays each date as-is and shows the
year whenever it differs from the period's `schedule_year` (e.g.
"Jan 7, 2027"). No special logic — just don't assume a period's dates are
all within its `schedule_year`.

### 7.4 What "current period" means on Dec 31

On, say, **Dec 31, 2026**, today is past period 626 (ends Dec 26, 2026).
The period actually containing Dec 31, 2026 is **701** — the first period
of the 2027 schedule — which **MDHHS will not have published** until late
2026 / early 2027. So between the last loaded period's `end_date` and the
next schedule being seeded, `getCurrentPeriod` returns `null` **by
design**. The UI handles this with the schedule-not-published state
(§ 3.4): it names the last known period and links to the Michigan.gov
schedule, rather than showing a wrong or blank "current period."

### 7.5 Contiguity check at seed time

Within and across years the periods are contiguous with no gaps or
overlaps: 526 ends Dec 27, 2025 and 601 starts Dec 28, 2025; 501 starts
Dec 29, 2024. The seed migration (or a Vitest test over the seed data)
**asserts** that, ordered by `start_date`, each period's `start_date` is
exactly the previous `end_date` + 1 day. A gap or overlap means a
transcription error in Appendix A and must fail loudly before reaching
production.

### 7.6 Timezone

All catalog columns are plain `date`. "Today" is computed as the device's
local calendar date — reuse the `todayYMD()`-style pattern already used by
the funding source form and the MiRegistry tracker, which derives the
year-month-day from local time and does no UTC-midnight math, so the
"current period" boundary never shifts by a day. Local timezone is the
right choice for V1; in the rare case a Michigan provider has a device set
to a non-Eastern timezone, they'll see the same calendar date that any
reasonable interpretation would give. Future: if/when CDC providers
operate cross-border, add explicit Michigan-time computation.

---

## 8. Phasing

### V1 — this PR (PR #5)

1. Migration `010_cdc_pay_period_catalog.sql` — new `cdc_pay_period_catalog`
   table + RLS, seeded inline with all 52 rows (2025 + 2026) from
   Appendix A. Per the new `CLAUDE.md` schema-verification convention, its
   `docs/runbook.md` entry is **not written until Seth has personally run
   the verification queries in the Supabase dashboard and saved
   screenshots** (the new step 4 of the Migration Application Procedure).
2. Pure helpers in `src/lib/cdcPayPeriods.js` with Vitest tests:
   `getCurrentPeriod`, `getNextPeriod`, `getPeriodDisplayStatus`,
   `getDeadlineCountdown`, plus the § 7.5 contiguity assertion.
3. New `src/pages/CdcPayPeriodsPage.jsx` — layout per § 3.2, read-only.
4. New `src/components/cdc/PayPeriodTable.jsx` (and a narrow-width card
   variant per § 3.3).
5. Sidebar entry in the Compliance section, gated `MODULE_KEYS.CDC`.
6. Route registration in `src/App.jsx` (`/cdc-pay-periods`).
7. Inline help per § 3.5.
8. Documentation: this spec, the runbook entry for migration 010, a
   `docs/tech_debt.md` entry for any deferred work.

No change to `src/lib/modules.js` (§ 5). No change to `billing_periods`.

### V2 — future PRs

- **Per-user lifecycle writes** — "Mark submitted" / "Mark paid," using the
  existing `billing_periods` columns (`status`, `submitted_at`,
  `actual_payment_date`, `actual_payment_amount`). `billing_periods` rows
  created lazily, per provider, only for periods actually acted on.
- **Payment amount tracking** — record expected vs actual; surface
  variance.
- **Reconciliation hooks for PR #6** — associate attendance + billed hours
  per child with a pay period; this is where the catalog and
  `billing_periods` join.
- **90-day-window warnings** — "Period 605 closes for billing in 12 days,"
  driven by the rules in § 1.3.
- **Dashboard "current pay period" widget** (§ 3.1).
- **Email reminders** before reporting deadlines — depends on the email
  infrastructure also needed by the MiRegistry tracker (`miregistry_tracker_spec.md`
  § 6).

### V3+

- Pay-period reporting status becomes one signal in the aggregate
  **Compliance Health Score** (`docs/strategy.md`).

---

## 9. Decisions recorded

Resolved in spec review on 2026-05-15:

1. **Shared catalog table.** Approved. Add `cdc_pay_period_catalog`
   (statewide, no `user_id`) per § 2.3, modelled on `tri_share_hubs`. This
   inverts the earlier lean toward lazy-seeding per-user `billing_periods`,
   and diverges from `funding_source_spec.md` § 5's per-provider intent —
   the reference-data-vs-operational-state distinction is the correct
   architecture. The static-JS-constant alternative was rejected (PR #6
   wants SQL joins; the catalog updates yearly without a deploy).

2. **`billing_periods` untouched.** Approved. This PR does not read or
   write `billing_periods`; it is reserved for PR #6 per-user lifecycle
   state.

3. **Route and label.** Approved. Route `/cdc-pay-periods`; sidebar label
   "CDC Pay Periods" in the existing Compliance section.

4. **Read-only V1.** Approved. No "Mark submitted" / "Mark paid" / writes.
   See § 4 for the argument.

5. **Seed both years.** Approved. The seed migration loads 2025 and 2026
   (52 rows).

6. **Annual catalog updates via runbook, no `/schedule` routine.** Approved
   with the routine dropped as overengineering for V1. The mechanism: each
   Q4, transcribe the newly published MDHHS schedule into a small seed
   migration, apply it via the Supabase dashboard, and verify with the
   § 7.5 contiguity check. Captured as a recurring entry in
   `docs/tech_debt.md` so the procedure is not forgotten in Q4 2027.

7. **Holiday markers.** Approved. Keep the `deadline_is_4pm` and
   `payment_may_be_delayed` booleans on the catalog.

8. **Schedule-not-published state.** Approved with revised copy (now in
   § 3.4): *"MDHHS hasn't published the 2027 CDC pay period schedule yet.
   The 2026 schedule ended with period 626 on December 26, 2026. Check
   Michigan.gov CDC Payment Schedule for the latest."* — MDHHS named, with
   a real Michigan.gov link.

9. **Provider-global, not per-child.** Approved. V1 shows one schedule for
   the whole provider; per-child billed status is PR #6.

10. **No license-exempt gating.** Approved. The page renders for any
    provider with the CDC module active; the schedule is identical for
    licensed and license-exempt providers.

11. **Migration number `010`, sequential.** Approved. This PR's migration
    is `010_cdc_pay_period_catalog.sql`. Migration numbering is sequential,
    not categorical: the informal "`010_` onward reserved for retroactive
    backfills" note in `docs/tech_debt.md` is removed in this commit; the
    retroactive cleanup, whenever it happens, takes the next free number at
    that time.

12. **New page location.** Approved. `src/pages/CdcPayPeriodsPage.jsx`, per
    the `CLAUDE.md` file-structure convention. A separate `docs/tech_debt.md`
    entry (added in this commit) tracks relocating the pre-existing
    misplaced `src/ReceiptsPage.jsx` into `src/pages/` in a future cleanup
    PR — out of scope here.

---

## Appendix A — Pay period schedules (seed data)

Transcribed from `docs/reference/Scholarship Handbook for License Exempt
Provider.pdf`, pages 29 (2025) and 30 (2026). `*` = reporting deadline is
4:00 PM that day (otherwise midnight). `**` = payment may be delayed by a
holiday.

### A.1 — 2025 schedule (`schedule_year = 2025`)

| # | Pay period dates | Reporting deadline | Check / EFT |
| --- | --- | --- | --- |
| 501 | 2024-12-29 – 2025-01-11 | 2025-01-16 | 2025-01-24 ** |
| 502 | 2025-01-12 – 2025-01-25 | 2025-01-30 | 2025-02-06 |
| 503 | 2025-01-26 – 2025-02-08 | 2025-02-13 | 2025-02-21 ** |
| 504 | 2025-02-09 – 2025-02-22 | 2025-02-27 | 2025-03-06 |
| 505 | 2025-02-23 – 2025-03-08 | 2025-03-13 | 2025-03-20 |
| 506 | 2025-03-09 – 2025-03-22 | 2025-03-27 | 2025-04-03 |
| 507 | 2025-03-23 – 2025-04-05 | 2025-04-10 | 2025-04-17 |
| 508 | 2025-04-06 – 2025-04-19 | 2025-04-24 | 2025-05-01 |
| 509 | 2025-04-20 – 2025-05-03 | 2025-05-08 | 2025-05-15 |
| 510 | 2025-05-04 – 2025-05-17 | 2025-05-22 | 2025-05-30 ** |
| 511 | 2025-05-18 – 2025-05-31 | 2025-06-05 | 2025-06-12 |
| 512 | 2025-06-01 – 2025-06-14 | 2025-06-19 | 2025-06-26 |
| 513 | 2025-06-15 – 2025-06-28 | 2025-07-02 * | 2025-07-10 |
| 514 | 2025-06-29 – 2025-07-12 | 2025-07-17 | 2025-07-24 |
| 515 | 2025-07-13 – 2025-07-26 | 2025-07-31 | 2025-08-07 |
| 516 | 2025-07-27 – 2025-08-09 | 2025-08-14 | 2025-08-21 |
| 517 | 2025-08-10 – 2025-08-23 | 2025-08-28 | 2025-09-05 ** |
| 518 | 2025-08-24 – 2025-09-06 | 2025-09-11 | 2025-09-18 |
| 519 | 2025-09-07 – 2025-09-20 | 2025-09-25 | 2025-10-02 |
| 520 | 2025-09-21 – 2025-10-04 | 2025-10-09 | 2025-10-16 |
| 521 | 2025-10-05 – 2025-10-18 | 2025-10-23 | 2025-10-30 |
| 522 | 2025-10-19 – 2025-11-01 | 2025-11-06 | 2025-11-14 ** |
| 523 | 2025-11-02 – 2025-11-15 | 2025-11-19 * | 2025-11-26 |
| 524 | 2025-11-16 – 2025-11-29 | 2025-12-04 | 2025-12-11 |
| 525 | 2025-11-30 – 2025-12-13 | 2025-12-17 * | 2025-12-26 ** |
| 526 | 2025-12-14 – 2025-12-27 | 2026-01-01 | 2026-01-08 |

### A.2 — 2026 schedule (`schedule_year = 2026`)

| # | Pay period dates | Reporting deadline | Check / EFT |
| --- | --- | --- | --- |
| 601 | 2025-12-28 – 2026-01-10 | 2026-01-15 | 2026-01-23 ** |
| 602 | 2026-01-11 – 2026-01-24 | 2026-01-29 | 2026-02-05 |
| 603 | 2026-01-25 – 2026-02-07 | 2026-02-12 | 2026-02-20 ** |
| 604 | 2026-02-08 – 2026-02-21 | 2026-02-26 | 2026-03-05 |
| 605 | 2026-02-22 – 2026-03-07 | 2026-03-12 | 2026-03-19 |
| 606 | 2026-03-08 – 2026-03-21 | 2026-03-26 | 2026-04-02 |
| 607 | 2026-03-22 – 2026-04-04 | 2026-04-09 | 2026-04-16 |
| 608 | 2026-04-05 – 2026-04-18 | 2026-04-23 | 2026-04-30 |
| 609 | 2026-04-19 – 2026-05-02 | 2026-05-07 | 2026-05-14 |
| 610 | 2026-05-03 – 2026-05-16 | 2026-05-21 | 2026-05-29 ** |
| 611 | 2026-05-17 – 2026-05-30 | 2026-06-04 | 2026-06-11 |
| 612 | 2026-05-31 – 2026-06-13 | 2026-06-17 * | 2026-06-25 |
| 613 | 2026-06-14 – 2026-06-27 | 2026-07-01 * | 2026-07-09 |
| 614 | 2026-06-28 – 2026-07-11 | 2026-07-16 | 2026-07-23 |
| 615 | 2026-07-12 – 2026-07-25 | 2026-07-30 | 2026-08-06 |
| 616 | 2026-07-26 – 2026-08-08 | 2026-08-13 | 2026-08-20 |
| 617 | 2026-08-09 – 2026-08-22 | 2026-08-27 | 2026-09-03 |
| 618 | 2026-08-23 – 2026-09-05 | 2026-09-10 | 2026-09-17 |
| 619 | 2026-09-06 – 2026-09-19 | 2026-09-24 | 2026-10-01 |
| 620 | 2026-09-20 – 2026-10-03 | 2026-10-08 | 2026-10-16 ** |
| 621 | 2026-10-04 – 2026-10-17 | 2026-10-22 | 2026-10-29 |
| 622 | 2026-10-18 – 2026-10-31 | 2026-11-05 | 2026-11-13 ** |
| 623 | 2026-11-01 – 2026-11-14 | 2026-11-19 | 2026-12-01 ** |
| 624 | 2026-11-15 – 2026-11-28 | 2026-12-03 | 2026-12-10 |
| 625 | 2026-11-29 – 2026-12-12 | 2026-12-17 | 2026-12-28 ** |
| 626 | 2026-12-13 – 2026-12-26 | 2026-12-29 | 2027-01-07 |

Both years are 26 periods, contiguous with no gaps or overlaps (§ 7.5).
The handbook publishes a fresh schedule annually; 2027 (`701`–`726`) is
seeded when MDHHS releases it (OQ6).
```
