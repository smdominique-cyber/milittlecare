-- ============================================================
-- MI Little Care — Phase Y1 fix-forward: template-edit invalidates
-- in-flight e-sign consents (Option A)
--
-- Bug surfaced during the Phase Y1 live verification gate (step 4
-- onward). Migration 033's consent_esign_complete had two layered
-- template-state guards:
--
--   (1) SELECT body_text WHERE id = pending.consent_template_id
--                          AND archived_at IS NULL.
--       If null → raise 'source template has been archived'.
--   (2) IF v_current_body IS DISTINCT FROM p_claimed_body_text →
--       raise 'template_changed_since_send'.
--
-- The stale-read branch (2) assumed an in-place UPDATE edit
-- semantic. The actual template-edit protocol (per migration 033
-- spec §6c) is ARCHIVE-THEN-INSERT: every edit archives the old
-- row and inserts a new one. Guard (1) ALWAYS FIRES before guard
-- (2) can be reached. The stale-read branch + the
-- p_claimed_body_text parameter are unreachable dead code.
--
-- Secondary defect: after an edit, the pending row's
-- consent_template_id points at the now-archived template. Parent
-- hits guard (1) on every complete attempt; the pending stays in
-- the queue forever, un-completable.
--
-- ── Option A (Seth-confirmed) ──────────────────────────────────
-- An edited template invalidates any in-flight pending consent.
-- The parent cannot sign a freshly-changed document. The provider
-- resends with the new template. This is the safe, unambiguous
-- behavior for compliance evidence — no signing a document the
-- provider just amended.
--
-- ── What this migration does ───────────────────────────────────
-- 1. Expand the `chk_consents_pending_esign_resolved_via` CHECK
--    to allow a fourth value: 'superseded_by_template_edit'.
-- 2. Create `supersede_pendings_on_template_archive` AFTER UPDATE
--    trigger on `consent_templates`. Fires only on the
--    archived_at NULL→non-NULL transition (the archive step of
--    the archive-then-insert edit protocol). Other UPDATEs
--    (e.g., toggling `enabled`) do not invalidate pendings —
--    only the body_text changes do, and those happen via
--    archive-then-insert. Atomically:
--      - Marks active pendings for the same
--        (provider_id, consent_type) as resolved_via=
--        'superseded_by_template_edit'.
--      - Resolves the corresponding reminder_instances
--        (category='consent_esign_pending').
--    Same transaction as the template archive; rollback unwinds
--    both together.
-- 3. DROP the old `consent_esign_complete(uuid, text, text)`
--    signature. CREATE the new
--    `consent_esign_complete(uuid, text)` signature with:
--      - State-aware messaging. Look up the pending row
--        regardless of state, branch on resolved_via, raise a
--        parent-readable, situation-specific message for each.
--      - Dead stale-read branch removed.
--        p_claimed_body_text parameter gone.
--      - Belt-and-suspenders race-window fallback: if the
--        template lookup returns null even though the pending
--        wasn't superseded (the trigger missed somehow, e.g.,
--        admin DELETE bypassing the trigger), mark the pending
--        superseded in this transaction and raise the same
--        parent-readable message.
--      - Snapshot-at-completion happy path: clean
--        send → no edit → complete still snapshots the current
--        body_text onto the acknowledgments row (the core
--        compliance property is unchanged).
--
-- ── What this migration does NOT do ────────────────────────────
-- - No table data changes. No row mutations beyond what the
--   trigger does on future template archives.
-- - No change to consent_esign_send or consent_esign_rescind.
-- - No change to the WORM trigger / acknowledgments schema /
--   consent_templates / consents_pending_esign tables.
-- - No UI. Y2 still owns the template editor + parent
--   completion UI.
--
-- ── Signature change — safety check ────────────────────────────
-- Y1 ships with no UI; the only callers of
-- `consent_esign_complete` are manual devtools / SQL Editor
-- invocations during the live gate. Nothing in the app or test
-- suite calls it. DROP + CREATE with the new signature is safe.
-- If a future caller is added, it MUST use the new 2-argument
-- signature; the old 3-argument form will not exist after this
-- migration.
--
-- DEPENDENCY: applies AFTER migration 034.
--
-- ── EXPECTED VERIFICATION (run AFTER applying) ─────────────────
--
--   -- a) Expanded CHECK constraint includes the new value.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname='chk_consents_pending_esign_resolved_via';
--   -- expect: one row, CHECK text includes 'superseded_by_template_edit'.
--
--   -- b) Trigger function + trigger attached.
--   select tgname, tgrelid::regclass
--     from pg_trigger
--    where tgname='supersede_pendings_on_template_archive_trg';
--   -- expect: one row, tgrelid='public.consent_templates'.
--
--   -- c) Old (uuid, text, text) signature is gone.
--   select proname, pg_get_function_identity_arguments(oid) as args
--     from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname='consent_esign_complete';
--   -- expect: ONE row, args='p_pending_id uuid, p_typed_signature_text text'
--   --   (NOT the 3-arg form).
--
--   -- d) EXECUTE permissions on the new signature.
--   select grantee, privilege_type
--     from information_schema.routine_privileges
--    where specific_schema='public'
--      and routine_name='consent_esign_complete'
--    order by grantee;
--   -- expect: authenticated / EXECUTE; no 'public' row.
--
-- ── LIVE GATE RETRY (continue from step 4) ─────────────────────
--   Step 4: provider edits the template body via archive-then-
--           insert. After the archive UPDATE, verify the prior
--           pending row was supersede-resolved:
--             select id, resolved_at, resolved_via
--               from consents_pending_esign
--              where id = '<pending_from_step_3>';
--             -- expect: resolved_at NOT NULL,
--             --   resolved_via='superseded_by_template_edit'.
--
--   Step 5: provider sends a FRESH pending via consent_esign_send
--           (new pending_id). Parent calls
--           consent_esign_complete(<new_pending_id>, '<name>') —
--           2 args, not 3. Expect success: returns the new
--           acknowledgments id; row has the new template's
--           body verbatim in template_snapshot_text.
--
--   Step 5a — supersede error path. Parent attempts
--             consent_esign_complete on the OLD (superseded)
--             pending_id. Expect P0001 with the parent-readable
--             "your provider updated this consent" message. No
--             acknowledgments row written.
--
--   Steps 6-8 + invariants — unchanged from the migration 034
--   spec. Re-run end-to-end to confirm no regression.
-- ============================================================

-- -------------------------------------------------------
-- 1. Expand the resolved_via CHECK
-- -------------------------------------------------------
alter table public.consents_pending_esign
  drop constraint if exists chk_consents_pending_esign_resolved_via;

alter table public.consents_pending_esign
  add constraint chk_consents_pending_esign_resolved_via
  check (
    resolved_via is null
    or resolved_via in (
      'parent_completed',
      'provider_rescinded',
      'expired',
      'superseded_by_template_edit'
    )
  );

-- -------------------------------------------------------
-- 2. supersede_pendings_on_template_archive — trigger function
--    + trigger on consent_templates
-- -------------------------------------------------------
create or replace function public.supersede_pendings_on_template_archive()
returns trigger
language plpgsql
as $$
begin
  -- Fire only on the archive transition (archived_at:
  -- NULL → NOT NULL). This is the archive step of the
  -- archive-then-insert edit protocol. Other UPDATEs (e.g.,
  -- toggling `enabled`, label/title changes that don't archive)
  -- do not invalidate pendings — their body_text is unchanged.
  if TG_OP <> 'UPDATE' then return NEW; end if;
  if OLD.archived_at is not null then return NEW; end if;
  if NEW.archived_at is null then return NEW; end if;

  -- Supersede active pendings for the same (provider, consent_type)
  -- AND resolve their consent_esign_pending reminder_instances in
  -- one CTE-driven statement. Single statement = atomic with the
  -- outer template-archive UPDATE.
  with superseded as (
    update public.consents_pending_esign
       set resolved_at  = now(),
           resolved_via = 'superseded_by_template_edit'
     where provider_id  = NEW.provider_id
       and consent_type = NEW.consent_type
       and resolved_at  is null
       and archived_at  is null
     returning child_id
  )
  update public.reminder_instances
     set resolved_at = now()
   where category     = 'consent_esign_pending'
     and resolved_at  is null
     and archived_at  is null
     and subject_type = 'child'
     and subject_id in (select child_id from superseded);

  return NEW;
end;
$$;

drop trigger if exists supersede_pendings_on_template_archive_trg
  on public.consent_templates;

create trigger supersede_pendings_on_template_archive_trg
  after update on public.consent_templates
  for each row execute function public.supersede_pendings_on_template_archive();

-- -------------------------------------------------------
-- 3. Drop the old consent_esign_complete signature
-- -------------------------------------------------------
-- Migration 033 created consent_esign_complete with three text
-- args (p_pending_id, p_typed_signature_text, p_claimed_body_text).
-- The third arg is unreachable dead code under Option A; remove
-- it by dropping the function and recreating with two args.
-- Y1 has no UI; the only callers are manual SQL editor / RPC
-- invocations during the live gate. Safe to drop.
drop function if exists public.consent_esign_complete(uuid, text, text);

-- -------------------------------------------------------
-- 4. consent_esign_complete — Option A rewrite
-- -------------------------------------------------------
-- Flow:
--   1. Input sanity.
--   2. Look up the pending row WITHOUT a resolved_at filter (so
--      we can produce a state-specific message for each resolved
--      flavor). FOR UPDATE locks for the transaction.
--   3. State checks with parent-readable messages — branch on
--      resolved_via.
--   4. Authorization: parent_family_links active link.
--   5. Optional expiry check (matches prior behavior).
--   6. Snapshot at completion: re-read CURRENT template body.
--      Under the supersede trigger, a non-superseded pending
--      always finds an active template here. Belt-and-suspenders
--      race-window fallback: if archived → mark superseded +
--      raise the same parent-readable message.
--   7-10. Insert acknowledgments row with current body snapshot,
--         mark pending parent_completed, resolve reminders,
--         provider-facing notification.
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

  -- 3. State checks — parent-readable, situation-specific. All
  --    errcode = 'P0001' so the UI can branch generically on
  --    "user-visible" vs other (42501 = permission, etc.).
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

  -- 5. Optional expiry check. Mark resolved_via='expired' in the
  --    same transaction and raise.
  if v_pending.expires_at is not null and v_pending.expires_at <= now() then
    update public.consents_pending_esign
       set resolved_at = now(),
           resolved_via = 'expired'
     where id = v_pending.id;
    raise exception 'consent_esign_complete: this consent request expired on %', v_pending.expires_at
      using errcode = 'P0001';
  end if;

  -- 6. Snapshot at completion — re-read CURRENT template body.
  --    Under Option A, a non-superseded pending should always
  --    find an active template here (the supersede trigger
  --    catches all archive-driven edits). Belt-and-suspenders
  --    fallback for the rare race window or trigger bypass: if
  --    the template lookup returns null, mark the pending
  --    superseded in this transaction and raise the same
  --    parent-readable message.
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

  -- 7. Carry per-occurrence metadata onto the acknowledgments row
  --    for the per-trip types (per the Phase C shape from
  --    migration 027).
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

  -- 11. Provider-facing notification on completion.
  insert into public.notification_log (
    recipient_type, recipient_id, recipient_email,
    change_type, change_description,
    changed_by_user_id, changed_by_role,
    family_id, child_id,
    email_sent, email_sent_at, email_id,
    metadata
  ) values (
    'provider', v_provider_id, null,
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

  return v_ack_id;
end;
$$;

revoke all  on function public.consent_esign_complete(uuid, text) from public;
grant execute on function public.consent_esign_complete(uuid, text) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- WARNING: rolling back the trigger leaves future template edits
-- stranding pending rows (the original Y1 bug). Don't roll back
-- once Y1 e-sign is live unless you also restore migration 033's
-- original consent_esign_complete and accept the orphaned-pending
-- behavior. Pre-flight: confirm there are no pending
-- consents_pending_esign rows with
-- resolved_via='superseded_by_template_edit' that you care about.
--
-- drop function if exists public.consent_esign_complete(uuid, text);
--
-- drop trigger if exists supersede_pendings_on_template_archive_trg
--   on public.consent_templates;
-- drop function if exists public.supersede_pendings_on_template_archive();
--
-- alter table public.consents_pending_esign
--   drop constraint if exists chk_consents_pending_esign_resolved_via;
-- alter table public.consents_pending_esign
--   add constraint chk_consents_pending_esign_resolved_via
--   check (
--     resolved_via is null
--     or resolved_via in (
--       'parent_completed',
--       'provider_rescinded',
--       'expired'
--     )
--   );
--
-- -- Recreate the original 033 consent_esign_complete(uuid, text, text).
-- -- (Body omitted; see migration 033 lines ~712-849 for the original.)
