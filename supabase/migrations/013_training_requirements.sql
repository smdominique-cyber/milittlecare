-- ============================================================
-- MI Little Care — Phase 8: Staff Training Tracking (requirement catalog)
--
-- The verified requirement catalog for docs/staff_training_tracking_spec.md
-- (PR #8) — reference data, structurally like cdc_pay_period_catalog
-- (migration 010). One row per (training category, regulatory role)
-- requirement, each transcribed from Michigan Administrative Code
-- R 400.1901–1963 (MiLEAP, effective 2026-04-27) and carrying its
-- citation. Built from the § 6.2 verified matrix of the spec.
--
-- Depends on migration 012 (the staff_training_category and
-- regulatory_role enums).
--
-- The catalog is statewide reference data: readable by every
-- authenticated user, written only by migration (this file + future
-- seed-only migrations if MiLEAP amends the rules). Modelled on
-- cdc_pay_period_catalog — no per-user rows, SELECT-only RLS.
--
-- 28 seed rows are expected after this migration. The seed is split
-- into one INSERT per category (≤ 6 rows each) to stay clear of the
-- web SQL Editor long-statement bug noted in docs/runbook.md.
-- ============================================================

-- -------------------------------------------------------
-- 1. Enums
-- -------------------------------------------------------

-- When an obligation first falls due. Renewal of an expiring
-- certification is driven separately by staff_training_records.expires_on
-- (R 400.1924(8)), independent of this field.
create type public.requirement_cadence as enum (
  'before_care',        -- before caring for / unsupervised contact with children
  'within_30_days',     -- within 30 calendar days of employment (R 400.1922)
  'within_90_days',     -- within 90 days of hire / being present (R 400.1921(3), R 400.1923(1))
  'per_calendar_year',  -- a clock-hour total each calendar year (R 400.1924)
  'per_card_expiry',    -- maintained per the certification card's own expiry
  'per_notice',         -- per a MiLEAP-published update notice (R 400.1924(11))
  'conditional'         -- applies only when `condition` below is met
);

-- The condition under which a `conditional`-cadence requirement applies.
create type public.requirement_condition as enum (
  'ratio_counted',                          -- driver counted in child-to-staff ratios (R 400.1951(10))
  'unsupervised_access_or_ratio_counted'    -- driver with unsupervised access OR ratio-counted (R 400.1951(4))
);

-- -------------------------------------------------------
-- 2. training_requirements catalog table
-- -------------------------------------------------------
create table public.training_requirements (
  id              uuid primary key default gen_random_uuid(),
  category        public.staff_training_category not null,
  regulatory_role public.regulatory_role not null,
  is_required     boolean not null default true,
  cadence         public.requirement_cadence not null,
  required_hours  numeric(5,2),            -- professional-development clock hours; null where not hour-denominated
  condition       public.requirement_condition,  -- non-null iff cadence = 'conditional'
  citation        text not null,           -- the R 400.19xx rule text this row is transcribed from
  created_at      timestamptz not null default now(),
  unique (category, regulatory_role),
  constraint training_requirements_condition_matches_cadence check (
    (cadence = 'conditional' and condition is not null)
    or (cadence <> 'conditional' and condition is null)
  )
);

-- -------------------------------------------------------
-- 3. Index
-- -------------------------------------------------------
-- The compliance engine looks requirements up per regulatory role.
-- The catalog is tiny (28 rows); this index is about intent.
create index training_requirements_role_idx
  on public.training_requirements (regulatory_role, category);

-- -------------------------------------------------------
-- 4. RLS — select only (mirrors cdc_pay_period_catalog, migration 010)
-- -------------------------------------------------------
alter table public.training_requirements enable row level security;

create policy "Authenticated users can view the training requirements catalog"
  on public.training_requirements for select
  to authenticated
  using (true);

-- -------------------------------------------------------
-- 5. Seed — one row per ✔ cell of spec § 6.2, by category
-- -------------------------------------------------------

-- CPR / pediatric first aid (R 400.1920(3), R 400.1921(3), R 400.1902(1)(d)).
-- Renewal is driven by each record's expires_on (R 400.1924(8)).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('cpr_first_aid', 'licensee',                'before_care',    null, null, 'R 400.1902(1)(d)'),
  ('cpr_first_aid', 'child_care_staff_member', 'before_care',    null, null, 'R 400.1920(3)'),
  ('cpr_first_aid', 'child_care_assistant',    'within_90_days', null, null, 'R 400.1921(3)');

-- New hire training — 14 mandated topics (R 400.1923). "All staff" =
-- personnel + unsupervised volunteers; a ratio-counted driver via
-- R 400.1951(10).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('new_hire_training', 'licensee',                'within_90_days', null, null,            'R 400.1923(1)'),
  ('new_hire_training', 'child_care_staff_member', 'within_90_days', null, null,            'R 400.1923(1)'),
  ('new_hire_training', 'child_care_assistant',    'within_90_days', null, null,            'R 400.1923(1)'),
  ('new_hire_training', 'unsupervised_volunteer',  'within_90_days', null, null,            'R 400.1923(1)'),
  ('new_hire_training', 'driver',                  'conditional',    null, 'ratio_counted', 'R 400.1951(10)');

-- Professional development — clock hours per calendar year (R 400.1924).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('professional_development', 'licensee',                'per_calendar_year', 10, null, 'R 400.1924(1)'),
  ('professional_development', 'child_care_staff_member', 'per_calendar_year',  5, null, 'R 400.1924(2)'),
  ('professional_development', 'child_care_assistant',    'per_calendar_year',  5, null, 'R 400.1924(2)'),
  ('professional_development', 'unsupervised_volunteer',  'per_calendar_year',  1, null, 'R 400.1924(3)'),
  ('professional_development', 'driver',                  'per_calendar_year',  1, null, 'R 400.1924(4)');

-- Health & safety update acknowledgement — event-driven (R 400.1924(11));
-- a ratio-counted driver via R 400.1951(10).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('health_safety_update_acknowledgement', 'licensee',                'per_notice',  null, null,            'R 400.1924(11)'),
  ('health_safety_update_acknowledgement', 'child_care_staff_member', 'per_notice',  null, null,            'R 400.1924(11)'),
  ('health_safety_update_acknowledgement', 'child_care_assistant',    'per_notice',  null, null,            'R 400.1924(11)'),
  ('health_safety_update_acknowledgement', 'unsupervised_volunteer',  'per_notice',  null, null,            'R 400.1924(11)'),
  ('health_safety_update_acknowledgement', 'driver',                  'conditional', null, 'ratio_counted', 'R 400.1951(10)');

-- MiRegistry account + non-expired membership + verified employment
-- entry — within 30 calendar days of employment (R 400.1922). "All
-- staff" only; a driver is not "staff" (R 400.1901(1)(pp)).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('miregistry_account', 'licensee',                'within_30_days', null, null, 'R 400.1922'),
  ('miregistry_account', 'child_care_staff_member', 'within_30_days', null, null, 'R 400.1922'),
  ('miregistry_account', 'child_care_assistant',    'within_30_days', null, null, 'R 400.1922'),
  ('miregistry_account', 'unsupervised_volunteer',  'within_30_days', null, null, 'R 400.1922');

-- Background-check eligibility — before unsupervised contact
-- (R 400.1919); assistants & supervised volunteers via sex-offender
-- registry clearance (R 400.1903(1)(r)); a driver conditionally
-- (R 400.1951(4)).
insert into public.training_requirements
  (category, regulatory_role, cadence, required_hours, condition, citation)
values
  ('background_check_eligibility', 'licensee',                'before_care', null, null,                                   'R 400.1919(1)(a)'),
  ('background_check_eligibility', 'child_care_staff_member', 'before_care', null, null,                                   'R 400.1919(1)(c)'),
  ('background_check_eligibility', 'child_care_assistant',    'before_care', null, null,                                   'R 400.1903(1)(r)'),
  ('background_check_eligibility', 'unsupervised_volunteer',  'before_care', null, null,                                   'R 400.1919(1)(d)'),
  ('background_check_eligibility', 'supervised_volunteer',    'before_care', null, null,                                   'R 400.1903(1)(r)'),
  ('background_check_eligibility', 'driver',                  'conditional', null, 'unsupervised_access_or_ratio_counted', 'R 400.1951(4)');

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- drop table if exists public.training_requirements;
-- drop type if exists public.requirement_condition;
-- drop type if exists public.requirement_cadence;
