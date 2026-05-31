# MILittleCare — Roadmap & Open Items
**Captured: 2026-05-29 (end of long build session)**

This is a capture-only note. Nothing here is scoped to build yet — the
items marked "scope fresh" need daytime-brain decisions before CC builds
them. Priority order is set so compliance-critical work (July deadline)
stays ahead of polish.

---

## STATUS: PR #16 (Child Files / R 400.1907 Intake Acknowledgments) — DONE

Closed and proven this session. The full parent-confirm loop works end to
end on a complete bundle:

- Crash fixed, provider lookup fixed, premises gate added, recipient
  routing fixed (emails reach the parent, not the provider).
- Channel-aware audit: all five parent-signed types tracked; provider
  attestation (`provider_override`) does NOT satisfy parent-signed items —
  only `parent_portal` / `in_person_paper` do. Lead is inform-only.
- Atomic confirm via SECURITY DEFINER RPC `intake_confirm_for_parent`
  (migration 025, applied + verified in production). Archive + insert +
  reminder-resolve in one transaction. Fixed the duplicate-key bug that
  blocked parent confirm.
- Verified live: complete bundle for child "Becky" (8 types incl.
  firearms, lead, infant_safe_sleep) — provider_override rows archived,
  parent_portal rows active, all at one atomic timestamp.

### Remaining #16 housekeeping (do next session, fresh)
- **TEST-DATA CLEANUP** — accumulated test reminders + ack rows across the
  Drambau and Dominique families, plus confirmed Becky/Aleshia bundles and
  stale Aiden reminders. Use preview-then-delete discipline (SELECT to
  confirm exactly what's being deleted, THEN delete). Do this before
  building anything new so the table is clean.

---

## ✅ SHIPPED 2026-05-29 (late session) — Licensing acknowledgment fix

**This was Priority 1; it's now DONE and in production.** What actually
happened differed from the original assumption, so read this carefully:

- Investigation found the existing `licensing_notebook_offered` type was
  ambiguously NAMED but its substance already mapped to R 400.1907(1)(b)(vii)
  (notice of THIS home's licensing notebook availability per R 400.1906(3)).
  The "offered" verb was misleading.
- So (vii) was already captured. The genuinely-MISSING item was
  **R 400.1907(1)(b)(iii)** — "parent was offered a copy of the licensing
  RULES (R 400.1901–1951)."
- Fix (Option A, no-migration): renamed JS constant
  `LICENSING_NOTEBOOK_OFFERED` → `LICENSING_NOTEBOOK_AVAILABILITY` (DB string
  value `'licensing_notebook_offered'` PRESERVED — no migration), and added
  new type `LICENSING_RULES_OFFERED` = `'licensing_rules_offered'` for (iii).
- Both parent-signed, always required. Wired through PARENT_SIGNED_TYPES +
  requiredSubTypesForChild + labels + audit-state. 830 tests passing.
- Merged to main, deployed to production (Vercel green).
- A regulatory subitem→constant mapping comment was added in
  `acknowledgments.js` — this is the durable record; confirm with consultant
  before #22.

### Two follow-ups this created (DO NOT LOSE):

**(a) Post-deploy verify (30 sec, do next session):** pull a child with an
existing `licensing_notebook_offered` row and confirm its audit state reads
the same as before the deploy — the "did the rename quietly change existing-
row counting" check. Not expected to be a problem (string preserved, type was
already parent-signed), but it's the cheap confirmation against the one risk.

**(b) BACKFILL QUESTION (compliance, consultant):** the parent-signed
requirement set GREW — every child now needs the (iii) rules-offered
acknowledgment, which didn't exist before this deploy. So every child
confirmed BEFORE 2026-05-29 is now missing (iii). Question for the licensing
consultant: do already-enrolled families need to re-acknowledge to capture
(iii), or does it only apply to new enrollments going forward? This is a
compliance/regulatory call, not a code bug. #22 will surface these children
as having a pending (iii) signature until resolved.

**(c) DEFERRED TECH DEBT (DB-string clarity):** the DB string
`'licensing_notebook_offered'` now permanently MEANS (vii)-availability,
which is misleading to anyone reading the raw `acknowledgments` table (the
string says "offered," an auditor might read it as (iii)). Code comments
document it but the DB doesn't carry comments. Eventual clean fix = a one-shot
UPDATE migration to rewrite the string value to something like
`'licensing_notebook_availability'`. Deferred (not worth the live-row rewrite
risk now); park as tech debt. Touch only with a deliberate migration.

---

## PRIORITY 1 — R 400.1907(vii) Notebook-Availability Item (GAP-FILL) [SUPERSEDED — see SHIPPED section above]

**Highest-priority small task. This is a gap in already-shipped work, not
new scope.**

The intake bundle was built against the 2019 rules (six child-in-care
statement items). The **current 2026 rules** (effective April 27, 2026 —
already in effect) added a SEVENTH required parent acknowledgment to
R 400.1907(1)(b):

> **(vii) Notice of the availability of the child care home's licensing
> notebook** and that it contains the items described in R 400.1906(3).

This is a parent-signed acknowledgment that belongs in the exact intake
bundle PR #16 just perfected. The app is currently NOT capturing it.

- Add `licensing_notebook_availability` (or similar) as a new
  parent-signed acknowledgment type.
- It's a parent-signed item (same channel rules as the other five —
  satisfied by parent_portal / in_person_paper).
- Folds into the existing acknowledgments engine + audit-state helper.
- Fast, deadline-relevant. Do before any branding work.

**Caveat:** confirm the exact item with the licensing consultant — the
rule text is clear that it's required, but the precise wording/form of the
acknowledgment is worth verifying.

---

## PRIORITY 2 — Operational & Protective Consents PR (NEW, scope fresh)

Extends the acknowledgments engine from "intake" to "ongoing consents."
Reuses existing infrastructure (polymorphic acknowledgments table,
parent-portal confirm flow, audit-state helper) — these are new
acknowledgment TYPES, not new architecture. **This outranks branding on
the compliance roadmap.**

Two distinct sub-categories — keep them tagged separately so the
compliance score (#22) never conflates them:

### 2a — Licensing-REQUIRED consents (MiLEAP can ask for these)
Each rule explicitly requires written parent permission. **Each has a
different cadence — model carefully, do NOT treat as generic "sign once"
(same trap as the firearms "always vs if-applicable" nuance).**

| Consent | Rule (2026) | Cadence |
|---|---|---|
| Transportation | R 400.1952(1) | Annually (routine) + before each non-routine trip |
| Non-vehicle field trips | R 400.1952(2) | Once at initial enrollment |
| Water activities | R 400.1934(10) | Per off-premises trip + once per season on-premises |
| Medication | R 400.1931(2) | Per-medication, prior written permission (has its own label/recordkeeping rules) |
| Religious objection to emergency medical tx | R 400.1907(1)(d) | If applicable, signed parent statement |

### 2b — Provider-PROTECTIVE consent (liability/trust, NOT licensing-mandated)
- **Generic photo-sharing consent.** Licensing rules are SILENT on photo
  sharing (verified against both 2019 and 2026 rule sets — no provision
  governs provider→parent digital photo sharing). So no licensing
  requirement is being missed. But consent should still be captured for
  liability/parent-trust reasons — this is the app doing its job on
  something the code leaves to the provider.
  - **Cadence:** once at enrollment, durable until revoked.
  - **Must be REVOCABLE** — withdrawal should actually stop sharing and be
    reflected in system state. (Connects to any future photo expansion:
    consent state should gate parent self-upload / broader sharing.)
  - **Scope narrowly first:** consent to share photos of the parent's OWN
    child, WITH that parent (lowest stakes — what messaging does today).
    Broader uses (marketing, white-label welcome content, multi-child
    photos) = separate, more carefully-worded consents IF ever wanted.
  - **The consent LANGUAGE needs legal/insurer review** — the app captures
    and tracks; whether the wording actually protects you is a
    lawyer/insurer question, not a licensing-rule or AI question.

### #22 tagging note
Tag 2a (licensing-required) and 2b (provider-protective) as DISTINCT
categories in the compliance score. A missing transportation consent is a
real compliance gap; a missing photo consent is a prudence gap, not a
licensing violation. Conflating them makes the score lie in both
directions.

---

## PRIORITY 3 — Existing Compliance Roadmap (#22 etc.)
The Compliance Health Score (#22) should consume:
- The five (now six, with notebook item) intake acknowledgment types.
- The new operational + protective consents above.
- **Do NOT treat `intake_completed_at` as "compliant"** — it's set at
  send time, before parent signs. The real signal is
  `pending_parent_signatures_count == 0`.
- **Rule-7 interpretation to confirm with licensing consultant before #22
  ships:** does provider attestation satisfy parent-signed items, or is
  parent signature required? Current code assumes parent signature
  required (provider_override does NOT satisfy). Revisitable by editing
  `PARENT_SIGNED_SATISFYING_CHANNELS` in `src/lib/childFiles.js`.

---

## PRIORITY 4 — Parent Portal Fixes (non-compliance, do when convenient)

### 4a — Home-screen intake banner is BROKEN (live bug)
- Branch `feature/pr-16-parent-home-intake-banner` is built, mount test
  passes — but the banner does NOT render on `/parent` home even when the
  data is present.
- **Confirmed live:** child "Becky" showed on the `/parent/intake-acknowledge`
  intake PAGE but NOT on the home banner, despite an unresolved reminder
  existing. The intake page and the banner use the SAME `listPendingForParent`
  helper — so the page rendering Becky while the banner doesn't means it's a
  real banner bug, not a `fired_at` / cron-timing issue.
- **Debug next session:** F12 on `/parent` home — does `listPendingForParent`
  return the reminder there? If yes, the banner has a render bug. If it
  returns empty there but not on the page, the banner calls it differently
  than the page does. (Mount test passing proved logic, not live render —
  same lesson as the whole session.)
- Possible related design question: reminders are written at send time but
  `fired_at` stays null until the cron tick. Consider firing intake
  reminders immediately on send so the parent sees them right away
  ("provider says 'I just sent it'" → parent should see it now). Design
  refinement, not a bug.

### 4b — Password banner shows for parents who ALREADY have a password
- The "Skip the email — set a password" nudge on `/parent` home is showing
  for a parent who already set a password. It isn't checking password
  state (or isn't checking it at all — just always rendering for
  magic-link sessions).
- Gate it on whether the parent has set a password.
- Pre-existing bug, spotted this session. Low priority, unrelated to #16.

---

## PRIORITY 5 — Branding / White-Label (PRIDE, not deadline — after compliance is safe)

Goal: make the parent-facing portal something a provider takes pride in
showing to current and prospective parents. Provider's brand front and
center; MILittleCare present but quiet. Build order: branding foundation
first (cheapest, highest pride, lowest risk), everything else after.

### 5a — Branding foundation (do first within this track)
- Provider business name as portal title (e.g. "Drambau Family Care Page")
  replacing hardcoded "MI Little Care." Field `daycare_name` already exists
  (used in email sender name). Text-only change for the name itself.
- Provider logo upload, shown in header. (Adds image storage — but
  provider's OWN logo, no kid-photo consent/privacy weight.)
- Small **"Hosted by: MI Little Care"** attribution — present, not
  prominent. (Decision made: keep attribution, keep it low-key. Preserves
  your brand visibility for growth without making the portal feel
  co-branded.)
- Visual/design pass on existing surfaces (attendance, balance, payments,
  info requests) so they LOOK as professional as they function.

### 5b — Welcome content
- Provider-written welcome message, auto-hides after ~a month so it doesn't
  go stale.

### 5c — Event calendar with prep notes
- Events with per-event "what to bring" notes (water day → swim clothes,
  zoo → walking shoes, paint project → old clothes). The prep-note pattern
  is the valuable part.
- Provider-level calendar (all families see it) unless family-specific is
  wanted later. Real data model — its own scope.

### 5d — Photos (family-scoped by construction — highest governance)
- **Photo sharing ALREADY EXISTS** (provider→parent, child-scoped, in the
  messaging feature). Verified live.
- Principle: **scope photos to a single family by construction.** Parent
  uploads their own child's portrait to their own portal; provider
  day-photos go through per-family messaging. NEVER a provider-managed
  portal-wide gallery (that's where cross-family consent gets hard).
- Depends on the photo-sharing consent (Priority 2b) being in place before
  expanding photo features.

---

## STANDING CAVEATS (apply to all compliance/legal items above)
- The licensing-rule readings here are careful-reader interpretations, NOT
  legal advice. Identifying WHICH consents the rules enumerate is
  low-risk (it's in the text). Whether the app's IMPLEMENTATION (cadence,
  valid-signature definition, electronic-signature validity) satisfies
  MiLEAP is a **licensing-consultant** question.
- Photo-consent LANGUAGE and liability coverage = **lawyer + insurer**
  question, not licensing rules and not AI.
- The 2026 rule set (effective April 27, 2026) is the CURRENT one and
  differs from the 2019 set — renumbered rules, and the new R 400.1907(vii)
  notebook item. Build against 2026, not 2019.

---

## QUICK PRIORITY SUMMARY
1. **Test-data cleanup** (housekeeping, do first, preview-then-delete).
2. **R 400.1907(vii) notebook item** — gap-fill, deadline-relevant, fast.
3. **Operational + protective consents PR** — compliance value, scope each
   cadence carefully. Ahead of branding.
4. **#22 compliance score** — consumes all consent types; confirm Rule-7
   interpretation with consultant first.
5. **Parent portal fixes** — broken home banner (4a), stale password
   banner (4b). Non-compliance, when convenient.
6. **Branding / white-label** — pride, after compliance is safe.
