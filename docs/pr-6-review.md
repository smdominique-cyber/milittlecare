# PR #6 Review — CDC Pay Period Catalog

Branch: `feature/cdc-pay-period-catalog`
Spec: `docs/cdc_pay_periods_spec.md` (approved 2026-05-15)
Built: 2026-05-16, autonomously, against the spec's 12 resolved decisions (§ 9).

This document is committed on its own. **Every other file in this PR is
present in the working tree but uncommitted** — review this doc, mark up
revisions, send the markup back, and the changes get applied to the
still-uncommitted files in one pass before the final commit.

> **Note on the PR number.** The spec (`cdc_pay_periods_spec.md` § 3 header,
> § 8, and the `docs/tech_debt.md` § "Annual CDC pay period catalog update"
> entry) calls this work **PR #5**. The build task called it **PR #6**, so
> this review doc and the branch use #6. The actual GitHub PR will get the
> next sequential GitHub number (≈ #9). Flagged under *Uncertain calls* — the
> spec text was not edited, to avoid churning a merged spec without a call.

---

## Files changed

### New files

| File | Lines | Description |
| --- | ---: | --- |
| `supabase/migrations/010_cdc_pay_period_catalog.sql` | 170 | New statewide `cdc_pay_period_catalog` table, one index, RLS (select-only), inline seed of all 52 rows (2025 + 2026), commented Down section. |
| `src/lib/cdcPayPeriods.js` | 213 | Pure helpers: `getCurrentPeriod`, `getNextPeriod`, `getPeriodDisplayStatus`, `getDeadlineCountdown`, `findCatalogContiguityGaps`, `todayYMD`, `PERIOD_STATUS`. No React, no Supabase. |
| `src/lib/cdcPayPeriods.test.js` | 328 | 36 Vitest tests, including the § 7.5 contiguity assertion over an independent 52-row transcription of Appendix A. |
| `src/pages/CdcPayPeriodsPage.jsx` | 662 | The page: two hero cards, year selector, 26-row schedule, empty states, inline help, module-gate redirect. |
| `src/components/cdc/payPeriodFormat.js` | 76 | Shared date-formatting helpers for the three CDC surfaces. |
| `src/components/cdc/PayPeriodTable.jsx` | 202 | Desktop 4-column schedule table. |
| `src/components/cdc/PayPeriodCard.jsx` | 153 | Narrow-width (≤ 640px) single-period card. |

### Modified files

| File | Change |
| --- | --- |
| `src/App.jsx` | +2 lines — import `CdcPayPeriodsPage`, register route `cdc-pay-periods`. |
| `src/components/dashboard/Sidebar.jsx` | +2 lines — `CalendarClock` import; "CDC Pay Periods" entry in the Compliance section, gated `MODULE_KEYS.CDC`, roles `['licensee', 'adult_staff']`. |
| `docs/runbook.md` | +66 lines — **draft** Migration History entry for migration 010, marked pending production application. |
| `docs/tech_debt.md` | +23 lines — "Deferred work introduced by PR #6" section. |

`docs/pr-6-review.md` (this file) is the only committed file.

---

## Migration status

**Not applied locally. Local Supabase is not set up in this repo.** There is
no `supabase/config.toml` — only `supabase/migrations/` and a stray
`supabase/.temp/cli-latest`. `supabase db reset` / `supabase start` cannot be
run without initialising a local stack (Docker), and the build task said not
to block on that.

The migration was therefore validated **without a database**, via the Vitest
contiguity suite:

- `src/lib/cdcPayPeriods.test.js` contains a 52-row fixture transcribed from
  `cdc_pay_periods_spec.md` Appendix A **independently of** the SQL seed in
  the migration file. `findCatalogContiguityGaps` is asserted to return `[]`
  over that fixture — every period's `start_date` is exactly the previous
  period's `end_date + 1`, with no gap or overlap across the 2025→2026
  boundary (spec § 7.5). Two transcriptions agreeing is decent confidence;
  the production verification queries below are the real check.

The migration is **pending production application** by Seth, via the Supabase
web SQL editor, per the runbook's Migration Application Procedure (step 4 —
user-visible dashboard verification). The runbook entry is a draft until that
evidence exists. Expected verification queries are listed in the draft
runbook entry (`docs/runbook.md` § "Migration 010").

---

## Tests

`npx vitest run` — **147 passed (147), 6 files.** No failures.

- New: `src/lib/cdcPayPeriods.test.js` — **36 tests**:
  - `getCurrentPeriod` — boundary inclusivity, year-boundary period (601),
    cross-year search, null past the last period / before the first, empty
    catalog, today-default.
  - `getNextPeriod` — strictly-greater semantics, year-boundary crossing,
    null at end of schedule, first-period-when-before-schedule.
  - `getPeriodDisplayStatus` — all four states, each boundary inclusive,
    a full upcoming → current → open_for_billing → billing_closed walk.
  - `getDeadlineCountdown` — whole-day count, 0 on the deadline, negative
    after, DST-boundary correctness (UTC math).
  - `findCatalogContiguityGaps` — the § 7.5 seed-data assertion, 52-row /
    26-per-year count, period-number↔year encoding, injected gap + overlap
    detection.
- Pre-existing 111 tests still pass.
- `npm run build` succeeds (the dynamic-import and 500 kB chunk warnings are
  pre-existing and unrelated).
- `npm run lint` was **not** run — ESLint has no config file in this repo
  (`docs/tech_debt.md` § "ESLint configuration is missing"). Verified via
  build + Vitest instead, as in PR #5.

---

## Copy strings for final approval

| Element | Proposed copy |
| --- | --- |
| Page header | CDC Pay Periods |
| Sidebar label | CDC Pay Periods |
| Header help tooltip | A CDC pay period is the 14-day window of care you bill to MDHHS through I-Billing. MDHHS publishes 26 pay periods a year. MILittleCare shows the schedule for reference and counts down your reporting deadlines — billing must be submitted within 90 days of care, or that period’s payment is lost. You still submit your billing in I-Billing; this page does not send anything to the state. |
| Year selector label | Year: |
| Current period card label | Current pay period |
| Current card status pill | Open — care days in progress |
| Current card — no active period | No active pay period |
| Current card — no-period body | No pay period covers today’s date. The 2026 schedule ended with period 626 on Dec 26, 2026. Check Michigan.gov CDC Payment Schedule for the latest. |
| Next period card label | Next pay period |
| Next card — none published | No later pay period has been published yet. |
| Hero/card date labels | Report by · Est. payment |
| Deadline 4:00 PM suffix (hero) | (4:00 PM) |
| Holiday-delay chip (hero) | may be delayed by a holiday |
| Countdown phrasings | N days left · 1 day left · due today · 1 day ago · N days ago |
| Table column headers | # · Pay period dates · Report by · Est. payment |
| Table/card row badges | Current · Still billable |
| "Report by" tooltip | The date MDHHS must receive your billing in I-Billing for this period. Billing has to be submitted within 90 days of the care — after that the period’s payment is permanently lost. A deadline marked * closes at 4:00 PM that day; the rest close at midnight. |
| "Est. payment" tooltip | The estimated check or EFT date, assuming you bill on time. A ⚠ marks a payment that may be delayed by a holiday — treat that date as approximate. |
| Schedule section heading | {year} schedule — {N} pay periods |
| Legend | ⚠ payment may be delayed by a holiday · * reporting deadline closes at 4:00 PM |
| Schedule-not-published (empty) | MDHHS hasn’t published the {year} CDC pay period schedule yet. The {lastYear} schedule ended with period {lastNumber} on {lastEndDate}. Check Michigan.gov CDC Payment Schedule for the latest. We add each new year’s schedule once MDHHS posts it. |
| Footer reference note | This schedule is published by MDHHS. MILittleCare shows it for reference — you still submit your billing in I-Billing. |
| Fetch error | Couldn’t load the CDC pay period schedule. Refresh the page, or email support@milittlecare.com if it keeps happening. |

"Michigan.gov CDC Payment Schedule" links to the MiLEAP CDC providers page
(`https://www.michigan.gov/mileap/early-childhood-education/early-learners-and-care/cdc/providers`),
per spec § 3.4.

---

## Design decisions made

Choices not literally dictated by the spec:

1. **Extra file `src/components/cdc/payPeriodFormat.js`.** Three surfaces
   (page, table, card) need identical date formatting. Putting the
   formatters there keeps `src/lib/cdcPayPeriods.js` as exactly the pure
   *logic* the spec § 2.4 and the Vitest suite target. Alternative:
   triplicate the formatters, or fold UI formatting into the logic module.

2. **Module-gate redirect.** Spec § 3.4 / § 5 say a non-CDC provider's route
   "would redirect." The closest precedent, `MiRegistryPage.jsx`, does *not*
   redirect — it self-handles its states. I implemented the redirect
   (`<Navigate to="/dashboard" replace />`), gated on
   `useActiveModules().loading` so it never fires during the initial load.
   See *Uncertain calls* — confirm you want the redirect.

3. **One extra index.** Spec § 2.3's SQL specified only the
   `unique (schedule_year, period_number)` constraint. I added
   `cdc_pay_period_catalog_year_start_idx` on `(schedule_year, start_date)`
   for the year-table and current/next scans. The catalog is 52 rows, so
   this is about intent and PR-#7 join paths, not present-day performance.

4. **Schedule-not-published copy is generated, not hard-coded.** Spec § 3.4
   (OQ8) gives literal copy naming 2027 / 2026 / period 626 / Dec 26. I
   render it dynamically from the last seeded period, so it stays correct
   for any future year. For `year = 2027` it produces the exact § 3.4
   sentence, plus one trailing line — "We add each new year's schedule once
   MDHHS posts it." — added as empty-state "how to use it" guidance
   (§ 3.5 requires empty states to carry that).

5. **Narrow-width switch via a `matchMedia` hook**, not CSS media queries.
   The codebase styles these components entirely with inline `style={{}}`
   and has no stylesheet for them; a `useIsNarrow()` hook (640px, spec
   § 3.3) fits that grain.

6. **Hero cards kept inline in the page file** (`CurrentPeriodCard`,
   `NextPeriodCard`, `HeroDateRow`, `ScheduleNotPublishedCard`), following
   `MiRegistryPage.jsx`'s precedent of inline page-specific cards.

7. **Per-column tooltips on the desktop table headers only.** The "Report
   by" / "Est. payment" tooltips (§ 3.5) sit on the table's `<th>`s. The
   narrow-width card layout omits per-card tooltips — 26× repetition is
   clutter — and relies on the comprehensive page-header help plus the
   legend, which cover the same ground.

8. **Year display rule.** Deadline / payment cells show the year only when
   it differs from the period's `schedule_year` (e.g. "Jan 7, 2027"); the
   care-window date range never shows years — both match the § 3.2 mock.

---

## Deviations from spec

**None from the § 9 decisions.** All 12 are honoured: shared catalog table
(1), `billing_periods` untouched (2), route + label (3), read-only V1 (4),
both years seeded (5), no `/schedule` routine (6), holiday-marker booleans
(7), revised not-published copy (8), provider-global (9), no license-exempt
gating (10), migration number 010 (11), page under `src/pages/` (12).

The two items beyond the literal spec — the `payPeriodFormat.js` file and the
extra index — are additions, not contradictions; see *Design decisions* 1 and
3. The one-sentence addition to the not-published copy is *Design decision* 4.

---

## Uncertain calls flagged for review

1. **PR number drift.** The merged spec and a `tech_debt.md` entry call this
   "PR #5"; the build task called it "PR #6"; the GitHub PR will be ≈ #9. I
   did not edit the spec/tech_debt text. Decide the canonical numbering and
   whether the spec should be corrected in a follow-up.

2. **Redirect vs. precedent** (*Design decision* 2). `MiRegistryPage` does
   not redirect non-module providers; this page does, because the spec asks
   for it. Confirm that's what you want, or say so and I'll match
   `MiRegistryPage` (render-anyway).

3. **`CdcPayPeriodsPage.jsx` is 662 lines.** That's within codebase norms —
   `MiRegistryPage.jsx` is 692 with the same inline-cards-plus-inline-styles
   pattern — and ~210 of those lines are style constants. If you'd rather
   the four hero/empty-state sub-components move into `src/components/cdc/`,
   that's a quick change; flagging it because the task asked me to.

4. **CSS-variable tokens.** New code uses `--clr-sage`, `--clr-sage-dark`,
   `--clr-sage-pale`, `--clr-cream`, `--clr-warm-mid`, `--clr-ink-*`,
   `--clr-danger*` — all already used by `MiRegistryPage.jsx`, so they
   exist. One token, `--clr-warn-dark`, is new; it's used with a
   `#8a6d00` fallback, so it renders correctly whether or not the token is
   defined. Worth adding the token to the stylesheet if you like the colour.

5. **Production verification still owed.** Migration 010 is unapplied; the
   Vitest contiguity test is not a substitute for the dashboard queries.
   Apply + verify per the draft runbook entry before merge.

---

## Test plan

Manual, on the branch's Vercel preview. Read-only feature — no DB writes, so
no reset step. Structured like PR #5's plan.

**Setup**

- [ ] Sign in as a provider with an active CDC Scholarship funding source
      (CDC module active) — e.g. Venessa's account or a CDC test account.
- [ ] Confirm "CDC Pay Periods" appears in the sidebar **Compliance**
      section, directly below "MiRegistry", with the calendar-clock icon.

**Core display**

- [ ] Click it → the page loads at `/cdc-pay-periods` with no error.
- [ ] Header reads "CDC Pay Periods"; hovering/tapping the info icon shows
      the header help tooltip.
- [ ] "Current pay period" card shows **Period 610**, "May 3 – May 16,
      2026", the green "Open — care days in progress" status, "Report by
      Thu May 21, 2026" with the correct days-left countdown, and
      "Est. payment Fri May 29, 2026" with the holiday-delay chip.
- [ ] "Next pay period" card shows **Period 611**, "May 17 – May 30, 2026".
- [ ] The schedule table lists **26 rows** for 2026; the **610** row is
      highlighted and carries a "Current" badge.
- [ ] A period that has ended but is still within its reporting window
      shows a "Still billable" badge.
- [ ] The legend shows the ⚠ and * meanings; periods 610/620/622/623/625
      show ⚠, periods 612/613 show *.
- [ ] The "Report by" and "Est. payment" column headers have working info
      tooltips.

**Edge cases**

- [ ] Year selector → choose **2025** → table shows 26 rows for 2025; no
      row is highlighted (no current period in 2025); switch back to 2026.
- [ ] Shrink the browser to ≤ 640px → the table collapses to a vertical
      list of period cards; the year selector stays at the top; no
      horizontal scrolling of a data table.
- [ ] Direct-navigate to `/cdc-pay-periods` as a provider with **no** CDC
      funding source → redirected to `/dashboard`, and the sidebar never
      showed the entry.
- [ ] (Optional, DB-dependent) The schedule-not-published empty state can't
      be reached through the year selector (it only lists seeded years);
      verify its copy by inspection, or once the 2027 schedule period
      arrives.

**Footer / reference**

- [ ] The footer note about MDHHS / I-Billing is present.
- [ ] "Michigan.gov CDC Payment Schedule" links out to the MiLEAP CDC
      providers page in a new tab.

---

## Vercel preview

URL: _pending branch push_ — Vercel posts the preview URL as a bot comment
on the GitHub PR once it's opened, and lists it in the Vercel dashboard
under the `feature/cdc-pay-period-catalog` deployment. (It cannot be
retrieved from this environment.)
