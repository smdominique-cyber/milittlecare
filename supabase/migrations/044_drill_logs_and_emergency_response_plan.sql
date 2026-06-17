-- ============================================================
-- MI Little Care — PR #19: drill_logs table + Emergency Response
-- Plan document_type extension.
--
-- 2026-06-17. Backs the four R 400.1939 compliance rows the
-- registry has carried as 'not_yet_modelled' since Phase 1:
--
--   drill_fire_quarterly           every 3 months           (drill_logs)
--   drill_tornado_seasonal         2× Mar-Nov per year      (drill_logs)
--   drill_other_emergencies_annual annual (lockdown / etc.) (drill_logs)
--   emergency_response_plan_on_file plan on file            (compliance_documents)
--
-- TWO MECHANISMS IN ONE MIGRATION:
--
--   1) New `public.drill_logs` table. Each row is one drill the
--      provider conducted: type, date performed, optional duration,
--      optional notes. Drill logs are NOT files; the compliance row
--      resolves from log history, not from an upload. The provider
--      can correct a mis-entered drill (RLS allows UPDATE of own
--      rows; soft-delete via `archived_at` for retention).
--
--   2) Extend the compliance_documents.document_type CHECK to
--      include 'emergency_response_plan'. The plan is a written
--      document — reuses the proven DocumentSlot / compliance_documents
--      substrate, NOT the drill_log table.
--
-- DEPENDENCY: applies AFTER migration 043 (the prior superset of the
-- compliance_documents CHECK). Compatible with migrations 041
-- (intake_packets) and 042 (auditor portal).
--
-- INTERACTION WITH MIGRATION 042 (auditor portal seal):
--
--   Mig 042's `DO` block templates the 'auditor jwt denied'
--   RESTRICTIVE policy across every public BASE TABLE at apply
--   time. The block runs ONCE; tables created AFTER mig 042
--   applied do NOT automatically receive the seal. This migration
--   therefore adds the universal-deny policy on `drill_logs`
--   inline, mirroring exactly what the 042 block would have
--   produced.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
--   - CREATE TABLE IF NOT EXISTS for drill_logs.
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT for the
--     compliance_documents CHECK swap (single transaction so no reader
--     sees an absent constraint).
--   - DROP POLICY IF EXISTS before each CREATE POLICY.
--   - Re-applying the migration is a no-op.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Paste into the Supabase web SQL Editor and screenshot the result
-- BEFORE promoting the migration to Migration History.
--
--   -- (a) drill_logs table exists with the expected columns.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'drill_logs'
--    order by ordinal_position;
--   -- expect (in order): id, user_id, drill_type, performed_on,
--   --   duration_minutes, notes, archived_at, archived_by, created_at,
--   --   updated_at. Nullable: duration_minutes, notes, archived_at,
--   --   archived_by. The rest NOT NULL.
--
--   -- (b) RLS enabled on drill_logs.
--   select relname, relrowsecurity
--     from pg_class
--    where relname = 'drill_logs';
--   -- expect: relrowsecurity = true.
--
--   -- (c) Drill-type CHECK and performed_on-not-future CHECK exist.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.drill_logs'::regclass and contype = 'c'
--    order by conname;
--   -- expect: drill_logs_drill_type_valid + drill_logs_performed_on_not_future
--   --   + drill_logs_duration_positive.
--
--   -- (d) Provider-scoped RLS policies + the auditor-deny RESTRICTIVE
--   --     are all in place.
--   select policyname, cmd, qual, with_check
--     from pg_policies
--    where schemaname='public' and tablename='drill_logs'
--    order by policyname;
--   -- expect 4 rows:
--   --   'Providers select own drill logs'  (SELECT, auth.uid()=user_id)
--   --   'Providers insert own drill logs'  (INSERT, with_check = auth.uid()=user_id)
--   --   'Providers update own drill logs'  (UPDATE)
--   --   'auditor jwt denied'                (ALL, RESTRICTIVE — NOT is_auditor_jwt())
--   -- and confirm NO DELETE policy.
--
--   -- (e) compliance_documents CHECK now accepts emergency_response_plan
--   --     in addition to all the prior values.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: definition lists every value from mig 043 (9 values)
--   --   plus 'emergency_response_plan' (10 values total).
--
--   -- (f) updated_at trigger exists on drill_logs.
--   select trigger_name from information_schema.triggers
--    where event_object_schema='public' and event_object_table='drill_logs';
--   -- expect: set_drill_logs_updated_at.
--
-- ROLLBACK (destructive — only run if rolling forward isn't possible
-- AND no production rows exist):
--   drop table if exists public.drill_logs;
--   alter table public.compliance_documents
--     drop constraint if exists chk_compliance_documents_document_type;
--   alter table public.compliance_documents
--     add constraint chk_compliance_documents_document_type
--     check (document_type in (
--       'fingerprint_reprint',
--       'property_radon_test',
--       'property_heating_inspection',
--       'property_licensing_notebook',
--       'property_co_detectors_per_level',
--       'property_smoke_detectors_per_floor',
--       'property_fire_extinguishers_per_floor',
--       'property_animal_notification',
--       'property_smoking_prohibition_posted'
--     ));
-- ============================================================

begin;

-- -------------------------------------------------------
-- 1. drill_logs — per-drill row, provider-owned
-- -------------------------------------------------------
-- One row per drill the provider conducted. The compliance rows
-- (drill_fire_quarterly, drill_tornado_seasonal,
-- drill_other_emergencies_annual) resolve from the row history,
-- not from a stored aggregate.
--
-- DRILL TYPES (CHECK whitelist, mirrors src/lib/drillSchedule.js):
--
--   'fire'              — drill_fire_quarterly cycle.
--   'tornado'           — drill_tornado_seasonal Mar-Nov pair.
--   'lockdown'          \
--   'shelter_in_place'   } — drill_other_emergencies_annual.
--   'reunification'     /
--   'other'             — catch-all subtype (provider describes in notes).
--
-- The compliance resolver in complianceState.js maps the first
-- three to the fire/tornado/other registry rows; 'lockdown',
-- 'shelter_in_place', 'reunification', and 'other' all satisfy
-- drill_other_emergencies_annual.
create table if not exists public.drill_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  drill_type        text not null,
  performed_on      date not null,
  duration_minutes  numeric(5,2),
  notes             text,
  archived_at       timestamptz,
  archived_by       uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint drill_logs_drill_type_valid check (
    drill_type in (
      'fire',
      'tornado',
      'lockdown',
      'shelter_in_place',
      'reunification',
      'other'
    )
  ),
  -- A drill cannot have been performed in the future. The
  -- registry resolvers compare performed_on against today, and a
  -- future-dated drill would silently extend the next-due date.
  constraint drill_logs_performed_on_not_future check (
    performed_on <= current_date
  ),
  -- Duration is optional; when present, it must be positive.
  constraint drill_logs_duration_positive check (
    duration_minutes is null or duration_minutes > 0
  )
);

-- Primary read pattern: "what drills has THIS provider done, newest
-- first?" The resolver filters by drill_type after fetching the
-- provider's full window.
create index if not exists drill_logs_user_performed_idx
  on public.drill_logs (user_id, performed_on desc)
  where archived_at is null;

-- Type-specific lookup index for the cycle/seasonal/annual
-- resolvers' filter-then-sort.
create index if not exists drill_logs_user_type_performed_idx
  on public.drill_logs (user_id, drill_type, performed_on desc)
  where archived_at is null;

alter table public.drill_logs enable row level security;

-- Idempotent policy recreation.
drop policy if exists "Providers select own drill logs" on public.drill_logs;
drop policy if exists "Providers insert own drill logs" on public.drill_logs;
drop policy if exists "Providers update own drill logs" on public.drill_logs;

create policy "Providers select own drill logs"
  on public.drill_logs for select
  using (auth.uid() = user_id);

create policy "Providers insert own drill logs"
  on public.drill_logs for insert
  with check (auth.uid() = user_id);

-- UPDATE policy enables correction of a mis-entered drill (date typo,
-- wrong type, missing notes). The provider can also flip
-- archived_at via this UPDATE — that's the soft-delete path. No
-- separate DELETE policy: hard deletion is not permitted; the
-- archived_at column is the audit-retained tombstone.
create policy "Providers update own drill logs"
  on public.drill_logs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- NO DELETE policy. Drill logs are an audit-relevant compliance
-- artifact; never hard-deleted (CLAUDE.md "Audit retention" rule).
-- Correctness errors are corrected via UPDATE; cancellations are
-- soft-deletes via archived_at.

-- Universal auditor-deny seal (mirror of migration 042's templated
-- policy, applied inline because the 042 DO block runs once at
-- apply time and does NOT catch tables created later). Without
-- this branch, an auditor JWT could SELECT directly from
-- drill_logs via PostgREST, bypassing the auditor portal's Edge
-- Function boundary.
drop policy if exists "auditor jwt denied" on public.drill_logs;
create policy "auditor jwt denied" on public.drill_logs
  as restrictive
  for all
  using (not public.is_auditor_jwt())
  with check (not public.is_auditor_jwt());

-- updated_at trigger using migration 001's set_updated_at() helper.
drop trigger if exists set_drill_logs_updated_at on public.drill_logs;
create trigger set_drill_logs_updated_at
  before update on public.drill_logs
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 2. compliance_documents.document_type CHECK extension
-- -------------------------------------------------------
-- Adds 'emergency_response_plan' to the existing nine-value CHECK
-- (mig 043). The plan is a single PDF the provider uploads; the
-- emergency_response_plan_on_file registry row resolves via
-- buildComplianceDocResolver('emergency_response_plan'), reading
-- compliance_documents the same way as radon, heating, notebook,
-- and the PR #21 inventory batch.
--
-- New list is a strict superset of the prior list — no existing
-- row is invalidated by the swap.
alter table public.compliance_documents
  drop constraint if exists chk_compliance_documents_document_type;

alter table public.compliance_documents
  add constraint chk_compliance_documents_document_type
  check (document_type in (
    'fingerprint_reprint',
    'property_radon_test',
    'property_heating_inspection',
    'property_licensing_notebook',
    'property_co_detectors_per_level',
    'property_smoke_detectors_per_floor',
    'property_fire_extinguishers_per_floor',
    'property_animal_notification',
    'property_smoking_prohibition_posted',
    'emergency_response_plan'
  ));

commit;

-- ============================================================
-- End of migration 044
-- ============================================================
