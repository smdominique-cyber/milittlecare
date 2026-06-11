# PR Scope — Compliance Engine Phase 3.1: Actionable guidance + deep-link-to-fix on the compliance checklist

**Date:** 2026-06-05
**Status:** Scope — **DRAFT for review.** Two genuinely open calls for
Seth: (a) **the regulatory accuracy of per-requirement guidance copy**
(every "NEEDS SETH REVIEW" row in §2 must be confirmed before build —
the rule readings here are careful-reader interpretations, not legal
advice; Seth + the licensing consultant are the accuracy check); (b)
**which fix targets get new deep-link param-handling in 3.1 vs deferred
to a 3.2 follow-up** (the sub-work inventory in §4 — every "needs new
param handling" row is a size-vs-deadline call). Decisions 1, 5, 6, 7,
8 are LOCKED by Seth per the parent prompt. The component contract (§1)
and the read-only boundary (§5) are mechanical.
**Parent docs (authoritative — read first):**
`docs/pr-compliance-engine-scope.md` (the three-faces design + §8
sequencing this slots into), `docs/pr-compliance-engine-phase-1-scope.md`
(the 52-row registry + the §2a governing principle), the Phase 3 scope
doc on branch `docs/compliance-engine-phase-3-scope` (commit `73ab3cd`),
and the merged Phase 3 build on `main` at commit **`b6dd1d5`**. Code-side:
`src/lib/complianceState.js` (REQUIREMENT_REGISTRY, six state kinds,
`classifyUnknownReason` with the three unknown sub-buckets including
`needs_provider_data` and `feature_not_yet_shipped`),
`src/components/compliance/ChecklistRow.jsx` (where rows render today),
`src/pages/ComplianceChecklistPage.jsx` + `FamilyComplianceTab.jsx`
(the two consumer surfaces), `src/pages/FamiliesPage.jsx` (the
Phase 3 Finding #5 `useSearchParams` precedent), `docs/feature-interaction-map.md`
(the route inventory + §15 divergences).
**Branch (suggested):** `feature/compliance-engine-phase-3-1`. Single
build: the `<ActionableGap>` primitive + integration into `ChecklistRow`
+ the per-requirement guidance content + whichever destination-surface
param-handling makes the in-scope cut from §4.
**Schema change:** **ZERO.** No migration. No RPC. No engine change. Pure
UI + content addition. The registry's `severity` + `data_state` +
`rule_citation` fields are already in place from Phase 1; 3.1 reads
them.

---

## Summary

Phase 3 shipped the checklist as a read-only display. Every gap row
states what's wrong ("Missing — needs staff record", "Expired
2026-04-12 — renew now", "Tell us about this", "Tracking ships with
PR #19 — keep paper records for now"). What no row tells the provider
is **how** to fix it — and where a real fix surface exists, no row
takes them there.

3.1 adds two pieces to every gap row:

1. **Plain-language guidance** — what the provider needs to DO to
   resolve the gap. Reads like "Send the parent the intake bundle so
   they can sign the lead-paint disclosure." Always present (or
   intentionally text-only when no actionable target exists).
2. **A deep-link button** — `Open [destination]` — that navigates
   directly to the surface where the fix happens. Only rendered when
   a real destination exists. **A button to nowhere is worse than no
   button** — locked by Seth.

Both pieces are delivered through a single reusable primitive
(`<ActionableGap>`, §1), built generic enough that future adopters
(dashboard reminder banners, Staff Training expiring-cert rows,
MiRegistry warning banner, iBilling review-grid issues, funding
vault) can plug it in unchanged. 3.1 ships it on the compliance
checklist **only** — prove the contract in one place; other adopters
are separate later PRs.

The load-bearing piece is **§2** — the per-requirement guidance and
fix-target table. For each of the **51 registry rows** (was 52;
`funding_dhs_198_on_file` removed 2026-06-06 per the CDC-layer
correctness pass — DHS-198 is an MDHHS notice TO the provider,
not an obligation they fulfill), organized by fix-surface, the doc
specifies the plain-language guidance and the deep-link target.
Rows where CC is not confident about regulatory
accuracy are marked **NEEDS SETH REVIEW**.

What this scope does NOT do: ship the score (Phase 4); ship the
auditor access mode (Phase 5); add inline editing on the checklist
itself (the read-only boundary stays — §5); add `<ActionableGap>` to
any surface other than the compliance checklist; change the engine
API; change any registry row; modify Phase 3's gates (opt-in,
licensed-home, loading-race, etc., all preserved).

---

## DECISIONS — RESOLVED (and the three genuinely open ones)

The format follows the Phase 3 scope doc + Y1 scope rigor. For Seth's
calls (#2 + #4 + #12 — guidance accuracy and which sub-work makes 3.1
vs. 3.2), the options are presented inline below; the table entry
says "Seth's call — see §X."

| # | Decision | Resolution |
|---|---|---|
| 1 | Both tiers ship: guidance text + deep-link button. | **LOCKED by Seth.** Every gap row gets guidance copy. Rows with a real fix destination ALSO get a deep-link button. The two-tier model handles the surface-doesn't-exist case (Pattern E / not-yet-shipped) and the surface-is-the-checklist-itself case (rare; mostly system-enforced rows like `medication_dose_log_retention`) without producing dead buttons. |
| 2 | Per-requirement guidance content + fix-target mapping (§2 — THE core work). | **Seth's call — see §2.** CC drafts guidance for every registry row + groups rows by fix-surface. Every row CC isn't confident about (regulatory framing, the right verb, "would a licensing inspector accept this guidance as correct?") is marked **NEEDS SETH REVIEW**. The first build PR pulls only the CONFIRMED guidance into production; NEEDS-REVIEW rows ship as text-only ("Contact your provider documentation / licensing consultant") until Seth confirms. |
| 3 | Deep-link where a real target exists; text-only where it doesn't. | **LOCKED by Seth.** A button labeled "Open intake bundle" that lands on a generic Families list is worse than no button. The `<ActionableGap>` contract enforces this: omitting the `fixTarget` prop renders text-only. |
| 4 | Component contract + namespace. | **LOCKED (with one §3.3 question).** New shared primitive `<ActionableGap>` in **`src/components/ui/`** (not `src/components/compliance/`) — the namespace signals reuse. Contract in §1. Built day-one to be drop-in for future adopters (dashboard banners, Staff Training, etc.) without compliance-specific assumptions. The one open call: should an optional `severity` prop drive button color/emphasis or should the consumer style separately? Recommendation: pass `severity` through — it's already on every registry row and aligns the visual hierarchy with the engine's truth. |
| 5 | Reusable component built day-one, shipped on compliance only. | **LOCKED by Seth.** Prove the contract in one place; other adopters (dashboard banners, Staff Training, MiRegistry warning banner, iBilling, funding vault) are separate later PRs — each will be a small follow-up that imports `<ActionableGap>` and supplies its own guidance + fix-target content. |
| 6 | Bucket-to-action mapping (§3). | **LOCKED.** The engine's six state kinds + three `unknown` sub-buckets each map to a specific `<ActionableGap>` shape. `feature_not_yet_shipped` and `not_applicable` rows get **no fix button** — the first because no surface to fix on; the second because no action to take. `data_anomaly` rows get guidance-only ("Contact support — record has a malformed date / engine couldn't classify"). Other buckets get the full guidance + fix-target treatment. |
| 7 | Read-only-ness preserved. | **LOCKED by Seth.** 3.1 adds navigation to fix surfaces. It does NOT add inline editing on the checklist itself. The checklist stays read-only; the fix happens on the destination. This keeps the rendering layer pure and the capture flows un-duplicated. |
| 8 | Phase 3 deep-link infrastructure reuse (the FamiliesPage `useSearchParams` precedent). | **LOCKED.** The Phase 3 Finding #5 fix established the pattern: `useSearchParams` + `KNOWN_TABS` validator + `initialTab` prop threaded into the family modal + `clearDeepLinkParams` on close. Every fix target that lands in FamiliesPage reuses this scheme — no new param convention. The helpers stay inline in `FamiliesPage` for 3.1; **extract into a shared module the moment a second deep-link consumer appears** (already flagged in `docs/tech_debt.md` as a Phase 3 follow-up). |
| 9 | Fix targets that need NEW param-handling on their destination page (sub-work). | **Seth's call — see §4.** Enumerated below in §4.2. Each is a small page-level addition (a `useSearchParams` handler, a few `KNOWN_*` validators, a scroll/focus effect). Recommendation: scope the **3.1 in-cut** to fix targets that already work via FamiliesPage's `?family=&tab=&child=` scheme PLUS BusinessInfoPage's `?section=` (a tiny addition); push everything that requires a brand-new page-level handler (StaffTrainingPage, MiRegistryPage, IBillingPage, BillingPage) into a **3.2 follow-up** that adds them surface-by-surface, each with the same shape. Rationale: extraction-then-adoption costs less than building one-off param schemes per surface; 3.1's value is the component contract + the easy wins, not waiting on the slowest adopter. |
| 10 | BusinessInfoPage `?section=` deep-link support (one-line precondition for 3.1's main fix-target). | **LOCKED — in scope for 3.1.** Phase 3's ChecklistRow already emits `<Link to="/business-info?section=compliance_applicability">` for `awaiting_input` rows, but BusinessInfoPage doesn't actually consume `?section=` (the user lands on the page and clicks the section tab themselves). 3.1 fixes that with a small `useSearchParams` + `setActiveSection` effect in BusinessInfoPage. Same shape as the FamiliesPage Finding #5 fix; reuses the same KNOWN_* validator pattern. ~10 lines. |
| 11 | Guidance text is content, not registry data. | **LOCKED.** Guidance copy lives in a content map adjacent to `ChecklistRow.jsx` (or a sibling content module), keyed by `requirement_key` + the state bucket. NOT in `REQUIREMENT_REGISTRY` itself — the engine stays pure and free of presentation strings, same posture as `NEEDS_PROVIDER_DATA_COPY` from the Phase 3 fix-forward. Future content edits don't touch the engine. |
| 12 | Per-state guidance + button copy (§3 mapping). | **LOCKED.** The button label per bucket: missing_required = "Open [surface]"; expired = "Renew now"; pending_parent = "View parent acknowledgment" (or "Send reminder" when reminder integration exists — out of scope for 3.1); needs_provider_data = "Edit record"; awaiting_input = "Answer in Business Info"; feature_not_yet_shipped = no button; not_applicable = no button. |
| 13 | Verification gate. | **LOCKED — see §6.** Three classes: (a) component-level — `<ActionableGap>` renders identically with/without `fixTarget`; severity tiering visible; no console warnings on degraded inputs. (b) per-row content — Seth-confirmed guidance renders on every applicable registry row; NEEDS-REVIEW rows render text-only fallback. (c) live deep-link round-trip — every in-scope fix-target lands on the right destination (reuses Phase 3 Finding #5's verification pattern + adds the new BusinessInfoPage `?section=` round-trip). |
| 14 | Schema impact. | **LOCKED: ZERO.** No migration. No RPC. No table. No registry change. Pure UI + content. |
| 15 | Backward compatibility. | **LOCKED.** Every existing surface keeps its current behavior. The Phase 3 ChecklistRow's existing six-state rendering is preserved; 3.1 EXTENDS it (adds the `<ActionableGap>` block beneath the primary row content). Existing tests pass unchanged. |
| 16 | Future-PR extraction of deep-link helpers (`clearDeepLinkParams`, KNOWN_TABS validator pattern). | **DEFERRED.** Per Phase 3 tech_debt entry, extract when a second consumer appears. 3.1's BusinessInfoPage adoption is the second consumer in spirit, but it's small enough (one `?section=` validator) that duplicating the inline pattern is cheaper than extracting now. Revisit when the 3.2 surface-by-surface sub-work lands StaffTrainingPage / MiRegistryPage / etc. — at that point an extracted helper saves real LOC. |

---

## §1. The reusable component contract (`<ActionableGap>`)

### Where it lives

**`src/components/ui/ActionableGap.jsx`** — the shared UI namespace,
not `src/components/compliance/`. The component IS compliance-built
(3.1 ships it on the compliance checklist), but the contract has no
compliance-specific assumptions. Putting it under `src/components/ui/`
signals reuse and discourages a future adopter from copy-pasting a
compliance-namespaced primitive into their domain.

Alongside the component (in the same file or a sibling
`ActionableGap.css` if styles grow): the shared types and exports.

### Public contract (as shipped in 3.1a)

```jsx
import ActionableGap from '@/components/ui/ActionableGap'

<ActionableGap
  // REQUIRED — the plain-language "how to resolve" copy. A plain
  // string, 1-3 sentences, matter-of-fact, no marketing voice.
  // Empty/absent → the component renders nothing (defensive).
  guidanceText="Capture the parent's signature on the lead-paint disclosure. R 400.1913 requires it for homes built before 1978."

  // OPTIONAL — when present AND fully built (both fields), renders a
  // react-router <Link> styled as a button. When absent or partial,
  // ONLY the guidance text shows — there is NEVER a dead or disabled
  // button. `to` is the COMPLETE destination, query string included;
  // the caller builds it (checklistGuidance.js owns that for the
  // compliance checklist).
  fixTarget={{
    label: 'Open this child in Families',
    to:    '/families?family=f1&child=c1&tab=children',
  }}

  // OPTIONAL — visual weight of the guidance TEXT only. It does not
  // gate the button or change behavior. Defaults to 'info'; unknown
  // values fall back to 'info'.
  severity="critical"  // 'critical' | 'warning' | 'info'
/>
```

There is **no citation prop** — the rule citation stays in the
surrounding row (ChecklistRow), which also keeps its own state color
and icon. There is no `variant` and no `prepend`: the
`feature_not_yet_shipped` and `data_anomaly` treatments are just
`severity='info'` text-only renders; the content map supplies the
copy, not a component mode.

### Render shape

```
┌─────────────────────────────────────────────────────────────────┐
│  Plain-language guidance copy here. One to three sentences,      │
│  matter-of-fact, no marketing voice.                             │
│  [Open [destination] →]   ← link only when fixTarget is complete │
└─────────────────────────────────────────────────────────────────┘
```

### Severity tiering

| `severity` | Guidance text visual |
|---|---|
| `critical` | Ink color, medium weight (500) |
| `warning` | Ink color, regular weight |
| `info` | Mid-ink (muted), regular weight |

These mirror the three weights the checklist actually distinguishes
(`missing_required`/`needs_provider_data` → critical;
`expired`/`pending_parent`/`awaiting_input` → warning; informational
buckets → info). Per-row overrides exist in the content map (F2's
expired state renders `info` — the Level 2 pay-tier reframe). The
container carries `actionable-gap--<severity>` classes for future CSS;
the registry's own four-level `severity` field is unrelated and is NOT
consumed by this component.

### Content lives in `checklistGuidance.js`, not here

The compliance adoption resolves all props through
`actionableGapPropsFor({ requirement, state, context })` in
`src/components/compliance/checklistGuidance.js` — an importable,
unit-testable content map (decision #11). It owns the per-row copy,
the severity overrides, the fixTarget builders (Surfaces 1/2/5 only in
3.1a), and the unknown-bucket branching via `classifyUnknownReason`
(load_failure → "refresh to retry"; data_anomaly → "contact support").
Family/child-scoped targets require the consumer to pass a
`fixContext` (`{ familyId, childId }`); absent context degrades to
text-only — never a dead button.

### Why a primitive, not just an inline render in ChecklistRow

Future adopters identified in Phase 3 tech_debt:

- Dashboard reminder banners (`src/components/dashboard/ReminderBanners.jsx`
  + the three legacy bespoke banners).
- Staff Training matrix expired-cert rows.
- MiRegistry warning banner.
- iBilling review-grid issue cells.
- Funding document vault expiring-document chips.

Each of these surfaces some kind of "you're missing X / this is
expired / take action" affordance today, rendered ad-hoc per surface.
A shared `<ActionableGap>` standardizes the affordance and the deep-
link convention. 3.1's compliance use IS the first adopter; the rest
follow when their PRs ship.

### Accessibility

- `guidanceText` is normal document content; screen readers read the
  description before the link.
- The fix affordance is a real `<Link>` (anchor semantics, keyboard
  focusable, visible text label) — not a div-button, never `disabled`.
- Severity is conveyed by the surrounding row's icon + state color,
  not by the gap's text weight alone.

---

## §2. Per-requirement guidance + fix-target table (THE core work)

This is the load-bearing section. Each registry row gets:

1. **Bucket states it can be in** (which of the engine's six state
   kinds + unknown sub-buckets actually fire for this requirement).
2. **Guidance copy** for each gap-producing bucket — plain language,
   matter-of-fact, audit-relevant.
3. **Fix target** — either a concrete route + params OR "text-only,
   no target."
4. **NEEDS SETH REVIEW flag** for any guidance copy CC isn't
   confident about (regulatory framing, the right action verb,
   "would a licensing inspector accept this as correct guidance?").

Organized by **fix-surface group** rather than by registry order —
this is the lens that drives build sequencing in §4. Within each
group, registry rows are listed in registry order.

> **Convention:** "→ Families" below always means the FamiliesPage
> deep-link scheme established by Phase 3 Finding #5
> (`/families?family=<fid>&tab=<tab>` + the existing
> `KNOWN_TABS` validator). The `child` and `action` query params are
> sub-work that 3.1 may or may not include — see §4.

---

### Group A — Families → child profile → Intake bundle (`ChildIntakeModal`)

**Fix surface today:** `/families` → click family → Children tab →
find child → click "Intake" → `ChildIntakeModal` opens.

**Deep-link state today:** `?family=<fid>&tab=children` works; the
modal-open-per-child step (`?child=<cid>&action=intake`) is **sub-work
flagged in §4.1 as a 3.1 candidate**.

**Recommended fix-target for this group (3.1):**

```js
{
  label: 'Open intake for this child',
  to:    '/families',
  params: { family: familyId, tab: 'children', child: childId, action: 'intake' },
}
```

Note `child=` + `action=intake` are intent params. If 3.1's sub-work
inventory doesn't include making the children-tab respond to those,
the deep-link lands on the family's Children tab and the user clicks
"Intake" themselves — degraded but still useful (one click vs. four).

#### Per-row guidance

| Key | Buckets it fires in | Guidance | Fix target | Review |
|---|---|---|---|---|
| `child_in_care_statement_envelope` | `missing_required` / `pending_parent` | "Send the parent the intake bundle so they can sign the child-in-care statement (and the eight sub-acknowledgments under R 400.1907)." | → Families (intake) | NEEDS SETH REVIEW — "Send the parent the intake bundle" assumes the parent-portal channel; confirm voice is right for providers who exclusively use in-person paper. |
| `intake_lead_disclosure` | `missing_required` (when home pre-1978) / `pending_parent` / `unknown awaiting-provider-input` (when `home_built_before_1978` is null) | (missing/pending) "Capture the parent's signature on the lead-paint disclosure. R 400.1913 requires it for homes built before 1978." (awaiting) "Tell us whether your home was built before 1978 — that determines whether lead disclosure applies." | (missing/pending) → Families (intake); (awaiting) → BusinessInfo `?section=premises` | NEEDS SETH REVIEW on the rule citation phrasing. |
| `intake_firearms_disclosure` | `missing_required` / `pending_parent` / `unknown awaiting-provider-input` (when `firearms_on_premises` is null) | (missing/pending) "Capture the parent's signature on the firearms disclosure. The copy on the disclosure form varies depending on your firearms answer in Business Info — R 400.1916." (awaiting) "Tell us whether firearms are present on your premises — that determines the disclosure copy." | (missing/pending) → Families (intake); (awaiting) → BusinessInfo `?section=premises` | NEEDS SETH REVIEW — confirm the rule reference. |
| `intake_food_provider_agreement` | `missing_required` / `pending_parent` | "Capture the parent's signature on the food-provider agreement — who provides each meal (R 400.1907(1)(b)(ii))." | → Families (intake) | NEEDS SETH REVIEW — confirm the precise sub-rule citation. |
| `intake_licensing_notebook_availability` | `missing_required` / `pending_parent` | "Capture the parent's acknowledgment that they were notified of your licensing notebook's availability per R 400.1907(1)(b)(vii) + R 400.1906(3)." | → Families (intake) | NEEDS SETH REVIEW. |
| `intake_licensing_rules_offered` | `missing_required` / `pending_parent` | "Capture the parent's acknowledgment that they were offered a copy of the licensing rules per R 400.1907(1)(b)(iii)." | → Families (intake) | NEEDS SETH REVIEW. |
| `intake_infant_safe_sleep` | `missing_required` / `pending_parent` (children < 18 months only — childGate) | "Capture the parent's signature on the infant safe-sleep acknowledgment. R 400.1930 — applies until the child reaches 18 months." | → Families (intake) | NEEDS SETH REVIEW — confirm both the rule citation and the 18-month gate copy. |
| `intake_health_condition` | `missing_required` / `pending_parent` | "Capture the parent's statement about the child's health condition at intake — R 400.1907(1)(b)(i)." | → Families (intake) | NEEDS SETH REVIEW. |
| `intake_discipline_policy_receipt` | `missing_required` / `pending_parent` | "Capture the parent's acknowledgment that they received your discipline policy — R 400.1907(1)(b)(iv). PR #17 will add a richer 'discipline policy receipt' surface separately." | → Families (intake) | NEEDS SETH REVIEW — confirm whether tying this to PR #17 in guidance copy is helpful or noise. |
| `child_in_care_statement_envelope_drift` | `pending_parent` (when the parent's prior intake no longer covers the current required sub-types) | "Premises or child-age info changed since this parent confirmed intake. Re-send the intake bundle so they can re-acknowledge — the engine detected drift in what's now required." | → Families (intake) | NEEDS SETH REVIEW — confirm "drift" is a word providers understand; consider replacing with "your premises answers changed" if not. |

---

### Group B — Families → child profile → child detail form (column edits)

Two registry rows are fixed by setting a column directly on the
`children` row (not via the intake modal, not via a separate consent).
Today these are edited via the family modal's Children tab → click
child → child form.

**Recommended fix-target (3.1):**

```js
{
  label: 'Open child record',
  to:    '/families',
  params: { family: familyId, tab: 'children', child: childId, action: 'edit' },
}
```

`action=edit` is intent; if not wired, lands on Children tab.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `child_immunization_record` | `missing_required` (when `immunization_status` is null) | "Record the child's immunization status — `up_to_date`, `waiver_on_file`, or `in_progress`. R 400.1907." | → Families (child edit) | NEEDS SETH REVIEW — confirm the three status values match what licensing accepts. |
| `child_annual_record_review` | `expired` (when `records_last_reviewed_on` is > 12 months old) / `missing_required` (if absent + `intake_completed_at` > 12 months ago) | (expired) "Mark this child's records as reviewed for the current year — R 400.1907 annual review." (missing) "Schedule an annual review of this child's records and update `records_last_reviewed_on` when complete." | → Families (child edit) | NEEDS SETH REVIEW — "Mark as reviewed" assumes a simple checkbox; confirm whether providers do a substantive review and the field is just the timestamp. |

---

### Group C — Families → child profile → `EnrollmentConsentsModal`

Captures the per-occurrence and durable consent acks (field-trip,
transportation routine annual, water on-premises seasonal,
per-trip rows, photo sharing).

**Recommended fix-target (3.1):**

```js
{
  label: 'Open consents for this child',
  to:    '/families',
  params: { family: familyId, tab: 'children', child: childId, action: 'consents' },
}
```

`action=consents` is intent; if not wired, lands on Children tab.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `consent_field_trip_permission` | `missing_required` / `pending_parent` (also fires the same when the provider hasn't opted out via BusinessInfo "What applies") | "Capture the parent's signature on the field-trip permission for this child — R 400.1952(2). If you never run field trips, mark this 'No' in Business Info → 'What applies to my program?'." | → Families (consents); secondary text-only mention of the Business Info alternative | NEEDS SETH REVIEW. |
| `consent_transportation_routine_annual` | `missing_required` (only when override `mode=applies` is set) / `pending_parent` | "Capture the parent's signature on the routine transportation permission — R 400.1952(1)(a). Annual baseline. Per-trip non-routine acks are captured separately when the trip happens." | → Families (consents) | NEEDS SETH REVIEW. |
| `consent_water_activities_on_premises_seasonal` | `missing_required` (only when override `mode=applies`) / `pending_parent` | "Capture the parent's seasonal signature on the on-premises water-activity permission — R 400.1934(10)(b). Per-trip off-premises water acks are captured separately." | → Families (consents) | NEEDS SETH REVIEW. |
| `consent_transportation_nonroutine_per_trip_recency` | `not_applicable` (data-inferred — no recent trips) / `on_file` (recent trip acks exist) | (Note: this row's `state_resolver` either returns `on_file` or `not_applicable` based on whether per-trip acks exist for any child in the last 12 months. There's no `missing_required` state — per-trip consents are captured as the trip happens, not pre-emptively. So 3.1 doesn't render an actionable surface for this row; the per-trip capture happens via the EnrollmentConsentsModal at the time of the trip.) | text-only ("Per-trip transportation permissions are captured at the time of each trip; this row shows 'on file' when recent trip records exist.") | NEEDS SETH REVIEW. |
| `consent_water_activities_off_premises_per_trip_recency` | Same shape as the transportation per-trip row above. | Same text-only guidance. | text-only | NEEDS SETH REVIEW. |
| `consent_photo_sharing` | `missing_required` (when `autoDefault: applies` and no ack) / `pending_parent` / can be revoked | "Capture the parent's photo-sharing consent. If they decline (or revoke), the engine will record that as the active state — provider-protective, not licensing-required. R 400 is silent on this." | → Families (consents) | NEEDS SETH REVIEW — confirm provider-protective framing reads correctly. |

---

### Group D — Families → child profile → `MedicationModal`

Captures medication authorizations + parent permission acks + dose
events.

**Recommended fix-target (3.1):**

```js
{
  label: 'Open medication for this child',
  to:    '/families',
  params: { family: familyId, tab: 'children', child: childId, action: 'medication' },
}
```

`action=medication` is intent; if not wired, lands on Children tab.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `medication_authorization_for_authorization` | `not_applicable` (no auth rows) / `on_file` (auth row exists) | text-only ("This row reflects whether a medication-authorization record exists for the child. Add one via the medication modal when the child takes medication.") | text-only | NEEDS SETH REVIEW. |
| `medication_permission_per_authorization` | `missing_required` / `pending_parent` / `pending_parent` reason `authorization-changed-since-permission` (drift) | (missing/pending) "Capture the parent's permission for this specific medication — R 400.1931(2)." (drift) "The medication's dose, schedule, or prescriber changed since the parent's last permission. Re-send for re-acknowledgment." | → Families (medication) | NEEDS SETH REVIEW. |
| `medication_permission_otc_blanket` | `missing_required` / `pending_parent` | "Capture the parent's blanket OTC topical permission (sunscreen / repellent / diaper rash cream) — covers all topical OTC collectively per R 400.1931(8) but doesn't waive the per-medication permission requirement." | → Families (medication) | NEEDS SETH REVIEW — confirm 'blanket OTC' is the right phrase and the (8) exemption framing is accurate. |
| `medication_role_gate_integrity` | `missing_required` reason `ineligible-role-administered-non-otc-dose` (a backwards-looking compliance issue — a past dose was administered by a caregiver without the eligible role) | **guidance-only — no fix target.** "An ineligible caregiver administered a non-OTC dose in the past. Document the corrective action in your records and confirm only licensees + child-care staff members administer non-topical-OTC medication going forward — R 400.1931(1). The DB trigger blocks new ineligible administrations; this row reflects historical evidence." | text-only | **NEEDS SETH REVIEW — high-stakes copy; this is real legal exposure.** |
| `medication_original_container_attestation` | `missing_required` (when `original_container_confirmed = false`) | "Confirm the medication is stored in its original labeled container — R 400.1931(4). Update the authorization record after verifying." | → Families (medication) | NEEDS SETH REVIEW. |
| `medication_dose_log_retention` | usually `on_file` (DB-enforced) / `unknown` (rare anomaly) | text-only ("This row reflects the dose log's retention state. The DB enforces archive-only + 2-year retention per R 400.1931(9). An `unknown` state here means an event row disappeared — contact support.") | text-only (data_anomaly variant) | NEEDS SETH REVIEW. |

---

### Group E — Staff Training (`/staff-training`) + Team (`/staff`)

Per-caregiver compliance items. The fix surface today is the
`StaffTrainingPage` (`StaffComplianceMatrix` + drill into one
`CaregiverTrainingLog`) for training entries, and the Team page
(`/staff`) for the caregiver row itself (including `date_of_hire`,
the field that triggers `needs_provider_data` reason
`caregiver-missing-date-of-hire`).

**Deep-link state today:** `/staff-training` is the route; **the
per-caregiver drill-down requires `?caregiver=<id>` param handling
that doesn't exist yet — flagged §4.2 as sub-work.** Same for
`/staff` per-caregiver edit. In 3.1, fix-targets in this group land
on the page generically; the user clicks through to the caregiver.

**Recommended fix-target (3.1, degraded form):**

```js
{
  label: 'Open Staff Training',
  to:    '/staff-training',
  params: {},  // caregiver= flagged as 3.2 sub-work
}
```

Or for the date-of-hire case:

```js
{
  label: 'Open Team — edit caregiver',
  to:    '/staff',
  params: {},  // caregiver= flagged as 3.2 sub-work
}
```

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `caregiver_background_check_eligibility` | `missing_required` / `expired` / `pending_parent` (reason `pending`) | (missing/expired) "Record this caregiver's background-check eligibility result. R 400.1919 + R 400.1903(1)(r). An eligible determination is required BEFORE unsupervised contact with children." (pending) "This caregiver's background check is pending review — they may not have unsupervised contact until the determination comes back eligible." | → Staff Training (degraded — caregiver param sub-work) | NEEDS SETH REVIEW — high-stakes copy. |
| `caregiver_cpr_first_aid_current` | `missing_required` / `expired` | "Record this caregiver's current CPR + pediatric first-aid certification (the expiration date printed on their card). R 400.1924(8) + R 400.1920(3) / R 400.1921(3)." | → Staff Training (degraded) | NEEDS SETH REVIEW. |
| `caregiver_new_hire_training_complete` | `missing_required` (incomplete) / `expired` (90 days elapsed without completion) / `unknown` reason `caregiver-missing-date-of-hire` (needs_provider_data) | (missing/expired) "Record completion of the 14 mandated new-hire training topics for this caregiver. R 400.1923. Must be done within 90 days of hire AND before unsupervised care." (needs_provider_data) "This caregiver is missing their hire date. Edit the caregiver record and set `date_of_hire` — the engine needs it to track the 90-day new-hire window." | (missing/expired) → Staff Training (degraded); (needs_provider_data) → Team (degraded) | NEEDS SETH REVIEW. |
| `caregiver_miregistry_account` | `missing_required` / `expired` (status = `expired`) — Type 1 mirror | "Confirm this caregiver's MiRegistry account status (`submitted` / `materials_received` / `awaiting_print` / `current`) — R 400.1922. We mirror what you enter; verify in MiRegistry directly. 30-day window from employment." | → Staff Training (degraded) | NEEDS SETH REVIEW. |
| `caregiver_professional_development_hours` | `missing_required` (hours below role threshold) — Type 1 mirror | "Log this caregiver's professional-development hours for the current calendar year — R 400.1924. The required hour count varies by their regulatory role." | → Staff Training (degraded) | NEEDS SETH REVIEW — confirm role-specific hour thresholds are correctly stated. |
| `caregiver_health_safety_update_acked` | `missing_required` reason `unacked-update` (per published MiLEAP update) | "Acknowledge the published health-safety update for this caregiver — R 400.1924(11). MiLEAP publishes notices; each applicable caregiver must read and acknowledge within the notice's stated timeframe." | → Staff Training (degraded) | NEEDS SETH REVIEW. |
| `caregiver_physician_attestation_annual` | `unknown` reason `feature-not-yet-shipped` (PR #18) | **No fix button — informational variant.** "Tracking ships with PR #18 (staff file gaps). Keep paper records of physician attestation of staff mental and physical health annually — an auditor will ask." | text-only (informational variant) | NEEDS SETH REVIEW — confirm rule citation. |
| `caregiver_discipline_policy_ack_at_hire` | `unknown` reason `feature-not-yet-shipped` (PR #17) | **No fix button — informational variant.** "Tracking ships with PR #17 (discipline policy receipt). Keep paper records of staff acknowledgment of your discipline policy at hire." | text-only (informational variant) | NEEDS SETH REVIEW. |
| `caregiver_daily_arrival_departure` | `unknown` reason `feature-not-yet-shipped` (partial — app-user clock covered, non-app-user surface gap) | **No fix button — informational variant.** "Tracking ships with PR #18 for non-app-user caregivers. App-user staff are covered today via the staff time-clock; non-app-user caregivers need paper records until the substrate ships." | text-only (informational variant) | NEEDS SETH REVIEW. |

---

### Group F — MiRegistry tracker (`/miregistry`)

Provider-level (not per-caregiver). Direct navigation works — the
tracker page is the fix surface.

**Recommended fix-target (3.1):**

```js
{
  label: 'Open MiRegistry tracker',
  to:    '/miregistry',
  params: {},
}
```

LEP only — these rows aren't `applicable` for licensed homes.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `provider_miregistry_annual_ongoing` | `missing_required` / `expired` — Type 1 mirror | "Complete the Michigan Ongoing Health & Safety Training Refresher and log the completion date — handbook p.12. December 16 deadline; missing it closes your CDC account. We mirror what you enter; verify in MiRegistry directly." | → /miregistry | NEEDS SETH REVIEW — confirm the deadline phrasing and the 'closes CDC account' consequence are accurate to current handbook. |
| `provider_miregistry_level_2_currency` | `expired` (when `miregistry_level_2_expires_on` is past) — Type 1 mirror | "Your Level 2 expiration date has passed. Log new approved training hours to reset the rolling clock, or update the level back to Level 1 if Level 2 is no longer current — handbook p.13. We mirror what you enter; verify in MiRegistry directly." | → /miregistry | NEEDS SETH REVIEW. |

---

### Group G — Funding sources + Funding documents (Families → family → Funding tab)

The fix surface is the Funding tab inside the family modal — funding
sources are family-scoped (per the funding-source spec).

**Recommended fix-target (3.1):**

```js
{
  label: 'Open funding for this family',
  to:    '/families',
  params: { family: familyId, tab: 'funding' },
}
```

Sub-targets per funding source row (e.g. open the specific funding
source detail to upload an Enrollment Agreement) are sub-work
in §4.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| ~~`funding_dhs_198_on_file`~~ | *REMOVED 2026-06-06 per the CDC-layer correctness pass* — the DHS-198 is MDHHS's authorization NOTICE TO the provider, not an obligation they fulfill. The registry row + its 3 tests + this worksheet entry are deleted; the underlying funding-document vault feature is unaffected. | n/a | n/a | n/a |
| `funding_enrollment_agreement_on_file` | `missing_required` / `expired` | "Upload the enrollment agreement for this CDC funding source — required for licensed-billing-basis CDC. Licensed Family Homes / Group Homes only." | → Families (funding tab) | NEEDS SETH REVIEW — confirm enrollment-agreement is licensed-only and not all CDC. |
| `cdc_authorization_currency` | `expired` (`authorization_end` past) / `on_file` with `expiring_soon` (≤30 days) / `unknown` reason `no-authorization-end-on-funding-source` (needs_provider_data) | (expired) "This CDC authorization expired. Process redetermination with MDHHS and update the authorization end date on the funding source." (expiring_soon — UI flag, technically on_file) "Authorization expires in N days — confirm redetermination is in motion." (needs_provider_data) "This CDC funding source is missing its authorization end date. Edit the funding source and set `authorization_end`." | → Families (funding tab) | NEEDS SETH REVIEW — confirm redetermination language. |
| `cdc_fingerprint_reprint_currency` | multi-band (info → warning → urgent → critical → expired) per `cdcProviderCompliance.js` | "Your fingerprint reprint is on a 5-year cycle. The current state of your `fingerprint_date` field tells the engine how close you are — update after each reprint." | → BusinessInfo `?section=licensing` (provider-level field; not per-family) | NEEDS SETH REVIEW — confirm `/business-info?section=licensing` is the right destination (the field may currently live elsewhere). |

---

### Group H — Attendance + Parent Acknowledgments

Per-day attendance acks. The fix surface for a missing parent ack:
either the parent acks via `/parent/acknowledge` OR the provider
runs a `provider_override` from `/acknowledgments`.

**Recommended fix-target (3.1):**

```js
{
  label: 'Open parent acknowledgments',
  to:    '/acknowledgments',
  params: {},
}
```

For provider-side override action.

| Key | Buckets | Guidance | Fix target | Review |
|---|---|---|---|---|
| `attendance_parent_acknowledgment_per_day` | `missing_required` / `pending_parent` (provider_override only, no parent sig) | (missing) "Parent hasn't acknowledged this day's attendance yet. Either prompt the parent (the existing acknowledgment digest cron sends weekly), or run a provider override with a documented reason if the parent is genuinely unreachable." (pending) "Parent override is on file but the parent hasn't acknowledged. This usually clears when they next open the portal." | → /acknowledgments | NEEDS SETH REVIEW — confirm whether 'provider override' is the right action and whether the override has its own audit trail surface today. |

---

### Group I — NOT YET SHIPPED (informational variant only)

These rows render the existing Phase 3 §4 Option A "Tracking ships
with PR #N" treatment via `<ActionableGap variant="informational">`.
**No fix button.** 3.1 doesn't change the content for these rows
beyond migrating the existing inline rendering in ChecklistRow.jsx
to the new primitive — the copy + intent are unchanged.

| Key | Future PR | Note |
|---|---|---|
| `drill_fire_quarterly` | PR #19 | Existing copy: "Tracking ships with PR #19 (drills + emergency response plan) — keep paper records for now. An auditor will ask to see them." |
| `drill_tornado_seasonal` | PR #19 | Same. |
| `drill_other_emergencies_annual` | PR #19 | Same. |
| `emergency_response_plan_on_file` | PR #19 | Same. |
| `property_radon_test_quadrennial` | PR #21 | Existing copy ("PR #21 property records"). |
| `property_heating_inspection_quadrennial` | PR #21 | Same. |
| `property_co_detectors_per_level` | PR #21 | Same. |
| `property_smoke_detectors_per_floor` | PR #21 | Same. |
| `property_fire_extinguishers_per_floor` | PR #21 | Same. |
| `property_animal_notification` | PR #21 (+ Phase 3 applicability override already in play) | Existing copy. If the provider answered "Yes, animals on premises" in Business Info, the row still renders the not-yet-trackable copy until PR #21 ships. |
| `property_smoking_prohibition_posted` | PR #21 | Same. |
| `property_licensing_notebook_archive` | PR #21 | Same. |

---

### Group J — Catalog summary

Total registry rows mapped: **51** *(was 52 — `funding_dhs_198_on_file`
removed 2026-06-06 per CDC-layer correctness pass; deferred
religious-objection row from Phase 1 §6 is still out)*.

| Group | Rows | Fix-target state | NEEDS SETH REVIEW count |
|---|---:|---|---:|
| A — Intake bundle (Families/children/intake) | 10 | → Families (sub-work for child+action) | 10 |
| B — Children column edits | 2 | → Families (sub-work for child+action) | 2 |
| C — Enrollment consents | 6 | → Families (sub-work for child+action) | 6 |
| D — Medication | 6 | → Families (sub-work for child+action) — one row text-only | 6 |
| E — Staff Training + Team | 9 | → /staff-training + /staff (sub-work for caregiver param) — 3 informational | 9 |
| F — MiRegistry tracker | 2 | → /miregistry | 2 |
| G — Funding sources + docs | 3 *(was 4 — G1 removed 2026-06-06)* | → Families (funding tab) — works today | 3 |
| H — Attendance acks | 1 | → /acknowledgments | 1 |
| I — Not-yet-shipped (informational) | 12 | No fix target | 0 (copy is locked from Phase 3) |
| **Total** | **51** | | **39 review-flagged** *(was 40)* |

**The 39 NEEDS-SETH-REVIEW rows are the gate on actual build.** The
component contract (§1) + deep-link infrastructure (§4) can ship
without waiting on accuracy review, BUT the per-row guidance copy
that's wrong is worse than no guidance. The recommended phase-split
inside 3.1:

- **3.1a (week 1)** — ship the `<ActionableGap>` primitive, the
  BusinessInfoPage `?section=` handler, and the FamiliesPage
  `?child=&action=` sub-work (decision pending in §4). Guidance copy
  pulled in for the Phase-3-already-confirmed rows ONLY — primarily
  the `awaiting_input` rows that have already been Seth-approved
  through the Phase 3 BusinessInfo "What applies" question copy.
- **3.1b (week 2 or staggered)** — pull in the 40 confirmed
  guidance rows in batches as Seth reviews them. Each batch is a
  small content-only PR.

This staggers the regulatory-accuracy work without blocking the
component infrastructure.

---

## §3. Bucket-to-action mapping

The engine returns six state kinds; the `unknown` kind further
classifies into three sub-buckets via `classifyUnknownReason`
(Phase 3 fix-forward Finding #3). Each combination maps to one
`<ActionableGap>` shape:

| Engine state | Phase 3 visual | 3.1 `<ActionableGap>` shape | Button copy |
|---|---|---|---|
| `on_file` | ✓ green | **No `<ActionableGap>` rendered** — row stays terse. | n/a |
| `expired` | ⚠ amber | `<ActionableGap severity="high" guidance=… fixTarget=…/>` | "Renew now" |
| `missing_required` | ✗ red | `<ActionableGap severity="critical" guidance=… fixTarget=…/>` | "Open [surface]" |
| `pending_parent` | ⏱ amber | `<ActionableGap severity="medium" guidance=… fixTarget=…/>` — fixTarget OMITTED unless a "send reminder" action wires up (out of scope for 3.1; reminder integration deferred per Phase 3 decision #10) | "View parent acknowledgment" (when fixTarget present); otherwise no button |
| `not_applicable` | ↳ gray (hidden by default) | **No `<ActionableGap>` rendered** — there's no action to take. | n/a |
| `unknown` + `awaiting-provider-input` | ⏱ amber + deep-link | `<ActionableGap severity="medium" guidance=… fixTarget={{to:'/business-info', params:{section:'compliance_applicability'}}}/>` | "Answer in Business Info" |
| `unknown` + `feature-not-yet-shipped` | 🔧 gray | `<ActionableGap variant="informational" guidance=…/>` | n/a (no button — locked decision #6) |
| `unknown` + `needs_provider_data` | ✗ red | `<ActionableGap severity="critical" guidance=… fixTarget=…/>` | "Edit record" |
| `unknown` + `data_anomaly` | gray | `<ActionableGap variant="guidance-only" guidance=… />` | n/a (no button — "contact support" is the action) |

The `pending_parent` decision is the one mild design tension worth
calling out: **does the provider want a button to "send the parent a
reminder"?** Possibly yes. Phase 3 decision #10 deferred reminder
integration to a later polish pass; 3.1 honors that deferral.
Recommend: render guidance text-only for `pending_parent` in 3.1,
revisit the "send reminder" button when reminders integrate.

---

## §4. Deep-link infrastructure — what reuses, what needs new param handling

### §4.1 — What's already in place from Phase 3

**FamiliesPage** (`src/pages/FamiliesPage.jsx`) gained its first
`useSearchParams` handler in the Phase 3 Finding #5 fix:

- Reads `?family=<id>` and opens the matching family's modal.
- Reads `?tab=<key>`, validates against `KNOWN_TABS` (`overview /
  invitations / children / funding / guardians / emergency /
  attendance / compliance`), threads as `initialTab` to
  `FamilyDetailModal`.
- `clearDeepLinkParams()` on modal close.

**Reusable for 3.1 with no further work** — Groups F (just `/miregistry`),
G (already uses `?family=&tab=funding`), and H (`/acknowledgments`,
no params needed) work today.

### §4.2 — Sub-work inventory — what 3.1 might add (Seth's call)

Each row below is a small page-level change (a `useSearchParams`
handler, a few validators, a scroll/focus or auto-open effect),
none larger than the Phase 3 Finding #5 fix.

| # | Surface | New params | What it lets 3.1 do | Estimated size |
|---|---|---|---|---|
| **B-1** | **BusinessInfoPage** | `?section=<sectionId>` | Auto-select the named section on mount. Required for the `awaiting_input` deep-link to land correctly. **3.1a note (2026-06-10): B-1 needs TWO section ids, not one** — `awaiting_input` rows split between the premises questions (A2 lead / A3 firearms → Premises section) and the applicability questionnaire (C1 field trips etc. → "What applies to my program?"). The KNOWN_SECTIONS validator must accept both. Also: 3.1a REMOVED the old broken `?section=compliance_applicability` link from ChecklistRow (it never landed — BusinessInfoPage doesn't read `?section=`); `awaiting_input` rows render text-only guidance until B-1 ships, at which point checklistGuidance.js adds the BusinessInfo fixTargets. | ~10 lines (+ second section id). **SHIPPED in 3.1b-1 (2026-06-10).** As-built: `KNOWN_SECTIONS` frozen Set of all 8 tab ids in BusinessInfoPage.jsx; a lazy `useState` initializer validates `?section=` (unknown/absent → `'hours'`). checklistGuidance.js added `SURFACE.BUSINESS_INFO_PREMISES` / `SURFACE.BUSINESS_INFO_APPLICABILITY` + an `awaitingSurface` entry field; the five `awaiting_input`-capable rows got fixTargets. **Correction to the 3.1a note:** the questionnaire-driven consents row is **C2 routine transport, not C1 field-trip** — C1's applicability `autoDefault`s to APPLIES (complianceState.js) and can never reach `awaiting_input`. Final set: A2 lead + A3 firearms → `?section=premises`; C2 transport + C3 water + animal notification → `?section=compliance_applicability`. |
| **B-2** | **FamiliesPage children tab** | `?child=<id>` (scroll/focus a specific child within the tab) | Scrolls the named child into view OR highlights their row when the children tab opens. Useful for every Group A/B/C/D row. | ~15 lines. **RECOMMEND IN-SCOPE.** Single-tab effect; small. |
| **B-3** | **FamiliesPage children tab** | `?action=intake` / `action=consents` / `action=medication` / `action=edit` | Auto-opens the corresponding modal on mount after the child is selected. Highest-leverage piece: a one-click deep-link from /compliance lands the user inside the intake/consents/medication modal for the right child. | ~30 lines including modal-open effects per action. **CONSIDER IN-SCOPE if Seth wants the full one-click experience; defer to 3.2 if the user clicking through the family modal is acceptable.** Open call. |
| **B-4** | **FamiliesPage funding tab** | `?funding_source=<id>` (open a specific funding source detail) | Opens the funding source's detail view (where the DHS-198 / Enrollment Agreement uploads live). Lets G-group rows deep-link to the exact source needing the document. | ~15 lines. **Recommend DEFER to 3.2** unless B-3 is in-scope. |
| **C-1** | **StaffTrainingPage** | `?caregiver=<id>` (drill into a specific caregiver's training log) | All E-group rows currently land on /staff-training generically. With this, they land on the named caregiver's drill-in. | ~20 lines. **SHIPPED in 3.1b-2 (2026-06-10).** As-built: the page consumes `?caregiver=<id>` (validated against the loaded roster; licensee-only; param cleared on drill-in close, FamiliesPage precedent). **BUT the six E-row fixTargets are PAGE-LEVEL (`/staff-training`, no param)** — the engine aggregates worst-across-caregivers, so no caregiver id exists at render time. `buildFixTarget(SURFACE.STAFF_TRAINING, ctx)` upgrades to `?caregiver=<id>` whenever a future context supplies `caregiverId`; the param handling is live and waiting. Same PR fixed H1's per-day copy to read the aggregated `<N>-days-missing-ack` / `<N>-days-provider-override-only` reasons. Caveat found during build: there is NO edit surface anywhere for an existing caregiver's `date_of_hire` (only AddCaregiverModal at creation) — the `caregiver-missing-date-of-hire` guidance says "edit the caregiver record" but that surface doesn't exist yet. |
| **C-2** | **StaffPage (`/staff`)** | `?caregiver=<id>&action=edit` (open the caregiver edit form) | The `caregiver-missing-date-of-hire` needs_provider_data row routes here. Without C-2, the user lands on the team roster and finds the caregiver themselves. | ~15 lines. **Recommend DEFER to 3.2.** |
| **C-3** | **IBillingPage** | `?period=<periodNumber>` | Not exercised by 3.1's per-row table; relevant for future iBilling Issue-Resolution adoption of `<ActionableGap>`. | n/a — not in 3.1's per-row needs. |
| **C-4** | **BillingPage** | `?invoice=<id>` | Same as C-3 — future-adopter only. | n/a — not in 3.1. |
| **C-5** | **MiRegistryPage** | `?training_entry=<id>` (jump to a specific entry edit) | Not strictly needed; F-group rows are provider-level, the page itself is the destination. | **Recommend DEFER to 3.2 or omit.** |

### §4.3 — Recommended 3.1 sub-work cut

**STRONGLY in-scope (small + high leverage):**

- B-1 (BusinessInfoPage `?section=`). Tiny. Unblocks the Phase 3 link
  that already promises this behavior. **In every 3.1 plan.**

**RECOMMENDED in-scope (Seth's call):**

- B-2 (FamiliesPage `?child=` scroll/focus). Small effect; makes
  every Group A/B/C/D row degrade gracefully on the destination.

**OPEN — Seth picks the cut between 3.1 and 3.2:**

- B-3 (FamiliesPage `?action=` modal-auto-open). This is the biggest
  single piece of leverage in 3.1 — a one-click deep-link to the
  capture modal for the right child. Cost is ~30 LOC + per-action
  state effects + tests. Recommendation: ship in 3.1 if Seth wants
  the full demonstrated value; defer to 3.2 if shipping the component
  primitive + content sooner is more valuable than the modal-auto-
  open polish.

**DEFER to 3.2 (separate surfaces, none load-bearing for 3.1):**

- B-4 (FamiliesPage `?funding_source=`).
- C-1 (StaffTrainingPage `?caregiver=`).
- C-2 (StaffPage `?caregiver=&action=`).
- C-3, C-4, C-5 (future-adopter surfaces).

### §4.4 — Extracting the helpers (tech_debt follow-up)

Phase 3's tech_debt entry flagged that the `KNOWN_TABS` validator +
`clearDeepLinkParams` helper inside FamiliesPage should be extracted
when a second consumer appears. **3.1's BusinessInfoPage adoption
(B-1) is that second consumer.**

Two options:

- **(a)** Extract NOW into `src/lib/deepLinkParams.js` (or similar)
  with shared `validateAgainst(knownSet, paramValue, fallback)` and
  `clearKeys(setParams, keys)` helpers. Both consumers import. ~30
  LOC + tests.
- **(b)** Duplicate the inline pattern in BusinessInfoPage for 3.1's
  small `?section=` case; extract when the third or fourth surface
  adopts (3.2's sub-work).

**Recommendation: (a) — extract now.** The cost is small, the second
consumer is the right moment by Phase 3 tech_debt convention, and
the 3.2 surfaces will adopt the helper rather than reinvent it.

---

## §5. Read-only-ness preserved

3.1 adds navigation to fix surfaces. It does **not**:

- Add inline editing on the checklist row itself. The checklist row
  shows state + guidance + a deep-link button. Editing happens on
  the destination.
- Add per-row modal pop-ups for capture. The capture flows live in
  their existing surfaces (`ChildIntakeModal`, `EnrollmentConsentsModal`,
  `MedicationModal`, the funding modal, the Staff Training entry
  form, etc.) — those are NOT duplicated.
- Add a score (Phase 4) or auditor view (Phase 5).
- Add deep-link actions to surfaces other than the compliance
  checklist. Future adopters (dashboard banners, Staff Training
  matrix, MiRegistry warning banner, iBilling, funding vault) get
  separate later PRs, each importing `<ActionableGap>` and supplying
  their own content.

The read-only boundary is the keep-Phase-3-shippable seam Seth
locked. 3.1 builds inside it.

---

## §6. Verification gate

Three classes — same caliber as Phase 3.

### §6.1 — Component-level (pure / unit tests)

In `src/components/ui/ActionableGap.test.jsx` (new file; first
component-level test under `src/components/ui/`):

1. **Guidance always renders.** With only `guidance` supplied, the
   component renders the text in a paragraph; no button. No console
   warnings.
2. **Button renders when `fixTarget` is present.** Label, route
   composition (`to` + serialized `params`), and click handler all
   verifiable via React Testing Library queryByRole('link'). Mount
   via MemoryRouter.
3. **Button does NOT render when `fixTarget` is omitted OR when
   `variant='guidance-only'` OR when `variant='informational'`.**
4. **Severity drives visual class.** Mapping
   `severity='critical'` → `bad`-tone, etc.
5. **Empty guidance → component renders nothing (or a stub).**
   Defensive — protects against a future caller passing an empty
   string.
6. **Accessible label combines guidance + button label.** Verify
   `aria-label` derivation.

### §6.2 — Content-level (per-row guidance present, NEEDS-REVIEW rows degrade)

In `src/components/compliance/ChecklistRow.guidance.test.js` (new):

1. **Every requirement key in `REQUIREMENT_REGISTRY` resolves to a
   guidance map entry** (either Seth-confirmed copy or a text-only
   fallback). No registry row produces an empty render.
2. **NEEDS_SETH_REVIEW rows degrade to text-only.** The content map
   carries a `seth_reviewed: true | false` flag per row; rows with
   `false` render guidance with a placeholder ("Confirm with your
   licensing consultant or contact support for guidance on this
   item") and NO fix button until Seth flips the flag in a follow-up
   content PR.
3. **Bucket-to-action map invariant.** For each
   (requirement_key × state_bucket) combination, the rendered
   `<ActionableGap>` shape matches the §3 table.

### §6.3 — Live gate (against a real provider account)

Once 3.1 lands on preview:

1. **Open `/compliance` as Vanessa or a licensed-home test account.**
   Confirm gap rows render `<ActionableGap>` with guidance text +
   button.
2. **Click each in-scope fix-target button for one row in each
   group** (intake, consents, medication, funding, BusinessInfo
   "What applies"). Confirm the destination opens correctly — for
   FamiliesPage targets, the right family modal opens on the right
   tab; for BusinessInfoPage, the right section is auto-selected.
3. **Close modal → URL clears.** Verify
   `clearDeepLinkParams()` still works (shouldn't regress; Phase 3's
   logic is unchanged).
4. **Click the deep-link from a `feature_not_yet_shipped` row.**
   Confirm NO button is rendered (the informational variant
   suppresses it).
5. **NEEDS-REVIEW rows show the placeholder copy + no button.**
   (This is the content-discipline check.)
6. **Negative path — LEP account.** Sign in as an LEP test account
   (or simulate). Confirm `/compliance` is gated and the LEP
   provider can't reach it. (Phase 3 behavior; 3.1 mustn't regress
   the gate.)

The live gate is the merge condition — same caliber as Phase 3.

---

## §7. Out of scope (explicitly deferred)

Named so they aren't silently absorbed.

- **The score (Phase 4).** 3.1's `<ActionableGap>` is a primitive
  Phase 4 may consume too; 3.1 doesn't ship the score itself.
- **The auditor access mode (Phase 5).** Same posture.
- **Reminder integration on `pending_parent` rows.** "Send the parent
  a reminder" as a button — deferred per Phase 3 decision #10.
- **Adoption on surfaces other than the compliance checklist.**
  Dashboard banners, Staff Training matrix, MiRegistry warning
  banner, iBilling, funding vault — each is a separate small PR
  that imports `<ActionableGap>` and supplies its own content.
  Likely a sequence of 3.x patch releases.
- **Sub-work fix targets requiring new page-level param handling
  beyond B-1 (and possibly B-2/B-3).** Per §4.3, the 3.1 cut is
  Seth's call; everything else slots into 3.2.
- **Inline editing on the checklist.** Read-only boundary preserved.
- **Per-requirement OR per-occurrence-data evidence chips.** A row
  could conceivably show "On file since YYYY-MM-DD, evidence ID
  xxx" or "Signed by parent J. Smith via parent portal" — useful
  for inspection prep. Phase 5 (auditor mode) will likely surface
  this; 3.1 just shows row state + the new actionable affordance.
- **Per-row history.** "When was this last on file / when did it
  expire" — internal audit data, deferred to Phase 5 or later.

---

## §8. Open questions for Seth

Numbered for reference; each names the default if Seth has no
preference.

1. **Per-requirement guidance accuracy (§2 — the load-bearing
   review work).** Every "NEEDS SETH REVIEW" row in §2 must be
   confirmed before build. Recommendation: Seth + the licensing
   consultant review the 39 flagged rows *(was 40 — G1 removed
   2026-06-06)* in batches over 1-2 sessions; confirmed rows
   ship; unconfirmed rows render text-only fallback until they're
   confirmed. Default if Seth wants the simplest path: defer all
   39 to "text-only fallback" and ship Phase-3-confirmed rows only
   (the BusinessInfo "What applies" rows from Phase 3 are already
   Seth-confirmed).

2. **§4.3 — the 3.1 sub-work cut.** Default: in-scope = B-1
   (BusinessInfo `?section=`) + B-2 (FamiliesPage `?child=` scroll-
   focus). 3.2 cut = everything else. If Seth wants the full
   one-click experience NOW (deep-link → modal opens directly on
   the right child + right capture flow), add B-3 (FamiliesPage
   `?action=` modal-auto-open) to 3.1's cut at +1 week of work.

3. **§3 `pending_parent` rows — "Send reminder" button or
   guidance-only?** Default: guidance-only for 3.1, revisit when
   reminder integration ships. Alternative: enable the button now
   with the existing acknowledgment-digest cron's manual-trigger
   endpoint. Recommend defer.

4. **§4.4 — extract `useSearchParams` helpers now or wait for the
   3.2 surfaces?** Default per recommendation: extract NOW into
   `src/lib/deepLinkParams.js` since B-1 (BusinessInfoPage) is the
   second consumer per Phase 3 tech_debt convention. Cost ~30 LOC.

5. **§1 — `<ActionableGap>` namespace.** Default: `src/components/ui/`
   per recommendation #4. Alternative: `src/components/compliance/`
   if Seth wants to keep the primitive compliance-flavored until
   a real second adopter exists. Recommend `ui/` — the contract has
   no compliance-specific assumptions.

6. **§1 — `severity` prop or consumer-styled?** Default: pass
   `severity` through (one of `critical|high|medium|low` from the
   registry). Alternative: omit and let each consumer style buttons
   themselves. Recommend pass through — aligns the visual ladder
   with the engine's truth and keeps consumers terse.

7. **§6.2 content-test discipline.** Default: every NEEDS-REVIEW row
   ships with `seth_reviewed: false` and renders the text-only
   fallback. Each Seth-confirmation is a small content-only PR that
   flips the flag + commits the confirmed copy. Alternative: ship
   all 40 with CC-drafted copy and let Seth iterate post-merge.
   **Recommend the disciplined path** (per CLAUDE.md domain rule:
   wrong compliance guidance is worse than none).

8. **§5 — read-only-ness scope.** Default: preserved per Seth's
   locked decision. Alternative: ship a small inline-edit affordance
   on the checklist for one or two well-bounded fields (e.g., the
   `caregiver-missing-date-of-hire` case — let the provider edit the
   hire date inline). Recommend defer — keeps the read-only boundary
   clean and the destination-surface fix-flows un-duplicated.

9. **Should `feature_not_yet_shipped` rows ALSO show "request this
   feature" / "watch progress" links?** Default: no — keeps the
   informational variant terse. The current Phase 3 copy
   ("Tracking ships with PR #N — keep paper records for now. An
   auditor will ask to see them.") is enough.

10. **Should `<ActionableGap>` carry an analytics hook**
    (`onClickFixTarget`, etc.)? Default: no — the project doesn't
    yet use analytics. Easy to add later if analytics shows up.

---

## §9. Recommended build phasing (within 3.1)

Single PR for 3.1, but with a clean internal sequence so each piece
has a verification step:

### Step 1 — primitives + infrastructure (small, low-risk)

- `src/components/ui/ActionableGap.jsx` + its CSS + test file.
- (if Seth approves §4.4) `src/lib/deepLinkParams.js` shared
  helpers + tests.
- BusinessInfoPage `?section=` handler (B-1).

Verification: pure tests pass; manually click an existing Phase 3
`awaiting_input` deep-link and confirm BusinessInfoPage auto-selects
the section.

### Step 2 — wire ChecklistRow to use `<ActionableGap>`

- Migrate the existing inline rendering for each bucket to the new
  primitive. Keep the visual identical to Phase 3 (so the diff is
  purely structural).

Verification: visit `/compliance` on a real account; rows look
identical to before; tests pass.

### Step 3 — content map (per-requirement guidance)

- `src/components/compliance/checklistGuidance.js` — the content
  map. Initial commit: 12 informational rows (locked from Phase 3) +
  the Phase-3-confirmed `awaiting_input` rows + text-only fallback
  for every other row.

Verification: every registry row resolves to a content map entry.
NEEDS-REVIEW rows render text-only fallback.

### Step 4 — sub-work fix targets per Seth's §4.3 cut

- Whatever sub-work Seth approves: at minimum B-1; recommended also
  B-2; possibly B-3.

Verification: §6.3 live gate.

### Step 5 — Seth's per-row content reviews (batched, optional in 3.1)

- Per-batch content-only commits that flip `seth_reviewed: true` and
  commit the confirmed copy for the reviewed rows.

This step is **optional in the 3.1 PR** — it can land in subsequent
small content PRs after 3.1 merges. The core 3.1 PR ships the
infrastructure + the Phase-3-confirmed rows.

---

## §10. Cross-cutting alignment

### Phase 3 dependency

- 3.1 builds on Phase 3 merged at `b6dd1d5`. No regression on Phase 3
  behavior: opt-in gate, licensed-home gate, loading-race fix, child
  name display, `needs_provider_data` bucket, `feature_not_yet_shipped`
  treatment, Finding #5 deep-link scheme — all preserved.

### Future-adopter alignment

- `<ActionableGap>` ships in `src/components/ui/` so the next
  adopter (dashboard banners, Staff Training, MiRegistry warning
  banner, iBilling Issue Resolution, funding vault) imports
  without copying.
- The deep-link helper convention (`useSearchParams` + `KNOWN_*`
  validator + `clearDeepLinkParams`) is documented and either
  extracted (recommendation §4.4) or available to copy.

### Documentation discipline

- A `docs/runbook.md` entry follows the 3.1 merge — same shape as
  the Phase 3 entry: what shipped, the live gate proof, any bugs
  caught + fixed.
- This scope doc commits BEFORE Seth's approval — Phase 3 scope
  doc precedent (`docs/pr-compliance-engine-phase-3-scope.md` on
  branch `docs/compliance-engine-phase-3-scope`, commit `73ab3cd`,
  not yet on main).
- Once Seth approves, build follows. The first PR may be
  partial — see §9 Step 3 / 5.

### State-modernization-hedge alignment

- Per `docs/strategy.md`'s priority on compliance intelligence
  surviving state modernization: 3.1's actionable guidance + deep-
  link layer IS "compliance intelligence" — telling the provider
  not just what's missing but how to fix it is the moat. A state
  modernization that changes WHERE forms are submitted doesn't
  change the guidance ("capture the parent's signature on the
  intake bundle"); 3.1 ages well.

### Opt-in posture preserved

- The Compliance Checklist surface itself is opt-in per Phase 3
  decision #8. 3.1 doesn't change that — it only enriches what
  shows on the opted-in surface.

### Retention + audit trail

- Pure UI / content; no data mutation. The existing capture
  surfaces (the destinations 3.1 links to) preserve their existing
  retention semantics (`archived_at`, never-hard-delete, etc.).
- No new tables; no new RPCs; no new RLS.

---

## §11. Halt for review — what Seth reads next

This doc, with focus on:

1. **§2** — the 39 NEEDS-SETH-REVIEW guidance rows *(was 40 — G1
   removed 2026-06-06 per the CDC-layer correctness pass)*. Each
   one is a small batch question: "is this guidance copy
   regulatorily accurate and the right voice for a provider?"
   Recommend Seth review in batches over 1-2 sessions; confirmed
   rows ship, unconfirmed fall through to text-only fallback.
2. **§4.3** — the 3.1 sub-work cut. Default = B-1 + B-2; optional
   = B-3; deferred = everything else to 3.2. Seth's call on the
   B-3 (one-click-to-modal) cost-vs-value question.
3. **§3 `pending_parent` rendering** — guidance-only or wire a
   "Send reminder" button (recommend defer).
4. **§4.4** — extract `useSearchParams` helpers now (recommend yes).

After Seth reads + reacts to these, build follows the Phase 3 cadence:
single feature branch, scope-locked content map, gated by §6 live
verification, no merge until the gate passes.

Status remains **DRAFT for review** until that next round.

---

**End of compliance-engine Phase 3.1 scope doc — DRAFT.** No code,
no migration, no commit-to-main. Halting for Seth's review per
§11.
