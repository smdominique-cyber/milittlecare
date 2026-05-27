# Claude Code Prompt — PR #13 (children.archived_at + Soft-Delete Audit)

**Paste this entire document into Claude Code as a single prompt.** This is a small implementation pass. Scoping is minimal because the change is contained.

---

## Context

The `children` table lacks an `archived_at` column. This violates two things at once:

1. **`CLAUDE.md`'s never-hard-delete convention** for audit records — `children` is an audit-relevant table (attendance records, billing records, and parent acknowledgements all reference it).
2. **Rule 7 (R 400.1907) retention requirement** — Michigan licensing requires child records to be retained for a minimum of 2 years after the date the child is no longer being cared for. Without `archived_at`, there's no soft-delete path; today the only options are "keep forever" or "hard-delete with referential damage."

This was identified in the licensed-home compliance audit (`docs/licensed-home-compliance-audit-2026-05-23.md` § Open Questions, OQ #6) and accepted by the owner as a standalone schema-hygiene PR that ships **before** PR #16 (Child file completeness) — see `docs/licensed-home-compliance-decisions-2026-05-23.md` § OQ6.

The pattern is already established elsewhere in the codebase:
- `caregivers.archived_at` (migration 012)
- `funding_sources.archived_at` (referenced throughout)
- `attendance_acknowledgments.archived_at` (migration 020)
- `funding_documents.archived_at` (migration 008)

This PR follows that pattern exactly.

## What I want you to do

Implement PR #13 as a single focused change. Branch off main. Single PR, can be one commit or split if it reads cleaner.

### Scope

**1. Migration**

- Add `archived_at timestamptz NULL` to `public.children` (per the pattern used elsewhere)
- No backfill needed — all existing rows leave `archived_at` as null, which means "active"
- Migration header cites `R 400.1907` (child records, 2-year retention)
- Migration number: next available in the sequence (likely 021)
- Coordinate with PR #14 (license-type foundation) which is queued — this PR's migration ships first

**2. App-code grep audit per the schema-altering-migration-paired-with-app-code-grep convention**

Find every place that queries the `children` table. For each:
- If it's a "show active children" surface (Families page, Today widget, attendance entry, child picker, anywhere a list of currently-enrolled children is rendered): **add `archived_at IS NULL` to the WHERE clause**
- If it's an audit/history/billing surface that might need to show archived children (I-Billing, audit packets, historical attendance reports, retention queries): **explicitly include archived rows** but make sure the UI distinguishes active vs archived if relevant
- If it's a unique-constraint or referential-integrity check: **decide per-case** whether archived should count or not

The grep should cover:
- `src/` and `api/` (all queries)
- SQL functions and views (search `public.children` and child_id joins)
- Anywhere a child name is rendered (because rendering an archived child without indicating archived is a UX bug)

Document every call site decision inline as a comment OR in the PR description so it's clear what's intentional.

**3. RLS policies on `children` (review only, change if needed)**

Look at the existing RLS policies on the `children` table. If they accidentally leak archived rows, adjust. If they're already correct (`user_id = auth.uid()` based, agnostic to `archived_at`), leave them.

**4. Indexes**

Consider whether a partial index on `WHERE archived_at IS NULL` would help. Most queries will filter for active children, so this could be useful. Decision: add the index unless table size is small enough that it's not worth it (currently small — but plan ahead).

**5. Soft-delete UI surface**

Add an "archive child" action somewhere in the family modal (Children tab). The pattern from caregiver/funding-source archival is the model:
- An archive button on the child detail card
- Confirmation modal explaining "archived children are retained for compliance but no longer appear in active lists"
- Writes `archived_at = NOW()`
- Hides the child from active lists after archive
- Provides a way to view archived children (toggle: "show archived")
- Provides an "unarchive" action that clears `archived_at`

**6. Tests**

- Migration test: column exists with expected nullability
- App test: queries with `archived_at IS NULL` filter exclude archived children
- Component test: archived child UI surfaces work (archive, unarchive, show-archived toggle)
- Smoke test: archiving a child preserves attendance records, billing records, and acknowledgement records (they still reference the now-archived child_id without breaking)

### Operating rules

- Branch off main: `feature/pr-13-children-archived-at`
- Migration cites `R 400.1907` in header
- Follow the existing soft-delete pattern from `caregivers` and `funding_sources`
- App-code grep is mandatory per the house convention — every `children` query needs a per-case decision
- Tests pass: `npm run build` + `npx vitest run`
- Don't merge to main yourself — halt with the branch pushed and tell me what's ready to review
- If you hit anything unexpected (e.g., RLS policies that conflict, an existing soft-delete attempt anywhere in the codebase, a unique constraint that breaks under archived rows), halt and flag before proceeding

### Verification before halt

- `npm run build` clean
- `npx vitest run` all tests pass
- App-code grep audit complete: list every changed call site in your halt message
- The "show archived children" toggle works and the archived UI is distinguishable from active UI

### Halt with

1. Branch name + final commit SHA
2. Files changed (high-level)
3. Test pass count
4. App-code call sites updated (count + key examples)
5. The migration number used (so PR #14 knows what's next)
6. Anything unexpected found during the grep

I'll merge after reviewing.

---

## A note on scope

This is a small PR by design. Don't expand it to handle adjacent issues unless they're truly blocking. Resist the temptation to:
- Also fix the `families` table's lack of `archived_at` (separate PR if needed)
- Also refactor the existing soft-delete UI patterns elsewhere
- Also build the retention-policy reminder system (that's PR #15)

The point of this PR is one column + grep audit + minimal UI for archive/unarchive. Ship small, ship fast, clear the deck for PR #14.
