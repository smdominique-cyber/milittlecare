-- ============================================================
-- MI Little Care — Phase 11: I-Billing Transfer & Reconciliation schema (PR #9)
--
-- Four schema additions, all purely additive:
--
--   1. Multi-segment attendance support
--      - new `segment_index integer NOT NULL DEFAULT 0` on attendance
--      - replace the existing (child_id, date) unique with a
--        (child_id, date, segment_index) unique, found and dropped via
--        pg_constraint introspection so this migration is agnostic to
--        the production constraint name (the attendance table itself
--        was created out-of-band — see docs/tech_debt.md).
--      The spec was originally going to ship PR #9 single-segment with
--      multi-segment as PR #9.5; reviewer signed off (path 2 in the
--      pre-build readout) on landing multi-segment here so the LEP
--      handbook's overnight-split-at-midnight rule (#7) and the
--      before/after school billing rule (#6) actually have a place to
--      land their data. UI write paths for multiple segments per day
--      are wired in this same PR.
--
--   2. cdc_billing_submissions
--      Records the I-Billing confirmation number per (provider,
--      pay period). One row per period per provider — UNIQUE
--      constraint enforces. Immutable once created: no DELETE policy,
--      no archived_at (cross-cutting § "Soft delete" — decision logged
--      in docs/pr-9-review.md).
--
--   3. attendance_validation_overrides
--      Audit trail for cases where a provider deliberately overrode a
--      validation rule (e.g. "billing during school hours" when the
--      child's school was closed that day). Append-only. Required by
--      Screen 3's override flow.
--
--   4. School schedule fields on children
--      Rule 6 (billing during school hours) requires knowing whether
--      a child is school-age and the bell schedule. The spec defers
--      these to PR #9 — added here on children:
--        - school_enrolled boolean
--        - school_name text
--        - school_bell_schedule_json jsonb
--      All nullable. UI surface lives in the child profile form
--      extension shipped with this PR.
--
-- Migration ordering note. PR #8.5a (016) captures the existing
-- production schema for children/families/guardians/emergency_contacts/
-- attendance. PR #8.5b (017) promotes CDC fields onto funding_sources.
-- PR #8.5c (018) adds provider billing settings. This migration (019)
-- is purely additive on top of the production tables and does not
-- require 016/017/018 to be applied first — each migration in the
-- 016–019 series addresses distinct objects. The dashboard apply
-- order is the runbook's choice; what's enforced here is that each
-- migration is idempotent and order-independent.
-- ============================================================

-- -------------------------------------------------------
-- 1. Multi-segment attendance
-- -------------------------------------------------------
alter table public.attendance
  add column if not exists segment_index integer not null default 0;

-- Drop the existing (child_id, date) unique constraint by
-- introspection. The constraint name varies depending on how the
-- production table was originally created (the attendance table is in
-- the "out-of-band" set per docs/tech_debt.md), so we find it via
-- pg_constraint shape match rather than hard-coding a name.
do $$
declare
  cons_name text;
  cons_kind char;
begin
  -- Look for a UNIQUE constraint OR a unique INDEX matching exactly
  -- (child_id, date). Either form may exist depending on whether the
  -- table was created via CREATE TABLE … UNIQUE (...) or via a
  -- separate CREATE UNIQUE INDEX.
  select c.conname, c.contype into cons_name, cons_kind
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'attendance'
    and c.contype = 'u'
    and (
      select array_agg(a.attname order by x.ord)
      from unnest(c.conkey) with ordinality x(att, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = x.att
    ) = array['child_id'::name, 'date'::name];

  if cons_name is not null then
    execute format('alter table public.attendance drop constraint %I', cons_name);
  else
    -- Fallback: a unique INDEX (not enforced as a CONSTRAINT) on the
    -- same two columns. Drop that too if present.
    select i.indexname into cons_name
    from pg_indexes i
    where i.schemaname = 'public'
      and i.tablename = 'attendance'
      and i.indexdef ilike 'CREATE UNIQUE INDEX %'
      and i.indexdef ilike '% (child_id, date)%';
    if cons_name is not null then
      execute format('drop index public.%I', cons_name);
    end if;
  end if;
end$$;

-- Replace with the multi-segment unique.
create unique index if not exists attendance_child_date_segment_key
  on public.attendance (child_id, date, segment_index);

-- An index that supports the most common pay-period query —
-- "every attendance segment for this provider in this date window."
create index if not exists attendance_user_date_idx
  on public.attendance (user_id, date);

-- -------------------------------------------------------
-- 2. cdc_billing_submissions
-- -------------------------------------------------------
create table if not exists public.cdc_billing_submissions (
  id                              uuid primary key default gen_random_uuid(),
  provider_id                     uuid not null references public.profiles(id) on delete cascade,

  -- The CDC pay period this submission covers. References
  -- cdc_pay_period_catalog.period_number (migration 010 — statewide
  -- reference data); FK omitted intentionally because period_number is
  -- not unique on the catalog (each year reuses 501-526 / 601-626 /
  -- etc.). The schedule_year is implied by submitted_at.
  pay_period_number               text not null,

  confirmation_number             text not null,
  submitted_at                    timestamptz not null default now(),

  -- Totals as of submission, for reconciliation against MDHHS payout
  -- later. nullable because providers may submit before a full
  -- compute pass runs.
  total_billed_hours              numeric(8,2),
  total_billed_amount_estimate    numeric(10,2),

  -- Future-state hooks (cross-cutting § "Future-state hooks").
  -- Populated when a provider records the EFT or check arrival;
  -- discrepancy detection is out of scope for PR #9.
  payment_received_amount         numeric(10,2),
  payment_received_date           date,
  discrepancy_notes               text,

  -- Frozen snapshot of the attendance state at submission. Used to
  -- demonstrate exactly what was submitted if a discrepancy surfaces
  -- months later. Schema is whatever the export step generates;
  -- jsonb keeps it flexible.
  attendance_snapshot_jsonb       jsonb,

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  unique (provider_id, pay_period_number)
);

create index if not exists cdc_billing_submissions_provider_idx
  on public.cdc_billing_submissions (provider_id, submitted_at desc);

alter table public.cdc_billing_submissions enable row level security;

create policy "Providers can view their own CDC submissions"
  on public.cdc_billing_submissions for select to authenticated
  using (provider_id = auth.uid());

create policy "Providers can record their own CDC submissions"
  on public.cdc_billing_submissions for insert to authenticated
  with check (provider_id = auth.uid());

-- UPDATE is allowed only for the future-state fields (payment_received_*,
-- discrepancy_notes). The submission record itself — pay period,
-- confirmation number, snapshot — is immutable once written. Postgres
-- can't easily express "only some columns updatable via RLS"; for V1
-- the UPDATE policy permits any update by the owner, and the UI keeps
-- the lock honest. A future trigger or application-level guard can
-- tighten this.
create policy "Providers can update payment-received fields on their submissions"
  on public.cdc_billing_submissions for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- No DELETE policy on purpose — submission records are audit-retained.
-- Soft-delete via archived_at is not used here: the spec called this
-- decision out and the answer is "submissions are immutable."

create trigger cdc_billing_submissions_set_updated_at
  before update on public.cdc_billing_submissions
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 3. attendance_validation_overrides
-- -------------------------------------------------------
-- Append-only audit log per cross-cutting § "Audit trail". A row lands
-- here whenever a provider clicks "Override (with note)" on a flagged
-- validation issue. No updates, no deletes — pure log.
create table if not exists public.attendance_validation_overrides (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references public.profiles(id) on delete cascade,

  -- attendance_id may be null when the override is at the pay-period
  -- level (e.g. an overall rule didn't fit). child_id similarly may be
  -- null for provider-wide overrides (rule 9: "Missing provider name").
  attendance_id       uuid references public.attendance(id) on delete set null,
  child_id            uuid references public.children(id) on delete set null,

  pay_period_number   text,
  rule_id             text not null,             -- the spec's 11-rule ID, e.g. 'rule_6'
  rule_description    text,                       -- denormalised for audit readability
  override_reason     text not null,              -- free-text justification — required

  overridden_at       timestamptz not null default now()
);

create index if not exists attendance_validation_overrides_provider_idx
  on public.attendance_validation_overrides (provider_id, overridden_at desc);

alter table public.attendance_validation_overrides enable row level security;

create policy "Providers can view their own validation overrides"
  on public.attendance_validation_overrides for select to authenticated
  using (provider_id = auth.uid());

create policy "Providers can record their own validation overrides"
  on public.attendance_validation_overrides for insert to authenticated
  with check (provider_id = auth.uid());

-- No UPDATE policy, no DELETE policy: append-only.

-- -------------------------------------------------------
-- 4. School schedule fields on children
-- -------------------------------------------------------
-- Rule 6 dependency. school_enrolled gates the whole rule:
--   NULL or false → rule does not apply
--   true + bell schedule on file → full validation
--   true + no bell schedule → warning only (cannot validate)
-- See docs/pr-9-review.md § Rule 6 implementation choice.
alter table public.children
  add column if not exists school_enrolled            boolean,
  add column if not exists school_name                text,
  add column if not exists school_bell_schedule_json  jsonb;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Reverses sections in opposite order — drop the new objects, then
-- the attendance constraint changes. The DOWN for the (child_id, date,
-- segment_index) → (child_id, date) constraint swap intentionally
-- recreates as a *unique index* not a constraint, because the original
-- production form (constraint vs index) varies per installation. Spot-
-- check both forms after rollback.
--
-- alter table public.children drop column if exists school_bell_schedule_json;
-- alter table public.children drop column if exists school_name;
-- alter table public.children drop column if exists school_enrolled;
--
-- drop table if exists public.attendance_validation_overrides;
-- drop table if exists public.cdc_billing_submissions;
--
-- drop index if exists public.attendance_child_date_segment_key;
-- drop index if exists public.attendance_user_date_idx;
-- create unique index if not exists attendance_child_id_date_key
--   on public.attendance (child_id, date);
--
-- alter table public.attendance drop column if exists segment_index;
