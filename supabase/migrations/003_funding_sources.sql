-- ============================================================
-- MI Little Care — Phase 3: Funding Sources Scaffolding
--
-- Establishes the foundational data model for the funding-source-driven
-- module activation system. See docs/funding_source_spec.md.
--
-- Hybrid attachment model (decided 2026-05-13):
--   - private_pay funding sources attach to families.id (rates are per-family)
--   - cdc_scholarship, tri_share, gsrp, head_start, agency_other attach to
--     children.id (state authorizations are per-child)
--   - A CHECK constraint enforces this mapping at the row level.
--
-- Funding-coverage invariant (enforced in application code, not SQL):
--   - Every active family must have at least one funding source attached
--     (typically private_pay).
--   - Any child enrolled in a state program must have an additional
--     funding source of that program's type attached to that child.
--   - There is intentionally NO child-level "must have a funding source"
--     invariant — coverage flows down from the family's private_pay row.
--
-- Soft-delete pattern: this migration introduces archived_at as the new
-- audit-retention pattern for funding-related rows (4 years for licensed
-- providers, longer for license-exempt — see CLAUDE.md). Existing tables
-- in this codebase use hard delete; new tables use archived_at instead.
-- archived_at is intentionally NOT added to billing_periods: those rows
-- are operational, not audit-retained.
-- ============================================================

-- -------------------------------------------------------
-- 1. Enums
-- -------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'funding_source_type') then
    create type public.funding_source_type as enum (
      'private_pay',
      'cdc_scholarship',
      'tri_share',
      'gsrp',
      'head_start',
      'agency_other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'funding_source_status') then
    create type public.funding_source_status as enum (
      'active',
      'paused',
      'ended'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_period_status') then
    create type public.billing_period_status as enum (
      'upcoming',
      'open',
      'submitted',
      'paid',
      'reconciled'
    );
  end if;
end$$;

-- -------------------------------------------------------
-- 2. funding_sources
-- -------------------------------------------------------
create table if not exists public.funding_sources (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references auth.users(id) on delete cascade not null,

  -- Hybrid FK: exactly one of child_id, family_id is non-null.
  -- private_pay -> family_id; everything else -> child_id.
  child_id              uuid references public.children(id) on delete cascade,
  family_id             uuid references public.families(id) on delete cascade,

  type                  public.funding_source_type    not null,
  status                public.funding_source_status  not null default 'active',

  start_date            date    not null,
  end_date              date,
  -- priority: lower number is consumed first. Per spec, private_pay
  -- defaults to 99 (last) and all other types default to 1 (first).
  -- A BEFORE INSERT trigger fills the default based on type when the
  -- caller omits priority; a column default cannot vary by type.
  priority              integer not null,
  hours_cap_per_period  integer,
  notes                 text,

  details               jsonb   not null default '{}'::jsonb,

  archived_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint funding_sources_one_owner check (
    (child_id is null) <> (family_id is null)
  ),

  constraint funding_sources_type_attachment check (
    (type = 'private_pay' and family_id is not null and child_id is null)
    or
    (type <> 'private_pay' and child_id is not null and family_id is null)
  ),

  constraint funding_sources_dates_ordered check (
    end_date is null or end_date >= start_date
  )
);

create index if not exists funding_sources_user_id_idx
  on public.funding_sources(user_id);
create index if not exists funding_sources_child_id_idx
  on public.funding_sources(child_id) where child_id is not null;
create index if not exists funding_sources_family_id_idx
  on public.funding_sources(family_id) where family_id is not null;
create index if not exists funding_sources_user_active_idx
  on public.funding_sources(user_id, status) where archived_at is null;
create index if not exists funding_sources_details_gin
  on public.funding_sources using gin(details);

alter table public.funding_sources enable row level security;

create policy "Users can view their own funding sources"
  on public.funding_sources for select
  using (auth.uid() = user_id);

create policy "Users can insert their own funding sources"
  on public.funding_sources for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own funding sources"
  on public.funding_sources for update
  using (auth.uid() = user_id);

create policy "Users can delete their own funding sources"
  on public.funding_sources for delete
  using (auth.uid() = user_id);

create trigger set_funding_sources_updated_at
  before update on public.funding_sources
  for each row execute procedure public.set_updated_at();

-- Type-aware priority default. Caller may omit priority; trigger fills
-- it based on type before the NOT NULL constraint is checked.
create or replace function public.set_funding_source_priority_default()
returns trigger
language plpgsql
as $$
begin
  if new.priority is null then
    if new.type = 'private_pay' then
      new.priority := 99;
    else
      new.priority := 1;
    end if;
  end if;
  return new;
end;
$$;

create trigger set_funding_sources_priority_default
  before insert on public.funding_sources
  for each row execute procedure public.set_funding_source_priority_default();

-- -------------------------------------------------------
-- 3. billing_periods
-- -------------------------------------------------------
-- Tracks reporting periods for state-payable funding sources (CDC, etc).
-- Avoids hard-coding pay schedules anywhere in the app.
create table if not exists public.billing_periods (
  id                      uuid default gen_random_uuid() primary key,
  user_id                 uuid references auth.users(id) on delete cascade not null,

  funding_type            public.funding_source_type not null,
  period_number           integer,  -- e.g. MiLEAP pay period number for CDC

  start_date              date not null,
  end_date                date not null,
  reporting_deadline      date not null,

  status                  public.billing_period_status not null default 'upcoming',
  submitted_at            timestamptz,
  expected_payment_date   date,
  actual_payment_date     date,
  actual_payment_amount   numeric(12,2),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint billing_periods_dates_ordered check (end_date >= start_date)
);

create index if not exists billing_periods_user_idx
  on public.billing_periods(user_id);
create index if not exists billing_periods_user_type_idx
  on public.billing_periods(user_id, funding_type, start_date);

alter table public.billing_periods enable row level security;

create policy "Users can view their own billing periods"
  on public.billing_periods for select
  using (auth.uid() = user_id);

create policy "Users can insert their own billing periods"
  on public.billing_periods for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own billing periods"
  on public.billing_periods for update
  using (auth.uid() = user_id);

create policy "Users can delete their own billing periods"
  on public.billing_periods for delete
  using (auth.uid() = user_id);

create trigger set_billing_periods_updated_at
  before update on public.billing_periods
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 4. tri_share_hubs
-- -------------------------------------------------------
-- Directory of MI Tri-Share regional hubs. Shared across all providers,
-- read-only from the app, seeded server-side.
-- TODO: seed with the 12 known hubs from https://mitrishare.org/ in a
-- follow-up PR.
create table if not exists public.tri_share_hubs (
  id              uuid default gen_random_uuid() primary key,
  name            text not null,
  region          text,
  contact_email   text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.tri_share_hubs enable row level security;

create policy "Authenticated users can view tri share hubs"
  on public.tri_share_hubs for select
  to authenticated
  using (true);

-- No insert/update/delete policies: writes happen server-side only.

create trigger set_tri_share_hubs_updated_at
  before update on public.tri_share_hubs
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- drop trigger if exists set_tri_share_hubs_updated_at on public.tri_share_hubs;
-- drop trigger if exists set_billing_periods_updated_at on public.billing_periods;
-- drop trigger if exists set_funding_sources_priority_default on public.funding_sources;
-- drop trigger if exists set_funding_sources_updated_at on public.funding_sources;
-- drop function if exists public.set_funding_source_priority_default();
-- drop table if exists public.tri_share_hubs;
-- drop table if exists public.billing_periods;
-- drop table if exists public.funding_sources;
-- drop type if exists public.billing_period_status;
-- drop type if exists public.funding_source_status;
-- drop type if exists public.funding_source_type;
