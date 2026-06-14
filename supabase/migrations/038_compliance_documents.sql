-- ============================================================
-- MI Little Care — Compliance Document Store (provider-level).
--
-- Phase A of the G4 fingerprint-reprint upload feature
-- (cdc_fingerprint_reprint_currency), and the shared substrate for
-- future per-provider compliance evidence uploads — PR #21 property
-- records (radon test, heating inspection, etc.) and PR #18 staff
-- file gaps (physician attestation, discipline policy acknowledgment).
--
-- DESIGN DECISIONS (locked in the 2026-06-14 G4 investigation report
-- + the audit's NO-WRITER classification of `fingerprint_date` —
-- commit 345b284 / 441efc5):
--
--   1. Provider-level scope. Unlike `funding_documents` (008, FK to
--      funding_sources) and `consent_attachments` (029, polymorphic
--      target_type), this store has NO parent row — the document is
--      associated with the licensee directly. No funding_source_id,
--      no target_type discriminator on a parent table.
--   2. `document_type text` + CHECK constraint, NOT a Postgres enum.
--      Enums force a type alteration on every new accepted value;
--      the CHECK pattern (which `consent_attachments.target_type`
--      already uses, 029:90-92) lets a future migration extend the
--      list with a single `alter table ... drop constraint ... add
--      constraint ...`. Designed to grow:
--        Phase A ships : 'fingerprint_reprint'
--        Future          : 'property_radon', 'property_heating',
--                          'property_co_detectors',
--                          'staff_physician_attestation',
--                          'staff_discipline_policy_ack', ...
--   3. Column shape mirrors `funding_documents` (008) verbatim where
--      it applies — same storage_path / original_filename /
--      content_type / file_size_bytes / uploaded_at /
--      uploaded_by_user_id / retention_until (4-year default) /
--      archived_at / archived_by / notes / created_at / updated_at.
--      A future generalized DocumentSlot component reads from both
--      tables without per-domain branching.
--   4. NO database-level "one active per type" uniqueness. Some
--      future types (property_radon_test) will produce many active
--      rows over time (one per inspection cycle); some (the
--      fingerprint_reprint case) are single-instance. The slot UI
--      handles single-instance semantics via the archive-then-insert
--      "Replace" flow already proven in FundingDocumentSlot. The DB
--      stays maximally flexible.
--   5. Three table RLS policies (view / insert / update on
--      auth.uid() = user_id). NO DELETE policy — soft-delete via
--      archived_at on UPDATE, the convention established by
--      migrations 003 / 007 / 008 / 024 / 028 / 029. Three storage
--      policies (insert / select / delete) keyed on
--      `(storage.foldername(name))[1] = auth.uid()` — the same
--      template migrations 002 / 008 / 029 use.
--
-- Storage layout:
--   bucket: compliance-documents (private)
--   path:   <user_id>/<document_type>/<uuid>.<ext>
--
--   The `<document_type>` middle segment (where 008 puts
--   `<funding_source_id>`) makes per-type bulk listing trivial.
--   The first segment `<user_id>` is what storage RLS keys off,
--   via the same `(storage.foldername(name))[1]` template every
--   other bucket on this codebase uses.
--
-- Retention:
--   `retention_until` defaults to current_date + 4 years per the
--   CDC funding-docs convention (008:78). Editable per row. A future
--   retention-sweep job (out of scope here, same gap funding-docs +
--   consent-attachments inherit) can purge rows where archived_at
--   is set AND retention_until has passed.
--
-- DEPENDENCY: stands alone. No FK to any other in-tree table beyond
-- `auth.users`. Safe to apply at any time after migration 002 (the
-- `storage.objects` template originates there).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- CREATE TABLE / INDEX use IF NOT EXISTS. CREATE POLICY uses
-- DROP-then-CREATE because Postgres does not support IF NOT EXISTS
-- on CREATE POLICY (same pattern as migrations 024 / 028 / 029).
-- CREATE TRIGGER uses DROP-then-CREATE for the same reason.
-- Bucket insert uses ON CONFLICT DO NOTHING.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Per docs/tech_debt.md § "Verification gap discovered 2026-05-15"
-- and the 2026-06-13 DB-is-source-of-truth process note in the
-- runbook: paste each query into the Supabase web SQL Editor and
-- screenshot the result BEFORE writing the runbook Migration History
-- entry.
--
--   -- a) Table exists with the expected columns.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'compliance_documents'
--    order by ordinal_position;
--   -- expect 14 rows (id, user_id, document_type, storage_path,
--   --   original_filename, content_type, file_size_bytes,
--   --   uploaded_at, uploaded_by_user_id, retention_until,
--   --   archived_at, archived_by, notes, created_at, updated_at).
--   -- 15 if you count updated_at separately — table definition
--   -- below is the canonical list.
--
--   -- b) The document_type CHECK exists and currently accepts
--   --    exactly one value.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: CHECK (document_type IN ('fingerprint_reprint'))
--
--   -- c) The three table-level RLS policies exist.
--   select policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and tablename  = 'compliance_documents'
--    order by policyname;
--   -- expect 3 rows: insert / select / update — all keyed on
--   -- auth.uid() = user_id. NO delete row.
--
--   -- d) The storage bucket exists, private.
--   select id, name, public from storage.buckets
--    where id = 'compliance-documents';
--   -- expect: 1 row, public = false.
--
--   -- e) The three storage RLS policies exist on storage.objects.
--   select policyname, cmd
--     from pg_policies
--    where schemaname = 'storage'
--      and tablename  = 'objects'
--      and policyname ilike '%compliance documents%'
--    order by policyname;
--   -- expect 3 rows: insert / select / delete. NO update row.
--
--   -- f) No existing data is affected (the table is new).
--   select count(*) from public.compliance_documents;
--   -- expect: 0.
-- ============================================================

-- -------------------------------------------------------
-- 1. compliance_documents table
-- -------------------------------------------------------
create table if not exists public.compliance_documents (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references auth.users(id) on delete cascade not null,

  -- Designed to GROW. Add new values via a follow-up migration that
  -- drops + re-adds chk_compliance_documents_document_type with the
  -- expanded list (the same single-statement maintenance shape the
  -- consent_attachments.target_type CHECK uses, 029:90-92).
  document_type         text not null
    constraint chk_compliance_documents_document_type
    check (document_type in (
      'fingerprint_reprint'
    )),

  storage_path          text not null,
  original_filename     text not null,
  content_type          text not null,
  file_size_bytes       bigint not null check (file_size_bytes > 0),

  uploaded_at           timestamptz not null default now(),
  -- Separate from user_id so a future staff seat can be the uploader
  -- without owning the row. Today these match in practice.
  uploaded_by_user_id   uuid references auth.users(id) on delete set null,

  -- 4-year default per the funding-docs convention (008:78). Editable
  -- per row for special cases.
  retention_until       date not null default (current_date + interval '4 years')::date,

  -- Soft-delete pair (CLAUDE.md never-hard-delete rule for
  -- audit-retention data).
  archived_at           timestamptz,
  archived_by           uuid references auth.users(id) on delete set null,

  notes                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- -------------------------------------------------------
-- 2. Indexes
-- -------------------------------------------------------
create index if not exists compliance_documents_user_idx
  on public.compliance_documents(user_id);

-- Active docs per (user, type) — the hot-path lookup for the
-- DocumentSlot component (one query per slot render).
create index if not exists compliance_documents_user_active_type_idx
  on public.compliance_documents(user_id, document_type)
  where archived_at is null;

-- Retention sweep support (same shape as funding_documents 008).
create index if not exists compliance_documents_retention_idx
  on public.compliance_documents(retention_until)
  where archived_at is not null;

-- -------------------------------------------------------
-- 3. RLS — table
-- -------------------------------------------------------
-- select / insert / update only. NO delete policy: soft-delete is
-- performed by setting archived_at via UPDATE.
alter table public.compliance_documents enable row level security;

drop policy if exists "Users can view their own compliance documents" on public.compliance_documents;
create policy "Users can view their own compliance documents"
  on public.compliance_documents for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own compliance documents" on public.compliance_documents;
create policy "Users can insert their own compliance documents"
  on public.compliance_documents for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own compliance documents" on public.compliance_documents;
create policy "Users can update their own compliance documents"
  on public.compliance_documents for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop trigger if exists set_compliance_documents_updated_at on public.compliance_documents;
create trigger set_compliance_documents_updated_at
  before update on public.compliance_documents
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 4. Storage bucket — compliance-documents
-- -------------------------------------------------------
-- Private bucket. Same self-contained pattern as migrations 002 /
-- 008 / 029 — a single SQL paste sets up table + bucket + policies.
insert into storage.buckets (id, name, public)
values ('compliance-documents', 'compliance-documents', false)
on conflict (id) do nothing;

-- -------------------------------------------------------
-- 5. RLS — storage objects
-- -------------------------------------------------------
-- insert / select / delete only. No update policy: storage objects
-- are immutable. A "replace" in the UI is a new upload + new
-- metadata row + soft-archive of the old metadata row; the old
-- object remains in the bucket for the retention window.
--
-- Ownership is enforced via the first path segment matching
-- auth.uid() — exact same template as migrations 002 / 008 / 029.
drop policy if exists "Users can upload their own compliance documents" on storage.objects;
create policy "Users can upload their own compliance documents"
  on storage.objects for insert
  with check (
    bucket_id = 'compliance-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can view their own compliance documents" on storage.objects;
create policy "Users can view their own compliance documents"
  on storage.objects for select
  using (
    bucket_id = 'compliance-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can delete their own compliance documents" on storage.objects;
create policy "Users can delete their own compliance documents"
  on storage.objects for delete
  using (
    bucket_id = 'compliance-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Note: rolling this back does NOT delete uploaded objects from the
-- 'compliance-documents' bucket. Drop the bucket manually via the
-- Supabase dashboard if a clean wipe is intended; bucket deletion
-- requires the bucket to be empty first.
--
-- ⚠️ DO NOT rollback if production document rows exist — the
-- retention rule (4 years by default per the funding-docs
-- convention) requires preservation. Export the table first if
-- rollback is genuinely necessary.
--
-- drop policy if exists "Users can delete their own compliance documents" on storage.objects;
-- drop policy if exists "Users can view their own compliance documents"   on storage.objects;
-- drop policy if exists "Users can upload their own compliance documents" on storage.objects;
-- delete from storage.buckets where id = 'compliance-documents';
--
-- drop trigger if exists set_compliance_documents_updated_at on public.compliance_documents;
-- drop policy if exists "Users can update their own compliance documents" on public.compliance_documents;
-- drop policy if exists "Users can insert their own compliance documents" on public.compliance_documents;
-- drop policy if exists "Users can view their own compliance documents"   on public.compliance_documents;
-- drop index if exists public.compliance_documents_retention_idx;
-- drop index if exists public.compliance_documents_user_active_type_idx;
-- drop index if exists public.compliance_documents_user_idx;
-- drop table if exists public.compliance_documents;
