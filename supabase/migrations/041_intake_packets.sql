-- ============================================================
-- MI Little Care — Intake packet capture model (Option D).
--
-- A provider handles the R 400.1907 intake bundle by EITHER (a)
-- sending a PDF for parent digital signature, OR (b) uploading an
-- already-signed copy — and declares which of the nine intake
-- elements that single artifact covers. Covered elements get their
-- normal `acknowledgments` rows written, tagged with `packet_id`.
-- Uncovered elements get NO row, so they remain `missing_required`
-- in the per-row checklist (the "singled out" outcome). The nine
-- intake-row resolvers (patternAAckOnFile, complianceState.js)
-- DO NOT CHANGE — they keep reading `acknowledgments` rows by type,
-- subject, and parent-signed channel, exactly as today.
--
-- This is Option D from feature/intake-packet-capture's scoping
-- report (see commit history). Option A (a packet table with
-- covered_subtypes array consumed by the resolvers) was the
-- alternative; D was chosen because the resolver layer stays
-- untouched and existing partial-state badges ("Aiden 1 on file")
-- keep working unchanged.
--
-- ── WHAT THIS MIGRATION SHIPS ────────────────────────────────────
--
--   1. public.intake_packets — the new packet record. One row per
--      send-for-sig request OR per uploaded signed copy. Carries
--      the provider's coverage declaration via the linkage to
--      `acknowledgments.packet_id` (set 5 lines below).
--
--   2. acknowledgments.packet_id — nullable FK to intake_packets.
--      Every existing ack row stays valid (packet_id NULL =
--      free-standing, the current world). New packet writes stamp
--      the column.
--
--   3. consent_attachments — target_type CHECK extended to accept
--      'intake_packet'. A path-(b) uploaded signed copy attaches
--      to the packet row via this surface.
--
--   4. Parent SELECT policy on consent_attachments (mig 030)
--      walked to add the intake_packet branch — parents can see
--      attachments for their own children's packets, same EXISTS
--      shape as the existing acknowledgment branch.
--
--   5. intake_packet_confirm_for_parent RPC — MIRRORS mig 025's
--      intake_confirm_for_parent. Same archive + insert + resolve
--      transaction PLUS packet_id stamping + intake_packets status
--      update (pending_parent → signed). Separate function (not a
--      modified 025) so the legacy path keeps working unchanged.
--
-- ── HONESTY GUARDRAIL ────────────────────────────────────────────
--
-- Green must never be a bare checkbox. Enforcement points:
--
--   App layer (the load-bearing enforcement — write-time):
--     path (a): covering acks are written as
--       acknowledged_via='provider_override' (pending_parent until
--       parent signs); they CANNOT read on_file by themselves.
--     path (b): covering acks are written as
--       acknowledged_via='in_person_paper' only AFTER a
--       consent_attachments row with target_type='intake_packet'
--       and target_id=<packet.id> has been inserted. The write
--       helper (src/lib/intakePackets.js) refuses the ack-write
--       step when the attachment write didn't complete.
--
--   DB floor (defense in depth — row-level CHECK):
--     intake_packets_signed_shape — `status='signed'` implies
--     `signed_via IS NOT NULL` AND `signed_at IS NOT NULL`.
--     `status='pending_parent'` implies `signed_via IS NULL` (no
--     accidental "pending but already signed" state). The
--     attachment-exists half of the path-(b) guardrail is enforced
--     in app code only — a per-row CHECK that joins to a sibling
--     table isn't expressible in Postgres CHECK constraints, and a
--     deferred-constraint trigger is overkill for a capture model
--     that always writes packet → attachment → acks in one flow.
--
-- DEPENDENCY: applies AFTER migrations 024 (acknowledgments table),
-- 025 (intake_confirm_for_parent — we mirror its signature + auth
-- shape), 029 (consent_attachments substrate), 030 (parent SELECT
-- policy on consent_attachments).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────
-- CREATE TABLE / INDEX use IF NOT EXISTS. CREATE POLICY uses
-- DROP-then-CREATE (Postgres does not support IF NOT EXISTS on
-- CREATE POLICY — same pattern as migrations 024 / 028 / 029).
-- ALTER TABLE ADD CONSTRAINT uses DROP IF EXISTS first for the
-- CHECK extensions. CREATE OR REPLACE on the RPC.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────
-- Paste into the Supabase web SQL Editor and screenshot the
-- result BEFORE promoting the migration to Migration History.
--
--   -- a) intake_packets table + the signed-shape CHECK exist.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'intake_packets'
--    order by ordinal_position;
--   -- expect 16 rows.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.intake_packets'::regclass
--      and conname  = 'intake_packets_signed_shape';
--   -- expect 1 row; the CHECK references status / signed_via /
--   -- signed_at as documented above.
--
--   -- b) packet_id column on acknowledgments + the index.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'acknowledgments'
--      and column_name  = 'packet_id';
--   -- expect: 1 row — packet_id | uuid | YES.
--   select indexname from pg_indexes
--    where schemaname='public'
--      and tablename='acknowledgments'
--      and indexname='acknowledgments_packet_idx';
--   -- expect: 1 row.
--
--   -- c) consent_attachments target_type CHECK now accepts
--   --    'intake_packet' in addition to the prior two values.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.consent_attachments'::regclass
--      and conname  = 'chk_consent_attachments_target_type';
--   -- expect: definition contains 'intake_packet'.
--
--   -- d) Parent SELECT policy on consent_attachments has 4
--   --    EXISTS branches (the three from 030 + the new intake_packet).
--   select policyname, qual
--     from pg_policies
--    where schemaname='public'
--      and tablename='consent_attachments'
--      and policyname='Parents can list consent attachments for their children';
--   -- expect: qual contains 'intake_packets' (the new branch joins
--   --   through the new table).
--
--   -- e) Four RLS policies on intake_packets (3 provider + 1 parent).
--   select policyname, cmd
--     from pg_policies
--    where schemaname='public'
--      and tablename='intake_packets'
--    order by policyname;
--   -- expect 4 rows: parents-view + providers-view/insert/update;
--   --   no DELETE row (soft-delete via archived_at).
--
--   -- f) intake_packet_confirm_for_parent RPC exists.
--   select proname, pg_get_function_arguments(oid)
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'intake_packet_confirm_for_parent';
--   -- expect: one row; args = (p_child_id uuid, p_packet_id uuid,
--   --   p_rows jsonb).
--
--   -- g) Existing acks survived (packet_id NULL on every pre-041
--   --    row — every Aiden / Audrey row unchanged).
--   select count(*) as total_acks,
--          count(packet_id) as rows_with_packet_id
--     from public.acknowledgments
--    where archived_at is null;
--   -- expect: rows_with_packet_id = 0 immediately after this
--   --   migration applies.
-- ============================================================

-- -------------------------------------------------------
-- 1. intake_packets table
-- -------------------------------------------------------
create table if not exists public.intake_packets (
  id                   uuid primary key default gen_random_uuid(),
  provider_id          uuid not null references auth.users(id) on delete cascade,

  -- Polymorphic subject for forward compatibility — currently locked
  -- to 'child' by CHECK. A future packet for staff or medication
  -- intake would extend the CHECK with another value.
  subject_type         text not null
    constraint chk_intake_packets_subject_type
    check (subject_type in ('child')),
  subject_id           uuid not null references public.children(id) on delete cascade,

  -- Which capture path produced this packet.
  source               text not null
    constraint chk_intake_packets_source
    check (source in ('digital_signature_request', 'uploaded_signed_copy')),

  -- Lifecycle state. 'archived' is the soft-delete terminal — the
  -- archived_at timestamp is the canonical signal, this column
  -- mirrors it for UI / query convenience.
  status               text not null
    constraint chk_intake_packets_status
    check (status in ('pending_parent', 'signed', 'archived')),

  -- Signature evidence. NULL while pending_parent; populated when
  -- the packet is signed. signed_via mirrors the
  -- acknowledgments.acknowledged_via taxonomy so a packet's
  -- channel is read with the same vocabulary as its acks.
  signed_via           text
    constraint chk_intake_packets_signed_via
    check (signed_via is null or signed_via in (
      'parent_portal',
      'parent_portal_esign',
      'in_person_paper'
    )),
  signed_at            timestamptz,
  signed_by_user_id    uuid references auth.users(id) on delete set null,
  signed_by_label      text,

  -- Drift detection. The envelope-style hash composed from the
  -- covered sub-types' payload hashes. Lets a future migration
  -- detect when a signed packet's coverage diverged from the
  -- currently-required intake set (e.g. provider toggled
  -- home_built_before_1978 after signing). Phase A: written by
  -- the JS helper; the engine doesn't read it yet.
  snapshot_hash        text,

  -- Provider's free-text rationale on the packet — the audit
  -- explanation an inspector reads alongside the artifact /
  -- signature event.
  attestation_text     text,

  -- Soft-delete pair (CLAUDE.md never-hard-delete rule).
  archived_at          timestamptz,
  archived_by          uuid references auth.users(id) on delete set null,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- DB-floor honesty guardrail. Signed packets MUST carry their
  -- signature evidence; pending packets MUST NOT pretend to.
  constraint intake_packets_signed_shape check (
    case status
      when 'signed' then
        signed_via is not null
        and signed_at is not null
      when 'pending_parent' then
        signed_via is null
      else true
    end
  )
);

-- Hot-path lookup for the parent portal (find this child's pending
-- packet) + completeness queries.
create index if not exists intake_packets_subject_active_idx
  on public.intake_packets (subject_id) where archived_at is null;

create index if not exists intake_packets_provider_active_idx
  on public.intake_packets (provider_id) where archived_at is null;

-- One ACTIVE packet per child enforces single-packet semantics.
-- A re-send / re-upload soft-archives the prior packet first
-- (the JS helper handles this), mirroring the
-- acknowledgments_active_unique pattern.
create unique index if not exists intake_packets_one_active_per_child
  on public.intake_packets (subject_id)
  where archived_at is null;

drop trigger if exists intake_packets_set_updated_at on public.intake_packets;
create trigger intake_packets_set_updated_at
  before update on public.intake_packets
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 2. RLS — intake_packets
-- -------------------------------------------------------
alter table public.intake_packets enable row level security;

drop policy if exists "Providers can view their own intake packets" on public.intake_packets;
create policy "Providers can view their own intake packets"
  on public.intake_packets for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their own intake packets" on public.intake_packets;
create policy "Providers can insert their own intake packets"
  on public.intake_packets for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their own intake packets" on public.intake_packets;
create policy "Providers can update their own intake packets"
  on public.intake_packets for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- No DELETE policy — soft-delete via archived_at only.

-- Parents see packets for their own children. Mirrors the
-- existing acknowledgments / attendance_acknowledgments parent
-- SELECT shape: children → parent_family_links → auth.uid().
drop policy if exists "Parents can view intake packets for their children" on public.intake_packets;
create policy "Parents can view intake packets for their children"
  on public.intake_packets for select to authenticated
  using (
    subject_type = 'child'
    and exists (
      select 1
        from public.children c
        join public.parent_family_links pfl on pfl.family_id = c.family_id
       where c.id = intake_packets.subject_id
         and pfl.parent_id = auth.uid()
         and pfl.status = 'active'
    )
  );

-- -------------------------------------------------------
-- 3. acknowledgments.packet_id
-- -------------------------------------------------------
-- Nullable on purpose: every existing ack row stays valid
-- (packet_id NULL = free-standing, the world before this PR).
-- New packet writes stamp the column. ON DELETE SET NULL so an
-- archived/dropped packet (extreme edge case — no DELETE policy
-- ships) doesn't cascade-destroy audit-evidence ack rows.
alter table public.acknowledgments
  add column if not exists packet_id uuid references public.intake_packets(id) on delete set null;

create index if not exists acknowledgments_packet_idx
  on public.acknowledgments (packet_id) where packet_id is not null;

comment on column public.acknowledgments.packet_id is
  'When set, this ack row was created as part of an intake packet '
  '(mig 041). NULL on every pre-041 row and on any future ack '
  'written directly through the ChildIntakeModal per-element path. '
  'The nine intake resolvers in complianceState.js do not read this '
  'column — the packet model produces ack rows that already satisfy '
  'the existing resolvers; packet_id is metadata for display '
  'grouping in a future PR.';

-- -------------------------------------------------------
-- 4. consent_attachments — target_type CHECK extension
-- -------------------------------------------------------
-- 029 / 030 shipped target_type in ('acknowledgment',
-- 'medication_authorization'). This migration extends the CHECK to
-- accept the new packet target. The path-(b) upload writes a row
-- with target_type='intake_packet' + target_id=<packet.id>.
alter table public.consent_attachments
  drop constraint if exists chk_consent_attachments_target_type;

alter table public.consent_attachments
  add constraint chk_consent_attachments_target_type
  check (target_type in (
    'acknowledgment',
    'medication_authorization',
    'intake_packet'
  ));

-- -------------------------------------------------------
-- 5. Parent SELECT policy on consent_attachments — extend
-- -------------------------------------------------------
-- 030 shipped three EXISTS branches; this migration walks that
-- policy to add a fourth for intake_packet. Same EXISTS shape as
-- the existing acknowledgment branch — children → parent_family_links
-- → auth.uid().
drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;

create policy "Parents can list consent attachments for their children"
  on public.consent_attachments for select to authenticated
  using (
    -- Soft-delete parity (preserved from 030).
    consent_attachments.archived_at is null
    and (
      -- Path 1: target_type='acknowledgment' on a child-subject ack.
      (
        target_type = 'acknowledgment'
        and exists (
          select 1
            from public.acknowledgments a
            join public.children c on (a.subject_type = 'child' and c.id = a.subject_id)
            join public.parent_family_links pfl on pfl.family_id = c.family_id
           where a.id = consent_attachments.target_id
             and a.archived_at is null
             and pfl.parent_id = auth.uid()
             and pfl.status = 'active'
        )
      )
      or
      -- Path 2: target_type='acknowledgment' on a medication-
      --         permission ack (subject_type='medication_authorization'
      --         → join through medication_authorizations to find
      --         the child).
      (
        target_type = 'acknowledgment'
        and exists (
          select 1
            from public.acknowledgments a
            join public.medication_authorizations m on (
              a.subject_type = 'medication_authorization' and m.id = a.subject_id
            )
            join public.children c on c.id = m.child_id
            join public.parent_family_links pfl on pfl.family_id = c.family_id
           where a.id = consent_attachments.target_id
             and a.archived_at is null
             and m.archived_at is null
             and pfl.parent_id = auth.uid()
             and pfl.status = 'active'
        )
      )
      or
      -- Path 3: target_type='medication_authorization' direct.
      (
        target_type = 'medication_authorization'
        and exists (
          select 1
            from public.medication_authorizations m
            join public.children c on c.id = m.child_id
            join public.parent_family_links pfl on pfl.family_id = c.family_id
           where m.id = consent_attachments.target_id
             and m.archived_at is null
             and pfl.parent_id = auth.uid()
             and pfl.status = 'active'
        )
      )
      or
      -- Path 4: target_type='intake_packet' (NEW — mig 041). Parent
      -- sees the artifact attached to their own child's packet.
      (
        target_type = 'intake_packet'
        and exists (
          select 1
            from public.intake_packets ip
            join public.children c on c.id = ip.subject_id
            join public.parent_family_links pfl on pfl.family_id = c.family_id
           where ip.id = consent_attachments.target_id
             and ip.archived_at is null
             and ip.subject_type = 'child'
             and pfl.parent_id = auth.uid()
             and pfl.status = 'active'
        )
      )
    )
  );

-- -------------------------------------------------------
-- 6. intake_packet_confirm_for_parent RPC (mirrors mig 025)
-- -------------------------------------------------------
-- Same authorization + archive + insert + reminder-resolve shape as
-- intake_confirm_for_parent (mig 025), with two additions:
--   - Stamps the new acks with packet_id = p_packet_id.
--   - Updates the packet row: status='signed', signed_via='parent_portal',
--     signed_at=now(), signed_by_user_id=auth.uid().
-- All in one transaction.
--
-- A separate function (not a modified mig 025) so the legacy
-- non-packet send-to-portal path keeps working unchanged.
create or replace function public.intake_packet_confirm_for_parent(
  p_child_id  uuid,
  p_packet_id uuid,
  p_rows      jsonb
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
  -- ── Input sanity ─────────────────────────────────────────────
  if p_child_id is null then
    raise exception 'intake_packet_confirm_for_parent: p_child_id is required';
  end if;
  if p_packet_id is null then
    raise exception 'intake_packet_confirm_for_parent: p_packet_id is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'intake_packet_confirm_for_parent: p_rows must be a jsonb array';
  end if;
  if v_parent_id is null then
    raise exception 'intake_packet_confirm_for_parent: no authenticated caller';
  end if;

  -- ── 1) Authorization — caller is an active parent for the child ──
  -- Same auth shape as mig 025. Validates BEFORE any side effects.
  select c.user_id into v_provider_id
    from public.children c
    join public.parent_family_links pfl on pfl.family_id = c.family_id
   where c.id = p_child_id
     and c.archived_at is null
     and pfl.parent_id = v_parent_id
     and pfl.status    = 'active';

  if v_provider_id is null then
    raise exception 'intake_packet_confirm_for_parent: caller is not an active parent for this child, or child not found';
  end if;

  -- ── 2) Authorization — the packet belongs to that child + the
  --       same provider, and is currently pending_parent. A
  --       provider-only update or a typo'd packet_id would
  --       otherwise let a parent flip an unrelated packet.
  if not exists (
    select 1 from public.intake_packets ip
     where ip.id            = p_packet_id
       and ip.subject_type  = 'child'
       and ip.subject_id    = p_child_id
       and ip.provider_id   = v_provider_id
       and ip.status        = 'pending_parent'
       and ip.archived_at   is null
  ) then
    raise exception 'intake_packet_confirm_for_parent: packet not found / not pending / not for this child';
  end if;

  -- ── 3) Collect distinct types in the parent's payload ───────
  select array_agg(distinct (r->>'type'))
    into v_types
    from jsonb_array_elements(p_rows) as r
   where r ? 'type'
     and r->>'type' is not null
     and length(r->>'type') > 0;

  if v_types is null or array_length(v_types, 1) = 0 then
    raise exception 'intake_packet_confirm_for_parent: p_rows contains no rows with a valid type';
  end if;

  -- ── 4) Archive every active row of those types for this child ──
  -- Channel-AGNOSTIC: archives provider_override, in_person_paper,
  -- and any leftover parent_portal rows alike (same shape as mig
  -- 025's archive sweep).
  update public.acknowledgments
     set archived_at = now()
   where provider_id  = v_provider_id
     and subject_type = 'child'
     and subject_id   = p_child_id
     and archived_at  is null
     and type         = any(v_types);

  -- ── 5) Insert parent_portal rows. packet_id is stamped here so
  --       the new acks remain linked to their producing packet
  --       through the lifecycle flip.
  insert into public.acknowledgments (
    provider_id, type, subject_type, subject_id,
    acknowledged_by_user_id, acknowledged_by_label,
    acknowledged_via, acknowledged_at,
    provider_override_reason,
    snapshot_hash, snapshot_version,
    packet_id
  )
  select
    v_provider_id,
    r->>'type',
    'child',
    p_child_id,
    v_parent_id,
    null,
    'parent_portal',
    now(),
    null,
    r->>'snapshot_hash',
    r->>'snapshot_version',
    p_packet_id
  from jsonb_array_elements(p_rows) as r
   where r ? 'type'
     and r->>'type' is not null
     and length(r->>'type') > 0;

  get diagnostics v_inserted = row_count;

  -- ── 6) Flip the packet: pending_parent → signed. signed_via /
  --       signed_at / signed_by_user_id are SERVER-AUTHORITATIVE —
  --       the JS doesn't pick them.
  update public.intake_packets
     set status            = 'signed',
         signed_via        = 'parent_portal',
         signed_at         = now(),
         signed_by_user_id = v_parent_id
   where id = p_packet_id;

  -- ── 7) Resolve any pending intake_acknowledgment_pending
  --       reminder for this child (same shape as mig 025).
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

-- Engineering Discipline rule 4 — every SECURITY DEFINER function
-- gets the canonical revoke/grant trailer.
revoke all     on function public.intake_packet_confirm_for_parent(uuid, uuid, jsonb) from public;
revoke execute on function public.intake_packet_confirm_for_parent(uuid, uuid, jsonb) from anon;
grant  execute on function public.intake_packet_confirm_for_parent(uuid, uuid, jsonb) to authenticated;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Note: rolling this back does NOT delete uploaded objects from the
-- 'consent-attachments' bucket nor archive any in-progress packets.
-- ⚠️ DO NOT rollback if production packet rows or packet-stamped
-- ack rows exist — the audit trail requires preservation.
--
-- drop function if exists public.intake_packet_confirm_for_parent(uuid, uuid, jsonb);
--
-- -- Restore the 030 parent SELECT policy.
-- drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;
-- -- (re-create the 3-branch policy from 030 here)
--
-- -- Restore the 029 target_type CHECK.
-- alter table public.consent_attachments
--   drop constraint if exists chk_consent_attachments_target_type;
-- alter table public.consent_attachments
--   add constraint chk_consent_attachments_target_type
--   check (target_type in ('acknowledgment', 'medication_authorization'));
--
-- alter table public.acknowledgments
--   drop column if exists packet_id;
-- drop index if exists public.acknowledgments_packet_idx;
--
-- drop policy if exists "Parents can view intake packets for their children" on public.intake_packets;
-- drop policy if exists "Providers can update their own intake packets" on public.intake_packets;
-- drop policy if exists "Providers can insert their own intake packets" on public.intake_packets;
-- drop policy if exists "Providers can view their own intake packets"   on public.intake_packets;
-- drop trigger if exists intake_packets_set_updated_at on public.intake_packets;
-- drop index if exists public.intake_packets_one_active_per_child;
-- drop index if exists public.intake_packets_provider_active_idx;
-- drop index if exists public.intake_packets_subject_active_idx;
-- drop table if exists public.intake_packets;
