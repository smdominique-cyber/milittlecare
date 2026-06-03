-- ============================================================
-- MI Little Care — Consent Attachments hardening:
--   parent metadata SELECT policy archived_at parity.
--
-- Authoritative context: Part 1 code audit (consent-attachments
-- privacy boundary), finding (a): the migration-029 parent SELECT
-- policy on `public.consent_attachments` did NOT include
-- `consent_attachments.archived_at IS NULL` in its USING clause.
-- The Edge Function (`api/consent-attachment-url.js`) does check
-- this (line 236 — `archived_at=is.null` on the attachment fetch),
-- but a hand-crafted PostgREST SELECT from a linked parent could
-- see soft-deleted (`archived_at IS NOT NULL`) attachment metadata
-- rows tied to consents in their own family. The application code
-- (`listConsentAttachments` in `src/lib/consentAttachments.js`)
-- filters for archived_at IS NULL on every read, so the UI never
-- surfaces archived rows — but the RLS layer was looser than the
-- function. This migration brings them to parity.
--
-- This is NOT a cross-tenant boundary fix — the parent already had
-- authorization to see metadata for their own family's consents.
-- It's a soft-delete / "archived stays out of the list" parity
-- fix, mirroring how every other parent-side RLS on this codebase
-- gates on archived_at.
--
-- DEPENDENCY: applies AFTER migration 029. Idempotent: DROP-then-
-- CREATE the named policy.
--
-- ── EXPECTED VERIFICATION ────────────────────────────────────────
-- Re-issue the verification gate's Test 4a (Parent B direct
-- SELECT) and ALSO check that an archived attachment on a
-- non-archived ack does NOT appear in the linked parent's SELECT
-- result. See the runbook entry.
-- ============================================================

drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;

create policy "Parents can list consent attachments for their children"
  on public.consent_attachments for select to authenticated
  using (
    -- Soft-delete parity (2026-06-02 hardening): archived attachments
    -- are not parent-visible. Matches the Edge Function's
    -- archived_at=is.null filter on the attachment fetch.
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
    )
  );

-- ============================================================
-- DOWN MIGRATION (commented; uncomment + run if rollback is needed)
-- ============================================================
-- Restores the migration-029 policy text (which lacks the
-- archived_at parity). Not destructive; merely loosens the policy.
--
-- drop policy if exists "Parents can list consent attachments for their children" on public.consent_attachments;
-- create policy "Parents can list consent attachments for their children"
--   on public.consent_attachments for select to authenticated
--   using (
--     (target_type = 'acknowledgment' and exists (...))
--     or (target_type = 'acknowledgment' and exists (...))
--     or (target_type = 'medication_authorization' and exists (...))
--   );
-- See migration 029 lines 189-247 for the full prior text.
