-- ============================================================
-- MI Little Care — PR #20: Medication administration log (Rule 31).
--
-- Authoritative scope: docs/pr-20-medication-log-scope.md (reconciled
-- against verbatim R 400.1931 text on 2026-06-02; see § "Verbatim
-- subsections this PR consumes"). This migration ships the
-- data-layer foundation (no UI in this PR — Part 1 of 2):
--
--   1. `public.medication_authorizations` — one row per (child,
--      medication). Provider's record of the active medication plan,
--      original-container attestation, OTC vs prescription split.
--   2. `public.medication_administration_events` — one row per dose.
--      Date/time/amount of every administered or applied dose, with
--      the administering caregiver, FK-locked to the authorization.
--      Retention: 2 years from `administered_at` per R 400.1931(9),
--      enforced via the soft-delete convention (`archived_at`) — no
--      auto-delete.
--   3. `medication_event_caregiver_role_check()` trigger on the
--      events table — enforces R 400.1931(1) at the DB level.
--      EXCEPT for `is_topical_otc=true` events (per R 400.1931(8)
--      exemption); see the trigger body for the rule-faithful logic.
--   4. RLS policies — provider-scoped via `provider_id`.
--
-- DEPENDENCY: applies AFTER migration 027
--   (acknowledgments_per_occurrence). This PR does NOT touch the
--   `acknowledgments` table — the two medication ACK_TYPES
--   (medication_permission_otc_blanket, medication_permission) are
--   already in the catalog (`src/lib/acknowledgments.js`) and ride
--   the existing engine. medication_permission uses
--   subject_type='medication_authorization' + subject_id=<auth_id>
--   (a distinct subject_id per authorization), which is how the
--   medication model sidesteps the per-occurrence index-relaxation
--   problem Phase C had to solve.
--
-- ── DESIGN DECISIONS (from docs/pr-20-medication-log-scope.md) ───────
--
--   A.1 Two-table model: authorizations (durable per child ×
--       medication) + administration events (per dose). Distinct
--       lifecycles — an authorization can be on file for months
--       while many dose events reference it. FK `on delete restrict`
--       (NOT cascade) so dose records survive authorization archival.
--   A.2 Role-gate trigger with OTC branch — see below.
--   A.3 Parent permission rides `public.acknowledgments` via the two
--       existing ACK_TYPES; no medication-specific consent table.
--   OQ4 Allergies displayed prominently in the modal via the existing
--       `children.allergies` column — no schema change here.
--
-- ── RULE-FAITHFUL ROLE-GATE (R 400.1931(1) + (8) reconciled) ─────────
--
-- (1) verbatim: "Medication, prescription or nonprescription, must be
--     given to a child in care by a licensee or a child care staff
--     member only. A child care assistant or supervised volunteer
--     shall not give medication to a child in care."
-- (8) verbatim: "Topical nonprescription medication, including, but
--     not limited to, sunscreen, insect repellant, and diaper rash
--     ointment, is exempt from subrules (1) and (7)."
--
-- So the trigger must:
--   * Gate ALL medication EXCEPT topical OTC (prescription + oral
--     OTC both subject to the gate).
--   * Skip the gate when the linked authorization's
--     `is_topical_otc=true`.
--
-- The pre-reconciliation scope draft framed the gate as
-- "prescription only" — too narrow on the rule's "(prescription or
-- nonprescription)" scope AND silently mishandled (8)'s exemption.
-- Corrected 2026-06-02 in the scope doc and embodied here.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- CREATE TABLE / INDEX use IF NOT EXISTS. CREATE OR REPLACE on the
-- function. CREATE POLICY uses DROP/CREATE (Postgres does not
-- support IF NOT EXISTS on CREATE POLICY — same pattern as migration
-- 024). CREATE TRIGGER uses DROP-then-CREATE because Postgres has
-- no CREATE TRIGGER IF NOT EXISTS.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Per docs/tech_debt.md § "Verification gap discovered 2026-05-15":
-- the user runs these in the Supabase web SQL Editor and screenshots
-- the result BEFORE writing the runbook Migration History entry. The
-- three trigger tests (Pair A negative + positive, Pair B positive)
-- are the legally-consequential verification — they prove
-- R 400.1931(1) is enforced AND R 400.1931(8) is honored. See the
-- runbook entry for the SQL.
--
--   -- a) Both tables exist with the expected columns.
--   select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema='public'
--     and table_name in ('medication_authorizations',
--                        'medication_administration_events')
--   order by table_name, ordinal_position;
--
--   -- b) The role-gate trigger exists on the events table.
--   select tgname, tgenabled, tgrelid::regclass
--   from pg_trigger
--   where tgname = 'trg_medication_event_caregiver_role_check';
--   -- expect 1 row, tgenabled='O' (enabled),
--   --        tgrelid = public.medication_administration_events
--
--   -- c) The authorization partial-unique index exists.
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname='public'
--     and tablename='medication_authorizations'
--     and indexname='idx_med_auth_active_per_child_med';
--   -- expect: WHERE clause includes "archived_at IS NULL"
--
--   -- d) No existing data is affected (the tables are new).
--   select count(*) from public.medication_authorizations;
--   select count(*) from public.medication_administration_events;
--   -- expect: both 0.
-- ============================================================

-- -------------------------------------------------------
-- 1. medication_authorizations — one row per (child, medication)
-- -------------------------------------------------------
create table if not exists public.medication_authorizations (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,
  child_id                 uuid not null references public.children(id) on delete cascade,

  -- Medication identity + plan.
  medication_name          text not null,
  dose_text                text,                    -- "5 mL by mouth" — free text (scope OQ1: structured schedule deferred to V2)
  schedule_text            text,                    -- "twice daily, 8a + 8p" — free text

  -- R 400.1931(8) discriminant: when true, the row's events bypass
  -- the role-gate trigger AND the per-dose log is OPTIONAL (per
  -- (7)'s exemption). When false (prescription or oral OTC), all of
  -- (1) + (7) apply.
  is_topical_otc           boolean not null default false,

  -- R 400.1931(4) — prescription label fields. Captured loosely via
  -- prescriber_name + dose_text + schedule_text + the linked child;
  -- original_container_confirmed is the provider's attestation that
  -- they verified the bottle's label against the rule.
  prescriber_name          text,
  starts_on                date,
  ends_on                  date,                    -- null = ongoing
  original_container_confirmed boolean not null default false,

  -- Soft-delete (audit retention; CLAUDE.md never-hard-delete rule).
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One active medication name per child. Re-acking / replacing an
-- authorization archives the prior row and inserts a new one — same
-- archive-then-insert convention as Phase A re-acks.
create unique index if not exists idx_med_auth_active_per_child_med
  on public.medication_authorizations (child_id, lower(medication_name))
  where archived_at is null;

create index if not exists idx_med_auth_provider_child
  on public.medication_authorizations (provider_id, child_id)
  where archived_at is null;

create trigger medication_authorizations_set_updated_at
  before update on public.medication_authorizations
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 2. medication_administration_events — one row per dose
-- -------------------------------------------------------
create table if not exists public.medication_administration_events (
  id                       uuid primary key default gen_random_uuid(),
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- FK to the authorization. ON DELETE RESTRICT: a dose record is
  -- audit data; deleting the authorization MUST NOT cascade to its
  -- dose log. To remove an authorization, archive it (sets
  -- archived_at) — the events remain queryable for the 2-year
  -- retention window per R 400.1931(9).
  authorization_id         uuid not null references public.medication_authorizations(id) on delete restrict,

  -- Denormalized child_id for query convenience; enforced to match
  -- the authorization's child_id at app-layer insert time.
  child_id                 uuid not null references public.children(id) on delete cascade,

  -- R 400.1931(7) required fields: date, time, amount of every dose.
  -- `administered_at` carries date + time as a single timestamptz;
  -- `dose_administered_text` carries the amount (free text — "5 mL",
  -- "1 tsp", "two pumps of sunscreen" — captured even when it matches
  -- the authorization's dose_text, in case the actual dose was
  -- partial).
  administered_at          timestamptz not null,
  dose_administered_text   text,

  -- WHO administered. The role-gate trigger below verifies this
  -- caregiver has an eligible role for non-topical-OTC events.
  -- ON DELETE RESTRICT: a caregiver's removal from the roster must
  -- not orphan or destroy dose records they previously administered.
  administered_by_caregiver_id uuid not null references public.caregivers(id) on delete restrict,

  notes                    text,
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_med_events_child_recent
  on public.medication_administration_events (child_id, administered_at desc)
  where archived_at is null;

create index if not exists idx_med_events_provider_recent
  on public.medication_administration_events (provider_id, administered_at desc)
  where archived_at is null;

create index if not exists idx_med_events_authorization
  on public.medication_administration_events (authorization_id, administered_at desc)
  where archived_at is null;

create trigger medication_events_set_updated_at
  before update on public.medication_administration_events
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 3. Role-gate trigger (R 400.1931(1) + (8) reconciled)
-- -------------------------------------------------------
-- Defense in depth for legally-consequential rules (CLAUDE.md):
-- the app code gates the administered_by_caregiver_id dropdown to
-- eligible roles, AND this trigger enforces the rule at the DB
-- level so any future admin tool / API endpoint / direct SQL
-- bypass is blocked.
--
-- (1) verbatim: "Medication, prescription or nonprescription, must
--     be given to a child in care by a licensee or a child care
--     staff member only. A child care assistant or supervised
--     volunteer shall not give medication to a child in care."
-- (8) verbatim: "Topical nonprescription medication, including, but
--     not limited to, sunscreen, insect repellant, and diaper rash
--     ointment, is exempt from subrules (1) and (7)."
--
-- The trigger reads the linked authorization's `is_topical_otc`
-- (the source of truth — the row classification). For OTC events
-- the role-check is skipped. For everything else, only
-- `licensee` or `child_care_staff_member` from the
-- `caregiver_regulatory_roles` junction table is accepted. Any
-- other role — including `child_care_assistant`,
-- `supervised_volunteer`, `unsupervised_volunteer`, `driver`, or a
-- caregiver with NO regulatory_role rows — is rejected.

create or replace function public.medication_event_caregiver_role_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_topical_otc boolean;
begin
  -- R 400.1931(8) — resolve OTC status from the linked authorization.
  -- If the authorization is missing (shouldn't happen via FK, but
  -- defensive), v_is_topical_otc is NULL and coalesce treats it as
  -- false → role-check applies (safe-by-default fall-through).
  select is_topical_otc into v_is_topical_otc
    from public.medication_authorizations
   where id = new.authorization_id;

  if coalesce(v_is_topical_otc, false) then
    return new;
  end if;

  -- R 400.1931(1) — role-gate for everything else.
  if not exists (
    select 1 from public.caregiver_regulatory_roles
     where caregiver_id = new.administered_by_caregiver_id
       and regulatory_role in ('licensee', 'child_care_staff_member')
  ) then
    raise exception 'Only licensee or child care staff member may administer medication (R 400.1931(1))';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_medication_event_caregiver_role_check on public.medication_administration_events;
create trigger trg_medication_event_caregiver_role_check
  before insert on public.medication_administration_events
  for each row execute function public.medication_event_caregiver_role_check();

-- -------------------------------------------------------
-- 4. RLS — provider-scoped on both tables
-- -------------------------------------------------------
alter table public.medication_authorizations enable row level security;
alter table public.medication_administration_events enable row level security;

-- ── medication_authorizations ──────────────────────────────────────

drop policy if exists "Providers can view their medication authorizations" on public.medication_authorizations;
create policy "Providers can view their medication authorizations"
  on public.medication_authorizations for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their medication authorizations" on public.medication_authorizations;
create policy "Providers can insert their medication authorizations"
  on public.medication_authorizations for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their medication authorizations" on public.medication_authorizations;
create policy "Providers can update their medication authorizations"
  on public.medication_authorizations for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- No DELETE policy — soft-delete via archived_at only (CLAUDE.md
-- never-hard-delete rule for audit-retention data).

-- Parents see authorizations for their own children (mirrors the
-- attendance_acknowledgments / acknowledgments parent-side
-- pattern: parent_family_links → children).
drop policy if exists "Parents can view medication authorizations for their children" on public.medication_authorizations;
create policy "Parents can view medication authorizations for their children"
  on public.medication_authorizations for select to authenticated
  using (
    child_id in (
      select c.id from public.children c
       where c.family_id in (
         select pfl.family_id from public.parent_family_links pfl
          where pfl.parent_id = auth.uid() and pfl.status = 'active'
       )
    )
  );

-- ── medication_administration_events ──────────────────────────────

drop policy if exists "Providers can view their medication events" on public.medication_administration_events;
create policy "Providers can view their medication events"
  on public.medication_administration_events for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their medication events" on public.medication_administration_events;
create policy "Providers can insert their medication events"
  on public.medication_administration_events for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their medication events" on public.medication_administration_events;
create policy "Providers can update their medication events"
  on public.medication_administration_events for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- Parents see dose events for their own children — same join shape
-- as the authorizations parent-side policy.
drop policy if exists "Parents can view medication events for their children" on public.medication_administration_events;
create policy "Parents can view medication events for their children"
  on public.medication_administration_events for select to authenticated
  using (
    child_id in (
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
-- This is destructive: dose records and authorizations are lost.
-- DO NOT run rollback if production data exists in these tables —
-- the 2-year retention rule R 400.1931(9) requires the dose log to
-- be preserved. If rollback is genuinely necessary, export the
-- tables first and store the export per the retention rule.
--
-- drop policy if exists "Parents can view medication events for their children" on public.medication_administration_events;
-- drop policy if exists "Providers can update their medication events" on public.medication_administration_events;
-- drop policy if exists "Providers can insert their medication events" on public.medication_administration_events;
-- drop policy if exists "Providers can view their medication events" on public.medication_administration_events;
-- drop policy if exists "Parents can view medication authorizations for their children" on public.medication_authorizations;
-- drop policy if exists "Providers can update their medication authorizations" on public.medication_authorizations;
-- drop policy if exists "Providers can insert their medication authorizations" on public.medication_authorizations;
-- drop policy if exists "Providers can view their medication authorizations" on public.medication_authorizations;
-- drop trigger if exists trg_medication_event_caregiver_role_check on public.medication_administration_events;
-- drop function if exists public.medication_event_caregiver_role_check();
-- drop table if exists public.medication_administration_events;
-- drop table if exists public.medication_authorizations;
