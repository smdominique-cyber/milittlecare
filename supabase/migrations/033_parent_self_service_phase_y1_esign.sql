-- ============================================================
-- MI Little Care — Parent Self-Service Phase Y1
-- Medium-risk consent e-signature: compliance-evidence data layer
-- (schema + RPCs + WORM, ZERO UI)
--
-- Authoritative spec: docs/pr-parent-self-service-phase-y-scope.md
-- (Y1 section). Phase Y is the highest-stakes build in the
-- parent-self-service arc — the completed e-sign acknowledgments
-- row IS the artifact a licensing inspector reads as the parent's
-- written permission. Three properties matter absolutely:
--
--   1. The row is self-contained. No JOIN required to surface
--      what the parent agreed to. Template body is snapshotted
--      onto the row at completion.
--   2. The snapshot survives later template edits. If the
--      provider edits the template after the parent signs, the
--      parent's row STILL shows what they actually saw.
--   3. The cross-tenant / authorization boundary holds with the
--      same caliber as the consent-attachments cross-tenant gate.
--
-- DEPENDENCY: applies AFTER migration 031
-- (parent_self_service_phase_x). Migration 032 was deleted on
-- the Phase X emergency-refresh branch (a stray that diagnosed
-- the wrong layer); migrations folder ends at 031.
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────
-- 1. consent_templates table — per-provider templates with
--    archive-then-insert protocol; one active row per
--    (provider_id, consent_type).
-- 2. consents_pending_esign table — sent-but-not-completed queue.
-- 3. profiles.medium_risk_consents_enabled jsonb — server-
--    authoritative opt-in gate, defaults all five categories
--    to false (OFF by default).
-- 4. acknowledgments extension: three new columns
--    (typed_signature_text, template_snapshot_text,
--    consent_template_id), expanded channel CHECK to include
--    'parent_portal_esign', new chk_acknowledgments_esign_shape
--    CHECK enforcing signature + snapshot non-null when channel
--    is esign and NULL otherwise.
-- 5. block_esign_evidence_update WORM trigger — blocks UPDATE
--    to the evidence columns after initial write. archived_at
--    stays mutable.
-- 6. Three SECURITY DEFINER RPCs:
--      - consent_esign_send       (provider sends to parent)
--      - consent_esign_complete   (parent types name + signs)
--      - consent_esign_rescind    (provider cancels a pending)
-- 7. RLS on the two new tables.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────
-- - NO UI. Y2 ships the Business-tab toggles + template editor +
--   provider send modal + parent pending card.
-- - NO template-body wording finalization. The seed bodies in
--   `consent_templates` are PLACEHOLDER PENDING SETH +
--   LICENSING CONSULTANT LEGAL REVIEW per spec §4 + §11. The
--   COMPLIANCE-REQUIRED ELEMENTS are present so structure is
--   correct, but the literal sentences must NOT ship to
--   providers as final language without review.
-- - NO change to existing acknowledgment row data. The new CHECK
--   is satisfied by every existing row (channel != esign, new
--   columns NULL). The WORM trigger fires on UPDATE only;
--   existing rows are unaffected.
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────
-- CREATE TABLE / INDEX / FUNCTION use IF NOT EXISTS or OR REPLACE.
-- CREATE POLICY uses DROP IF EXISTS / CREATE (Postgres does not
-- support IF NOT EXISTS on CREATE POLICY — see migration 016
-- lesson in docs/tech_debt.md). ALTER TABLE column adds use
-- IF NOT EXISTS.
--
-- ── EXPECTED VERIFICATION (run by Seth in the Supabase web SQL
--    Editor AFTER applying this migration, BEFORE writing the
--    runbook entry per the CLAUDE.md verification-gap rule). ─────
--
--   -- a) The two new tables exist with their key columns.
--   select table_name, column_name, data_type
--     from information_schema.columns
--    where table_schema='public'
--      and table_name in ('consent_templates', 'consents_pending_esign')
--    order by table_name, ordinal_position;
--   -- expect: 11 cols for consent_templates,
--   --         13 cols for consents_pending_esign.
--
--   -- b) The acknowledgments extension is in place.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public'
--      and table_name='acknowledgments'
--      and column_name in
--          ('typed_signature_text','template_snapshot_text','consent_template_id');
--   -- expect: 3 rows, all is_nullable='YES'.
--
--   -- c) The expanded channel CHECK.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname='chk_acknowledgments_via';
--   -- expect: includes 'parent_portal_esign'.
--
--   -- d) The new shape CHECK.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname='chk_acknowledgments_esign_shape';
--   -- expect: one row, CHECK includes
--   --   acknowledged_via = 'parent_portal_esign' AND signature +
--   --   snapshot non-null clauses.
--
--   -- e) The WORM trigger is attached.
--   select tgname, tgrelid::regclass as table_name
--     from pg_trigger
--    where tgname='block_esign_evidence_update_trg';
--   -- expect: one row, table_name='public.acknowledgments'.
--
--   -- f) The three RPCs exist and are granted to authenticated.
--   select proname from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname in
--          ('consent_esign_send','consent_esign_complete','consent_esign_rescind');
--   -- expect: 3 rows.
--
--   select grantee, privilege_type, routine_name
--     from information_schema.routine_privileges
--    where specific_schema='public'
--      and routine_name in
--          ('consent_esign_send','consent_esign_complete','consent_esign_rescind')
--    order by routine_name, grantee;
--   -- expect: each function granted EXECUTE to authenticated only.
--
--   -- g) profiles column with default.
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_schema='public' and table_name='profiles'
--      and column_name='medium_risk_consents_enabled';
--   -- expect: one row, data_type='jsonb', default carrying the
--   --   five false keys.
--
--   -- h) RLS policies on the two new tables.
--   select tablename, polname, polcmd
--     from pg_policies
--    where schemaname='public'
--      and tablename in ('consent_templates','consents_pending_esign')
--    order by tablename, polcmd, polname;
--   -- expect: see RLS section below.
--
-- ── LIVE VERIFICATION GATE (the 8-step boundary; run by Seth on
--    preview, AFTER applying, AGAINST REAL AUTH/FIXTURES —
--    Jeff/2549scio, klsnay/Audrey, Dominique). NO MERGE until all
--    eight pass. Three of these (steps 6, 7, 8) are the
--    compliance-defensibility proof — if any fails the boundary
--    has a hole. See the build PR's report for the exact SQL/RPC
--    calls per step. ──────────────────────────────────────────────
--
--   1. Schema applied + (a)-(h) above all pass.
--   2. Provider Vanessa: insert a consent_templates row for
--      'field_trip_permission' (no UI yet); flip
--      profiles.medium_risk_consents_enabled
--        ->'field_trip_permission' to true via direct UPDATE.
--   3. Provider Vanessa: rpc('consent_esign_send', { p_child_id:
--      <Audrey>, p_consent_type: 'field_trip_permission' }).
--      Confirm consents_pending_esign row + notification_log row
--      written, both with the right provider + child + family.
--   4. Provider Vanessa: edit the consent_templates row's body_text
--      (archive prior + insert new — the template-edit protocol).
--   5. Parent klsnay: rpc('consent_esign_complete', { pending_id,
--      typed_signature_text: 'klsnay typed name',
--      claimed_body_text: <OLD body from step 3> }). Expect
--      template_changed_since_send error. THEN re-call with the
--      NEW body (step 4's body). Expect success.
--      Verify on acknowledgments row:
--        - acknowledged_via='parent_portal_esign'
--        - typed_signature_text matches
--        - template_snapshot_text = NEW body verbatim
--        - consent_template_id references the NEW template row
--        - subject_type='child', subject_id=Audrey
--        - acknowledged_by_user_id=klsnay's uid
--        - provider_id=Vanessa's uid
--   6. Provider Vanessa: edit/archive the template again. The
--      acknowledgments row from step 5 STILL has the old
--      template_snapshot_text (the snapshot is immutable — the
--      WORM trigger enforces).
--   7. Cross-tenant denial: provider sends a fresh pending for a
--      Dominique-family child. klsnay (not linked to Dominique)
--      calls consent_esign_complete on it. Expect 42501
--      "caller is not an active parent for this child".
--   8. Opt-in bypass: any non-Vanessa user calls
--      consent_esign_send → DENIED (caller is not the provider
--      for this child). Then Vanessa toggles
--      medium_risk_consents_enabled->'field_trip_permission'
--      back to false; Vanessa calls consent_esign_send → DENIED
--      (category not enabled). Parent klsnay attempts an INSERT
--      into consents_pending_esign directly → RLS denies.
--
--   Plus invariants:
--      - Update typed_signature_text on the row from step 5 →
--        WORM trigger raises.
--      - Provider archives the row from step 5
--        (archived_at = now()) → succeeds (archive is mutable).
-- ============================================================

-- -------------------------------------------------------
-- 1. consent_templates — per-provider templates
-- -------------------------------------------------------
create table if not exists public.consent_templates (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references auth.users(id) on delete cascade,
  consent_type        text not null,
  -- One of the five medium-risk values:
  --   'field_trip_permission'
  --   'transportation_routine_annual'
  --   'transportation_nonroutine_per_trip'
  --   'water_activities_on_premises_seasonal'
  --   'water_activities_off_premises_per_trip'
  -- Validated at the application catalog (ACK_TYPES); no DB
  -- CHECK per the same OQ3-style reasoning as migrations
  -- 024 + 023.
  title               text not null,
  body_text           text not null,
  body_text_version   integer not null default 1,
  enabled             boolean not null default true,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists consent_templates_active_unique
  on public.consent_templates (provider_id, consent_type)
  where archived_at is null;

create index if not exists consent_templates_provider
  on public.consent_templates (provider_id);

comment on column public.consent_templates.body_text is
  'The literal paragraph parents read + agree to. Snapshotted into '
  'acknowledgments.template_snapshot_text at completion. The seed '
  'bodies provided by Phase Y1 are PLACEHOLDER PENDING SETH + '
  'LICENSING CONSULTANT LEGAL REVIEW — they carry the '
  'compliance-required elements per R 400.xxxx but the literal '
  'wording must NOT ship to providers as final language without '
  'review. Phase Y2 ships the template editor that lets the '
  'provider customize before relying on a template.';

alter table public.consent_templates enable row level security;

-- RLS — providers own their templates. Parents have NO direct
-- SELECT; they see template body only through the snapshot
-- column on a sent/completed acknowledgments row, or via the
-- pending-esign row's template_body_at_send.
drop policy if exists "Providers can view their own consent_templates"
  on public.consent_templates;
create policy "Providers can view their own consent_templates"
  on public.consent_templates for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their own consent_templates"
  on public.consent_templates;
create policy "Providers can insert their own consent_templates"
  on public.consent_templates for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their own consent_templates"
  on public.consent_templates;
create policy "Providers can update their own consent_templates"
  on public.consent_templates for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- -------------------------------------------------------
-- 2. consents_pending_esign — sent-but-not-completed queue
-- -------------------------------------------------------
create table if not exists public.consents_pending_esign (
  id                          uuid primary key default gen_random_uuid(),
  provider_id                 uuid not null references auth.users(id) on delete cascade,
  child_id                    uuid not null references public.children(id) on delete cascade,
  consent_type                text not null,
  consent_template_id         uuid not null references public.consent_templates(id),
  -- Stable text the parent reads between send and completion.
  -- The AUTHORITATIVE snapshot lives on the acknowledgments row
  -- written at completion (per spec decision 7); this column is
  -- the in-flight working copy.
  template_body_at_send       text not null,
  -- Per-occurrence metadata for the per-trip / per-outing types.
  -- Same { event_date, description } shape as the existing
  -- migration 027 occurrence_metadata column. NULL for the
  -- durable types.
  per_send_metadata           jsonb,
  sent_at                     timestamptz not null default now(),
  expires_at                  timestamptz,
  -- Set when the parent completes OR the provider rescinds OR
  -- the pending expires. NULL = still pending.
  resolved_at                 timestamptz,
  resolved_via                text
    constraint chk_consents_pending_esign_resolved_via
    check (resolved_via is null
        or resolved_via in ('parent_completed', 'provider_rescinded', 'expired')),
  -- Link from pending → completed without a search. Set on
  -- parent_completed.
  resolved_acknowledgment_id  uuid references public.acknowledgments(id) on delete set null,
  archived_at                 timestamptz,
  created_at                  timestamptz not null default now()
);

-- Partial unique: at most one ACTIVE pending row per
-- (provider, child, consent_type) at a time for the DURABLE
-- types. Per-occurrence types are EXEMPT (per_send_metadata
-- discriminates parallel pendings).
create unique index if not exists consents_pending_esign_active_unique
  on public.consents_pending_esign (provider_id, child_id, consent_type)
  where archived_at is null
    and resolved_at is null
    and consent_type not in (
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip'
    );

create index if not exists consents_pending_esign_active_child
  on public.consents_pending_esign (child_id, resolved_at)
  where archived_at is null;

alter table public.consents_pending_esign enable row level security;

-- RLS — providers see + write their own pendings; parents see
-- (but cannot directly write) pendings targeting children they're
-- linked to via parent_family_links. The completion path goes
-- through the consent_esign_complete RPC, NOT a direct UPDATE
-- (the RPC server-side updates resolved_at).
drop policy if exists "Providers can view their own consents_pending_esign"
  on public.consents_pending_esign;
create policy "Providers can view their own consents_pending_esign"
  on public.consents_pending_esign for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their own consents_pending_esign"
  on public.consents_pending_esign;
create policy "Providers can insert their own consents_pending_esign"
  on public.consents_pending_esign for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their own consents_pending_esign"
  on public.consents_pending_esign;
create policy "Providers can update their own consents_pending_esign"
  on public.consents_pending_esign for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

drop policy if exists "Parents can view pending consents for their children"
  on public.consents_pending_esign;
create policy "Parents can view pending consents for their children"
  on public.consents_pending_esign for select to authenticated
  using (
    child_id in (
      select c.id from public.children c
      where c.family_id in (
        select pfl.family_id from public.parent_family_links pfl
        where pfl.parent_id = auth.uid() and pfl.status = 'active'
      )
    )
  );

-- NOTE: no parent INSERT / UPDATE / DELETE policy. The send path
-- is provider-RPC-only; the completion path is parent-RPC-only
-- (the SECURITY DEFINER RPC bypasses RLS server-side to update
-- resolved_at). The boundary at §8 step 8 verifies this.

-- -------------------------------------------------------
-- 3. profiles.medium_risk_consents_enabled — server-side gate
-- -------------------------------------------------------
alter table public.profiles
  add column if not exists medium_risk_consents_enabled jsonb
    not null default jsonb_build_object(
      'field_trip_permission',                  false,
      'transportation_routine_annual',          false,
      'transportation_nonroutine_per_trip',     false,
      'water_activities_on_premises_seasonal',  false,
      'water_activities_off_premises_per_trip', false
    );

comment on column public.profiles.medium_risk_consents_enabled is
  'Per-provider opt-in gate for medium-risk parent self-service '
  'e-sign. All five categories default to false. The server-side '
  'consent_esign_send RPC checks this jsonb before producing a '
  'pending row. Phase Y2 surfaces the toggle UI; until then, '
  'providers can flip via direct UPDATE on profiles (gated by the '
  'existing provider profile RLS).';

-- -------------------------------------------------------
-- 4. acknowledgments — channel CHECK expansion + new columns
--    + shape CHECK
-- -------------------------------------------------------

-- 4a. Drop the old channel CHECK so we can expand the allowed set.
--     Migration 024 created this constraint.
alter table public.acknowledgments
  drop constraint if exists chk_acknowledgments_via;
alter table public.acknowledgments
  add constraint chk_acknowledgments_via check (
    acknowledged_via in (
      'parent_portal',
      'provider_override',
      'in_person_paper',
      'parent_portal_esign'        -- NEW (Phase Y1)
    )
  );

-- 4b. Three new columns for the e-sign payload. Nullable at the
--     column level; the shape CHECK below enforces the
--     channel-conditional NOT-NULL.
alter table public.acknowledgments
  add column if not exists typed_signature_text    text,
  add column if not exists template_snapshot_text  text,
  add column if not exists consent_template_id     uuid
    references public.consent_templates(id) on delete set null;

comment on column public.acknowledgments.typed_signature_text is
  'Phase Y1 — the parent''s typed full name at the moment they '
  'signed via the portal. NOT NULL when acknowledged_via = '
  '''parent_portal_esign''; NULL otherwise. WORM after insert per '
  'block_esign_evidence_update_trg.';

comment on column public.acknowledgments.template_snapshot_text is
  'Phase Y1 — the literal template body the parent agreed to, '
  'snapshotted at completion (NOT at send). Per spec §3b: the RPC '
  're-reads the current consent_templates.body_text at completion '
  'and stores it here, after confirming the parent saw the same '
  'text (via the claimed_body_text stale-read check). Snapshot '
  'survives later template edits — an inspector reads the row '
  'and sees exactly what this parent signed. WORM after insert.';

comment on column public.acknowledgments.consent_template_id is
  'Phase Y1 — FK to the consent_templates row that was current '
  'at completion. ON DELETE SET NULL so a future template delete '
  'does NOT cascade-remove the compliance evidence; the snapshot '
  'on the row remains the source of truth. WORM after insert.';

-- 4c. Shape CHECK — the structural guard. Enforces:
--     (a) parent_portal_esign rows MUST carry signature + snapshot,
--         both non-null and non-empty.
--     (b) Any other channel MUST leave both signature + snapshot
--         NULL (so an accidental write via the wrong channel
--         doesn't get e-sign-like evidence).
--
--     consent_template_id is NOT in this CHECK (it's allowed to
--     be NULL for non-esign rows naturally, and the FK handles
--     referential integrity). The trigger §5 below enforces the
--     write-once behavior for all three evidence columns.
alter table public.acknowledgments
  drop constraint if exists chk_acknowledgments_esign_shape;
alter table public.acknowledgments
  add constraint chk_acknowledgments_esign_shape check (
    (acknowledged_via = 'parent_portal_esign'
       and typed_signature_text   is not null
       and template_snapshot_text is not null
       and length(trim(typed_signature_text))   > 0
       and length(trim(template_snapshot_text)) > 0)
    or
    (acknowledged_via <> 'parent_portal_esign'
       and typed_signature_text   is null
       and template_snapshot_text is null)
  );

-- -------------------------------------------------------
-- 5. block_esign_evidence_update — WORM trigger
-- -------------------------------------------------------
-- After an acknowledgments row is inserted, the evidence columns
-- (typed_signature_text, template_snapshot_text,
-- consent_template_id) are write-once. The provider CAN still
-- archive the row (archived_at is mutable) — the trigger checks
-- only the evidence columns.
--
-- Mirrors the block_parent_archive trigger shape from migration
-- 031: BEFORE UPDATE, raises on the protected mutation, else
-- returns NEW. Cost is three IS-DISTINCT-FROM checks per UPDATE —
-- trivial.
create or replace function public.block_esign_evidence_update()
returns trigger
language plpgsql
as $$
begin
  if TG_OP <> 'UPDATE' then
    return NEW;
  end if;
  if NEW.typed_signature_text   is distinct from OLD.typed_signature_text
  or NEW.template_snapshot_text is distinct from OLD.template_snapshot_text
  or NEW.consent_template_id    is distinct from OLD.consent_template_id
  then
    raise exception
      'block_esign_evidence_update: typed_signature_text / template_snapshot_text / consent_template_id are WORM on the acknowledgments row (compliance evidence)'
      using errcode = '42501';
  end if;
  return NEW;
end;
$$;

drop trigger if exists block_esign_evidence_update_trg on public.acknowledgments;
create trigger block_esign_evidence_update_trg
  before update on public.acknowledgments
  for each row execute function public.block_esign_evidence_update();

-- -------------------------------------------------------
-- 6. consent_esign_send — provider sends to parent
-- -------------------------------------------------------
-- Mirrors intake_confirm_for_parent's authorization shape
-- (migration 025): SECURITY DEFINER, server-authoritative
-- on every security-critical field.
--
-- Behavior:
--   1. Input sanity + auth check (auth.uid() must be the
--      provider for the named child).
--   2. Category enable gate
--      (profiles.medium_risk_consents_enabled ->> consent_type).
--   3. Active template lookup for (provider, consent_type).
--   4. Per-occurrence metadata required for per-trip types.
--   5. Insert consents_pending_esign row with
--      template_body_at_send = current template body.
--   6. Insert notification_log row so the existing dispatcher
--      emails the parent. Column shape verbatim per
--      api/notify-state-change.js +
--      api/cron-dispatch-reminders.js.
--
-- Returns: the new consents_pending_esign.id.
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

  -- Notification log for the email dispatcher. Column shape
  -- verbatim per api/notify-state-change.js +
  -- api/cron-dispatch-reminders.js.
  insert into public.notification_log (
    recipient_type, recipient_id, recipient_email,
    change_type, change_description,
    changed_by_user_id, changed_by_role,
    family_id, child_id,
    email_sent, email_sent_at, email_id,
    metadata
  ) values (
    'parent', null, null,
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

  return v_pending_id;
end;
$$;

revoke all  on function public.consent_esign_send(uuid, text, jsonb, timestamptz) from public;
grant execute on function public.consent_esign_send(uuid, text, jsonb, timestamptz) to authenticated;

-- -------------------------------------------------------
-- 7. consent_esign_complete — parent types name + signs
-- -------------------------------------------------------
-- The evidence-writing RPC. Mirrors intake_confirm_for_parent's
-- shape for the auth check, but produces the COMPLIANCE EVIDENCE
-- row. Atomicity matters: archive the pending + insert the
-- evidence row in one transaction.
--
-- Behavior:
--   1. Input sanity + auth check (auth.uid() must be an active
--      parent linked to the child via parent_family_links).
--   2. Pending row lookup, locked FOR UPDATE in the transaction.
--   3. Optional expiry check.
--   4. Stale-read protection: re-read CURRENT template body.
--      Compare to p_claimed_body_text via IS DISTINCT FROM
--      (exact match per spec §13 OQ#2). If different, raise
--      'template_changed_since_send' so the UI re-fetches.
--      If the template is archived since send, raise a
--      different message (provider must send a fresh one).
--   5. Insert the acknowledgments row with channel
--      'parent_portal_esign', signature, snapshot (= the
--      confirmed current body), template_id. The shape CHECK
--      + WORM trigger lock the evidence.
--   6. Mark the pending row resolved
--      (resolved_via='parent_completed',
--      resolved_acknowledgment_id=<new ack id>).
--   7. Resolve any open reminder_instances of category
--      'consent_esign_pending' for this child.
--   8. Provider-facing notification on completion.
--
-- Returns: the new acknowledgments.id.
create or replace function public.consent_esign_complete(
  p_pending_id            uuid,
  p_typed_signature_text  text,
  p_claimed_body_text     text
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
  if p_pending_id is null then
    raise exception 'consent_esign_complete: p_pending_id is required';
  end if;
  if p_typed_signature_text is null
     or length(trim(p_typed_signature_text)) = 0 then
    raise exception 'consent_esign_complete: typed_signature_text required';
  end if;
  if p_claimed_body_text is null then
    raise exception 'consent_esign_complete: claimed_body_text required';
  end if;
  if v_parent_id is null then
    raise exception 'consent_esign_complete: no authenticated caller';
  end if;

  -- Lock the pending row for the transaction so two parallel
  -- completes can't both write acknowledgments rows.
  select * into v_pending
    from public.consents_pending_esign
   where id = p_pending_id
     and archived_at is null
     and resolved_at is null
   for update;
  if v_pending.id is null then
    raise exception 'consent_esign_complete: pending row not found, already resolved, or rescinded'
      using errcode = '42501';
  end if;

  -- Authorization: parent must be linked to this child's family.
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

  -- Optional expiry check.
  if v_pending.expires_at is not null and v_pending.expires_at <= now() then
    update public.consents_pending_esign
       set resolved_at = now(),
           resolved_via = 'expired'
     where id = v_pending.id;
    raise exception 'consent_esign_complete: this consent expired on %', v_pending.expires_at
      using errcode = '42501';
  end if;

  -- Snapshot-at-completion: re-read the CURRENT template body.
  select body_text into v_current_body
    from public.consent_templates
   where id = v_pending.consent_template_id
     and archived_at is null;
  if v_current_body is null then
    raise exception 'consent_esign_complete: the source template has been archived; provider must send a fresh consent'
      using errcode = '42501';
  end if;

  -- Stale-read protection: exact body match. Per spec §13 OQ#2.
  if v_current_body is distinct from p_claimed_body_text then
    raise exception 'consent_esign_complete: template_changed_since_send'
      using errcode = 'P0001',
            detail  = 'The template was updated after you opened this page. Refresh and review the new wording.';
  end if;

  -- For per-occurrence types, carry the per_send_metadata onto
  -- the acknowledgments row's occurrence_metadata column (per
  -- the Phase C shape from migration 027).
  if v_pending.consent_type in (
    'transportation_nonroutine_per_trip',
    'water_activities_off_premises_per_trip'
  ) then
    v_occurrence_meta := v_pending.per_send_metadata;
  else
    v_occurrence_meta := null;
  end if;

  -- Insert the evidence row. The shape CHECK
  -- (chk_acknowledgments_esign_shape) enforces signature +
  -- snapshot non-null; the WORM trigger blocks future UPDATEs.
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
    null,                    -- snapshot_hash unused for esign rows
    'v1',
    p_typed_signature_text,
    v_current_body,          -- AUTHORITATIVE snapshot
    v_pending.consent_template_id,
    v_occurrence_meta
  )
  returning id into v_ack_id;

  -- Mark the pending row resolved.
  update public.consents_pending_esign
     set resolved_at = now(),
         resolved_via = 'parent_completed',
         resolved_acknowledgment_id = v_ack_id
   where id = v_pending.id;

  -- Resolve any open reminder_instances for the parent-to-do
  -- surface (mirrors migration 025's inline resolve at step 5).
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_type = 'child'
     and ri.subject_id   = v_pending.child_id
     and ri.category     = 'consent_esign_pending'
     and ri.resolved_at  is null
     and ri.archived_at  is null;

  -- Provider-facing notification on completion.
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

revoke all  on function public.consent_esign_complete(uuid, text, text) from public;
grant execute on function public.consent_esign_complete(uuid, text, text) to authenticated;

-- -------------------------------------------------------
-- 8. consent_esign_rescind — provider cancels a pending
-- -------------------------------------------------------
-- For a pending (NOT yet completed) row, the provider can
-- rescind. Marks the pending resolved with
-- resolved_via='provider_rescinded'. The optional reason rolls
-- onto per_send_metadata under key 'rescind_reason'.
--
-- V1 does NOT support rescinding a COMPLETED consent — the
-- provider amends on paper per spec §13 OQ. (A future PR can
-- add that path if real demand surfaces; the WORM trigger
-- protects the evidence either way.)
create or replace function public.consent_esign_rescind(
  p_pending_id uuid,
  p_reason     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider_id   uuid := auth.uid();
  v_pending_owner uuid;
  v_pending_child uuid;
begin
  if p_pending_id is null then
    raise exception 'consent_esign_rescind: p_pending_id required';
  end if;
  if v_provider_id is null then
    raise exception 'consent_esign_rescind: no authenticated caller';
  end if;

  select provider_id, child_id
    into v_pending_owner, v_pending_child
    from public.consents_pending_esign
   where id = p_pending_id
     and archived_at is null
     and resolved_at is null
   for update;
  if v_pending_owner is null then
    raise exception 'consent_esign_rescind: pending row not found or already resolved';
  end if;
  if v_pending_owner <> v_provider_id then
    raise exception 'consent_esign_rescind: caller is not the provider for this pending row'
      using errcode = '42501';
  end if;

  update public.consents_pending_esign
     set resolved_at   = now(),
         resolved_via  = 'provider_rescinded',
         per_send_metadata = case
            when p_reason is not null then
              coalesce(per_send_metadata, '{}'::jsonb) || jsonb_build_object('rescind_reason', p_reason)
            else per_send_metadata
         end
   where id = p_pending_id;

  -- Resolve any open reminder_instances for this child's pending
  -- e-sign surface.
  update public.reminder_instances ri
     set resolved_at = now()
   where ri.subject_type = 'child'
     and ri.subject_id   = v_pending_child
     and ri.category     = 'consent_esign_pending'
     and ri.resolved_at  is null
     and ri.archived_at  is null;

  return true;
end;
$$;

revoke all  on function public.consent_esign_rescind(uuid, text) from public;
grant execute on function public.consent_esign_rescind(uuid, text) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- WARNING: rolling back this migration AFTER any production
-- e-sign rows exist in `acknowledgments` would violate
-- compliance-evidence retention. Confirm there are zero rows
-- with acknowledged_via='parent_portal_esign' before rolling
-- back. The WORM trigger protects against tampering; rollback
-- removes the schema entirely.
--
-- -- Pre-flight check (run AS service-role; expect zero rows
-- -- before proceeding):
-- --   select count(*) from public.acknowledgments
-- --    where acknowledged_via='parent_portal_esign';
--
-- drop function if exists public.consent_esign_rescind(uuid, text);
-- drop function if exists public.consent_esign_complete(uuid, text, text);
-- drop function if exists public.consent_esign_send(uuid, text, jsonb, timestamptz);
--
-- drop trigger if exists block_esign_evidence_update_trg on public.acknowledgments;
-- drop function if exists public.block_esign_evidence_update();
--
-- alter table public.acknowledgments
--   drop constraint if exists chk_acknowledgments_esign_shape;
--
-- alter table public.acknowledgments
--   drop column if exists consent_template_id,
--   drop column if exists template_snapshot_text,
--   drop column if exists typed_signature_text;
--
-- -- Restore original channel CHECK (without parent_portal_esign).
-- alter table public.acknowledgments
--   drop constraint if exists chk_acknowledgments_via;
-- alter table public.acknowledgments
--   add constraint chk_acknowledgments_via check (
--     acknowledged_via in ('parent_portal','provider_override','in_person_paper')
--   );
--
-- alter table public.profiles
--   drop column if exists medium_risk_consents_enabled;
--
-- drop table if exists public.consents_pending_esign;
-- drop table if exists public.consent_templates;
