-- ============================================================
-- MI Little Care — Compliance Document Store: next_due_on column.
--
-- Phase A cycle-tracking for the recurring property document rows
-- (radon every 4 years per R 400.1934/1932, heating inspection every
-- 4 years per R 400.1932). Adds a single nullable column the
-- DocumentSlot writes from a provider-entered date input — no cycle
-- math in the resolver, just a straight today-vs-next-due
-- comparison.
--
-- WHY THE PROVIDER ENTERS THE NEXT-DUE DATE (decision locked with
-- Seth before this PR was scoped):
--   The recurring cadence is defined by the rule (4 years), but the
--   ACTUAL next-due date in any given home depends on facts the
--   document doesn't carry — the date a tester anchored the cycle,
--   whether the home was tested earlier than the rule required,
--   when a heating contractor said the next inspection should
--   happen, etc. The provider has that information in front of
--   them when they upload; the engine doesn't. So the provider
--   enters the next-due date directly, the resolver compares it
--   against today, and the row flips ON_FILE / EXPIRED on the
--   actual boundary the provider attested to.
--
-- WHY NULLABLE:
--   - Pre-040 rows (fingerprint Phase A — mig 038, and any radon /
--     heating / licensing-notebook rows captured between 039 and
--     040 application) carry no due-date value. The CHECK constraint
--     on document_type didn't gate next_due_on; existing rows are
--     valid as-is.
--   - The fingerprint_reprint type and the property_licensing_notebook
--     type don't recur — next_due_on stays NULL on those rows
--     forever. A NOT NULL constraint would force a meaningless date
--     on those uploads. The JS resolver is the right enforcement
--     layer: it requires next_due_on for the cycle types
--     (requiresDueDate=true in COMPLIANCE_DOCUMENT_TYPE_CONFIG) and
--     ignores it for the rest. A row of a cycle type with NULL
--     next_due_on resolves to MISSING_REQUIRED with reason
--     'due-date-missing' — never silently green.
--
-- DEPENDENCY: applies AFTER migration 039 (the property
-- document_type CHECK extension).
--
-- ── IDEMPOTENCY ──────────────────────────────────────────────────────
-- ALTER TABLE ADD COLUMN IF NOT EXISTS — Postgres 9.6+. The
-- migration is re-runnable: a partial-apply that landed the column
-- and failed mid-statement (very unlikely for a single ADD) would
-- re-run cleanly.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────────
-- Paste into the Supabase web SQL Editor and screenshot the result
-- BEFORE promoting the migration to Migration History (DB-is-source-
-- of-truth process note in the runbook).
--
--   -- a) The column exists with the expected shape.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name   = 'compliance_documents'
--      and column_name  = 'next_due_on';
--   -- expect: 1 row — next_due_on | date | YES
--
--   -- b) No existing row was mutated (next_due_on is NULL on every
--   --    pre-040 row — including any production fingerprint uploads).
--   select count(*) as total_rows,
--          count(next_due_on) as rows_with_next_due_on
--     from public.compliance_documents
--    where archived_at is null;
--   -- expect: rows_with_next_due_on = 0 immediately after this
--   --   migration. Any cycle-type row of this kind reads as
--   --   MISSING_REQUIRED 'due-date-missing' in the engine until
--   --   the provider re-enters the date via the slot.
--
--   -- c) The CHECK constraint on document_type is unchanged from
--   --    migration 039 (sanity — this migration did not touch it).
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.compliance_documents'::regclass
--      and conname  = 'chk_compliance_documents_document_type';
--   -- expect: same 4-value list mig 039 produced.
-- ============================================================

alter table public.compliance_documents
  add column if not exists next_due_on date;

comment on column public.compliance_documents.next_due_on is
  'Provider-entered next-due / expiration date for cycle-tracked '
  'document types (radon, heating inspection). The JS resolver '
  '(buildComplianceDocResolver in src/lib/complianceState.js, cycle '
  'branch) compares this against today: future date → ON_FILE; past '
  'date → EXPIRED; NULL on a cycle type → MISSING_REQUIRED with '
  'reason "due-date-missing". NULL on non-cycle types is fine and '
  'never read (fingerprint_reprint, property_licensing_notebook).';

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Non-destructive in shape (drops a single column) but lossy in
-- intent: every cycle-tracked row loses the provider's attested
-- next-due date, and the resolver flips every cycle row to
-- MISSING_REQUIRED until each is re-entered. Treat as an emergency
-- path; export the next_due_on column first if rollback is genuinely
-- necessary so the dates can be restored after the followup.
--
-- alter table public.compliance_documents
--   drop column if exists next_due_on;
