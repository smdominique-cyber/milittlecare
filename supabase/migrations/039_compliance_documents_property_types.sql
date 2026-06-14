-- ============================================================
-- MI Little Care — Compliance Document Store: property doc types.
--
-- Phase A batch (2026-06-14) extends the compliance_documents
-- substrate from migration 038 with the property-records document
-- types whose evidence is genuinely a static document an auditor
-- can leaf through.
--
-- BATCH SCOPE (Step 0 classification from the
-- feature/compliance-documents-batch PR):
--
--   IN — added to the chk_compliance_documents_document_type CHECK:
--     property_radon_test          (radon-test report from a tester)
--     property_heating_inspection  (HVAC/heating inspection report)
--     property_licensing_notebook  (the home's licensing notebook —
--                                   a binder/PDF of past licensing
--                                   correspondence and reports)
--
--   OUT — evidence type does NOT fit the doc store; left as
--     Pattern E feature-not-yet-shipped until a fitting capture
--     surface ships:
--       property_co_detectors_per_level         (per-level inventory,
--                                                not a document)
--       property_smoke_detectors_per_floor      (same — count per floor)
--       property_fire_extinguishers_per_floor   (same — count + rating)
--       property_animal_notification            (per-parent notification,
--                                                not a single uploaded
--                                                file)
--       property_smoking_prohibition_posted     (posted-sign attestation,
--                                                a boolean not a document)
--
--   DEFERRED — DOCUMENT-shaped but the substrate would need a
--     per-caregiver scoping column (subject_caregiver_id) before
--     they fit cleanly. Reported as follow-up; not in this PR.
--       caregiver_physician_attestation_annual
--       caregiver_discipline_policy_ack_at_hire
--
--   OUT — not document-shaped at all:
--       caregiver_daily_arrival_departure       (recurring log, not
--                                                a single doc)
--       drill_*                                 (logs, not docs)
--
-- The four drill rows include `emergency_response_plan_on_file`
-- which IS document-shaped despite being in the drills category;
-- the task brief did not enumerate it. Flagged as a clean future
-- addition — the same one-line CHECK-extension migration adds it
-- alongside any future doc type.
--
-- DEPENDENCY: applies AFTER migration 038 (the substrate itself).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- The constraint swap is wrapped in a single transaction:
-- DROP CONSTRAINT + ADD CONSTRAINT in lock-step so a reader between
-- the two statements never sees a constraint with the wrong list.
-- Both statements are idempotent on their own (the IF EXISTS / the
-- new name is the same as the old name, so re-running the migration
-- replaces the constraint with itself).
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Paste into the Supabase web SQL Editor and screenshot the result
-- BEFORE promoting the migration to Migration History (DB-is-source-
-- of-truth process note in the runbook).
--
--   -- a) The CHECK exists and now accepts all four values.
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: definition is
--   --   CHECK (document_type = ANY (ARRAY[
--   --     'fingerprint_reprint'::text,
--   --     'property_radon_test'::text,
--   --     'property_heating_inspection'::text,
--   --     'property_licensing_notebook'::text
--   --   ]))
--   --   (Postgres normalizes IN (...) to ANY(ARRAY[...]); the
--   --    semantic is identical to the IN form below.)
--
--   -- b) Existing data still satisfies the CHECK (no row was
--   --    invalidated by the swap).
--   select count(*) as rows_total,
--          count(*) filter (where document_type = 'fingerprint_reprint') as fingerprint,
--          count(*) filter (where document_type = 'property_radon_test') as radon,
--          count(*) filter (where document_type = 'property_heating_inspection') as heating,
--          count(*) filter (where document_type = 'property_licensing_notebook') as notebook
--     from public.compliance_documents;
--   -- expect: no error. fingerprint may be > 0 if G4 has been
--   --   live-gated; the other three are 0 immediately after this
--   --   migration applies.
-- ============================================================

begin;

-- Drop the Phase A (038) constraint and recreate it with the
-- extended value list. Postgres validates ALL existing rows
-- against the new CHECK on ADD — so if a value was somehow
-- inserted that's no longer accepted, this would error. The new
-- list is a SUPERSET of the old, so this is always safe.
alter table public.compliance_documents
  drop constraint if exists chk_compliance_documents_document_type;

alter table public.compliance_documents
  add constraint chk_compliance_documents_document_type
  check (document_type in (
    'fingerprint_reprint',
    'property_radon_test',
    'property_heating_inspection',
    'property_licensing_notebook'
  ));

commit;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Reverting to the 038 single-value CHECK. ⚠️ If any rows of the
-- three new types exist in production at rollback time, the ADD
-- CONSTRAINT will fail (the rows would violate the narrower CHECK).
-- Archive them first via:
--
--   update public.compliance_documents
--      set archived_at = now()
--    where document_type in (
--      'property_radon_test',
--      'property_heating_inspection',
--      'property_licensing_notebook'
--    ) and archived_at is null;
--
-- The archived rows still violate the narrower CHECK, so a real
-- rollback also requires either DELETE of those rows (destroys
-- audit data — almost certainly wrong) or temporarily disabling
-- the constraint. Treat this rollback as an emergency-only path.
--
-- begin;
--   alter table public.compliance_documents
--     drop constraint if exists chk_compliance_documents_document_type;
--   alter table public.compliance_documents
--     add constraint chk_compliance_documents_document_type
--     check (document_type in ('fingerprint_reprint'));
-- commit;
