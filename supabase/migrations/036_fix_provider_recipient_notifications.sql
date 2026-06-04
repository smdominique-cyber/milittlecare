-- ============================================================
-- MI Little Care — Phase Y1 fix-forward (round 3): provider-
-- recipient notification_log inserts populate recipient_email,
-- AND notification failures no longer void the compliance
-- evidence row.
--
-- ── BUG (the immediate one) ────────────────────────────────────
-- During the Phase Y1 live verification gate, a real authenticated
-- parent (Jeff, 7bac7213) called consent_esign_complete on a
-- valid pending row. Authorization passed; the acknowledgments
-- evidence row was prepared; the per-pending UPDATE was queued;
-- the reminder resolve was queued — and the final
-- provider-notification INSERT failed with PostgreSQL
-- error 23502:
--
--   null value in column "recipient_email" of relation
--   "notification_log" violates not-null constraint
--
-- That insert (migration 035 lines 423-444, carried forward from
-- migration 033 lines 825-845) writes
--   recipient_type   = 'provider'
--   recipient_id     = v_provider_id   -- populated
--   recipient_email  = NULL            -- the violation
--
-- Because the notification insert is in the same transaction as
-- the evidence write, the WHOLE completion rolled back. The
-- parent's signed evidence row was lost. The pending row stayed
-- un-resolved. Re-attempt produces the same outcome — the parent
-- is stuck.
--
-- ── BUG (the wrong inference behind it) ────────────────────────
-- Migration 034 inspected the failing notification insert in
-- consent_esign_send (recipient_id=NULL) and reasoned: "the
-- provider path was fine because migration 031's
-- child_parent_update writes recipient_type='provider' with
-- recipient_id=v_provider_id populated, and that's in production."
-- That sentence is in 034's header (lines 38-41) and was wrong
-- twice:
--   (a) Migration 031's child_parent_update writes
--       recipient_email=NULL too (031 lines 401, 424). It does
--       NOT "work in production" — it has NEVER been hit. No
--       parent has actually changed allergies or medical_notes
--       via the parent portal since 031 applied. The first call
--       that flips p_apply_allergies/p_apply_medical_notes to
--       true will fail with the same 23502 and roll the children
--       UPDATE back too.
--   (b) Inferring constraint state from "another migration writes
--       this shape and works" was the methodological mistake.
--       The live database is the source of truth. Constraint
--       state must be CONFIRMED, never inferred.
--
-- This migration acknowledges both errors and corrects the live
-- bug + the latent twin.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────
-- 1. CREATE OR REPLACE consent_esign_complete (uuid, text). Same
--    signature as migration 035's rewrite. Two behavioral changes:
--      (a) Resolve the provider's email via profiles.email (same
--          source api/notify-state-change.js uses at line 246-247)
--          and pass it into the notification_log row. If the
--          provider has no email on profile, SKIP the
--          notification insert — matches the
--          recipients.length === 0 silent-skip in
--          api/notify-state-change.js lines 282-289. The evidence
--          row still gets written; the provider just doesn't
--          receive an email. This is the correct behavior:
--          provider-discoverable email gap should not void the
--          parent's signature.
--      (b) Wrap the notification insert in a BEGIN ... EXCEPTION
--          WHEN OTHERS block. Any future surprise — another
--          column going NOT NULL, a check constraint added, a
--          column rename — produces a NOTICE-level log and a
--          metadata-tagged row on the acknowledgments record's
--          completion event in the form of a RAISE NOTICE only.
--          The evidence row IS the compliance artifact; a failed
--          provider email must not destroy it. (See
--          "Transactional recommendation" below.)
--
-- 2. CREATE OR REPLACE child_parent_update with the same two
--    behavioral changes applied to its two notification inserts
--    (allergies + medical_notes branches). Identical latent bug,
--    identical fix. The signature is unchanged; CREATE OR
--    REPLACE is safe — the existing 031 callers (parent portal
--    medical-update form) keep working with no client change.
--
-- 3. Explicit REVOKE EXECUTE ... FROM anon after each CREATE OR
--    REPLACE. Migrations 033, 034, 035 all re-added the default
--    anon EXECUTE grant on every CREATE OR REPLACE and Seth had
--    to revoke manually each time. This pattern is fixed here
--    by including the anon revoke in the committed migration.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────
-- - NO TABLE CHANGES. notification_log.recipient_email NOT NULL
--   is correct. The dispatcher pattern is: resolve recipients at
--   WRITE time, then INSERT with email populated (per
--   api/notify-state-change.js + api/cron-dispatch-reminders.js +
--   api/cron-send-acknowledgment-digest.js). The NOT NULL
--   constraint enforces this convention.
-- - NO change to consent_esign_send (already correct as of
--   migration 034: parent loop pre-filters pp.email IS NOT NULL
--   and uses pp.email as recipient_email — empty parents are
--   skipped at SELECT time, so the insert can't see a NULL).
-- - NO change to consent_esign_rescind (writes nothing to
--   notification_log).
-- - NO change to the WORM trigger / acknowledgments schema /
--   consent_templates / consents_pending_esign tables.
-- - NO UI.
--
-- ── TRANSACTIONAL RECOMMENDATION ───────────────────────────────
-- The user's question: should the provider-notification write be
-- inside the same transaction as the evidence write at all? Two
-- options:
--   (a) Keep transactional; make the insert correct. Simplest.
--       Failure modes: any future NOT NULL or CHECK addition on
--       notification_log silently re-introduces the same
--       evidence-rollback bug.
--   (b) Make notification failures non-fatal to the evidence
--       write. Robust against future column changes. The
--       parent's signature is the compliance artifact; a failed
--       provider notification (no email on profile, future
--       constraint mismatch, dispatcher-side schema drift)
--       should never void it.
--
-- RECOMMENDATION: BOTH, in defense-in-depth order. Option (a)
-- fixes the immediate bug. Option (b) hardens against the next
-- one. The cost of (b) is a savepoint per RPC call, which is
-- negligible. The cost of NOT having (b) is exactly the bug we
-- just discovered: a constraint we didn't know about voided the
-- evidence the entire feature exists to capture.
--
-- The EXCEPTION block applies ONLY to the notification insert
-- itself. All other failures (auth gate, pending-row state,
-- template-archive race, evidence insert) still abort the
-- transaction. That's correct: those are state failures the
-- parent needs to know about. The notification is a
-- communication side-effect.
--
-- ── DEPENDENCY ─────────────────────────────────────────────────
-- Applies AFTER migration 035.
--
-- ── EXPECTED VERIFICATION (run AFTER applying — Seth in the
--    Supabase web SQL Editor, save screenshot per the
--    CLAUDE.md verification-gap rule) ─────────────────────────
--
--   -- a) Confirm the REAL notification_log NOT NULL list. This
--   --    is the ground-truth audit the migration 034 inference
--   --    SHOULD have done. Save this output.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public'
--      and table_name='notification_log'
--    order by ordinal_position;
--   -- read off: every is_nullable='NO' row is a column the
--   -- writer must populate. Expected (per api/notify-state-
--   -- change.js and the live failures): recipient_type,
--   -- recipient_id, recipient_email, change_type at least.
--   -- Confirm there are no others the RPCs currently leave NULL.
--
--   -- b) Both RPCs exist with the right signatures.
--   select proname, pg_get_function_identity_arguments(oid) as args
--     from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname in ('consent_esign_complete','child_parent_update')
--    order by proname;
--   -- expect:
--   --   child_parent_update    | (13-arg form, unchanged)
--   --   consent_esign_complete | p_pending_id uuid,
--   --                            p_typed_signature_text text
--
--   -- c) Anon does NOT have EXECUTE on either RPC.
--   select grantee, privilege_type, routine_name
--     from information_schema.routine_privileges
--    where specific_schema='public'
--      and routine_name in ('consent_esign_complete','child_parent_update')
--    order by routine_name, grantee;
--   -- expect: 'authenticated' rows only. No 'anon' row, no
--   -- 'public' row.
--
-- ── LIVE GATE RETRY ────────────────────────────────────────────
-- Retry the failed completion that surfaced this bug:
--   As Jeff (real auth):
--     select public.consent_esign_complete(
--       '<the_pending_id_from_the_failed_call>'::uuid,
--       'Jeff Snayberger'   -- (or whatever typed text)
--     );
--   Expect:
--     - Returns a UUID (the new acknowledgments.id).
--     - acknowledgments row exists with
--         acknowledged_via='parent_portal_esign',
--         typed_signature_text='Jeff Snayberger',
--         template_snapshot_text = current template body.
--     - consents_pending_esign row resolved with
--         resolved_via='parent_completed',
--         resolved_acknowledgment_id = the ack id.
--     - notification_log row exists with
--         recipient_type='provider',
--         recipient_id     = Vanessa's user id,
--         recipient_email  = Vanessa's profiles.email
--                            (POPULATED — the fix).
--
-- Negative coverage:
--   - If Vanessa's profiles.email is NULL, the completion still
--     succeeds (evidence row + pending resolved); notification
--     row is silently skipped.
--   - If a future schema change introduces a new NOT NULL on
--     notification_log that the RPC doesn't populate, the
--     EXCEPTION block catches it, logs a NOTICE, and the
--     evidence row still survives.
-- ============================================================

-- -------------------------------------------------------
-- 1. consent_esign_complete — populate provider recipient_email
--    + EXCEPTION-wrap the notification insert
-- -------------------------------------------------------
create or replace function public.consent_esign_complete(
  p_pending_id            uuid,
  p_typed_signature_text  text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id          uuid := auth.uid();
  v_pending            public.consents_pending_esign;
  v_current_body       text;
  v_provider_id        uuid;
  v_provider_email     text;
  v_child_family_id    uuid;
  v_ack_id             uuid;
  v_occurrence_meta    jsonb;
begin
  -- 1. Input sanity.
  if p_pending_id is null then
    raise exception 'consent_esign_complete: p_pending_id is required';
  end if;
  if p_typed_signature_text is null
     or length(trim(p_typed_signature_text)) = 0 then
    raise exception 'consent_esign_complete: typed_signature_text is required';
  end if;
  if v_parent_id is null then
    raise exception 'consent_esign_complete: no authenticated caller';
  end if;

  -- 2. Look up the pending row regardless of resolved_at state so
  --    the resolved-row case below can produce a state-specific
  --    parent-readable message. FOR UPDATE locks for the
  --    transaction.
  select * into v_pending
    from public.consents_pending_esign
   where id = p_pending_id
   for update;
  if v_pending.id is null then
    raise exception 'consent_esign_complete: this consent request was not found'
      using errcode = 'P0001';
  end if;

  -- 3. State checks — parent-readable, situation-specific.
  if v_pending.archived_at is not null then
    raise exception 'consent_esign_complete: this consent request is no longer available'
      using errcode = 'P0001';
  end if;
  if v_pending.resolved_at is not null then
    if v_pending.resolved_via = 'parent_completed' then
      raise exception 'consent_esign_complete: this consent has already been signed'
        using errcode = 'P0001';
    elsif v_pending.resolved_via = 'provider_rescinded' then
      raise exception 'consent_esign_complete: your provider rescinded this consent request'
        using errcode = 'P0001';
    elsif v_pending.resolved_via = 'expired' then
      raise exception 'consent_esign_complete: this consent request expired before it was signed'
        using errcode = 'P0001';
    elsif v_pending.resolved_via = 'superseded_by_template_edit' then
      raise exception 'consent_esign_complete: your provider updated this consent. They will need to send you a new version to sign.'
        using errcode = 'P0001';
    else
      raise exception 'consent_esign_complete: this consent request is no longer pending'
        using errcode = 'P0001';
    end if;
  end if;

  -- 4. Authorization: parent must be linked to this child's family
  --    via an active parent_family_links row.
  select c.family_id, c.user_id
    into v_child_family_id, v_provider_id
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = v_pending.child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';
  if v_provider_id is null then
    raise exception 'consent_esign_complete: caller is not an active parent for this child'
      using errcode = '42501';
  end if;

  -- 5. Optional expiry check.
  if v_pending.expires_at is not null and v_pending.expires_at <= now() then
    update public.consents_pending_esign
       set resolved_at = now(),
           resolved_via = 'expired'
     where id = v_pending.id;
    raise exception 'consent_esign_complete: this consent request expired on %', v_pending.expires_at
      using errcode = 'P0001';
  end if;

  -- 6. Snapshot at completion — re-read CURRENT template body.
  --    Belt-and-suspenders fallback for the rare race window or
  --    trigger bypass: if the template lookup returns null, mark
  --    the pending superseded in this transaction and raise the
  --    same parent-readable message used by the supersede path.
  select body_text into v_current_body
    from public.consent_templates
   where id = v_pending.consent_template_id
     and archived_at is null;
  if v_current_body is null then
    update public.consents_pending_esign
       set resolved_at  = now(),
           resolved_via = 'superseded_by_template_edit'
     where id = v_pending.id
       and resolved_at is null;
    raise exception 'consent_esign_complete: your provider updated this consent. They will need to send you a new version to sign.'
      using errcode = 'P0001';
  end if;

  -- 7. Per-occurrence metadata for per-trip types.
  if v_pending.consent_type in (
    'transportation_nonroutine_per_trip',
    'water_activities_off_premises_per_trip'
  ) then
    v_occurrence_meta := v_pending.per_send_metadata;
  else
    v_occurrence_meta := null;
  end if;

  -- 8. Insert the evidence row. The shape CHECK
  --    (chk_acknowledgments_esign_shape) enforces signature +
  --    snapshot non-null; the WORM trigger blocks future UPDATEs.
  --    THIS row is the compliance artifact — everything after
  --    this point is a side-effect and must not be allowed to
  --    void this write.
  insert into public.acknowledgments (
    provider_id, type, subject_type, subject_id,
    acknowledged_by_user_id, acknowledged_by_label,
    acknowledged_via, acknowledged_at,
    provider_override_reason,
    snapshot_hash, snapshot_version,
    typed_signature_text, template_snapshot_text, consent_template_id,
    occurrence_metadata
  ) values (
    v_provider_id,
    v_pending.consent_type,
    'child',
    v_pending.child_id,
    v_parent_id,
    null,
    'parent_portal_esign',
    now(),
    null,
    null,                          -- snapshot_hash unused for esign rows
    'v1',
    p_typed_signature_text,
    v_current_body,                -- AUTHORITATIVE snapshot
    v_pending.consent_template_id,
    v_occurrence_meta
  )
  returning id into v_ack_id;

  -- 9. Mark the pending row resolved.
  update public.consents_pending_esign
     set resolved_at = now(),
         resolved_via = 'parent_completed',
         resolved_acknowledgment_id = v_ack_id
   where id = v_pending.id;

  -- 10. Resolve any open reminder_instances for this child's
  --     consent_esign_pending surface.
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_type = 'child'
     and ri.subject_id   = v_pending.child_id
     and ri.category     = 'consent_esign_pending'
     and ri.resolved_at  is null
     and ri.archived_at  is null;

  -- 11. Provider email lookup. profiles.email is the resolver
  --     established by api/notify-state-change.js line 246-247.
  --     SECURITY DEFINER context bypasses RLS so this read works
  --     for the parent caller.
  select email into v_provider_email
    from public.profiles
   where id = v_provider_id;

  -- 12. Provider-facing notification (DEFENSE IN DEPTH).
  --     - Skip the insert entirely if the provider has no email
  --       on profile. Matches api/notify-state-change.js
  --       lines 282-289 (recipients.length === 0 → silent skip).
  --     - Wrap the insert in EXCEPTION WHEN OTHERS so any future
  --       schema surprise on notification_log cannot void the
  --       evidence row from step 8. The parent's signature is
  --       the compliance artifact; a failed side-effect must
  --       not destroy it.
  if v_provider_email is not null
     and length(trim(v_provider_email)) > 0 then
    begin
      insert into public.notification_log (
        recipient_type, recipient_id, recipient_email,
        change_type, change_description,
        changed_by_user_id, changed_by_role,
        family_id, child_id,
        email_sent, email_sent_at, email_id,
        metadata
      ) values (
        'provider', v_provider_id, v_provider_email,
        'consent_esign_completed',
        'A parent signed a consent in the portal',
        v_parent_id, 'parent',
        v_child_family_id, v_pending.child_id,
        false, null, null,
        jsonb_build_object(
          'consent_type',         v_pending.consent_type,
          'acknowledgment_id',    v_ack_id,
          'consent_template_id',  v_pending.consent_template_id,
          'pending_esign_id',     v_pending.id
        )
      );
    exception when others then
      -- The evidence row in step 8 is already written. A failed
      -- provider notification is a side-effect, not a compliance
      -- failure. Surface the cause in Postgres logs but let the
      -- outer transaction commit so the parent's signature
      -- survives.
      raise notice 'consent_esign_complete: provider notification insert failed (sqlstate=%, message=%); evidence row % was preserved.',
        SQLSTATE, SQLERRM, v_ack_id;
    end;
  end if;

  return v_ack_id;
end;
$$;

revoke all  on function public.consent_esign_complete(uuid, text) from public;
revoke execute on function public.consent_esign_complete(uuid, text) from anon;
grant execute on function public.consent_esign_complete(uuid, text) to authenticated;

-- -------------------------------------------------------
-- 2. child_parent_update — same latent bug, same fix
-- -------------------------------------------------------
-- Migration 031's child_parent_update writes two provider-
-- recipient notification_log rows with recipient_email=NULL
-- (lines 401, 424). Same 23502-on-write pattern, undetected
-- because no parent has yet flipped p_apply_allergies or
-- p_apply_medical_notes through the parent portal.
--
-- Identical fix: populate recipient_email from profiles.email;
-- skip the insert when missing; EXCEPTION-wrap the insert so a
-- failed notification cannot void the children UPDATE.
--
-- Signature unchanged from 031.
create or replace function public.child_parent_update(
  p_child_id        uuid,
  p_allergies       text default null,
  p_medical_notes   text default null,
  p_physician_name  text default null,
  p_physician_phone text default null,
  p_dentist_name    text default null,
  p_dentist_phone   text default null,
  p_apply_allergies      boolean default false,
  p_apply_medical_notes  boolean default false,
  p_apply_physician_name boolean default false,
  p_apply_physician_phone boolean default false,
  p_apply_dentist_name   boolean default false,
  p_apply_dentist_phone  boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id        uuid := auth.uid();
  v_provider_id      uuid;
  v_provider_email   text;
  v_child_family_id  uuid;
  v_old_allergies    text;
  v_old_medical      text;
begin
  -- ── Input sanity ─────────────────────────────────────────────────
  if p_child_id is null then
    raise exception 'child_parent_update: p_child_id is required';
  end if;
  if v_parent_id is null then
    raise exception 'child_parent_update: no authenticated caller';
  end if;

  -- ── Authorization: caller is an active parent for this child ────
  select c.user_id, c.family_id, c.allergies, c.medical_notes
    into v_provider_id, v_child_family_id, v_old_allergies, v_old_medical
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = p_child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';

  if v_provider_id is null then
    raise exception 'child_parent_update: caller is not an active parent for this child, or child not found'
      using errcode = '42501';
  end if;

  -- ── Apply only the columns flagged by the p_apply_* booleans ────
  update public.children
     set
       allergies       = case when p_apply_allergies       then p_allergies       else allergies       end,
       medical_notes   = case when p_apply_medical_notes   then p_medical_notes   else medical_notes   end,
       physician_name  = case when p_apply_physician_name  then p_physician_name  else physician_name  end,
       physician_phone = case when p_apply_physician_phone then p_physician_phone else physician_phone end,
       dentist_name    = case when p_apply_dentist_name    then p_dentist_name    else dentist_name    end,
       dentist_phone   = case when p_apply_dentist_phone   then p_dentist_phone   else dentist_phone   end,
       updated_at      = now()
   where id = p_child_id;

  -- ── Provider email lookup (same pattern as consent_esign_complete) ─
  -- SECURITY DEFINER context bypasses RLS. If the provider has no
  -- email on profile, skip the notification inserts below (the
  -- children UPDATE has already committed in this transaction and
  -- survives regardless).
  select email into v_provider_email
    from public.profiles
   where id = v_provider_id;

  -- ── Care-critical notifications — populated recipient_email +
  -- EXCEPTION-wrapped per-insert ──────────────────────────────────
  -- Each insert is in its own BEGIN/EXCEPTION block. A failed
  -- notification (now or under future schema changes) must not
  -- void the children UPDATE that already happened above. The
  -- children row IS the source of truth; the notification is a
  -- side-effect for the provider's awareness.
  if v_provider_email is not null
     and length(trim(v_provider_email)) > 0
     and p_apply_allergies
     and (p_allergies is distinct from v_old_allergies) then
    begin
      insert into public.notification_log (
        recipient_type, recipient_id, recipient_email,
        change_type, change_description,
        changed_by_user_id, changed_by_role,
        family_id, child_id,
        email_sent, email_sent_at, email_id,
        metadata
      ) values (
        'provider', v_provider_id, v_provider_email,
        'child_allergies_updated_by_parent',
        'Allergy info updated by parent',
        v_parent_id, 'parent',
        v_child_family_id, p_child_id,
        false, null, null,
        jsonb_build_object(
          'previous_value', v_old_allergies,
          'new_value',      p_allergies
        )
      );
    exception when others then
      raise notice 'child_parent_update: allergy notification insert failed (sqlstate=%, message=%); child % update was preserved.',
        SQLSTATE, SQLERRM, p_child_id;
    end;
  end if;

  if v_provider_email is not null
     and length(trim(v_provider_email)) > 0
     and p_apply_medical_notes
     and (p_medical_notes is distinct from v_old_medical) then
    begin
      insert into public.notification_log (
        recipient_type, recipient_id, recipient_email,
        change_type, change_description,
        changed_by_user_id, changed_by_role,
        family_id, child_id,
        email_sent, email_sent_at, email_id,
        metadata
      ) values (
        'provider', v_provider_id, v_provider_email,
        'child_medical_notes_updated_by_parent',
        'Medical notes updated by parent',
        v_parent_id, 'parent',
        v_child_family_id, p_child_id,
        false, null, null,
        jsonb_build_object(
          'previous_value', v_old_medical,
          'new_value',      p_medical_notes
        )
      );
    exception when others then
      raise notice 'child_parent_update: medical notes notification insert failed (sqlstate=%, message=%); child % update was preserved.',
        SQLSTATE, SQLERRM, p_child_id;
    end;
  end if;

  return true;
end;
$$;

revoke all  on function public.child_parent_update(
  uuid, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) from public;
revoke execute on function public.child_parent_update(
  uuid, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) from anon;
grant execute on function public.child_parent_update(
  uuid, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- WARNING: rolling back this migration restores the broken
-- recipient_email=NULL inserts. A consent_esign_complete call
-- after rollback will fail with 23502 again and the parent's
-- signature will be lost. Don't roll back unless you're also
-- rolling back to before the live e-sign rollout started.
--
-- Down for child_parent_update — restore migration 031's body
-- with recipient_email=NULL on both inserts. (Body omitted; see
-- migration 031 lines 299-448 for the original.)
--
-- Down for consent_esign_complete — restore migration 035's
-- body with recipient_email=NULL on the provider notification.
-- (Body omitted; see migration 035 lines 247-451 for the
-- original.)
