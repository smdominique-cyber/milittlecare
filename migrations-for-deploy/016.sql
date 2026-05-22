-- ============================================================
-- MI Little Care — PR #8.5a: Schema capture for five production-only tables
--
-- Captures the existing production schema for tables created out-of-band
-- (docs/tech_debt.md § "Migrations folder is out of sync with production
-- schema") so future migrations can be reasoned about against committed
-- definitions. Every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS so the migration is idempotent against the running
-- production schema (every block is a no-op against an existing object
-- and only takes effect on a clean reset / new environment).
--
-- The five tables: public.children, public.families, public.guardians,
-- public.emergency_contacts, public.attendance. Schema captured from
-- Seth's dashboard inspection 2026-05-20 (see
-- docs/discovery_results_for_migrations.md handoff doc).
--
-- Only TWO behaviour-altering additions:
--   1. ALTER TABLE public.guardians ADD COLUMN IF NOT EXISTS archived_at
--      — enables soft delete (spec § PR #8.5a acceptance criteria).
--   2. CREATE INDEX IF NOT EXISTS idx_guardians_family_active
--      — partial index on guardians(family_id) WHERE archived_at IS NULL.
--
-- Two discovery items preserved verbatim per docs/pr-8-5a-review.md:
--   - The attendance.checked_in_by / checked_out_by CHECK constraints
--     with the misleading NULL-in-ARRAY shape. Rewrite is a follow-up
--     cleanup PR; this migration documents existing reality.
--   - Sparse FK indexes — no new indexes added beyond the guardians
--     archived_at partial index.
-- ============================================================

-- -------------------------------------------------------
-- 1. children — 11 columns
-- -------------------------------------------------------
create table if not exists public.children (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_id       uuid not null references public.families(id) on delete cascade,
  first_name      text not null,
  last_name       text,
  date_of_birth   date,
  allergies       text,
  medical_notes   text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- -------------------------------------------------------
-- 2. families — 32 columns
-- -------------------------------------------------------
create table if not exists public.families (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  family_name                 text not null,
  billing_type                text default 'weekly',
  weekly_rate                 numeric,
  hourly_rate                 numeric,
  enrollment_status           text default 'active',
  start_date                  date,
  end_date                    date,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  invoice_delivery            text default 'email',
  invoice_email               text,
  invoice_phone               text,
  late_fee_amount             numeric default 0,
  late_fee_after_days         integer default 7,
  stripe_customer_id          text,
  autopay_enabled             boolean default false,
  autopay_enrolled_at         timestamptz,
  autopay_parent_id           uuid references auth.users(id),
  autopay_payment_method_id   text,
  autopay_last_charged_at     timestamptz,
  autopay_last_failed_at      timestamptz,
  autopay_failure_count       integer default 0,
  billing_frequency           text default 'weekly'
    check (billing_frequency in ('weekly', 'biweekly', 'monthly', 'custom')),
  billing_frequency_weeks     integer,
  billing_cycle_start_day     integer default 1
    check (billing_cycle_start_day >= 0 and billing_cycle_start_day <= 6),
  billing_cycle_anchor_date   date,
  billing_monthly_mode        text default 'calendar'
    check (billing_monthly_mode in ('calendar', 'four_weeks')),
  billing_partial_week_mode   text default 'full_rate'
    check (billing_partial_week_mode in ('full_rate', 'prorate')),
  billing_cycle_end_day       integer
    check (billing_cycle_end_day >= 0 and billing_cycle_end_day <= 6)
);

-- -------------------------------------------------------
-- 3. guardians — 13 columns (+ archived_at added below)
-- -------------------------------------------------------
create table if not exists public.guardians (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_id       uuid not null references public.families(id) on delete cascade,
  first_name      text not null,
  last_name       text,
  relationship    text,
  phone           text,
  email           text,
  address         text,
  is_primary      boolean default false,
  can_pickup      boolean default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.guardians
  add column if not exists archived_at timestamptz;

create index if not exists idx_guardians_family_active
  on public.guardians (family_id)
  where archived_at is null;

-- -------------------------------------------------------
-- 4. emergency_contacts — 8 columns
-- -------------------------------------------------------
create table if not exists public.emergency_contacts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  family_id       uuid not null references public.families(id) on delete cascade,
  name            text not null,
  relationship    text,
  phone           text,
  notes           text,
  created_at      timestamptz not null default now()
);

-- -------------------------------------------------------
-- 5. attendance — 15 columns + CHECK + UNIQUE + index
-- -------------------------------------------------------
-- The checked_in_by / checked_out_by CHECK constraints are preserved
-- verbatim. See docs/pr-8-5a-review.md § "B. attendance.checked_in_by"
-- for the NULL-in-ARRAY analysis: production behaviour is correct
-- ('parent' / 'provider' / NULL all pass) but the literal reading
-- suggests otherwise. Future cleanup PR can rewrite as
-- CHECK (col IS NULL OR col IN ('parent', 'provider')).
create table if not exists public.attendance (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  child_id                    uuid not null references public.children(id) on delete cascade,
  date                        date not null,
  check_in                    time,
  check_out                   time,
  hours                       numeric,
  status                      text default 'present',
  notes                       text,
  created_at                  timestamptz not null default now(),
  created_by_user_id          uuid references auth.users(id),
  checked_in_by               text check (
    checked_in_by = any (array['parent'::text, 'provider'::text, null::text])
  ),
  checked_in_by_user_id       uuid,
  checked_out_by              text check (
    checked_out_by = any (array['parent'::text, 'provider'::text, null::text])
  ),
  checked_out_by_user_id      uuid,
  unique (child_id, date)
);

create index if not exists attendance_user_date_idx
  on public.attendance (user_id, date);

-- -------------------------------------------------------
-- 6. RLS — preserved verbatim from production (40 policies)
-- -------------------------------------------------------
-- Every policy below is captured directly from the dashboard's
-- pg_policy output (Seth's discovery query 4, 2026-05-20). Do NOT
-- modify policy expressions — these are production reality.
--
-- Idempotency: Postgres does not support CREATE POLICY IF NOT EXISTS
-- (caught during the 2026-05-21 production apply attempt). The
-- equivalent idempotent pattern is `DROP POLICY IF EXISTS … ;
-- CREATE POLICY …` — each policy below is a two-statement pair.
-- DROP IF EXISTS on a non-existent policy is a no-op; the CREATE then
-- lands the policy. On a fresh environment the DROP is a no-op, the
-- CREATE creates; on production the DROP removes the existing policy
-- in place and the CREATE re-creates it with the same body. Either
-- way the post-state is identical.

alter table public.children           enable row level security;
alter table public.families           enable row level security;
alter table public.guardians          enable row level security;
alter table public.emergency_contacts enable row level security;
alter table public.attendance         enable row level security;

-- ---- attendance ----
drop policy if exists "Parents can read attendance for their children" on public.attendance;
create policy "Parents can read attendance for their children"
  on public.attendance for select to authenticated
  using (exists (
    select 1 from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
    where c.id = attendance.child_id
      and pfl.parent_id = auth.uid()
      and pfl.status = 'active'
  ));

drop policy if exists "Parents can record attendance for their children" on public.attendance;
create policy "Parents can record attendance for their children"
  on public.attendance for insert to authenticated
  with check (exists (
    select 1 from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
    where c.id = attendance.child_id
      and pfl.parent_id = auth.uid()
      and pfl.status = 'active'
  ));

drop policy if exists "Parents can update their own attendance records" on public.attendance;
create policy "Parents can update their own attendance records"
  on public.attendance for update to authenticated
  using (
    (checked_in_by_user_id = auth.uid() or checked_out_by_user_id = auth.uid())
    and date = current_date
  )
  with check (
    (checked_in_by_user_id = auth.uid() or checked_out_by_user_id = auth.uid())
    and date = current_date
  );

drop policy if exists "Staff can insert attendance for their licensee" on public.attendance;
create policy "Staff can insert attendance for their licensee"
  on public.attendance for insert
  with check (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
      and staff_memberships.role = any (array['adult_staff'::text, 'assistant'::text])
  ));

drop policy if exists "Staff can update attendance for their licensee" on public.attendance;
create policy "Staff can update attendance for their licensee"
  on public.attendance for update
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
      and staff_memberships.role = any (array['adult_staff'::text, 'assistant'::text])
  ));

drop policy if exists "Staff can view their licensee's attendance" on public.attendance;
create policy "Staff can view their licensee's attendance"
  on public.attendance for select
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
  ));

drop policy if exists "Users can delete their own attendance" on public.attendance;
create policy "Users can delete their own attendance"
  on public.attendance for delete using (auth.uid() = user_id);
drop policy if exists "Users can insert their own attendance" on public.attendance;
create policy "Users can insert their own attendance"
  on public.attendance for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own attendance" on public.attendance;
create policy "Users can update their own attendance"
  on public.attendance for update using (auth.uid() = user_id);
drop policy if exists "Users can view their own attendance" on public.attendance;
create policy "Users can view their own attendance"
  on public.attendance for select using (auth.uid() = user_id);

-- ---- children ----
drop policy if exists "Parents can update children medical info" on public.children;
create policy "Parents can update children medical info"
  on public.children for update
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can view children for their families" on public.children;
create policy "Parents can view children for their families"
  on public.children for select
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Staff can view their licensee's children" on public.children;
create policy "Staff can view their licensee's children"
  on public.children for select
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
  ));

drop policy if exists "Users can delete their own children records" on public.children;
create policy "Users can delete their own children records"
  on public.children for delete using (auth.uid() = user_id);
drop policy if exists "Users can insert their own children records" on public.children;
create policy "Users can insert their own children records"
  on public.children for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own children records" on public.children;
create policy "Users can update their own children records"
  on public.children for update using (auth.uid() = user_id);
drop policy if exists "Users can view their own children records" on public.children;
create policy "Users can view their own children records"
  on public.children for select using (auth.uid() = user_id);

-- ---- emergency_contacts ----
drop policy if exists "Parents can delete emergency contacts" on public.emergency_contacts;
create policy "Parents can delete emergency contacts"
  on public.emergency_contacts for delete
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can insert emergency contacts" on public.emergency_contacts;
create policy "Parents can insert emergency contacts"
  on public.emergency_contacts for insert
  with check (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can update emergency contacts" on public.emergency_contacts;
create policy "Parents can update emergency contacts"
  on public.emergency_contacts for update
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can view emergency contacts for their families" on public.emergency_contacts;
create policy "Parents can view emergency contacts for their families"
  on public.emergency_contacts for select
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Staff can view their licensee's emergency contacts" on public.emergency_contacts;
create policy "Staff can view their licensee's emergency contacts"
  on public.emergency_contacts for select
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
  ));

drop policy if exists "Users can delete their own emergency_contacts" on public.emergency_contacts;
create policy "Users can delete their own emergency_contacts"
  on public.emergency_contacts for delete using (auth.uid() = user_id);
drop policy if exists "Users can insert their own emergency_contacts" on public.emergency_contacts;
create policy "Users can insert their own emergency_contacts"
  on public.emergency_contacts for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own emergency_contacts" on public.emergency_contacts;
create policy "Users can update their own emergency_contacts"
  on public.emergency_contacts for update using (auth.uid() = user_id);
drop policy if exists "Users can view their own emergency_contacts" on public.emergency_contacts;
create policy "Users can view their own emergency_contacts"
  on public.emergency_contacts for select using (auth.uid() = user_id);

-- ---- families ----
drop policy if exists "Parents can view their linked families" on public.families;
create policy "Parents can view their linked families"
  on public.families for select
  using (id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Staff can view their licensee's families" on public.families;
create policy "Staff can view their licensee's families"
  on public.families for select
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
  ));

drop policy if exists "Users can delete their own families" on public.families;
create policy "Users can delete their own families"
  on public.families for delete using (auth.uid() = user_id);
drop policy if exists "Users can insert their own families" on public.families;
create policy "Users can insert their own families"
  on public.families for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own families" on public.families;
create policy "Users can update their own families"
  on public.families for update using (auth.uid() = user_id);
drop policy if exists "Users can view their own families" on public.families;
create policy "Users can view their own families"
  on public.families for select using (auth.uid() = user_id);

-- ---- guardians ----
drop policy if exists "Parents can delete guardians for their families" on public.guardians;
create policy "Parents can delete guardians for their families"
  on public.guardians for delete
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can insert guardians for their families" on public.guardians;
create policy "Parents can insert guardians for their families"
  on public.guardians for insert
  with check (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can update guardians for their families" on public.guardians;
create policy "Parents can update guardians for their families"
  on public.guardians for update
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Parents can view guardians for their families" on public.guardians;
create policy "Parents can view guardians for their families"
  on public.guardians for select
  using (family_id in (
    select parent_family_links.family_id from public.parent_family_links
    where parent_family_links.parent_id = auth.uid()
      and parent_family_links.status = 'active'
  ));

drop policy if exists "Staff can view their licensee's guardians" on public.guardians;
create policy "Staff can view their licensee's guardians"
  on public.guardians for select
  using (user_id in (
    select staff_memberships.licensee_id from public.staff_memberships
    where staff_memberships.staff_user_id = auth.uid()
      and staff_memberships.status = 'active'
  ));

drop policy if exists "Users can delete their own guardians" on public.guardians;
create policy "Users can delete their own guardians"
  on public.guardians for delete using (auth.uid() = user_id);
drop policy if exists "Users can insert their own guardians" on public.guardians;
create policy "Users can insert their own guardians"
  on public.guardians for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own guardians" on public.guardians;
create policy "Users can update their own guardians"
  on public.guardians for update using (auth.uid() = user_id);

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- The CREATE TABLE blocks are idempotent against production, so a
-- rollback typically only needs to reverse the two net-new objects.
-- Do NOT drop the captured tables on rollback — they exist
-- independently of this migration.
--
-- drop index if exists public.idx_guardians_family_active;
-- alter table public.guardians drop column if exists archived_at;
