-- ============================================================
-- MI Little Care — Phase 8: Staff Training Tracking (schema)
--
-- Implements the operational schema for docs/staff_training_tracking_spec.md
-- (PR #8). Training requirements are verified against the Michigan
-- Administrative Code R 400.1901–1963, "Licensing Family and Group
-- Child Care Homes," administered by MiLEAP, effective 2026-04-27 —
-- transcribed in docs/reference/staff_training_tracking_spec.md.
--
-- This migration creates the OPERATIONAL tables. The verified
-- requirement catalog (reference data) is migration 013.
--
-- Model B + the caregivers table
-- ------------------------------
-- A regulated caregiver is NOT always a MILittleCare app user — most
-- drivers and volunteers never log in. Keying training records on
-- auth.users would silently fail to track half the regulated roles.
-- So records key on a new public.caregivers row (spec § 2.2 / OQ1):
--
--   - caregivers          — the licensee's regulatory roster. A row may
--                           or may not be linked to an auth user.
--   - caregivers.app_user_id — set when the caregiver is also an app
--                           user (e.g. a staff member invited through
--                           the existing staff-invitation flow). When
--                           set, that user reads their own records.
--
-- public.staff_memberships (the existing app-user invitation roster)
-- is left UNTOUCHED. The two tables are deliberately separate:
-- staff_memberships drives app access; caregivers is the regulatory
-- roster. A caregiver who is also an app user links the two via
-- caregivers.app_user_id (≈ staff_memberships.staff_user_id).
--
-- Tables created here:
--   1. caregivers
--   2. caregiver_regulatory_roles  — many-to-many person → regulatory
--      role (a person may be e.g. a staff member AND a driver)
--   3. staff_training_records      — the per-caregiver training log
--   4. health_safety_updates       — per-licensee R 400.1924(11) notices
--
-- Soft delete (archived_at) everywhere — staff/driver records must be
-- retained for employment + 2 years (R 400.1906(2)); never hard-deleted
-- (CLAUDE.md).
-- ============================================================

-- -------------------------------------------------------
-- 1. Enums
-- -------------------------------------------------------

-- The six regulatory roles R 400.1901–1963 distinguishes for training.
-- "Personnel" = licensee + staff member + assistant (R 400.1901(1)(ff));
-- "staff" = personnel + unsupervised volunteers (R 400.1901(1)(pp)).
create type public.regulatory_role as enum (
  'licensee',
  'child_care_staff_member',     -- 16+ (R 400.1920(1))
  'child_care_assistant',        -- 14–15 (R 400.1921(1))
  'unsupervised_volunteer',
  'supervised_volunteer',
  'driver'
);

-- Training-record categories (spec § 2.3).
create type public.staff_training_category as enum (
  'new_hire_training',                     -- R 400.1923 — 14 topics, 90-day deadline
  'cpr_first_aid',                         -- R 400.1920(3) / 1921(3) — expiring certification
  'professional_development',              -- R 400.1924 — per-calendar-year clock hours
  'health_safety_update_acknowledgement',  -- R 400.1924(11) — event-driven MiLEAP notice
  'miregistry_account',                    -- R 400.1922 — account + membership + employment entry
  'background_check_eligibility',          -- R 400.1919 / 1903(1)(r) — eligibility determination
  'other'                                  -- anything the provider wants on record
);

-- MiRegistry membership status values (R 400.1922(1)). The first four
-- count as "non-expired"; 'expired' does not.
create type public.miregistry_status as enum (
  'submitted',
  'materials_received',
  'awaiting_print',
  'current',
  'expired'
);

-- Background-check eligibility determination status (R 400.1919).
create type public.background_check_status as enum (
  'pending',
  'eligible',
  'ineligible'
);

-- -------------------------------------------------------
-- 2. caregivers — the regulatory roster
-- -------------------------------------------------------
create table public.caregivers (
  id            uuid primary key default gen_random_uuid(),
  licensee_id   uuid not null references auth.users(id) on delete cascade,
  full_name     text not null,
  email         text,                     -- optional; a caregiver need not be an app user
  app_user_id   uuid references auth.users(id) on delete set null,
                                           -- set when this caregiver is also a MILittleCare user
  date_of_hire  date,                      -- drives the 30-/90-day deadline checks
                                           -- (R 400.1922, R 400.1921(3), R 400.1923(1))
  archived_at   timestamptz,               -- soft delete — "archived caregivers" (spec § 9 decision 7)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A given app user is at most one caregiver per licensee. NULL
  -- app_user_id (non-app-user caregivers) is unconstrained.
  unique (licensee_id, app_user_id)
);

-- -------------------------------------------------------
-- 3. caregiver_regulatory_roles — many-to-many person → role
-- -------------------------------------------------------
-- A person may hold several regulatory roles (a staff member who also
-- drives). Requirements roll up strictest-wins per category (spec § 6.3).
-- Roles are person-scoped, not per-home (spec OQ3) — training follows
-- the person (R 400.1922, R 400.1924).
create table public.caregiver_regulatory_roles (
  id                             uuid primary key default gen_random_uuid(),
  caregiver_id                   uuid not null references public.caregivers(id) on delete cascade,
  regulatory_role                public.regulatory_role not null,
  -- Driver-only attributes. They drive the conditional driver
  -- requirements: ratio-counted → R 400.1951(10) (new hire training +
  -- professional development); unsupervised access OR ratio-counted →
  -- R 400.1951(4) (background-check eligibility). The CHECK forces them
  -- non-null for a driver row and null for every other role.
  driver_ratio_counted           boolean,
  driver_has_unsupervised_access boolean,
  created_at                     timestamptz not null default now(),
  unique (caregiver_id, regulatory_role),
  constraint caregiver_regulatory_roles_driver_attrs check (
    (regulatory_role = 'driver'
       and driver_ratio_counted is not null
       and driver_has_unsupervised_access is not null)
    or
    (regulatory_role <> 'driver'
       and driver_ratio_counted is null
       and driver_has_unsupervised_access is null)
  )
);

-- -------------------------------------------------------
-- 4. staff_training_records — the per-caregiver training log
-- -------------------------------------------------------
create table public.staff_training_records (
  id                      uuid primary key default gen_random_uuid(),
  caregiver_id            uuid not null references public.caregivers(id) on delete cascade,
  category                public.staff_training_category not null,
  title                   text not null,
  completed_on            date not null,            -- completion / determination / as-of date
  expires_on              date,                     -- CPR & first aid card expiry (R 400.1924(8));
                                                    --   null = does not expire
  hours                   numeric(5,2),             -- professional-development clock hours (R 400.1924)
  issuer                  text,                     -- e.g. "American Red Cross"
  reference_code          text,                     -- cert id / MiRegistry event id /
                                                    --   health_safety_updates.id (the § 7.1 / Q2 seam)
  miregistry_status       public.miregistry_status,        -- R 400.1922; set ONLY for miregistry_account
  background_check_status public.background_check_status,  -- R 400.1919; set ONLY for background_check_eligibility
  notes                   text,
  entered_by              uuid references auth.users(id) on delete set null,
                                                    -- who recorded this — staff self vs licensee
                                                    --   (spec § 9 decisions 4 & 5)
  archived_at             timestamptz,              -- soft delete; retain per R 400.1906(2)
  archived_by             uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint staff_training_records_dates_ordered
    check (expires_on is null or expires_on >= completed_on),
  -- The two status columns are valid only for their own category, and
  -- exactly the matching one is populated there (spec § 2.3, structural
  -- change: enums + CHECK, not free text).
  constraint staff_training_records_status_matches_category check (
    case category
      when 'miregistry_account'
        then miregistry_status is not null and background_check_status is null
      when 'background_check_eligibility'
        then background_check_status is not null and miregistry_status is null
      else miregistry_status is null and background_check_status is null
    end
  )
);

-- -------------------------------------------------------
-- 5. health_safety_updates — per-licensee R 400.1924(11) notices
-- -------------------------------------------------------
-- When MiLEAP publishes a health & safety update notice, applicable
-- personnel and unsupervised volunteers must read/complete it within
-- the notice's stated timeframe (R 400.1924(11)). The notice is entered
-- per licensee (no statewide feed confirmed — spec OQ2). A per-person
-- acknowledgement is a staff_training_records row of category
-- 'health_safety_update_acknowledgement' with reference_code = this id.
create table public.health_safety_updates (
  id             uuid primary key default gen_random_uuid(),
  licensee_id    uuid not null references auth.users(id) on delete cascade,
  title          text not null,
  miregistry_url text,
  published_on   date,                     -- date MiLEAP published the notice (R 400.1924(11))
  acknowledge_by date,                      -- deadline stated on the notice (R 400.1924(11))
  archived_at    timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- -------------------------------------------------------
-- 6. Indexes
-- -------------------------------------------------------
create index caregivers_licensee_idx
  on public.caregivers (licensee_id) where archived_at is null;
create index caregivers_app_user_idx
  on public.caregivers (app_user_id) where app_user_id is not null;
create index caregiver_regulatory_roles_caregiver_idx
  on public.caregiver_regulatory_roles (caregiver_id);
create index staff_training_records_caregiver_idx
  on public.staff_training_records (caregiver_id, completed_on desc) where archived_at is null;
create index staff_training_records_caregiver_category_idx
  on public.staff_training_records (caregiver_id, category, expires_on) where archived_at is null;
create index health_safety_updates_licensee_idx
  on public.health_safety_updates (licensee_id) where archived_at is null;

-- -------------------------------------------------------
-- 7. updated_at triggers (set_updated_at() from migration 001)
-- -------------------------------------------------------
create trigger caregivers_set_updated_at
  before update on public.caregivers
  for each row execute function public.set_updated_at();
create trigger staff_training_records_set_updated_at
  before update on public.staff_training_records
  for each row execute function public.set_updated_at();
create trigger health_safety_updates_set_updated_at
  before update on public.health_safety_updates
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 8. RLS — provider-scoped (spec § 2.3, § 9 decisions 3 & 4)
-- -------------------------------------------------------
-- Visibility runs through caregivers: the row's licensee
-- (caregivers.licensee_id) and the linked app user
-- (caregivers.app_user_id). Soft delete only — no DELETE policy on the
-- record tables.

alter table public.caregivers enable row level security;

create policy "Licensee or the linked app user can view a caregiver"
  on public.caregivers for select to authenticated
  using (licensee_id = auth.uid() or app_user_id = auth.uid());

create policy "Licensee can add caregivers to their own roster"
  on public.caregivers for insert to authenticated
  with check (licensee_id = auth.uid());

create policy "Licensee can update their own roster"
  on public.caregivers for update to authenticated
  using (licensee_id = auth.uid())
  with check (licensee_id = auth.uid());

alter table public.caregiver_regulatory_roles enable row level security;

create policy "Licensee or linked app user can view regulatory roles"
  on public.caregiver_regulatory_roles for select to authenticated
  using (exists (
    select 1 from public.caregivers c
    where c.id = caregiver_regulatory_roles.caregiver_id
      and (c.licensee_id = auth.uid() or c.app_user_id = auth.uid())
  ));

create policy "Licensee can assign regulatory roles on their roster"
  on public.caregiver_regulatory_roles for insert to authenticated
  with check (exists (
    select 1 from public.caregivers c
    where c.id = caregiver_regulatory_roles.caregiver_id and c.licensee_id = auth.uid()
  ));

create policy "Licensee can change regulatory roles on their roster"
  on public.caregiver_regulatory_roles for update to authenticated
  using (exists (
    select 1 from public.caregivers c
    where c.id = caregiver_regulatory_roles.caregiver_id and c.licensee_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.caregivers c
    where c.id = caregiver_regulatory_roles.caregiver_id and c.licensee_id = auth.uid()
  ));

create policy "Licensee can remove regulatory roles on their roster"
  on public.caregiver_regulatory_roles for delete to authenticated
  using (exists (
    select 1 from public.caregivers c
    where c.id = caregiver_regulatory_roles.caregiver_id and c.licensee_id = auth.uid()
  ));

alter table public.staff_training_records enable row level security;

create policy "Licensee or the caregiver themselves can view records"
  on public.staff_training_records for select to authenticated
  using (exists (
    select 1 from public.caregivers c
    where c.id = staff_training_records.caregiver_id
      and (c.licensee_id = auth.uid() or c.app_user_id = auth.uid())
  ));

-- Both the licensee and a caregiver who is an app user may add records
-- (spec § 9 decisions 3 & 4). entered_by must be the calling user.
create policy "Licensee or the caregiver themselves can add records"
  on public.staff_training_records for insert to authenticated
  with check (
    entered_by = auth.uid()
    and exists (
      select 1 from public.caregivers c
      where c.id = staff_training_records.caregiver_id
        and (c.licensee_id = auth.uid() or c.app_user_id = auth.uid())
    )
  );

create policy "Licensee or the caregiver themselves can update records"
  on public.staff_training_records for update to authenticated
  using (exists (
    select 1 from public.caregivers c
    where c.id = staff_training_records.caregiver_id
      and (c.licensee_id = auth.uid() or c.app_user_id = auth.uid())
  ))
  with check (exists (
    select 1 from public.caregivers c
    where c.id = staff_training_records.caregiver_id
      and (c.licensee_id = auth.uid() or c.app_user_id = auth.uid())
  ));

alter table public.health_safety_updates enable row level security;

-- The licensee manages notices; their caregivers who are app users may
-- read them (so they can see what they must acknowledge).
create policy "Licensee or their app-user caregivers can view notices"
  on public.health_safety_updates for select to authenticated
  using (
    licensee_id = auth.uid()
    or exists (
      select 1 from public.caregivers c
      where c.licensee_id = health_safety_updates.licensee_id
        and c.app_user_id = auth.uid()
    )
  );

create policy "Licensee can add health & safety update notices"
  on public.health_safety_updates for insert to authenticated
  with check (licensee_id = auth.uid());

create policy "Licensee can update their own notices"
  on public.health_safety_updates for update to authenticated
  using (licensee_id = auth.uid())
  with check (licensee_id = auth.uid());

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- -- Reverse dependency order. Dropping a table drops its policies,
-- -- indexes, and triggers with it.
-- drop table if exists public.staff_training_records;
-- drop table if exists public.caregiver_regulatory_roles;
-- drop table if exists public.health_safety_updates;
-- drop table if exists public.caregivers;
-- drop type if exists public.background_check_status;
-- drop type if exists public.miregistry_status;
-- drop type if exists public.staff_training_category;
-- drop type if exists public.regulatory_role;
