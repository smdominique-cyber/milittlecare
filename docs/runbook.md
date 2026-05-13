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
