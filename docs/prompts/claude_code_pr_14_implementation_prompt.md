# Claude Code Prompt — PR #14 Implementation (License-Type Foundation)

**Paste this entire document into Claude Code as a single prompt.** This is the implementation pass for PR #14 (License-Type Foundation). The scoping doc at `docs/pr-14-license-type-foundation-scope.md` is the spec; you implement it.

---

## Context

PR #14 is the license-type foundation that blocks PRs #15–#21 (the opt-in reminder system and the six compliance categories). Scoping is complete and committed to `docs/pr-14-license-type-foundation-scope.md`.

**Pre-decided design** (do not re-litigate these):

From `docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ3:
- New `profiles.license_type` ENUM with values `'family_home'`, `'group_home'`, `'license_exempt'`
- Backfill from existing signals, flag ambiguous rows for human review
- Update `modules.js` to gate compliance modules on `license_type` not `is_license_exempt`
- Update `LicenseStatusPromptModal` from binary to ternary
- Add editor to `BusinessInfoPage`

**Owner decisions on the four open questions from your scoping pass (2026-05-24):**

1. **ENUM vs text+CHECK:** Use your judgment based on best practice. The decisions doc said ENUM, but you noted `provider_type` is text+CHECK for column-shape parity. Pick whichever is technically better; document the rationale in the migration header.

2. **Onboarding wizard scope:** **Expand the wizard ternary in this PR.** New providers go through the ternary picker from day one. Touches the reducer, QuestionScreen, and wizard specs. Owner accepts the larger scope.

3. **Compliance categories apply to LEPs:** **No.** LEPs see no compliance UI. The `MODULE_KEYS.LICENSED_COMPLIANCE` gate must check `license_type IN ('family_home', 'group_home')` and explicitly exclude `'license_exempt'`. The `MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE` gate keys on `license_type = 'license_exempt'` if it stays.

4. **`michigan_license_number` as LICENSED_COMPLIANCE trigger:** **Drop it.** `license_type` is authoritative. Remove the field from the LICENSED_COMPLIANCE gate logic. Don't delete the column — it's still useful as a record-keeping field — just stop using it as a compliance trigger.

## What I want you to do

Implement PR #14 per the scoping doc. Branch off main. Single PR with all the work.

### Branch and commits

- Branch: `feature/pr-14-license-type-foundation` off main
- Commit structure: as many discrete commits as needed for clean history (e.g., migration + backfill + modules.js + capture UI + tests can be separate commits, OR one commit if it reads cleanly)
- Each commit message should reference the PR (e.g., `PR #14: add license_type column + backfill`)

### Implementation work

Implement everything covered by the scoping doc. At minimum:

**1. Migration**
- New column `profiles.license_type` per OQ1 (your choice of ENUM vs text+CHECK; document rationale)
- New column `profiles.license_type_review_needed` boolean (per the scoping doc's recommendation for surfacing ambiguous backfill rows)
- Transactional backfill with row-count SELECT (per the scoping doc's house convention)
- Migration header cites R 400.1925 (capacity / licensing scope) per the regulatory mapping
- Migration number: coordinate with PR #13's migration. If PR #13 hasn't shipped yet, document the order explicitly

**2. App-code wiring**
- Mirror `license_type` ↔ `is_license_exempt` at all three write sites:
  - `LicenseStatusPromptModal` (binary → ternary)
  - `BusinessInfoPage` Licensing tab (relabel section, add ternary editor)
  - Onboarding wizard (expand `license_status` question to ternary)
- Keep `is_license_exempt` derived for backward compat — every existing reader keeps working
- Update `modules.js`:
  - `MODULE_KEYS.LICENSED_COMPLIANCE` gates on `license_type IN ('family_home', 'group_home')`
  - `MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE` gates on `license_type = 'license_exempt'`
  - Remove `michigan_license_number` from the LICENSED_COMPLIANCE trigger
- Update `LicenseStatusPromptModal` re-prompt logic to fire when `license_type IS NULL OR license_type_review_needed = true`

**3. Capture UIs**
- `LicenseStatusPromptModal`: 3-option picker (Family Home / Group Home / License Exempt). Friendly microcopy explaining each. On submit, writes `license_type` AND derives `is_license_exempt`. Clears `license_type_review_needed = false`.
- `BusinessInfoPage`: fix the existing "Provider Type" mislabel; add license_type editor; same write logic as the modal
- Onboarding wizard: expand the existing license question from binary to ternary. Update reducer, QuestionScreen, and wizard spec. Match modal microcopy.

**4. Review-needed surfacing**
- When `license_type_review_needed = true` OR `license_type IS NULL`, the LicenseStatusPromptModal re-fires on next dashboard load
- A non-dismissible info banner appears on dashboard until set
- Document the "review needed" query for backfill verification in the migration or a `docs/runbook-...` doc

**5. Tests**
- Migration test: backfill produces expected results on representative profile rows
- App test: modules.js correctly gates on `license_type`; LEPs see no compliance UI; family/group homes do
- Component test: LicenseStatusPromptModal renders 3 options; writes propagate to both `license_type` and `is_license_exempt`
- Smoke test: a license_exempt provider sees no LICENSED_COMPLIANCE modules; family_home provider sees them; null/review_needed provider sees the re-prompt banner

**6. Documentation**
- Update `docs/architecture.md` if license-type is mentioned there
- Add an entry to `docs/tech_debt.md` documenting that `is_license_exempt` is now derived from `license_type` (the inverse-relationship constraint should be enforced via app code; long-term DB-level constraint is future work)
- Note in the scoping doc itself that it's now implemented (one-line append: "Implemented in PR #14, merged YYYY-MM-DD")

### Operating rules

- Read the scoping doc first — it has the implementation plan; don't re-decide what's there
- Follow the house schema-altering-migration-paired-with-app-code-grep convention (CLAUDE.md)
- Backfill must be idempotent and re-runnable
- Don't delete `is_license_exempt` or `michigan_license_number` — both stay as legacy columns
- Don't touch `provider_type` — it stays as the CDC-billing concept it is
- Cite `R 400.xxxx` in migration headers and code comments per `docs/regulatory-rule-mapping.md`
- Don't merge to main yourself — halt with the branch pushed and tell me what's ready to review
- If you hit anything unexpected during implementation that diverges from the scoping doc, halt and ask before proceeding

### Verification before halt

Before you halt:

- `npm run build` clean
- `npx vitest run` all tests pass
- Migration applies cleanly to a fresh local Supabase if possible (or document the test command that would do so)
- App-code grep audit: confirm no `is_license_exempt` reader is broken, no `provider_type` reader is broken, no `michigan_license_number` reader is broken

### Halt with

1. Branch name + final commit SHA
2. Files changed (high-level)
3. Test pass count
4. The "review needed" query for backfill verification
5. Anything that diverged from the scoping doc and why
6. Any new tech_debt entries added

I'll merge after reviewing.

---

## Reminder on the order of operations for PR #13 and #14

PR #13 (`children.archived_at`) was decided to ship first, but you may begin PR #14 in parallel as long as both can land sequentially. If PR #13 hasn't shipped yet when you start, coordinate the migration numbers: PR #13 should be migration 021 and PR #14 should be migration 022. If PR #13 has already shipped, PR #14 becomes 021. Check `supabase/migrations/` to determine the right number at start.
