-- ============================================================
-- MI Little Care — PR #15 (Half 1): opt-in reminder system schema
--
-- Authoritative scope: docs/pr-15-opt-in-reminder-system-scope.md
-- (resolved 2026-05-26 review). This migration is Half 1 of two — it
-- adds the schema and the SECURITY DEFINER provider-mutation RPCs.
-- Half 2 (the dispatcher cron, hooks, settings UI, banner host, and
-- vercel.json wiring) is a separate pass.
--
-- DEPENDENCY: applies AFTER migration 022 (license_type, PR #14).
--
-- General-purpose infrastructure: per cross-cutting constraint A, this
-- table set serves both licensed-home compliance categories AND future
-- non-compliance use cases (CDC redetermination reminders, "remember to
-- bill" reminders, MiRegistry deadline reminders). The category string
-- catalog is owned by the application
-- (`src/lib/reminderCategories.js`), not the database — see OQ3 below.
--
-- Initial consumers (one category-string per scope doc):
--   PR #16  — child_annual_review, intake_acknowledgment_pending
--   PR #17  — staff_discipline_policy_ack_pending
--   PR #18  — cpr_first_aid_expiration, physician_attestation_expiration
--   PR #19  — drill_fire, drill_tornado, drill_other
--   PR #20  — medication_authorization_renewal
--   PR #21  — radon_test_due, heating_inspection_due, detector_check_overdue
--   This PR — miregistry_annual_training, fingerprint_reprint (the existing
--             cdcProviderCompliance.js banner surfaces; migration to the
--             new pipeline lands in Half 2).
--
-- ── OQ3 DECISION (subject_type discriminator) ──────────────────────────
-- Free-text (no CHECK enumerating subject_type values). Rationale:
--   1. The category string is itself free-text for the same evolution
--      reason as license_type in PR #14 (text + CHECK was chosen there
--      because ALTER TYPE ADD VALUE inside a transaction is awkward in
--      Supabase Postgres). Constraining subject_type but not category
--      would create an inconsistent constraint surface.
--   2. The authoritative catalog lives in `src/lib/reminderCategories.js`
--      and enumerates valid (category, subject_type) pairs. The
--      application is the validator; the database is the store.
--   3. Future categories (post-July CDC redetermination, billing
--      reminders) introduce new subject_types without an ALTER TYPE
--      migration. Net-zero schema churn on every consumer PR.
-- The unique partial indexes below still prevent duplicate instances
-- correctly regardless of whether subject_type is enumerated.
--
-- ── RLS POLICY SHAPE ──────────────────────────────────────────────────
-- reminder_preferences:
--   - Provider-scoped SELECT/INSERT/UPDATE on rows where
--     provider_id = auth.uid().
--   - No DELETE policy (a toggle-off flips `enabled = false`; row is
--     never deleted so a re-enable preserves channel + lead_time_days).
--
-- reminder_instances:
--   - Provider-scoped SELECT on rows where provider_id = auth.uid().
--   - **No client-facing INSERT or UPDATE policy.** The dispatcher cron
--     and per-category schedulers run server-side under the service
--     role (which bypasses RLS). The only provider-side mutations
--     allowed are setting `dismissed_at` and `resolved_at`, exposed via
--     two SECURITY DEFINER RPCs (`reminder_instance_dismiss`,
--     `reminder_instance_resolve`) defined below. Direct UPDATEs by the
--     authenticated role are denied by RLS.
--   - No DELETE policy (soft-delete only, via `archived_at`).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- Every CREATE TABLE / INDEX / FUNCTION uses IF NOT EXISTS or OR REPLACE.
-- Every CREATE POLICY uses the DROP-then-CREATE pattern (Postgres does
-- not support CREATE POLICY IF NOT EXISTS — see migration 016 lesson
-- in docs/tech_debt.md and migration 015).
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Per docs/tech_debt.md § "Verification gap discovered 2026-05-15": the
-- user runs these in the Supabase web SQL Editor and screenshots the
-- results BEFORE writing the runbook Migration History entry.
--
--   -- a) Tables and columns exist:
--   select table_name from information_schema.tables
--   where table_schema='public'
--     and table_name in ('reminder_preferences','reminder_instances')
--   order by table_name;
--   -- expect: two rows.
--
--   -- b) Indexes exist:
--   select indexname from pg_indexes
--   where schemaname='public'
--     and tablename in ('reminder_preferences','reminder_instances')
--   order by indexname;
--   -- expect:
--   --   idx_reminder_instances_active
--   --   idx_reminder_instances_pending
--   --   idx_reminder_instances_unique_subject     (partial — subject_id NOT NULL)
--   --   idx_reminder_instances_unique_no_subject  (partial — subject_id IS NULL)
--   --   reminder_preferences_pkey
--   --   reminder_preferences_provider_category_uq
--   --   reminder_instances_pkey
--
--   -- c) RPCs exist:
--   select proname from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname in ('reminder_instance_dismiss','reminder_instance_resolve')
--   order by proname;
--   -- expect: two rows.
--
--   -- d) RLS enabled + policies:
--   select tablename, policyname from pg_policies
--   where schemaname='public'
--     and tablename in ('reminder_preferences','reminder_instances')
--   order by tablename, policyname;
--   -- expect: 3 policies on reminder_preferences (select/insert/update)
--   --        1 policy  on reminder_instances    (select)
-- ============================================================

-- -------------------------------------------------------
-- 1. reminder_preferences
-- -------------------------------------------------------
create table if not exists public.reminder_preferences (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references auth.users(id) on delete cascade,
  category        text not null,
  -- Channel CHECK matches the catalog's enumeration. (Note: ENUM was
  -- considered and rejected for the same OQ1 / column-shape reason in
  -- PR #14: text + CHECK is easier to extend than an ENUM that can't
  -- ADD VALUE inside a transaction.)
  channel         text not null default 'in_app'
    check (channel in ('in_app', 'email', 'both')),
  lead_time_days  integer not null default 7
    check (lead_time_days between 0 and 365),
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint reminder_preferences_provider_category_uq
    unique (provider_id, category)
);

create trigger reminder_preferences_set_updated_at
  before update on public.reminder_preferences
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 2. reminder_instances
-- -------------------------------------------------------
create table if not exists public.reminder_instances (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references auth.users(id) on delete cascade,
  category        text not null,

  -- subject_type / subject_id pair — polymorphic anchor per OQ3 (see
  -- header). NULL when the reminder is provider-level (e.g. drill_fire).
  subject_type    text,
  subject_id      uuid,

  trigger_at      timestamptz not null,
  due_at          timestamptz,

  title           text not null,
  body            text,
  cta_path        text,

  fired_at        timestamptz,
  fired_via       text check (
    fired_via is null or fired_via in ('in_app','email','both')
  ),
  dismissed_at    timestamptz,
  resolved_at     timestamptz,

  archived_at     timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger reminder_instances_set_updated_at
  before update on public.reminder_instances
  for each row execute function public.set_updated_at();

-- Uniqueness — two partial indexes because Postgres treats NULL as
-- distinct from NULL in unique constraints, which would let multiple
-- "same provider, same category, same trigger time, no subject" rows
-- through. Splitting on subject_id NULL gives clean dedup for both
-- subject-bound and provider-level reminders.
create unique index if not exists idx_reminder_instances_unique_subject
  on public.reminder_instances (provider_id, category, subject_type, subject_id, trigger_at)
  where subject_id is not null;

create unique index if not exists idx_reminder_instances_unique_no_subject
  on public.reminder_instances (provider_id, category, trigger_at)
  where subject_id is null;

-- Hot path: dispatcher reads pending instances grouped by provider.
create index if not exists idx_reminder_instances_pending
  on public.reminder_instances (provider_id, trigger_at)
  where fired_at is null and resolved_at is null and archived_at is null;

-- Banner host: per-provider active instances ordered by trigger.
create index if not exists idx_reminder_instances_active
  on public.reminder_instances (provider_id, category, trigger_at)
  where dismissed_at is null and resolved_at is null and archived_at is null;

-- -------------------------------------------------------
-- 3. RLS — reminder_preferences (provider owns their own prefs)
-- -------------------------------------------------------
alter table public.reminder_preferences enable row level security;

drop policy if exists "Providers can view their own reminder preferences" on public.reminder_preferences;
create policy "Providers can view their own reminder preferences"
  on public.reminder_preferences for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their own reminder preferences" on public.reminder_preferences;
create policy "Providers can insert their own reminder preferences"
  on public.reminder_preferences for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their own reminder preferences" on public.reminder_preferences;
create policy "Providers can update their own reminder preferences"
  on public.reminder_preferences for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- -------------------------------------------------------
-- 4. RLS — reminder_instances (provider read-only; mutations via RPC)
-- -------------------------------------------------------
alter table public.reminder_instances enable row level security;

drop policy if exists "Providers can view their own reminder instances" on public.reminder_instances;
create policy "Providers can view their own reminder instances"
  on public.reminder_instances for select to authenticated
  using (provider_id = auth.uid());

-- Note: deliberately NO INSERT, UPDATE, or DELETE policy for the
-- authenticated role. The service role (cron + per-category
-- schedulers) bypasses RLS; provider dismiss/resolve mutations go
-- through the SECURITY DEFINER RPCs below.

-- -------------------------------------------------------
-- 5. SECURITY DEFINER RPCs — provider dismiss / resolve
-- -------------------------------------------------------
-- Provider's only allowed mutation on reminder_instances is to set
-- `dismissed_at` (close the banner until next tick) or `resolved_at`
-- (close it permanently because the underlying deadline was satisfied).
-- Implemented as RPCs rather than column-level UPDATE policies because
-- a "any column may be set EXCEPT these two specific columns set to
-- these specific values" rule does not have a clean policy expression
-- in Postgres.
--
-- Both RPCs are no-ops when:
--   - the instance does not exist
--   - the instance belongs to a different provider
--   - the target column is already set (idempotent re-call)
--   - the instance is archived
-- This makes them safe to wire to a UI button without race-condition
-- handling on the client.

create or replace function public.reminder_instance_dismiss(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reminder_instances
     set dismissed_at = now()
   where id = p_instance_id
     and provider_id = auth.uid()
     and dismissed_at is null
     and archived_at is null;
end;
$$;

create or replace function public.reminder_instance_resolve(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reminder_instances
     set resolved_at = now()
   where id = p_instance_id
     and provider_id = auth.uid()
     and resolved_at is null
     and archived_at is null;
end;
$$;

-- Allow authenticated users to invoke these RPCs (the function body
-- itself enforces ownership via auth.uid()).
revoke all on function public.reminder_instance_dismiss(uuid) from public;
grant execute on function public.reminder_instance_dismiss(uuid) to authenticated;
revoke all on function public.reminder_instance_resolve(uuid) from public;
grant execute on function public.reminder_instance_resolve(uuid) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- drop function if exists public.reminder_instance_resolve(uuid);
-- drop function if exists public.reminder_instance_dismiss(uuid);
-- drop table if exists public.reminder_instances;
-- drop table if exists public.reminder_preferences;
