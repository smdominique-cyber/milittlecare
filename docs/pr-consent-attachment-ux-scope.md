# PR Scope — Consent Attachment UX (fix + camera + cross-modal consistency)

**Date:** 2026-06-02
**Status:** Scope — **FINAL, ready for build** (no schema change; pure
UI/UX fix pass; the root cause of the save-exits bug is confirmed
identical to the medication-modal cause fixed on 2026-06-02).
**Branch (suggested):** `feature/consent-attachment-ux`
**Builds on:** the proven save-confirmation pattern in
`src/components/families/MedicationModal.jsx` (fix-forward landed
on `main` 2026-06-02, commit `74f7bc9`); the
`ConsentAttachmentSlot` component from Consent Attachments Part 2
(landed on `main` 2026-06-02). No new migration; no new dependency
(reuses the already-installed `browser-image-compression` from the
messaging surface).

---

## Summary

Recording a consent in the **EnrollmentConsentsModal**, capturing the
intake bundle in **ChildIntakeModal**, and (when present) revoking a
photo consent all eject the provider to the family-tab list — a
direct repeat of the medication-modal silent-refresh bug that was
diagnosed and fixed for PR #20. The root cause is the same: every
save calls `onSaved?.()` (which triggers `FamiliesPage.loadAll()` →
`setLoading(true)` → spinner short-circuit → entire subtree
unmounts), and the consent/intake save paths additionally call
`onClose?.()` explicitly. The medication-modal fix removed the
`onSaved` cascade and the modal stayed open with an inline ✓; this
pass replicates that pattern in the other two modals and ensures
all three behave identically.

The workflow payoff this enables is the "record + snap the paper
right now" motion: because the modal stays open, the just-recorded
consent's `ConsentAttachmentSlot` is rendered in place, so the
provider can immediately photograph the signed paper without
navigating back in. Same provider, same moment, no friction.

The pass also adds rear-camera capture for the `ConsentAttachmentSlot`'s
file input (phone-friendly attach for the at-the-table workflow),
client-side image compression for camera/photo uploads (reusing the
messaging surface's existing dependency), and a "retake" affordance
on mobile.

What this scope does NOT do: the compliance-state engine arc
(quality score, readiness checklist, auditor access mode — three
faces of one model, captured for the next arc); per-occurrence
(Phase C) attach; parent intake-view attach; the three parent-view
bugs in the parked cluster.

---

## DECISIONS — RESOLVED

| # | Decision | Resolution |
|---|---|---|
| 1 | Root cause confirmation | **Same mechanism in both buggy modals.** Confirmed by grep: `EnrollmentConsentsModal.recordOne` (line 350-351) and `revokePhotoConsent` (451-452) call BOTH `onSaved?.()` AND `onClose?.()` after every successful insert. `ChildIntakeModal.handleSaveBundle` (339-340) and `handleSendToPortal` (429-430) do the same. `recordOccurrence` (414-415) calls only `onSaved?.()` but the cascade kicks the provider out anyway — confirming the cascade IS sufficient to close. The fix is identical to the medication-modal fix: drop `onSaved?.()` from the save paths AND drop explicit `onClose?.()`. |
| 2 | Replicate the proven MedicationModal pattern | Add a `refresh()` function that re-runs the modal's own load query (acks fetch). After each successful save: `await refresh()` then `showSuccess(key, text)`. Drop `onSaved?.()` AND `onClose?.()` from save handlers. Add a `successMessage: { key, text } \| null` state + 3s auto-clear `useEffect`. Modal closes only via explicit X (header) or Close (footer). |
| 3 | Sub-form reset on save | Sub-forms (e.g., the per-occurrence dose-entry form, the authorization form in MedicationModal) collapse on successful submit; the conditional-mount pattern (`{open && <Form/>}`) ensures fresh state on re-open. Same convention for EnrollmentConsentsModal's per-occurrence sub-form (already in place; confirm preserved). ChildIntakeModal has one big bundle save (no sub-form to reset). |
| 4 | Inline ✓ confirmation per save | Same `SuccessChip` shape as MedicationModal: sage-pale background, sage-dark text, `CheckCircle2` icon, `role="status" aria-live="polite"`, 3s auto-dismiss. Per-section keys so chips land near the right control. Specific keys per modal listed in §"Per-modal fix shape" below. |
| 5 | Cross-modal consistency invariant | All three record modals (`ChildIntakeModal`, `EnrollmentConsentsModal`, `MedicationModal`) share the same on-save behavior — stay open, inline ✓, list updates in place, sub-form collapses, modal closes only on explicit close. **MedicationModal is the reference**; the other two are brought into parity, not the reverse. Any future per-modal deviation needs a noted reason. |
| 6 | Camera capture on mobile | Add `capture="environment"` to the `<input type="file">` inside `ConsentAttachmentSlot`. On mobile (iOS Safari, Chrome Android), this opens the rear camera directly. On desktop, the `capture` hint is ignored — same component falls back to file picker. Net change: one attribute on one input. No new component, no platform sniffing. |
| 7 | Image compression for camera/photo uploads | Reuse the existing `browser-image-compression` dependency (already in `package.json`; used by `src/lib/messages.js` for the photo-attachment path). Compress images > 1MB to ~1MB target with maxWidthOrHeight 1800px. **Skip compression for PDFs** (they go through as-is). For HEIC: the library handles iOS HEIC natively in most cases; on failure, fall back to uploading the original (`validateFile` already allows HEIC; the 10MB cap is the safety net). No new dep; no breaking change to the upload path; compression happens BEFORE `uploadConsentAttachment` is called. |
| 8 | "Retake" affordance | Minimal: no special UI. When a phone user captures a photo and the upload is in flight, the existing button shows "Uploading…". If they don't like the snap, they can wait for the upload to finish then click the Remove (trash) button on the just-uploaded row (which soft-deletes it). They can then re-tap Attach to capture a fresh shot. Adding an explicit pre-upload "preview + cancel" step would be more clicks and a new state machine — defer unless a real provider asks. |
| 9 | Envelope-vs-per-form attach defaults | **Keep current per-surface defaults.** Each modal has the natural attach level baked in already: intake → envelope (`child_in_care_statement` ack); enrollment consents → per-consent; medication → per-medication-permission + per-child OTC-blanket. Adding an "envelope-level" attach on the consents/medication modals (for the "one packet covers all" desktop-admin case) is more UI surface for an edge case the data model already supports (provider can upload the same scan to each ack individually). Recommendation: ship the fix without expanding attach surfaces; if a real provider asks for "one scan covers the whole packet," add it as a small follow-up. |
| 10 | Schema change | **None.** No migration. The `consent_attachments` polymorphic target shape already supports both envelope and per-form attach via `(target_type, target_id)`; the choice is per-surface UX, not data-layer. The save-confirmation pattern is presentation-layer. Camera capture is a single HTML attribute. Compression reuses an installed dependency. **Halt and flag if anything turns out to need a migration during build** — the scope doesn't anticipate one. |
| 11 | Verification model | **Live click-through** on the preview build. No SQL, no real-rows boundary test — this pass touches no data boundary. Run the per-modal save+attach motion on a phone (camera capture) and on desktop (file picker). See §"Verification gate" below. |

---

## Root cause — the close mechanism (confirmed)

The medication-modal fix (commit `74f7bc9`, 2026-06-02) traced the
"saving closes the modal" symptom to a parent-side cascade:

```
modal save handler
   └─ await save / refresh
        └─ onSaved?.()                              ← fired by the modal
             └─ parent's onSaved = async () => { await onChange() }
                  └─ onChange = loadAll (FamiliesPage)
                       └─ loadAll() first calls setLoading(true)
                            └─ FamiliesPage's render hits the short-circuit
                               `if (loading) return <spinner>` (lines 135-141)
                            └─ Entire subtree UNMOUNTS:
                                 FamilyDetailModal → ChildrenTab → modal
                       └─ loadAll() awaits 5 table fetches
                            └─ setLoading(false)
                                 └─ FamilyDetailModal remounts
                                 └─ ChildrenTab remounts WITH FRESH STATE
                                      → consentsTarget / intakeTarget is null
                                 → modal does NOT come back
```

The medication-modal fix removed `onSaved?.()` from `refresh()` — the
modal's internal state updates were sufficient; the parent doesn't
need to know on every save because medication data isn't in
`loadAll()`'s fetches.

**Confirmed today via grep that the same mechanism is in play for the
other two modals:**

| Modal | Save handler | Lines | What it does on success |
|---|---|---|---|
| `EnrollmentConsentsModal` | `recordOne` | 350-351 | `onSaved?.()` then `onClose?.()` — BOTH closes fire. The cascade alone would close; the explicit close is belt-and-suspenders. |
| `EnrollmentConsentsModal` | `revokePhotoConsent` | 451-452 | Same shape. |
| `EnrollmentConsentsModal` | `recordOccurrence` | 414-415 | Only `onSaved?.()`. **Has a misleading comment**: *"Deliberately do NOT call onClose() here — per-occurrence is iterative"* — the comment intended to keep the modal open across multiple per-trip captures, but the `onSaved` cascade closes it anyway. The bug has been hiding behind the comment. |
| `ChildIntakeModal` | `handleSaveBundle` | 339-340 | `onSaved?.()` then `onClose?.()` — same shape as recordOne. |
| `ChildIntakeModal` | `handleSendToPortal` | 429-430 | Same shape. |

**Same parent mount pattern.** Both modals are mounted from
`FamiliesPage → FamilyDetailModal → ChildrenTab`, exactly like the
medication modal was; the unmount mechanism is identical. The fix is
identical: drop the cascade, drop the explicit close, refresh
in-place, show inline ✓.

---

## Per-modal fix shape

### `EnrollmentConsentsModal`

- Add `async function refresh()` that re-runs the existing acks
  fetch (`supabase.from('acknowledgments').select(...)`). Update
  `acks` state in place. **NO `onSaved?.()` call.**
- `recordOne(type)`: after the insert, `await refresh()`, then
  `showSuccess('consent:' + type, '✓ Consent recorded')`. **Drop both
  `onSaved?.()` and `onClose?.()`.**
- `revokePhotoConsent`: after the insert, `await refresh()`, then
  `showSuccess('consent:photo_sharing_consent_revoked', '✓ Revocation recorded')`. **Drop both.**
- `recordOccurrence(type, metadataInput)`: after the insert,
  `await refresh()`, then `showSuccess('occurrence:' + type, '✓ Trip recorded')` or `'✓ Outing recorded'`. **Drop `onSaved?.()`.** Remove the misleading "Deliberately do NOT call onClose() here" comment AND restore the comment's spirit explicitly: the modal stays open via the refresh-in-place pattern, not via the absence of an `onClose` call.
- `successMessage` state + 3s auto-clear `useEffect` — same shape as MedicationModal.
- `SuccessChip` component imported from a shared location OR duplicated locally (MedicationModal currently has its own; we keep parity by duplicating in this pass, with a noted "consider extracting" comment — extraction across three modals is a follow-up that doesn't block the fix).
- Per-consent chip placement:
  - field_trip_permission, photo_sharing_consent, photo_sharing_consent_revoked → next to the "Record" / "Re-record" / "Record revocation" buttons in `ConsentRow`'s footer (add a chip-rendering prop to ConsentRow, same as the medication modal's pattern).
  - Phase B routine_annual / on_premises_seasonal → inside the `PhaseBConsentRow`'s footer.
  - Phase C per-occurrence → next to the "Record a trip" / "Record an outing" button or in the recent-N list header (mirror the medication modal's `'dose:<auth.id>'` per-card chip).
- **The attachment payoff:** the modal's existing `ConsentAttachmentSlot` (added in Part 2) is rendered as the `footer` prop on each `ConsentRow`, gated by `state.fieldTripAckId` etc. — those ack ids appear in state immediately after `refresh()` because the just-saved ack is now in `acks`. **Without further change, the attachment slot becomes reachable in the same modal session.** That's the workflow payoff.

### `ChildIntakeModal`

- Add `async function refresh()` that re-runs the existing acks
  fetch on lines 158-172. **NO `onSaved?.()` call.**
- `handleSaveBundle` (lines 339-340): after the bundle write
  succeeds, `await refresh()`, then `showSuccess('bundle-saved', '✓ Intake bundle recorded')`. **Drop both `onSaved?.()` and `onClose?.()`.**
- `handleSendToPortal` (429-430): similar — `showSuccess('bundle-sent-to-portal', '✓ Intake sent to portal')`. **Drop both.**
- `successMessage` state + 3s auto-clear — same shape as elsewhere.
- Per-modal chip placement: at the top of the modal body (one save = one chip, no per-row chips needed because intake is one bundle action). Alternative: next to the save button in the modal footer — pick whichever reads cleaner; the build can refine.
- **The attachment payoff:** the existing envelope-level `ConsentAttachmentSlot` (added in Part 2, gated by `envelope?.id`) appears in place once the envelope ack is in `acks`. The provider's next natural action is to attach the signed packet — same modal session.

### `MedicationModal`

- **No change.** This is the reference pattern. Linked here for confirmation that the other two are coming into parity, not the reverse. Cross-reference: `MedicationModal.jsx` lines 179-202 (`refresh()` without `onSaved`); lines 205-221 (`handleCreateAuthorization` with `await refresh()` + `showSuccess('auth-create', '✓ Medication saved')`); lines 240-275 (per-auth consent + OTC consent with their own keys); line 294-308 (dose with per-auth key).

### What parent `onSaved` becomes — a deliberate no-op

`FamiliesPage` mounts each modal with `onSaved={async () => { await onChange() }}`. The cascade-via-parent-refetch is what closes the modal. **Modals no longer call `onSaved`** in this pass. The prop is still accepted (API symmetry) but never invoked from save paths. If a future feature genuinely needs the parent to refetch on a save, the safest place is on the modal's explicit `onClose` — never inside a save handler.

Document this with an explanatory comment at each removal site (same as the comment in `MedicationModal.refresh()`) so a future maintainer doesn't reintroduce the cascade.

---

## Camera capture + image compression

### Camera capture

One-line change in `ConsentAttachmentSlot.jsx`'s file input:

```jsx
<input
  ref={inputRef}
  type="file"
  accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif"
  capture="environment"          // ← NEW: hint phones to open the rear camera
  onChange={handleFileInputChange}
  disabled={busy}
  style={{ display: 'none' }}
/>
```

**Mobile** (iOS Safari, Chrome Android): tapping the label opens the rear camera directly (provider photographs the signed paper).

**Desktop**: the `capture` hint is ignored; the same input falls back to the file picker. Same component, same code path.

**Trade-off note:** `capture="environment"` strongly hints mobile to open the camera. On some platforms, this means the file picker is HARDER to reach if the provider wants to upload an existing photo from their phone's library. **Mitigation:** mobile browsers still show a "use library" option in the camera flow (standard OS behavior). If real providers complain that they want library-by-default on mobile, the fix is to drop `capture` and rely on the user picking the camera from the OS picker. Flag for build to confirm against a real device after shipping.

### Image compression

**Reuse `browser-image-compression`** — already a dependency (used by `src/lib/messages.js` for parent-message photo attachments). No new dependency.

Where to compress: inside `ConsentAttachmentSlot.handleFile`, BEFORE calling `uploadConsentAttachment`. The compression is conditional:

```
if (file.type starts with 'image/' and file.size > 1MB):
   attempt compression to ~1MB / maxWidthOrHeight 1800px
   if compression succeeds: upload the compressed File
   if compression fails (e.g., HEIC edge case): upload the original
else:
   upload as-is (PDFs and small images bypass compression)
```

**HEIC handling:** the `browser-image-compression` library has imperfect HEIC support across browsers. iOS Safari typically converts HEIC to JPEG when handed to a `<canvas>` operation; if compression succeeds, the resulting file is JPEG. If compression fails, we fall back to uploading the original — `validateFile` already accepts HEIC under both MIME and extension allowlists, and the 10MB cap is the safety net for raw iPhone shots.

**Why not always compress:** PDFs are already optimized; running them through the image-compression library would either error or produce nonsense. Single-page phone shots under 1MB don't benefit. The 1MB threshold is the cleanest gate.

**1800px maxWidthOrHeight:** sufficient for compliance audit reading (a typical 8.5×11 letter at 200dpi is ~1700px on the long edge); produces files in the 500KB-1.5MB range after JPEG compression.

### Compression failure handling

If compression throws or returns nothing, log a console.warn with the cause, fall back to uploading the original file unchanged. **Never block the upload on compression failure** — the provider's intent is to attach the paper, not to debug a JS library.

### "Retake" affordance

**Minimal:** if a phone user captures a bad photo, the upload still happens; they wait, then click the trash icon on the just-uploaded row (existing soft-delete path) and re-tap Attach to capture a fresh shot. No new UI; reuses existing remove + attach.

A "preview-before-upload" step (display the captured image with a Retake / Use button) would be more clicks per attach and a new state machine. Defer unless a real provider asks. Phone users today expect the camera flow to commit on shutter; this matches that expectation.

---

## Cross-modal consistency

### The invariant

All three record modals (`ChildIntakeModal`, `EnrollmentConsentsModal`, `MedicationModal`) behave identically on save:

1. The modal stays mounted.
2. An inline ✓ chip appears near the relevant control.
3. The list / state updates in place (the just-saved ack appears in
   the modal's view).
4. Any open sub-form collapses; its state resets on next open via the
   conditional-mount pattern.
5. The modal closes only via the explicit X (header) or Close
   (footer) buttons.

### Reference

MedicationModal is the reference. Cross-references:
- `refresh()` does NOT call `onSaved` — `MedicationModal.jsx:179-202`.
- `showSuccess(key, text)` + 3s auto-clear — `MedicationModal.jsx:100-121`.
- Per-section chip keys (`auth-create`, `consent-otc-blanket`, `consent-per-auth:<id>`, `dose:<id>`) — `MedicationModal.jsx:205-308`.
- Sub-form reset via conditional mount — implicit; the modal renders `{addAuthOpen && <AuthorizationForm/>}` and `{doseOpen && <DoseEntryForm/>}`, so close-then-reopen produces fresh state.

### Per-modal legitimate deviations

None for this pass. EnrollmentConsentsModal's per-occurrence flow IS iterative (the misleading comment was right about the intent, wrong about the mechanism); after this fix, both intent and behavior match — the modal stays open across multiple per-trip captures, success chip per save, list updates in place.

The intake modal's bundle save is a one-shot action (vs. medication's per-row saves); the chip placement differs (top-of-body for the whole-bundle save vs. per-row in medication) but the underlying behavior is the same. Not a deviation, just a different chip location.

---

## Envelope-vs-per-form attach defaults — recommendation

The data model supports both: `consent_attachments` polymorphic
`(target_type='acknowledgment', target_id=<any ack id>)` — the
target can be either the `child_in_care_statement` envelope ack
(intake bundle) or a specific per-consent ack (field_trip,
photo_sharing, transport_routine_annual, medication_permission,
etc.). The choice is per-surface UX, not a data-model question.

### Two physical workflows (from the scope's "ground in reality" framing)

- **Phone-at-table:** the parent signs a single paper for a single
  consent (field-trip permission, photo consent, medication
  permission); the provider records "on file" and photographs the
  signed paper then and there. **One consent = one paper = one
  scan.** The per-consent attach surface matches this exactly. Adding
  an envelope-level "whole packet" affordance here would be clutter —
  the provider rarely has a packet at this moment.
- **Desktop-admin:** the provider has a scanned PDF packet
  containing many signed forms. They want to upload ONE file that
  covers everything. **One packet covers many consents.** An
  envelope-level affordance is the natural fit. But the data-layer
  also supports the workaround: upload the same file to each ack
  individually (4 uploads of the same PDF), which works today.

### Current per-surface defaults (already shipped)

| Modal | Current attach level | Maps to the natural workflow? |
|---|---|---|
| `ChildIntakeModal` | Envelope-level only (`target = child_in_care_statement ack`) | Yes — the intake bundle IS conceptually one paper packet; the sub-rows are checklist items, not separately-signed forms in practice. |
| `EnrollmentConsentsModal` | Per-consent (field-trip ack, photo ack, etc.) | Yes — these are independently-signed forms in the phone-at-table workflow. |
| `MedicationModal` | Per-medication-permission + per-child OTC-blanket | Yes — one signed paper per medication; one signed paper covers all topical OTC. |

### Recommendation: keep the current defaults

The per-modal defaults already match the natural workflow for each
modal's domain. The "one scan covers everything" desktop-admin case
on the consents and medication modals is uncommon and is handled by
the upload-same-file-multiple-times workaround.

**Don't expand attach surfaces in this pass.** Three reasons:
1. The save-exits bug is the urgent fix; expanding scope adds risk
   to the fix landing.
2. The expanded "envelope-level" surface on consents/medication
   would add UI clutter (a second slot at the modal top: "Whole-
   packet attach") for an edge case.
3. The data layer supports it cheaply when a real provider asks —
   adding an envelope-level slot is a 10-line UI addition; no
   migration.

**Flag for the build PR:** if a real provider says "I have a packet
and want to upload it once," the small follow-up is to add a
modal-top "whole-packet attach" slot that targets the
`child_in_care_statement` envelope ack (already exists for intake)
or a new "enrollment-packet" placeholder ack for consents. Decide
then; don't preempt.

---

## Backward compatibility / does-not-foreclose

- **Existing attachments unchanged.** The `consent_attachments`
  table is not touched. The Edge Function is not touched in this
  pass. Migration 029 + 030 land independently.
- **Existing modal mounts unchanged.** `FamiliesPage`'s `onSaved`
  prop is still passed; modals just don't call it from save paths.
  Future features that genuinely need a parent refresh can call
  `onSaved` from `onClose` — the prop's wiring is preserved.
- **MedicationModal unchanged.** It's the reference, not the patched
  surface. (Verifying in the PR that its tests still pass is the
  guard.)
- **Camera capture is additive.** Desktop ignores the hint; mobile
  gets a more direct path. No platform sniff.
- **Compression is opt-in by file type.** PDFs bypass entirely; small
  images bypass. The compression failure path falls back to the
  original; nothing breaks for an unusual file.
- **No retention / archive logic change.** Attachments still
  soft-delete via `archived_at`; the bucket still survives.

---

## Tests

Presentation behavior. The live check is the proof.

- **Build clean, vitest green.** Existing `ConsentAttachmentSlot`
  tests (none yet — added in a fast-follow if RTL is set up).
  Existing `consentAttachments.test.js` (Part 1 helper tests) and
  `consent-attachment-url.test.js` (Edge Function pure logic) must
  continue to pass — neither is touched.
- If the existing setup doesn't support component-level tests for
  the modal save behavior (no RTL infrastructure for `EnrollmentConsentsModal` or `ChildIntakeModal` either, mirroring the
  MedicationModal fix's same posture), note that and rely on the
  live check. Add `data-testid` markers on the success chips and
  the camera-capture input for the build PR to land hooks for
  future RTL tests.
- **The camera-capture attribute IS unit-testable** at the DOM
  level (assert the input has `capture="environment"`); add one
  small test for it if a render harness is mountable, otherwise
  rely on the live device check.

---

## Verification gate — live click-through (no SQL, no real-rows boundary)

This pass touches no data boundary; the cross-tenant boundary from
the consent-attachments PRs is unchanged. Verification is
presentation behavior.

### On a desktop

1. **Open ChildIntakeModal.** Fill the bundle. Click Save (or Send
   to Portal). The modal stays open; a sage-pale ✓ chip ("✓ Intake
   bundle recorded") appears at the top of the body; the recorded
   sub-row entries now show "On file"; the envelope-level
   attachment slot now appears (the envelope ack id is in state).
   Click Attach signed form, pick a PDF, confirm it uploads + the
   attachment appears in the slot's list. Modal still open.
2. **Open EnrollmentConsentsModal.** Click "Record" on field-trip
   permission. The modal stays open; a "✓ Consent recorded" chip
   appears in the field-trip row; the row flips to "Recorded";
   the attachment slot now appears beneath that row. Attach a
   PDF; confirm it lands. Modal still open.
3. **Click "Record consent" on photo sharing.** Same shape. Modal
   stays open. Attach. Modal still open.
4. **Click "Record a trip" on the per-occurrence section.** Fill
   the metadata, save. The modal stays open; the trip appears in
   the recent list; a "✓ Trip recorded" chip appears. Repeat for a
   second trip — modal stays open across both; no eject.
5. **Open MedicationModal.** Record a new authorization. Modal
   stays open; "✓ Medication saved" chip appears; the authorization
   appears in the active list. Record per-medication consent — chip,
   stays open. Log a dose — chip, stays open. This is the existing
   behavior; the test is that the new pattern hasn't regressed it.
6. **Modal close path.** Click X in each modal's header → modal
   closes. Click Close in each footer → modal closes. Confirm
   nothing in the modal body triggers close.

### On a phone

7. **Reopen any modal.** Tap "Attach signed form" — the OS camera
   opens directly (or with a "library" option in the OS picker).
   Photograph a real signed paper. Confirm the upload completes,
   the row appears with the filename + uploaded date. Tap View to
   confirm the file opens.
8. **Verify the at-the-table flow end-to-end.** Open a child's
   field-trip permission consent: tap Record → ✓ → tap Attach →
   camera → snap → upload → row appears. All in one modal session,
   no navigation, no friction.

### Pass criteria

All three modals stay open on every save; ✓ chip appears within
~1s; just-saved item is visible in the modal's view; attach slot
reachable in the same session for the just-saved consent; on
mobile, the attach control opens the camera; uploaded photos are
~1-2MB (compressed) for large originals; PDFs pass through
unchanged.

---

## Out of scope (explicitly deferred)

Named so they're not absorbed silently.

- **The compliance-state engine arc** — the compliance health
  score (planned V3+, gated on 7-10 signals existing), the per-child
  "what's missing" readiness checklist, and the auditor access mode
  (time-boxed scoped read-only inspector login). These are three
  faces of one compliance-state model and need their own scoping
  arc. Name them as the next arc; don't touch them here.
- **Per-occurrence (Phase C) attach** — the per-trip
  `ConsentAttachmentSlot` next to each occurrence row. Flagged in
  Part 2 as a fast-follow; out of this pass. (Note: with the modal
  staying open after a per-occurrence save in this pass, the
  follow-up's per-row attach surface becomes trivially reachable
  — the foundation is laid.)
- **Parent intake-view attach surface** — Part 2 surfaced parent
  attachment view in `ParentEnrollmentConsentsPanel` only; the
  parent intake page (`ParentIntakeAcknowledgePage`) doesn't render
  the envelope attachment yet. Fast-follow; not this pass.
- **Three parent-view bugs** (raw type string, per-occurrence
  miscategorization, no per-occurrence parent surface) — separate
  parked cluster; investigate in a sibling pass.
- **Per-modal "whole-packet" envelope attach** for the consents
  and medication modals — see decision 9 above. Real provider need
  surfaces it; not preempted.
- **Component-level RTL tests** for the modal save behavior — no
  RTL mounting infrastructure for these modals today (same posture
  as MedicationModal's earlier fix). Add `data-testid` hooks now;
  set up RTL in a separate scaffolding pass.
- **Pre-upload preview + retake UI** — see decision 8. Defer unless
  a real provider asks.
- **Drop or keep `capture="environment"` based on real-device
  feedback** — captured for the build PR's live-check note; not a
  decision to relitigate here.

---

## Halt for review — show

When CC picks this up for the build PR:

1. Confirmation grep that `onSaved?.()` and explicit `onClose?.()`
   are removed from all save handlers in both modals (the diagnosis
   evidence in §"Root cause" should match the diff exactly).
2. The new `refresh()` function in each modal, mirroring the
   medication-modal shape; explanatory comment at the removal site
   so the cascade isn't reintroduced.
3. The `successMessage` state + 3s auto-clear `useEffect` + the
   chip-placement props on each consent row / each intake save
   surface.
4. The `capture="environment"` attribute on the
   `ConsentAttachmentSlot`'s file input.
5. The compression branch in `ConsentAttachmentSlot.handleFile`
   (or a sibling helper in `src/lib/storage.js` — propose location
   in the build PR) with the file-type gate, the 1MB threshold,
   the 1800px maxWidthOrHeight, and the fall-back-to-original
   error path.
6. Live verification: each of the 8 steps in §"Verification gate"
   passing on the preview, with the phone steps run on a real
   device (iOS Safari + Chrome Android if possible).

Do NOT merge until the live click-through on a real phone confirms
the camera-capture motion. This is presentation behavior — vitest
green doesn't prove it; the device check does.

---

**End of consent-attachment-ux scope — FINAL.** No schema change.
All decisions resolve cleanly. Ready to hand to CC for the build.
