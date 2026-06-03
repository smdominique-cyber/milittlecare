-- ============================================================
-- MI Little Care — Parent Self-Service Phase X
-- RLS lockdown + low-risk surface schema + child_parent_update RPC
--
-- Authoritative scope: docs/pr-parent-self-service-scope.md
-- (Phase X). This migration is the data-layer half of Phase X:
--
--   1. The upload-but-never-delete RLS LOCKDOWN — closes a LIVE
--      production gap. Today migrations 016 grants parents:
--        - DELETE on `emergency_contacts` (line 308-315)
--        - DELETE on `guardians`           (line 399-406)
--      AND a too-permissive UPDATE on `children` (line 267-275)
--      that lets a parent set ANY column including
--      `intake_completed_at`, `archived_at`, `school_*`.
--      This migration drops those three policies and replaces
--      the children-medical-update path with a SECURITY DEFINER
--      RPC that accepts only the safe columns.
--   2. A `block_parent_archive` trigger pattern — defense in depth
--      against any other write path that would let a parent set
--      `archived_at`. Attached to every table with an
--      `archived_at` column that parents can write to (children
--      via the RPC; guardians via direct UPDATE).
--      `emergency_contacts` has no `archived_at` column so no
--      trigger is attached there — the DELETE policy removal is
--      the entirety of its lockdown.
--   3. Low-risk surface columns:
--      - `emergency_contacts.pickup_authorized boolean` for the
--        authorized-pickup list (§2d Option A — extend the
--        existing table, no new table).
--      - `children.physician_name|_phone|dentist_name|_phone text`
--        for parent-authored child medical contacts (§2e).
--   4. `child_parent_update(p_child_id, …)` SECURITY DEFINER RPC
--      — the ONLY path for parent edits on the `children` table.
--      Validates the caller is an active parent linked to the
--      child via `parent_family_links`. Writes only the safe
--      columns. Notifies the provider via `notification_log`
--      when allergies or medical_notes change (§9 care-critical
--      notifications).
--
-- DEPENDENCY: applies AFTER migration 030
-- (consent_attachments_archived_rls). No dependency on Phase Y
-- (templates / e-signature) — those are a future migration.
--
-- ── RLS POLICY SHAPE AFTER THIS MIGRATION ──────────────────────────
-- emergency_contacts (parent role):
--   SELECT — yes (per migration 016 family-linked policy)
--   INSERT — yes
--   UPDATE — yes
--   DELETE — NO (dropped by this migration)
-- guardians (parent role):
--   SELECT — yes
--   INSERT — yes
--   UPDATE — yes (BUT cannot set archived_at; trigger blocks)
--   DELETE — NO (dropped by this migration)
-- children (parent role):
--   SELECT — yes
--   INSERT — NO (provider-only)
--   UPDATE — NO direct (dropped); via child_parent_update RPC
--            only — narrow column allowlist; archived_at always
--            untouched by the parent
--   DELETE — NO
-- parent_profiles — unchanged (parent owns own row, no archived_at column)
-- acknowledgments — unchanged (parent has SELECT + INSERT 'parent_portal'
--                   only; no UPDATE policy — archive is provider-only via
--                   the existing "Providers can update their own
--                   acknowledgments" policy + intake_confirm_for_parent
--                   SECURITY DEFINER RPC for parent-confirm archives)
--
-- The provider role's DELETE / UPDATE on these tables is UNAFFECTED.
-- The "Users can delete/insert/update their own ..." policies (which
-- gate on `user_id = auth.uid()` — provider id) stay in place.
--
-- ── IDEMPOTENCY ────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS / CREATE OR REPLACE FUNCTION /
-- ADD COLUMN IF NOT EXISTS. Re-runnable.
--
-- ── EXPECTED VERIFICATION (run BEFORE writing the runbook entry) ──
-- After applying:
--
--   -- a) The two parent-DELETE policies are gone.
--   select polname from pg_policies
--   where schemaname='public'
--     and (tablename='emergency_contacts' or tablename='guardians')
--     and cmd='DELETE'
--     and polname like 'Parents can%';
--   -- expect: zero rows.
--
--   -- b) The overly-broad parent UPDATE on children is gone.
--   select polname from pg_policies
--   where schemaname='public' and tablename='children'
--     and polname='Parents can update children medical info';
--   -- expect: zero rows.
--
--   -- c) The block_parent_archive trigger exists on children + guardians.
--   select tgname, tgrelid::regclass as table_name from pg_trigger
--   where tgname='block_parent_archive_trg'
--   order by table_name;
--   -- expect: children, guardians (2 rows).
--
--   -- d) The RPC exists + is granted to authenticated.
--   select proname from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname='child_parent_update';
--   -- expect: one row.
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where specific_schema='public'
--     and routine_name='child_parent_update';
--   -- expect: authenticated / EXECUTE; no public.
--
--   -- e) New columns present.
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema='public'
--     and (
--       (table_name='emergency_contacts' and column_name='pickup_authorized')
--       or (table_name='children' and column_name in
--           ('physician_name','physician_phone','dentist_name','dentist_phone'))
--     )
--   order by table_name, column_name;
--   -- expect: 5 rows.
--
-- ── LIVE VERIFICATION GATE (run by Seth on preview, BEFORE merge) ──
-- This migration closes a LIVE gap; the gate is real-auth tests:
--
--   1. As parent A: attempt DELETE on emergency_contacts where their
--      family_id matches. Expect 0 rows affected (RLS denies; no error).
--   2. As parent A: attempt DELETE on guardians where their family_id
--      matches. Expect 0 rows affected.
--   3. As parent A: attempt UPDATE on guardians SET archived_at = now()
--      WHERE family_id matches. Expect trigger exception
--      'block_parent_archive: only the provider can archive this record'.
--   4. As parent A: attempt UPDATE on children SET archived_at = now()
--      via direct PostgREST. Expect 0 rows affected (no parent UPDATE
--      policy on children after this migration); fall-through to the
--      RPC is the only path, and the RPC does not touch archived_at.
--   5. As provider P: DELETE / UPDATE / archive on any of the above
--      tables for their own children/guardians/contacts — succeeds
--      unchanged.
--   6. As parent A: rpc('child_parent_update', { ... allergies: 'updated' })
--      succeeds. Verify: child's allergies updated; notification_log
--      row written with kind='child_allergies_updated_by_parent';
--      archived_at unchanged.
-- ============================================================

-- -------------------------------------------------------
-- 1. RLS LOCKDOWN — drop the parent-DELETE policies
-- -------------------------------------------------------
-- emergency_contacts: the migration-016 family-linked parent DELETE
-- policy is the LIVE gap. The "Users can delete their own ..." policy
-- gates on user_id (provider id) and stays.
drop policy if exists "Parents can delete emergency contacts"
  on public.emergency_contacts;

-- guardians: same.
drop policy if exists "Parents can delete guardians for their families"
  on public.guardians;

-- -------------------------------------------------------
-- 2. RLS LOCKDOWN — drop the too-permissive parent UPDATE on children
-- -------------------------------------------------------
-- Migration 016's "Parents can update children medical info" lets a
-- parent update ANY column on children including intake_completed_at,
-- archived_at, school_*, user_id — full table write. Drop it and
-- route parent edits through the SECURITY DEFINER RPC below, which
-- restricts to the safe column set.
drop policy if exists "Parents can update children medical info"
  on public.children;

-- -------------------------------------------------------
-- 3. LOW-RISK SURFACE COLUMNS — additive
-- -------------------------------------------------------

-- §2d Option A — extend emergency_contacts with pickup authorization
-- flag (rather than a new authorized_pickup table). One extra
-- checkbox in the existing emergency-contact UI; smallest schema
-- surface area for V1.
alter table public.emergency_contacts
  add column if not exists pickup_authorized boolean
    not null default false;

comment on column public.emergency_contacts.pickup_authorized is
  'Whether this contact is authorized to pick the child up. '
  'Parent-writable per §2d of pr-parent-self-service-scope.md. '
  'Default false — explicit opt-in per-contact.';

-- §2e — parent-authored child medical contacts (physician + dentist).
-- Free-text per Phase X; richer structure (specialty, etc.) can be
-- added later without a breaking change.
alter table public.children
  add column if not exists physician_name  text,
  add column if not exists physician_phone text,
  add column if not exists dentist_name    text,
  add column if not exists dentist_phone   text;

comment on column public.children.physician_name is
  'Parent-authored: child''s primary care physician name. '
  'Updated via child_parent_update RPC (Phase X). '
  'See docs/pr-parent-self-service-scope.md §2e.';

-- -------------------------------------------------------
-- 4. block_parent_archive — defense-in-depth trigger
-- -------------------------------------------------------
-- Even with the parent UPDATE policy dropped, defense-in-depth is
-- to also block at the trigger level. Any future RLS edit that
-- accidentally re-opens a parent UPDATE path on these tables would
-- still be stopped at the trigger by the archive check.
--
-- Generic enough to handle multiple tables. The trigger relies on
-- pg_table_is_visible + TG_TABLE_NAME to know which table is being
-- updated, then checks the appropriate ownership-by-provider join.
--
-- A simpler design (one trigger function per table) is cleaner; we
-- use the generic version because the per-table boilerplate would
-- be three copies of the same 15 lines.
create or replace function public.block_parent_archive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_provider boolean := false;
begin
  -- Only care about UPDATEs that change archived_at to non-null.
  -- An archived_at = null write (un-archive) is also restricted to
  -- providers — same logic. NEW.archived_at IS DISTINCT FROM
  -- OLD.archived_at covers both cases.
  if TG_OP <> 'UPDATE' then
    return NEW;
  end if;
  if NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at then
    -- No change to archived_at — allow.
    return NEW;
  end if;

  -- Per-table ownership lookup. Each table has a different path to
  -- the licensee/provider id. Extend this CASE if a new
  -- archived_at-bearing parent-writable table is added.
  case TG_TABLE_NAME
    when 'children' then
      -- children.user_id IS the provider/licensee id.
      v_is_provider := (NEW.user_id = auth.uid());
    when 'guardians' then
      -- guardians.user_id IS the licensee id (per migration 016's
      -- "Users can delete their own guardians" policy that gates on
      -- user_id = auth.uid()).
      v_is_provider := (NEW.user_id = auth.uid());
    else
      -- Unknown table — be safe and require provider role. If a
      -- future table is added that lacks a provider gating column,
      -- the trigger should be customized for that table; the default
      -- DENY-by-default keeps holes from opening unintentionally.
      v_is_provider := false;
  end case;

  if not v_is_provider then
    raise exception 'block_parent_archive: only the provider can archive this record'
      using errcode = '42501';  -- insufficient_privilege
  end if;

  return NEW;
end;
$$;

revoke all  on function public.block_parent_archive() from public;

-- Attach to children + guardians. emergency_contacts has no
-- archived_at column, so no trigger is attached there.
drop trigger if exists block_parent_archive_trg on public.children;
create trigger block_parent_archive_trg
  before update on public.children
  for each row execute function public.block_parent_archive();

drop trigger if exists block_parent_archive_trg on public.guardians;
create trigger block_parent_archive_trg
  before update on public.guardians
  for each row execute function public.block_parent_archive();

-- -------------------------------------------------------
-- 5. child_parent_update — SECURITY DEFINER RPC
-- -------------------------------------------------------
-- The single path by which parents edit `children` rows in Phase X.
-- Restricts to the safe column set:
--   allergies, medical_notes, physician_name, physician_phone,
--   dentist_name, dentist_phone
-- Never touches: user_id, family_id, intake_completed_at,
--   records_last_reviewed_on, school_*, immunization_*, archived_at,
--   first/last_name, date_of_birth.
--
-- Care-critical notification: when allergies or medical_notes change,
-- insert a notification_log row with the appropriate kind so the
-- existing `api/notify-state-change.js` dispatcher emails the
-- provider.
--
-- Authorization mirror of intake_confirm_for_parent (migration 025):
-- the caller's auth.uid() must be an active parent linked to the
-- child via parent_family_links.
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
  -- Pulls the child's provider_id (user_id) + current allergies +
  -- medical_notes in the same query so we don't issue a second
  -- SELECT for the notification check.
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
  -- The boolean flags let the caller distinguish "leave unchanged"
  -- from "set to NULL" — without them, every NULL parameter would
  -- be treated as a clear (the JS would have to send the existing
  -- value to keep it, which defeats the purpose).
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

  -- ── Care-critical notifications ──────────────────────────────────
  -- Fire one notification_log row per changed care-critical field.
  -- Column shape matches the existing api/notify-state-change.js +
  -- api/cron-dispatch-reminders.js writers verbatim:
  --   recipient_type / recipient_id / recipient_email
  --   change_type / change_description
  --   changed_by_user_id / changed_by_role
  --   family_id / child_id
  --   email_sent / email_sent_at / email_id
  --   metadata (jsonb)
  --
  -- We write the row server-side via the RPC; the actual email send
  -- happens out-of-band (the existing dispatcher reads unread rows).
  -- email_sent stays false here — the dispatcher flips it when the
  -- email actually goes out.
  --
  -- recipient_email left null in the SQL; the dispatcher resolves
  -- from profiles.email at send time, same as
  -- api/cron-dispatch-reminders.js line 446-447 does for the
  -- no_recipient case.
  --
  -- Only fire when the value actually changed (NULL-safe IS DISTINCT
  -- FROM). Avoids spam when the parent saved with no real change.
  if p_apply_allergies
     and (p_allergies is distinct from v_old_allergies) then
    insert into public.notification_log (
      recipient_type, recipient_id, recipient_email,
      change_type, change_description,
      changed_by_user_id, changed_by_role,
      family_id, child_id,
      email_sent, email_sent_at, email_id,
      metadata
    ) values (
      'provider', v_provider_id, null,
      'child_allergies_updated_by_parent',
      'Allergy info updated by parent',
      v_parent_id, 'parent',
      v_child_family_id, p_child_id,
      false, null, null,
      jsonb_build_object(
        'previous_value', v_old_allergies,
        'new_value', p_allergies
      )
    );
  end if;

  if p_apply_medical_notes
     and (p_medical_notes is distinct from v_old_medical) then
    insert into public.notification_log (
      recipient_type, recipient_id, recipient_email,
      change_type, change_description,
      changed_by_user_id, changed_by_role,
      family_id, child_id,
      email_sent, email_sent_at, email_id,
      metadata
    ) values (
      'provider', v_provider_id, null,
      'child_medical_notes_updated_by_parent',
      'Medical notes updated by parent',
      v_parent_id, 'parent',
      v_child_family_id, p_child_id,
      false, null, null,
      jsonb_build_object(
        'previous_value', v_old_medical,
        'new_value', p_medical_notes
      )
    );
  end if;

  return true;
end;
$$;

revoke all  on function public.child_parent_update(
  uuid, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) from public;
grant execute on function public.child_parent_update(
  uuid, text, text, text, text, text, text,
  boolean, boolean, boolean, boolean, boolean, boolean
) to authenticated;

-- -------------------------------------------------------
-- 6. parent_photo_consent_set — SECURITY DEFINER RPC
-- -------------------------------------------------------
-- The parent-side path for photo-sharing consent grant + revoke
-- (Phase X §2a — low-risk, provider-protective, no rule).
--
-- Why an RPC: a clean grant-after-revoke (or revoke-after-grant)
-- requires archiving the prior active photo row before inserting
-- the new one — the `acknowledgments_active_unique` partial index
-- enforces one active row per (provider, type, subject_type,
-- subject_id), and we want only one active "current preference"
-- regardless of which type. Parents have NO UPDATE policy on
-- `acknowledgments` (migration 024 — provider archive only), so
-- a parent can't archive on their own. This RPC does the
-- archive + insert atomically server-side with the parent's
-- auth.uid().
--
-- Authorization: same shape as intake_confirm_for_parent
-- (migration 025) — joins through parent_family_links to confirm
-- the parent has authority on the subject child.
--
-- Inputs:
--   p_child_id — the child the consent is for
--   p_grant    — true = grant photo sharing; false = revoke
--
-- Behavior:
--   1. Validate parent authority.
--   2. Archive every active row of type 'photo_sharing_consent'
--      OR 'photo_sharing_consent_revoked' for (provider, child)
--      under any channel — this is the parent overriding both
--      prior preference rows.
--   3. Insert a single new row of the appropriate type with
--      acknowledged_via='parent_portal',
--      acknowledged_by_user_id=auth.uid(),
--      acknowledged_at=now().
--
-- The new row's `subject_type='child'`, `subject_id=p_child_id`,
-- `provider_id=children.user_id` (looked up server-side).
create or replace function public.parent_photo_consent_set(
  p_child_id uuid,
  p_grant    boolean
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id    uuid := auth.uid();
  v_provider_id  uuid;
  v_new_type     text;
  v_inserted     int := 0;
begin
  if p_child_id is null then
    raise exception 'parent_photo_consent_set: p_child_id is required';
  end if;
  if p_grant is null then
    raise exception 'parent_photo_consent_set: p_grant is required';
  end if;
  if v_parent_id is null then
    raise exception 'parent_photo_consent_set: no authenticated caller';
  end if;

  -- ── Authorization: caller is an active parent for the child ────
  select c.user_id into v_provider_id
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = p_child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';

  if v_provider_id is null then
    raise exception 'parent_photo_consent_set: caller is not an active parent for this child, or child not found'
      using errcode = '42501';
  end if;

  -- ── Archive both prior preference rows (consent OR revoke) ─────
  -- Channel-agnostic — the parent's new preference overrides any
  -- prior preference recorded by the provider too.
  update public.acknowledgments
     set archived_at = now()
   where provider_id = v_provider_id
     and subject_type = 'child'
     and subject_id   = p_child_id
     and archived_at  is null
     and type in ('photo_sharing_consent', 'photo_sharing_consent_revoked');

  -- ── Insert the new preference row ──────────────────────────────
  v_new_type := case when p_grant then 'photo_sharing_consent'
                                  else 'photo_sharing_consent_revoked' end;

  insert into public.acknowledgments (
    provider_id, type, subject_type, subject_id,
    acknowledged_by_user_id, acknowledged_by_label,
    acknowledged_via, acknowledged_at,
    provider_override_reason,
    snapshot_hash, snapshot_version
  ) values (
    v_provider_id,
    v_new_type,
    'child',
    p_child_id,
    v_parent_id,
    null,
    'parent_portal',
    now(),
    null,
    null,        -- snapshot_hash optional for this row
    'v1'
  );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all  on function public.parent_photo_consent_set(uuid, boolean) from public;
grant execute on function public.parent_photo_consent_set(uuid, boolean) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- WARNING: rolling back this migration RE-OPENS the parent DELETE
-- gap on emergency_contacts + guardians and the too-permissive
-- children UPDATE policy. Confirm there's no live production data
-- depending on the lockdown before rolling back.
--
-- drop function if exists public.parent_photo_consent_set(uuid, boolean);
--
-- drop function if exists public.child_parent_update(
--   uuid, text, text, text, text, text, text,
--   boolean, boolean, boolean, boolean, boolean, boolean
-- );
--
-- drop trigger if exists block_parent_archive_trg on public.guardians;
-- drop trigger if exists block_parent_archive_trg on public.children;
-- drop function if exists public.block_parent_archive();
--
-- alter table public.children
--   drop column if exists dentist_phone,
--   drop column if exists dentist_name,
--   drop column if exists physician_phone,
--   drop column if exists physician_name;
--
-- alter table public.emergency_contacts
--   drop column if exists pickup_authorized;
--
-- -- Re-create the dropped policies (from migration 016).
-- create policy "Parents can update children medical info"
--   on public.children for update
--   using (family_id in (
--     select pfl.family_id from public.parent_family_links pfl
--     where pfl.parent_id = auth.uid() and pfl.status = 'active'
--   ));
--
-- create policy "Parents can delete emergency contacts"
--   on public.emergency_contacts for delete
--   using (family_id in (
--     select pfl.family_id from public.parent_family_links pfl
--     where pfl.parent_id = auth.uid() and pfl.status = 'active'
--   ));
--
-- create policy "Parents can delete guardians for their families"
--   on public.guardians for delete
--   using (family_id in (
--     select pfl.family_id from public.parent_family_links pfl
--     where pfl.parent_id = auth.uid() and pfl.status = 'active'
--   ));
