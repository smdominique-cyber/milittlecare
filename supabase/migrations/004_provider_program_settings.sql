-- ============================================================
-- MI Little Care — Phase 4: Provider program settings + Michigan fields
--
-- Adds the columns required by the module activation system to profiles.
-- See docs/funding_source_spec.md section 4.
--
-- program_settings is a JSONB column with one key per gateable module:
--   - cdc, tri_share, gsrp:        'auto' | 'force_on' | 'force_off'
--   - cacfp:                       boolean (provider-level, not kid-driven)
--   - license_exempt_compliance:   boolean | null (set on onboarding)
--   - licensed_compliance:         boolean | null (set on onboarding)
--
-- profiles.role already exists in production with default 'licensee' and
-- is intentionally NOT modified by this migration (see decision.txt).
--
-- All columns are NULL-safe / default-safe so this migration is
-- non-destructive against existing profiles rows.
-- ============================================================

alter table public.profiles
  add column if not exists program_settings jsonb not null default jsonb_build_object(
    'cdc',                       'auto',
    'tri_share',                 'auto',
    'gsrp',                      'auto',
    'cacfp',                     false,
    'license_exempt_compliance', null,
    'licensed_compliance',       null
  ),
  add column if not exists michigan_license_number          text,
  add column if not exists michigan_provider_id             text,
  add column if not exists miregistry_id                    text,
  add column if not exists great_start_star_rating          integer,
  add column if not exists is_license_exempt                boolean,
  add column if not exists annual_training_completion_date  date;

-- Great Start star rating is published on a 0–5 scale.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_star_rating_range'
  ) then
    alter table public.profiles
      add constraint profiles_star_rating_range check (
        great_start_star_rating is null
        or (great_start_star_rating between 0 and 5)
      );
  end if;
end$$;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- alter table public.profiles
--   drop constraint if exists profiles_star_rating_range;
-- alter table public.profiles
--   drop column if exists annual_training_completion_date,
--   drop column if exists is_license_exempt,
--   drop column if exists great_start_star_rating,
--   drop column if exists miregistry_id,
--   drop column if exists michigan_provider_id,
--   drop column if exists michigan_license_number,
--   drop column if exists program_settings;
