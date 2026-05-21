-- ============================================================
-- MI Little Care — PR #8.5b: Promote CDC fields from details JSON to
-- typed columns; expand funding_source_status enum.
--
-- Pre-flight audit results (Seth, dashboard inspection 2026-05-20):
--   - 10 details JSON keys on CDC rows: exact match to the spec's list,
--     no HALT triggered.
--   - 1 CDC row with populated details (0 null, 0 empty); 0 currently
--     have a dhs_198_issue_date key (confirms new column, NULL on
--     backfill).
--   - 15 active rows across all funding source types; 0 paused / 0
--     ended; no status reclassification needed.
--   - shared_provider_notes in production is the empty string '' (not
--     NULL). Backfill uses NULLIF on every text column to coerce '' to
--     NULL so the typed columns carry semantically meaningful values.
--
-- Migration body follows the addendum's Step 2 + the empty-string-NULL
-- correction.
-- ============================================================

-- -------------------------------------------------------
-- 1. Expand funding_source_status enum (additive, non-destructive)
-- -------------------------------------------------------
-- 'pending' / 'expired' / 'terminated' / 'renewed' added per spec § PR
-- #8.5b. 'expiring' is NOT an enum value — it's UI-derived from
-- (authorization_end - now < 30 days) in src/lib/cdcAuthorization.js.
-- Existing 'active' / 'paused' / 'ended' values retained for backward
-- compatibility; 'ended' is a deprecated alias for 'expired' or
-- 'terminated' depending on cause, surfaced for human reclassification
-- in spec § Step 6's report (which returned 0 rows per Seth's audit).
alter type public.funding_source_status add value if not exists 'pending';
alter type public.funding_source_status add value if not exists 'expired';
alter type public.funding_source_status add value if not exists 'terminated';
alter type public.funding_source_status add value if not exists 'renewed';

-- -------------------------------------------------------
-- 2. CDC-specific typed columns
-- -------------------------------------------------------
alter table public.funding_sources
  add column if not exists case_number                  text,
  add column if not exists dhs_198_issue_date           date,
  add column if not exists dhs_198_received_date        date,
  add column if not exists authorization_start          date,
  add column if not exists authorization_end            date,
  add column if not exists approved_hours_per_period    numeric(6,2),
  add column if not exists family_contribution_amount   numeric(8,2),
  add column if not exists billing_basis                text,
  add column if not exists age_tier                     text
    check (age_tier is null
       or age_tier in ('infant_toddler', 'preschool', 'school_age')),
  add column if not exists rate_tier_at_issue           text
    check (rate_tier_at_issue is null
       or rate_tier_at_issue in ('level_1', 'level_2')),
  add column if not exists shared_with_other_provider   boolean,
  add column if not exists shared_provider_notes        text,
  add column if not exists provider_pin_required        boolean,
  add column if not exists renewed_to_id                uuid
    references public.funding_sources(id) on delete set null;

-- -------------------------------------------------------
-- 3. Backfill from details JSON
-- -------------------------------------------------------
-- NULLIF(text, '') across every column ensures empty-string values
-- (per audit, shared_provider_notes is '') become NULL in the typed
-- columns rather than carrying through as meaningless empty text. The
-- ::date / ::numeric / ::boolean casts on NULLIF results work
-- correctly because NULLIF(NULL or '', '') returns NULL, and casting
-- NULL is a no-op.
update public.funding_sources
-- Discovery confirmed only text columns can carry '' from JSON
-- (shared_provider_notes specifically); date/numeric/boolean values in
-- production are well-formed. NULLIF wraps the three text columns;
-- direct cast on the rest matches the discovery handoff doc's
-- backfill snippet verbatim.
set
  case_number                = nullif(details ->> 'case_number', ''),
  dhs_198_received_date      = (details ->> 'dhs_198_received_date')::date,
  authorization_start        = (details ->> 'authorization_start')::date,
  authorization_end          = (details ->> 'authorization_end')::date,
  approved_hours_per_period  = (details ->> 'approved_hours_per_period')::numeric,
  family_contribution_amount = (details ->> 'family_contribution_amount')::numeric,
  billing_basis              = nullif(details ->> 'billing_basis', ''),
  shared_provider_notes      = nullif(details ->> 'shared_provider_notes', ''),
  shared_with_other_provider = (details ->> 'shared_with_other_provider')::boolean,
  provider_pin_required      = (details ->> 'provider_pin_required')::boolean
where type = 'cdc_scholarship'
  and details is not null
  and archived_at is null;

-- dhs_198_issue_date is NOT backfilled — the audit confirmed it does
-- not exist in production details. New column lands NULL; providers
-- populate it via the rewired form. The CDC form treats
-- dhs_198_received_date as the default ("Date on the DHS-198 letter
-- (optional, defaults to received date if blank)").

-- -------------------------------------------------------
-- 4. Index for the most common PR #9 query
-- -------------------------------------------------------
-- "Find authorizations expiring in the next 30 days" — used by the
-- lifecycle countdown badge and PR #9's pay-period picker.
create index if not exists idx_funding_sources_cdc_active_by_end_date
  on public.funding_sources (authorization_end)
  where type = 'cdc_scholarship'
    and status = 'active'
    and archived_at is null;

-- -------------------------------------------------------
-- 5. Operational notes
-- -------------------------------------------------------
-- details JSON column is RETAINED (not dropped). Spec § "PR #8.5b
-- does NOT" — typed columns become the column-of-record for CDC
-- fields; JSON becomes secondary; legacy read paths fall back to JSON
-- when the typed column is null. After ~30 days of clean operation
-- (spec § Step 4), a future cleanup PR can drop the JSON fallback.

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Drops the typed columns. Note: PostgreSQL does NOT support removing
-- enum values, so 'pending' / 'expired' / 'terminated' / 'renewed' on
-- public.funding_source_status persist after rollback; rolling those
-- back requires a recreate-and-cast dance documented in
-- docs/pr-8-5b-review.md.
--
-- drop index if exists public.idx_funding_sources_cdc_active_by_end_date;
--
-- alter table public.funding_sources
--   drop column if exists renewed_to_id,
--   drop column if exists provider_pin_required,
--   drop column if exists shared_provider_notes,
--   drop column if exists shared_with_other_provider,
--   drop column if exists rate_tier_at_issue,
--   drop column if exists age_tier,
--   drop column if exists billing_basis,
--   drop column if exists family_contribution_amount,
--   drop column if exists approved_hours_per_period,
--   drop column if exists authorization_end,
--   drop column if exists authorization_start,
--   drop column if exists dhs_198_received_date,
--   drop column if exists dhs_198_issue_date,
--   drop column if exists case_number;
