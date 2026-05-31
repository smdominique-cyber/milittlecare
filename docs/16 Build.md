Build PR #16 (child files scope) straight through. Don't pause for confirmation mid-build — only stop at the very end, with all production-affecting steps batched for my go/no-go.

READ FIRST, before writing any code:
1. docs/pr-16-child-files-scope.md — source of truth for scope. Follow it; don't add or invent scope beyond it.
2. CLAUDE.md at repo root — honor all project conventions.
3. Verify the two hard dependencies are actually present:
   - PR #15's `intake_acknowledgment_pending` reminder category (check the category enum/constants and migration 023).
   - PR #12's parent-acknowledgment portal page extension.
   If either is genuinely missing, STOP and report it — do not build on a missing dependency. If both are present, proceed straight through with no further mid-build pauses.

BUILD (one pass, no checkpoints):
- Create branch feature/pr-16-child-files-scope off current main (0411f25).
- Implement everything the spec calls for: migration, backend/API routes, audit-state helper, frontend.
- Migration is the next sequential number — 024 if 023 is the latest in the migrations dir; verify. Follow the established migration structure (tables, indexes, RLS policies, SECURITY DEFINER RPCs) per the spec.
- Must include getChildFilesAuditState(licenseeId) per the audit-state mandate. Match the signature and return shape of the existing audit-state helpers from PRs #13–#15 so PR #22's aggregator can consume it uniformly — read those helpers and mirror their pattern exactly.
- Commit to the feature branch as you go (local commits are reversible — encouraged).
- Run local typecheck / lint / build and fix anything that breaks.

CODEBASE-SPECIFIC GUARDRAILS (learned from PR #15):
- Any provider/licensee lookup `select` must include EVERY column downstream code reads — PR #15 shipped a dispatcher missing profiles.email. Verify select completeness.
- No Vite @/ aliases in any code reachable by an Edge Function. Use relative imports with explicit .js extensions. This broke Edge bundling in a PR #15 scheduler. Applies to anything under src/lib/schedulers/ or otherwise on the Edge bundling path.

PAUSES — ALL AT THE END, BATCHED:
Build everything reversible first; do NOT touch production mid-build. When the local build is green and committed, STOP and present these as one batch for my approval:
1. Migration 024 — give me the full SQL, ready to paste into the Supabase SQL Editor (I apply it manually, same as 023).
2. Merge feature/pr-16-child-files-scope ? main (I approve; the merge triggers the Vercel production deploy).
Pushing the feature branch for a Vercel preview deploy is fine and welcome — that's not production.

END STATE:
Stop after local build is green and committed to the feature branch. Summarize: files changed, the migration's contents, the getChildFilesAuditState return shape, and confirmation that local typecheck/lint/build pass. Then list the two production steps above queued for my go/no-go.

UPDATE:
Follow-up on PR #16. The straight-through build silently dropped the provider?parent portal trigger, which left intake_acknowledgment_pending unfired, the /parent/intake-acknowledge route unreachable, and the audit-state pending-counts inert. Close that gap now. Same rule as before: build everything reversible, then HALT for my review — do NOT re-queue the migration or the merge.

IMPORTANT META-RULE: If you find yourself simplifying, deferring, or dropping any part of this scope, STOP and surface it in the halt. Do not make silent scope cuts. A flagged simplification is fine; an unflagged one is the specific failure we're correcting.

Stay on branch feature/pr-16-child-files-scope. Re-read docs/pr-16-child-files-scope.md §§ around lines 413–416 and 537 for the intended flow before writing code.

WIRE THE FULL LOOP (all four pieces — a dead path is worse than a deferred one):

1. Provider trigger (ChildIntakeModal.jsx)
   Add the "Send to parent's portal" channel that was dropped. When the provider picks it for a child, instead of writing the acknowledgment bundle immediately, insert ONE reminder_instances row of category 'intake_acknowledgment_pending' per applicable child.
   - The insert MUST match the exact reminder_instances shape PR #15's dispatcher expects. Read miregistryAnnualTrainingScheduler.js and the dispatcher (api/cron-dispatch-reminders.js) for the known-good shape — provider_id, category, title, body, cta_path, lead_time/fire timing, channel, and whatever else the dispatcher selects. A malformed insert gets silently skipped by the dispatcher, which just disguises the dead path. Mirror the shape that successfully fired in the PR #15 smoke test.

2. cta_path
   The inserted reminder's cta_path must point at /parent/intake-acknowledge WITH whatever child/family/token param the parent page needs to load the correct intake bundle. Verify against how the page reads its params (and how PR #12's /parent/acknowledge does it). The email's Open button has to land the parent on the right screen — a wrong cta_path was the no-op we caught in the #15 smoke test.

3. Parent-side resolve (ParentIntakeAcknowledgePage.jsx)
   The page shipped without resolution logic. When the parent confirms, set resolved_at (or the dispatcher's equivalent "satisfied" field — check what PR #15 uses to stop a reminder from re-firing) on the corresponding intake_acknowledgment_pending instance, in addition to writing the acknowledgment row. An insert with no resolve fires forever. Confirm the parent's RLS allows this update, or route it through a SECURITY DEFINER RPC if that's the established pattern (check how dismiss worked in PR #15).

4. childFiles.js test
   Add src/lib/childFiles.test.js. Must include a case asserting that a child with an unsigned REQUIRED disclosure (lead when home_built_before_1978=true; firearms always) appears in the pending count, and drops out once acknowledged. This is the exact logic the inert path was hiding. Mirror the test style of acknowledgments.test.js.

MIGRATION CHECK:
Confirm migration 024 already covers every column these four pieces touch. The acknowledgments table and reminder_instances plumbing should already exist, so 024 is likely untouched — but if the trigger or resolve needs a column 024 doesn't have, AMEND 024 in place (don't create 025). Tell me explicitly in the halt whether 024 changed.

VERIFY:
- npx vitest run — all green, report the real delta and the actual new total (track the numbers honestly this time).
- npm run build — clean.
- Edge guardrail: any new scheduler/dispatcher-reachable code uses relative .js imports, no @/ aliases.
- select-completeness guardrail on any new/changed query.

HALT — review batch, no production steps queued:
Commit the changes to the feature branch and push (preview deploy is fine). Then STOP and show me:
1. The new "Send to parent's portal" trigger code in ChildIntakeModal.jsx (the actual diff).
2. The reminder_instances insert payload — field by field — next to the PR #15 shape you mirrored.
3. The cta_path you set and the param the parent page reads to confirm they match.
4. The parent-page resolve edit (the actual diff).
5. The childFiles.test.js cases and the new vitest total.
6. Whether migration 024 changed, and if so the diff.
Do NOT re-queue applying 024 or merging to main. I approve production steps separately after I've reviewed this batch.

PR #16, third pass. Your last halt correctly flagged that parents have no SELECT on reminder_instances — but you understated it: the resolve loop is currently DEAD. Trace it: the parent page loads pendingReminders via a direct SELECT on reminder_instances ? RLS denies it ? reminderById is empty ? on confirm, the loop over pendingReminders[child.id] is empty ? reminder_instance_resolve_for_parent is NEVER called. The reminder inserts but never resolves. Same dead-path shape as the trigger gap, one layer deeper. Fix it.

Same rules: build everything reversible, then HALT for review. Do NOT re-queue applying 024 or merging. Surface any simplification or cut in the halt — do not make it silently. Stay on branch feature/pr-16-child-files-scope.

BUILD:

1. New RPC: reminder_instance_list_for_parent
   Amend migration 024 IN PLACE (no 025) — add a third SECURITY DEFINER function alongside the two you already added. It returns the list of pending intake_acknowledgment_pending reminder ids (and subject_id) for the calling parent, scoped by the SAME guard as reminder_instance_resolve_for_parent: category='intake_acknowledgment_pending', subject_type='child', subject_id linked to auth.uid() via active parent_family_links. SECURITY DEFINER so the parent gets the ids without needing a direct SELECT policy on reminder_instances. Filter to resolved_at IS NULL AND archived_at IS NULL. grant execute to authenticated; revoke from public. Update migrations-for-deploy/024.sql to match. Add a verification query for the new function to the migration header's section (e).

2. Swap the parent page's direct SELECT
   In ParentIntakeAcknowledgePage.jsx, replace the best-effort .from('reminder_instances').select(...) block with a call to supabase.rpc('reminder_instance_list_for_parent'). Build pendingReminders (subject_id ? [ids]) from the RPC result. This is the line that makes the resolve loop actually reachable — verify the resolve loop now has ids to iterate. The console.warn currently lives inside a loop body that never executes; once this works it should actually be able to fire.

VERIFY A DISPATCHER FACT I need to know before merge:
Show me the dispatcher's fire-selection query — the actual SELECT in api/cron-dispatch-reminders.js that picks which reminder_instances to fire. Specifically: does it re-fire an instance that has fired_at SET but resolved_at NULL? Your PR #15 smoke test showed the dispatcher sets fired_at on fire. I need to know the blast radius of an unresolved reminder:
- If it fires once then goes quiet (fired_at IS NULL in the WHERE), a broken resolve is just stale-row hygiene.
- If it re-fires while unresolved (keys only off resolved_at / trigger_at), then a parent who already confirmed gets re-emailed every hour forever — worse than shipping nothing.
Quote the WHERE clause and tell me which case it is. If it's the re-fire case, that raises the stakes on the resolve loop being correct — say so.

3. Test the resolve path for real
   Add a test proving a parent CAN retrieve and resolve their own pending reminder — i.e. reminder_instance_list_for_parent returns the id, and the resolve path is reachable with a non-empty id list. The existing childFiles test mocks supabase and can't see RLS, so green tells us nothing about this path — this test needs to exercise the list?resolve wiring, not just the audit counts. Mirror the existing mock style. If a true RLS-level test isn't feasible in vitest (no live DB), say so explicitly and test the wiring as far as the mock allows, flagging the gap rather than implying coverage you don't have.

VERIFY:
- npx vitest run — all green, report real total and honest delta.
- npm run build — clean.
- Confirm childFiles.js still untouched (its relative ./supabase import preserved); no new Edge-path code.

HALT — review batch, NO production queued. Show me:
1. The reminder_instance_list_for_parent function (full SQL) + the migration 024 diff.
2. The ParentIntakeAcknowledgePage diff swapping SELECT ? RPC, and confirmation the resolve loop now receives a non-empty id list.
3. The dispatcher fire-selection WHERE clause quoted, with your verdict: fire-once or re-fire-forever.
4. The new test cases and the new vitest total.
5. Anything you simplified or couldn't fully cover — flagged, not silent.
Do NOT apply 024 or merge. I approve production separately after reviewing this.