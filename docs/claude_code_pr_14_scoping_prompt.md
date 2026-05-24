# Claude Code Prompt — PR #14 Scoping (License-Type Foundation)

**Paste this entire document into Claude Code as a single prompt.** This is a **scoping pass only** — investigation + plan + open questions, then halt. No code changes, no branches.

---

## Context

The product targets Michigan Family Child Care Homes, Group Child Care Homes, and License-Exempt Providers (LEPs). A new set of Michigan Administrative Code rules (R 400.1901–1951, adopted 2026-04-27) require licensed homes to be in compliance by approximately late July 2026.

A compliance audit was completed on 2026-05-23 and is at `docs/licensed-home-compliance-audit-2026-05-23.md`. Decisions in response to the audit's open questions are in `docs/licensed-home-compliance-decisions-2026-05-23.md`. The R 400.xxxx mapping is in `docs/regulatory-rule-mapping.md`.

**PR #14 is the license-type foundation.** It blocks PRs #15–#21 (the six compliance categories plus the reminder system). The audit identified that three license-related signals already exist in the codebase (`is_license_exempt`, `provider_type`, `michigan_license_number`) but none of them is wired to gate compliance modules, and `provider_type` is framed as a CDC-billing concept rather than a compliance source of truth.

**The decision recorded in `licensed-home-compliance-decisions-2026-05-23.md` § OQ3:**

> New `license_type` ENUM as compliance source of truth. Derive from existing signals, flag ambiguous rows for human review. Update `modules.js` to gate on it. Update `LicenseStatusPromptModal` from binary to ternary. Add editor to `BusinessInfoPage`.

## What I want you to do

**Scoping only — no code changes.** Produce a detailed implementation plan that I will use as the spec for a follow-on implementation pass. After producing the plan, halt with a summary of open questions and any unexpected findings.

Read the relevant existing code in depth. Produce a written scoping doc at `docs/pr-14-license-type-foundation-scope.md`.

### Step 1 — Read context

1. `docs/licensed-home-compliance-audit-2026-05-23.md` (§ License type field on provider profile is the most relevant section)
2. `docs/licensed-home-compliance-decisions-2026-05-23.md` (§ OQ3 and the updated PR sequence)
3. `docs/regulatory-rule-mapping.md` (for R 400.xxxx citation style)
4. `CLAUDE.md` (operating conventions — never-hard-delete, schema-app-code audit pairing, table-name availability check, etc.)
5. `docs/tech_debt.md` (especially the schema-debt and license-status-null sections)

### Step 2 — Deep-dive the existing license signals

For each of these three existing fields, document:

- File path and migration where it was introduced
- Type, nullability, default
- Where it's read in `src/` and `api/` (every reference)
- Where it's written
- What product behavior depends on it
- Known quirks (e.g., "frequently null" per tech debt)

The three fields:
- `profiles.is_license_exempt` (migration 004)
- `profiles.provider_type` (migration 018)
- `profiles.michigan_license_number` (migration 004)

Also document:
- `MODULE_KEYS.LICENSED_COMPLIANCE` and `MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE` in `src/lib/modules.js` — what they currently gate (likely nothing meaningful per audit)
- `src/lib/licenseStatusPrompt.js` — the existing prompt logic
- `src/components/.../LicenseStatusPromptModal.jsx` — the binary capture UI
- `src/pages/BusinessInfoPage.jsx` — where the user edits profile fields today
- Any program_settings reference to `licensed_compliance` / `license_exempt_compliance`

### Step 3 — Draft the implementation plan

The scoping doc should propose a concrete implementation, broken into ordered work items. Cover at minimum:

**A. Migration design**

- New column on `profiles`: `license_type` ENUM
- ENUM values: `'family_home'`, `'group_home'`, `'license_exempt'`
- Nullability decision (recommend: nullable, with backfill setting non-null where derivable)
- Default decision (recommend: no default — explicit set required)
- Backfill SQL that derives from existing signals per the decisions doc:
  - `provider_type = 'licensed_family'` → `'family_home'`
  - `provider_type = 'licensed_group'` → `'group_home'`
  - `provider_type = 'licensed_center'` → leave null + flag (out of scope for milittlecare)
  - `is_license_exempt = true` AND no licensed `provider_type` → `'license_exempt'`
  - All other rows → leave null + flag for review
- How "flag for review" surfaces — recommend a `license_type_review_needed` boolean column, OR a derived flag in the UI when `license_type IS NULL`
- Migration table-name availability check per CLAUDE.md (`license_type` ENUM may collide with existing types — verify)
- Index decisions if any

**B. App-code audit per the schema-altering-migrations-paired-with-an-app-code-audit convention**

- Every place that reads `is_license_exempt` (grep the codebase)
- Every place that reads `provider_type` (grep the codebase)
- For each: does it need to change to read `license_type` instead? Or keep reading the original signal? Document the decision per call site.

**C. modules.js wiring**

- Current state of `MODULE_KEYS.LICENSED_COMPLIANCE` and `MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE` gates
- Proposed new state: gates read `license_type` instead of (or in addition to) `is_license_exempt`
- All call sites of `getActiveModules` / `useActiveModules` — what changes downstream
- How the compliance categories (A-F, shipping in PR #16-#21) will key off `license_type` — propose the pattern

**D. LicenseStatusPromptModal extension**

- Current UI: binary (exempt yes/no)
- New UI: ternary (family home / group home / license exempt)
- When the modal fires (today: after first CDC scholarship funding source created)
- Whether the modal should ALSO fire for license-type review (when `license_type` is null AND the user is not new)
- Copy/microcopy proposal

**E. BusinessInfoPage editor**

- Current state of BusinessInfoPage profile editing
- Where to add the license-type editor
- Validation rules (can you change family→group? group→license_exempt? what about the reverse?)
- Whether changing license type triggers any cleanup (e.g., archiving compliance records that no longer apply)

**F. Provider-type relationship**

- The decision is: `license_type` becomes compliance source of truth, `provider_type` keeps its CDC-billing meaning
- Document explicitly in code comments and migration headers
- Are there places that today read `provider_type` for compliance purposes? Those need to switch
- Are there places that today read `is_license_exempt` for compliance purposes? Those need to switch

**G. Test plan**

- Migration tests: backfill produces expected results on representative data
- App tests: modules.js correctly gates on `license_type`
- UI tests: LicenseStatusPromptModal renders the ternary picker
- Smoke test: a license_exempt provider sees no compliance modules; a family_home provider sees them; etc.

**H. Rollout plan**

- Migration applies cleanly to production
- App code deploys after migration is applied
- Backfill review process: a query/dashboard to identify rows where license_type is null after backfill (for human review)
- Communication to Venessa: "your license_type is now group_home; please confirm"

### Step 4 — Open questions and unexpected findings

After producing the plan, summarize:

- Decisions that need owner input before implementation
- Unexpected findings about the existing code (e.g., "provider_type is set in 14 places, most of which are CDC billing — only 2 reads need to change")
- Schema-debt concerns specific to this PR
- Test data needs

### Step 5 — Halt

Do not propose code changes beyond what's in the scoping doc. Do not create branches. Do not run migrations. After saving the scoping doc, halt with:

1. The path to the scoping doc
2. A 5-bullet executive summary
3. The 3-5 most important open questions for me to answer before implementation

## Operating rules

- Read the audit doc and decisions doc first — they're the source of truth for what's been decided. Don't re-decide things that are already decided.
- Cite real file paths and line numbers where possible.
- Use the R 400.xxxx citation style (per `docs/regulatory-rule-mapping.md`) in migration headers and comments.
- If you find that an existing signal is more correct than what the decision implies (e.g., `provider_type` is actually fine to repurpose), flag it as a concern rather than overriding the decision.
- Don't invent fields or table names — verify against actual schema.
- Where the rule text matters for a specific column, cite the rule number (e.g., "Rule 7 / R 400.1907").
- Halt cleanly with a summary. No code changes.

When finished, the deliverable is the scoping doc + your 5-bullet summary + 3-5 open questions.
