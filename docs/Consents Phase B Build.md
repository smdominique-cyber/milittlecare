Task: Build Consents Phase B (time-bound recurring consents) per the finalized scope. Branch, build, halt for review. Do NOT merge. Migration is applied manually by Seth — do NOT attempt to run it.
Authoritative spec: docs/pr-consents-B-scope.md (committed, on main, commit 66b7675). Read it in full before writing anything. Every decision is locked there; this prompt is the build order, the doc is the contract. Where this prompt and the doc agree, follow them; if you find any conflict between them, halt and report it rather than guessing.
Branch: create feature/consents-b-recurring off current main. Confirm you're on it before the first edit.
Build order — do these in sequence, not all at once:

The two ACK_TYPES. Add transportation_routine_annual and water_activities_on_premises_seasonal to src/lib/childFiles.js (or acknowledgments.js, wherever the catalog lives — check both). Add both to PARENT_SIGNED_TYPES and ENROLLMENT_CONSENT_TYPES. Do NOT add them to the intake bundle. Mirror exactly how Phase A's field_trip_permission is wired as a licensing-required parent-signed type.
The migration file (write it, do NOT apply it). Create supabase/migrations/026_acknowledgments_expires_at.sql per §10's sketch: a single ALTER TABLE public.acknowledgments ADD COLUMN IF NOT EXISTS expires_at timestamptz;. Header comment matching migration 024's style. No index, no constraint changes, no row mutations. Include the commented down-migration (ALTER TABLE … DROP COLUMN IF EXISTS expires_at;) per the 024 pattern. Add the runbook entry per CLAUDE.md's same-PR doc discipline (what it does, dependency on 025, verification SQL, rollback). Stop short of running it — Seth applies migrations manually via the Supabase web SQL editor. In your halt report, give Seth the exact SQL to paste.
The expiry-aware predicate, caller-side only. The verdict functions stay pure (no now() reference — this is non-negotiable, it's what keeps the fixtures deterministic). Add AND (expires_at IS NULL OR expires_at > now()) to the Supabase query in each of the six read surfaces enumerated in §8's table:

getChildFilesAuditState (childFiles.js)
the caller feeding pendingEnrollmentConsentsForChild
loadPhotoConsentReminderState (MessageThreadPage.jsx) — no-op for photo consent but applied for consistency
EnrollmentConsentsPendingBanner.jsx
ParentEnrollmentConsentsPanel.jsx (see step 4)
EnrollmentConsentsModal.jsx
Also select the expires_at column wherever these reads will need it for display.


Resolver consolidation (decision 6, tight scope). In ParentEnrollmentConsentsPanel.jsx, replace the inline pickActive/PhotoStatusRow/StatusRow consent logic with calls to the shared resolver. Drop the inline reads. Render four states per row: on-file, revoked-or-recorded-as-no (photo only), expired, not-on-file. The expired render reuses not-on-file's "needs action" treatment with distinct copy ("expired on YYYY-MM-DD — needs renewal"). Do not redesign the resolver interface beyond adding the expired field (step 5). Phase A call sites and signatures stay otherwise unchanged.
The enrollment_consents_expired field (decision 11). Add it to pendingEnrollmentConsentsForChild's return shape, parallel to enrollment_consents_pending. A type lands in _expired when there's an active row for it that's past expires_at (the caller will have filtered, so the verdict distinguishes "present and valid" from "present but expired" — confirm the mechanism in the doc; the verdict needs to know expired-vs-pending without referencing now() itself, which means the caller passes that distinction in). any_pending is true when either _pending or _expired is non-empty. _expired is always empty for Phase A types. This is the subtle part — read §8 and §9's typedef section carefully and make sure the pure-function/caller split actually works for distinguishing expired from never-captured. If the split doesn't cleanly support that distinction without now() in the verdict, halt and flag it before implementing, because that's a real design question, not a coding detail.
The renewal flow in EnrollmentConsentsModal.jsx (decisions 8, 9). Provider modal only. For each Phase B type, show on-file (with expires_at date) / expired (with capture + expiry dates, "Renew" button) / not-on-file ("Capture"). Renewal and capture both set expires_at = acknowledged_at + interval '1 year' — same formula, both types, no branching. Renewal is archive-then-insert in one transaction: archive the prior row's archived_at, then insert the new row. This ordering is mandatory because the acknowledgments_active_unique partial index considers an expired-but-not-archived row still active — inserting before archiving violates the constraint. Implement in JS against existing RLS (provider has UPDATE + INSERT under their own provider_id); no new RPC.
Tests per §12. All of them, including: expiry-aware verdict tests (NULL ? satisfied, future ? satisfied, past ? expired-not-pending), the cadence write test (both types get acknowledged_at + 1yr), renewal protocol (archive-then-insert, one active row after), early-renewal (archives immediately, no coexistence), backward-compat (Phase A types with NULL expires_at read identically — existing tests pass unmodified), and the parent-panel consolidation tests (asserts the shared resolver is called, asserts no inline pickActive remains). Build clean, vitest green, lint --max-warnings 0.

Constraints throughout:

Migration is NOT run by you. Write it, give Seth the SQL, stop.
Verdict functions never reference now().
No changes to acknowledgments_active_unique or any constraint.
Don't touch the two untracked junk items in the working tree.
Phase C non-foreclosure: confirm in your report that nothing you did forecloses §9-NonForeclosure's three Phase C models.

Commit and push to preview, then HALT. Do not merge. Commit message: feat(consents-b): time-bound recurring consents — expires_at, renewal, resolver consolidation. Push to origin/feature/consents-b-recurring so Vercel builds the preview.
Verification gate — this is the part that matters, read it twice. Green tests are NOT sufficient evidence this works — that is the explicit, repeatedly-confirmed lesson of this project. Every real bug here has hidden behind passing tests and surfaced only against real rows. So your halt report must set up Seth to verify the expired-state read firing against a real row, not just cite green tests. Specifically, in your report:

Give Seth the migration SQL to paste into Supabase.
Give Seth a SQL snippet to put a test child into a genuine expired state: insert (or identify) a transportation_routine_annual row for a test child with expires_at set to a past timestamp (e.g. now() - interval '1 day'), archived_at NULL, satisfying channel.
Tell Seth exactly what to check on the preview URL as provider: the child's audit/consents surface must report that consent as expired — distinctly from "on file" and from "never captured" — and the modal must offer Renew, not Capture. The meaningful pass is seeing the expired state render for a row confirmed-expired in the database, the same way the photo-consent live check's meaningful pass was seeing the modal fire for a confirmed-revoked child.
Also give Seth the renewal verification: after clicking Renew, confirm in SQL that the prior row is archived (archived_at set) and exactly one active row remains with a fresh expires_at ~1 year out.

Do not claim Phase B works on the basis of the test suite. Set up the live verification and let Seth run it.