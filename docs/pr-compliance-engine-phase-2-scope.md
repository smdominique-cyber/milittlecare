# PR Scope — Compliance Engine Phase 2: Consumer Refactor + Three Parent-View Bug Fixes

**Date:** 2026-06-03
**Status:** Scope — **DRAFT for review.** Two design decisions need
Seth's input before this becomes the build: (a) the
parent-surface-per-category model (§6 — the question parked since
the consent phases) and (b) the per-occurrence parent surface's UX
shape (§7 — bug 3's new view). The consumer inventory and the
per-bug trace are mechanical; those two are not.
**Parent docs:** `docs/pr-compliance-engine-scope.md` (the three-faces
DRAFT) and `docs/pr-compliance-engine-phase-1-scope.md` (the engine
that just shipped — `src/lib/complianceState.js` +
`complianceStateLoader.js`, merged to main as commit `123ed0e`).
**Branch (suggested, two-part):** `feature/compliance-engine-phase-2a`
for the pure refactor + Bugs 1 & 2, then
`feature/compliance-engine-phase-2b` for the new per-occurrence
surface + Bug 3.

---

## Summary

Phase 1 shipped the **engine without consumers**: a 52-row registry,
six requirement states, a clean pure verdict API. Phase 2 plugs the
consumers into it — primarily the parent-facing surfaces, because
all three known consent bugs live on the parent side. The refactor
fixes Bugs 1 and 2 by structural change (the engine knows category +
label; consumers stop hand-rolling either); Bug 3 needs an
**additive UI surface** for per-occurrence consents (a missing view,
not a refactor target).

The doc resolves the **"what each parent surface shows per consent
category"** question parked since the consent phases — Bug 3 forces
it. Per category (intake / durable / time-bound / per-occurrence /
medication), this scope locks the verb the parent surface uses, the
state model it projects from, and where it lives in the UI.

Split into **2A (pure refactor + Bugs 1, 2)** and **2B (additive
per-occurrence surface + Bug 3)** to land the lower-risk refactor
first; the per-occurrence surface is the design-heavy part that
benefits from a separate review cycle.

What this scope does NOT do: refactor provider-side consumers
(they work; refactoring carries regression risk for little gain —
deferred to a later optional pass); migrate any data; touch
existing helpers' return shapes (`getChildFilesAuditState`,
`pendingEnrollmentConsentsForChild` keep their signatures so
indirect consumers don't break); add new ACK_TYPES or schema.

---

## DECISIONS — RESOLVED (and the two genuinely open ones)

| # | Decision | Resolution |
|---|---|---|
| 1 | Engine is the source of truth for parent-side surfaces | **LOCKED.** Every parent surface that renders consent / intake / compliance state in Phase 2 reads from `getChildComplianceState` (or a focused projection helper over it). The existing per-domain helpers (`pendingEnrollmentConsentsForChild`, `getChildFilesAuditState`) stay in place — both as a backward-compat seam and because the engine's `getChildComplianceState` already implements the same verdict for the rows they cover (Phase 1 §3). The parent panels swap which function they call; the existing functions keep working for any indirect consumer. |
| 2 | Provider-side consumers are OUT of Phase 2 | **LOCKED.** `EnrollmentConsentsModal`, `ChildIntakeModal`, `MedicationModal`, `getChildFilesAuditState` all currently work correctly. Refactoring them carries regression risk against shipped, live behavior with no user-visible win. Captured as a future optional pass (see §12). |
| 3 | Add `label` / `description` exposure to the registry | **LOCKED** — already shipped in Phase 1. Every `REQUIREMENT_REGISTRY` row carries `label: string` (short UI label). The registry IS the friendly-label source. Bug 1's fix is one line per parent surface: `requirement.label` instead of `SUB_TYPE_LABEL[type]` or the raw type string. |
| 4 | Engine is authoritative for category | **LOCKED** — already shipped. Every row carries `category: 'child_files' \| 'consents' \| 'medication' \| ...`. The intake-bundle rows are `child_files`; per-occurrence are `consents`. Bug 2's fix follows from filtering by category at the parent intake surface. |
| 5 | The parent-surface-per-category model | **Seth's call — see §6.** Five categories to map to verbs. The recommendation in §6 is per-category UX: intake = "confirm these," durable = "on file / talk to provider," time-bound = "on file / expired — talk to provider," per-occurrence = "list of recorded events, read-only," medication = "permission on file / talk to provider." Seth react. |
| 6 | The per-occurrence parent surface (Bug 3) | **Seth's call — see §7.** Three layout options proposed (collapsed-by-default-with-count, always-visible-with-list, separate-tab). Recommendation: **collapsed-by-default with count + most-recent N expanded when ≥1 row exists.** Lowest visual cost when zero rows; rich when there's data to show. |
| 7 | New ACK_TYPES or schema for Bug 3 | **LOCKED: none.** The per-occurrence types already exist (`transportation_nonroutine_per_trip`, `water_activities_off_premises_per_trip`). The engine already classifies them as `consents` category. The parent panel just needs to render them — pure UI. No migration, no constant changes. |
| 8 | RLS for the per-occurrence parent view | **LOCKED — already in place.** Migration 024's parent SELECT policy on `acknowledgments` already returns per-occurrence rows for children the parent is linked to. The parent panel's existing query at `ParentEnrollmentConsentsPanel:126-131` already returns these rows — they're just unrendered today. No RLS work needed. |
| 9 | Engine helper signature gap | **LOCKED: add ONE thin helper.** `src/lib/complianceState.js` exports `getChildComplianceState` returning the FULL per-child rollup across every category. The parent panel wants a category-filtered projection. Add `getChildComplianceStateForCategory({ child, provider, sourceRows, category, overrides, now })` — a thin filter over the existing function. No schema change; no new logic; just a typed projection. Phase 2A adds it. |
| 10 | Phase 2 sub-phasing | **LOCKED:** 2A (pure refactor of existing parent surfaces, fixes Bugs 1 & 2) → 2B (new per-occurrence surface, fixes Bug 3). Each its own branch + PR. 2A is the lower-risk landing; 2B is the design-heavy half. |
| 11 | Schema change | **LOCKED: ZERO.** Reading from the engine; engine doesn't mutate; new surface is read-only. |
| 12 | Verification gate is live + before/after | **LOCKED — see §9.** Phase 2 ships visible UI changes on surfaces real users hit. Tests aren't sufficient; the gate is the three bugs demonstrably fixed (with before/after evidence) AND no correctly-working surface regressed (per-surface live check). |
| 13 | Determinism + backward-compat smoke | **LOCKED.** Vitest tests for the new helper (`getChildComplianceStateForCategory`) plus an integration-shaped test that asserts the parent panel's category projection matches what the existing `pendingEnrollmentConsentsForChild` returned for the same input — drift detector. |

---

## §1. The Phase 1 engine — what Phase 2 consumes

For reference. The API Phase 2 reads from:

```js
// PURE — src/lib/complianceState.js (Phase 1 — shipped)
import {
  REQUIREMENT_REGISTRY,
  REQUIREMENT_STATE_KIND,           // on_file | expired | missing_required | pending_parent | not_applicable | unknown
  APPLICABILITY_RESULT,             // applies | does_not_apply | unknown
  CATEGORIES,                       // child_files, consents, medication, staff_files, miregistry, funding_docs, cdc_compliance, attendance, drills, property
  getRequirementState,              // (ctx) => RequirementState
  getChildComplianceState,          // (ctx) => PerChildComplianceState
  getProviderComplianceState,       // (ctx) => ProviderComplianceState
  resolveApplicability,             // (ctx) => 'applies' | 'does_not_apply' | 'unknown'
} from '@/lib/complianceState'

// IMPURE — src/lib/complianceStateLoader.js (Phase 1 — shipped)
import {
  loadComplianceSourceRows,         // ({ providerId, childIds }) => { provider, children, sourceRows }
  computeProviderComplianceState,   // ({ providerId }) => ProviderComplianceState
  computeChildComplianceState,      // ({ providerId, childId }) => PerChildComplianceState
} from '@/lib/complianceStateLoader'
```

Every registry row exposes `label`, `category`, `subject_type`,
`data_authority`, `severity`, plus an `applicability` rule and a
`state_resolver`. Per-child rollup returns per-category buckets;
each bucket carries a `requirements[]` array of
`{ applicability, state }` pairs that also carry
`requirement_key` for downstream label lookup.

---

## §2. Consumer inventory

The audit below enumerates every place in the app that currently
computes consent / compliance / on-file state independently. Each
row says what it does today, whether Phase 2 refactors it, and
why.

| # | Consumer | What it computes today | Phase 2 action | Why |
|---|---|---|---|---|
| **1** | `src/pages/ParentIntakeAcknowledgePage.jsx` | Reads `acknowledgments` where `subject_type='child'` for the parent's children (lines 122-128), groups by child, renders each ack via `SUB_TYPE_LABEL[type] \|\| a.type`. Confirm-flow builds the envelope hash from EVERY existing row's type (line 189-191). | **REFACTOR (2A).** Read from the engine for the intake-bundle category; filter to `child_files` category requirements; render `requirement.label`. **This consumer hosts Bugs 1 AND 2.** | Bug 1's friendly-label gap (line 342 falls back to raw type for unknowns) + Bug 2's category-leak bug (per-occurrence types pulled into the bundle) both originate here. The engine's category + label resolve both. |
| **2** | `src/pages/ParentEnrollmentConsentsPanel.jsx` | Reads `acknowledgments` for parent's children (lines 126-131), partitions by expiry, calls `pendingEnrollmentConsentsForChild` for the verdict, iterates `ENROLLMENT_CONSENT_TYPES` (durable + Phase B only) to render rows. Has explicit `PhotoStatusRow` with revocation-pair handling. | **REFACTOR (2A) + EXTEND (2B).** Phase 2A: drop the inline ack-fetch + verdict call; read from engine's `consents` category projection. Render `requirement.label` per row. Phase 2B: add per-occurrence section beneath the existing durable-consent list — **the new surface for Bug 3.** | The panel currently has no surface for `PER_OCCURRENCE_CONSENT_TYPES` (the structural exclusion is in `ENROLLMENT_CONSENT_TYPES`). Bug 3 is "no view exists." Engine-read in 2A unblocks adding the per-occurrence subview in 2B. |
| **3** | `src/pages/ParentAcknowledgmentsPage.jsx` | Tab-wrapper around the two parent pages. Computes intake-pending count via `reminder_instance_list_for_parent` RPC + consent-tab badge via inline `pendingEnrollmentConsentsForChild` call. | **REFACTOR (2A, light).** Replace the inline consents-badge computation with engine-based projection (the badge count == "children with at least one applicable consent gap" via the engine). Keep the intake RPC badge as-is (the RPC is its own data path, not a consent verdict). | The badge counts must agree with what the consent tab itself renders. Reading from the same source removes drift risk between the badge and the panel. |
| **4** | `src/components/parent/EnrollmentConsentsPendingBanner.jsx` | Parent dashboard banner. Reads `acknowledgments`, partitions by expiry, calls `pendingEnrollmentConsentsForChild`, renders summary. | **REFACTOR (2A, light).** Same shape as #2 / #3 — read from engine's `consents` category projection. | Keeps the dashboard banner consistent with the Consents tab the user opens after clicking it. |
| **5** | `src/pages/MessageThreadPage.jsx` (loadPhotoConsentReminderState) | Uses `photoConsentNeedsReminderForChild` from `childFiles.js` — pure, takes activeAcks, returns boolean. | **KEEP AS-IS.** | This is a different question (semantic per `childFiles.js:478-518` header) — "should the messaging photo nag fire?" — with different rules than the engine's consent state. The function is pure and correctly scoped. Don't refactor. |
| **6** | `src/lib/childFiles.js` `getChildFilesAuditState` | Provider audit-state helper. Single Supabase fetch + verdict over child-files + enrollment-consents categories. | **KEEP AS-IS.** | Per-domain audit-state helper consumed by the dashboard. Phase 2 leaves it untouched; it shares the verdict pattern with the engine but is provider-side scope. Future provider-side refactor is optional (decision 2). |
| **7** | `src/components/families/EnrollmentConsentsModal.jsx` | Provider capture flow + `refresh()` direct supabase read. | **KEEP AS-IS.** | Capture-side. Reads acks to populate the modal's "what's on file" view. Hand-rolled today but works correctly. The save-stays-open fix landed cleanly 2026-06-02. Refactor risk > value. |
| **8** | `src/components/families/ChildIntakeModal.jsx` | Provider intake capture. | **KEEP AS-IS.** | Same reasoning as #7. |
| **9** | `src/components/families/MedicationModal.jsx` | Provider medication capture + state. | **KEEP AS-IS.** | Same reasoning as #7. |
| **10** | `src/components/dashboard/*` (TodayWidget, AnnualTrainingBanner, etc.) | Provider dashboard widgets reading per-domain audit-state. | **KEEP AS-IS.** | Provider-side; working. |

### Summary

**Refactored in 2A: consumers 1, 2, 3, 4** (parent intake page,
parent consents panel, parent acks tab wrapper, parent dashboard
banner) — all four read from the engine for their consent /
intake verdict.

**Extended in 2B: consumer 2** (parent consents panel) — gains the
new per-occurrence section.

**Kept: consumers 5-10** — five provider-side, plus the photo-nag
helper (which is its own question).

---

## §3. The three bugs — root cause + engine-side fix

### Bug 1 — Raw type string on the parent Intake tab

**Live evidence:** `ParentIntakeAcknowledgePage.jsx:340-344` —

```jsx
<ul ...>
  {subTypeAcks.map(a => (
    <li key={a.id}>{SUB_TYPE_LABEL[a.type] || a.type}</li>
  ))}
</ul>
```

`SUB_TYPE_LABEL` (lines 41-51) maps only the 9 intake-bundle types.
When ANY other type lands in `subTypeAcks` — which can happen
because of Bug 2 — the `|| a.type` fallback renders the raw type
string (e.g., `water_activities_off_premises_per_trip` shown
literally).

**Engine-side fix (2A):** the parent intake page reads from
`getChildComplianceStateForCategory({ category: 'child_files' })`
(the new helper) — which returns only intake-bundle requirements,
each carrying `requirement.label`. The rendering becomes:

```jsx
{requirements.map(r => (
  <li key={r.requirement_key}>{REQUIREMENT_REGISTRY[r.requirement_key].label}</li>
))}
```

Bug 1 is structurally impossible after the refactor — the category
filter excludes the rows that lacked labels, AND every row that
remains has a `label`.

### Bug 2 — Per-occurrence consent miscategorized into the parent intake-confirm bundle

**Live evidence:** `ParentIntakeAcknowledgePage.jsx:122-128` —

```js
const ackResp = await supabase
  .from('acknowledgments')
  .select(...)
  .eq('subject_type', 'child')
  .in('subject_id', kids.map(k => k.id))
  .is('archived_at', null)
```

This pulls EVERY ack for the child where `subject_type='child'`,
which is also the subject_type used by per-occurrence consent rows
(`transportation_nonroutine_per_trip`,
`water_activities_off_premises_per_trip`). They flow into
`acksByChild`, into `subTypeAcks`, into the envelope-hash
composition at line 189-191, into the parent-confirmed bundle at
line 199-204 — silently rewriting per-occurrence event records as
intake-bundle items in the audit trail.

**Engine-side fix (2A):** the engine's registry categorizes
correctly — `transportation_nonroutine_per_trip` is `category:
'consents'`, NOT `category: 'child_files'`. The parent intake page
projects only `child_files`. Per-occurrence rows are structurally
excluded from the bundle.

A second defense: the confirm-flow's row-set is the projection
output, NOT the raw ack fetch. The engine's category filter is the
gate.

Bug 2 is fixed structurally after the refactor: the engine never
puts a per-occurrence ack into the intake bundle's category, and
the parent page only reads the intake bundle's category.

### Bug 3 — No parent-facing surface for per-occurrence consents

**Live evidence:** `ParentEnrollmentConsentsPanel.jsx:219-228` —

```jsx
{ENROLLMENT_CONSENT_TYPES.map(type => (
  <EnrollmentConsentRow type={type} ... />
))}
```

`ENROLLMENT_CONSENT_TYPES` from `childFiles.js:124-132` includes
only durable + Phase B types. `PER_OCCURRENCE_CONSENT_TYPES` is
structurally separate (`childFiles.js:185-188`). The panel's
explicit design choice excludes them — verbatim from the file
header:

> Per-occurrence consents are event records, not enrollment
> state … The verdict function NATURALLY doesn't see them.

The provider can record 50 trip permissions in
`EnrollmentConsentsModal`'s per-occurrence section. None of them
appear in the parent's view. The parent sees "no per-trip consent
on file" — even though dozens are.

**Engine-side fix (2B):** the engine already knows per-occurrence
state via `consent_transportation_nonroutine_per_trip_recency`
and `consent_water_activities_off_premises_per_trip_recency`
(applicability data-inferred from any active per-occurrence row in
the last 12 months). The state tells the panel WHETHER to render
the section.

But the engine's "recency" requirement is a single boolean (any
active row in window) — it doesn't carry the list of trip dates,
destinations, attachments. The parent surface needs that detail.
**The new section reads ack rows directly** (the parent SELECT
policy on `acknowledgments` is already in place per migration 024)
for the two per-occurrence types and renders a per-event list. The
engine tells the panel WHETHER to show the section; the panel
reads the rows to show WHAT.

This is the additive UI piece of Phase 2B — see §7 for the UX
shape Seth must react to.

---

## §4. The new helper — `getChildComplianceStateForCategory`

Phase 2A adds one thin pure helper to `src/lib/complianceState.js`:

```js
/**
 * Per-child rollup, filtered to a single category. Convenience over
 * `getChildComplianceState` — same logic, returns only the named
 * category's bucket + a totals object scoped to it. Parent surfaces
 * that render one category's view (e.g., intake-only, consents-only)
 * use this rather than load the full per-child state and discard
 * other categories.
 */
export function getChildComplianceStateForCategory({
  child, provider, sourceRows, category, overrides, now
}): {
  child_id: string,
  category: string,
  requirements: RequirementResult[],   // each with `requirement_key` ref
  applicable_count, on_file_count, expired_count,
  missing_required_count, pending_parent_count,
  not_applicable_count, unknown_count,
  any_gap, any_unknown_input,
}
```

Pure. Tested. Phase 2A's first commit. Mirrors the existing
`getChildComplianceState` signature minus the per-category map.

---

## §5. Refactor surface — file by file (Phase 2A)

The actual code changes per consumer. None are large; each is
"swap the data source, keep the render structure."

### `ParentIntakeAcknowledgePage.jsx`

**Today:** direct ack fetch + inline `SUB_TYPE_LABEL` map + envelope
composition over whatever rows came back.

**After 2A:**
- Replace lines 122-128 (the broad ack SELECT) with a call to
  `loadComplianceSourceRows({ providerId, childIds })` followed by
  `getChildComplianceStateForCategory({ child, provider,
  sourceRows, category: 'child_files' })` per child.
- Replace lines 41-51 (`SUB_TYPE_LABEL`) — delete it; pull labels
  from `REQUIREMENT_REGISTRY[r.requirement_key].label`.
- Lines 171-247 (the confirm flow) STAY as-is — the RPC contract
  doesn't change; only the `subRows` source changes from "all acks
  the page pulled" to "only the intake-bundle category's
  requirements that have an active ack." The envelope hash
  composition reads from the engine's bundle, not the raw fetch.

**Risk:** the confirm RPC `intake_confirm_for_parent` accepts a
`p_rows` array. We feed it exactly what we used to (the
child_files-category active acks), just sourced from the engine.
Live test confirms parity.

### `ParentEnrollmentConsentsPanel.jsx`

**Today:** direct ack fetch + `partitionAcksByExpiry` +
`pendingEnrollmentConsentsForChild` + iterate
`ENROLLMENT_CONSENT_TYPES` + render `EnrollmentConsentRow` +
`PhotoStatusRow`.

**After 2A:**
- Replace the data load (lines 83-158) with
  `loadComplianceSourceRows` +
  `getChildComplianceStateForCategory({ category: 'consents' })`
  per child.
- Replace the iteration (line 219-228) with iteration over the
  category's `requirements[]`, rendering each by its
  `requirement_key` lookup against the registry for label +
  description.
- `PhotoStatusRow`'s revocation-pair logic stays — the engine
  already reports the right state (on_file with `revoked: true`
  flag for revoked-via-satisfying-channel; on_file/pending_parent
  for normal photo consent). Render keys off `requirement_key`
  and the `state.revoked` flag.

**After 2B (additive):** add a new section beneath the existing
durable-consent list — see §7.

### `ParentAcknowledgmentsPage.jsx`

**Today:** computes consent badge count inline.

**After 2A:** consume engine-projected count. Same number;
different data path. Removes the second inline `pendingEnrollment
ConsentsForChild` call site so the badge can never drift from the
panel.

### `EnrollmentConsentsPendingBanner.jsx`

**Today:** banner that fires when any of the parent's children has
a pending consent.

**After 2A:** consume engine. Same conditions; same UI.

---

## §6. The parent-surface-per-category model — Seth react

The question parked since the consent phases. Per category, what
does the parent see, where, and what verb? Resolving this is what
makes Phase 2 coherent rather than a one-bug-at-a-time patch.

### The categories (engine-defined)

The registry has 10 categories. The parent surfaces touch four:

1. **`child_files`** — R 400.1907 intake bundle. 12 rows in the
   engine (envelope + lead + firearms + food + 2× licensing
   notebook/rules + safe-sleep + health + discipline +
   immunization + annual review + drift).
2. **`consents`** — enrollment-level + per-occurrence. 6 rows in
   the engine (field trip, transport routine, water on-prem,
   transport per-trip, water off-prem per-trip, photo).
3. **`medication`** — R 400.1931. 6 rows in the engine
   (authorization, per-medication permission, OTC blanket, role
   gate, container attestation, dose log).
4. **`attendance`** — daily acks. 1 row. Already has its own
   `/parent/acknowledge` flow.

The other six categories (`staff_files`, `miregistry`,
`funding_docs`, `cdc_compliance`, `drills`, `property`) are
provider-only — the parent never sees them. The audit boundary
already enforces this via the existing parent RLS policies.

### Proposed per-category UX model

| Category | Where the parent sees it | What it shows | Verb |
|---|---|---|---|
| `child_files` (intake bundle) | `/parent/intake-acknowledge` tab on `/parent/acknowledge` | Per child, the parent-signed sub-rows the provider has captured awaiting the parent's confirmation. After confirm, the rows are stamped parent_portal and the child drops off the page. | **"Confirm these"** — actionable, button-based. Existing UX. |
| `consents` — durable (field trip, photo) | Consents tab on `/parent/acknowledge` | Per child, the durable consents. Each row shows on file (with channel + date) OR not on file yet (with "talk to your provider" copy). Photo consent shows tri-state (consented / revoked / not on file). | **"On file / talk to your provider"** — informational, no parent action. Existing UX. |
| `consents` — time-bound (transport routine, water on-prem) | Same Consents tab | Each row shows on file (with renewal date) OR expired (talk to your provider) OR not on file yet. | **"On file — renews Date / expired — talk to your provider"** — informational. Existing UX. |
| `consents` — per-occurrence (transport per-trip, water off-prem per-trip) | **NEW section on the Consents tab — see §7** | Per child, a list of recorded trip / outing events. When ≥1 exists: count + most-recent N with date + description. When zero: "No per-trip consents on file yet — your provider records these before each trip / outing." | **"Recorded — read-only history"** — informational, no parent action. **NEW — Phase 2B.** |
| `medication` (permission rows) | **NEW row on the Consents tab — see §6a** | Per child, "Medication permission on file" or "Talk to your provider about medication permission" when the child has an active medication authorization but no parent-signed permission ack. | **"On file / talk to your provider"** — informational. **NEW — Phase 2B.** |
| `attendance` | `/parent/acknowledge` (Attendance tab — separate from this scope) | Per-day attendance acks. | Existing UX, unchanged. |

### §6a. Medication permission on the parent surface

A flagged ambiguity. The medication category lives on the parent
surface in principle (per the engine's category model), but the
parent has never seen medication state today. The engine knows
when a child has an active medication authorization (per
requirement #20-#25 in the registry).

**Two options:**

**Option A — surface medication permission state on the Consents
tab (RECOMMENDED).** Add a single row per child showing the
medication permission state. Quiet when there's no medication on
file (state = not_applicable). Informational when there is. Same
read-only framing as the durable consents.

**Option B — leave it as a future PR.** Phase 2 only covers
consents categorization. Medication parent-view ships separately.

Recommendation: **Option A**. The engine already returns it; the
parent's right-to-see is the same as enrollment consents (both
read off the same RLS); the panel rendering is one extra row.
Seth react.

---

## §7. Bug 3 — the per-occurrence parent surface UX

The meatiest design call in this scope. Three layout options.

### What needs to be on the surface

Per-event detail:
- Event date (from `occurrence_metadata.event_date`).
- Description (from `occurrence_metadata.description` — destination
  for transport, location + activity for water).
- Channel (in-person paper / parent portal / provider override).
- Capture date (`acknowledged_at`).
- Attachment if any (the existing `ConsentAttachmentSlot` in parent
  mode renders signed-paper scans via the Edge Function).

Per child, per type:
- A section header (e.g., "Per-trip transportation consents on
  file for Audrey").
- Count + list.

### Layout options

#### Option A — Collapsed-by-default with count (RECOMMENDED)

```
┌─────────────────────────────────────────────────┐
│ Field trip permission              ✓ On file    │
│ Routine transportation             ✗ Not on file │
│ On-premises water activities       ✓ On file    │
│ Photo sharing                      ✓ Consented  │
│                                                 │
│ ▶ Per-trip transportation permissions (3 on file)│
│ ▶ Per-outing water activity permissions (0)     │
└─────────────────────────────────────────────────┘
```

Tap the disclosure to expand:

```
│ ▼ Per-trip transportation permissions (3 on file)│
│   • Sep 12, 2026 — Public library trip          │
│     Signed in person · attachment on file       │
│   • Aug 28, 2026 — Zoo field trip               │
│     Confirmed in portal · attachment on file    │
│   • Jul 15, 2026 — Splash park trip             │
│     Signed in person                            │
│   When your provider takes [child] on another   │
│   non-routine trip, they'll record permission   │
│   here before the trip.                         │
```

**When zero rows exist:** collapsed disclosure with `(0)` count.
Tapping it shows the explainer copy without any list.

**Pros:**
- Minimal visual cost when the section is empty (most
  enrollment-stable cases).
- Discoverable when needed.
- Matches the iconography of the rest of the panel.

**Cons:**
- Hidden by default — parents who don't think to expand it won't
  know per-trip permissions exist.

#### Option B — Always-visible with full list

Same section, never collapsed. Pros: discoverability. Cons:
visual clutter when zero rows.

#### Option C — Separate tab on `/parent/acknowledge`

Three tabs become four: Attendance / Intake / Consents /
Per-trip. Pros: clean separation. Cons: tab proliferation; users
already complain about tab overload.

### Recommendation: **Option A**.

Lowest visual cost; full discoverability when there's data. The
disclosure widget is a familiar idiom; the count makes the
existence visible at a glance.

### State model behind the section

- Engine signals **whether to render the section header** via
  `consent_transportation_nonroutine_per_trip_recency` and
  `consent_water_activities_off_premises_per_trip_recency`
  requirements. When applicability is `does_not_apply` (no rows
  in the last 12 months), the section still renders with count 0
  + explainer — the engine's binary doesn't drive
  show/hide, just informs the count.
- The panel reads the **per-occurrence ack rows directly** for the
  list detail (parent SELECT policy on `acknowledgments`,
  migration 024). The engine's "recency" requirement is summary
  data; the list is detail data.

### Honest copy rule

Per `CLAUDE.md`'s "providers' lived experience is data" principle:
the surface frames per-occurrence consents as **records of past
events**, not "things you need to do." Parents have no action on
this surface — it's a portal into what's on file. The provider
captures permission before each trip; the parent's role is to be
informed via the trip notification (separate from this surface).

### Attachment rendering

Each event row that has an attached scan renders the existing
`ConsentAttachmentSlot mode="parent" targetType="acknowledgment"
targetId={ack.id}` — the same component the durable-consent rows
already use. The Edge Function (`api/consent-attachment-url.js`)
already handles parent-side signed URLs; no work needed.

---

## §8. Backward-compat + regression surface

Phase 2A ships visible UI changes on routes real users hit
(Venessa's families, etc.). Phase 2B adds a new section to a tab
the same users see. Risks:

### Risk 1 — Refactor changes a correct current behavior

**Where it lives:** the parent intake confirm flow. If the engine's
`child_files` category projection drops a row the old SELECT
included, the parent's confirmed bundle becomes incomplete.

**Mitigation:** the new helper `getChildComplianceStateForCategory({
category: 'child_files' })` returns EXACTLY the same set of rows
the existing `requiredSubTypesForChild` + `getChildFileCompleteness`
flow uses. A drift detector test (§9 tests) locks the two paths
to the same output for every fixture child.

### Risk 2 — Engine returns a different verdict than the inline path

The engine and `pendingEnrollmentConsentsForChild` BOTH compute
the same verdict for `consents`-category rows. By design — the
engine's Pattern A resolver mirrors the verdict logic.

**Mitigation:** the test suite asserts engine output ==
`pendingEnrollmentConsentsForChild` output for the same input,
across multiple fixtures, BEFORE the refactor cuts over. Drift
fails the build.

### Risk 3 — Bug 2's confirm-flow change breaks Vanessa's data

The existing confirm flow at lines 199-204 wrote per-occurrence
rows into the bundle by accident. Fixing the bug means the
bundle is now SMALLER on confirm. Vanessa's pre-Phase-2 confirmed
children may have envelope-hash references to per-occurrence rows
that the new bundle won't include — drift on re-confirm.

**Mitigation:** the confirm RPC is fire-once per child; the
existing parent_portal rows for any previously-confirmed child are
not re-archived. The bug fix changes future confirms only. Past
confirmations are preserved unchanged in the audit trail (the
provider_override rows that were archived stay archived; the
parent_portal rows stay active).

### Risk 4 — Phase 2B's new section breaks tab navigation

A new section on the existing Consents tab grows the page height
on phones. Reusing the existing card layout keeps the visual
language; the disclosure widget is collapse-by-default so the
initial paint is unchanged for the zero-row case.

**Mitigation:** the disclosure default is closed when count=0.
Initial visual identical to today for any parent with no
per-occurrence acks. Verification gate confirms.

---

## §9. Verification gate — live + before/after per bug

### Before/after for each of the three bugs (the headline gate)

**Bug 1 — raw type string on parent Intake tab.**
- **Before:** create a per-occurrence ack on a child (provider
  records a trip). Reload `/parent/intake-acknowledge?child=<id>`.
  The page renders the per-occurrence type string raw in the
  bundle list (e.g., "water_activities_off_premises_per_trip").
- **After (2A):** same setup. The per-occurrence row is
  STRUCTURALLY excluded from the bundle (Bug 2 fix). For any
  other row that remains, the friendly label renders. **No raw
  type string anywhere on the page.**

**Bug 2 — per-occurrence miscategorized into parent confirm bundle.**
- **Before:** with a per-occurrence ack present, click "I confirm
  these." Check the resulting parent_portal rows in
  `acknowledgments`. The per-occurrence type was archived as part
  of the bundle and a fresh parent_portal row with that type was
  written. **Data corruption.**
- **After (2A):** same flow. The per-occurrence row is excluded
  from the bundle. The parent_portal write contains only the
  intake-bundle types. The original per-occurrence ack stays
  active.

**Bug 3 — no parent-facing per-occurrence surface.**
- **Before:** with 3 per-occurrence acks for a child, open the
  Consents tab. The child's section shows only the durable
  consents. Per-occurrence acks are invisible.
- **After (2B):** same setup. A new disclosure section "Per-trip
  transportation permissions (3 on file)" appears beneath the
  durable list. Expanding it shows the 3 events with dates,
  descriptions, channels, and attachments where applicable.

### Live check per surface (no regression on correct behavior)

For every refactored consumer, run a live test on the preview
build:

| Surface | Before | After | Pass criteria |
|---|---|---|---|
| `/parent/intake-acknowledge` (no per-occurrence acks) | Renders 9 sub-types correctly with labels | Renders same 9 sub-types correctly with labels | Page identical |
| `/parent/intake-acknowledge` (with per-occurrence acks) | Bug 1 + Bug 2 fire | Bugs structurally fixed | Bundle list omits per-occurrence; labels render for all |
| `/parent/acknowledge` Consents tab (durable on file) | Renders existing rows with channels + dates | Same | Page identical |
| `/parent/acknowledge` Consents tab (zero per-occurrence) | (no per-occurrence section) | Disclosure section "Per-trip … (0)" collapsed | New section present; zero count |
| `/parent/acknowledge` Consents tab (with per-occurrence) | (no surface) | Disclosure section "Per-trip … (N)" — expandable | Section renders, count matches DB, expanded list shows events |
| Parent dashboard (consent banner) | Banner fires when consents pending | Same | Same banner conditions |
| Parent acks-tab badge count | Matches consent tab | Matches consent tab | No drift |
| Photo-consent revocation flow | Tri-state renders correctly | Same | No regression |
| Phase B time-bound expiry copy | Renders renewal/expired states | Same | No regression |

### Test-side gate

Vitest, runs in CI:

- **`getChildComplianceStateForCategory` unit tests.** Per
  category, ≥4 cases (returns the right requirements, applicable
  count is right, aggregates are right, totals are right).
- **Drift detector tests.** For a set of fixture children + acks,
  assert the engine's `consents`-category output matches
  `pendingEnrollmentConsentsForChild`'s output for the same input.
  Both code paths must give the same verdict per row; any
  divergence fails the build.
- **Backward-compat smoke.** The 109 Phase 1 tests + the 1070
  existing tests all still pass.
- **Confirm-flow shape.** A small test for the parent intake
  confirm-flow path: given fixture acks, the bundle the engine
  surfaces matches what `requiredSubTypesForChild` would have
  returned. Locks Bug 2's fix.

### Real-data live check

The Jeff / klsnay / Dominique fixtures already exist in production
(Vanessa's account + the seeded fixtures from the consent-attachment
verification gate). Phase 2A merges only after a live check on the
preview deploy against ≥1 of these fixtures with both per-occurrence
acks present (to trigger Bugs 1 & 2's structural fix) AND only
durable acks present (to confirm no regression on the
durable-consents case).

Phase 2B merges only after a live check confirming the new section
renders correctly on a fixture with per-occurrence acks AND on a
fixture without (zero state).

---

## §10. Schema impact

**Confirmed: ZERO.**

- No new tables.
- No new columns.
- No new ACK_TYPES (the per-occurrence types already exist;
  registry rows for them already exist).
- No new RLS policies — the parent SELECT policy on
  `acknowledgments` already returns per-occurrence rows for the
  parent's linked children (migration 024).
- No new Edge Functions.
- No new dependencies.

If a schema change surfaces during build, **STOP and flag it**
— per the contract this is a pure refactor + additive UI pass.

---

## §11. Phasing within Phase 2

### Phase 2A — refactor + Bugs 1, 2

**Branch:** `feature/compliance-engine-phase-2a`

**Scope:**
- Add `getChildComplianceStateForCategory` to
  `src/lib/complianceState.js` + tests.
- Add drift-detector tests against
  `pendingEnrollmentConsentsForChild`.
- Refactor consumers 1, 2, 3, 4 (parent intake page, parent
  consents panel, parent acks tab wrapper, parent dashboard
  banner) to read from the engine.
- Bug 1 fixed (friendly labels for every requirement).
- Bug 2 fixed (per-occurrence excluded from intake bundle).

**Difficulty:** **M.** Mechanical refactor + one new pure helper
+ tests. 3-5 days.

**Verification:**
- Vitest green (1179 + new tests).
- Live before/after for Bugs 1 + 2 on preview.
- No regression on `/parent/intake-acknowledge`,
  `/parent/acknowledge` Consents tab,
  `EnrollmentConsentsPendingBanner`.

**Dependencies:** Phase 1 (shipped).

**Merge gate:** Bugs 1 + 2 demonstrably fixed; no regression on
correct surfaces; tests green.

### Phase 2B — new per-occurrence parent surface + Bug 3

**Branch:** `feature/compliance-engine-phase-2b`

**Scope:**
- New section on `ParentEnrollmentConsentsPanel.jsx` per §7
  (collapsed-by-default disclosure + count + most-recent-N list +
  attachments).
- Optionally, the medication permission row (per §6a Option A
  recommendation) — Seth's call whether to include in 2B.
- Bug 3 fixed (per-occurrence parent surface exists).

**Difficulty:** **M.** New UI surface; UX-heavy. 3-5 days.

**Verification:**
- Live before/after for Bug 3 on preview.
- Zero-row state renders correctly.
- ≥1-row state renders correctly (counts, dates, descriptions,
  channels, attachments).
- Attachment Edge Function works (the parent-mode
  `ConsentAttachmentSlot` is unchanged).

**Dependencies:** Phase 2A.

**Merge gate:** Bug 3 demonstrably fixed; no regression.

### Why split

Three reasons:
1. **Lower risk for the refactor.** 2A's blast radius is the four
   refactored consumers; 2B adds new UI on top. Splitting means a
   2A regression on a separate consumer doesn't get tangled with
   a 2B UI change.
2. **Smaller review surface.** Each PR is its own design review;
   2A is "refactor only," 2B is "new UX," each focused.
3. **Phased rollout.** 2A can ship to production once verified;
   2B follows when the UX shape is locked. Bug 3's fix is the
   one users notice; 2A's fixes (Bugs 1 + 2) are mostly invisible
   to users but high-value for audit hygiene.

---

## §12. Out of scope (explicitly deferred)

Named so they aren't quietly absorbed.

- **Provider-side consumer refactor.** Consumers 6-10 keep their
  current implementation. The engine's verdict matches theirs;
  refactoring carries risk for little gain. Optional future pass.
- **Phase 1 audit-state helper deletion.** `pendingEnrollmentConsentsForChild`,
  `getChildFilesAuditState`, etc. stay in place as thin facades.
  Eventually they become re-exports of the engine; not in Phase 2.
- **Medication parent-view per-medication surface** (vs. just the
  permission row). Showing the parent a list of every medication
  their child takes is a larger UX call; defer until a parent
  asks.
- **Per-occurrence parent renewal flow.** The parent surface in
  Phase 2B is read-only; the parent can't initiate a per-trip
  consent capture from the portal. The provider records before
  each trip; the parent sees it after. No parent-portal action.
- **Trips entity.** The future "trips" table (if/when it
  materializes) would feed the per-occurrence applicability —
  scoped doc-only in `pr-compliance-engine-scope.md` §14. Not
  Phase 2.
- **Auditor mode**, **score**, **checklist**. Phases 3-5 per the
  parent scope.
- **GSQ-relevance tagging projection.** Future GSQ widget; Phase
  2 doesn't touch it.
- **Provider-side compliance dashboard surface.** Future phase;
  per `docs/pr-compliance-engine-scope.md` §8 Phase 3.

---

## §13. Open questions for Seth

The two genuine design calls in this scope. Both have a
recommendation; both need Seth's read before the build.

1. **The parent-surface-per-category model (§6).** Does each
   category's verb + location match Seth's mental model? The
   recommendation is:
   - `child_files` (intake) → "Confirm these" — existing
     `/parent/intake-acknowledge` flow.
   - `consents` durable / time-bound → "On file / talk to your
     provider" — existing Consents tab.
   - `consents` per-occurrence → "Recorded — read-only history"
     — **new section, Phase 2B.**
   - `medication` permission → "On file / talk to your provider"
     — **new row on Consents tab, Phase 2B per §6a Option A.**
   - `attendance` → existing flow, unchanged.

2. **The per-occurrence parent surface UX (§7, Bug 3 fix).** The
   recommendation is **Option A: collapsed-by-default disclosure
   with count + most-recent-N expanded list.** Alternatives: B
   (always-visible) or C (separate tab). Seth react.

3. **Medication permission row in Phase 2B (§6a).** Include
   (recommended) or defer? The engine returns it for free; the
   parent already has RLS on the underlying acks.

---

## Halt for review — what CC needs from Seth before building

1. Approve / modify the §6 per-category model.
2. Pick the §7 layout option (A / B / C / other).
3. Pick §6a Option A (include medication permission row in 2B)
   or defer.

After Seth reacts, the build PR follows. Phase 2A is the immediate
next branch; Phase 2B comes after 2A merges and verifies.

Status: **DRAFT for review.**

---

**End of compliance-engine Phase 2 scope — DRAFT.** No code, no
migration, no commit, no branch. Untracked. Halting for review.
