-- ============================================================
-- MI Little Care — Consent Attachments: scanned signed paper forms.
--
-- Authoritative scope: docs/pr-consent-attachments-scope.md
-- (FINAL 2026-06-02). This migration ships the data layer that lets
-- providers attach scanned/photographed copies of signed paper
-- consent forms to consent records across every consent surface
-- (intake bundle items per migration 024; Phase A field-trip +
-- photo per migration 024 catalog; Phase B time-bound per migrations
-- 024+026; Phase C per-occurrence per migration 027; medication
-- parent permission via PR #20's ACK_TYPES on migration 028's
-- tables).
--
-- DEPENDENCY: applies AFTER migration 028 (medication tables exist,
-- in case a future feature attaches scans directly to a
-- medication_authorization via the polymorphic
-- target_type='medication_authorization' branch). Also requires
-- migration 024's `parent_family_links → children → acknowledgments`
-- pattern that the parent-side metadata SELECT policy mirrors.
--
-- ── DESIGN DECISIONS (locked in pr-consent-attachments-scope.md) ──
--
--   1. Polymorphic target (decision 6) — `target_type text NOT NULL
--      CHECK IN ('acknowledgment','medication_authorization')` plus
--      `target_id uuid NOT NULL`. No DB-level FK on the polymorphic
--      reference; the app-side insert helper (`src/lib/consentAttachments.js`)
--      validates the target row exists before inserting. The Edge
--      Function re-validates on every read.
--   2. RLS — provider SELECT/INSERT/UPDATE only on the metadata
--      table (no DELETE policy; soft-delete via archived_at per the
--      CLAUDE.md never-hard-delete rule). Plus a parent SELECT-only
--      policy so the parent UI can list attachment METADATA — the
--      §12 sub-decision in the scope. The parent metadata policy
--      mirrors the Edge Function's child-resolution paths so a
--      parent cannot list attachments for a child they aren't
--      linked to. This is a second cross-tenant boundary alongside
--      the function; the verification gate proves both.
--   3. Storage bucket — `consent-attachments`, private, RLS template
--      from migrations 002/008. INSERT/SELECT/DELETE, no UPDATE
--      (objects immutable). Owner-only at the storage level (first
--      path segment = provider's auth.uid()). Parent content-read
--      goes through the Edge Function (service-role), NOT through
--      the storage RLS — explicitly chosen so the storage policy
--      stays the simple template every other bucket uses.
--   7. Retention — `retention_until date` defaulting to current_date
--      + 4 years per the funding-docs convention. Soft-delete via
--      archived_at. Storage object survives the archive. No
--      retention-sweep cron ships with this feature (same gap
--      funding-docs has).
--
-- ── BACKWARD-COMPAT INVARIANT ────────────────────────────────────────
-- Every existing table is UNTOUCHED. Zero ALTER on `acknowledgments`,
-- `medication_authorizations`, `medication_administration_events`,
-- the Phase B/C columns, the `acknowledgments_active_unique` partial
-- unique index, the existing RLS policies. The new table sits
-- beside them.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- CREATE TABLE / INDEX / FUNCTION use IF NOT EXISTS or OR REPLACE.
-- CREATE POLICY uses DROP-then-CREATE (Postgres does not support
-- IF NOT EXISTS on CREATE POLICY — same pattern as migrations 024
-- and 028). The bucket insert uses ON CONFLICT DO NOTHING.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- See docs/runbook.md § Pending Application — the runbook entry
-- carries the verification queries AND the four-test gate (provider
-- upload + provider read; linked parent metadata list + Edge
-- Function content read; cross-tenant parent denial — both via the
-- metadata RLS and via the Edge Function). The cross-tenant denial
-- (Test 4 in the runbook) is the privacy-boundary proof — it MUST
-- be run on real rows against real auth.
-- ============================================================

-- -------------------------------------------------------
-- 1. consent_attachments — metadata table
-- -------------------------------------------------------
create table if not exists public.consent_attachments (
  id                       uuid primary key default gen_random_uuid(),

  -- The licensee who owns the consent + the scan. Same denormalized
  -- pattern migration 024 uses for `acknowledgments.provider_id`.
  provider_id              uuid not null references auth.users(id) on delete cascade,

  -- ── Polymorphic target (decision 6) ─────────────────────────────
  -- `target_type` discriminator; `target_id` is the row id of the
  -- table named by `target_type`. NO DB-level FK on `target_id`
  -- (polymorphism precludes it). App-side validation in
  -- `src/lib/consentAttachments.js` + the Edge Function's
  -- resolution-to-child check guard against orphans.
  target_type              text not null
    constraint chk_consent_attachments_target_type
    check (target_type in ('acknowledgment', 'medication_authorization')),
  target_id                uuid not null,

  -- ── Storage pointer (modeled on funding_documents) ──────────────
  storage_path             text not null,
  original_filename        text not null,
  content_type             text not null,
  file_size_bytes          bigint not null check (file_size_bytes > 0),

  uploaded_at              timestamptz not null default now(),
  -- Separate from provider_id so a future staff seat can be the
  -- uploader without owning the row. Today these match in practice.
  uploaded_by_user_id      uuid references auth.users(id) on delete set null,

  -- 4-year default per the funding-docs convention. Editable per row
  -- for special cases (active dispute, longer-retention LEP records).
  retention_until          date not null default (current_date + interval '4 years')::date,

  -- Soft-delete pair (CLAUDE.md never-hard-delete rule).
  archived_at              timestamptz,
  archived_by              uuid references auth.users(id) on delete set null,

  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger consent_attachments_set_updated_at
  before update on public.consent_attachments
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------
-- 2. Indexes
-- -------------------------------------------------------
-- Hot path: list active attachments for a given consent target.
create index if not exists consent_attachments_target_active_idx
  on public.consent_attachments (target_type, target_id)
  where archived_at is null;

-- Provider's own roll-up reads.
create index if not exists consent_attachments_provider_active_idx
  on public.consent_attachments (provider_id)
  where archived_at is null;

-- Retention-sweep helper (same shape funding_documents uses). The
-- sweep cron itself is not built yet (named §13 in the scope doc as
-- an inherited future-item, not a blocker).
create index if not exists consent_attachments_retention_idx
  on public.consent_attachments (retention_until)
  where archived_at is not null;

-- -------------------------------------------------------
-- 3. RLS — provider-scoped + parent-metadata
-- -------------------------------------------------------
alter table public.consent_attachments enable row level security;

-- ── Provider policies (SELECT/INSERT/UPDATE; NO DELETE) ───────────

drop policy if exists "Providers can view their own consent attachments" on public.consent_attachments;
create policy "Providers can view their own consent attachments"
  on public.consent_attachments for select to authenticated
  using (provider_id = auth.uid());

drop policy if exists "Providers can insert their own consent attachments" on public.consent_attachments;
create policy "Providers can insert their own consent attachments"
  on public.consent_attachments for insert to authenticated
  with check (provider_id = auth.uid());

drop policy if exists "Providers can update their own consent attachments" on public.consent_attachments;
create policy "Providers can update their own consent attachments"
  on public.consent_attachments for update to authenticated
  using (provider_id = auth.uid())
  with check (provider_id = auth.uid());

-- No DELETE policy — soft-delete via UPDATE archived_at.

-- ── Parent metadata SELECT policy (§12 sub-decision) ──────────────
--
-- Parents need to LIST attachments for their own children's consents
-- in the parent portal so the UI can render "you have 2 signed
-- forms on file." This policy gives parents METADATA visibility
-- only (filename, uploaded date, etc.) — content read still goes
-- through the Edge Function `api/consent-attachment-url.js`, which
-- mints the signed URL after re-checking the same join.
--
-- The policy enumerates the three resolution paths the Edge
-- Function uses, and EVERY path checks `parent_family_links` →
-- `children` for the parent's auth.uid(). A parent cannot see
-- attachments for a child they aren't linked to via either path.
-- This is a second cross-tenant boundary alongside the function;
-- both must deny in the verification gate's Test 4.
--
-- The acknowledgment archived_at + medication_authorization
-- archived_at are checked in the EXISTS subqueries — an attachment
-- for an archived consent is NOT parent-visible (the consent isn't
-- in effect; the attachment shouldn't be surfaced).
drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;
create policy "Parents can list consent attachments for their children"
  on public.consent_attachments for select to authenticated
  using (
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
    -- Path 2: target_type='acknowledgment' on a medication-permission
    --         ack (subject_type='medication_authorization' → join
    --         through medication_authorizations to find the child).
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
    -- Path 3: target_type='medication_authorization' direct (reserved
    --         for a future feature that attaches scans of medication-
    --         plan documentation; no v1 UI exercises this branch but
    --         the policy is in place so the future feature is
    --         already covered without another migration).
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
  );

-- Any ack subject_type that isn't 'child' or 'medication_authorization'
-- (e.g. 'caregiver', 'family', 'provider', NULL) falls through every
-- EXISTS clause → no row visible to the parent. Mirrors migration
-- 024's parent-side `acknowledgments` SELECT policy which only
-- grants `subject_type='child'` access.

-- No parent INSERT / UPDATE / DELETE policies. Parents read
-- metadata only; writes are provider-driven.

-- -------------------------------------------------------
-- 4. Storage bucket — consent-attachments
-- -------------------------------------------------------
-- Private bucket. Same self-contained pattern as migrations 002 and
-- 008 — a single SQL paste sets up table + bucket + policies.
insert into storage.buckets (id, name, public)
values ('consent-attachments', 'consent-attachments', false)
on conflict (id) do nothing;

-- -------------------------------------------------------
-- 5. RLS — storage objects (provider-only at the storage level)
-- -------------------------------------------------------
-- INSERT / SELECT / DELETE, no UPDATE (objects immutable). Same
-- template migrations 002 and 008 use. Ownership is enforced via
-- the first path segment matching auth.uid() — providers can read
-- their own scans directly; parents do NOT match this template and
-- get RLS denials. Parent content-read goes through the Edge
-- Function, which uses service-role to bypass the storage RLS
-- after performing the explicit join-check in app code.
drop policy if exists "Providers can upload their own consent attachments" on storage.objects;
create policy "Providers can upload their own consent attachments"
  on storage.objects for insert
  with check (
    bucket_id = 'consent-attachments'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Providers can view their own consent attachments" on storage.objects;
create policy "Providers can view their own consent attachments"
  on storage.objects for select
  using (
    bucket_id = 'consent-attachments'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Providers can delete their own consent attachments" on storage.objects;
create policy "Providers can delete their own consent attachments"
  on storage.objects for delete
  using (
    bucket_id = 'consent-attachments'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Note: rolling this back does NOT delete uploaded objects from the
-- 'consent-attachments' bucket. Drop the bucket manually via the
-- Supabase dashboard if a clean wipe is intended; bucket deletion
-- requires the bucket to be empty first.
--
-- ⚠️ DO NOT rollback if production attachment rows exist — the
-- retention rule (4 years by default per the funding-docs
-- convention) requires preservation. Export the table first if
-- rollback is genuinely necessary.
--
-- drop policy if exists "Providers can delete their own consent attachments" on storage.objects;
-- drop policy if exists "Providers can view their own consent attachments" on storage.objects;
-- drop policy if exists "Providers can upload their own consent attachments" on storage.objects;
-- delete from storage.buckets where id = 'consent-attachments';
--
-- drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;
-- drop policy if exists "Providers can update their own consent attachments" on public.consent_attachments;
-- drop policy if exists "Providers can insert their own consent attachments" on public.consent_attachments;
-- drop policy if exists "Providers can view their own consent attachments" on public.consent_attachments;
-- drop trigger if exists consent_attachments_set_updated_at on public.consent_attachments;
-- drop index if exists public.consent_attachments_retention_idx;
-- drop index if exists public.consent_attachments_provider_active_idx;
-- drop index if exists public.consent_attachments_target_active_idx;
-- drop table if exists public.consent_attachments;
