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

### Public contract

```jsx
import ActionableGap from '@/components/ui/ActionableGap'

<ActionableGap
  // REQUIRED — the plain-language "how to resolve" copy. Rendered
  // unconditionally. Free-form text or a short JSX node. Caller's
  // responsibility to keep it concise (1-3 sentences).
  guidance="Capture the parent's signature on the child's intake bundle. The intake form includes the lead-paint disclosure, firearms disclosure, food agreement, and safe-sleep acknowledgment."

  // OPTIONAL — when present, renders a "Open [destination]" button
  // that navigates via react-router <Link>. When absent, ONLY the
  // guidance text shows — no dead button.
  fixTarget={{
    label:  'Open intake for this child',  // button copy; usually "Open X"
    to:     '/families',                   // base route
    params: { family: familyId, tab: 'children', child: childId },  // optional query params
  }}

  // OPTIONAL — drives visual emphasis of the button. Mirrors the
  // engine's severity ladder so the button tier aligns with the
  // requirement's regulatory weight. Defaults to 'medium'.
  severity="critical"  // 'critical' | 'high' | 'medium' | 'low'

  // OPTIONAL — for the Phase 3 'feature_not_yet_shipped' case, which
  // wants the gray "tracking ships with PR #N" treatment instead of
  // a colored gap. Set to 'informational' and pass guidance only.
  variant="informational"  // 'gap' (default) | 'informational' | 'guidance-only'

  // OPTIONAL — render hooks for consumers that want to inject extra
  // structure (e.g. an icon, an evidence-id chip). Most consumers pass
  // nothing.
  prepend={<Icon />}
/>
```

### Render shape

```
┌─────────────────────────────────────────────────────────────────┐
│  [optional prepend]                                              │
│  Plain-language guidance copy here. One to three sentences,      │
│  matter-of-fact, no marketing voice. Same color as the surface's │
│  body text.                                                       │
│  [Open [destination] →]   ← button only when fixTarget present    │
└─────────────────────────────────────────────────────────────────┘
```

### Severity tiering

| `severity` | Button visual |
|---|---|
| `critical` | Filled, error-tone (matches `MISSING_REQUIRED` row color) |
| `high` | Filled, warning-tone (matches `EXPIRED` row color) |
| `medium` | Outlined, neutral-tone (matches `AWAITING_INPUT` row color) |
| `low` | Subtle link-style, no fill |

The same severity values the registry already uses (per Phase 1 §4 —
`critical | high | medium | low`). Consumers either pass through
`requirement.severity` from the engine or supply their own (a
dashboard banner might pass `severity` derived from its own scoring).

### Variant — when not a "gap"

`variant='informational'` produces the Pattern E "Tracking ships with
PR #19" treatment Phase 3 already renders for `feature_not_yet_shipped`
rows: gray icon, neutral text, no fix button. The
existing rendering in `ChecklistRow.jsx` migrates to use
`<ActionableGap variant="informational" guidance="..." />` —
removes the inline gray styling, lands the same visual.

`variant='guidance-only'` is the `data_anomaly` case + the
NEEDS-SETH-REVIEW fallback: text appears in a neutral tone, no button
even if `fixTarget` is supplied (the variant suppresses it). Used
when the guidance itself is the action ("Contact support — record
has a malformed date").

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

- `guidance` text is in normal-document tab order; screen readers
  read the description before the button.
- Button has an accessible label that includes the guidance context
  (e.g., `aria-label="Open intake bundle for Audrey — capture the
  parent signature"`) for users navigating without seeing the
  surrounding row.
- Severity color is paired with shape/icon, not color-only.

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
| **B-1** | **BusinessInfoPage** | `?section=<sectionId>` | Auto-select the named section on mount. Required for Phase 3's `awaiting_input` deep-link to land correctly (today it navigates but the user clicks the tab themselves). | ~10 lines. **STRONGLY RECOMMEND IN-SCOPE.** Tiny + unblocks the Phase 3 link that already promises this behavior. |
| **B-2** | **FamiliesPage children tab** | `?child=<id>` (scroll/focus a specific child within the tab) | Scrolls the named child into view OR highlights their row when the children tab opens. Useful for every Group A/B/C/D row. | ~15 lines. **RECOMMEND IN-SCOPE.** Single-tab effect; small. |
| **B-3** | **FamiliesPage children tab** | `?action=intake` / `action=consents` / `action=medication` / `action=edit` | Auto-opens the corresponding modal on mount after the child is selected. Highest-leverage piece: a one-click deep-link from /compliance lands the user inside the intake/consents/medication modal for the right child. | ~30 lines including modal-open effects per action. **CONSIDER IN-SCOPE if Seth wants the full one-click experience; defer to 3.2 if the user clicking through the family modal is acceptable.** Open call. |
| **B-4** | **FamiliesPage funding tab** | `?funding_source=<id>` (open a specific funding source detail) | Opens the funding source's detail view (where the DHS-198 / Enrollment Agreement uploads live). Lets G-group rows deep-link to the exact source needing the document. | ~15 lines. **Recommend DEFER to 3.2** unless B-3 is in-scope. |
| **C-1** | **StaffTrainingPage** | `?caregiver=<id>` (drill into a specific caregiver's training log) | All E-group rows currently land on /staff-training generically. With this, they land on the named caregiver's drill-in. | ~20 lines. **Recommend DEFER to 3.2** — staff training has its own tab structure inside the page; param needs careful validation. |
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

# Part 2 — per-requirement guidance + fix-target table

> Produced 2026-06-09 on `feature/phase-3-1-guidance-table`, verified
> against the registry on `main` (commit `0c50756` — post Pass-2
> citation corrections). Scoping artifact only — no code. Where this
> Part and §2's earlier draft rows conflict, this Part is the
> verified successor; §2 remains for bucket framing and prior review
> notes.

## Counts (count discipline)

- **Total registry requirements found: 51.** Earlier scoping notes
  said "~52" and the `complianceState.js` file header still says 52.
  The difference is exactly one row: `funding_dhs_198_on_file` (G1),
  removed 2026-06-06 in the CDC-layer correctness pass (in-file
  comment in the funding section; §11 of this doc already records
  "39 was 40 — G1 removed"). The mismatch is stated, not reconciled —
  no rows were merged or invented. `REGISTRY_ROW_COUNT` is computed
  from `Object.keys` and locked by test.
- **Route status across the 51 primary rows: A = 23 · B = 7 ·
  C = 19 · n/a = 2.** (n/a = D1/D6, whose resolvers cannot produce an
  actionable gap.)
- **Secondary `awaiting_input` gap-type rows: 5** (same requirement
  keys, different gap → different fix surface; Surface 3 below). All
  route status **B**.
- **review-me rows: 9** (A7, B1, B2, C2, D4, E5, E7, F1, G4).

## Contract this table feeds (and §1 divergence)

The decided `ActionableGap` contract:

```
{ guidanceText: string (required),
  fixTarget?: { label: string, to: string },   // `to` is FULLY BUILT, incl. query string
  severity: 'critical' | 'warning' | 'info' }  // presentation only, mapped from gap state by the consumer
```

- **No citation prop.** Citation stays in ChecklistRow. No guidance
  string below embeds a rule citation.
- **`fixTarget` optional; no dead-button state.** A row whose route
  can't be confirmed addressable to the right entity is text-only,
  full stop.
- **§1 of this doc diverges from the decided contract** (`guidance`
  prop name, separate `params` object, 4-level severity, `variant`
  prop). This table is written to the decided contract; §1 must be
  updated in the build PR. Open question Q5 covers the `variant`
  prop's fate.

### Severity mapping (consumer-side)

| gap state | severity |
|---|---|
| `missing_required` | `critical` |
| `unknown` / `needs_provider_data` | `critical` |
| `expired` | `warning` (exception: F2, advisory by design → `info`) |
| `pending_parent` | `warning` |
| `unknown` / `awaiting_input` | `warning` |
| `unknown` / `feature_not_yet_shipped` | `info` |
| `unknown` / load failure (`sourceRowsLoaded === false`) | `info` |
| `unknown` / `data_anomaly` | `info` |
| `on_file` (incl. `expiring_soon`) / `not_applicable` | ActionableGap does not render (Q10) |

## Global rules (apply to every row; not repeated per-row)

1. **Load-failure unknown.** When the envelope reports
   `sourceRowsLoaded === false` for a table the row's resolver reads:
   `guidanceText` = "We couldn't verify this — refresh to retry.",
   severity `info`, **no fixTarget**. ⚠ Wrinkle (open question Q1):
   `getRequirementState` (complianceState.js:2200-2202) returns
   `reason: 'awaiting-provider-input'` for ALL applicability-level
   unknowns **including** the §2a load-failure path — the load
   failure is NOT distinguishable by reason code. The consumer must
   branch on the envelope's `sourceRowsLoaded` BEFORE calling
   `classifyUnknownReason`, or the engine needs a distinct reason
   (e.g. `'source-rows-not-loaded'`). Without one of those, a
   transient load failure renders the `awaiting_input` "Tell us
   about this" treatment — exactly the misleading state this Part
   forbids.
2. **`data_anomaly` unknown.** `guidanceText` = "Something looks
   wrong with this record — contact support.", severity `info`, no
   fixTarget. Reserved for genuine anomalies (unparseable dates,
   completion date in future, no-state-resolver). Never used for a
   load failure (rule 1) or a provider-fixable gap
   (`needs_provider_data` rows have their own guidance below).
3. **Route evidence.** Every category-A `to` was verified by opening
   the route definition: `src/App.jsx:130-153` (route table) and the
   deep-link handler `src/pages/FamiliesPage.jsx:150-180` (`?family=`
   + `?tab=` consumed, `?tab=` validated against `KNOWN_TABS`
   including `children`/`funding`; `?child=` accepted but
   informational; `clearDeepLinkParams` clears all three). No route
   was guessed into A.

### Granularity convention for the Families deep link (Q9)

The Finding #5 scheme is addressable to **family + tab** — not to a
specific child or modal. `?child=` is accepted-but-informational
(FamiliesPage.jsx:163-167); there is no `?action=`. The link is
honest, not dead: it opens the right family's modal at the right
tab, where the named child is one click away. Surface 1/2 rows are
therefore marked **A at family+tab granularity**, and every `to`
already includes `child={child_id}` so the B-2 (scroll/focus) and
B-3 (modal auto-open) sub-work upgrades them without touching the
content map. If Seth sets the category-A bar at strict child-level
addressing, every Surface 1/2 row flips to B until B-2/B-3 land —
that's a one-line convention change, not a per-row re-audit.

The consumer builds `to` from the loader's children list, which
carries `family_id` (precedent: ComplianceChecklistPage.jsx:333-336
builds exactly this link shape today).

---

## Surface 1 — Families modal → Children tab (19 rows, all A)

`to` = `/families?family={family_id}&child={child_id}&tab=children`
— route `src/App.jsx:135`; params `FamiliesPage.jsx:150-169`.
fixTarget label: "Open this child's record" (or per-row below).

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `child_in_care_statement_envelope` (A1) | `missing_required`, `pending_parent` | The Child in Care statement hasn't been signed by a parent yet. Open the child's intake and send (or re-send) the bundle for signature. | `/families?family={family_id}&child={child_id}&tab=children` | A | high |
| `intake_lead_disclosure` (A2) | `missing_required` (inform-only — Pattern B, no pending_parent) | Your home was built before 1978, so the lead-paint disclosure must be on file for this child. Record it from the child's intake bundle. | same | A | high |
| `intake_firearms_disclosure` (A3) | `missing_required`, `pending_parent` | The firearms disclosure must be acknowledged by a parent. Send it from the child's intake bundle. | same | A | high |
| `intake_food_provider_agreement` (A4) | `missing_required`, `pending_parent` | The food-provider agreement hasn't been acknowledged by a parent. Send it from the child's intake bundle. *(Known-wrong citation on this row is a ChecklistRow concern — do not re-derive; it never enters guidanceText.)* | same | A | high |
| `intake_licensing_notebook_availability` (A5) | `missing_required`, `pending_parent` | The licensing-notebook-availability notice hasn't been acknowledged by a parent. Send it from the child's intake bundle. | same | A | high |
| `intake_licensing_rules_offered` (A6) | `missing_required`, `pending_parent` | The licensing-rules-offered acknowledgment is missing for this child. Send it from the child's intake bundle. | same | A | high |
| `intake_infant_safe_sleep` (A7) | `missing_required`, `pending_parent` (child <18 mo); `unknown`/awaiting-input when DOB null | Under 18 months: "This child is under 18 months, so a parent must acknowledge the safe-sleep policy. Send it from the child's intake bundle." DOB missing: "Add this child's date of birth so we can tell whether the safe-sleep acknowledgment applies." (DOB unknown is a child-record gap, **not** a Business-Info question — same fix target.) | same | A | **review-me** (forced): the alternate-sleep trigger ("how does the system know a child needs non-standard sleep?") is UNRESOLVED. Guidance above covers only the standard ack; no alternate-sleep fix flow is invented here. |
| `intake_health_condition` (A8) | `missing_required`, `pending_parent` | The health-condition disclosure hasn't been acknowledged by a parent. Send it from the child's intake bundle. | same | A | high |
| `intake_discipline_policy_receipt` (A9) | `missing_required`, `pending_parent` | The parent hasn't acknowledged receipt of your discipline policy for this child. Send it from the child's intake bundle. | same | A | high |
| `child_in_care_statement_envelope_drift` (B3) | `pending_parent` | This child's information changed after the parent last signed the Child in Care statement. Re-send it for a fresh signature. | same | A | high |
| `consent_field_trip_permission` (C1) | `missing_required`, `pending_parent` | Capture the parent's field-trip permission from the child's Consents. | same | A | high |
| `consent_transportation_routine_annual` (C2) | `missing_required`, `pending_parent`, `expired` | Capture — or renew — the parent's routine-transportation permission from the child's Consents. This permission currently expires annually. | same | A | **review-me**: the annual-expiry removal is approved as a separate all-surfaces PR (the logic change was backed out of the Pass-2 citation branch 2026-06-08). When it lands, the `expired` gap state disappears and "annually" comes out of this copy. Do not ship this row's copy without checking that PR's status (Q6). |
| `consent_water_activities_on_premises_seasonal` (C3) | `missing_required`, `pending_parent`, `expired` | Capture — or renew for the season — the parent's on-premises water-activities permission from the child's Consents. | same | A | high |
| `consent_transportation_nonroutine_per_trip_recency` (C4) | `pending_parent` (resolver yields on_file/pending only) | A non-routine transportation trip is on record without a parent-signed per-trip permission. Collect the parent's signature for that trip from the child's Consents. | same | A | high |
| `consent_water_activities_off_premises_per_trip_recency` (C5) | `pending_parent` | An off-premises water-activity trip is on record without a parent-signed per-trip permission. Collect the parent's signature for that trip from the child's Consents. | same | A | high |
| `consent_photo_sharing` (C6) | `missing_required`, `pending_parent` | Record the parent's photo-sharing choice from the child's Consents — a grant **or** a revocation both put this on file. | same | A | high |
| `medication_permission_per_authorization` (D2) | `missing_required`, `pending_parent` (incl. `authorization-changed-since-permission` drift) | A medication authorization is missing current parent permission — or the authorization changed after the parent signed. Re-collect permission from the child's Medications. | same | A | high |
| `medication_permission_otc_blanket` (D3) | `missing_required`, `pending_parent` | Collect the parent's blanket over-the-counter medication permission from the child's Medications. | same | A | high |
| `medication_original_container_attestation` (D5) | `missing_required` (`original_container_confirmed !== true`) | Confirm on this medication's record that it arrived in its original container with the required labeling. | same | A | high |

## Surface 2 — Families modal → Funding tab (2 rows, both A)

`to` = `/families?family={family_id}&child={child_id}&tab=funding`
— same handler evidence as Surface 1; `funding` ∈ `KNOWN_TABS`.
Funding-source-level addressing (the exact document slot) is
sub-work **B-4** (§4.2) — not required for A at this granularity.

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `funding_enrollment_agreement_on_file` (G2) | `missing_required` | This CDC funding source bills by enrollment but has no enrollment agreement on file. Upload it in the funding source's Documents. | `/families?family={family_id}&child={child_id}&tab=funding` | A | high |
| `cdc_authorization_currency` (G3) | `expired`, `missing_required`; `unknown`/`needs_provider_data` (`no-authorization-end-on-funding-source`) | Expired/missing: "This child's CDC authorization has ended or isn't recorded. Update the funding source dates after redetermination." needs_provider_data: "Add the authorization end date to this child's CDC funding source so we can track when it ends." | same | A | high |

## Surface 3 — Business Info (5 secondary `awaiting_input` rows, all B → text-only for now)

Route `/business-info` exists (`src/App.jsx:143`) and the page
renders `ApplicabilityQuestionsSection` (BusinessInfoPage.jsx:925)
and the premises-disclosures section (BusinessInfoPage.jsx:931
comment). **But `?section=` is NOT consumed** — BusinessInfoPage has
no `useSearchParams`/`useLocation` handler (verified by direct
search of the file, 2026-06-09). So the section deep link navigates
but doesn't land → **B — route exists, not addressable**. Per the
no-dead-button rule these render **text-only for now**; the missing
param handling is sub-work **B-1** (§4.2, ~10 lines, already
STRONGLY RECOMMEND).

Two honesty notes:

- **ChecklistRow.jsx:256 already emits**
  `/business-info?section=compliance_applicability` for
  `awaiting_input` rows — that shipped link under-delivers today.
  Recommendation: land B-1 in the same build PR, which flips all
  five rows here to A.
- **B-1 needs two section ids, not one.** A2/A3 booleans
  (`home_built_before_1978`, `firearms_on_premises`) live in the
  **premises disclosures** section; C2/C3/animal overrides live in
  **ApplicabilityQuestionsSection**. §4.2's single-id framing is
  incomplete (Q2).

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `intake_lead_disclosure` (A2) | `unknown`/`awaiting_input` | Tell us whether your home was built before 1978 — it decides whether the lead-paint disclosure applies. Answer in Business Info → Premises. | text-only (B-1 pending; premises section) | B | high |
| `intake_firearms_disclosure` (A3) | `unknown`/`awaiting_input` | Tell us whether firearms are present on the premises — it decides whether the firearms disclosure applies. Answer in Business Info → Premises. | text-only (B-1 pending; premises section) | B | high |
| `consent_transportation_routine_annual` (C2) | `unknown`/`awaiting_input` | Tell us whether you routinely transport children. Answer in Business Info → "What applies to my program?" | text-only (B-1 pending; applicability section) | B | high (wording should mirror `QUESTION_COPY` in ApplicabilityQuestionsSection.jsx:51-82) |
| `consent_water_activities_on_premises_seasonal` (C3) | `unknown`/`awaiting_input` | Tell us whether you have a pool or other qualifying water feature on the premises. Answer in Business Info → "What applies to my program?" | text-only (B-1 pending; applicability section) | B | high (same `QUESTION_COPY` note) |
| `property_animal_notification` | `unknown`/`awaiting_input` | Tell us whether animals are present on the premises. Answer in Business Info → "What applies to my program?" *(Even once answered "yes", the record itself is Pattern E — see Surface 7.)* | text-only (B-1 pending; applicability section) | B | high |

## Surface 4 — Staff Training `/staff-training` (6 rows, all B → text-only for now)

Route exists (`src/App.jsx:147`); **StaffTrainingPage consumes no
params** (no `useSearchParams` in the file — verified 2026-06-09),
so a specific caregiver is not addressable → **B**, text-only;
sub-work **C-1** (§4.2, `?caregiver=`).

Correction to §4.2: the `date_of_hire` edit lives on
**StaffTrainingPage** (write at StaffTrainingPage.jsx:285), not on
`/staff` — so **C-1 covers E3's hire-date fix and §4.2's C-2 routing
note is stale** (Q8).

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `caregiver_background_check_eligibility` (E1) | `missing_required`, `pending_parent` (status `pending`) | This caregiver's comprehensive background check isn't cleared yet. Record their eligibility on Staff Training once the check clears. | text-only (C-1 pending) | B | high |
| `caregiver_cpr_first_aid_current` (E2) | `expired`, `missing_required` (+`expiring_soon` advisory on on_file — Q10) | Record a current CPR/First Aid certification for this caregiver on Staff Training — renew before the expiration date. | text-only (C-1 pending) | B | high |
| `caregiver_new_hire_training_complete` (E3) | `missing_required`; `unknown`/`needs_provider_data` (`caregiver-missing-date-of-hire`) | Missing: "Log this caregiver's new-hire training on Staff Training — all 14 topics are due within 90 days of hire." needs_provider_data: "Add this caregiver's hire date on Staff Training so the 90-day window can be tracked." | text-only (C-1 pending) | B | high |
| `caregiver_miregistry_account` (E4) — **Type 1** | `expired`, `missing_required`; `unknown` `unrecognized-miregistry-status` → currently `data_anomaly` (Q7) | This caregiver's MiRegistry account isn't current. Renew it in MiRegistry, then update the transcribed status on Staff Training. (Auditors verify this in MiRegistry — we mirror it for visibility.) | text-only (C-1 pending) | B | high |
| `caregiver_professional_development_hours` (E5) — **Type 1** | `missing_required` (reason `hours-N-of-16`) | This caregiver has logged N of 16 annual professional-development hours. Complete approved training in MiRegistry and record the hours on Staff Training. | text-only (C-1 pending) | B | **review-me**: the engine uses a flat conservative 16-hour threshold (`ANNUAL_HOURS = 16` in complianceState.js); R 400.1924 hours vary by role. Copy asserting "16" needs Seth's blessing (Q7). |
| `caregiver_health_safety_update_acked` (E6) | `missing_required` (`unacked-update`) | A health & safety update hasn't been acknowledged by this caregiver. Collect their acknowledgment on Staff Training. | text-only (C-1 pending) | B | high |

## Surface 5 — MiRegistry tracker `/miregistry` (2 rows, both A)

Route `src/App.jsx:146`. Provider-level — the page is the
destination; no entity params needed (per §4.2 C-5, "the page itself
is the destination"). fixTarget label: "Open MiRegistry tracker",
`to` = `/miregistry`.

⚠ Surface-gating tension (Q4): F1/F2 are LEP-gated in the registry,
but every compliance surface that exists today gates to licensed
homes — so on current surfaces these rows resolve `not_applicable`
and never show a gap. The rows are specified anyway so the content
map is complete when an LEP-visible surface ships.

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `provider_miregistry_annual_ongoing` (F1) | `expired`, `missing_required` | Complete the Michigan Ongoing Health & Safety Refresher in MiRegistry before December 16 — missing the deadline closes your CDC account. If you enrolled this calendar year, the December 16 deadline begins next year — verify against your records. | `/miregistry` | A | **review-me** (forced by the registry itself): the first-year-LEP sentence is exactly the nuance the registry comment defers to "Phase 3.1 guidance copy" — Seth confirms wording. |
| `provider_miregistry_level_2_currency` (F2) | `expired` (+`expiring_soon`) — **advisory**, severity `info` always (registry severity `low`; a pay-rate drop, not a violation) | Your Level 2 status has expired (or expires soon) — your CDC pay rate drops to Level 1 on that date. Log 10 more approved training hours in MiRegistry, then update your transcribed level here. | `/miregistry` | A | high |

## Surface 6 — Parent Acknowledgments `/acknowledgments` (1 row, B → text-only for now)

Route exists (`src/App.jsx:145`) but ProviderAcknowledgmentsPage
consumes no params (grep of `useSearchParams` across `src/pages`,
2026-06-09) — a specific child/day is not addressable → **B**.
**New named sub-work, not in §4.2's inventory: "C-6 —
ProviderAcknowledgmentsPage `?child=` filter (~15 lines)"** (Q8).

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `attendance_parent_acknowledgment_per_day` (H1) | `pending_parent` (`N-days-provider-override-only`), `missing_required` (`N-days-missing-ack`) | pending: "N attendance day(s) have only your override on file — the parent hasn't confirmed. Ask them to confirm in their portal, or review the days on Parent Acknowledgments." missing: "N CDC attendance day(s) have no parent acknowledgment. Follow up with the parent, or record an override with a reason." | text-only (C-6 pending) | B | high |

## Surface 7 — No fix surface (19 C rows + 2 n/a)

Pattern E guidance must reuse `trackingCopy()` /
`TRACKING_SHIPS_WITH` (ChecklistRow.jsx:72-93) rather than duplicate
PR-name strings.

| requirement key | gap state(s) | plain-language guidance | fix target | route status | confidence |
|---|---|---|---|---|---|
| `child_immunization_record` (B1) | `missing_required` (status not in `up_to_date` / `waiver_on_file` / `in_progress`) | Record this child's immunization status — "up to date," "waiver on file," or "in progress" all satisfy the rule. | text-only | **C — no fix surface**: `children.immunization_status` has **no writer anywhere** — no UI component, page, or migration RPC sets it (searched src/ + supabase/migrations, 2026-06-09; column added in 024, read by the loader, written nowhere). The intake bundle's immunization *acknowledgment* does not set this column. | **review-me** (Q3 — capture gap needs an owner) |
| `child_annual_record_review` (B2) | `expired`, `missing_required`; unparseable date → `data_anomaly` (global rule 2) | Review this child's records and mark the review date — due annually, with first-year tolerance from intake. | text-only | **C — no fix surface**: `children.records_last_reviewed_on` has **no writer anywhere** (same search). The childAnnualReviewScheduler comment says "intake form → updates records_last_reviewed_on," but no code does. | **review-me** (Q3) |
| `medication_authorization_for_authorization` (D1) | none — resolver always `on_file` (the authorization row IS the evidence); only the global-rule-1 load-failure unknown is possible | n/a — no ActionableGap content | n/a | n/a | high |
| `medication_role_gate_integrity` (D4) | `missing_required` (`ineligible-role-administered-non-otc-dose`) | A non-OTC dose was recorded by someone not permitted to administer medication (licensee or child care staff member only). Review the dose log entry and your staffing assignments. | text-only | C — interim only | **review-me** (forced): this detection row is being **retired** — the designed fix (dropdown role-gating at capture) is NOT built. Do not write or build fix guidance as if it ships; the copy above is an interim stop-gap pending the retirement decision. |
| `medication_dose_log_retention` (D6) | none — resolver always `on_file` (retention is DB-enforced) | n/a | n/a | n/a | high |
| `cdc_fingerprint_reprint_currency` (G4) | `missing_required`, `expired` (5-year cycle, 30-day window — complianceState.js:1778-1785) | Your fingerprint capture is more than 5 years old (or not on record). Schedule a reprint and record the new date. | text-only | **C — no fix surface**: `profiles.fingerprint_date` has **no writer anywhere in src/** (loader reads it; nothing sets it). A capture surface must be named before any fixTarget — Business Info is the natural candidate (Q3). | **review-me** (Q3) |
| `caregiver_physician_attestation_annual` (E7) | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #18 (staff file gaps) — keep the signed physician attestation in your paper staff files; an auditor will ask to see it. | text-only | C | **review-me** (forced): the citation is verified, but the **"annual" recurrence is NOT verified** — copy must not assert a cadence until it is (the key name itself says "annual"; flag, don't infer). |
| `caregiver_discipline_policy_ack_at_hire` (E8) | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #17 (discipline policy receipt at hire) — keep signed paper acknowledgments for now. | text-only | C | high |
| `caregiver_daily_arrival_departure` (E9) | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #18 (staff file gaps). App-user caregivers already have clock records; keep a paper daily log for non-app caregivers meanwhile. | text-only | C | high |
| `drill_fire_quarterly` | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #19 (drills + emergency response plan) — keep your written drill log on paper; an auditor will ask to see it. | text-only | C | high |
| `drill_tornado_seasonal` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `drill_other_emergencies_annual` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `emergency_response_plan_on_file` | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #19 — keep your written emergency response plan on paper for now. | text-only | C | high |
| `property_radon_test_quadrennial` | `unknown`/`feature_not_yet_shipped` | Tracking ships with PR #21 (property records) — keep the test results / inspection reports on paper for now. | text-only | C | high |
| `property_heating_inspection_quadrennial` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `property_co_detectors_per_level` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `property_smoke_detectors_per_floor` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `property_fire_extinguishers_per_floor` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |
| `property_animal_notification` | `unknown`/`feature_not_yet_shipped` (once applicability is answered; the `awaiting_input` gap is Surface 3) | Tracking ships with PR #21 — keep per-family pet notifications on paper for now. | text-only | C | high |
| `property_smoking_prohibition_posted` | `unknown`/`feature_not_yet_shipped` | (same as the PR #21 rows above) | text-only | C | high |
| `property_licensing_notebook_archive` | `unknown`/`feature_not_yet_shipped` | (same as above) | text-only | C | high |

---

## Open questions for Seth (Part 2)

1. **Load-failure unknown is reason-indistinguishable from
   awaiting_input** (complianceState.js:2200-2202 — both yield
   `'awaiting-provider-input'`). Pick the sub-work: a distinct engine
   reason code, or a documented consumer-side `sourceRowsLoaded`
   branch before `classifyUnknownReason`. One of the two must ship
   with the build.
2. **B-1 must land with the build** — ChecklistRow.jsx:256 already
   emits the unconsumed `?section=` link — **and B-1 needs two
   section ids** (premises disclosures for A2/A3; applicability
   section for C2/C3/animal). §4.2's single-id framing is incomplete.
3. **Three columns have no writer anywhere** (UI or migrations):
   `children.immunization_status` (B1),
   `children.records_last_reviewed_on` (B2),
   `profiles.fingerprint_date` (G4). These rows can never leave
   their gap state from the app today. Pre-existing capture gaps,
   not 3.1 build items — but they need an owner and a target PR
   before those three rows get fixTargets.
4. **F1/F2 gating tension**: LEP-only rows, licensed-only surfaces —
   today they always resolve `not_applicable`. Ship the guidance now
   (content map complete for a future LEP surface) or mark deferred?
5. **§1 contract divergence**: `guidance` → `guidanceText`, `params`
   folded into fully-built `to`, 4-level → 3-level severity, and the
   `variant` prop has no equivalent in the decided contract
   (presumably `feature_not_yet_shipped` just renders text-only at
   severity `info`). Update §1 in the build PR.
6. **C2 sequencing**: this Part's C2 copy reflects current `main`
   (annual expiry ACTIVE). Re-review the row when the separate
   expiry-removal PR lands.
7. **Two engine-copy confirmations**: E5's flat 16-hour threshold in
   user-facing copy; E4's `unrecognized-miregistry-status` currently
   classifies to `data_anomaly` → "contact support," though it's a
   provider-fixable transcription — consider adding it to
   `NEEDS_PROVIDER_DATA_REASONS`.
8. **§4.2 inventory updates**: add **C-6** (ProviderAcknowledgmentsPage
   `?child=`, ~15 lines) for H1; **C-2 is stale** — the hire-date
   edit lives on StaffTrainingPage (line 285), not `/staff`, so C-1
   covers E3 and C-2 can be demoted/omitted.
9. **Category-A granularity bar**: family+tab accepted as A (the
   convention above) — confirm, or Surface 1/2 (21 rows) flip to B
   pending B-2/B-3.
10. **`expiring_soon` advisory** (E2/F2/G4 on_file rows): does
    ActionableGap render a nudge, or is that ChecklistRow-only?
    Recommend ChecklistRow-only for 3.1.

---

**End of compliance-engine Phase 3.1 scope doc — DRAFT, now
including Part 2 (2026-06-09).** No code, no migration,
no commit-to-main. Halting for Seth's review per §11 + Part 2's
open questions.
