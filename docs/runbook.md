# Runbook

Operational procedures for MI Little Care. Update this file whenever a new procedure is introduced (per `CLAUDE.md` § Documentation Conventions, rule 3).

## Migration Application Procedure

All schema migrations are currently applied manually. Until automated migration tooling lands, the procedure is:

1. **Source the SQL.** Open the migration file on the feature branch via GitHub (e.g. `supabase/migrations/007_funding_sources_archived_by.sql`). Copy the full file content.
2. **Paste into the Supabase SQL Editor.** Production project only for now; staging is not yet provisioned. Run the script.
3. **Verify the result.** If the migration includes a trailing `SELECT` (the backfill pattern), record those numbers. Otherwise, run a separate verification query — e.g. `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='funding_sources' order by ordinal_position;` after a column-add migration.
4. **Verify in the dashboard yourself.** Paste the verification queries directly into the Supabase web SQL Editor at `https://supabase.com/dashboard/project/ooavvgkfhgouakkiknfs/sql`. Run them yourself with eyes on the dashboard. Copy or screenshot the results. The user-visible dashboard output is the artifact — not chat output, and not a Claude Code report of queries it ran. Save the screenshot before writing the runbook entry. If you cannot personally verify in the dashboard, the migration is not done.
5. **Update Migration History.** Add an entry to the section below: date, migrations applied, verification result, any deviations.

Rollback follows the same pattern in reverse: open the migration's commented `DOWN MIGRATION` section, uncomment, paste, run. Always rollback the latest applied migration first and walk backwards in number order.

### Operational note — the web SQL Editor mangles long statements

⚠️ **The Supabase web SQL Editor cannot reliably execute long single
statements.** Observed during migration 010 application on 2026-05-17: long
`INSERT` statements (26 rows per `VALUES` clause, ~1500+ chars) get wrapped
into multiple physical lines and the editor runs only a fragment, producing
a `syntax error` on the truncated portion. The editor handles short
single-line statements fine.

For future migrations: either break long seed inserts into many short
statements (4–5 rows each), apply via the direct Supabase connection (MCP
path), or test the editor's behavior with a small sample first before
assuming a complex migration will land. The `Success. No rows returned`
message can fire on a fragment that did nothing — verification queries
against the actual table state are the only reliable confirmation.

## Migration History

### 2026-05-13 — Migrations 003-006: funding-source scaffolding

Applied to production:

- `003_funding_sources.sql` — created `funding_sources`, `billing_periods`, `tri_share_hubs` tables, three enums, hybrid-FK CHECK constraints, type-aware priority trigger, RLS policies.
- `004_provider_program_settings.sql` — added `program_settings jsonb` plus Michigan-specific columns to `profiles`.
- `005_invoice_items_funding_source.sql` — added nullable `funding_source_id` FK to `invoice_items` with `on delete set null`.
- `006_backfill_private_pay.sql` — inserted one `private_pay` funding source per active family.

Verification from `006`'s trailing SELECT:

| total_funding_sources_created | needs_rate_review_count | ok_count |
| ----------------------------: | ----------------------: | -------: |
| 14                            | 4                       | 10       |

Manually spot-checked Venessa's data after application — looks correct. No deviations from the migration text.

### 2026-05-13 — Migration 007: archived_by audit column

Applied to production:

- `007_funding_sources_archived_by.sql` — added nullable `archived_by uuid` FK on `public.funding_sources` referencing `auth.users(id)` with `ON DELETE SET NULL`. Pairs with `archived_at` from `003` to record who soft-deleted each funding source.

Verification (`information_schema.columns` for the new column):

| column_name | data_type | is_nullable |
| ----------- | --------- | ----------- |
| archived_by | uuid      | YES         |

Exact match against expected output. No deviations.

### 2026-05-13 — Migration 008: funding document vault

Applied to production:

- `008_funding_documents.sql` — created `funding_documents` table, `funding_document_type` enum (`dhs_198`, `enrollment_agreement`, `other`), four indexes (including the partial-unique `funding_documents_one_active_per_type` that excludes `'other'`), RLS policies (select/insert/update only — no delete; soft-delete via `archived_at`), the private `funding-documents` storage bucket, and three storage policies (insert/select/delete; objects are immutable). Storage RLS reuses the `(storage.foldername(name))[1]` template from `002`. Storage path layout: `<user_id>/<funding_source_id>/<uuid>.<ext>`.

Verification:

- `funding_documents` table has 16 columns (14 design columns plus `created_at` / `updated_at`).
- `archived_at`, `archived_by`, `uploaded_by_user_id`, and `file_size_bytes` (`bigint`) all present.
- `retention_until` default resolves to `(current_date + interval '4 years')::date` as expected.
- Bucket row exists with `public = false`. Confirmed private.

No deviations from migration text. No backfill (no pre-existing documents).

### 2026-05-14 — Migration 009: MiRegistry training entries — ⚠️ RETRACTED, SEE 2026-05-15

**This entry was inaccurate and has been retracted.** It originally stated, on
2026-05-14, that migration `009_miregistry_training_entries.sql` had been
applied to production and verified. It had not. The migration was not applied
to production until 2026-05-15 — see the entry below for the real record.

The "Verification" bullets recorded in the original entry were never run
against the production database. They were reported in a Claude Code chat
session without any user-visible evidence, and the migration itself had not
been applied. The chain of trust broke here: a migration was logged as applied
and verified on the strength of an assistant chat report alone. See
`docs/tech_debt.md` § "Verification gap discovered 2026-05-15".

### 2026-05-15 — Migration 009: MiRegistry training entries + profiles columns

Applied to production on **2026-05-15**, manually, by pasting the full text of
`009_miregistry_training_entries.sql` into the **Supabase web SQL editor**
(the dashboard). Not applied via the `supabase` CLI — this project has no CLI
migration ledger (`supabase_migrations.schema_migrations` does not exist).

What the migration creates:

- `miregistry_training_entries` table, `miregistry_training_source` enum
  (`leppt`, `annual_ongoing`, `level_2_approved`, `other`), two partial indexes
  (`miregistry_entries_user_completed_idx`, `miregistry_entries_user_source_idx`,
  both `WHERE archived_at IS NULL`), RLS policies (select/insert/update only —
  no delete; soft-delete via `archived_at`), and the `set_updated_at` trigger.
- Three new `profiles` columns for the manually-transcribed Training Level
  state: `miregistry_current_level` (text, constrained to
  `'level_1' | 'level_2' | NULL` via the `profiles_miregistry_level_values`
  check), `miregistry_level_2_expires_on` (date),
  `miregistry_level_last_updated_at` (timestamptz). All nullable; meaningful
  only for license-exempt providers.

Verification — three queries run by the user in the Supabase web SQL editor,
with results:

1. Table exists:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'miregistry_training_entries';
   ```
   → 1 row: `miregistry_training_entries`.

2. `profiles` columns:
   ```sql
   SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'profiles'
     AND column_name LIKE 'miregistry%';
   ```
   → 4 rows: `miregistry_current_level` (text), `miregistry_id` (text),
   `miregistry_level_2_expires_on` (date),
   `miregistry_level_last_updated_at` (timestamp with time zone).

3. Enum exists:
   ```sql
   SELECT typname FROM pg_type WHERE typname = 'miregistry_training_source';
   ```
   → 1 row: `miregistry_training_source`.

Non-changes worth noting:

- `profiles.annual_training_completion_date` is intentionally untouched. It
  enters its deprecated phase with this PR's implementation; a follow-up
  cleanup PR drops the column once write paths are removed (per
  `docs/tech_debt.md` § Planned deprecations).
- No backfill — no existing training entries to migrate.

### 2026-05-17 — Migration 010: CDC pay period catalog

Applied to production on **2026-05-17** by Seth, via **two channels**
(forced by the web SQL Editor bug recorded in the operational note above):

- **DDL** — the `cdc_pay_period_catalog` table, the
  `cdc_pay_period_catalog_year_start_idx` index, `enable row level
  security`, and the single SELECT policy — applied through the **Supabase
  web SQL Editor** as four separate single-line statements.
- **The 52 seed rows** — the 2025 schedule (501–526) and the 2026 schedule
  (601–626) — applied via the **direct Supabase connection (MCP path)**,
  because the web SQL Editor corrupted the long multi-row `INSERT`
  statements (~1500+ chars each). See the operational note in the Migration
  Application Procedure section above.

Not applied via the `supabase` CLI — this project has no CLI migration
ledger (`supabase_migrations.schema_migrations` does not exist).

What the migration creates:

- `cdc_pay_period_catalog` table — a **statewide** reference table (no
  `user_id`) holding the MDHHS-published CDC Payment Schedule. Modelled on
  `tri_share_hubs` (migration 003): readable by every authenticated user,
  never written from the app.
- One index, `cdc_pay_period_catalog_year_start_idx` on
  `(schedule_year, start_date)`. The `unique (schedule_year, period_number)`
  constraint provides a second index.
- RLS enabled, with a single SELECT policy for `authenticated`. **No
  insert/update/delete policies** — the catalog is seeded by migration only.
- 52 seed rows: the 2025 schedule (period numbers 501–526) and the 2026
  schedule (601–626), transcribed from `docs/cdc_pay_periods_spec.md`
  Appendix A.

No dependency on migration 009. Independent of `billing_periods` (migration
003), which this migration deliberately leaves untouched.

Verification — four queries run by Seth in the Supabase web SQL editor on
**2026-05-17**, all passed:

1. **Table exists** — `information_schema.tables` returns
   `public.cdc_pay_period_catalog`. ✓
2. **Row count** — 52 rows total, 26 per `schedule_year` (2025 and 2026). ✓
3. **Contiguity** (spec § 7.5) — ordered by `start_date`, every period's
   `start_date` equals the previous period's `end_date + 1`; the
   gap/overlap query returned 0 rows. ✓
4. **RLS** — row level security enabled, exactly one policy:
   `cmd = SELECT`, `roles = {authenticated}`, no insert/update/delete
   policies. ✓

Rollback: uncomment the `DOWN MIGRATION` block at the foot of the migration
file (drop policy → drop index → drop table). Dropping the table removes all
52 seeded rows; no separate DELETE is needed.

### 2026-05-18 — Migration 011: profiles.onboarding_state column

Applied to production on **2026-05-18** by Seth, via the **Supabase web
SQL Editor** — a single `ALTER TABLE` statement. The web SQL Editor
long-statement bug (see the Migration Application Procedure note above)
does not apply: this is one short single statement, pasted and run
directly.

Applied ahead of the original plan (which scheduled it for the end of
PR #7's Phase 3). It was pulled forward so the Phase 2 onboarding-wizard
write-through could be smoke-tested against production before Phase 3's
dashboard integration is built on top of it.

What the migration does:

- `011_onboarding_state.sql` — adds a single column,
  `public.profiles.onboarding_state jsonb not null default '{}'::jsonb`.
  It is the bookkeeping blob for the first-login onboarding wizard
  (`docs/onboarding_wizard_spec.md` § 2.3): `version`, `completed_at`,
  `dismissed_at`, `last_step`, `skipped`. Wizard answers are **not** stored
  here — each writes through to its canonical column.

Dependencies:

- Sequential after migration `010` (the next free number). No data
  dependency on `010` or any other migration — this is an isolated
  column-add on `profiles`.

No backfill statement: the `default '{}'::jsonb` populates every existing
`profiles` row (Venessa + 2 others) at `ALTER` time. Each then reads as
"not yet onboarded" (`completed_at` absent), which is the intended
backfill of structural identity (spec § 4.3).

RLS: no new policy. `onboarding_state` is a new column on `public.profiles`,
which already has per-provider read/write policies (migration 001); the
column inherits them.

Editor note: this is a **single short DDL statement**, so the web SQL
Editor long-statement bug recorded in the Migration Application Procedure
above does not apply — it can be pasted and run directly.

Verification — two queries run by Seth in the Supabase web SQL Editor on
**2026-05-18**, both passed:

1. **Column exists with the right type/default** —
   `select column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema='public' and table_name='profiles'
      and column_name='onboarding_state';`
   Returned one row: `onboarding_state | jsonb | NO | '{}'::jsonb`. ✓
2. **Every existing row is backfilled** —
   `select count(*) as total,
           count(*) filter (where onboarding_state = '{}'::jsonb) as empty_blob
    from public.profiles;`
   Returned `total = 3`, `empty_blob = 3` — every existing `profiles` row
   defaults to `{}`. The 3 rows are Venessa + 2 others, matching the
   expected production state. ✓

Rollback: uncomment the `DOWN MIGRATION` block at the foot of
`011_onboarding_state.sql` — `alter table public.profiles drop column if
exists onboarding_state;`. Dropping the column discards any wizard
bookkeeping written since application; the canonical answer columns
(`profiles.*`, `program_settings.*`) are unaffected.

### 2026-05-18 — Migration 012: staff training tracking schema — PENDING PRODUCTION APPLICATION

> ⚠️ **Status: PENDING PRODUCTION APPLICATION.** Ships on branch
> `docs/staff-training-tracking-spec` (PR #8); **not yet applied**. Apply
> per the Migration Application Procedure above — including the
> user-visible dashboard verification convention (`CLAUDE.md` § Critical
> Domain Knowledge: the user runs the verification queries in the Supabase
> web SQL Editor and saves a screenshot). This entry is completed with the
> actual verification output at application time; the numbers below are
> *expected*, not confirmed.

What the migration does — `012_staff_training.sql` creates the operational
schema for staff training tracking (PR #8), verified against Michigan
Administrative Code R 400.1901–1963 (MiLEAP):

- 4 enums — `regulatory_role`, `staff_training_category`,
  `miregistry_status`, `background_check_status`.
- `caregivers` — the licensee's regulatory roster; a row may or may not be
  linked to an auth user (`app_user_id`).
- `caregiver_regulatory_roles` — many-to-many caregiver → regulatory role;
  driver-only attributes CHECK-scoped to driver rows.
- `staff_training_records` — the per-caregiver training log, keyed on
  `caregiver_id`; two status enum columns gated by a CHECK to their
  categories; soft delete via `archived_at`.
- `health_safety_updates` — per-licensee R 400.1924(11) notices.
- 6 indexes, 3 `set_updated_at` triggers, provider-scoped RLS on all 4
  tables.

Dependencies — sequential after migration 011; no data dependency on any
prior migration. References `auth.users` and the migration-001
`set_updated_at()` function. `public.staff_memberships` is left untouched.

Editor note — `012` is **all DDL, no long seed INSERT**, so the web SQL
Editor long-statement bug (operational note above) does not apply; it can
be pasted and run as a whole file or statement by statement.

Expected verification (run by the user in the Supabase web SQL Editor at
application time, then recorded here):

1. **Tables exist** — `information_schema.tables` returns `caregivers`,
   `caregiver_regulatory_roles`, `staff_training_records`,
   `health_safety_updates` in schema `public` (4 rows).
2. **Enums exist** — `select typname from pg_type where typname in
   ('regulatory_role','staff_training_category','miregistry_status',
   'background_check_status');` → 4 rows.
3. **RLS enabled** — `pg_tables.rowsecurity = true` for all 4 tables;
   `pg_policies` lists the select/insert/update policies (plus the
   `caregiver_regulatory_roles` delete policy).
4. **Empty** — each new table returns 0 rows (`012` seeds nothing).

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`012_staff_training.sql` (drop the 4 tables in reverse-dependency order,
then the 4 enums). The tables hold no data until the app writes to them.

### 2026-05-18 — Migration 013: training requirements catalog — PENDING PRODUCTION APPLICATION

> ⚠️ **Status: PENDING PRODUCTION APPLICATION.** Ships on branch
> `docs/staff-training-tracking-spec` (PR #8); **not yet applied**. Apply
> **after migration 012** (it uses 012's enums). Same dashboard
> verification convention as above; the numbers below are *expected*.

What the migration does — `013_training_requirements.sql` creates the
verified MiLEAP training requirement catalog (PR #8) — reference data,
structurally like `cdc_pay_period_catalog` (migration 010):

- 2 enums — `requirement_cadence`, `requirement_condition`.
- `training_requirements` — one row per (training category, regulatory
  role) requirement, each carrying its `R 400.19xx` citation.
- 1 index; SELECT-only RLS for `authenticated` (no write policies — the
  catalog is migration-seeded, like `cdc_pay_period_catalog`).
- Seeds **28 rows** — every ✔ cell of the spec § 6.2 matrix.

Dependencies — must be applied **after migration 012** (uses the
`staff_training_category` and `regulatory_role` enums created in 012).

Editor note — the seed is split into **6 short INSERT statements (≤ 6 rows
each)**, one per training category, to stay clear of the web SQL Editor
long-statement bug (operational note above).

Expected verification (run by the user in the Supabase web SQL Editor):

1. **Table + enums exist** — `training_requirements` in
   `information_schema.tables`; `requirement_cadence` and
   `requirement_condition` in `pg_type`.
2. **Row count** — `select count(*) from public.training_requirements;`
   → expected **28**.
3. **Breakdown by role** — `select regulatory_role, count(*) from
   public.training_requirements group by regulatory_role order by 1;`
   Expected: `child_care_assistant` 6, `child_care_staff_member` 6,
   `driver` 4, `licensee` 6, `supervised_volunteer` 1,
   `unsupervised_volunteer` 5.
4. **RLS** — row level security enabled, exactly one policy
   (`cmd = SELECT`, `roles = {authenticated}`), no write policies.

Rollback — uncomment the `DOWN MIGRATION` block at the foot of
`013_training_requirements.sql` (drop the table, then the 2 enums).
