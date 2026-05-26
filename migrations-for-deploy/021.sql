-- ============================================================
-- MI Little Care — PR #13: children.archived_at (soft-delete)
--
-- Adds soft-delete to public.children, closing two gaps identified in
-- docs/licensed-home-compliance-audit-2026-05-23.md § Open Questions OQ6
-- (accepted in docs/licensed-home-compliance-decisions-2026-05-23.md § OQ6):
--
--   1. CLAUDE.md never-hard-delete convention. children is audit-relevant:
--      attendance, invoice_items, and attendance_acknowledgments all
--      reference children(id). A hard DELETE orphans or cascades those
--      records. Before this PR, FamiliesPage's "Remove this child" button
--      issued a hard DELETE (replaced with archive in the same PR).
--
--   2. Rule 7 — R 400.1907 (child's record). Michigan licensing requires a
--      child's record be retained for at least 2 years after the date the
--      child is no longer in care. Soft-delete via archived_at provides the
--      retention path; hard delete did not.
--
-- Pattern mirrors the existing soft-delete columns:
--   caregivers.archived_at (012), funding_sources.archived_at (003/007),
--   funding_documents.archived_at (008),
--   attendance_acknowledgments.archived_at (020),
--   guardians.archived_at (016). Active rows are archived_at IS NULL.
--
-- Sequencing: ships BEFORE PR #14's license_type migration. PR #14 takes
-- the next free number after this one lands.
--
-- RLS: no policy change. The children policies (migration 016) key on
-- user_id / family_id and are agnostic to archived_at, so archived rows
-- remain visible to the owning licensee (intended — they manage retention
-- and the "show archived" view). Per-call-site filtering lives in app code:
-- active-roster surfaces add `archived_at IS NULL`; audit / billing /
-- acknowledgment surfaces intentionally include archived rows so historical
-- child names still resolve.
--
-- Additive and non-destructive: existing rows get archived_at = NULL
-- (active). No backfill.
--
-- Expected verification (run in the Supabase web SQL Editor; screenshot
-- before writing the runbook Migration History entry, per
-- docs/tech_debt.md § "Verification gap discovered 2026-05-15"):
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='children'
--     and column_name='archived_at';
--   -- expect: archived_at | timestamp with time zone | YES
--   select indexname from pg_indexes
--   where schemaname='public' and tablename='children'
--     and indexname='idx_children_family_active';
--   -- expect: one row.
-- ============================================================

alter table public.children
  add column if not exists archived_at timestamptz;

-- Active-child lookup is the hot path (per-family rendering, parent views).
-- Partial index mirrors idx_guardians_family_active (migration 016).
create index if not exists idx_children_family_active
  on public.children (family_id)
  where archived_at is null;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Non-destructive to reverse: archived_at only ever held a soft-delete
-- marker; dropping it does not delete any children rows. Any child that
-- was archived will reappear in active lists after rollback.
--
-- drop index if exists public.idx_children_family_active;
-- alter table public.children drop column if exists archived_at;
