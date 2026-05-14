-- ============================================================
-- MI Little Care — Phase 5: MiRegistry deadline tracker
--
-- Implements the data model from docs/miregistry_tracker_spec.md
-- (PR #3 spec, merged 2026-05-14). Two changes:
--
-- 1. New table public.miregistry_training_entries (with enum) — the
--    source of truth for every completed training, one row per
--    completion event. Replaces single-date column
--    profiles.annual_training_completion_date as the system of
--    record (that column is being deprecated; see docs/tech_debt.md).
--
-- 2. Three new columns on public.profiles for the manually
--    transcribed Training Level state:
--      - miregistry_current_level             ('level_1' | 'level_2')
--      - miregistry_level_2_expires_on        date
--      - miregistry_level_last_updated_at     timestamptz
--    All three are null until the provider transcribes them from
--    their MiRegistry LEP Training Record. MiRegistry is
--    authoritative; we hold what they typed plus a "last updated by
--    you on" stamp so they can gauge freshness.
--
-- Cited rules (handbook = docs/reference/Scholarship Handbook for
-- License Exempt Provider.pdf, rev 2026-04-01):
--   - Source enum values map to handbook page 11–13 (LEP Training
--     Levels and Annual Ongoing Training).
--   - hours per single training session: handbook page 13 says each
--     Level 2 training "must be one hour or longer" — we do NOT
--     enforce that at the column level because LEPPT and Other
--     entries don't share the rule. Application-level validation
--     surfaces it where appropriate.
--   - Soft-delete via archived_at + archived_by mirrors the
--     funding_sources / funding_documents convention (PR #1, PR #2).
--     Training entries are evidence of qualification at the time of
--     billing; same 4-year retention horizon as funding records.
--
-- Non-changes:
--   - profiles.annual_training_completion_date is intentionally
--     untouched. It stays in the schema as a no-op for backward
--     compatibility; a follow-up cleanup PR will drop it after this
--     PR's implementation has stopped writing to it (per
--     docs/tech_debt.md § Planned deprecations).
-- ============================================================

-- -------------------------------------------------------
-- 1. Enum
-- -------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'miregistry_training_source') then
    create type public.miregistry_training_source as enum (
      'leppt',             -- one-time initial LEP Provider Preservice Training
      'annual_ongoing',    -- Michigan Ongoing Health & Safety Refresher (Dec 16 deadline)
      'level_2_approved',  -- any other MiRegistry-approved training, ≥ 1 hour
      'other'              -- training the provider chose to log but doesn't fit above
    );
  end if;
end$$;

-- -------------------------------------------------------
-- 2. miregistry_training_entries table
-- -------------------------------------------------------
create table if not exists public.miregistry_training_entries (
  id                  uuid default gen_random_uuid() primary key,
  user_id             uuid references auth.users(id) on delete cascade not null,

  completed_on        date not null,
  hours               numeric(5,2) not null check (hours > 0 and hours < 100),
  title               text not null,
  source              public.miregistry_training_source not null,

  -- Optional: MiRegistry's per-event ID. V2 hook for direct import.
  miregistry_event_id text,
  notes               text,

  -- Soft-delete pair (mirrors funding_sources + funding_documents).
  archived_at         timestamptz,
  archived_by         uuid references auth.users(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- -------------------------------------------------------
-- 3. Indexes
-- -------------------------------------------------------

-- Hot-path lookup for the page: "this provider's active entries,
-- newest first" — drives the entries list and the
-- annual-deadline-for-current-year check.
create index if not exists miregistry_entries_user_completed_idx
  on public.miregistry_training_entries (user_id, completed_on desc)
  where archived_at is null;

-- Secondary: source-type rollups (e.g. "any LEPPT entry?", or
-- year-over-year annual_ongoing audit).
create index if not exists miregistry_entries_user_source_idx
  on public.miregistry_training_entries (user_id, source, completed_on)
  where archived_at is null;

-- -------------------------------------------------------
-- 4. RLS — select / insert / update only
-- -------------------------------------------------------
-- No DELETE policy. Soft-delete is performed by setting archived_at
-- via UPDATE. Matches the convention from migrations 003 and 008.

alter table public.miregistry_training_entries enable row level security;

create policy "Users can view their own training entries"
  on public.miregistry_training_entries for select
  using (auth.uid() = user_id);

create policy "Users can insert their own training entries"
  on public.miregistry_training_entries for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own training entries"
  on public.miregistry_training_entries for update
  using (auth.uid() = user_id);

create trigger set_miregistry_entries_updated_at
  before update on public.miregistry_training_entries
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 5. New columns on profiles for Training Level state
-- -------------------------------------------------------
-- All three nullable; meaningful only for license-exempt providers.
-- Provider transcribes these from their MiRegistry LEP Training
-- Record via the [Update from MiRegistry] modal.
alter table public.profiles
  add column if not exists miregistry_current_level text,
  add column if not exists miregistry_level_2_expires_on date,
  add column if not exists miregistry_level_last_updated_at timestamptz;

-- Constrain miregistry_current_level to the two valid values (or null).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_miregistry_level_values'
  ) then
    alter table public.profiles
      add constraint profiles_miregistry_level_values check (
        miregistry_current_level is null
        or miregistry_current_level in ('level_1', 'level_2')
      );
  end if;
end$$;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.profiles
--   drop constraint if exists profiles_miregistry_level_values;
-- alter table public.profiles
--   drop column if exists miregistry_level_last_updated_at,
--   drop column if exists miregistry_level_2_expires_on,
--   drop column if exists miregistry_current_level;
--
-- drop trigger if exists set_miregistry_entries_updated_at on public.miregistry_training_entries;
-- drop policy if exists "Users can update their own training entries" on public.miregistry_training_entries;
-- drop policy if exists "Users can insert their own training entries" on public.miregistry_training_entries;
-- drop policy if exists "Users can view their own training entries" on public.miregistry_training_entries;
-- drop index if exists public.miregistry_entries_user_source_idx;
-- drop index if exists public.miregistry_entries_user_completed_idx;
-- drop table if exists public.miregistry_training_entries;
-- drop type if exists public.miregistry_training_source;
