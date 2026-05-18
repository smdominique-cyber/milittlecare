# Tech Debt

## Migrations folder is out of sync with production schema

As of 2026-05-13, `supabase/migrations/` contains only:

- `001_profiles.sql` — creates `profiles` (6 columns), the `handle_new_user`
  signup trigger, and the `set_updated_at()` helper.
- `002_receipts.sql` — creates `receipts` plus the `receipts` storage bucket
  and image-access policies.

The production Supabase database has substantially more schema than these
two files describe. Many objects were added directly via the Supabase SQL
editor without a migration file.

### Tables present in production but missing a migration file

Confirmed via `information_schema.tables` and cross-referenced against
React `.from('...')` call sites:

| Table | First reference in code |
| --- | --- |
| attendance | `src/components/ui/AttendanceExportButton.jsx` |
| autopay_charges | (live schema; not yet referenced by name in React) |
| business_hours | `src/components/parent/BusinessInfoSection.jsx` |
| business_policies | `src/components/dashboard/Sidebar.jsx` |
| children | `src/lib/messages.js` |
| closures | `src/components/parent/BusinessInfoSection.jsx` |
| emergency_contacts | `src/pages/FamiliesPage.jsx` |
| families | `src/pages/BillingPage.jsx` |
| family_invitations | `src/pages/FamiliesPage.jsx` |
| guardians | `src/pages/FamiliesPage.jsx` |
| hour_logs | `src/lib/taxExport.js` |
| invoice_items | `src/pages/BillingPage.jsx` |
| invoices | `src/pages/BillingPage.jsx` |
| message_attachments | `src/lib/messages.js` |
| message_threads | `src/lib/messages.js` |
| messages | `src/lib/messages.js` |
| notification_log | (live schema; used by server-side notification flow) |
| parent_family_links | `src/pages/ParentDashboardPage.jsx` |
| parent_profiles | `src/pages/AuthCallbackPage.jsx` |
| payments | `src/pages/BillingPage.jsx` |
| staff_invitations | `src/pages/StaffPage.jsx` |
| staff_memberships | `src/hooks/useRole.jsx` |
| staff_time_audit_log | `src/pages/StaffPage.jsx` |
| staff_time_entries | `src/components/dashboard/StaffClockWidget.jsx` |
| subscription_events | (live schema; used by Stripe webhook handler) |
| ts_ratios | `src/lib/taxExport.js` |

### Columns added to `profiles` out-of-band

Migration 001 created `profiles` with 6 columns. Production has these
additional columns:

- `trial_started_at`, `trial_ends_at`
- `subscription_status` (default `'trialing'`)
- `stripe_customer_id`, `stripe_subscription_id`
- `current_period_end`, `cancel_at_period_end`
- `role` (default `'licensee'`)
- `tax_id`

## Why this matters

- **Clean environments cannot be reproduced from migrations alone.** A
  fresh Supabase project bootstrapped from `supabase/migrations/` would
  fail to serve the React app — over 25 tables would be missing.
- **Schema reviews are unreliable.** Reviewers must compare against
  production via `information_schema` queries, not against the repo.
- **Future migrations risk colliding** with out-of-band changes. Authors
  must dump the live schema first to avoid duplicate column names or
  constraint conflicts.

## Recommended cleanup (separate PR — explicitly out of scope here)

1. `pg_dump --schema-only --no-owner` from the production Supabase project.
2. Diff against `001` + `002` + new migrations from this PR.
3. Author retroactive migrations — numbered sequentially from the next
   free migration number at the time the cleanup is done; no migration
   number range is reserved in advance — that recreate every missing table
   and column. Mark each clearly: `-- RETROACTIVE: already present in
   production as of YYYY-MM-DD`.
4. Verify `supabase db reset` against a fresh project produces a working
   schema and the React app boots without "relation does not exist" errors.

## Scope of this PR

The funding-source scaffolding PR (migrations `003`–`006`) adds **only new
objects** on top of what production already has. It assumes existing
tables (`children`, `families`, `invoice_items`, `profiles`) are present
with their current production schema. It does not attempt to backfill the
missing migration history.

## Deferred work introduced by PR #1 (funding source scaffolding)

- **Inline styles in `src/components/funding/`.** `FundingSourceList.jsx`
  and `FundingSourceForm.jsx` use inline `style={{...}}` props for layout
  instead of CSS classes. Lift into `src/styles/funding.css` when adding
  a third file in `src/components/funding/`, or earlier if styling
  diverges meaningfully from `FamiliesPage.jsx`'s conventions.
- **Component tests for `src/components/funding/`.** No render tests
  exist yet. Add when React Testing Library is approved and installed;
  cover loading/empty/error/populated/show-archived for the list, and
  add+edit/per-type-branches/validation-summary/dual-write/stub-coming-soon
  for the form.
- **Private Pay edit form writes to both `families.*` columns and
  `funding_source.details` JSON.** Remove the legacy write path when
  invoice generation refactors to read from funding sources only. Future
  PR cleans this up.
- **Private Pay form duplicates some billing fields from the family
  Overview tab.** Two surfaces edit the same underlying `families.*`
  columns. Consolidate when refactoring invoice generation to read
  from funding sources only.

## Deferred work introduced by PR #2 (funding document vault)

- **Single `busy` flag per `FundingDocumentSlot`.** A slot's busy state
  disables every action button across all of its rows during any in-flight
  operation. The visible effect is on the `'other'` multi-doc slot: while
  one document uploads or replaces, the View/Replace/Remove buttons on
  every other Other doc in the same slot are disabled. Acceptable for V1
  given typical low-doc-count usage. Future fix: per-row busy state in
  the multi-doc list.
- **Duplicate `is_license_exempt` fetch.** The `enrollment_agreement`
  variant of `FundingDocumentSlot` re-fetches
  `profiles.is_license_exempt` even though the parent `FundingSourceForm`
  has already loaded it for CDC validation. One extra round-trip per CDC
  source open. Pass it down as a prop on the next refactor.
- **No retention-date editor in V1.** `funding_documents.retention_until`
  is editable per row at the SQL layer and via a future support tool, but
  the slot UI shows it display-only. Surface as an inline editor (with
  confirmation dialog) when a real provider request justifies the
  affordance — most providers will never need to touch it.
- **Best-effort cleanup on `FundingDocumentSlot` Replace failure.** The
  Replace flow wraps its compensating writes (un-archive the old row,
  delete the orphan storage object) in `.catch(() => {})` so a cleanup
  failure doesn't mask the original error. Trade-off: a cascading
  failure could leave the old metadata row archived and/or the new
  storage object orphaned, requiring manual reconciliation. Future fix:
  log cleanup failures to a server-side queue with periodic review.

## Deferred work introduced by PR #4 (MiRegistry tracker)

- **MiRegistry banner per-family fetch.** The
  `MiRegistryWarningBanner` component (added in PR #4) fetches
  `profile.is_license_exempt` and the user's training entries every
  time a family detail modal opens. For V1 this is acceptable —
  Venessa has 14 families and the fetch is small — but at scale,
  repeat fetches when opening multiple families in succession is
  wasteful. Future fix: lift the data into a context shared with
  `MiRegistryPage` so both surfaces hit the network at most once per
  session.

## License-exempt provider self-identification is invisible

The MiRegistry tracker activates on `profile.is_license_exempt === true`,
but providers have no UI surface that asks them this question. A
license-exempt provider can set up MILittleCare, add CDC funding sources
for their kids, and never discover the MiRegistry tracker exists because
the activation field stays `null`.

Fix: when a provider creates their first CDC Scholarship funding source on
any child, prompt them with a modal asking whether they're license-exempt
or licensed. Store the answer on `profiles.is_license_exempt`. The same
prompt should fire if they edit/replace a funding source and still have no
answer recorded.

Future: licensed providers' answer should also activate (eventually)
licensed-provider continuing education tracking (LARA rules, separate from
the MiRegistry tracker, separate spec).

Surfaced 2026-05-15 by Seth during PR #4 production testing — he correctly
noted that adding CDC funding sources for his kids should have triggered
the MiRegistry module's relevance somehow. The activation rule itself is
correct (license status is a provider attribute, not a per-child
attribute); the gap is in surfacing the question to the provider.

## License status indefinitely null

`profiles.is_license_exempt` can sit at `null` indefinitely if a provider
repeatedly picks "I'm not sure — ask me later" in the license-status prompt
(see `docs/license_status_prompt_spec.md` §§ 3–4). A provider parked in
`null` never gets the MiRegistry tracker.

If real-life usage shows providers doing this repeatedly without ever
answering, add a one-time gentle dashboard banner prompting them to answer.
Defer until we have signal that this is a real pattern — surfaced as
OQ5 in the license-status prompt spec and deliberately deferred to V2.

## Staff training tracking for licensed providers is unmodeled

The MiRegistry tracker (PR #4) assumes one auth user = one provider
tracking their own training. This works for license-exempt providers
(single individual, no staff).

It does NOT work for licensed providers (e.g. Family Child Care Home
licensees like Venessa). Licensed providers must track training for every
staff member under their license — assistants, substitutes, anyone
providing care. LARA requires this and inspects for it. Training
requirements differ by role and are different from license-exempt
requirements (administered by LARA, not MDHHS CDC).

Current schema implication: staff invited via `staff_invitations` get
their own `auth.users` / profile rows. The MiRegistry page would activate
for them only if they had a `miregistry_id` set on their own profile.
There's no surface where the licensee can see aggregated staff compliance,
no role-aware training requirement matrix, no concept that "Maria (staff
at Venessa's home) needs initial orientation + annual H&S + CPR by Dec 1."

This is a real gap, not a polish item. It's potentially a meaningful
product wedge for licensed providers — possibly more valuable than CDC pay
period catalog (PR #5).

Out of scope for this PR; surfaced 2026-05-15 by Seth.

## Migration 006 backfill assumption — CDC-primary providers

Migration 006 backfill assumed every active family was private-pay. In
Venessa's data, 4 families flagged `needs_rate_review=true` are
actually CDC Scholarship kids. She'll archive the placeholders and
create proper CDC Scholarship sources once the document vault UI
ships.

This is also a lesson for future backfills: many providers — especially
home daycare and license-exempt — have CDC Scholarship as the majority
of their roster, not the exception. See `CLAUDE.md` § Critical Domain
Knowledge for the rule that codifies this. Future backfills that need
to choose a funding type should flag rows for human review rather than
default to `private_pay`.

## Planned deprecations (foreshadowed by approved specs)

- **`profiles.annual_training_completion_date`** — added by migration
  `004_provider_program_settings.sql` as a single-date "latest annual
  training completion" column. The MiRegistry tracker spec (`docs/
  miregistry_tracker_spec.md` § 2.3) replaces it with the
  `miregistry_training_entries` table as the source of truth for
  every annual ongoing training event (with full history per year,
  rather than the single overwriteable date). Action plan:

  1. The MiRegistry tracker implementation PR stops all new write
     paths to this column.
  2. A later cleanup PR drops the column. Until then, the column
     remains in the schema as a no-op for any backward-compatibility
     read paths.

  Do not add new write paths to this column. Read paths should
  migrate to query `miregistry_training_entries` directly.

## Verification gap discovered 2026-05-15

Schema migrations were being marked "verified" in `docs/runbook.md` on the
strength of Claude Code's chat-session reports, rather than on user-visible
evidence from the Supabase dashboard.

Concretely: migration `009_miregistry_training_entries.sql` was reported
"verified" on 2026-05-13, and a runbook Migration History entry dated
2026-05-14 recorded it as applied and verified — but the migration had **not**
been applied to production. It was not actually applied until 2026-05-15 (via
the Supabase web SQL editor). For roughly two days the runbook asserted a
production schema state that did not exist. The gap surfaced only when a later
read-only check queried production directly and found the table, enum, and
`profiles` columns all absent.

Root cause: nothing separated "Claude Code says it ran" from "it demonstrably
ran." An assistant chat report is not evidence — the assistant can be wrong,
can query the wrong database, or can conflate a local or branch run with
production.

**Going forward — required process for every schema migration:**

1. The **user** personally runs the verification queries in the **Supabase web
   dashboard** SQL editor — not the assistant, and not inferred from a CLI or
   MCP report.
2. The user saves **screenshots** of the queries and their results.
3. The `docs/runbook.md` Migration History entry is **not written until that
   evidence exists**. The entry documents the user-run verification.

This supersedes the "paste the result back in chat" step in the runbook's
Migration Application Procedure: that step is no longer sufficient on its own
as the verification artifact.

## Conventions introduced by this PR (apply to all future migrations)

- **Soft delete on audit-relevant tables: `archived_at timestamptz`.**
  Funding records and anything with regulatory retention requirements
  (4 years for licensed providers, longer for license-exempt) must never
  be hard-deleted. Filter active rows with `where archived_at is null`.
  Operational-only tables (e.g. `billing_periods`) can keep using hard
  delete.
- **Backfill marker for rollback safety: `details.backfilled_by = '<NNN>'`.**
  Any migration that inserts rows into an existing table must stamp those
  rows with a marker in a JSON column (or equivalent), so the migration's
  DOWN section can DELETE precisely the rows it created. See
  `006_backfill_private_pay.sql` for the canonical example.
- **Rollback safety past dependent migrations.** If a later migration
  adds a FK pointing at rows created by an earlier backfill, that FK
  must be `on delete set null` (or `on delete cascade` with caution),
  and the earlier migration's DOWN section must document the orphaning
  risk. See the warning header in `006_backfill_private_pay.sql`.
- **Transactional backfills.** Wrap any backfill INSERT in an explicit
  `begin; ... commit;` so a mid-run error rolls back cleanly. Include a
  trailing `SELECT` that prints row counts for verification.

## Annual CDC pay period catalog update (recurring — every Q4)

`cdc_pay_period_catalog` (to be added by migration
`010_cdc_pay_period_catalog.sql`, PR #5) holds the MDHHS-published CDC pay
period schedule. MDHHS publishes a new schedule once per calendar year, so
the catalog needs one update per year — a standing operational task, not a
bug.

Procedure, each Q4 (target: October, once MDHHS posts the next year's
schedule on the Michigan.gov CDC Providers page):

1. Transcribe the new year's 26 periods into a small seed-only migration
   (next sequential migration number), following the row format in
   `docs/cdc_pay_periods_spec.md` Appendix A.
2. Apply it via the Supabase web SQL editor, per the runbook's Migration
   Application Procedure.
3. Verify with the `cdc_pay_periods_spec.md` § 7.5 contiguity check —
   ordered by `start_date`, each period's `start_date` is the previous
   `end_date` + 1 day, with no gaps or overlaps across the year boundary.

Next due: **Q4 2027**, for the 2027 schedule (`701`–`726`). Until the
catalog is updated, the CDC Pay Periods page shows the
schedule-not-published empty state (`cdc_pay_periods_spec.md` § 3.4).

## `src/ReceiptsPage.jsx` not yet relocated to `src/pages/`

`src/ReceiptsPage.jsx` lives at the `src/` root; per `CLAUDE.md`
§ File Structure it belongs in `src/pages/`. `CLAUDE.md` already flags this
("should eventually move into `src/pages/`. Not urgent."). Surfaced again
during PR #5 spec review when placing the new `CdcPayPeriodsPage.jsx`
correctly under `src/pages/`.

Fix: move the file to `src/pages/ReceiptsPage.jsx` and update its import in
`src/App.jsx`, as a standalone cleanup PR — not bundled into a feature PR,
since it is unrelated churn.

## ESLint configuration is missing from the repo

`package.json`'s `lint` script references ESLint, but no config file is
committed — no `.eslintrc.*`, no `eslint.config.*`, no flat config
anywhere. Running `npm run lint` fails with "ESLint couldn't find a
configuration file."

Discovered 2026-05-15 during PR #5 implementation (license-status prompt
modal). Pre-existing; same class of out-of-band gap as the 26 production
tables without migration files.

Fix: pick the ESLint version we're standardizing on (ESLint 8 with
`.eslintrc.json`, or ESLint 9+ with `eslint.config.js` — match what
`package.json`'s `eslint` dependency declares), and commit the config with
the React plugins already in the project (`eslint-plugin-react`,
`eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`) plus
`eslint-plugin-jsx-a11y` for accessibility linting. Verify `npm run lint`
runs clean against current `main` before merging.

Out of scope for the license-status prompt PR; surfaced here so it's not
lost.

## Deferred work introduced by PR #6 (CDC pay period catalog)

- **Local-date helpers are now duplicated.** `src/lib/cdcPayPeriods.js`
  re-implements `todayYMD()` and the `Date.UTC`-based day-difference helper
  that already exist in `src/lib/miregistry.js`. `miregistry.js` already
  foreshadowed this ("extract a shared util when this multiplies further")
  — it has now multiplied. Extracting a shared `src/lib/dates.js` was kept
  out of PR #6's scope because it would touch `miregistry.js` (and its
  tests) unrelated to the pay-period feature. Fix: lift `todayYMD`,
  `daysBetweenYMD`, and `nextDayYMD` into one date util and have both
  modules import it, as a standalone cleanup PR.
- **No render tests for the CDC pay period UI.** `CdcPayPeriodsPage.jsx`,
  `PayPeriodTable.jsx`, and `PayPeriodCard.jsx` have no component tests —
  the pure helpers in `cdcPayPeriods.js` are covered by Vitest, the React
  surfaces are not. Same gap as PRs #1, #2, #4. Add when React Testing
  Library is approved and installed; cover loading / error /
  schedule-not-published / populated states, the year selector, the
  narrow-width card fallback, and the module-gate redirect.
- **`useIsNarrow` is page-local.** `CdcPayPeriodsPage.jsx` defines a small
  `matchMedia`-based hook for the ≤640px table→card switch. If a second
  surface needs viewport-width detection, lift it into
  `src/hooks/useMediaQuery.js` rather than copy it.

## Deferred work introduced by PR #7 (onboarding wizard)

- **`getMissingFields` cannot distinguish a participation "no" from
  "unanswered".** `src/lib/onboarding.js#getMissingFields` reports a
  participation question (`cdc` / `tri_share` / `gsrp`) as missing whenever
  its `program_settings` key is absent. But a wizard "no" *also* leaves the
  key absent by design (`onboarding_wizard_spec.md` § 9 decision 13:
  "no" → absent / `'auto'`, never `'force_off'`). So a provider who
  answered "no" and a provider who never answered are indistinguishable
  from the profile alone. This is acceptable for V1, which ships a single
  generic next-step prompt. When V2 adds precise per-field next-step
  prompts (spec § 3.3, § 7.2), "no" on a participation question must be
  distinguishable from "unanswered" — the disambiguating signal is
  `onboarding_state.gate_answers` (added in PR #7; it records the raw
  CDC/Tri-Share/GSRP answer, including a distinct "never heard of it" for
  Tri-Share). The V2 prompt logic should consult it rather than rely on
  `getMissingFields`, which inspects the profile alone.

- **The generic next-step prompt routes everything to Business Info.**
  `OnboardingNextStepPrompt` (the single generic V1 prompt) links to
  `/business-info` for every skipped field. That page's "Licensing" tab
  is a real edit surface for `is_license_exempt` (and the future home for
  `miregistry_id` / `michigan_license_number`), but the program-
  participation fields (`program_settings.cdc` / `tri_share` / `gsrp` /
  `cacfp`) and the soft-context buckets have **no settings UI at all**
  (`funding_source_spec.md` § 1.1). A provider who skipped those in the
  wizard has nowhere to set them afterward. Resolve when the richer
  per-field next-step prompts land (spec § 7.2) — each should route to,
  or the same PR should build, a real per-field settings surface.
