# CC follow-up — pin parent-side / provider-side consent-count agreement

**Context:** Consents Phase A (branch `feature/consents-a-photo-fieldtrip`,
commit 682b158) computes "pending enrollment consents" in TWO independent
places:

1. **Provider side** — `getChildFilesAuditState` in `src/lib/childFiles.js`
   (the tested helper), using `ENROLLMENT_CONSENT_TYPES`,
   `PROVIDER_PROTECTIVE_CONSENT_TYPES`, `REVOCATION_PAIRS`, and the
   parent-signed channel rule.
2. **Parent side** — inline re-implemented logic in
   `src/pages/ParentAcknowledgmentsPage.jsx` (the tab badge count) and in
   `src/components/parent/EnrollmentConsentsPendingBanner.jsx` (the banner),
   each doing its own `acknowledgments` query + its own per-child
   "is this captured?" loop.

The two paths encode the SAME rule but in different code. They can drift —
most dangerously on the revocation-pair-counts-as-captured rule, where the
parent side could forget that an active `photo_sharing_consent_revoked`
counts as "preference captured" (not pending) and nag the parent about a
consent the provider already recorded.

**Goal of this task:** make the two paths provably agree, so a future edit
to one can't silently disagree with the other. Build on the SAME branch
(`feature/consents-a-photo-fieldtrip`), halt for review, no deploy/merge.

---

## Preferred approach — extract ONE shared pure function, call it from both

The real fix isn't "add a test that both happen to pass" — it's to remove
the duplication so there's only ONE implementation of the rule, and have
both sides call it.

1. In `src/lib/childFiles.js` (or a small sibling module if you think it
   belongs separately — propose which), extract a PURE function that takes
   the raw inputs both sides already have and returns the per-child
   pending verdict. Something shaped like:

   ```
   // Pure: no Supabase, no I/O. Given a child's active acks (as a set or
   // list of {type, acknowledged_via}), return which enrollment consents
   // are pending for that child, applying the channel rule + revocation
   // pairing. This is the SINGLE source of truth both the provider audit
   // helper and the parent-side surfaces use.
   export function pendingEnrollmentConsentsForChild({ activeAcks }) { ... }
   ```

   It must encode, in ONE place:
   - the satisfying-channel rule (`parent_portal` / `in_person_paper`
     satisfy; `provider_override` alone does not),
   - the revocation-pair rule (an active `<type>_revoked` recorded via a
     satisfying channel counts as "preference captured" → NOT pending),
   - the licensing-required vs provider-protective split.

2. Refactor `getChildFilesAuditState` to call this pure function per child
   instead of its own inline loop. Its existing output shape must NOT
   change — all 854 current tests stay green.

3. Refactor BOTH parent-side consumers
   (`ParentAcknowledgmentsPage.jsx` badge count and
   `EnrollmentConsentsPendingBanner.jsx`) to call the SAME pure function,
   instead of their own inline per-child loops. They still do their own
   Supabase query under parent RLS to FETCH the acks (that part legitimately
   differs — parent reads under parent RLS, provider reads under provider
   RLS), but the VERDICT logic (given the fetched acks, what's pending) must
   come from the one shared function. Fetch differs; rule does not.

   Note: the parent side counts DISTINCT CHILDREN affected (for the badge),
   while the provider side reports both slot-counts and children-affected.
   The shared function should return the per-child verdict; each caller
   aggregates as it needs (badge = count children with any pending;
   helper = sum slots + count children). Don't force one aggregation shape
   on both — share the per-child rule, not the rollup.

## Tests

- A new test that feeds the SAME fixture (a child's set of active acks)
  through the shared pure function and asserts the verdict — covering:
  no record → pending; consent via in_person_paper → captured; consent via
  provider_override → still pending; revocation via in_person_paper →
  captured; revocation via provider_override → still pending.
- A parity test: construct a few representative children + ack fixtures,
  run them through (a) the provider helper's aggregation and (b) the
  parent-side aggregation, and assert the two AGREE on which children are
  pending. This is the test that catches future drift — it should fail if
  someone edits one path's rule and not the other.
- All 854 existing tests stay green (the helper's public shape is unchanged).

## Confirm

- No migration (this is a pure refactor + tests).
- The parent-side Supabase QUERIES are unchanged in what they fetch — only
  the verdict logic is now shared. (Don't accidentally change parent RLS
  surface.)
- build clean.

## Halt — show:
1. The extracted pure function + where it lives + its signature.
2. The three call sites now using it (provider helper + 2 parent surfaces),
   with confirmation the helper's output shape is byte-for-byte unchanged.
3. The parity test + that it would fail if the rule drifted on one side.
4. 854+ green, build clean, no migration.
Do NOT deploy or merge.
