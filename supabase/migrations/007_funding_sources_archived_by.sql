-- ============================================================
-- MI Little Care — Phase 7: archived_by audit column on funding_sources
--
-- Adds user attribution for soft deletes. When a provider archives a
-- funding source from the new Funding tab, archived_by records the
-- auth.users.id of the actor. Coupled with archived_at (from
-- migration 003) this gives the full who/when story for the
-- four-year audit-retention window described in CLAUDE.md.
--
-- Nullable on purpose: rows archived by automated processes (cron
-- jobs, future cleanup migrations, server-side scripts) may leave
-- archived_by null. We do NOT add a CHECK linking archived_at and
-- archived_by — the bidirectional constraint would block legitimate
-- system-level archives and offers limited safety value.
--
-- ON DELETE SET NULL: if the actor's auth.users row is later deleted
-- (account closure, GDPR deletion), the audit row stays — the FK
-- becomes null, but archived_at and the underlying funding source
-- record remain intact for retention compliance.
--
-- No backfill needed: every funding_sources row created so far is
-- status='active' / archived_at=null (the 14 rows from migration 006
-- plus any added through the UI before this migration ships).
-- ============================================================

alter table public.funding_sources
  add column if not exists archived_by uuid
    references auth.users(id) on delete set null;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.funding_sources drop column if exists archived_by;
