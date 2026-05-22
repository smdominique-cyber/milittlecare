-- ============================================================
-- MI Little Care — PR #8.5c: Provider CDC billing settings
--                       + PR #12 parent-acknowledgment provider settings
--
-- Discovery handoff (2026-05-20):
--   - profiles has 28 columns today; under the ~30 threshold so this
--     migration extends profiles rather than creating a new
--     provider_cdc_settings table.
--   - Three originally-proposed columns from the PR #8.5c spec are
--     dropped here because they overlap with existing columns:
--       * annual_ongoing_training_completed_date → reuse existing
--         annual_training_completion_date (added by migration 004).
--       * rate_tier → reuse existing miregistry_current_level (added by
--         migration 009; 'level_1' / 'level_2').
--       * michigan_provider_id stays as the LICENSED-provider ID;
--         bridges_provider_id is the LEP/Bridges ID — distinct concepts,
--         both legitimately exist.
--
-- PR #12 ack-settings folded in per discovery recommendation: all
-- provider-level setting additions in one migration. PR #12's migration
-- 020 now only handles the three acknowledgment tables and the
-- parent_profiles opt-in column — no longer touches profiles.
--
-- Total new columns added here: 10 (4 CDC billing + 6 ack-settings).
-- All additive, IF NOT EXISTS, no data migration needed.
-- ============================================================

-- -------------------------------------------------------
-- 1. CDC billing settings — 4 new columns
-- -------------------------------------------------------
alter table public.profiles
  add column if not exists bridges_provider_id text,
  add column if not exists provider_type text,
  add column if not exists care_location text,
  add column if not exists fingerprint_date date;

-- Format constraint on bridges_provider_id: 7-digit string per MDHHS
-- DHS-4481-D form. NULL is permitted (provider hasn't entered it yet).
alter table public.profiles
  drop constraint if exists chk_bridges_provider_id_format;
alter table public.profiles
  add constraint chk_bridges_provider_id_format
  check (bridges_provider_id is null or bridges_provider_id ~ '^\d{7}$');

-- Provider-type enum check.
alter table public.profiles
  drop constraint if exists chk_provider_type;
alter table public.profiles
  add constraint chk_provider_type
  check (provider_type is null or provider_type in
    ('lep_related', 'lep_unrelated', 'licensed_family', 'licensed_group', 'licensed_center'));

-- Care-location enum check.
alter table public.profiles
  drop constraint if exists chk_care_location;
alter table public.profiles
  add constraint chk_care_location
  check (care_location is null or care_location in
    ('provider_home', 'child_home', 'facility_address'));

-- -------------------------------------------------------
-- 2. Parent-acknowledgment settings — 6 new columns
-- -------------------------------------------------------
-- Folded in from the PR #12 addendum § 6.3 per discovery doc's
-- "fold into 018" recommendation. Drives the Vercel-cron digest
-- scheduling and PR #9 Rule 8's strictness gate.
alter table public.profiles
  add column if not exists acknowledgment_cadence text
    default 'weekly'
    check (acknowledgment_cadence in ('weekly', 'daily')),
  add column if not exists acknowledgment_strictness text
    default 'warning'
    check (acknowledgment_strictness in ('warning', 'strict')),
  add column if not exists acknowledgment_email_enabled boolean
    default true,
  add column if not exists acknowledgment_email_send_day integer
    default 5
    check (acknowledgment_email_send_day between 0 and 6),
  add column if not exists acknowledgment_email_send_hour integer
    default 17
    check (acknowledgment_email_send_hour between 0 and 23),
  add column if not exists acknowledgment_email_timezone text
    default 'America/Detroit';

-- -------------------------------------------------------
-- 3. Column comments
-- -------------------------------------------------------
comment on column public.profiles.bridges_provider_id is
  '7-digit MDHHS Bridges Provider ID from the DHS-4481-D Confirmation '
  'form. Distinct from michigan_provider_id (licensed-provider ID) and '
  'miregistry_id (training-system ID).';

comment on column public.profiles.provider_type is
  'CDC provider classification: lep_related / lep_unrelated / '
  'licensed_family / licensed_group / licensed_center. Drives the '
  'fingerprint reprint check (LEP-unrelated only) and a few other '
  'compliance gates.';

comment on column public.profiles.care_location is
  'Where care is provided: provider_home / child_home / facility_address. '
  'Constrained by provider_type at the UI level (LEP-related can be '
  'home or child_home; LEP-unrelated must be child_home; Licensed must '
  'be facility_address).';

comment on column public.profiles.fingerprint_date is
  'Most recent fingerprint background-check submission date. Used by '
  'cdcProviderCompliance.getFingerprintReprintState for the >4.5yr '
  'reminder / >5yr urgent banner. LEP-unrelated providers only.';

comment on column public.profiles.acknowledgment_cadence is
  'PR #12 parent-acknowledgment email cadence: weekly (default) or daily.';

comment on column public.profiles.acknowledgment_strictness is
  'PR #12 parent-acknowledgment strictness: warning (default; PR #9 '
  'Rule 8 surfaces but allows export) or strict (Rule 8 blocks export).';

comment on column public.profiles.acknowledgment_email_send_day is
  '0 = Sunday … 6 = Saturday. Default 5 (Friday). Only meaningful '
  'when acknowledgment_cadence = ''weekly''.';

comment on column public.profiles.acknowledgment_email_send_hour is
  '24h, in the provider''s local time identified by '
  'acknowledgment_email_timezone. Default 17 (5 PM).';

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.profiles
--   drop column if exists acknowledgment_email_timezone,
--   drop column if exists acknowledgment_email_send_hour,
--   drop column if exists acknowledgment_email_send_day,
--   drop column if exists acknowledgment_email_enabled,
--   drop column if exists acknowledgment_strictness,
--   drop column if exists acknowledgment_cadence,
--   drop column if exists fingerprint_date,
--   drop column if exists care_location,
--   drop column if exists provider_type,
--   drop column if exists bridges_provider_id;
--
-- alter table public.profiles
--   drop constraint if exists chk_care_location,
--   drop constraint if exists chk_provider_type,
--   drop constraint if exists chk_bridges_provider_id_format;
