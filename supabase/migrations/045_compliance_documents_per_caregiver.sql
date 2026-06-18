-- ============================================================
-- MI Little Care — PR #17/#18 foundation: per-caregiver scoping
-- on compliance_documents + caregiver_physician_attestation doc type.
--
-- 2026-06-17. Backs the THREE per-caregiver staff-record compliance
-- rows the registry has carried as 'not_yet_modelled' since Phase 1:
--
--   caregiver_physician_attestation_at_renewal  R 400.1933        (THIS PR — wired end-to-end)
--     (registry key renamed from _annual on 2026-06-18 — R 400.1933
--      says "renewed at the time of subsequent license renewals,"
--      not annually. Resolver mechanism is unchanged; the rename
--      tracks the cadence semantics. Doc-type string is unchanged.)
--   caregiver_discipline_policy_ack_at_hire   R 400.1906(1)(e)(iii)  (next PR — design recorded below)
--   caregiver_daily_arrival_departure         R 400.1906        (next PR — design recorded below)
--
-- This migration ships only what the physician-attestation row needs.
-- The other two rows have different substrate requirements and ship
-- in follow-up PRs once the foundation here is proven by Seth's live-
-- gate. See the "FUTURE PR — design recorded" block at the bottom of
-- this header for the substrate plan we'll execute when those rows
-- ship.
--
-- FOUNDATION CHANGES (this PR):
--
--   1. ADD COLUMN compliance_documents.subject_caregiver_id uuid
--      (nullable, FK auth-cascaded). NULL = provider-level doc (the
--      pre-existing semantics for radon / heating / notebook / the
--      PR #21 inventory batch / the PR #19 ERP). NOT NULL = the
--      doc is scoped to one caregiver (this PR's physician
--      attestation, and the future PR's discipline-policy signed
--      copy if Seth wants storable evidence).
--
--   2. EXTEND chk_compliance_documents_document_type CHECK with
--      'caregiver_physician_attestation'. The doc-type CHECK now
--      lists 11 values (1 fingerprint + 4 property batch + 5
--      property inventory + 1 ERP + 1 caregiver attestation).
--
--   3. ADD INDEX compliance_documents_subject_caregiver_type_idx on
--      (subject_caregiver_id, document_type, uploaded_at DESC)
--      WHERE archived_at IS NULL AND subject_caregiver_id IS NOT NULL.
--      The per-caregiver resolver's primary read pattern is "give me
--      the latest non-archived doc of type X for caregiver Y"; this
--      index serves it directly. Filtered on subject_caregiver_id
--      IS NOT NULL so the provider-level read path (the existing
--      compliance_documents_user_id-only filter) is untouched.
--
-- WHAT THIS MIGRATION DOES NOT CHANGE:
--
--   - RLS posture on compliance_documents. The existing provider-
--     scoped policies (auth.uid() = user_id) continue to work — a
--     per-caregiver doc is still OWNED by the licensee (the
--     caregiver's licensee_id), so user_id-keyed RLS is still
--     correct. The subject_caregiver_id is an additional filter
--     for the resolver / UI, not an authorization key.
--
--   - The "auditor jwt denied" RESTRICTIVE policy on
--     compliance_documents. Migration 042's DO block sealed
--     compliance_documents at its apply time (the table existed at
--     042's apply time); no inline seal is needed here. New
--     TABLES would need one — this migration adds a column, not a
--     table.
--
--   - Storage RLS / bucket layout. The new
--     'caregiver_physician_attestation' document_type uses the
--     existing path shape `<user_id>/<document_type>/<uuid>.<ext>`
--     where <user_id> is the LICENSEE's id (not the caregiver's)
--     so the existing first-folder-segment storage policies still
--     authorize the read. The subject_caregiver_id lives only in
--     the metadata row, not in the storage path. Per-caregiver
--     bulk listing happens via the new index, not via storage
--     prefix scan.
--
-- DEPENDENCY: applies AFTER migration 044 (the prior superset of
-- the document_type CHECK and the auditor seal coverage on
-- drill_logs). Compatible with 042's universal RLS seal on
-- compliance_documents — that policy is unchanged.
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS for subject_caregiver_id.
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT for the document_type
--     CHECK swap, wrapped in the single BEGIN/COMMIT so no reader sees
--     an absent CHECK between the two statements.
--   - CREATE INDEX IF NOT EXISTS for the per-caregiver index.
--   - Re-applying the migration is a no-op.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Paste each query into the Supabase web SQL Editor and screenshot
-- the result BEFORE promoting the migration to Migration History.
--
--   -- (a) The subject_caregiver_id column exists, nullable, FK
--   --     to caregivers, ON DELETE CASCADE.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'compliance_documents'
--      and column_name = 'subject_caregiver_id';
--   -- expect: 1 row — subject_caregiver_id, uuid, YES.
--
--   -- (b) FK details (cascade behavior).
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and contype  = 'f'
--      and pg_get_constraintdef(oid) ilike '%subject_caregiver_id%';
--   -- expect: 1 row whose definition contains:
--   --   FOREIGN KEY (subject_caregiver_id) REFERENCES caregivers(id) ON DELETE CASCADE
--
--   -- (c) The CHECK now accepts caregiver_physician_attestation.
--   select pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: definition lists 11 doc_type values incl.
--   --   'caregiver_physician_attestation'.
--
--   -- (d) The per-caregiver index exists and is correctly filtered.
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'compliance_documents'
--      and indexname = 'compliance_documents_subject_caregiver_type_idx';
--   -- expect: indexdef contains
--   --   (subject_caregiver_id, document_type, uploaded_at DESC)
--   --   WHERE (archived_at IS NULL AND subject_caregiver_id IS NOT NULL).
--
--   -- (e) The auditor portal seal on compliance_documents still
--   --     reads the same — we did NOT add a second 'auditor jwt
--   --     denied' policy and did NOT touch the existing one.
--   select policyname, cmd, qual
--     from pg_policies
--    where schemaname='public' and tablename='compliance_documents'
--      and policyname='auditor jwt denied';
--   -- expect: 1 row, present from migration 042.
--
--   -- (f) Existing rows are untouched (subject_caregiver_id NULL
--   --     for the provider-level docs that existed pre-045).
--   select document_type,
--          count(*)                                     as total,
--          count(*) filter (where subject_caregiver_id is null) as provider_level,
--          count(*) filter (where subject_caregiver_id is not null) as caregiver_scoped
--     from public.compliance_documents
--    group by document_type
--    order by document_type;
--   -- expect: every row's subject_caregiver_id is NULL immediately
--   --   after this migration applies (the column was just added).
--
-- ROLLBACK (destructive — only run if rolling forward isn't possible):
--   -- ⚠️ If any caregiver-scoped row exists at rollback time, the
--   --   subject_caregiver_id column drop will lose that scoping
--   --   data. Archive caregiver-scoped rows first if you intend to
--   --   restore them on a re-apply.
--   alter table public.compliance_documents
--     drop constraint if exists chk_compliance_documents_document_type;
--   alter table public.compliance_documents
--     add constraint chk_compliance_documents_document_type
--     check (document_type in (
--       'fingerprint_reprint',
--       'property_radon_test',
--       'property_heating_inspection',
--       'property_licensing_notebook',
--       'property_co_detectors_per_level',
--       'property_smoke_detectors_per_floor',
--       'property_fire_extinguishers_per_floor',
--       'property_animal_notification',
--       'property_smoking_prohibition_posted',
--       'emergency_response_plan'
--     ));
--   drop index if exists public.compliance_documents_subject_caregiver_type_idx;
--   alter table public.compliance_documents
--     drop column if exists subject_caregiver_id;
--
-- ── FUTURE PR — design recorded (NOT shipped in this migration) ──
--
-- Substrate plan for the two remaining staff-file rows, recorded
-- here so the next PR (after Seth proves this foundation) follows a
-- pre-agreed path:
--
--   caregiver_discipline_policy_ack_at_hire (R 400.1906(1)(e)(iii))
--     SUBSTRATE: the existing `acknowledgments` table (mig 024).
--     `subject_type='caregiver'` is already in the polymorphic
--     subject CHECK (mig 024:176). `type='staff_discipline_policy_receipt'`
--     is already in `ACK_TYPES` (src/lib/acknowledgments.js:71). The
--     ack records WHO acknowledged + WHEN, with a snapshot_version
--     for staleness detection (the discipline policy version bumps
--     mechanic). NO new table or column needed.
--
--     OPTIONALLY also storable: the SIGNED COPY of the discipline
--     policy receipt as a per-caregiver compliance_documents row of
--     a new type `caregiver_discipline_policy_signed_copy` (uses
--     this PR's subject_caregiver_id + the same one-line CHECK
--     extension pattern). Stored only when the provider opts to
--     keep a digital copy; the ack itself is the load-bearing
--     evidence, the file is optional.
--
--     SHARED LOGIC WITH REMINDERS: the existing reminder category
--     `staff_discipline_policy_ack_pending` already computes the
--     "new hire owes ack" + "policy version bump invalidates" logic.
--     Same consistency pattern as the drills PR — the compliance
--     resolver will call shared helpers in
--     src/lib/disciplinePolicySchedule.js (TBD) which the reminder
--     scheduler will also call. Drift-prevention regression net
--     mirrors src/lib/drillSchedule.test.js.
--
--   caregiver_daily_arrival_departure (R 400.1906)
--     INVESTIGATION FINDING: `staff_time_entries` exists in
--     production (created out-of-band, no in-tree migration). It
--     captures `staff_user_id`, `licensee_id`, `clock_in`, GPS
--     coords + location status, `clock_out`. For caregivers WITH
--     an `app_user_id` set, the time-clock IS the daily arrival/
--     departure record per R 400.1906. The compliance row reads
--     `staff_time_entries` filtered by `staff_user_id =
--     caregiver.app_user_id`.
--
--     GAP — non-app-user caregivers: caregivers with
--     `app_user_id IS NULL` have no clock entries. Three options
--     for V1:
--       (i)  Manual daily log entry by the licensee (provider
--            types in arrival + departure times per caregiver per
--            day). Highest fidelity, highest friction.
--       (ii) "Kept on paper" attestation toggle (provider
--            confirms they keep a paper log; the compliance row
--            resolves to on_file via the attestation). Lowest
--            friction, weakest evidence — but matches the auditor's
--            reality for many small homes that have always kept
--            paper.
--       (iii) Required-day matrix (engine knows which days the
--             home was open AND which caregivers were on duty;
--             expects an entry per operating day per on-duty
--             caregiver). High complexity for V1 — defer.
--
--     RECOMMENDED V1: option (ii) attestation, surfaced as a
--     per-caregiver toggle in CaregiverTrainingLog. Phase 2 can
--     add option (i) for providers who want digital logs.
--
--     SUBSTRATE: this PR's `compliance_documents` table can host
--     the attestation as a doc_type
--     `caregiver_arrival_departure_paper_attestation` (one row
--     per caregiver, plaintext attestation in `notes`, no actual
--     file upload — the existence of the row IS the attestation).
--     Same one-line CHECK extension pattern. Date-keyed via
--     `next_due_on` for annual re-attestation.
--
--     This entire row is a separate PR; the recommendation is
--     recorded here for that PR's scope doc.
-- ============================================================

begin;

-- ─── 1. subject_caregiver_id column ───────────────────────────────
--
-- The foundation: every per-caregiver compliance_documents row
-- carries a non-null FK to caregivers; every provider-level row
-- keeps the NULL it has today.
alter table public.compliance_documents
  add column if not exists subject_caregiver_id uuid
    references public.caregivers(id) on delete cascade;

comment on column public.compliance_documents.subject_caregiver_id is
  'PR #17/#18 foundation (mig 045). NULL = provider-level document '
  '(radon, heating, notebook, ERP, the property inventory batch, '
  'fingerprint reprint). NOT NULL = per-caregiver document '
  '(physician attestation today; future: discipline policy signed '
  'copy, arrival/departure paper attestation). The licensee still '
  'OWNS the row (user_id), so RLS is unchanged; this column is an '
  'additional filter the resolver + UI use.';

-- ─── 2. document_type CHECK extension ─────────────────────────────
--
-- Drops the mig 044 ten-value CHECK and recreates it as an
-- eleven-value superset. New list is a strict superset — no row
-- is invalidated.
alter table public.compliance_documents
  drop constraint if exists chk_compliance_documents_document_type;

alter table public.compliance_documents
  add constraint chk_compliance_documents_document_type
  check (document_type in (
    'fingerprint_reprint',
    'property_radon_test',
    'property_heating_inspection',
    'property_licensing_notebook',
    'property_co_detectors_per_level',
    'property_smoke_detectors_per_floor',
    'property_fire_extinguishers_per_floor',
    'property_animal_notification',
    'property_smoking_prohibition_posted',
    'emergency_response_plan',
    'caregiver_physician_attestation'
  ));

-- ─── 3. Per-caregiver index ───────────────────────────────────────
--
-- Primary read pattern for the per-caregiver resolver: "give me
-- the latest non-archived doc of type T for caregiver C". The
-- WHERE clause keeps the index narrow — only per-caregiver rows
-- show up, so the provider-level read path's existing index
-- (compliance_documents_user_id_idx, mig 038) is unaffected by
-- this addition.
create index if not exists compliance_documents_subject_caregiver_type_idx
  on public.compliance_documents (subject_caregiver_id, document_type, uploaded_at desc)
  where archived_at is null and subject_caregiver_id is not null;

commit;

-- ============================================================
-- End of migration 045
-- ============================================================
