-- ============================================================
-- MI Little Care — Phase 5: invoice_items.funding_source_id FK
--
-- Adds a nullable funding_source_id reference to invoice_items so each
-- line item can be attributed to a specific funding source. Nullable so
-- pre-existing rows remain valid; new code populates it going forward.
-- See docs/funding_source_spec.md section 6.
--
-- on delete set null: if a funding_sources row is hard-deleted (rare —
-- the soft-delete pattern is archived_at), the line item is preserved
-- and its FK is nulled out. Audit story stays intact: the invoice line
-- itself never disappears.
-- ============================================================

alter table public.invoice_items
  add column if not exists funding_source_id uuid
    references public.funding_sources(id) on delete set null;

create index if not exists invoice_items_funding_source_id_idx
  on public.invoice_items(funding_source_id)
  where funding_source_id is not null;

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- drop index if exists public.invoice_items_funding_source_id_idx;
-- alter table public.invoice_items drop column if exists funding_source_id;
