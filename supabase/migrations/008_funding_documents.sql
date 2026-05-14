-- ============================================================
-- MI Little Care — Phase 4: Funding Document Vault
--
-- Stores compliance documents (DHS-198 letters, Enrollment Agreements,
-- and other supporting materials) attached to funding_sources rows.
-- See docs/funding_source_spec.md.
--
-- Storage layout:
--   bucket: funding-documents (private)
--   path:   <user_id>/<funding_source_id>/<uuid>.<ext>
--   The <funding_source_id> middle segment is intentional — it makes
--   per-source bulk listing trivial for future audit-export features.
--   The first segment (<user_id>) is what storage RLS keys off of, via
--   the same (storage.foldername(name))[1] template used by migration
--   002 for the receipts bucket.
--
-- Retention:
--   retention_until defaults to current_date + 4 years per the CDC
--   handbook for licensed providers. Editable per row for special
--   cases. License-exempt providers may need a longer window — the
--   exact MiLEAP-specified number is not yet confirmed; tracked in
--   docs/tech_debt.md.
--
-- Cascade behavior on parent archive:
--   When a funding_source.archived_at is set, its attached documents
--   remain non-archived for audit retention — their archived_at stays
--   null. The UI filters them out by default and surfaces them via the
--   same "Show archived" toggle pattern used for funding sources.
--
-- Retention vs soft-delete:
--   Documents are never hard-deleted by user action. The funding_documents
--   RLS policy set deliberately omits DELETE — soft-delete is performed
--   by setting archived_at via an UPDATE. A future retention-sweep job
--   can purge rows where archived_at is set AND retention_until has
--   passed; that job runs server-side, outside RLS.
-- ============================================================

-- -------------------------------------------------------
-- 1. Enum
-- -------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'funding_document_type') then
    create type public.funding_document_type as enum (
      'dhs_198',
      'enrollment_agreement',
      'other'
    );
  end if;
end$$;

-- -------------------------------------------------------
-- 2. funding_documents table
-- -------------------------------------------------------
create table if not exists public.funding_documents (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references auth.users(id) on delete cascade not null,

  -- on delete set null: preserve the audit row even if the parent
  -- funding source is hard-deleted by a future ops mistake. The
  -- document remains queryable by user_id for the retention window.
  funding_source_id     uuid references public.funding_sources(id) on delete set null,

  document_type         public.funding_document_type not null,

  -- Storage pointer. <user_id>/<funding_source_id>/<uuid>.<ext>
  storage_path          text not null,
  original_filename     text not null,
  content_type          text not null,
  file_size_bytes       bigint not null check (file_size_bytes > 0),

  uploaded_at           timestamptz not null default now(),
  -- Separate from user_id so a future staff seat can be the uploader
  -- without owning the row. Today these will match in practice.
  uploaded_by_user_id   uuid references auth.users(id) on delete set null,

  -- 4-year default per CDC handbook for licensed providers. Editable.
  retention_until       date not null default (current_date + interval '4 years')::date,

  -- Soft-delete pair: matches the archived_at + archived_by convention
  -- introduced by migrations 003/007 on funding_sources.
  archived_at           timestamptz,
  archived_by           uuid references auth.users(id) on delete set null,

  notes                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- -------------------------------------------------------
-- 3. Indexes
-- -------------------------------------------------------
create index if not exists funding_documents_user_idx
  on public.funding_documents(user_id);

-- Active docs for a given funding source — the hot-path lookup for
-- the FundingDocumentSlot component.
create index if not exists funding_documents_source_active_idx
  on public.funding_documents(funding_source_id, document_type)
  where archived_at is null;

-- DB-level backstop: at most one active DHS-198 and one active
-- Enrollment Agreement per funding source. 'other' is excluded so
-- multiple Other attachments per source remain valid.
--
-- Implication for the UI "Replace document" flow: the operation must
-- be archive-old-then-insert-new (not insert-then-archive), or this
-- constraint trips. Wrap the two writes in a single transaction so a
-- failed insert leaves the old row active rather than orphaning the
-- source with no document.
create unique index if not exists funding_documents_one_active_per_type
  on public.funding_documents(funding_source_id, document_type)
  where archived_at is null and document_type <> 'other';

-- Retention sweep support: find expired archived rows efficiently.
create index if not exists funding_documents_retention_idx
  on public.funding_documents(retention_until)
  where archived_at is not null;

-- -------------------------------------------------------
-- 4. RLS — table
-- -------------------------------------------------------
-- select / insert / update only. No delete policy: soft-delete is
-- performed by setting archived_at via UPDATE.
alter table public.funding_documents enable row level security;

create policy "Users can view their own funding documents"
  on public.funding_documents for select
  using (auth.uid() = user_id);

create policy "Users can insert their own funding documents"
  on public.funding_documents for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own funding documents"
  on public.funding_documents for update
  using (auth.uid() = user_id);

create trigger set_funding_documents_updated_at
  before update on public.funding_documents
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- 5. Storage bucket
-- -------------------------------------------------------
-- Private bucket. Same self-contained pattern as migration 002 — a
-- single SQL paste sets up table + bucket + policies.
insert into storage.buckets (id, name, public)
values ('funding-documents', 'funding-documents', false)
on conflict (id) do nothing;

-- -------------------------------------------------------
-- 6. RLS — storage objects
-- -------------------------------------------------------
-- insert / select / delete only. No update policy: storage objects
-- are immutable. A "replace" in the UI is a new upload + new metadata
-- row + soft-archive of the old metadata row; the old object remains
-- in the bucket for the retention window.
--
-- Ownership is enforced via the first path segment matching auth.uid()
-- — exact same template as migration 002's receipts policies.
create policy "Users can upload their own funding documents"
  on storage.objects for insert
  with check (
    bucket_id = 'funding-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can view their own funding documents"
  on storage.objects for select
  using (
    bucket_id = 'funding-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own funding documents"
  on storage.objects for delete
  using (
    bucket_id = 'funding-documents'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Note: rolling this back does NOT delete uploaded objects from the
-- 'funding-documents' bucket. Drop the bucket manually via the
-- Supabase dashboard if a clean wipe is intended; bucket deletion
-- requires the bucket to be empty first.
--
-- drop policy if exists "Users can delete their own funding documents" on storage.objects;
-- drop policy if exists "Users can view their own funding documents" on storage.objects;
-- drop policy if exists "Users can upload their own funding documents" on storage.objects;
-- delete from storage.buckets where id = 'funding-documents';
--
-- drop trigger if exists set_funding_documents_updated_at on public.funding_documents;
-- drop policy if exists "Users can update their own funding documents" on public.funding_documents;
-- drop policy if exists "Users can insert their own funding documents" on public.funding_documents;
-- drop policy if exists "Users can view their own funding documents" on public.funding_documents;
-- drop index if exists public.funding_documents_retention_idx;
-- drop index if exists public.funding_documents_one_active_per_type;
-- drop index if exists public.funding_documents_source_active_idx;
-- drop index if exists public.funding_documents_user_idx;
-- drop table if exists public.funding_documents;
-- drop type if exists public.funding_document_type;
