-- ============================================================
-- MI Little Care — Phase 6: CDC Pay Period Catalog
--
-- Implements the data model from docs/cdc_pay_periods_spec.md
-- (PR #6 spec, approved 2026-05-15). One change:
--
-- 1. New table public.cdc_pay_period_catalog — a STATEWIDE
--    reference table holding the MDHHS-published CDC Payment
--    Schedule. There is no user_id: every CDC provider in
--    Michigan bills against the same 26 pay periods per year on
--    the same dates. The schedule is a statewide constant, not
--    provider data — see spec § 1.1 and § 2.3.
--
-- Modelled on public.tri_share_hubs (migration 003): shared
-- reference data, readable by every authenticated user, written
-- only by migration / server-side. No INSERT/UPDATE/DELETE
-- policies are created — the table is seeded here and maintained
-- via future seed-only migrations (one per year; see
-- docs/tech_debt.md § "Annual CDC pay period catalog update").
--
-- This migration also SEEDS all 52 rows inline — the 2025
-- schedule (period numbers 501–526) and the 2026 schedule
-- (601–626) — transcribed from docs/cdc_pay_periods_spec.md
-- Appendix A, itself transcribed from "Scholarship Handbook for
-- License Exempt Provider.pdf" (rev 2026-04-01), pages 29–30.
--
-- Annotations from the handbook schedule:
--   '*'  on a reporting deadline  -> deadline_is_4pm = true
--          (the deadline is 4:00 PM that day, not midnight)
--   '**' on a check / EFT date    -> payment_may_be_delayed = true
--          (payment may be delayed by a holiday)
--
-- Non-changes:
--   - public.billing_periods is intentionally left untouched.
--     It stays in the schema, empty, reserved for PR #7 / V2
--     per-user lifecycle state (spec § 2.3, § 8). V1 is
--     read-only and writes nothing.
--
-- Contiguity: within and across both schedule years the 52
-- periods are contiguous — each period's start_date is exactly
-- the previous period's end_date + 1 day, with no gaps or
-- overlaps (spec § 7.5). This is asserted by a Vitest test over
-- the seed data in src/lib/cdcPayPeriods.test.js.
-- ============================================================

-- -------------------------------------------------------
-- 1. cdc_pay_period_catalog table
-- -------------------------------------------------------
create table if not exists public.cdc_pay_period_catalog (
  id                      uuid default gen_random_uuid() primary key,
  schedule_year           integer not null,   -- 2025, 2026, …
  period_number           integer not null,   -- 501–526, 601–626, …
  start_date              date not null,
  end_date                date not null,
  reporting_deadline      date not null,
  deadline_is_4pm         boolean not null default false,  -- handbook '*'
  expected_payment_date   date not null,
  payment_may_be_delayed  boolean not null default false,  -- handbook '**'
  created_at              timestamptz not null default now(),
  constraint cdc_pay_period_catalog_dates_ordered
    check (end_date >= start_date),
  unique (schedule_year, period_number)
);

-- -------------------------------------------------------
-- 2. Index
-- -------------------------------------------------------
-- The unique (schedule_year, period_number) constraint above
-- already provides a btree index. This second index serves the
-- page's two access patterns: the year-table query (filter by
-- schedule_year, order by start_date) and the current/next-period
-- scan (order by start_date). The catalog is tiny (52 rows), so
-- this is about intent and PR #7 join paths, not present-day
-- performance.
create index if not exists cdc_pay_period_catalog_year_start_idx
  on public.cdc_pay_period_catalog (schedule_year, start_date);

-- -------------------------------------------------------
-- 3. RLS — select only
-- -------------------------------------------------------
-- Mirrors tri_share_hubs (migration 003). No insert/update/delete
-- policies: the catalog is seeded by this migration and maintained
-- by future seed-only migrations, never written from the app.
alter table public.cdc_pay_period_catalog enable row level security;

create policy "Authenticated users can view the CDC pay period catalog"
  on public.cdc_pay_period_catalog for select
  to authenticated
  using (true);

-- -------------------------------------------------------
-- 4. Seed — 2025 schedule (schedule_year = 2025, periods 501–526)
-- -------------------------------------------------------
insert into public.cdc_pay_period_catalog
  (schedule_year, period_number, start_date, end_date,
   reporting_deadline, deadline_is_4pm,
   expected_payment_date, payment_may_be_delayed)
values
  (2025, 501, '2024-12-29', '2025-01-11', '2025-01-16', false, '2025-01-24', true),
  (2025, 502, '2025-01-12', '2025-01-25', '2025-01-30', false, '2025-02-06', false),
  (2025, 503, '2025-01-26', '2025-02-08', '2025-02-13', false, '2025-02-21', true),
  (2025, 504, '2025-02-09', '2025-02-22', '2025-02-27', false, '2025-03-06', false),
  (2025, 505, '2025-02-23', '2025-03-08', '2025-03-13', false, '2025-03-20', false),
  (2025, 506, '2025-03-09', '2025-03-22', '2025-03-27', false, '2025-04-03', false),
  (2025, 507, '2025-03-23', '2025-04-05', '2025-04-10', false, '2025-04-17', false),
  (2025, 508, '2025-04-06', '2025-04-19', '2025-04-24', false, '2025-05-01', false),
  (2025, 509, '2025-04-20', '2025-05-03', '2025-05-08', false, '2025-05-15', false),
  (2025, 510, '2025-05-04', '2025-05-17', '2025-05-22', false, '2025-05-30', true),
  (2025, 511, '2025-05-18', '2025-05-31', '2025-06-05', false, '2025-06-12', false),
  (2025, 512, '2025-06-01', '2025-06-14', '2025-06-19', false, '2025-06-26', false),
  (2025, 513, '2025-06-15', '2025-06-28', '2025-07-02', true,  '2025-07-10', false),
  (2025, 514, '2025-06-29', '2025-07-12', '2025-07-17', false, '2025-07-24', false),
  (2025, 515, '2025-07-13', '2025-07-26', '2025-07-31', false, '2025-08-07', false),
  (2025, 516, '2025-07-27', '2025-08-09', '2025-08-14', false, '2025-08-21', false),
  (2025, 517, '2025-08-10', '2025-08-23', '2025-08-28', false, '2025-09-05', true),
  (2025, 518, '2025-08-24', '2025-09-06', '2025-09-11', false, '2025-09-18', false),
  (2025, 519, '2025-09-07', '2025-09-20', '2025-09-25', false, '2025-10-02', false),
  (2025, 520, '2025-09-21', '2025-10-04', '2025-10-09', false, '2025-10-16', false),
  (2025, 521, '2025-10-05', '2025-10-18', '2025-10-23', false, '2025-10-30', false),
  (2025, 522, '2025-10-19', '2025-11-01', '2025-11-06', false, '2025-11-14', true),
  (2025, 523, '2025-11-02', '2025-11-15', '2025-11-19', true,  '2025-11-26', false),
  (2025, 524, '2025-11-16', '2025-11-29', '2025-12-04', false, '2025-12-11', false),
  (2025, 525, '2025-11-30', '2025-12-13', '2025-12-17', true,  '2025-12-26', true),
  (2025, 526, '2025-12-14', '2025-12-27', '2026-01-01', false, '2026-01-08', false);

-- -------------------------------------------------------
-- 5. Seed — 2026 schedule (schedule_year = 2026, periods 601–626)
-- -------------------------------------------------------
insert into public.cdc_pay_period_catalog
  (schedule_year, period_number, start_date, end_date,
   reporting_deadline, deadline_is_4pm,
   expected_payment_date, payment_may_be_delayed)
values
  (2026, 601, '2025-12-28', '2026-01-10', '2026-01-15', false, '2026-01-23', true),
  (2026, 602, '2026-01-11', '2026-01-24', '2026-01-29', false, '2026-02-05', false),
  (2026, 603, '2026-01-25', '2026-02-07', '2026-02-12', false, '2026-02-20', true),
  (2026, 604, '2026-02-08', '2026-02-21', '2026-02-26', false, '2026-03-05', false),
  (2026, 605, '2026-02-22', '2026-03-07', '2026-03-12', false, '2026-03-19', false),
  (2026, 606, '2026-03-08', '2026-03-21', '2026-03-26', false, '2026-04-02', false),
  (2026, 607, '2026-03-22', '2026-04-04', '2026-04-09', false, '2026-04-16', false),
  (2026, 608, '2026-04-05', '2026-04-18', '2026-04-23', false, '2026-04-30', false),
  (2026, 609, '2026-04-19', '2026-05-02', '2026-05-07', false, '2026-05-14', false),
  (2026, 610, '2026-05-03', '2026-05-16', '2026-05-21', false, '2026-05-29', true),
  (2026, 611, '2026-05-17', '2026-05-30', '2026-06-04', false, '2026-06-11', false),
  (2026, 612, '2026-05-31', '2026-06-13', '2026-06-17', true,  '2026-06-25', false),
  (2026, 613, '2026-06-14', '2026-06-27', '2026-07-01', true,  '2026-07-09', false),
  (2026, 614, '2026-06-28', '2026-07-11', '2026-07-16', false, '2026-07-23', false),
  (2026, 615, '2026-07-12', '2026-07-25', '2026-07-30', false, '2026-08-06', false),
  (2026, 616, '2026-07-26', '2026-08-08', '2026-08-13', false, '2026-08-20', false),
  (2026, 617, '2026-08-09', '2026-08-22', '2026-08-27', false, '2026-09-03', false),
  (2026, 618, '2026-08-23', '2026-09-05', '2026-09-10', false, '2026-09-17', false),
  (2026, 619, '2026-09-06', '2026-09-19', '2026-09-24', false, '2026-10-01', false),
  (2026, 620, '2026-09-20', '2026-10-03', '2026-10-08', false, '2026-10-16', true),
  (2026, 621, '2026-10-04', '2026-10-17', '2026-10-22', false, '2026-10-29', false),
  (2026, 622, '2026-10-18', '2026-10-31', '2026-11-05', false, '2026-11-13', true),
  (2026, 623, '2026-11-01', '2026-11-14', '2026-11-19', false, '2026-12-01', true),
  (2026, 624, '2026-11-15', '2026-11-28', '2026-12-03', false, '2026-12-10', false),
  (2026, 625, '2026-11-29', '2026-12-12', '2026-12-17', false, '2026-12-28', true),
  (2026, 626, '2026-12-13', '2026-12-26', '2026-12-29', false, '2027-01-07', false);

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- -- Reverse dependency order: policy, then index, then table.
-- drop policy if exists "Authenticated users can view the CDC pay period catalog"
--   on public.cdc_pay_period_catalog;
-- drop index if exists public.cdc_pay_period_catalog_year_start_idx;
-- drop table if exists public.cdc_pay_period_catalog;
-- -- Dropping the table removes all 52 seeded rows with it; no
-- -- separate DELETE is needed (the catalog holds only seed data).
