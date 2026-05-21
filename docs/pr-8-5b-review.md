# PR #8.5b Review — CDC Authorization Typing + Lifecycle Expansion

**Branch:** `feature/cdc-authorization-typing-pr-8-5b`
**Migration:** `supabase/migrations/017_promote_cdc_fields_and_expand_lifecycle.sql` *(pending — see status below)*

## Build session status

> ⚠️ **Migration body PARKED, awaiting pre-flight audit output (spec § PR #8.5b Step 1).**
>
> Per spec, the typing migration cannot be written until the four pre-flight audit queries are run against production and their output is committed to this doc. The audit may also trigger a HALT condition if `funding_sources.details` for CDC rows contains keys outside the spec's documented set.

### Items unblocked and written in this commit

- `src/lib/cdcAuthorization.js` — the lifecycle countdown helper (spec § Step 5). Pure function, shape-tolerant: reads `authorization_end` from the typed column first, falls back to `details.authorization_end` for rows that haven't been rewired yet. Same `Date.UTC`-based date math as `staffTraining.js` / `miregistry.js` (DST-safe).
- `src/lib/cdcAuthorization.test.js` — 16 deterministic Vitest cases. Boundary cases (29/30/31/0/-1 days), all three static states (`pending`/`terminated`/`renewed`), missing-data branches, and the JSON-fallback path are all covered.
- This review-doc scaffold.

### Items parked, awaiting pre-flight audit data

| Item | Blocker |
|---|---|
| The migration body (enum-expand + typed-column add + backfill + index) | Audit queries 2a–2d unrun |
| Resolution of any unexpected JSON keys → **HALT condition** | Audit query 2a |
| Decision on whether to add `dhs_198_issue_date` as new column or skip if production never had it | Audit query 2d |
| Backfill `update` statement (the spec's hard-coded version) | Needs query 2b sample values to confirm types parse cleanly (e.g., are date strings ISO or local-format? are booleans `true`/`false` strings or jsonb booleans?) |
| Reclassification report (rows that should be `expired` but are still `active`; rows currently `ended`) | Migration must land before the report queries make sense |
| Form rewire — switch CDC form writes from `details` JSON to typed columns | Typed columns must exist |
| Read-path updates — wire `FUNDING_SOURCE_COLUMNS` constant + every `details.X` reader to prefer typed columns | Typed columns must exist |
| UI badge wiring — surface `getLifecycleDisplayState` results on the funding sources list, child profile, dashboard widget | Helper exists; surfaces wait for migration |

## Spec § PR #8.5b — required review entries

### Pre-flight audit output

*Pending — paste verbatim once human runs queries 2a–2d in the Supabase dashboard.*

### HALT verification

*Pending — confirm query 2a returns no keys outside the spec's documented set: `case_number, dhs_198_received_date, authorization_start, authorization_end, approved_hours_per_period, family_contribution_amount, billing_basis, shared_with_other_provider, shared_provider_notes, provider_pin_required`. If any unknown keys are found, HALT and document here.*

### Reclassification report

*Pending — to be run after migration body lands. Rows that look mis-statused per spec § Step 6.*

### Backfill sample verification

*Pending — confirm a sample of pre-backfill rows shows JSON values matching their post-backfill typed-column values.*

### Decisions made when assumptions met reality

*Pending — populated as the build progresses.*

## Architectural notes carried forward from pre-build readout

### Lifecycle helper: shape tolerance

Per spec § Step 4 ("read from typed columns first, fall back to JSON for legacy rows where typed column is null"), the helper accepts both shapes. Tests cover the legacy-JSON path explicitly (see `src/lib/cdcAuthorization.test.js` — "JSON fallback for legacy rows" suite). The fallback path can be removed in a future cleanup PR once all rows have been rewritten through the new form (spec mentions "after 30 days of clean operation").

### `EXPIRING_WINDOW_DAYS` = 30

Mirrors the spec § PR #8.5b acceptance criterion. Distinct from `EXPIRING_SOON_WINDOW_DAYS = 60` in `staffTraining.js` (CPR-card expiry) — different number because the regulatory urgency is different (a CDC authorization expiring in <30 days threatens billing; a CPR card expiring in <60 days threatens role compliance). Both constants explicitly named so the difference is visible to a future reader.

### Status enum: `ended` left intact

Spec calls `ended` a "deprecated alias for `expired` or `terminated`" but doesn't remove it. The migration adds `pending`/`expired`/`terminated`/`renewed` additively; PostgreSQL `ALTER TYPE … ADD VALUE` cannot remove. Existing `ended` rows are surfaced for human reclassification in the post-migration report (spec § Step 6). No auto-reclassification.

### Date math: `Date.UTC`, not naive subtraction

The spec's pseudocode uses `new Date(authorization_end) - new Date()` which is DST-sensitive — twice a year the calculation produces an off-by-one. The helper here goes through `Date.UTC(y, m-1, d)` instead, matching the convention already established in `src/lib/miregistry.js`, `src/lib/cdcPayPeriods.js`, and `src/lib/staffTraining.js`. The deviation from spec pseudocode is intentional and documented in the function's JSDoc.
