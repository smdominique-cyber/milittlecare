// 2026-06-18 — migration shape test for 046 (licensee self-row backfill).
//
// Static SQL-shape verification — vitest can't run real Postgres. The
// runtime check (every licensee gets exactly one self-row) lives in
// the verification queries embedded in the migration header; the
// deploy operator screenshots those before promoting.
//
// What this pins:
//   - The backfill is purely additive — exactly one INSERT into
//     public.caregivers, no DELETE, no UPDATE, no ALTER, no DROP.
//   - The INSERT lists exactly three target columns (licensee_id,
//     app_user_id, full_name) — same shape as the historical
//     useStaffTraining.js create and the relocated
//     ensureLicenseeSelfCaregiverRow helper. New columns would break
//     the equivalence the runbook entry is verified against.
//   - The licensee universe is the UNION of two definitions
//     (profiles.license_type IS NOT NULL  ∪  DISTINCT
//     caregivers.licensee_id) — neither alone is sufficient.
//   - The full_name fallback uses COALESCE in the priority order
//     specified in the helper: profiles.full_name → profiles.email
//     → 'You (licensee)'.
//   - The WHERE-NOT-EXISTS guard runs against the (licensee_id,
//     app_user_id) pair so re-running is a no-op (idempotency).
//   - The body is wrapped in a single BEGIN/COMMIT.
//   - No schema changes anywhere (no CREATE TABLE, no ALTER, no
//     constraint changes, no new RLS policy, no new index).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(
  join(__dirname, '046_licensee_caregivers_self_row_backfill.sql'),
  'utf8'
)

// SQL minus header comments — same idiom as mig 045's shape test.
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

describe('046 — pure backfill (no schema changes)', () => {
  it('contains no CREATE TABLE / ALTER TABLE / DROP TABLE statements', () => {
    expect(CODE).not.toMatch(/\bcreate\s+table\b/i)
    expect(CODE).not.toMatch(/\balter\s+table\b/i)
    expect(CODE).not.toMatch(/\bdrop\s+table\b/i)
  })

  it('does not add a new auditor-deny policy (caregivers predates mig 042 and is already sealed)', () => {
    expect(CODE).not.toMatch(/auditor\s+jwt\s+denied/i)
    expect(CODE).not.toMatch(/create\s+policy/i)
  })

  it('contains no DELETE or UPDATE statements (additive only)', () => {
    expect(CODE).not.toMatch(/^\s*delete\s+from\b/im)
    expect(CODE).not.toMatch(/^\s*update\s+public\./im)
  })

  it('declares no new index, constraint, or trigger', () => {
    expect(CODE).not.toMatch(/\bcreate\s+index\b/i)
    expect(CODE).not.toMatch(/\bcreate\s+(unique\s+)?constraint\b/i)
    expect(CODE).not.toMatch(/\bcreate\s+trigger\b/i)
    expect(CODE).not.toMatch(/\badd\s+constraint\b/i)
  })

  it('contains exactly one INSERT into public.caregivers', () => {
    const matches = CODE.match(/insert\s+into\s+public\.caregivers/gi) || []
    expect(matches.length).toBe(1)
  })
})

describe('046 — INSERT shape matches the historical create', () => {
  it('targets exactly three columns: licensee_id, app_user_id, full_name', () => {
    // The column-list portion of the INSERT statement.
    const m = CODE.match(/insert\s+into\s+public\.caregivers\s*\(([^)]+)\)/i)
    expect(m).not.toBeNull()
    const cols = m[1].split(',').map(s => s.trim()).sort()
    expect(cols).toEqual(['app_user_id', 'full_name', 'licensee_id'])
  })

  it('uses COALESCE for full_name in priority order: profiles.full_name → profiles.email → \'You (licensee)\'', () => {
    // Matches the COALESCE call regardless of whitespace/casing.
    expect(CODE).toMatch(/coalesce\s*\(\s*nullif\s*\(\s*trim\s*\(\s*p\.full_name\s*\)\s*,\s*''\s*\)\s*,\s*p\.email\s*,\s*'You \(licensee\)'/i)
  })

  it('sets licensee_id = app_user_id (both reference the same id) — the marker of a self-row', () => {
    // The two l.id projections appear on consecutive lines or are
    // separated only by whitespace + comma.
    expect(CODE).toMatch(/select\s+l\.id\s*,\s*l\.id/i)
  })
})

describe('046 — licensee universe is the union of two definitions', () => {
  it('selects from profiles WHERE license_type IS NOT NULL', () => {
    expect(CODE).toMatch(/select\s+id\s+from\s+public\.profiles\s+where\s+license_type\s+is\s+not\s+null/i)
  })

  it('also selects DISTINCT licensee_id from caregivers (covers pre-PR-#14 accounts)', () => {
    expect(CODE).toMatch(/select\s+distinct\s+licensee_id(\s+as\s+id)?\s+from\s+public\.caregivers/i)
  })

  it('unions the two definitions', () => {
    // The UNION keyword must appear between the two SELECTs inside
    // the licensee subquery.
    expect(CODE).toMatch(/from\s+public\.profiles\s+where\s+license_type\s+is\s+not\s+null\s+union\s+select\s+distinct/i)
  })

  it('does NOT filter on specific license_type values — license_exempt is INCLUDED per the 2026-06-18 decision', () => {
    // Regression lock: a future PR that narrows scope to family_home /
    // group_home only would need an explicit `IN (...)` clause, which
    // this assertion blocks until the decision-in-header is updated.
    expect(CODE).not.toMatch(/license_type\s+in\s*\(/i)
    expect(CODE).not.toMatch(/license_type\s*=\s*'family_home'/i)
    expect(CODE).not.toMatch(/license_type\s*<>\s*'license_exempt'/i)
    expect(CODE).not.toMatch(/license_type\s*!=\s*'license_exempt'/i)
  })
})

describe('046 — idempotency', () => {
  it('uses ON CONFLICT (licensee_id, app_user_id) DO NOTHING — keyed on the unique constraint declared in mig 012:106', () => {
    expect(CODE).toMatch(
      /on\s+conflict\s*\(\s*licensee_id\s*,\s*app_user_id\s*\)\s+do\s+nothing/i
    )
  })

  it('does NOT use the older WHERE-NOT-EXISTS idiom (this swap landed 2026-06-18 — ON CONFLICT is the canonical pattern)', () => {
    expect(CODE).not.toMatch(/where\s+not\s+exists/i)
  })

  it('the ON CONFLICT clause does NOT filter on archived_at — an archived self-row is treated as "exists" per the header policy', () => {
    // The conflict-target tuple is (licensee_id, app_user_id) only.
    // archived_at must not appear in the conflict target.
    const m = CODE.match(/on\s+conflict\s*\(([^)]*)\)/i)
    expect(m).not.toBeNull()
    expect(m[1]).not.toMatch(/archived_at/i)
  })
})

describe('046 — transaction boundary', () => {
  it('wraps the body in a single BEGIN/COMMIT', () => {
    const beginCount = (CODE.match(/^\s*begin\s*;/gim) || []).length
    const commitCount = (CODE.match(/^\s*commit\s*;/gim) || []).length
    expect(beginCount).toBe(1)
    expect(commitCount).toBe(1)
  })
})
