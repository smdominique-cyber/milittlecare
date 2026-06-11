# PR Scope — Messaging Photo-Consent Reminder (binary fast-follow)
# + captured design: three-state photo consent (next chapter)

**Date:** 2026-05-30
**Status:** Scope — ready for CC.
**Branch (suggested):** `feature/messaging-photo-consent-reminder`
**Builds on:** Consents Phase A (now on `main`) — `photo_sharing_consent` /
`photo_sharing_consent_revoked`, the shared `pendingEnrollmentConsentsForChild`
verdict function in `src/lib/childFiles.js`, and the messaging photo-attachment
path in `src/lib/messages.js` + the messaging pages.

---

## PART 1 — THIS PR: binary photo-consent reminder (small, honest)

### What it is (and explicitly is NOT)
Phase A records photo consent as binary (consented / revoked) and the copy
already admits enforcement is deferred. This PR closes that gap — but only as
far as the binary model honestly allows.

**Hard truth that bounds this PR:** the system CANNOT inspect photo content.
It does not know whether a given attachment depicts the consent-governed
child, another child, or nothing (a menu, a flyer, a sign-up sheet). So this
PR does NOT block, and does NOT claim a photo "violates consent." It surfaces
a **non-blocking contextual reminder** of the consent STATE and leaves the
content judgment to the provider (the licensed human, the only party who can
see what's in the photo).

### Behavior
- **Trigger:** provider is about to attach/send a photo in a message thread
  for a child whose `photo_sharing_consent` is in the **revoked** state (an
  active `photo_sharing_consent_revoked` recorded via a satisfying channel),
  OR has **no consent captured either way**. (Both "revoked" and "never
  captured" → show the reminder. Only an active affirmative consent → no
  reminder.)
- **The reminder:** a non-blocking note at attach/send time, e.g.
  "Photo consent for [child] is on file as withdrawn (or not yet recorded).
  If this photo includes [child], consider whether to send it." Send ALWAYS
  proceeds — the provider clicks through.
- **No logging of the send as an 'override'.** Per the design discussion: the
  photo may not even depict the child, so recording "sent despite revocation"
  would imply a violation that may not have occurred. The reminder is a
  courtesy memory-aid, not a compliance event. Do NOT write an audit row for
  proceeding.
- **Text-only messages are untouched.** This gates the photo-attachment UI
  only.

### Reuse, don't reimplement
- Read consent state via the SAME `pendingEnrollmentConsentsForChild` (or a
  thin sibling that exposes the photo-specific verdict) from Phase A — do NOT
  write a fourth inline copy of the channel/revocation rule. This is the
  natural payoff of the parity refactor, AND building it exercises the
  Phase A consent-read path end-to-end (which doubles as the live
  verification that's still outstanding for Phase A).
- The thread is already child-scoped (per the Phase A findings), so the
  child to check is identifiable from the thread context.

### No migration
Reading existing consent state; no schema change. If anything seems to force
a migration, STOP and flag — it shouldn't.

### Tests
- Photo attach in a thread for a revoked-consent child → reminder shown,
  send still allowed.
- Photo attach for a no-consent-captured child → reminder shown.
- Photo attach for an affirmatively-consented child → NO reminder.
- Text message (no photo) → never gated, regardless of consent state.
- The consent read goes through the shared verdict function (assert no
  inline reimplementation).
- build clean.

### Halt — show:
1. Where the reminder fires + confirmation it's non-blocking (send proceeds).
2. The exact reminder copy (must NOT claim a violation; must frame as
   "if this photo includes [child]").
3. Confirmation the consent read reuses the shared Phase A function.
4. No audit row written on proceed. No migration.
Do NOT deploy or merge.

---

## PART 2 — CAPTURED FOR NEXT CHAPTER: three-state photo consent (NOT this PR)

**This is the real feature.** Captured here so it's not lost; it is a
deliberate Phase A *revision* and wants its own scoping pass with fresh brain
+ a migration plan. Do NOT build it in the reminder PR above.

### The model (Seth's design, 2026-05-30)
A per-child photo-consent traffic light, shown in that child's message
thread:

- 🟢 **GREEN — full sharing:** parent consents to photos that include their
  child even in group/shared contexts (class photo with their kid in it = OK).
- 🟡 **YELLOW — restricted:** photos ONLY of their own child individually;
  group photos where their child appears are NOT OK.
- 🔴 **RED — none:** no photos of the child at all.

### Why this is a model change, not a UI tweak
Phase A's photo consent is BINARY (`photo_sharing_consent` +
`photo_sharing_consent_revoked` pair = 2 states). The traffic light needs
THREE states, and the middle state (yellow: group-vs-individual) encodes a
distinction the binary model has nowhere to store. So this requires:

- **Data model:** carry the LEVEL (green/yellow/red). Options to weigh at
  scoping: a level field/payload on a single consent type, vs. three distinct
  types, vs. a status enum. Likely a migration (a level column or value).
- **Existing-row mapping (the migration's key question):** Phase A consents
  already recorded in production are binary. Decide how they map —
  does an existing affirmative `photo_sharing_consent` become GREEN or
  YELLOW? (Conservative reading: probably YELLOW — "they said yes to photos
  of their child" doesn't clearly mean "yes to group photos." But that's a
  consent-semantics call — confirm intent; arguably re-ask the parent rather
  than assume.) An existing `photo_sharing_consent_revoked` → RED.
- **Provider modal:** capture three choices instead of consent/revoke (the
  same modal whose spacing was just fixed).
- **Shared verdict function + audit state:** `pendingEnrollmentConsentsForChild`
  and the audit-state blocks must understand three states; "captured" =
  "a level is set." Pending logic changes.
- **#22 compliance score:** still provider-protective (not licensing) — but
  now has a level dimension.

### The enforcement limit STILL applies
Even with three states, the system cannot inspect photo content — it can't
tell a group photo from an individual from a menu. So the traffic light
COMMUNICATES the parent's stated preference to the provider; it does not
mechanically enforce "this specific photo is a group shot, block it." Yellow
shows yellow; the provider applies the judgment. Same fundamental limit as
the binary reminder — the light informs, the human decides.

### Sequencing
Build AFTER the binary reminder ships. This is a fresh-brain PR: model
change + migration + existing-row mapping + modal + audit + UI. Scope it
deliberately when rested; don't tail-end it.
