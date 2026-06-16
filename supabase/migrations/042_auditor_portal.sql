-- ============================================================================
-- 042_auditor_portal.sql — Auditor Read-Only Portal Phase 1 (REBUILD)
--
-- Authoritative design: docs/auditor-portal-auth-design.md (auth re-scope,
-- supersedes the original Phase 1 HMAC-signed-link design).
--
-- This migration ships the schema + the universal seal for the auditor
-- portal. The Edge Functions (api/auditor-mint.js, api/auditor-read.js,
-- api/auditor-revoke.js) ship in the same PR and are the in-code boundary;
-- this migration is the durable seal that wraps the boundary so a
-- compromise of the Edge Function can't bypass it.
--
-- Phase 1 ships ONLY the security layer. NO provider-side UI (Phase 2)
-- and NO auditor-facing reading UI (Phase 3) yet.
--
-- Seth's locked decisions (from the auth re-scope doc § 7):
--   - § 7.1  Amend migration 042 (NOT add 043). The original Phase 1's
--            042 was never applied; this file replaces it.
--   - § 7.2  Lifecycle: Vercel Cron, hourly. (Job in api/cron-auditor-
--            lifecycle.js; this migration creates the schema it reads.)
--   - § 7.3  Password length 20 chars (enforced in api/auditor-mint.js,
--            not in DB).
--   - § 7.4  Enforce unique-active session per (auditor_user_id,
--            provider_id) — partial unique index below.
--   - § 7.7  Universal RLS deny on EVERY public table. Templated below
--            via a DO block iterating information_schema.tables.
--
-- THE BINDING INVARIANT this migration enforces, restated for the
-- reader:
--
--   An auditor temp account is a SEALED READ-ONLY BOX around ONE
--   provider's records. The Edge Function api/auditor-read.js is the
--   only data path. EVERY other path — direct PostgREST query against
--   any domain table, any other Edge Function, the storage REST API —
--   is denied by this migration's RESTRICTIVE auditor-deny policy.
--
-- TABLES CREATED:
--   public.auditor_sessions
--   public.auditor_session_access_log
--
-- COLUMNS ADDED:
--   public.profiles.is_audit_account   (boolean, default false)
--   public.profiles.password_disabled_at (timestamptz; null = live)
--
-- FUNCTIONS CREATED:
--   public.is_auditor_jwt()   -- the seal's single point of truth
--   public.handle_new_user()  -- REPLACED to set is_audit_account
--
-- POLICY CREATED ON EVERY PUBLIC TABLE:
--   "auditor jwt denied"      -- RESTRICTIVE: NOT is_auditor_jwt()
--
-- IDEMPOTENT: re-applying this migration is a no-op (CREATE TABLE IF
-- NOT EXISTS; DROP POLICY IF EXISTS before each CREATE POLICY; CREATE
-- OR REPLACE FUNCTION).
--
-- VERIFICATION (run after apply, in Supabase SQL Editor as service-role
-- — this verifies SCHEMA + POLICY COVERAGE only, NOT auth-gated logic.
-- Per CLAUDE.md rule 3 the auth-gated bits are live-gated in browser):
--
--   -- (a) Both new tables exist with expected columns.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'auditor_sessions'
--    order by ordinal_position;
--   -- Expect (in order): id (uuid NO), provider_id (uuid NO),
--   --   auditor_user_id (uuid YES), email_at_creation (text NO),
--   --   starts_at (timestamptz NO), expires_at (timestamptz NO),
--   --   revoked_at (timestamptz YES), revoked_by_user_id (uuid YES),
--   --   auditor_label (text YES),
--   --   auditor_acknowledged_at (timestamptz YES),
--   --   auditor_acknowledged_label (text YES), notes (text YES),
--   --   created_at (timestamptz NO), updated_at (timestamptz NO).
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'auditor_session_access_log'
--    order by ordinal_position;
--
--   -- (b) profiles got the two new columns.
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name in ('is_audit_account','password_disabled_at')
--    order by column_name;
--   -- Expect: is_audit_account boolean NO 'false', password_disabled_at timestamptz YES.
--
--   -- (c) THE SEAL-COVERAGE CHECK — the universal-deny policy lands
--   --     on every public BASE TABLE. This query IS the one-line
--   --     verification asked for in the build brief.
--   select tablename from pg_policies
--    where policyname = 'auditor jwt denied' and schemaname = 'public'
--    order by tablename;
--   -- Expect: every base table in public schema.
--
--   -- (d) Sanity: count of tables that DON'T have the policy.
--   --     Should be zero.
--   select t.tablename
--     from pg_tables t
--    where t.schemaname = 'public'
--      and not exists (
--        select 1 from pg_policies p
--         where p.schemaname = 'public'
--           and p.tablename = t.tablename
--           and p.policyname = 'auditor jwt denied'
--      )
--    order by t.tablename;
--   -- Expect: zero rows. If any row appears, the seal has a hole;
--   --   investigate and either add the policy or document why the
--   --   table is exempt.
--
--   -- (e) is_auditor_jwt() returns false in the SQL Editor (no JWT).
--   select public.is_auditor_jwt();
--   -- Expect: false. (The SQL Editor runs as service-role with no
--   --   auth.jwt(); the helper's COALESCE-to-false handles that case.)
--
--   -- (f) The 72h CHECK + revoked_at-after-start CHECK exist.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.auditor_sessions'::regclass and contype = 'c'
--    order by conname;
--   -- Expect:
--   --   auditor_sessions_expiry_window CHECK (expires_at > starts_at AND expires_at <= starts_at + '72:00:00'::interval)
--   --   auditor_sessions_revoked_at_after_start CHECK (revoked_at IS NULL OR revoked_at >= starts_at)
--
--   -- (g) Partial unique index for active-session-per-(auditor,
--   --     provider) exists.
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'auditor_sessions'
--    order by indexname;
--   -- Expect to include:
--   --   auditor_sessions_active_unique_idx
--   --     UNIQUE (auditor_user_id, provider_id)
--   --     WHERE revoked_at IS NULL AND expires_at > now()
--
-- ROLLBACK (destructive — restores schema to pre-042 state. Do NOT
-- run after Phase 2 / Phase 3 have shipped):
--
--   drop policy if exists "auditor jwt denied" on public.<every table>;
--     -- regenerate the DROP list from `select tablename from
--     -- pg_policies where policyname = 'auditor jwt denied'`.
--   drop table if exists public.auditor_session_access_log;
--   drop table if exists public.auditor_sessions;
--   drop function if exists public.is_auditor_jwt();
--   alter table public.profiles drop column if exists is_audit_account;
--   alter table public.profiles drop column if exists password_disabled_at;
--   -- handle_new_user trigger: restore the body from migration 001.
-- ============================================================================

begin;

-- -------------------------------------------------------
-- 1. profiles — two new columns
-- -------------------------------------------------------
-- is_audit_account: persistent flag, "this profile is the identity of
-- an external auditor temp account." Read by the mint endpoint's
-- email-uniqueness gate. Set by the handle_new_user trigger from
-- raw_app_meta_data.role at account creation.
--
-- password_disabled_at: set by the lifecycle cron when the auditor's
-- password is rotated to a random unguessable value. Null = the
-- password is the one the provider handed out on the most recent
-- mint. Non-null = the account can no longer log in. Idempotency:
-- the cron skips rows where password_disabled_at IS NOT NULL.
alter table public.profiles
  add column if not exists is_audit_account boolean not null default false;
alter table public.profiles
  add column if not exists password_disabled_at timestamptz;

-- -------------------------------------------------------
-- 2. handle_new_user — REPLACED to set is_audit_account
-- -------------------------------------------------------
-- Migration 001's version did NOT set is_audit_account (the column
-- didn't exist). The replacement reads raw_app_meta_data.role and
-- defaults to false when the claim is absent. Trigger itself
-- (on_auth_user_created) was created in migration 001 and is
-- unchanged here; we only swap the function body.
--
-- COALESCE keeps the trigger safe when raw_app_meta_data is null
-- (Supabase initializes it to '{}' but defensive parsing here).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, full_name, email, is_audit_account)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.email,
    coalesce((new.raw_app_meta_data ->> 'role') = 'auditor', false)
  );
  return new;
end;
$$;

-- Canonical revoke/grant trailer (CLAUDE.md rule 4). handle_new_user
-- runs ONLY as the on_auth_user_created trigger; the trigger system
-- doesn't consult EXECUTE grants — but lock it down anyway so the
-- function name can't be invoked directly by anon as a side channel.
revoke all     on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
grant  execute on function public.handle_new_user() to authenticated;

-- -------------------------------------------------------
-- 3. is_auditor_jwt() — the seal's single point of truth
-- -------------------------------------------------------
-- Returns true iff the calling JWT's app_metadata.role = 'auditor'.
-- Used in the templated RESTRICTIVE policy on every public table.
-- COALESCE-to-false handles every "no JWT" case (service-role
-- without auth.jwt(), anon without app_metadata, malformed claims).
--
-- STABLE: the JWT does not change within a query.
-- SECURITY DEFINER + set search_path: matches the 015 hardening
-- convention so the function is stable across schemas.
create or replace function public.is_auditor_jwt()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
    (auth.jwt()->'app_metadata'->>'role') = 'auditor',
    false
  );
$$;

-- Canonical revoke/grant trailer.
revoke all     on function public.is_auditor_jwt() from public;
revoke execute on function public.is_auditor_jwt() from anon;
grant  execute on function public.is_auditor_jwt() to authenticated;

-- -------------------------------------------------------
-- 4. auditor_sessions — provider-minted, single-provider-scoped
-- -------------------------------------------------------
-- Carries forward from the original 042 design:
--   - Provider scope via provider_id (RLS gate).
--   - Expiry + revocation columns.
--   - 72h cap CHECK + revoked-after-start CHECK.
--   - Updated_at trigger.
--
-- NEW vs the original Phase 1 (auth re-scope):
--   - auditor_user_id: the temp account this session reaches data
--     through. NULL allowed (set-null on auth.users delete) for
--     audit retention.
--   - email_at_creation: the state email the temp account was
--     created for. Carried separately for forensic clarity even
--     though the auditor profile retains the email.
--   - DROPPED signing_key_version (no HMAC anymore).
--   - Partial unique index: at most ONE active session per
--     (auditor_user_id, provider_id). Re-inviting the same auditor
--     for the same provider must extend/replace, not duplicate.
create table if not exists public.auditor_sessions (
  id                          uuid primary key default gen_random_uuid(),
  provider_id                 uuid not null references public.profiles(id) on delete cascade,
  auditor_user_id             uuid references auth.users(id) on delete set null,
  email_at_creation           text not null,
  starts_at                   timestamptz not null default now(),
  expires_at                  timestamptz not null,
  revoked_at                  timestamptz,
  revoked_by_user_id          uuid references auth.users(id) on delete set null,
  auditor_label               text,
  auditor_acknowledged_at     timestamptz,
  auditor_acknowledged_label  text,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint auditor_sessions_expiry_window check (
    expires_at > starts_at
    and expires_at <= starts_at + interval '72 hours'
  ),
  constraint auditor_sessions_revoked_at_after_start check (
    revoked_at is null or revoked_at >= starts_at
  )
);

create index if not exists auditor_sessions_provider_created_idx
  on public.auditor_sessions (provider_id, created_at desc);
create index if not exists auditor_sessions_expires_idx
  on public.auditor_sessions (expires_at);
create index if not exists auditor_sessions_auditor_user_idx
  on public.auditor_sessions (auditor_user_id);

-- Unique active session per (auditor_user_id, provider_id). A
-- second active mint for the same pair fails the unique index.
create unique index if not exists auditor_sessions_active_unique_idx
  on public.auditor_sessions (auditor_user_id, provider_id)
  where revoked_at is null and expires_at > now();

alter table public.auditor_sessions enable row level security;

-- Provider-only SELECT/INSERT/UPDATE. NO DELETE policy.
drop policy if exists "Providers select own auditor sessions" on public.auditor_sessions;
drop policy if exists "Providers insert own auditor sessions" on public.auditor_sessions;
drop policy if exists "Providers update own auditor sessions" on public.auditor_sessions;
create policy "Providers select own auditor sessions"
  on public.auditor_sessions for select
  using (auth.uid() = provider_id);
create policy "Providers insert own auditor sessions"
  on public.auditor_sessions for insert
  with check (auth.uid() = provider_id);
create policy "Providers update own auditor sessions"
  on public.auditor_sessions for update
  using (auth.uid() = provider_id)
  with check (auth.uid() = provider_id);

drop trigger if exists set_auditor_sessions_updated_at on public.auditor_sessions;
create trigger set_auditor_sessions_updated_at
  before update on public.auditor_sessions
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 5. auditor_session_access_log — append-only audit trail
-- -------------------------------------------------------
-- Carries forward unchanged from the original 042. Service-role
-- only writes (no INSERT policy); provider SELECTs their own via
-- sub-select; no UPDATE/DELETE. The auditor-deny policy added in
-- step 6 below provides defense-in-depth.
create table if not exists public.auditor_session_access_log (
  id                       uuid primary key default gen_random_uuid(),
  session_id               uuid not null references public.auditor_sessions(id) on delete restrict,
  event_kind               text not null,
  read_resource_type       text,
  read_resource_id         uuid,
  read_resource_descriptor jsonb,
  denial_reason            text,
  ip_address               inet,
  user_agent               text,
  occurred_at              timestamptz not null default now(),
  constraint auditor_session_access_log_event_kind_valid check (
    event_kind in (
      'read',
      'denied',
      'session_created',
      'session_revoked',
      'session_extended',
      'signed_url_minted',
      'password_rotated'
    )
  ),
  constraint auditor_session_access_log_denial_reason_valid check (
    denial_reason is null or denial_reason in (
      'out_of_scope',
      'expired',
      'revoked',
      'invalid_token',
      'unknown_resource',
      'malformed_request',
      'rate_limited',
      'email_collision'
    )
  ),
  constraint auditor_session_access_log_denial_iff_denied check (
    (event_kind = 'denied' and denial_reason is not null)
    or (event_kind <> 'denied' and denial_reason is null)
  )
);

create index if not exists auditor_session_access_log_session_idx
  on public.auditor_session_access_log (session_id, occurred_at desc);

alter table public.auditor_session_access_log enable row level security;

drop policy if exists "Providers select own session access log" on public.auditor_session_access_log;
create policy "Providers select own session access log"
  on public.auditor_session_access_log for select
  using (
    auth.uid() in (
      select provider_id
        from public.auditor_sessions
       where id = auditor_session_access_log.session_id
    )
  );

-- -------------------------------------------------------
-- 6. THE SEAL — universal "auditor jwt denied" RESTRICTIVE policy
--    on every public BASE TABLE
-- -------------------------------------------------------
-- This is the load-bearing piece of the rebuild. PostgreSQL
-- RESTRICTIVE policies are AND-combined with all other policies;
-- an auditor JWT (where is_auditor_jwt() = true) fails the
-- restrictive check on every table it tries to read, regardless
-- of what permissive policies otherwise grant.
--
-- The DO block iterates information_schema.tables WHERE
-- table_schema='public' AND table_type='BASE TABLE'. For each:
--   - Enables RLS (idempotent: ENABLE on an already-RLS table is
--     a no-op).
--   - Drops the policy if it exists (so re-runs replace, not
--     duplicate-error).
--   - Creates the policy with body 'NOT public.is_auditor_jwt()'.
--
-- The policy is named 'auditor jwt denied' uniformly across every
-- table, so the verification query is one line:
--   select tablename from pg_policies
--    where policyname = 'auditor jwt denied' and schemaname='public';
--
-- This iterates EVERY public table — including auditor_sessions
-- and auditor_session_access_log themselves. That's deliberate:
-- the auditor's JWT must not enumerate or read these tables
-- either (the Edge Function does the auditor-side reads via
-- service-role).
--
-- Tables that get created AFTER this migration will NOT
-- automatically receive the policy. Future migrations must add it
-- explicitly OR a maintenance task re-runs the policy
-- application. See the verification queries (d) above; they are
-- the catch-all "did we miss any?" check.
do $$
declare
  r record;
begin
  for r in
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
  loop
    execute format(
      'alter table public.%I enable row level security',
      r.table_name
    );
    execute format(
      'drop policy if exists "auditor jwt denied" on public.%I',
      r.table_name
    );
    execute format(
      'create policy "auditor jwt denied" on public.%I '
      || 'as restrictive '
      || 'for all '
      || 'using (not public.is_auditor_jwt()) '
      || 'with check (not public.is_auditor_jwt())',
      r.table_name
    );
  end loop;
end$$;

commit;

-- ============================================================================
-- End of migration 042_auditor_portal.sql (REBUILD with universal seal)
-- ============================================================================
