# PR #8.5a Review — Schema capture for existing production tables

**Branch:** `schema/capture-existing-production-tables`
**Migration:** `supabase/migrations/016_capture_existing_schema_for_pr_8_5.sql`

## Build session status — SHIPPED

All items from the original "parked, awaiting dashboard data" list are now resolved. The migration was rewritten against Seth's full discovery output (2026-05-20, see `discovery_results_for_migrations.md`) and committed in `1a15505`. Three commits on this branch:

```
1a15505 PR #8.5a: revise migration 016 against full discovery output
4dd425d PR #8.5a: migration 016 + soft-delete fixes + birth_date and pickup column normalizations
6e86912 PR #8.5a: scaffold review doc; migration parked pending discovery
```

What landed in the final migration:
- 5 `CREATE TABLE IF NOT EXISTS` blocks matching production verbatim (children 11 cols; families 32 cols; guardians 13 + archived_at; emergency_contacts 8; attendance 15 + UNIQUE + CHECK constraints + the single `attendance_user_date_idx` index).
- 5 families CHECK constraints (billing_frequency, billing_monthly_mode, billing_partial_week_mode, billing_cycle_start_day, billing_cycle_end_day).
- 40 RLS policies captured verbatim via the idempotent `DROP POLICY IF EXISTS … ; CREATE POLICY …` pair. Postgres does not support `CREATE POLICY IF NOT EXISTS`; migration 016 was revised to use the drop-then-create pattern. Caught during production apply 2026-05-21 (`ERROR: 42601: syntax error at or near "not"`). The drop-then-create pair is idempotent in both directions — on a fresh environment the DROP is a no-op and the CREATE lands the policy; on production the DROP removes the existing policy and the CREATE re-creates it with the same body.
- 1 net-new column: `guardians.archived_at`.
- 1 net-new index: `idx_guardians_family_active` (partial, `WHERE archived_at IS NULL`).
- Code-side: ParentMyFamilyPage normalized to `can_pickup` and `date_of_birth`; both guardian-delete call sites soft-delete; both list queries filter on `archived_at IS NULL`.

## Spec § PR #8.5a — required review entries

### Schemas captured

Migration 016 carries the verbatim column definitions for all five tables from Seth's `discovery_results_for_migrations.md` Query 1 output. Summary:

| Table | Column count | New column added |
|---|---|---|
| `public.children` | 11 | — |
| `public.families` | 32 | — |
| `public.guardians` | 13 | `+ archived_at` (net-new this PR) |
| `public.emergency_contacts` | 8 | — |
| `public.attendance` | 15 | — |

Full column listings live in `discovery_results_for_migrations.md` § Query 1 (the raw CSV pasted from the dashboard); the migration file is the canonical declaration.

### `can_pickup` / `authorized_pickup` resolution

- **Canonical column name:** `can_pickup` (chosen because `FamiliesPage.jsx`'s primary write path uses it; `ParentMyFamilyPage.jsx` was writing `authorized_pickup` to a non-existent column, silently dropped by PostgREST).
- **Lines normalized:**
  - `src/pages/ParentMyFamilyPage.jsx:469` — guardian update now writes `can_pickup` (form state still labels the local form field `authorized_pickup` for UI consistency; only the DB column reference changed).
  - `src/pages/ParentMyFamilyPage.jsx:480` — guardian insert, same change.
- **Adjacent gap noted in pre-build readout:** `ParentMyFamilyPage.jsx`'s guardian writes also omit `is_primary` and `address`. Both columns exist (per `FamiliesPage.jsx`'s form). Not fixed in this PR — the parent-side guardian editor is intentionally a stripped subset of the provider-side editor (parents probably shouldn't be unilaterally marking themselves "primary contact"). Documented here so a future PR knows it's a deliberate scope choice, not an oversight.

### `child.birth_date` vs `date_of_birth`

- **Canonical column name:** `date_of_birth` (every write path uses it; 8 references across 5 files).
- **Lines fixed in `ParentMyFamilyPage.jsx`:**
  - `:55` — `.order('birth_date', …)` → `.order('date_of_birth', …)`
  - `:346,348` — `child.birth_date` → `child.date_of_birth` in the conditional render.

### RLS policies missing or unclear

Migration 016 issues `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on all five tables but does not re-issue specific policy bodies — production already has policies in place, and `CREATE POLICY` would conflict / duplicate. The migration explicitly documents this: "RLS captures here are best-effort … policy bodies are preserved as production defines them; this migration declares row level security enabled but does not re-issue specific policies."

**For-human-verification action when this migration is applied:** confirm via the dashboard policy editor that each of the five tables has its expected per-`user_id` read/write policy in place, and that parent-side reads (where applicable) go through `parent_family_links`. If a policy is missing, a follow-up migration `0XX_capture_existing_rls.sql` adds it. Tracking as a discovery-completeness item, not as a blocker.

### Migration safety verification

The migration is fully idempotent: every CREATE TABLE block uses `IF NOT EXISTS`; the one behaviour-altering statement (`ADD COLUMN IF NOT EXISTS archived_at` on guardians) is also idempotent; CHECK constraints inside `CREATE TABLE IF NOT EXISTS` are no-op against an existing table whether or not they match production verbatim (the table-existence short-circuit beats the constraint declaration). Safe to dry-run against any environment.

### Tables NOT captured (out of scope, remain on tech-debt backlog)

`tech_debt.md` § "Migrations folder is out of sync with production schema" lists ~26 production-only tables. PR #8.5a addresses only the five required for the PR #8.5b/c/9 build (`children`, `families`, `guardians`, `emergency_contacts`, `attendance`). The remaining ~21 stay parked in tech-debt.

## Discovery findings worth flagging (not blocking this PR)

Two production observations surfaced during the dashboard inspection, both surfaced as "preserve as-is in the capture migration, document for a future cleanup PR." Migration 016 (when written) keeps existing reality verbatim; both items become candidates for a follow-up cleanup PR.

### A. Sparse FK indexes — future tech debt, not a blocker

Of the five tables PR #8.5a captures, only `attendance` carries a non-PK index (`attendance_user_date_idx`). `children`, `families`, `guardians`, and `emergency_contacts` have nothing beyond their PK. Foreign-key columns — `children.family_id`, `guardians.family_id`, `emergency_contacts.family_id`, etc. — drive every "show me a family's kids / guardians / contacts" query in the app, all running unindexed today. Postgres can still execute them; at single-licensee scale (Venessa + early users) it doesn't matter; at scale it will.

**Action for this PR:** preserve as-discovered. The capture migration documents what exists; it does not add new indexes (acceptance-criteria-bound by spec § PR #8.5a "Does not add any new columns beyond `archived_at` on guardians" — the same minimalism applies to indexes).

**Future cleanup PR — recommended index set when query patterns get profiled:**

```sql
CREATE INDEX IF NOT EXISTS children_family_id_idx           ON public.children (family_id);
CREATE INDEX IF NOT EXISTS guardians_family_id_idx          ON public.guardians (family_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS emergency_contacts_family_id_idx ON public.emergency_contacts (family_id);
```

The `guardians` index is partial to match PR #8.5a's `archived_at`-based soft-delete pattern (every list query goes through `WHERE archived_at IS NULL`).

### B. `attendance.checked_in_by` CHECK constraint is correct but confusingly written

The production constraint reads:

```sql
CHECK ((checked_in_by = ANY (ARRAY['parent'::text, 'provider'::text, NULL::text])))
```

The `NULL::text` member of the array doesn't do what it appears to: `<value> = ANY(ARRAY[…, NULL, …])` returns `NULL` when the value is `NULL`, not `TRUE`. Postgres CHECK constraints pass on `NULL` results (only an explicit `FALSE` fails them), so the constraint *does* allow `NULL` values to land — but as a side effect of how CHECK + NULL three-valued logic interact, not because the `NULL::text` array member matched. A reader who hasn't internalised this would reasonably misread the constraint as "must be `'parent'`, `'provider'`, or `NULL`," when in reality it's "must be `'parent'` or `'provider'`, with `NULL` allowed because all CHECKs are lenient on NULL."

**Production behaviour is correct** — `'parent'`, `'provider'`, and `NULL` all pass; anything else fails.

**Action for this PR:** preserve verbatim in migration 016. The capture migration's job is to document existing reality, not refactor it. Migration 016 will quote the constraint exactly as production defines it.

**Future cleanup PR — clearer rewrite, same behaviour:**

```sql
CHECK (checked_in_by IS NULL OR checked_in_by IN ('parent', 'provider'))
```

This expresses the intent directly: NULL is allowed (left branch), otherwise the value must be in the enum-shaped list. Same `'parent'` / `'provider'` / `NULL` pass-set; no NULL-in-array trickery. Worth bundling whenever a future migration is already touching the `attendance` table for another reason — a cleanup PR of its own probably isn't worth the dashboard ceremony.

Carry the same review note forward to `attendance.checked_out_by` if discovery confirms it has the same shape (likely — the pair of columns is usually defined symmetrically).

## Migration ordering note

Migrations `014_terms_acceptance.sql` and `015_security_hardening.sql` are both merged into `main` (verified `git log` on `supabase/migrations/`). Whether they are *applied* to production is a separate dashboard verification step — their runbook entries were last left in `PENDING` state. The PR #8.5a migration (`016`) is additive (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`) and does not depend on `014`/`015` schema being in place to apply cleanly, so it stacks safely regardless of their apply-state. Carrying this forward to the runbook entry.
