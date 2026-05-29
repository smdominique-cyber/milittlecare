-- ============================================================
-- MI Little Care — PR #16 follow-up: intake_confirm_for_parent RPC
--
-- Authoritative scope: docs/16patch.md (parent-confirm flow,
-- 2026-05-29 unique-constraint bug). This migration fixes a
-- production-confirmed bug where the parent's "I confirm these
-- acknowledgments" click errored with:
--
--   duplicate key value violates unique constraint
--   "acknowledgments_active_unique"
--
-- Root cause (verified against the deployed schema in migration 024):
-- the parent has NO update policy on `public.acknowledgments`. The
-- only update policy is "Providers can update their own
-- acknowledgments" with `using (provider_id = auth.uid())`. When
-- `ParentIntakeAcknowledgePage.confirmChild` issued the archive
-- UPDATE under the parent's session, PostgREST evaluated the policy,
-- silently filtered out every row (the parent's auth.uid() is not
-- the provider's), and returned a success response with zero rows
-- affected. The subsequent parent_portal INSERT then violated the
-- `acknowledgments_active_unique` partial index because the
-- provider_override rows it was meant to replace were still active.
--
-- The fix lives in the DB layer because the constraint is a DB-level
-- invariant. A JS-side fix (two separate HTTP requests, even both
-- awaited) cannot guarantee the partial index sees the archived rows
-- before the inserted rows — the two calls aren't a transaction. And
-- a JS-side fix can't bypass the parent's RLS gap.
--
-- This migration adds ONE SECURITY DEFINER RPC,
-- `intake_confirm_for_parent`, that does archive + insert + reminder
-- resolve atomically in a single SQL transaction. The parent's
-- session calls one rpc() instead of two .from() chains; the partial
-- index sees the archive and the insert as one atomic event.
--
-- DEPENDENCY: applies AFTER migration 024 (which created the
-- acknowledgments table, the partial unique index, and the three
-- existing reminder-related parent RPCs that this RPC's authorization
-- pattern mirrors).
--
-- ── DESIGN ────────────────────────────────────────────────────────────
-- Security-critical fields are SERVER-AUTHORITATIVE — the RPC ignores
-- whatever the JS sends for these:
--   * provider_id           — looked up from children.user_id
--   * acknowledged_via      — forced to 'parent_portal'
--   * acknowledged_by_user_id — forced to auth.uid()
--   * acknowledged_at       — forced to now()
--   * subject_type / subject_id — forced to ('child', p_child_id)
--   * provider_override_reason / acknowledged_by_label — forced NULL
-- The parent contributes only the bundle shape: `type`,
-- `snapshot_hash`, `snapshot_version` per row.
--
-- The authorization check is FIRST and raises if invalid (rather than
-- silently no-op'ing) so a genuine auth gap is distinguishable from
-- "nothing to confirm" in any future client error handling.
--
-- The archive step is type-keyed (not id-keyed). It clears every
-- active row of (provider_id, subject_type='child', subject_id, type)
-- for each `type` present in `p_rows`. This handles two cases the
-- previous JS-only approach could not:
--   * Defense against any pathologically-leftover provider_override
--     row (manual SQL, prior race, future admin tool).
--   * The latent double-trigger case where "Send to parent's portal"
--     was clicked twice. ChildIntakeModal.handleSendToPortal already
--     archives existing acks before writing a fresh bundle (runs as
--     the provider, so RLS allows it), but stale-state edge cases
--     across multiple modal sessions could still leave two active
--     bundles — this RPC cleans them up uniformly.
--
-- The reminder resolve is INLINE — the parent's confirm is a single
-- atomic event that closes the loop. If we left the resolve as a
-- separate rpc() call on the JS side, a JS process death between
-- the acks insert and the resolve would leave a row mismatch (acks
-- recorded but reminder still pending). One transaction, all or
-- nothing.
--
-- ── VERIFICATION (run by Seth in the Supabase web SQL Editor AFTER
--    applying this migration, BEFORE merging the PR branch) ──────────
--
--   -- a) The RPC exists.
--   select proname from pg_proc
--   where pronamespace = 'public'::regnamespace
--     and proname = 'intake_confirm_for_parent';
--   -- expect: one row.
--
--   -- b) Permissions: authenticated has EXECUTE; public does not.
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where specific_schema='public'
--     and routine_name='intake_confirm_for_parent'
--   order by grantee;
--   -- expect: a row for 'authenticated' / EXECUTE; no 'public' row.
--
--   -- c) End-to-end smoke (run as a real parent session — use the
--   --    Studio's "impersonate a user" feature). Pre-step: trigger
--   --    Send-to-Portal as the provider so there's an active
--   --    provider_override bundle.
--   --
--   --    select public.intake_confirm_for_parent(
--   --      '<child_uuid>'::uuid,
--   --      jsonb_build_array(
--   --        jsonb_build_object('type','child_in_care_statement','snapshot_hash','abc','snapshot_version',null)
--   --      )
--   --    );
--   --
--   --    Expect: returns 1. Then verify:
--   --      select acknowledged_via, count(*)
--   --        from public.acknowledgments
--   --       where subject_id='<child_uuid>'::uuid
--   --      group by acknowledged_via;
--   --    Expect: one or more parent_portal rows with archived_at IS NULL;
--   --            the prior provider_override rows present but
--   --            archived_at IS NOT NULL.
--   --      select count(*) from public.reminder_instances
--   --       where subject_id='<child_uuid>'::uuid
--   --         and category='intake_acknowledgment_pending'
--   --         and resolved_at is not null;
--   --    Expect: the reminder is resolved.
--
--   -- d) Negative smoke — same RPC call but for a child NOT in the
--   --    parent's parent_family_links. Should raise:
--   --      'intake_confirm_for_parent: caller is not an active parent
--   --       for this child, or child not found'
--   --    No rows should be inserted or archived.
-- ============================================================

-- -------------------------------------------------------
-- intake_confirm_for_parent — atomic archive + insert + resolve
-- -------------------------------------------------------
create or replace function public.intake_confirm_for_parent(
  p_child_id uuid,
  p_rows     jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id uuid;
  v_parent_id   uuid := auth.uid();
  v_types       text[];
  v_inserted    int := 0;
begin
  -- ── Input sanity ─────────────────────────────────────────────────
  if p_child_id is null then
    raise exception 'intake_confirm_for_parent: p_child_id is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'intake_confirm_for_parent: p_rows must be a jsonb array';
  end if;
  if v_parent_id is null then
    raise exception 'intake_confirm_for_parent: no authenticated caller';
  end if;

  -- ── 1) Authorization: caller is an active parent for the child ──
  -- Validate BEFORE any side effects. Raise on failure so a genuine
  -- auth gap is visible to the client, distinct from "nothing to
  -- confirm." Returns the provider_id (children.user_id) which we
  -- need server-side; the JS is not trusted for this value.
  select c.user_id into v_provider_id
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = p_child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';

  if v_provider_id is null then
    raise exception 'intake_confirm_for_parent: caller is not an active parent for this child, or child not found';
  end if;

  -- ── 2) Collect distinct types in the parent's payload ──────────
  -- Used for the archive sweep. The distinct narrowing also catches
  -- a malformed p_rows that's an array of non-objects: r->>'type'
  -- returns NULL which array_agg(distinct) filters out, then we
  -- raise.
  select array_agg(distinct (r->>'type'))
    into v_types
    from jsonb_array_elements(p_rows) as r
   where r ? 'type'
     and r->>'type' is not null
     and length(r->>'type') > 0;

  if v_types is null or array_length(v_types, 1) = 0 then
    raise exception 'intake_confirm_for_parent: p_rows contains no rows with a valid type';
  end if;

  -- ── 3) Archive every active row of those types for this child ──
  -- Channel-AGNOSTIC: archives provider_override, in_person_paper,
  -- and any leftover parent_portal rows alike. Defensive against
  -- double-trigger leftovers and any pathological active row.
  update public.acknowledgments
     set archived_at = now()
   where provider_id  = v_provider_id
     and subject_type = 'child'
     and subject_id   = p_child_id
     and archived_at  is null
     and type         = any(v_types);

  -- ── 4) INSERT parent_portal rows with server-overridden security
  --       fields. The parent's JS contributes only `type`,
  --       `snapshot_hash`, and `snapshot_version` per row — every
  --       other column is set here from server-authoritative
  --       sources.
  insert into public.acknowledgments (
    provider_id, type, subject_type, subject_id,
    acknowledged_by_user_id, acknowledged_by_label,
    acknowledged_via, acknowledged_at,
    provider_override_reason,
    snapshot_hash, snapshot_version
  )
  select
    v_provider_id,                   -- looked up; NOT from p_rows
    r->>'type',
    'child',
    p_child_id,
    v_parent_id,                     -- auth.uid(); NOT from p_rows
    null,                            -- parent_portal CHECK: must be null
    'parent_portal',                 -- forced; NOT from p_rows
    now(),                           -- forced; NOT from p_rows
    null,                            -- parent_portal CHECK: must be null
    r->>'snapshot_hash',
    r->>'snapshot_version'
  from jsonb_array_elements(p_rows) as r
   where r ? 'type'
     and r->>'type' is not null
     and length(r->>'type') > 0;

  get diagnostics v_inserted = row_count;

  -- ── 5) Resolve any pending intake_acknowledgment_pending reminder
  --       for this child, in the same transaction. The authorization
  --       check in step 1 already proved the caller has authority on
  --       this child; scoping by subject_id is sufficient. Idempotent.
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_type = 'child'
     and ri.subject_id   = p_child_id
     and ri.category     = 'intake_acknowledgment_pending'
     and ri.resolved_at  is null
     and ri.archived_at  is null;

  return v_inserted;
end;
$$;

revoke all  on function public.intake_confirm_for_parent(uuid, jsonb) from public;
grant execute on function public.intake_confirm_for_parent(uuid, jsonb) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- This migration only adds the function — no schema changes, no
-- column drops, no data modifications. Rollback is one drop:
--
-- drop function if exists public.intake_confirm_for_parent(uuid, jsonb);
--
-- Rolling back this migration WITHOUT also reverting
-- ParentIntakeAcknowledgePage.confirmChild's JS will return the
-- parent-confirm flow to its pre-bug state (errors with
-- "could not find the function public.intake_confirm_for_parent"
-- on every confirm). Roll back the JS first, then the function.
