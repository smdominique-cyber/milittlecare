PR #16 consolidated follow-up. Four issues, all confirmed by live production testing. The crash fix (#1) is already built on branch fix/pr-16-parent-page-hooks-order � bring it into this work. Build all four, then HALT for review. Do NOT deploy or merge. Standing rule: surface any simplification or blocker rather than deciding it silently � every silent scope cut this PR has been caught at review, so flag, don't drop.

Work on a single branch off main; cherry-pick or merge in the existing crash-fix commit (69bf2af) so everything reviews together.

??? #1 � CRASH (already fixed, carry forward) ???
The useMemo-below-early-return fix on fix/pr-16-parent-page-hooks-order is correct. Bring it into this branch. Then ALSO add the regression guard: add @testing-library/react (I approve the dependency) and a mount test for ParentIntakeAcknowledgePage that renders it through the loading->loaded transition with a mocked parent session and one pending reminder, asserting no throw. This is the test class that would have caught #310 and didn't exist.

??? #4 � EMAIL GOES TO PROVIDER, NOT PARENT (confirmed live) ???
Confirmed: intake_acknowledgment_pending emails are delivered to the PROVIDER's own inbox, not the parent's. The dispatcher (api/cron-dispatch-reminders.js ~line 332) hardcodes `to = providerProfile.email`. Correct for PR #15's provider-facing reminders (CPR, drills); WRONG for intake_acknowledgment_pending, whose recipient is the parent. Result: parent never gets the link, loop is dead end-to-end even with the crash fixed.

CRITICAL � resolve the parent-email path correctly, do not assume:
- The parent's email is in auth.users.email. BUT PR #15's own comment says auth.users is "not directly readable from PostgREST" under the dispatcher's role. Verify what role the dispatcher actually runs as and whether it can read auth.users. Do NOT just swap in auth.users.email and assume it works � if the dispatcher's role can't read it, you get a null recipient and the email silently doesn't send (another dead path).
- The portal already sends parents magic-link invite emails. That flow ALREADY resolves a parent's email under some role. FIND that existing path (SECURITY DEFINER function, or a public-table mirror of the email written at invite time) and REUSE it. Do not invent a new mechanism if one exists.
- Route the recipient BY CATEGORY: provider-facing categories keep providerProfile.email; intake_acknowledgment_pending (and future parent-facing categories) resolve the parent address via the path you found. CC's own suggestion of a recipient_resolver field on the catalog entry is a good shape.

??? #3 � OPT-IN TRAP (Design A, approved) ???
intake_acknowledgment_pending currently fires nothing unless the provider separately opted into the category (default OFF per PR #15). Clicking "Send to parent's portal" IS the consent. Implement Design A: add transactional: true to the catalog entry; in decideAction() fire transactional categories by default (skip the no-preference-row -> skip branch), defaulting to the parent-email channel. Add the CLAUDE.md note documenting that transactional categories bypass default-OFF, the trigger action is the consent, currently intake_acknowledgment_pending (and likely staff_discipline_policy_ack_pending in PR #17). In settings, surface the toggle as "Email parents when I send acknowledgment requests," default ON. #3 and #4 touch the same dispatcher/catalog surface � do them together coherently.

??? #2 � INTAKE PAGE UNREACHABLE IN PORTAL (build spec version) ???
Spec called for an Intake TAB on /parent/acknowledge (three times); build instead shipped a standalone /parent/intake-acknowledge route whose promised "linked from there" was never wired, so no parent can reach it except via the email link. Build what the spec specified: add an Intake tab to ParentAcknowledgePage.jsx. Keep /parent/intake-acknowledge?child=<id> working as a deep link that auto-selects the Intake tab (preserves the email CTA). Default tab = whichever has pending items, Attendance first if both.

??? VERIFY + HALT ???
- vitest green (report real total + delta), build clean.
- The new mount test passes.
- Confirm the recipient resolves to a real PARENT address for intake_acknowledgment_pending � show me how you verified the dispatcher's role can actually read it, not just that the data exists.
Show me, per issue: the diffs, the parent-email path you found and reused, how you confirmed the role can read it, and the spec citations for #2. Do NOT deploy or merge � I review, then we do ONE deploy and a full end-to-end smoke test (provider triggers -> cron fires -> PARENT inbox receives link -> parent opens page, it renders -> parent confirms -> resolved_at sets). We've learned green tests prove nothing about the live loop.

---

## OPEN ITEMS — PR #16 NOT CLOSED

### Audit-state lenience on parent-signed disclosure items (2026-05-29)

Surfaced after merge `d733a7b`. R 400.1907 distinguishes inform-only items (lead, subitem vi — "licensee shall inform") from items that must be "signed by the parent" (discipline policy receipt, health condition, licensing notebook offered, food provider agreement, firearms acknowledgment). `getChildFilesAuditState` currently counts ANY active row of the required type as satisfied — correct for lead, **overstated for the five parent-signed items** when the portal flow has only the provider's `provider_override` attestation.

Current `src/lib/childFiles.test.js` § "phase A" asserts the lenient behavior; that assertion will need revisiting when the fix lands.

Full write-up + recommended fix shape: see `docs/tech_debt.md` § "`getChildFilesAuditState` overstates compliance for parent-signed disclosure types (2026-05-29)".

**Must be resolved before PR #22 (Compliance Health Score) consumes these counts.** Also worth confirming the regulatory reading with a licensing consultant before #22 lands.