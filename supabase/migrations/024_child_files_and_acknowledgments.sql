-- ============================================================
-- MI Little Care — PR #16: Child files (Rule 7) + general acknowledgments
--
-- Authoritative scope: docs/pr-16-child-files-scope.md (resolved
-- 2026-05-26 review). This migration:
--   1. Extends `public.children` with the Rule 7 / R 400.1907
--      structured fields (immunization, food provider, annual review,
--      intake completion).
--   2. Adds two property disclosures to `public.profiles` (lead-based
--      paint per pre-1978 homes and firearms on premises).
--   3. Creates the general `public.acknowledgments` table — the
--      polymorphic acknowledgment substrate that PR #16 itself
--      consumes (child-in-care statement envelope + sub-rows for
--      lead/firearms/food/etc.) AND that future PRs #17 (discipline
--      policy) and PR #20 (medication parent permission) consume
--      without further migration.
--
-- DEPENDENCY: applies AFTER migration 023 (reminder system, PR #15).
--
-- ── DESIGN DECISIONS (from the scope doc's OQ resolutions) ────────────
--   OQ4 envelope shape: a single `child_in_care_statement` envelope row
--     carries `snapshot_hash = computeEnvelopeHash(sub-row hashes)`
--     (sorted, deterministic composition). Up to 7 sub-rows
--     (lead_disclosure, firearms_disclosure, food_provider_agreement,
--     licensing_notebook_offered, infant_safe_sleep,
--     discipline_policy_receipt, health_condition) per intake. The
--     schema does NOT enforce envelope-vs-sub structure: the application
--     constructs the bundle and writes all rows in a transaction.
--   OQ5 denormalize provider_id: provider_id sits directly on every
--     acknowledgments row (mirrors PR #12's `attendance_acknowledgments`
--     pattern). Simpler RLS path and a direct index for the
--     audit-state helper.
--   OQ3 acknowledged_via CHECK enumeration:
--     'parent_portal' | 'provider_override' | 'in_person_paper'. These
--     are stable channel concepts; a CHECK constraint (vs. free-text)
--     is appropriate here because the constraint shape on each value
--     differs (see `acknowledgments_channel_shape` below).
--   `subject_type` STAYS free-text (matches PR #15 OQ3 reasoning): the
--     application catalog (`src/lib/acknowledgments.js` ACK_TYPES) is
--     the authoritative validator; future PRs add new `(type,
--     subject_type)` pairs without ALTER constraints.
--
-- ── RLS POLICY SHAPE ──────────────────────────────────────────────────
-- Children + profiles extensions: existing RLS on those tables already
-- gates by user_id / auth.uid(). The new columns inherit those policies
-- without change.
--
-- Acknowledgments:
--   - Provider sees rows where `provider_id = auth.uid()`. SELECT +
--     INSERT + UPDATE allowed (UPDATE is used to archive rows; no
--     DELETE policy because soft-delete is via `archived_at`).
--   - Parent sees rows where the subject is one of their children
--     (subject_type='child' + subject_id in their family's children via
--     parent_family_links). Parent INSERT for self-sign restricted to
--     their own user id.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- CREATE TABLE / INDEX / FUNCTION use IF NOT EXISTS or OR REPLACE.
-- CREATE POLICY uses DROP/CREATE (Postgres does not support
-- IF NOT EXISTS on CREATE POLICY — see migration 016 lesson in
-- docs/tech_debt.md). ALTER TABLE column adds use IF NOT EXISTS.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Per docs/tech_debt.md § "Verification gap discovered 2026-05-15": the
-- user runs these in the Supabase web SQL Editor and screenshots the
-- results BEFORE writing the runbook Migration History entry.
--
--   -- a) children + profiles columns exist with expected shape:
--   select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public'
--     and (
--       (table_name='children' and column_name in
--         ('immunization_status','immunization_record_url',
--          'food_provider','records_last_reviewed_on','intake_completed_at'))
--       or
--       (table_name='profiles' and column_name in
--         ('home_built_before_1978','firearms_on_premises'))
--     )
--   order by table_name, column_name;
--   -- expect 7 rows.
--
--   -- b) acknowledgments table exists:
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public' and table_name='acknowledgments'
--   order by ordinal_position;
--   -- expect: id, provider_id, type, subject_type, subject_id,
--   --         acknowledged_by_user_id, acknowledged_by_label,
--   --         acknowledged_via, acknowledged_at,
--   --         provider_override_reason, snapshot_hash, snapshot_version,
--   --         archived_at, created_at, updated_at  (15 rows)
--
--   -- c) Indexes:
--   select indexname from pg_indexes
--   where schemaname='public' and tablename='acknowledgments'
--   order by indexname;
--   -- expect:
--   --   acknowledgments_active_unique           (partial)
--   --   acknowledgments_pkey
--   --   acknowledgments_provider_active         (partial — audit-state helper)
--   --   acknowledgments_subject_active          (partial)
--
--   -- d) RLS policies:
--   select policyname from pg_policies
--   where schemaname='public' and tablename='acknowledgments'
--   order by policyname;
--   -- expect at least 4 policies (provider select/insert/update +
--   --                              parent select/insert).
-- ============================================================

-- -------------------------------------------------------
-- 1. children — Rule 7 / R 400.1907 structured fields
-- -------------------------------------------------------
alter table public.children
  add column if not exists immunization_status text
    constraint chk_children_immunization_status
    check (immunization_status is null
      or immunization_status in ('up_to_date', 'waiver_on_file', 'in_progress')),
  add column if not exists immunization_record_url text,
  add column if not exists food_provider text
    constraint chk_children_food_provider
    check (food_provider is null
      or food_provider in ('provider', 'parent', 'both')),
  add column if not exists records_last_reviewed_on date,
  add column if not exists intake_completed_at timestamptz;

-- -------------------------------------------------------
-- 2. profiles — per-property disclosures
-- -------------------------------------------------------
-- Both are nullable booleans set by the in-product Premises prompt on
-- BusinessInfoPage. The intake form reads them to gate which child-level
-- acknowledgments are required.
alter table public.profiles
  add column if not exists home_built_before_1978 boolean,
  add column if not exists firearms_on_premises boolean;

-- -------------------------------------------------------
-- 3. acknowledgments — general polymorphic acknowledgment table
-- -------------------------------------------------------
create table if not exists public.acknowledgments (
  id                       uuid primary key default gen_random_uuid(),

  -- The provider this acknowledgment lives under. Denormalized for RLS
  -- and audit-state queries per OQ5.
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- What is being acknowledged. `type` enumerates acknowledgment kinds:
  --   'child_in_care_statement' (PR #16 envelope),
  --   'lead_disclosure', 'firearms_disclosure',
  --   'food_provider_agreement', 'licensing_notebook_offered',
  --   'infant_safe_sleep', 'health_condition',
  --   'discipline_policy_receipt' (PR #16 stub + PR #17),
  --   'staff_discipline_policy_receipt' (PR #17),
  --   'medication_permission_otc_blanket',
  --   'medication_permission' (PR #20), etc.
  -- Validated at the application layer via ACK_TYPES catalog; the DB
  -- stores free-text per the OQ3-style reasoning.
  type                     text not null,

  -- Polymorphic subject. NULL for provider-level acknowledgments.
  -- Values: 'child' | 'caregiver' | 'family' | 'provider' | …
  subject_type             text,
  subject_id               uuid,

  -- Who acknowledged.
  acknowledged_by_user_id  uuid references auth.users(id) on delete set null,
  acknowledged_by_label    text,
  acknowledged_via         text not null
    constraint chk_acknowledgments_via
    check (acknowledged_via in ('parent_portal', 'provider_override', 'in_person_paper')),
  acknowledged_at          timestamptz not null default now(),
  provider_override_reason text,

  -- Drift detection.
  snapshot_hash            text,
  snapshot_version         text,

  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Channel-shape CHECK: each channel has its own required fields.
  constraint acknowledgments_channel_shape check (
    case acknowledged_via
      when 'parent_portal' then
        acknowledged_by_user_id is not null
        and provider_override_reason is null
      when 'provider_override' then
        provider_override_reason is not null
        and length(trim(provider_override_reason)) > 0
      when 'in_person_paper' then
        acknowledged_by_label is not null
        and length(trim(acknowledged_by_label)) > 0
    end
  )
);

create trigger acknowledgments_set_updated_at
  before update on public.acknowledgments
  for each row execute function public.set_updated_at();

-- Uniqueness: at most one ACTIVE acknowledgment per
-- (provider, type, subject). A new acknowledgment for an already-acked
-- subject requires the old row to be soft-archived first (a re-ack
-- workflow). Two partial indexes because Postgres treats NULL as
-- distinct from NULL in unique constraints (same split as
-- reminder_instances in migration 023).
create unique index if not exists acknowledgments_active_unique
  on public.acknowledgments (provider_id, type, subject_type, subject_id)
  where archived_at is null and subject_id is not null;

create unique index if not exists acknowledgments_active_unique_no_subject
  on public.acknowledgments (provider_id, type)
  where archived_at is null and subject_id is null;

-- Banner / completeness queries by subject (e.g. "which acks does this
-- child have?").
create index if not exists acknowledgments_subject_active
  on public.acknowledgments (subject_type, subject_id)
  where archived_at is null;

-- Audit-state helper hot-path: per-provider active acks.
create index if not exists acknowledgments_provider_active
  on public.acknowledgments (provider_id, type)
  where archived_at is null;

-- -------------------------------------------------------
-- 4. RLS — provider-scoped + parent-portal
-- -------------------------------------------------------
alter table public.acknowledgments enable row level security;

-- Provider sees their own rows.
drop policy if exists "Providers can view their own acknowledgments" on public.acknowledgments;
create policy "Providers can view their own acknowledgments"
  on public.acknowledgments for select to authenticated
  using (provider_id = auth.uid());

-- Provider can insert acknowledgments under their own provider_id.
drop policy if exists "Providers can insert their own acknowledgments" on public.acknowledgments;
create policy "Providers can insert their own acknowledgments"
  on public.acknowledgments for insert to authenticated
  with check (provider_id = auth.uid());

-- Provider can update (the only legitimate update is setting
-- `archived_at` to soft-delete a row that needs re-acknowledgment).
drop policy if exists "Providers can update their own acknowledgments" on public.acknowledgments;
create policy "Providers can update their own acknowledgments"
  on public.acknowledgments for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- Parent sees acks for their own children. Parent eligibility joins
-- through parent_family_links -> families -> children, same pattern as
-- attendance_acknowledgments (migration 020 § 1).
drop policy if exists "Parents can view acks on their children" on public.acknowledgments;
create policy "Parents can view acks on their children"
  on public.acknowledgments for select to authenticated
  using (
    subject_type = 'child'
    and subject_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- Parent self-sign via portal: the parent can insert an acknowledgment
-- for their child with `acknowledged_via = 'parent_portal'` and
-- `acknowledged_by_user_id = auth.uid()`. The provider_id on the row is
-- the licensee (the parent does not own it); we verify the parent has
-- access to the subject child via the same join.
drop policy if exists "Parents can insert portal acknowledgments for their children" on public.acknowledgments;
create policy "Parents can insert portal acknowledgments for their children"
  on public.acknowledgments for insert to authenticated
  with check (
    acknowledged_via = 'parent_portal'
    and acknowledged_by_user_id = auth.uid()
    and subject_type = 'child'
    and subject_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- The down migration leaves any acknowledgments rows in place; only the
-- table structure is reversed if uncommented. Children / profile column
-- drops are non-destructive (existing data rows lose only the new
-- columns).
--
-- drop policy if exists "Parents can insert portal acknowledgments for their children" on public.acknowledgments;
-- drop policy if exists "Parents can view acks on their children" on public.acknowledgments;
-- drop policy if exists "Providers can update their own acknowledgments" on public.acknowledgments;
-- drop policy if exists "Providers can insert their own acknowledgments" on public.acknowledgments;
-- drop policy if exists "Providers can view their own acknowledgments" on public.acknowledgments;
-- drop table if exists public.acknowledgments;
--
-- alter table public.profiles
--   drop column if exists firearms_on_premises,
--   drop column if exists home_built_before_1978;
--
-- alter table public.children
--   drop column if exists intake_completed_at,
--   drop column if exists records_last_reviewed_on,
--   drop column if exists food_provider,
--   drop column if exists immunization_record_url,
--   drop column if exists immunization_status;
