-- ============================================================
-- MI Little Care — PR #14: profiles.license_type (compliance source of truth)
--
-- Implements docs/pr-14-license-type-foundation-scope.md per the OQ3
-- decision in docs/licensed-home-compliance-decisions-2026-05-23.md.
--
-- Citation: R 400.1925 (capacity / licensed-home scope); the family-vs-group
-- distinction encoded here drives the ratio rules in R 400.1927 (family
-- home) and R 400.1928 (group home). license_exempt providers are
-- MDHHS-registered CDC providers under the separate Scholarship Handbook
-- for License-Exempt Providers (not the licensed-home rules).
--
-- DEPENDENCY: applies AFTER migration 021 (children.archived_at, PR #13).
-- No data dependency on 021; this is purely the runbook apply order.
--
-- ── DESIGN DECISION (PR #14 scope OQ1: ENUM vs text+CHECK) ───────────
-- Adopted: text + CHECK constraint. Rationale:
--   1. Column-shape parity with the sibling provider_type column
--      (migration 018), which uses text + CHECK on the same table.
--   2. Easier to evolve: extending the value set is a normal
--      `ALTER TABLE ... DROP/ADD CONSTRAINT` inside a transaction, whereas
--      `ALTER TYPE ... ADD VALUE` on a live ENUM cannot run inside a
--      transaction in some Postgres contexts and complicates rollback.
--   3. No functional difference for a single-column, non-joined constraint.
-- Three values today: 'family_home', 'group_home', 'license_exempt'.
-- (A `licensed_center` value could be added later via CHECK rewrite if
-- center scope ever enters milittlecare — see § Open questions in the
-- scoping doc; out of scope today per the OQ3 decision.)
--
-- ── RELATIONSHIP TO EXISTING SIGNALS ─────────────────────────────────
--   * license_type   — compliance source of truth (NEW, this migration).
--   * is_license_exempt (migration 004) — kept as a derived MIRROR in app
--     code: is_license_exempt = (license_type = 'license_exempt') when
--     license_type is set. All ~10 existing readers (MiRegistry tracker,
--     AnnualTrainingBanner, FundingSourceForm 2016-hour cap, etc.) keep
--     working untouched. See docs/pr-14-license-type-foundation-scope.md
--     § B for the per-call-site decision table.
--   * provider_type (migration 018) — CDC-billing classification,
--     unchanged. license_type and provider_type are INTENTIONALLY
--     distinct: compliance vs billing. They must not be conflated.
--   * michigan_license_number (migration 004) — kept as a record-keeping
--     field. As of PR #14, NO LONGER drives the LICENSED_COMPLIANCE
--     module gate (the gate now reads license_type). The column itself
--     stays.
--
-- ── BACKFILL (transactional, idempotent, runs in this migration) ─────
--   1. provider_type='licensed_family'  → license_type='family_home'.
--   2. provider_type='licensed_group'   → license_type='group_home'.
--   3. provider_type='licensed_center'  → leave NULL + review_needed=true
--      (out of milittlecare scope; flagged for human disambiguation).
--   4. is_license_exempt=true (and no licensed provider_type)
--                                       → license_type='license_exempt'.
--   5. is_license_exempt=true with provider_type in licensed_*
--                                       → review_needed=true (conflict).
--   6. is_license_exempt=false with no licensed provider_type
--                                       → review_needed=true (cannot tell
--      family vs group from this signal; CLAUDE.md no-default-on-backfill
--      rule. The app re-prompts via LicenseStatusPromptModal to collect
--      the family/group answer in-product — this is the EXPECTED main
--      path because provider_type has no writer in the codebase and is
--      likely null even for licensed providers like Venessa).
--   Anything else stays NULL with review_needed=false — net-new
--   providers handled by the normal capture flow (modal + wizard +
--   BusinessInfoPage editor).
--
-- review_needed surfacing: the app shows a non-dismissible banner on
-- the dashboard and re-fires LicenseStatusPromptModal whenever
-- (license_type IS NULL OR license_type_review_needed IS TRUE).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- Re-running is safe. add column uses IF NOT EXISTS; CHECK uses
-- DROP/CREATE; every backfill UPDATE filters `license_type IS NULL` so
-- already-set rows are never overwritten on a re-run.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Per docs/tech_debt.md § "Verification gap discovered 2026-05-15":
-- the user runs these in the Supabase web SQL Editor and screenshots
-- the results BEFORE writing the runbook Migration History entry.
--
--   -- a) Columns exist with expected shape:
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='profiles'
--     and column_name in ('license_type','license_type_review_needed')
--   order by column_name;
--   -- expect:
--   --   license_type                | text    | YES |
--   --   license_type_review_needed  | boolean | NO  | false
--
--   -- b) Backfill row counts (also printed by the SELECT below at apply):
--   select license_type, license_type_review_needed, count(*)
--   from public.profiles group by 1,2 order by 1 nulls last, 2;
--
--   -- c) Rows needing human confirmation (the in-product re-prompt queue):
--   select id, is_license_exempt, provider_type, michigan_license_number
--   from public.profiles
--   where license_type is null and license_type_review_needed = true;
-- ============================================================

alter table public.profiles
  add column if not exists license_type text,
  add column if not exists license_type_review_needed boolean not null default false;

alter table public.profiles
  drop constraint if exists chk_license_type;
alter table public.profiles
  add constraint chk_license_type
  check (license_type is null
    or license_type in ('family_home', 'group_home', 'license_exempt'));

-- ── Backfill ─────────────────────────────────────────────────────────
begin;

-- 1. Licensed family-home (high-confidence).
update public.profiles set license_type = 'family_home'
  where provider_type = 'licensed_family' and license_type is null;

-- 2. Licensed group-home (high-confidence).
update public.profiles set license_type = 'group_home'
  where provider_type = 'licensed_group' and license_type is null;

-- 3. licensed_center — out of milittlecare scope; flag for human review.
update public.profiles set license_type_review_needed = true
  where provider_type = 'licensed_center' and license_type is null;

-- 4. License-exempt boolean, no conflicting licensed provider_type.
update public.profiles set license_type = 'license_exempt'
  where is_license_exempt = true
    and (provider_type is null or provider_type in ('lep_related','lep_unrelated'))
    and license_type is null;

-- 5. Conflict: is_license_exempt=true but provider_type says licensed_*.
update public.profiles set license_type_review_needed = true
  where is_license_exempt = true
    and provider_type in ('licensed_family','licensed_group','licensed_center')
    and license_type is null;

-- 6. Licensed-by-boolean with no provider_type granularity — cannot tell
--    family vs group; flag rather than guess. This is the path the app
--    collects from via the dashboard re-prompt.
update public.profiles set license_type_review_needed = true
  where is_license_exempt = false
    and (provider_type is null or provider_type not in ('licensed_family','licensed_group'))
    and license_type is null;

-- Row-count summary — the audit artifact. Copy into the runbook Migration
-- History entry once you have screenshot evidence from the dashboard.
select
  count(*) filter (where license_type = 'family_home')                       as family_home,
  count(*) filter (where license_type = 'group_home')                        as group_home,
  count(*) filter (where license_type = 'license_exempt')                    as license_exempt,
  count(*) filter (where license_type is null and license_type_review_needed)
                                                                              as needs_review,
  count(*) filter (where license_type is null and not license_type_review_needed)
                                                                              as unanswered_new,
  count(*) as total
from public.profiles;

commit;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Non-destructive to reverse: is_license_exempt / provider_type were
-- never modified by this migration, so the legacy signals remain intact.
-- A rollback leaves the data as it was before PR #14 applied.
--
-- alter table public.profiles
--   drop constraint if exists chk_license_type;
-- alter table public.profiles
--   drop column if exists license_type_review_needed,
--   drop column if exists license_type;
