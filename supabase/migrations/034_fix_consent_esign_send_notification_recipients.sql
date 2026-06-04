-- ============================================================
-- MI Little Care — Phase Y1 fix-forward: consent_esign_send
-- notification recipients
--
-- Bug surfaced during the Phase Y1 live verification gate:
-- consent_esign_send (migration 033) fails the WHOLE transaction
-- with PostgreSQL error 23502 — null value in column
-- "recipient_id" of relation "notification_log" violates not-null
-- constraint. Because the pending-row insert + the notification
-- insert are one transaction, the pending row is rolled back too
-- (which is why consents_pending_esign had 0 rows after the live
-- gate's step-3 call).
--
-- Root cause: the 033 RPC wrote ONE notification_log row with
-- recipient_type='parent', recipient_id=NULL,
-- recipient_email=NULL — intending the existing dispatcher to
-- resolve the parent identity at send time. That mental model is
-- wrong: the dispatcher reads notification_log rows that are
-- ALREADY recipient-resolved. The recipient resolution happens at
-- WRITE time, not at send time. notification_log.recipient_id is
-- NOT NULL in production.
--
-- The established pattern (verified against the existing
-- recipient resolvers + their parent paths):
--   - api/cron-dispatch-reminders.js lines 269-299 — the
--     'parent_via_subject_child' resolver loops over
--     parent_family_links + parent_profiles for the child's
--     family and emits ONE recipient per active linked parent
--     with email AND acknowledgment_email_opt_in != false,
--     de-duped by parent_id.
--   - api/notify-state-change.js lines 271-278 — same loop on
--     the JS write path.
--   - api/cron-send-acknowledgment-digest.js line 312 — also
--     one row per parent with recipient_id=parent.id +
--     recipient_email=parent.email.
--
-- Migration 031's child_parent_update RPC writes a
-- recipient_type='provider' row with recipient_id=v_provider_id
-- (populated) — so the provider path was fine. The bug is
-- specific to the parent-recipient pattern, where 033 set the
-- id to NULL.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────
-- CREATE OR REPLACE consent_esign_send. Replaces the broken
-- single-row notification with a loop over active linked parents
-- per the established pattern: one notification_log row per
-- parent with parent_profiles.id + parent_profiles.email
-- populated, skipping parents with no email or with
-- acknowledgment_email_opt_in = false.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────
-- - NO table changes. The notification_log.recipient_id NOT NULL
--   constraint is correct and stays.
-- - NO change to consent_esign_complete (writes recipient_id =
--   v_provider_id, populated — verified against 033 line 833;
--   matches the provider-recipient pattern from migration 031's
--   child_parent_update which is in production and works).
-- - NO change to consent_esign_rescind (doesn't write to
--   notification_log at all).
-- - NO change to any other RPC.
--
-- ── EDGE CASE — child with zero eligible parents ───────────────
-- If the child has no linked parents OR all linked parents have
-- empty emails OR all have acknowledgment_email_opt_in=false,
-- the loop writes ZERO notification_log rows. The pending row
-- is STILL inserted — the consent waits in the queue for the
-- parent to find it on their own when they log in. This matches
-- the dispatcher's behavior in the no_recipient case (it also
-- attempts a no_recipient log but tolerates the failure
-- silently in api/cron-dispatch-reminders.js line 443+).
--
-- Notable trade-off: the dispatcher writes a "log the gap" row
-- with recipient_id=null when no recipients exist. That insert
-- ITSELF fails silently against the NOT NULL constraint — the
-- dispatcher swallows the error because supabasePost doesn't
-- throw on non-2xx. We can't afford the silent swallow in a
-- transactional RPC, so we just skip the notification_log
-- write in that case. The pending row carries the state of
-- record either way.
--
-- DEPENDENCY: applies AFTER migration 033.
--
-- ── EXPECTED VERIFICATION (run AFTER applying) ─────────────────
--
--   -- a) The function exists (CREATE OR REPLACE in place):
--   select proname, prosrc like '%for v_parent_row in%' as is_fixed
--     from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname='consent_esign_send';
--   -- expect: one row, is_fixed=true.
--
--   -- b) EXECUTE still granted to authenticated only:
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where specific_schema='public'
--      and routine_name='consent_esign_send'
--    order by grantee;
--   -- expect: authenticated / EXECUTE; no public row.
--
-- ── LIVE GATE RETRY (continue from step 3 of the 8-step gate) ──
-- After applying 034, retry step 3:
--   As Vanessa (or 35a6d4dd in the test scenario):
--     select public.consent_esign_send(
--       '<aleshia_child_id>'::uuid,
--       'field_trip_permission',
--       null, null
--     );
--   Expect: returns a UUID (the new pending_esign_id).
--
-- Then verify (admin):
--   - consents_pending_esign has exactly one row for this
--     (provider, child, consent_type) with resolved_at=null.
--   - notification_log has one row per active linked parent of
--     the child's family, each with:
--       recipient_type='parent'
--       recipient_id   = <parent's user_id>      (POPULATED)
--       recipient_email = <parent's email>       (POPULATED)
--       change_type    = 'consent_esign_send'
--       family_id      = the child's family
--       child_id       = the child
--       metadata->>'pending_esign_id' = the returned UUID
--
-- Then proceed with steps 4-8 of the live gate.
-- ============================================================

create or replace function public.consent_esign_send(
  p_child_id           uuid,
  p_consent_type       text,
  p_per_send_metadata  jsonb default null,
  p_expires_at         timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id      uuid := auth.uid();
  v_child_user_id    uuid;
  v_child_family_id  uuid;
  v_enabled          boolean;
  v_active_template  uuid;
  v_active_body      text;
  v_pending_id       uuid;
  v_parent_row       record;
begin
  if p_child_id is null then
    raise exception 'consent_esign_send: p_child_id is required';
  end if;
  if p_consent_type is null or p_consent_type not in (
    'field_trip_permission',
    'transportation_routine_annual',
    'transportation_nonroutine_per_trip',
    'water_activities_on_premises_seasonal',
    'water_activities_off_premises_per_trip'
  ) then
    raise exception 'consent_esign_send: invalid p_consent_type';
  end if;
  if v_provider_id is null then
    raise exception 'consent_esign_send: no authenticated caller';
  end if;

  -- Authorization: caller owns the child.
  select c.user_id, c.family_id
    into v_child_user_id, v_child_family_id
    from public.children c
   where c.id = p_child_id
     and c.archived_at is null;
  if v_child_user_id is null then
    raise exception 'consent_esign_send: child not found or archived';
  end if;
  if v_child_user_id <> v_provider_id then
    raise exception 'consent_esign_send: caller is not the provider for this child'
      using errcode = '42501';
  end if;

  -- Category enable gate (server-authoritative).
  select (medium_risk_consents_enabled ->> p_consent_type)::boolean
    into v_enabled
    from public.profiles
   where id = v_provider_id;
  if not coalesce(v_enabled, false) then
    raise exception 'consent_esign_send: category % is not enabled for this provider', p_consent_type
      using errcode = '42501';
  end if;

  -- Active template lookup.
  select id, body_text
    into v_active_template, v_active_body
    from public.consent_templates
   where provider_id = v_provider_id
     and consent_type = p_consent_type
     and archived_at is null
     and enabled = true
   order by created_at desc
   limit 1;
  if v_active_template is null then
    raise exception 'consent_esign_send: no active template for consent_type %', p_consent_type;
  end if;

  -- Per-occurrence metadata required for per-trip types.
  if p_consent_type in ('transportation_nonroutine_per_trip', 'water_activities_off_premises_per_trip') then
    if p_per_send_metadata is null
       or p_per_send_metadata ->> 'event_date'  is null
       or p_per_send_metadata ->> 'description' is null
    then
      raise exception 'consent_esign_send: per-occurrence types require per_send_metadata with event_date + description';
    end if;
  end if;

  -- Insert the pending row.
  insert into public.consents_pending_esign (
    provider_id, child_id, consent_type, consent_template_id,
    template_body_at_send, per_send_metadata,
    sent_at, expires_at
  ) values (
    v_provider_id, p_child_id, p_consent_type, v_active_template,
    v_active_body, p_per_send_metadata,
    now(), p_expires_at
  )
  returning id into v_pending_id;

  -- ── 2026-06-04 fix-forward (migration 034) ──────────────────
  -- Notification log per eligible parent. Mirrors the established
  -- 'parent_via_subject_child' recipient pattern from
  -- api/cron-dispatch-reminders.js + api/notify-state-change.js +
  -- api/cron-send-acknowledgment-digest.js:
  --
  --   - One row per active parent_family_links row.
  --   - Skip parents with no parent_profiles.email.
  --   - Skip parents with acknowledgment_email_opt_in = false.
  --   - De-dup by parent_id (DISTINCT in the SELECT).
  --
  -- The recipient_id is the parent's auth user id; recipient_email
  -- is their parent_profiles.email. notification_log.recipient_id
  -- is NOT NULL in production — the original 033 RPC's
  -- recipient_id=null insert was the bug that rolled the whole
  -- transaction back.
  --
  -- If zero parents are eligible, the loop writes zero
  -- notification_log rows. The pending row is the state of record;
  -- the consent waits in the queue for the parent to find it on
  -- their own when they log in.
  for v_parent_row in
    select distinct pp.id as parent_id, pp.email as parent_email
      from public.parent_family_links pfl
      join public.parent_profiles pp on pp.id = pfl.parent_id
     where pfl.family_id = v_child_family_id
       and pfl.status    = 'active'
       and pp.email is not null
       and coalesce(pp.acknowledgment_email_opt_in, true) = true
  loop
    insert into public.notification_log (
      recipient_type, recipient_id, recipient_email,
      change_type, change_description,
      changed_by_user_id, changed_by_role,
      family_id, child_id,
      email_sent, email_sent_at, email_id,
      metadata
    ) values (
      'parent', v_parent_row.parent_id, v_parent_row.parent_email,
      'consent_esign_send',
      'A consent is awaiting your signature in the portal',
      v_provider_id, 'provider',
      v_child_family_id, p_child_id,
      false, null, null,
      jsonb_build_object(
        'consent_type',         p_consent_type,
        'pending_esign_id',     v_pending_id,
        'consent_template_id',  v_active_template,
        'per_send_metadata',    p_per_send_metadata,
        'cta_path',             '/parent/acknowledge?tab=todo&pending=' || v_pending_id::text
      )
    );
  end loop;

  return v_pending_id;
end;
$$;

revoke all  on function public.consent_esign_send(uuid, text, jsonb, timestamptz) from public;
grant execute on function public.consent_esign_send(uuid, text, jsonb, timestamptz) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- A rollback would require restoring 033's broken function body.
-- Don't do that — 033's body fails the live gate. If you must
-- roll back, also roll back 033 (per its own down migration,
-- subject to the "no production e-sign rows exist" pre-flight).
