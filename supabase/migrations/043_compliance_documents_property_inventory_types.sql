-- ============================================================
-- MI Little Care — Compliance Document Store: PR #21 inventory types.
--
-- 2026-06-17. Extends the compliance_documents substrate from
-- migrations 038 + 039 + 040 with the remaining property-records
-- document types from PR #21. These five rows were classified
-- "OUT — evidence type does NOT fit the doc store" in migration
-- 039's header (inventory / per-floor counts / boolean attestations).
-- This PR reverses that decision per a user-level product call:
-- a photo of the installed device, the posted sign, or a copy of
-- the parent notification IS a document and IS sufficient evidence
-- to flip the checklist row from "Not tracked / missing" to "on file."
--
-- The migration 039 deferral notes are preserved in that file as
-- historical context for why the rows started as Pattern E.
--
-- BATCH SCOPE (5 new document_type values, all added to
-- chk_compliance_documents_document_type):
--
--   property_co_detectors_per_level         R 400.1915(3)  Carbon-monoxide detectors per level
--   property_smoke_detectors_per_floor      R 400.1948     Smoke detectors per floor
--   property_fire_extinguishers_per_floor   R 400.1948     Fire extinguishers per floor (2A-10BC+)
--   property_animal_notification            R 400.1917     Animal/pet notification to parents
--   property_smoking_prohibition_posted     R 400.1918     Smoking/vaping prohibition posted
--
-- CITATION CORRECTIONS recorded in src/lib/complianceState.js as
-- part of the same PR. The pre-2026-06-17 registry shared a blanket
-- 'R 400.1934' citation (water hazards) across most property rows
-- during Phase 1 scaffolding; that placeholder was wrong for every
-- one. Source for each correction is the authoritative rule text
-- and the repo's docs/regulatory-rule-mapping.md crosswalk.
--
--   Row                                       Old cite                  Correct cite      Source
--   ----------------------------------------- ------------------------- ----------------- ---------------------------
--   property_animal_notification              R 400.1937 (food allergy) R 400.1917        docs/regulatory-rule-mapping.md
--   property_smoking_prohibition_posted       R 400.1934 (water)        R 400.1918        docs/regulatory-rule-mapping.md
--   property_fire_extinguishers_per_floor     R 400.1934 (water)        R 400.1948        docs/regulatory-rule-mapping.md
--   property_smoke_detectors_per_floor        R 400.1934 (water)        R 400.1948        docs/regulatory-rule-mapping.md
--   property_co_detectors_per_level           R 400.1934 (water)        R 400.1915(3)     R 400.1915 'Heating; ventilation; lighting; radon' subrule (3) — CO is grouped with its hazard source (combustion / heating), NOT with smoke + fire detectors (R 400.1948). The earlier 2026-06-17 in-PR attempt to cite 'R 400.1934(3)' (assuming CO was a subrule of water hazards) was a wrong-rule guess based on the existing placeholder; user-provided rule text corrected it to 1915(3).
--
-- DEPENDENCY: applies AFTER migration 039 (the prior superset of the
-- CHECK). Compatible with migration 040 — the optional next_due_on
-- column is unused for these rows (none are cycle-tracked; the
-- attestation/photo doesn't expire on a cycle).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- The constraint swap is wrapped in a single transaction:
-- DROP CONSTRAINT + ADD CONSTRAINT in lock-step so a reader between
-- the two statements never sees a constraint with the wrong list.
-- Both statements are idempotent on their own; the new list is a
-- SUPERSET of the prior, so re-running the migration is a no-op.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Paste into the Supabase web SQL Editor and screenshot the result
-- BEFORE promoting the migration to Migration History (DB-is-source-
-- of-truth process note in the runbook).
--
--   -- a) The CHECK exists and now accepts all nine values.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: definition is
--   --   CHECK (document_type = ANY (ARRAY[
--   --     'fingerprint_reprint'::text,
--   --     'property_radon_test'::text,
--   --     'property_heating_inspection'::text,
--   --     'property_licensing_notebook'::text,
--   --     'property_co_detectors_per_level'::text,
--   --     'property_smoke_detectors_per_floor'::text,
--   --     'property_fire_extinguishers_per_floor'::text,
--   --     'property_animal_notification'::text,
--   --     'property_smoking_prohibition_posted'::text
--   --   ]))
--
--   -- b) Existing data still satisfies the CHECK (no row invalidated).
--   select count(*) as rows_total,
--          count(*) filter (where document_type = 'fingerprint_reprint')                    as fingerprint,
--          count(*) filter (where document_type = 'property_radon_test')                    as radon,
--          count(*) filter (where document_type = 'property_heating_inspection')            as heating,
--          count(*) filter (where document_type = 'property_licensing_notebook')            as notebook,
--          count(*) filter (where document_type = 'property_co_detectors_per_level')        as co_detectors,
--          count(*) filter (where document_type = 'property_smoke_detectors_per_floor')     as smoke_detectors,
--          count(*) filter (where document_type = 'property_fire_extinguishers_per_floor')  as fire_extinguishers,
--          count(*) filter (where document_type = 'property_animal_notification')           as animal_notice,
--          count(*) filter (where document_type = 'property_smoking_prohibition_posted')    as smoking_sign
--     from public.compliance_documents;
--   -- expect: no error. The five new columns are 0 immediately after
--   --   this migration applies; the prior four match the existing
--   --   live-gate counts.
--
-- ============================================================

begin;

-- Drop the migration 039 four-value CHECK and recreate it with the
-- nine-value list. Postgres validates ALL existing rows against the
-- new CHECK on ADD — the new list is a strict superset, so this is
-- always safe.
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
    'property_smoking_prohibition_posted'
  ));

commit;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Reverting to the migration 039 four-value CHECK. ⚠️ If any rows
-- of the five new types exist in production at rollback time, the
-- ADD CONSTRAINT will fail (the rows would violate the narrower
-- CHECK). Same emergency-only-path guidance as migration 039's
-- DOWN section applies; treat any real rollback as destructive.
--
-- begin;
--   alter table public.compliance_documents
--     drop constraint if exists chk_compliance_documents_document_type;
--   alter table public.compliance_documents
--     add constraint chk_compliance_documents_document_type
--     check (document_type in (
--       'fingerprint_reprint',
--       'property_radon_test',
--       'property_heating_inspection',
--       'property_licensing_notebook'
--     ));
-- commit;
