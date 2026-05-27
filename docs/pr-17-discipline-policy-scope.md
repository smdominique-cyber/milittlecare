# PR #17 — Discipline Policy (Rule 42): Implementation Scope (2026-05-26)

**Scoping pass only. No code was changed, no branch created, no migration
run.** Open questions resolved 2026-05-26 review; doc reads as
authoritative. **Production introspection of `business_policies` is
complete** (per OQ7 / decisions doc): the table has ~22 columns
including `late_fee_*`, `late_pickup_fee_*`, `payment_methods jsonb`,
`emergency_procedures text`, `policies_set boolean`; **no existing
`discipline_policy_*` column**. **Path A** is committed (add columns to
`business_policies`); Path B is no longer under consideration.

**Source decisions** (from
`docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ7 + Updated
PR sequence): PR #17 stores the licensee's written discipline policy and
captures **two** acknowledgments — parents at child intake (extends
PR #16's intake bundle) and staff at hire (a new caregiver-side
acknowledgment).

**Rule citations:**
- **R 400.1942 (Rule 42) — Discipline.** Requires a written discipline
  policy. The rule lists prohibited methods (physical, verbal,
  humiliation, deprivation of food/sleep, restraint that interferes with
  breathing, isolation in a closed room, mechanical restraints) and time-
  out restrictions (only over age 3, max 1 minute per year of age,
  supervised). Positive guidance is required.
- **R 400.1907 (Rule 7) — Child's record.** The child-in-care statement
  must include the parent's acknowledgment of receipt of the discipline
  policy. PR #16 introduces the `acknowledgments` table; PR #17 is the
  first consumer beyond the Rule 7 bundle itself.
- **R 400.1906 (Rule 6) — Child care home records.** Personnel records
  must show acknowledgment that policies were read. PR #8 (staff
  training) covers training records; PR #17 adds discipline-policy
  acknowledgment at hire.

---

## 0. Headline findings (drive the whole plan)

1. **Production introspection of `business_policies` is the load-bearing
   pre-condition.** Per OQ7, **the PR cannot be authored until the live
   column list of `business_policies` is captured from the dashboard.**
   The table is referenced from `Sidebar.jsx` for `messaging_enabled`,
   `BusinessInfoPage.jsx` for the policies sub-section, and `notify-state-change.js`
   for the email-notification flow, but its **full column list is not in
   any migration file** (it's part of the out-of-band schema from
   `docs/tech_debt.md` § "Migrations folder is out of sync"). This scope
   doc assumes a representative shape and flags the introspection step
   as a § Pre-implementation gate.

2. **Two acknowledgments, one policy.** The discipline policy itself is
   provider-level (one per home). The acknowledgments are per-parent
   (one per child intake) and per-caregiver (one per hire). PR #16's
   `acknowledgments` table absorbs both with different `type` and
   `subject_type` values.

3. **Versioning matters here, more than for Rule 7 disclosures.**
   Discipline policy can be **updated** over a license cycle. When
   updated, all previous acknowledgments are effectively stale — the new
   text was not what they signed. PR #17 stores a `version` integer on
   the policy and writes it into each acknowledgment's `snapshot_version`
   (per PR #16's schema). Stale acknowledgments surface a re-acknowledge
   prompt on the family card and a re-ack reminder for staff hires.

4. **Hire-time acknowledgment leverages PR #8.** `caregivers.date_of_hire`
   exists (migration 012). PR #17 adds an
   `acknowledgments` row with `type = 'staff_discipline_policy_receipt'`
   and `subject_type = 'caregiver'`, `subject_id = caregivers.id`. The
   staff-training page (`/staff-training`, PR #8) gets a new column /
   indicator for discipline-policy receipt status.

5. **MiLEAP-precise copy is required** (constraint G). The discipline
   policy template must use exact rule language for prohibited methods
   ("corporal punishment", "physical force", "verbal abuse",
   "deprivation of meals or snacks", "restraint that prevents breathing"
   — these are MiLEAP phrasings). The product ships a starter template
   the provider can edit; the editor includes a "verify required clauses"
   linter that flags missing required disclaimers.

---

## Step 2 — Inventory of what exists

### `business_policies` (production-only)

**Unknown full shape.** Confirmed columns from app reads:
- `user_id` (provider id)
- `messaging_enabled` (boolean, Sidebar gate)
- Various policy/text fields used by `BusinessInfoPage` (the section
  rendered for "Payment & Fees", "Emergency Info" — names not enumerated
  in the codebase, only their read sites)

**Production introspection (completed 2026-05-26 review):**

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='business_policies'
order by ordinal_position;
```

Result: ~22 columns including `late_fee_*`, `late_pickup_fee_*`,
`payment_methods jsonb`, `emergency_procedures text`,
`policies_set boolean`. **No `discipline_policy_*` column exists.** PR
#17 adds three columns to this table — see § A.1.

### Acknowledgments substrate (from PR #16)

- `public.acknowledgments` table with `(type, subject_type, subject_id)`
  shape and `snapshot_version` column — directly consumed.
- PR #16 introduces the `discipline_policy_receipt` type (parent side, at
  intake).
- PR #17 adds the `staff_discipline_policy_receipt` type (caregiver
  side, at hire).

### Caregivers + staff training (from PR #8)

- `caregivers` table with `date_of_hire` (anchor for the
  "at hire" acknowledgment requirement).
- Staff training page `/staff-training` with the `StaffComplianceMatrix`
  surface. PR #17 adds a column (discipline policy receipt status) to
  this matrix.

### Audit-doc reference

`docs/licensed-home-compliance-audit-2026-05-23.md` § Category C
identified the gaps; this scope doc inherits the audit's analysis. The
audit also recommended **not overloading** `attendance_acknowledgments` —
PR #16 acted on that recommendation; PR #17 just uses the resulting
general table.

---

## Step 3 — Implementation plan

### A. Migration design

**Migration 025** (post-PR-16's 024).

#### A.1 Discipline policy storage (Path A — column on `business_policies`)

Per the 2026-05-26 introspection result: no naming conflict, the
provider-level fit is clean. Three columns added:

```sql
alter table public.business_policies
  add column if not exists discipline_policy_text text,
  add column if not exists discipline_policy_version integer not null default 1,
  add column if not exists discipline_policy_updated_at timestamptz;
```

Path B (a separate `discipline_policies` table) was considered and
dismissed — the existing `business_policies` row is the right home for
provider-level configuration, and a parallel table would fragment
queries. This decision is final; rollout (§ G) and migration (§ A)
assume Path A throughout.

#### A.2 `acknowledgments` consumption

No schema changes. PR #16 already created the table. New `type` values
used in this PR:
- `discipline_policy_receipt` — already enumerated in PR #16's intake
  bundle (parent side).
- `staff_discipline_policy_receipt` — NEW type (staff side); `subject_type
  = 'caregiver'`, `subject_id = caregivers.id`.

`snapshot_version` is set to the policy's `discipline_policy_version`
string at the time of acknowledgment.

#### A.3 Re-acknowledgment trigger

When the provider updates the policy text (versioned via the editor —
manual bump or auto-increment, see § B.1), every existing
`acknowledgments` row of type `discipline_policy_receipt` or
`staff_discipline_policy_receipt` whose `snapshot_version` differs from
the new version is marked **stale** (UI concept; not a column — derived
at read time by comparing `snapshot_version` to the current policy
version).

### B. App-code structure

#### B.1 Discipline policy editor (`src/pages/DisciplinePolicyPage.jsx`, new dedicated route)

Per OQ3 resolution: a **dedicated `/discipline-policy` route** under the
Compliance section of the sidebar (gated on `LICENSED_COMPLIANCE`).
Distinct surface — the version-bump UX is too prominent for a
BusinessInfoPage sub-section. Includes:

- A starter template populated from a `src/lib/disciplinePolicyTemplate.js`
  static string (the MiLEAP-language clauses).
- A textarea editor with **autosave** for typo-level edits (writes to
  `discipline_policy_text` and `discipline_policy_updated_at`; does NOT
  bump `discipline_policy_version`).
- A **"verify required clauses" linter** — pure function in
  `src/lib/disciplinePolicy.js` that scans the text for required
  phrases and reports missing clauses. Per OQ4: **warn-only, never
  blocks save.** See § E.
- A separate **"Save as new version"** button distinct from autosave
  (per OQ2 resolution):
  - **Confirmation modal** before the bump, explicitly listing the
    cascade ("Saving as a new version will mark N family
    acknowledgments and M staff acknowledgments stale. Parents and
    caregivers will need to re-acknowledge the new policy.")
  - On confirm: increments `discipline_policy_version`, updates text +
    `discipline_policy_updated_at`, returns to the policy view
    rendering a "Stale acknowledgments: N families, M staff" banner
    with a CTA to launch re-collection.

#### B.2 Parent-intake consumer

No new code in PR #17 — PR #16's intake bundle already writes a
`discipline_policy_receipt` ack row with `snapshot_version` set. The
linter in `src/lib/acknowledgments.js#getChildFileCompleteness`
returns "intake incomplete" when the stored version differs from the
current policy version, prompting the provider to re-collect.

#### B.3 Staff-hire consumer (`src/pages/StaffTrainingPage.jsx` extension)

Add a column to `StaffComplianceMatrix` for discipline-policy receipt
status, and a button to capture (mirrors the caregiver self-ack pattern
or licensee-override pattern). When a new `caregivers` row is created,
the UI surfaces a "needs discipline policy ack" indicator until an
acknowledgment row exists.

#### B.4 Stale-acknowledgment surface

A pure helper `getStaleAcknowledgments(currentVersion, acks)` that
returns the subset where `snapshot_version !== currentVersion`. The
discipline-policy editor and the dashboard surface this count and a CTA
(in licensed-home compliance mode).

#### B.4a Stale-ack remediation channels

Per OQ5 resolution: **same channels as the initial acknowledgment.**
- Parent stale acks: provider can re-collect via paper / in-person
  (`acknowledged_via = 'in_person_paper'` or `provider_override`) OR
  re-trigger parent-portal collection via PR #16's portal extension
  (`acknowledged_via = 'parent_portal'`).
- Staff stale acks: licensee captures on behalf
  (`acknowledged_via = 'provider_override'` with a noted reason) OR the
  caregiver acknowledges via their own app-user session if applicable.
The product surfaces the staleness; the provider chooses the channel.

#### B.4b Audit-state helper (`getDisciplinePolicyAuditState(licenseeId)`, new — cross-cutting requirement)

Per the audit-state mandate, PR #17 exposes a pure helper in
`src/lib/disciplinePolicy.js`:

```js
export async function getDisciplinePolicyAuditState(licenseeId) {
  return {
    domain: 'discipline_policy',
    type: 'type_2',                          // MILittleCare-owned.
    has_policy_text: false,                  // discipline_policy_text IS NOT NULL/empty
    current_version: 0,                      // discipline_policy_version
    parent_acks_current_count: 0,            // count where snapshot_version === current_version
    parent_acks_stale_count: 0,
    staff_acks_current_count: 0,
    staff_acks_stale_count: 0,
    new_hires_without_ack_count: 0,          // caregivers with date_of_hire
                                              // AND no active staff_discipline_policy_receipt
  }
}
```

Consumed by future PR #22 (Compliance Health Score). Read-only.

#### B.5 Required-clause linter (`src/lib/disciplinePolicy.js`)

```js
export const REQUIRED_CLAUSE_PATTERNS = Object.freeze([
  { id: 'prohibits_corporal_punishment',
    pattern: /no\s+corporal\s+punishment/i,
    label: 'Prohibits corporal punishment (R 400.1942)' },
  { id: 'prohibits_verbal_abuse',
    pattern: /verbal\s+abuse/i,
    label: 'Prohibits verbal abuse / humiliation' },
  { id: 'prohibits_food_deprivation',
    pattern: /deprivation\s+of\s+(food|meal)/i,
    label: 'Prohibits deprivation of food/meals' },
  { id: 'time_out_rule',
    pattern: /time[\-\s]*out/i,
    label: 'Addresses time-out (max 1 min/year of age, age 3+)' },
  { id: 'positive_guidance',
    pattern: /positive\s+(guidance|reinforcement|discipline)/i,
    label: 'Includes a positive guidance statement' },
])

export function lintDisciplinePolicy(text) {
  // Returns array of { id, label, present } for each required clause.
}
```

The linter is **advisory, not blocking** — the provider can ship policy
text without every clause and may have phrased a clause differently. The
UI shows the result as guidance, not a gate.

### C. UI surfaces

- **Discipline policy editor.** New surface — textarea + starter
  template + clause linter + version history (read-only list of
  prior versions if Path B; if Path A, the current row is the only
  version on disk and history is implicit). Save bumps version. Stale
  banner appears post-save.
- **Family card / intake form.** Re-acknowledge button when the stored
  parent ack version is behind the current policy version.
- **Staff training matrix.** New "Discipline policy" column with
  per-caregiver status badge.
- **Sidebar.** "Discipline policy" nav entry under Compliance (gated on
  `LICENSED_COMPLIANCE`).
- **Reminder integration (PR #15).** New reminder category
  `staff_discipline_policy_ack_pending` — fires when a caregiver with
  `date_of_hire > N days ago` has no policy ack yet (default lead time:
  on hire date itself).

### D. Module gating

The discipline-policy surface, the parent re-acknowledgment prompt, and
the staff matrix column gate on `MODULE_KEYS.LICENSED_COMPLIANCE`
(license_type IN family/group home). LEPs see nothing.

### E. Tests

- **Pure unit (`disciplinePolicy.test.js`):** `lintDisciplinePolicy` —
  the five required clauses for a fully-compliant text, the empty
  string (all missing), a partial text (some present).
- **Pure unit (`acknowledgments.test.js` extension):** stale-version
  detection for two versions of the same policy.
- **Migration test:** Path A — column exists post-apply; Path B — table
  exists with unique-active constraint.
- **Smoke (manual):** create policy v1, capture parent ack at intake,
  bump to v2, observe the family card showing stale-ack pill.
- RTL render tests deferred per house convention.

### F. Documentation

- `docs/runbook.md` — migration 025 entry template, **flagged as
  "post-introspection commit"**.
- `docs/tech_debt.md` — once introspection happens, capture the
  `business_policies` shape there if it wasn't already documented.
- `CLAUDE.md` — append to § Critical Domain Knowledge: "Discipline policy
  is provider-level + versioned. Parent and staff acknowledgments
  record the policy version they consented to; bumping the version
  flags all prior acknowledgments stale."

### G. Rollout

1. Apply migration 025 (three column adds on `business_policies` per
   Path A); verify column shape per dashboard screenshot. Introspection
   already done at scoping time — no re-introspection required.
2. Deploy app; the dedicated `/discipline-policy` editor is live; the
   existing policy text is empty (provider must compose). Existing
   children show "discipline ack missing" until the parent acks
   policy v1.
3. **Communicate to Venessa:** "Compose your discipline policy in
   Compliance → Discipline Policy; we'll prompt for parent and staff
   acknowledgments when you save the first version."

---

## Step 4 — Open questions (RESOLVED 2026-05-26 review)

1. **Path A vs Path B (column on `business_policies` vs new table)?**
   **RESOLVED — Path A.** Production introspection confirmed
   `business_policies` has ~22 columns and no `discipline_policy_*`
   column; the table is the right home. Three columns added per § A.1.

2. **Version bumping — manual or automatic on every save?** **RESOLVED
   — manual** via a "Save as new version" button distinct from
   autosave. **Confirmation modal** before the bump, spelling out the
   stale-ack cascade. Autosave handles typo-level edits without bumping.

3. **Where does the discipline policy editor live in the IA?**
   **RESOLVED — dedicated `/discipline-policy` route** under the
   Compliance sidebar nav (gated on `LICENSED_COMPLIANCE`). Not a
   sub-section of BusinessInfoPage. See § B.1.

4. **Required-clause linter — block save or warn-only?** **RESOLVED —
   warn-only, never blocks save.** Rule language varies; the provider
   may phrase clauses differently. Linter is guidance.

5. **Stale-ack remediation channels?** **RESOLVED — same channels as
   the initial acknowledgment.** Parent stale acks → paper / in-person
   / provider-override OR parent portal (via PR #16). Staff stale acks
   → provider-override OR caregiver self-ack. See § B.4a.

---

## Step 5 — Effort estimate

**M.** Modest schema change (three columns on `business_policies` per
Path A — already confirmed by 2026-05-26 production introspection), a
new dedicated editor surface with a versioning workflow and confirmation
modal, two acknowledgment-table extensions of an existing pattern
(PR #16's table), starter template + warn-only linter, plus the
audit-state helper. No remaining unknowns from the introspection gate.

---

## Step 6 — Out of scope (future PRs)

- **Multi-version history table** — V1 keeps only the current text on
  `business_policies` (Path A). A full audit trail of every prior
  version is a future move if compliance audits demand it.
- **Linter that proves rule compliance** (vs the warn-only heuristic) —
  a heavier NLP / structured-policy editor. Future move.
- **Block-billing on missing acknowledgments** — analogous to PR #9's
  Rule 8 strict mode. Out of scope; not required by Rule 42.
- **Parent / staff training materials** — the rule does not require a
  training video; this PR ships text policy only.

---

## Step 7 — Dependencies on prior PRs

- **PR #16 (acknowledgments table) — HARD DEPENDENCY.** PR #17 has no
  table of its own for the acknowledgments; it only adds new `type`
  values and a stale-detection helper.
- **PR #14 (license_type) — REQUIRED.** All UI surfaces gate on it.
- **PR #15 (reminders) — REQUIRED.** PR #15's catalog includes
  `staff_discipline_policy_ack_pending`; this PR contributes that
  category and consumes it for the matrix indicator + email
  notification when a hire has no policy ack on file.
- **PR #8 (staff training tracking) — REQUIRED.** Provides the
  `caregivers` table that the staff-side acknowledgment binds to.

---

## Files read for this scope

`docs/strategy.md`, `docs/backlog.md`,
`docs/licensed-home-compliance-decisions-2026-05-23.md`,
`docs/regulatory-rule-mapping.md`, `CLAUDE.md`, `docs/tech_debt.md`,
`docs/licensed-home-compliance-audit-2026-05-23.md`,
`docs/pr-14-license-type-foundation-scope.md` (format template),
`docs/pr-16-child-files-scope.md` (sibling — provides the acknowledgments
table this PR consumes);
`supabase/migrations/012_staff_training.sql` (caregivers + date_of_hire);
`src/pages/BusinessInfoPage.jsx` (existing policies sections),
`src/components/dashboard/Sidebar.jsx` (Compliance nav structure),
`src/pages/StaffTrainingPage.jsx` (extension surface).

*No source files modified. No migrations run. No branch other than
`docs/pr-15-21-scoping`.*
