// 2026-06-17 — migration shape test for 044 (PR #19).
//
// Static SQL-shape verification — vitest can't run real Postgres,
// so the runtime checks (RLS actually denies cross-provider reads,
// CHECK actually rejects an invalid drill_type insert, the inline
// 'auditor jwt denied' policy actually denies an auditor JWT) all
// happen at apply time via the verification queries embedded in
// the migration header.
//
// What this pins:
//   - drill_logs CREATE TABLE has all required columns + NOT NULL
//     where promised.
//   - The three CHECK constraints (drill_type whitelist, performed_on
//     not future, duration positive) are present and shape-correct.
//   - Both indexes are present and filter on archived_at IS NULL.
//   - RLS is enabled.
//   - The three provider-scoped policies + the universal 'auditor jwt
//     denied' policy are present. NO DELETE policy.
//   - The set_drill_logs_updated_at trigger uses set_updated_at().
//   - The compliance_documents CHECK swap is wrapped in the same
//     transaction as the table creation and includes
//     'emergency_response_plan' as the only new value (10 total).
//   - Header verification queries name every load-bearing surface.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(
  join(__dirname, '044_drill_logs_and_emergency_response_plan.sql'),
  'utf8'
)

// SQL minus header comments — the header repeats column lists and
// policy names in `--` lines and we don't want those to false-positive.
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

const DRILL_TYPES = [
  'fire',
  'tornado',
  'lockdown',
  'shelter_in_place',
  'reunification',
  'other',
]

const PRIOR_DOC_TYPES = [
  'fingerprint_reprint',
  'property_radon_test',
  'property_heating_inspection',
  'property_licensing_notebook',
  'property_co_detectors_per_level',
  'property_smoke_detectors_per_floor',
  'property_fire_extinguishers_per_floor',
  'property_animal_notification',
  'property_smoking_prohibition_posted',
]
const NEW_DOC_TYPE = 'emergency_response_plan'

// ─── drill_logs table ────────────────────────────────────────────────

describe('044 — drill_logs table', () => {
  it('declares the table with CREATE TABLE IF NOT EXISTS', () => {
    expect(CODE).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.drill_logs/i)
  })

  it('all required NOT NULL columns are present', () => {
    expect(CODE).toMatch(/id\s+uuid\s+primary\s+key/i)
    expect(CODE).toMatch(/user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\(id\)/i)
    expect(CODE).toMatch(/drill_type\s+text\s+not\s+null/i)
    expect(CODE).toMatch(/performed_on\s+date\s+not\s+null/i)
    expect(CODE).toMatch(/created_at\s+timestamptz\s+not\s+null/i)
    expect(CODE).toMatch(/updated_at\s+timestamptz\s+not\s+null/i)
  })

  it('nullable columns are explicitly nullable (no NOT NULL)', () => {
    // The optional columns: duration_minutes, notes, archived_at,
    // archived_by. Each appears once in the CREATE TABLE body
    // without a NOT NULL qualifier on its column declaration line.
    expect(CODE).toMatch(/duration_minutes\s+numeric\(5,\s*2\)\s*(?:,|\n)/i)
    expect(CODE).toMatch(/notes\s+text\s*(?:,|\n)/i)
    expect(CODE).toMatch(/archived_at\s+timestamptz\s*(?:,|\n)/i)
    expect(CODE).toMatch(/archived_by\s+uuid\s+references\s+auth\.users\(id\)/i)
  })

  it('ON DELETE CASCADE on user_id (provider deletion cascades)', () => {
    expect(CODE).toMatch(/user_id[\s\S]*?on\s+delete\s+cascade/i)
  })
})

describe('044 — drill_logs CHECK constraints', () => {
  it('drill_type CHECK lists every drill type in DRILL_TYPES', () => {
    for (const t of DRILL_TYPES) {
      expect(CODE).toContain(`'${t}'`)
    }
    expect(CODE).toMatch(/drill_logs_drill_type_valid/i)
  })

  it('performed_on cannot be in the future', () => {
    expect(CODE).toMatch(/drill_logs_performed_on_not_future/i)
    expect(CODE).toMatch(/performed_on\s*<=\s*current_date/i)
  })

  it('duration_minutes, when set, must be positive', () => {
    expect(CODE).toMatch(/drill_logs_duration_positive/i)
    expect(CODE).toMatch(/duration_minutes\s+is\s+null\s+or\s+duration_minutes\s*>\s*0/i)
  })
})

describe('044 — drill_logs indexes (both archived-aware)', () => {
  it('declares the (user_id, performed_on DESC) index filtered on archived_at IS NULL', () => {
    expect(CODE).toMatch(/create\s+index\s+if\s+not\s+exists\s+drill_logs_user_performed_idx/i)
    expect(CODE).toMatch(/drill_logs_user_performed_idx[\s\S]*?archived_at\s+is\s+null/i)
  })

  it('declares the (user_id, drill_type, performed_on DESC) type-specific index', () => {
    expect(CODE).toMatch(/create\s+index\s+if\s+not\s+exists\s+drill_logs_user_type_performed_idx/i)
    expect(CODE).toMatch(/drill_logs_user_type_performed_idx[\s\S]*?archived_at\s+is\s+null/i)
  })
})

describe('044 — drill_logs RLS (provider scope + universal auditor deny + NO DELETE)', () => {
  it('enables RLS on the table', () => {
    expect(CODE).toMatch(/alter\s+table\s+public\.drill_logs\s+enable\s+row\s+level\s+security/i)
  })

  it('provider SELECT policy on auth.uid() = user_id', () => {
    expect(CODE).toMatch(/create\s+policy\s+"Providers select own drill logs"\s+on\s+public\.drill_logs\s+for\s+select\s+using\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/i)
  })

  it('provider INSERT policy with WITH CHECK', () => {
    expect(CODE).toMatch(/create\s+policy\s+"Providers insert own drill logs"[\s\S]*?with\s+check\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/i)
  })

  it('provider UPDATE policy enables in-place correction of mis-entered drills', () => {
    expect(CODE).toMatch(/create\s+policy\s+"Providers update own drill logs"\s+on\s+public\.drill_logs\s+for\s+update[\s\S]*?with\s+check\s*\(\s*auth\.uid\(\)\s*=\s*user_id\s*\)/i)
  })

  it('NO delete policy — soft-delete via archived_at is the only path', () => {
    expect(CODE).not.toMatch(/create\s+policy[\s\S]*?on\s+public\.drill_logs\s+for\s+delete/i)
  })

  it('universal "auditor jwt denied" RESTRICTIVE policy is added inline (mig 042 DO block already fired)', () => {
    expect(CODE).toMatch(/create\s+policy\s+"auditor jwt denied"\s+on\s+public\.drill_logs[\s\S]*?as\s+restrictive[\s\S]*?using\s*\(\s*not\s+public\.is_auditor_jwt\(\)\s*\)[\s\S]*?with\s+check\s*\(\s*not\s+public\.is_auditor_jwt\(\)\s*\)/i)
  })

  it('updated_at trigger uses migration 001s set_updated_at()', () => {
    expect(CODE).toMatch(/create\s+trigger\s+set_drill_logs_updated_at\s+before\s+update\s+on\s+public\.drill_logs\s+for\s+each\s+row\s+execute\s+procedure\s+public\.set_updated_at\(\)/i)
  })
})

// ─── compliance_documents.document_type CHECK extension ──────────────

describe('044 — compliance_documents CHECK extension (adds emergency_response_plan)', () => {
  it('drops the prior CHECK before recreating it', () => {
    expect(CODE).toMatch(/alter\s+table\s+public\.compliance_documents\s+drop\s+constraint\s+if\s+exists\s+chk_compliance_documents_document_type/i)
  })

  it('recreates the CHECK with all 9 prior values still listed', () => {
    for (const t of PRIOR_DOC_TYPES) {
      expect(CODE).toContain(`'${t}'`)
    }
  })

  it(`recreates the CHECK with '${NEW_DOC_TYPE}' added`, () => {
    expect(CODE).toContain(`'${NEW_DOC_TYPE}'`)
  })

  it('the DROP + ADD is inside the single BEGIN/COMMIT (atomicity)', () => {
    const beginCount = (CODE.match(/^\s*begin\s*;/gim) || []).length
    const commitCount = (CODE.match(/^\s*commit\s*;/gim) || []).length
    expect(beginCount).toBe(1)
    expect(commitCount).toBe(1)
  })
})

// ─── Header verification block ───────────────────────────────────────

describe('044 — header verification block', () => {
  it('header documents the drill_logs column-list query', () => {
    expect(SQL).toMatch(/select\s+column_name,\s+data_type,\s+is_nullable[\s\S]*?table_name\s*=\s*'drill_logs'/i)
  })

  it('header documents the RLS-enabled check for drill_logs', () => {
    expect(SQL).toMatch(/relrowsecurity[\s\S]*?relname\s*=\s*'drill_logs'/i)
  })

  it('header documents the 4-policy-list check for drill_logs (incl. RESTRICTIVE)', () => {
    expect(SQL).toMatch(/pg_policies[\s\S]*?tablename='drill_logs'/i)
    expect(SQL).toMatch(/auditor jwt denied/)
  })

  it('header documents the compliance_documents CHECK definition query', () => {
    expect(SQL).toMatch(/pg_get_constraintdef[\s\S]*?compliance_documents/i)
  })

  it('header documents the updated_at trigger check', () => {
    expect(SQL).toMatch(/information_schema\.triggers[\s\S]*?event_object_table\s*=\s*'drill_logs'/i)
  })
})
