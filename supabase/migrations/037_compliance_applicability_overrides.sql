-- ============================================================
-- MI Little Care — Compliance Engine Phase 3
-- compliance_applicability_overrides table (data layer for the
-- applicability-resolution mechanism the Phase 1 engine left as a
-- seam).
--
-- Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md
-- §2 (table shape) + §3 (Business Info "What applies" surface) +
-- §4 (catalog-vs-capture-surface presentation) + §7 (verification
-- gate). Builds on the shipped Phase 1 engine
-- (src/lib/complianceState.js) which already accepts the
-- `overrides: Map<requirement_key, 'applies' | 'does_not_apply'>`
-- parameter as layer 1 of resolveApplicability — this migration
-- ships the persistence the loader fills that Map from. The pure
-- engine API is UNCHANGED.
--
-- ── §2a GOVERNING PRINCIPLE (carried verbatim from Phase 1) ─────
-- The engine NEVER silently resolves a real regulatory requirement
-- to `not_applicable` when it cannot actually determine
-- applicability. It resolves to `unknown` instead. The override
-- row IS the affirmative basis — never a silent default. An
-- UNanswered question = no row in this table = engine falls back
-- to the registry's `autoDefault` (which is `unknown` for the
-- three rows this UI asks about, per the spec's §6 locked
-- defaults). The Business Info surface NEVER creates a "no" row
-- in disguise — only an explicit user click on "No" produces a
-- `does_not_apply` row.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────
-- Creates `public.compliance_applicability_overrides`:
--   - Per-provider rows. Phase 3 UI only writes provider-wide
--     rows (family_id, child_id both NULL).
--   - Forward-compat: `family_id` (uuid, nullable) and `child_id`
--     (uuid, nullable) columns exist but are UNUSED in this
--     phase. They are RESERVED for two future use cases:
--       (a) per-family overrides — the deferred
--           consent_religious_objection_emergency_medical
--           requirement is per-family by rule and will need this
--           column when its capture flow ships;
--       (b) rare per-child overrides for edge cases that the
--           current registry doesn't require.
--     Neither use case has a UI today; the columns ship empty so
--     no later schema migration is required when they do. Do NOT
--     remove these columns as "dead" — they are deliberate.
--   - `mode text NOT NULL CHECK IN ('applies', 'does_not_apply')`
--     — the engine's `overrides: Map` only accepts these two
--     values. UNKNOWN is represented by the absence of a row
--     (or by archived_at NOT NULL), which makes the engine fall
--     back to the registry's autoDefault.
--   - Soft-delete pair (`archived_at`, `archived_by`) per the
--     never-hard-delete rule in CLAUDE.md. The UI's "Reset to
--     auto" action archives the row; the loader's WHERE
--     `archived_at IS NULL` filter then makes the engine fall
--     back to autoDefault.
--   - Audit columns (`set_at`, `set_by_user_id`, `notes`,
--     `created_at`, `updated_at`).
--   - RLS — provider owns their rows; no DELETE policy (soft-
--     delete only).
--   - Partial-unique index on the active row per
--     (provider, requirement_key, family_id, child_id) — mirrors
--     the consent_templates / acknowledgments active-unique
--     pattern.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────
-- - NO engine API change. The pure verdict + the Map shape are
--   shipped (Phase 1). The loader fills the Map; the engine
--   resolves; nothing in src/lib/complianceState.js needs to
--   change to honor the new table.
-- - NO functions / triggers / RPCs. This is a pure table + RLS
--   migration. There is therefore NO SECURITY DEFINER trailer
--   to apply (the canonical revoke/grant trailer applies to
--   functions; this migration creates none).
-- - NO data. Empty table after the CREATE; rows arrive via the
--   Business Info "What applies to my program?" UI shipping in
--   the same PR.
-- - NO change to the existing registry's row count, autoDefault
--   values, or state resolvers. The 52-row registry is
--   unchanged.
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────
-- CREATE TABLE / INDEX / POLICY all use IF NOT EXISTS or the
-- DROP IF EXISTS / CREATE idiom. Re-running this migration on
-- top of itself is a no-op (modulo schema-version metadata Supabase
-- may or may not keep).
--
-- ── DEPENDENCY ──────────────────────────────────────────────────
-- Sequential after migration 036. No data dependency on prior
-- migrations beyond `auth.users` (for the FK on `set_by_user_id`
-- and `archived_by`) and `public.profiles` (for the FK on
-- `provider_id`).
--
-- ── EXPECTED VERIFICATION (run by Seth AFTER applying — paste
--    into the Supabase web SQL Editor, screenshot results, per
--    CLAUDE.md verification-gap rule). ──────────────────────────
--
--   -- (a) Table + columns exist with the right types + nullability.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public'
--      and table_name='compliance_applicability_overrides'
--    order by ordinal_position;
--   -- expect 12 columns:
--   --   id (uuid, NO), provider_id (uuid, NO),
--   --   requirement_key (text, NO), mode (text, NO),
--   --   family_id (uuid, YES), child_id (uuid, YES),
--   --   set_at (timestamptz, NO), set_by_user_id (uuid, YES),
--   --   notes (text, YES), archived_at (timestamptz, YES),
--   --   archived_by (uuid, YES), created_at (timestamptz, NO),
--   --   updated_at (timestamptz, NO).
--
--   -- (b) CHECK constraint on `mode`.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname='compliance_overrides_mode_check';
--   -- expect: CHECK ((mode = ANY (ARRAY['applies'::text, 'does_not_apply'::text])))
--
--   -- (c) Partial-unique index for the active row.
--   select indexname, indexdef
--     from pg_indexes
--    where tablename='compliance_applicability_overrides';
--   -- expect at least:
--   --   compliance_overrides_active_unique (partial, archived_at IS NULL)
--   --   compliance_overrides_by_provider (partial, archived_at IS NULL)
--
--   -- (d) RLS enabled + policies present.
--   select polname, polcmd, polroles::regrole[]
--     from pg_policy
--    where polrelid = 'public.compliance_applicability_overrides'::regclass
--    order by polcmd, polname;
--   -- expect: SELECT / INSERT / UPDATE policies for `authenticated`,
--   --        NO DELETE policy (soft-delete only).
--
--   -- (e) RLS is enforced.
--   select relname, relrowsecurity
--     from pg_class
--    where relname='compliance_applicability_overrides';
--   -- expect: relrowsecurity = true.
--
-- ── LIVE GATE (run AFTER applying, against Vanessa's account in
--    the browser console as the real user — `window.supabase`,
--    per CLAUDE.md Engineering Discipline rule 3). The full gate
--    is in `docs/pr-compliance-engine-phase-3-scope.md` §7.3.
--    Quick smoke check: ───────────────────────────────────────────
--
--   1. As Vanessa (signed in): open BusinessInfo → "What applies
--      to my program?" → click "Yes" on "Do you have a pool, kiddie
--      pool, or other water feature?". Verify a row arrives in
--      compliance_applicability_overrides with
--      provider_id = Vanessa's id,
--      requirement_key = 'consent_water_activities_on_premises_seasonal',
--      mode = 'applies',
--      family_id IS NULL, child_id IS NULL,
--      archived_at IS NULL.
--   2. Open `/compliance` (or per-child Compliance tab). Confirm
--      the corresponding requirement row's STATE transitioned
--      from `unknown` (reason 'awaiting-provider-input') to
--      `missing_required` (Vanessa has no water-activities ack on
--      file).
--   3. Click "Reset to auto" → row's archived_at gets set →
--      requirement state returns to `unknown`. Confirm the active
--      row count drops to 0 (the row stays for the audit trail).
--   4. §2a sanity: walk through every category in Vanessa's
--      checklist. Confirm NO row shows `not_applicable` without
--      one of: (a) license_type exclusion, (b) data-inferred
--      negative, (c) provider override = does_not_apply. If any
--      row shows N/A without one of those, HALT — the engine
--      principle has a hole.
--
-- ============================================================

-- -------------------------------------------------------
-- 1. compliance_applicability_overrides table
-- -------------------------------------------------------
create table if not exists public.compliance_applicability_overrides (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references public.profiles(id) on delete cascade,
  -- Stable string identifier from REQUIREMENT_REGISTRY in
  -- src/lib/complianceState.js. No FK enforcement (the registry
  -- lives in code, not the DB — same posture as ack types and
  -- consent_type). The loader filters rows whose requirement_key
  -- doesn't match a known registry key, so a stale key here is a
  -- no-op rather than a crash.
  requirement_key     text not null,
  -- The override value. The engine's overrides Map only accepts
  -- 'applies' and 'does_not_apply'. UNKNOWN is the absence of a
  -- row (or an archived row), which makes the engine fall back
  -- to the registry's autoDefault — see the §2a comment in the
  -- header.
  mode                text not null
    constraint compliance_overrides_mode_check
    check (mode in ('applies', 'does_not_apply')),
  -- ── Forward-compat scope columns (RESERVED — UNUSED in Phase 3). ──
  -- The UI shipped in this PR writes both NULL. The loader filters
  -- rows where these are non-null as "narrower than provider-wide"
  -- — that semantics ships when a writer for the narrower scope
  -- exists. First future use case: the deferred
  -- consent_religious_objection_emergency_medical row is per-family
  -- by rule (R 400.1907(1)(d)) and will write `family_id` when its
  -- ACK type + capture flow eventually ship. Per-child is for rare
  -- edge cases that the current registry doesn't require but the
  -- schema accommodates without a future migration.
  --
  -- DO NOT REMOVE these columns as "dead." Removing them later
  -- would force a migration when the per-family writer ships;
  -- shipping them now is the forward-compat decision recorded in
  -- the Phase 3 scope doc decision #2.
  family_id           uuid references public.families(id) on delete cascade,
  child_id            uuid references public.children(id) on delete cascade,
  -- Audit + retention per CLAUDE.md (never hard-delete).
  set_at              timestamptz not null default now(),
  set_by_user_id      uuid references auth.users(id) on delete set null,
  notes               text,
  archived_at         timestamptz,
  archived_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.compliance_applicability_overrides is
  'Phase 3 — per-provider applicability overrides for the compliance '
  'engine''s ''auto: unknown'' registry rows. The override is the '
  'affirmative basis the engine''s §2a principle requires (never '
  'silently resolve a regulatory requirement to not_applicable). An '
  'absent or archived row makes the engine fall back to '
  'REQUIREMENT_REGISTRY[key].applicability.autoDefault — which is '
  '''unknown'' for the three rows the Phase 3 UI asks about.';

comment on column public.compliance_applicability_overrides.requirement_key is
  'Stable identifier from REQUIREMENT_REGISTRY in '
  'src/lib/complianceState.js. No FK to the DB because the registry '
  'lives in code; stale keys here are no-ops in the loader. Phase 3 '
  'writes one of three keys: '
  '''consent_transportation_routine_annual'', '
  '''consent_water_activities_on_premises_seasonal'', '
  '''property_animal_notification''. Future registry additions with '
  'autoDefault=unknown automatically appear in the Business Info '
  'questions UI without a UI code change.';

comment on column public.compliance_applicability_overrides.mode is
  '''applies'' or ''does_not_apply''. UNKNOWN is the absence of '
  'an active row — DO NOT add a third enum value; the engine''s '
  'overrides Map shape is fixed by the Phase 1 contract.';

comment on column public.compliance_applicability_overrides.family_id is
  'RESERVED for forward-compat — UNUSED in Phase 3 (always NULL '
  'via the Phase 3 UI). First future writer: the deferred '
  'consent_religious_objection_emergency_medical row, which is '
  'per-family by R 400.1907(1)(d). Do not remove as "dead."';

comment on column public.compliance_applicability_overrides.child_id is
  'RESERVED for forward-compat — UNUSED in Phase 3 (always NULL '
  'via the Phase 3 UI). For rare per-child overrides on edge cases '
  'the current registry doesn''t require. Do not remove as "dead."';

-- -------------------------------------------------------
-- 2. Indexes
-- -------------------------------------------------------

-- Partial-unique: at most one ACTIVE row per
-- (provider, requirement_key, family_id, child_id). The
-- coalesce-to-sentinel UUID pattern mirrors
-- consent_templates_active_unique + acknowledgments_active_unique:
-- a NULL family_id and a NULL child_id both treated as the
-- well-known sentinel so two provider-wide rows for the same key
-- can't both be active.
create unique index if not exists compliance_overrides_active_unique
  on public.compliance_applicability_overrides (
    provider_id,
    requirement_key,
    coalesce(family_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(child_id,  '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where archived_at is null;

-- Provider lookup for the loader's by-provider fetch.
create index if not exists compliance_overrides_by_provider
  on public.compliance_applicability_overrides (provider_id)
  where archived_at is null;

-- -------------------------------------------------------
-- 3. updated_at trigger
-- -------------------------------------------------------
-- The set_updated_at() function is created by migration 001.
drop trigger if exists compliance_overrides_set_updated_at
  on public.compliance_applicability_overrides;
create trigger compliance_overrides_set_updated_at
  before update on public.compliance_applicability_overrides
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 4. Row Level Security
-- -------------------------------------------------------
alter table public.compliance_applicability_overrides enable row level security;

-- SELECT — provider reads only their own rows.
drop policy if exists "Providers can view their own applicability overrides"
  on public.compliance_applicability_overrides;
create policy "Providers can view their own applicability overrides"
  on public.compliance_applicability_overrides for select to authenticated
  using (provider_id = auth.uid());

-- INSERT — provider creates only rows owned by themselves.
drop policy if exists "Providers can insert their own applicability overrides"
  on public.compliance_applicability_overrides;
create policy "Providers can insert their own applicability overrides"
  on public.compliance_applicability_overrides for insert to authenticated
  with check (provider_id = auth.uid());

-- UPDATE — provider modifies only their own rows (covers the soft-
-- delete via archived_at and any future mode/notes edit).
drop policy if exists "Providers can update their own applicability overrides"
  on public.compliance_applicability_overrides;
create policy "Providers can update their own applicability overrides"
  on public.compliance_applicability_overrides for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- NO DELETE POLICY. Soft-delete only via archived_at, per
-- CLAUDE.md never-hard-delete rule.

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- WARNING: rolling back this migration drops the table + every
-- override row. Provider answers to the Business Info "What
-- applies to my program?" section are lost. The Phase 1 engine
-- continues to honor the missing rows by falling back to the
-- registry's autoDefault — so the rollback is recoverable in
-- principle, but the providers' answers must be re-collected.
-- Pre-flight check (recommended): screenshot the table contents
-- so the affected providers can be re-asked their questions
-- post-rollback.
--
-- drop trigger if exists compliance_overrides_set_updated_at
--   on public.compliance_applicability_overrides;
-- drop policy if exists "Providers can view their own applicability overrides"
--   on public.compliance_applicability_overrides;
-- drop policy if exists "Providers can insert their own applicability overrides"
--   on public.compliance_applicability_overrides;
-- drop policy if exists "Providers can update their own applicability overrides"
--   on public.compliance_applicability_overrides;
-- drop index if exists public.compliance_overrides_active_unique;
-- drop index if exists public.compliance_overrides_by_provider;
-- drop table if exists public.compliance_applicability_overrides;
