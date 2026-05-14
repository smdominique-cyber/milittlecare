# Runbook

Operational procedures for MI Little Care. Update this file whenever a new procedure is introduced (per `CLAUDE.md` § Documentation Conventions, rule 3).

## Migration Application Procedure

All schema migrations are currently applied manually. Until automated migration tooling lands, the procedure is:

1. **Source the SQL.** Open the migration file on the feature branch via GitHub (e.g. `supabase/migrations/007_funding_sources_archived_by.sql`). Copy the full file content.
2. **Paste into the Supabase SQL Editor.** Production project only for now; staging is not yet provisioned. Run the script.
3. **Verify the result.** If the migration includes a trailing `SELECT` (the backfill pattern), record those numbers. Otherwise, run a separate verification query — e.g. `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='funding_sources' order by ordinal_position;` after a column-add migration.
4. **Paste the result back in chat.** The verification output is the artifact reviewed before moving on to dependent work.
5. **Update Migration History.** Add an entry to the section below: date, migrations applied, verification result, any deviations.

Rollback follows the same pattern in reverse: open the migration's commented `DOWN MIGRATION` section, uncomment, paste, run. Always rollback the latest applied migration first and walk backwards in number order.

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

### 2026-05-14 — Migration 009: MiRegistry training entries + profiles columns

Applied to production:

- `009_miregistry_training_entries.sql` — created `miregistry_training_entries` table, `miregistry_training_source` enum (`leppt`, `annual_ongoing`, `level_2_approved`, `other`), two indexes (`miregistry_entries_user_completed_idx` and `miregistry_entries_user_source_idx`, both partial WHERE `archived_at IS NULL`), RLS policies (select/insert/update only — no delete; soft-delete via `archived_at`), and the `set_updated_at` trigger. Added three new columns to `profiles` for the manually-transcribed Training Level state: `miregistry_current_level` (text, constrained to `'level_1' | 'level_2' | NULL` via `profiles_miregistry_level_values` check), `miregistry_level_2_expires_on` (date), `miregistry_level_last_updated_at` (timestamptz). All three nullable; meaningful only for license-exempt providers.

Verification:

- `miregistry_training_entries` table created with 12 columns; soft-delete pair (`archived_at`, `archived_by`) and audit columns (`created_at`, `updated_at`) all present.
- `miregistry_training_source` enum exists with the four expected values.
- `profiles` gained the three `miregistry_*` columns (in addition to the existing `miregistry_id` from migration 004).
- `profiles_miregistry_level_values` check constraint applied; rejects values outside the allowed set.

Non-changes worth noting:

- `profiles.annual_training_completion_date` is intentionally untouched. It enters its deprecated phase with this PR's implementation; a follow-up cleanup PR drops the column once write paths are removed (per `docs/tech_debt.md` § Planned deprecations).
- No backfill — no existing training entries to migrate.
