-- ============================================================
-- MI Little Care — Phase 6: Backfill private_pay funding sources
--
-- For every family with enrollment_status='active', insert exactly one
-- funding_sources row of type='private_pay' attached at family_id.
--
-- Decisions baked in (see decision.txt + chat 2026-05-13):
--   - Per-family, NOT per-child. Rates live on families today; children
--     inherit private-pay coverage via family_id lookup.
--   - Families with no rate set get details.needs_rate_review=true plus
--     a notes string flagging for follow-up. Status stays 'active' so
--     they surface in the new Funding tab.
--   - Missing start_date falls back to families.created_at::date, then
--     current_date.
--   - All billing-related family columns are copied into details so no
--     data is lost (dual-rate, billing schedule, late fees, etc.).
--   - Idempotent: skips families that already have any non-archived
--     private_pay funding source (NOT EXISTS guard).
--   - Marker: every row carries details.backfilled_by='006' so the
--     rollback DELETE in the DOWN section is precisely scoped.
--
-- Wrapped in a single transaction. Any error during INSERT aborts the
-- whole thing (PostgreSQL auto-rollback) — no partial state.
--
-- ⚠ ROLLBACK WARNING ⚠
-- The DOWN section deletes rows by marker. Re-running the UP migration
-- after a rollback creates new funding_sources rows with brand-new UUIDs.
-- Once migration 005 ships and invoice_items.funding_source_id starts
-- being populated, any rollback-then-replay sequence will orphan
-- invoice_items references created between the two runs. If you need to
-- roll back AFTER 005 is in use, you must also null out
-- invoice_items.funding_source_id for the affected rows before re-running
-- this migration. See docs/tech_debt.md for the migration-marker pattern.
-- ============================================================

begin;

with backfill_targets as (
  select
    f.id        as family_id,
    f.user_id,
    coalesce(f.start_date, f.created_at::date, current_date)
                as effective_start_date,
    f.weekly_rate,
    f.hourly_rate,
    f.billing_type,
    f.billing_frequency,
    f.billing_frequency_weeks,
    f.billing_cycle_start_day,
    f.billing_cycle_end_day,
    f.billing_cycle_anchor_date,
    f.billing_monthly_mode,
    f.billing_partial_week_mode,
    f.late_fee_amount,
    f.late_fee_after_days,
    (f.weekly_rate is null and f.hourly_rate is null) as no_rate
  from public.families f
  where f.enrollment_status = 'active'
    and not exists (
      select 1
        from public.funding_sources fs
       where fs.family_id = f.id
         and fs.type = 'private_pay'
         and fs.archived_at is null
    )
),
inserted as (
  insert into public.funding_sources (
    user_id,
    family_id,
    type,
    status,
    start_date,
    priority,
    notes,
    details
  )
  select
    bt.user_id,
    bt.family_id,
    'private_pay'::public.funding_source_type,
    'active'::public.funding_source_status,
    bt.effective_start_date,
    99,
    case
      when bt.no_rate
        then 'Backfilled with no rate set on family at backfill time. Review and update before invoicing.'
      else null
    end,
    jsonb_build_object(
      'backfilled_by',             '006',
      'needs_rate_review',         bt.no_rate,
      'weekly_rate',               bt.weekly_rate,
      'hourly_rate',               bt.hourly_rate,
      'billing_type',              bt.billing_type,
      'billing_frequency',         bt.billing_frequency,
      'billing_frequency_weeks',   bt.billing_frequency_weeks,
      'billing_cycle_start_day',   bt.billing_cycle_start_day,
      'billing_cycle_end_day',     bt.billing_cycle_end_day,
      'billing_cycle_anchor_date', bt.billing_cycle_anchor_date,
      'billing_monthly_mode',      bt.billing_monthly_mode,
      'billing_partial_week_mode', bt.billing_partial_week_mode,
      'late_fee_amount',           bt.late_fee_amount,
      'late_fee_after_days',       bt.late_fee_after_days
    )
  from backfill_targets bt
  returning
    id,
    (details->>'needs_rate_review')::boolean as needs_rate_review
)
select
  count(*)                                       as total_funding_sources_created,
  count(*) filter (where needs_rate_review)      as needs_rate_review_count,
  count(*) filter (where not needs_rate_review)  as ok_count
from inserted;

commit;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Scoped strictly to rows created by this migration via the
-- details.backfilled_by marker. Safe to re-run.
-- begin;
-- delete from public.funding_sources
--  where type = 'private_pay'
--    and details->>'backfilled_by' = '006';
-- commit;
