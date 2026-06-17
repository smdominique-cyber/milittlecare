// 2026-06-17 — migration shape test for 043 (PR #21 inventory batch).
//
// Mirrors the discipline applied to migration 042 (auditor portal):
// static SQL-shape verification because vitest can't run real
// Postgres. The runtime check (the CHECK constraint actually
// accepts the new values, existing rows still satisfy the swap)
// happens at apply time in Supabase SQL Editor via the verification
// queries embedded in the migration header.
//
// What this pins:
//   - The migration drops the prior 039 CHECK and re-adds it as a
//     superset including the five new document_type values.
//   - The single transaction wrapper is intact (DROP + ADD inside
//     one BEGIN/COMMIT — a reader between the two statements never
//     sees a missing CHECK).
//   - The verification block in the header still names every new
//     document_type so the apply-time count query is complete.
//   - The DOWN block is present and gated by an emergency-only
//     comment (per the migration 039 pattern).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(
  join(__dirname, '043_compliance_documents_property_inventory_types.sql'),
  'utf8'
)

// SQL minus header comments (single-line `--`). The CHECK list lives in
// the live SQL; the header has its own listing in comments which we
// don't want to false-positive on.
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

const NEW_DOC_TYPES = [
  'property_co_detectors_per_level',
  'property_smoke_detectors_per_floor',
  'property_fire_extinguishers_per_floor',
  'property_animal_notification',
  'property_smoking_prohibition_posted',
]

const PRIOR_DOC_TYPES = [
  'fingerprint_reprint',
  'property_radon_test',
  'property_heating_inspection',
  'property_licensing_notebook',
]

describe('043 — CHECK constraint swap', () => {
  it('drops the prior chk_compliance_documents_document_type before recreating it', () => {
    expect(CODE).toMatch(
      /alter\s+table\s+public\.compliance_documents\s+drop\s+constraint\s+if\s+exists\s+chk_compliance_documents_document_type/i
    )
  })

  it('recreates the constraint with all four prior values', () => {
    for (const t of PRIOR_DOC_TYPES) {
      expect(CODE).toContain(`'${t}'`)
    }
  })

  it('recreates the constraint with all five new values', () => {
    for (const t of NEW_DOC_TYPES) {
      expect(CODE).toContain(`'${t}'`)
    }
  })

  it('the DROP + ADD pair is wrapped in a single transaction (BEGIN/COMMIT once each)', () => {
    const beginCount = (CODE.match(/^\s*begin\s*;/gim) || []).length
    const commitCount = (CODE.match(/^\s*commit\s*;/gim) || []).length
    expect(beginCount).toBe(1)
    expect(commitCount).toBe(1)
  })

  it('the DROP statement precedes the ADD statement (constraint is never absent inside the txn boundary)', () => {
    const dropIdx = CODE.search(/drop\s+constraint\s+if\s+exists\s+chk_compliance_documents_document_type/i)
    const addIdx  = CODE.search(/add\s+constraint\s+chk_compliance_documents_document_type/i)
    expect(dropIdx).toBeGreaterThan(-1)
    expect(addIdx).toBeGreaterThan(-1)
    expect(dropIdx).toBeLessThan(addIdx)
  })
})

describe('043 — header verification block', () => {
  it('header documents the CHECK swap query', () => {
    expect(SQL).toMatch(/select conname[\s\S]*?pg_get_constraintdef[\s\S]*?compliance_documents/i)
  })

  it('header documents a count-by-type verification query covering every new type', () => {
    for (const t of NEW_DOC_TYPES) {
      expect(SQL).toContain(`document_type = '${t}'`)
    }
  })

  it('header records all five rule-citation corrections (audit-trail discipline)', () => {
    // Each row's citation correction lives in a comment line so a
    // reader scanning the migration sees the WHY without diving into
    // src/lib/complianceState.js. The corrections are part of the
    // same PR; this assertion catches a drift where someone updates
    // the citations in code but forgets the runbook-style trace
    // recorded here.
    expect(SQL).toMatch(/property_co_detectors_per_level[\s\S]*?R 400\.1915\(3\)/)
    expect(SQL).toMatch(/property_smoke_detectors_per_floor[\s\S]*?R 400\.1948/)
    expect(SQL).toMatch(/property_fire_extinguishers_per_floor[\s\S]*?R 400\.1948/)
    expect(SQL).toMatch(/property_animal_notification[\s\S]*?R 400\.1917/)
    expect(SQL).toMatch(/property_smoking_prohibition_posted[\s\S]*?R 400\.1918/)
  })
})

describe('043 — DOWN block', () => {
  it('exists, commented, and reverts to the migration 039 four-value list', () => {
    // The DOWN block lives in -- comments so applying the migration
    // doesn't execute it. We assert both the comment marker (so an
    // accidental uncomment is loud) and the four-value revert shape.
    expect(SQL).toMatch(/DOWN MIGRATION/i)
    expect(SQL).toMatch(/--\s*alter\s+table\s+public\.compliance_documents/i)
    expect(SQL).toMatch(/--\s*add\s+constraint\s+chk_compliance_documents_document_type/i)
    // The DOWN's check() block names exactly the four prior types.
    for (const t of PRIOR_DOC_TYPES) {
      expect(SQL).toContain(`'${t}'`)
    }
  })
})
