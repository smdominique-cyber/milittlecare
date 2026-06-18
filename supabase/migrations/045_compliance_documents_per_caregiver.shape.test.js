// 2026-06-17 — migration shape test for 045 (PR #17/#18 foundation).
//
// Static SQL-shape verification — vitest can't run real Postgres.
// The runtime checks (RLS still denies cross-provider reads, CHECK
// rejects a non-whitelisted document_type, the FK cascades on
// caregiver delete) happen at apply time via the verification
// queries embedded in the migration header.
//
// What this pins:
//   - subject_caregiver_id is added as a nullable FK to caregivers
//     ON DELETE CASCADE.
//   - The document_type CHECK lists all 10 prior values plus the
//     new 'caregiver_physician_attestation'.
//   - The per-caregiver index is filtered on archived_at IS NULL
//     AND subject_caregiver_id IS NOT NULL.
//   - The DROP + ADD CONSTRAINT swap is inside one transaction.
//   - The migration does NOT add a new 'auditor jwt denied'
//     policy on compliance_documents (the table existed at mig 042
//     apply time so the universal seal already covers it; a
//     second policy would be redundant noise).
//   - The migration does NOT create a new public table (so no
//     inline auditor-deny seal needed — the rule from mig 044's
//     header).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SQL = readFileSync(
  join(__dirname, '045_compliance_documents_per_caregiver.sql'),
  'utf8'
)

// SQL minus header comments — the header repeats column lists and
// CHECK contents in `--` lines and we don't want those to
// false-positive on the body assertions.
const CODE = SQL.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

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
  'emergency_response_plan',
]
const NEW_DOC_TYPE = 'caregiver_physician_attestation'

describe('045 — subject_caregiver_id column', () => {
  it('declares the new column as a nullable FK to caregivers ON DELETE CASCADE', () => {
    expect(CODE).toMatch(
      /alter\s+table\s+public\.compliance_documents\s+add\s+column\s+if\s+not\s+exists\s+subject_caregiver_id\s+uuid\s+references\s+public\.caregivers\(id\)\s+on\s+delete\s+cascade/i
    )
  })

  it('the column is NULLABLE — provider-level rows continue to work without setting it', () => {
    // No `NOT NULL` qualifier on the column declaration line.
    const colDecl = CODE.match(/add\s+column\s+if\s+not\s+exists\s+subject_caregiver_id[\s\S]*?(;|on delete cascade)/i)
    expect(colDecl).not.toBeNull()
    expect(colDecl[0]).not.toMatch(/\bnot\s+null\b/i)
  })

  it('adds a COMMENT documenting the NULL = provider-level semantics', () => {
    expect(CODE).toMatch(/comment\s+on\s+column\s+public\.compliance_documents\.subject_caregiver_id\s+is/i)
    expect(CODE).toMatch(/NULL\s*=\s*provider-level/i)
  })
})

describe('045 — document_type CHECK extension (adds caregiver_physician_attestation)', () => {
  it('drops the prior CHECK before recreating it', () => {
    expect(CODE).toMatch(/alter\s+table\s+public\.compliance_documents\s+drop\s+constraint\s+if\s+exists\s+chk_compliance_documents_document_type/i)
  })

  it('recreates the CHECK with all 10 prior values', () => {
    for (const t of PRIOR_DOC_TYPES) {
      expect(CODE).toContain(`'${t}'`)
    }
  })

  it(`recreates the CHECK with '${NEW_DOC_TYPE}' added`, () => {
    expect(CODE).toContain(`'${NEW_DOC_TYPE}'`)
  })

  it('the DROP + ADD CONSTRAINT is inside the single BEGIN/COMMIT (atomicity)', () => {
    const beginCount = (CODE.match(/^\s*begin\s*;/gim) || []).length
    const commitCount = (CODE.match(/^\s*commit\s*;/gim) || []).length
    expect(beginCount).toBe(1)
    expect(commitCount).toBe(1)
  })
})

describe('045 — per-caregiver index', () => {
  it('declares the (subject_caregiver_id, document_type, uploaded_at DESC) index', () => {
    expect(CODE).toMatch(/create\s+index\s+if\s+not\s+exists\s+compliance_documents_subject_caregiver_type_idx/i)
    expect(CODE).toMatch(/compliance_documents_subject_caregiver_type_idx[\s\S]*?\(subject_caregiver_id,\s*document_type,\s*uploaded_at\s+desc\)/i)
  })

  it('the index is filtered on archived_at IS NULL AND subject_caregiver_id IS NOT NULL', () => {
    expect(CODE).toMatch(
      /compliance_documents_subject_caregiver_type_idx[\s\S]*?where\s+archived_at\s+is\s+null\s+and\s+subject_caregiver_id\s+is\s+not\s+null/i
    )
  })
})

describe('045 — does NOT touch the auditor portal seal', () => {
  it('does NOT add a second "auditor jwt denied" policy on compliance_documents', () => {
    // The migration 042 DO block already sealed compliance_documents.
    // Adding a second policy would be redundant noise. This assertion
    // catches an accidental "I forgot 042 already did this" addition.
    expect(CODE).not.toMatch(/create\s+policy\s+"auditor jwt denied"/i)
  })

  it('does NOT create a new public TABLE (so no inline auditor seal is required)', () => {
    expect(CODE).not.toMatch(/create\s+table\s+(if\s+not\s+exists\s+)?public\./i)
  })
})

describe('045 — header verification block', () => {
  it('header documents the subject_caregiver_id column-existence query', () => {
    expect(SQL).toMatch(/column_name\s*=\s*'subject_caregiver_id'/i)
  })

  it('header documents the FK cascade-behavior query', () => {
    expect(SQL).toMatch(/contype\s*=\s*'f'[\s\S]*?subject_caregiver_id/i)
  })

  it('header documents the CHECK extension query expecting 11 values', () => {
    expect(SQL).toMatch(/pg_get_constraintdef[\s\S]*?compliance_documents/i)
    expect(SQL).toMatch(/11 doc_type values incl\./i)
  })

  it('header documents the per-caregiver index query', () => {
    expect(SQL).toMatch(/pg_indexes[\s\S]*?compliance_documents_subject_caregiver_type_idx/i)
  })

  it('header documents the "existing seal unchanged" check', () => {
    expect(SQL).toMatch(/auditor jwt denied[\s\S]*?present from migration 042/i)
  })

  it('header documents the existing-rows-untouched query (no caregiver-scoped rows pre-045)', () => {
    expect(SQL).toMatch(/subject_caregiver_id is null/i)
    expect(SQL).toMatch(/subject_caregiver_id is not null/i)
  })
})

describe('045 — header records design for the two follow-up rows', () => {
  it('records the substrate plan for caregiver_discipline_policy_ack_at_hire', () => {
    expect(SQL).toMatch(/caregiver_discipline_policy_ack_at_hire/i)
    expect(SQL).toMatch(/acknowledgments[\s\S]*?subject_type='caregiver'/i)
    expect(SQL).toMatch(/staff_discipline_policy_receipt/i)
  })

  it('records the investigation finding + V1 recommendation for caregiver_daily_arrival_departure', () => {
    expect(SQL).toMatch(/caregiver_daily_arrival_departure/i)
    expect(SQL).toMatch(/staff_time_entries/i)
    // Non-app-user gap explicitly noted.
    expect(SQL).toMatch(/non-app-user/i)
    // V1 recommendation: attestation toggle.
    expect(SQL).toMatch(/attestation/i)
  })
})
