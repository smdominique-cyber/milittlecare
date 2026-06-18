// 2026-06-14 — Phase A of the compliance_documents store. Locks the
// generic DocumentSlot behavior for the G4 (fingerprint_reprint)
// consumer + the future PR #21 / PR #18 consumers that reuse it.
//
// Three classes of test:
//
//   1. Catalog alignment — the per-domain configs in
//      `lib/complianceDocuments.js` agree on the same set of
//      document_type values. A drift here means the SQL CHECK in
//      migration 038 would accept a value the JS layer can't render
//      (or vice versa) — the same "trap" class the B1 immunization
//      enum had.
//
//   2. Upload path — when the slot mounts with no existing
//      documents and the provider picks a file:
//        a. `supabase.storage.from(bucket).upload(path, file)` runs.
//        b. `supabase.from(table).insert({...})` runs with the
//           provider-level payload shape compliance_documents
//           expects (no parent FK column, user_id present,
//           document_type matches the prop, storage_path matches
//           what `buildStoragePath` returned).
//      The two together prove the slot speaks the migration-038
//      contract correctly.
//
//   3. Archive (Remove) path — clicking Remove writes
//      `.update({archived_at, archived_by}).eq('id', doc.id)` on
//      the metadata table. Soft-delete: the row stays, archived_at
//      becomes non-null, the storage object is untouched. This is
//      the CLAUDE.md never-hard-delete convention; locking it
//      prevents a future "let's just .delete it" regression.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

// -----------------------------------------------------------------------------
// Catalog alignment — no React, no DOM, pure imports
// -----------------------------------------------------------------------------

import {
  COMPLIANCE_DOCUMENT_TYPES,
  COMPLIANCE_DOCUMENT_TYPE_CONFIG,
  BUCKET as COMPLIANCE_BUCKET,
  buildStoragePath as buildCompliancePath,
} from '@/lib/complianceDocuments'

describe('compliance_documents catalog ↔ config alignment (the B1-style enum trap)', () => {
  it('every COMPLIANCE_DOCUMENT_TYPES entry has a config row, and vice versa', () => {
    const typeSet = new Set(COMPLIANCE_DOCUMENT_TYPES)
    const cfgKeys = Object.keys(COMPLIANCE_DOCUMENT_TYPE_CONFIG)
    // Same membership both directions.
    for (const t of typeSet) {
      expect(COMPLIANCE_DOCUMENT_TYPE_CONFIG[t], `missing config for ${t}`).toBeDefined()
    }
    for (const k of cfgKeys) {
      expect(typeSet.has(k), `config has ${k} but it isn't in COMPLIANCE_DOCUMENT_TYPES`).toBe(true)
    }
  })

  it('Phase A + 2026-06-14 batch + 2026-06-17 PR #21 inventory batch + 2026-06-17 PR #19 ERP + 2026-06-17 PR #17/#18 foundation — order locked, count locked', () => {
    // Each addition needs both the SQL CHECK (mig 038, then 039, then
    // 043, then 044, then 045) and this catalog updated in lockstep.
    // A new entry forces this test to fail until the migration is
    // named in the same commit — the same enum-trap discipline as B1.
    expect(COMPLIANCE_DOCUMENT_TYPES).toEqual([
      'fingerprint_reprint',                    // G4   — mig 038
      'property_radon_test',                    // J1   — mig 039
      'property_heating_inspection',            // J2   — mig 039
      'property_licensing_notebook',            // J8   — mig 039
      'property_co_detectors_per_level',        // J3   — mig 043
      'property_smoke_detectors_per_floor',     // J4   — mig 043
      'property_fire_extinguishers_per_floor',  // J5   — mig 043
      'property_animal_notification',           // J6   — mig 043
      'property_smoking_prohibition_posted',    // J7   — mig 043
      'emergency_response_plan',                // PR #19 — mig 044
      'caregiver_physician_attestation',        // PR #17/#18 foundation — mig 045
    ])
  })

  it('config entries carry the shape DocumentSlot expects (title + help; badge or null; multi boolean)', () => {
    for (const k of Object.keys(COMPLIANCE_DOCUMENT_TYPE_CONFIG)) {
      const cfg = COMPLIANCE_DOCUMENT_TYPE_CONFIG[k]
      expect(typeof cfg.title).toBe('string')
      expect(typeof cfg.help).toBe('string')
      expect(typeof cfg.multi).toBe('boolean')
      // badge is null OR { text, tone }
      if (cfg.badge !== null && cfg.badge !== undefined) {
        expect(typeof cfg.badge.text).toBe('string')
        expect(['required', 'neutral']).toContain(cfg.badge.tone)
      }
    }
  })

  it('buildStoragePath returns the <userId>/<documentType>/<uuid>.<ext> shape', () => {
    const f = new File(['x'], 'cert.pdf', { type: 'application/pdf' })
    const path = buildCompliancePath({
      userId: 'u-1',
      documentType: 'fingerprint_reprint',
      file: f,
    })
    expect(path.startsWith('u-1/fingerprint_reprint/')).toBe(true)
    expect(path.endsWith('.pdf')).toBe(true)
  })

  it('BUCKET name matches what migration 038 creates', () => {
    expect(COMPLIANCE_BUCKET).toBe('compliance-documents')
  })
})

// -----------------------------------------------------------------------------
// DocumentSlot — upload + archive integration
// -----------------------------------------------------------------------------

// Hoisted recorders so vi.mock can read them.
const tableState = vi.hoisted(() => ({
  // fetch sequence: the slot's initial fetch and any refetch read
  // shifts from this queue. Each entry is the { data, error } the
  // .order(...) thenable resolves to.
  fetchQueue: [],
  inserts: [],
  updates: [],
  // Storage capture.
  storageUploads: [],
  // Errors to inject.
  insertError: null,
  uploadError: null,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-licensee' } }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from(table) {
      // PostgREST chain. .select/.eq/.is/.order are chainable; the
      // terminal .then resolves to the next item in fetchQueue. For
      // .update / .insert the result is returned synchronously from
      // an await (we model them as thenables that resolve once).
      let mode = 'select'
      let updatePayload = null
      let insertPayload = null
      const chain = {
        select() { mode = 'select'; return chain },
        eq(col, val) {
          // Capture the .eq('id', ...) for archive assertions only
          // when in update mode — the select-mode .eq calls are
          // setup chatter.
          if (mode === 'update') chain.__lastEqs.push({ col, val })
          return chain
        },
        is() { return chain },
        order() { return chain },
        update(payload) {
          mode = 'update'
          updatePayload = payload
          chain.__lastEqs = []
          return chain
        },
        insert(payload) {
          mode = 'insert'
          insertPayload = payload
          return chain
        },
        then(resolve) {
          if (mode === 'update') {
            tableState.updates.push({
              table, payload: updatePayload, eqs: chain.__lastEqs,
            })
            resolve({ data: null, error: null })
            return
          }
          if (mode === 'insert') {
            tableState.inserts.push({ table, payload: insertPayload })
            resolve({ data: null, error: tableState.insertError })
            return
          }
          // select
          const next = tableState.fetchQueue.shift() || { data: [], error: null }
          resolve(next)
        },
      }
      chain.__lastEqs = []
      return chain
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, file, opts) {
            tableState.storageUploads.push({ bucket, path, fileName: file?.name, opts })
            return { error: tableState.uploadError }
          },
          async remove(paths) {
            tableState.storageUploads.push({ bucket, removed: paths })
            return { error: null }
          },
        }
      },
    },
  },
}))

const { default: DocumentSlot } = await import('./DocumentSlot')
const { default: ComplianceDocumentSlot } =
  await import('./ComplianceDocumentSlot')

beforeEach(() => {
  tableState.fetchQueue = []
  tableState.inserts = []
  tableState.updates = []
  tableState.storageUploads = []
  tableState.insertError = null
  tableState.uploadError = null
})

afterEach(cleanup)

function pickFile(input, file) {
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  })
  fireEvent.change(input)
}

describe('DocumentSlot — upload (empty state → file picked)', () => {
  it('insert payload matches the migration-038 contract: user_id + document_type + storage_path + no parent column', async () => {
    // Mount with an empty fetch result so the slot renders the
    // DropZone (the only path to a fresh upload).
    tableState.fetchQueue.push({ data: [], error: null })
    // Refetch after a successful upload returns the new row so the
    // slot doesn't sit in a broken state at the end of the test.
    tableState.fetchQueue.push({
      data: [{ id: 'new-doc', original_filename: 'cert.pdf', uploaded_at: '2026-06-14T10:00:00Z' }],
      error: null,
    })

    const { container } = render(
      <ComplianceDocumentSlot documentType="fingerprint_reprint" />
    )

    // Wait for the initial fetch to flush (the slot exits its loading
    // state).
    await screen.findByLabelText(/Drop a file/i)

    // Find the hidden file input inside the drop zone. The slot
    // doesn't expose it via a friendly selector; query by type.
    const fileInputs = container.querySelectorAll('input[type="file"]')
    expect(fileInputs.length).toBeGreaterThan(0)
    const fileInput = fileInputs[0]
    const file = new File(['fingerprint-receipt-bytes'], 'cert.pdf', {
      type: 'application/pdf',
    })

    await act(async () => {
      pickFile(fileInput, file)
    })

    // Storage upload landed on the right bucket with a
    // compliance-documents-shaped path.
    expect(tableState.storageUploads.length).toBeGreaterThan(0)
    const uploaded = tableState.storageUploads.find(u => u.fileName === 'cert.pdf')
    expect(uploaded).toBeDefined()
    expect(uploaded.bucket).toBe('compliance-documents')
    expect(uploaded.path.startsWith('u-licensee/fingerprint_reprint/')).toBe(true)
    expect(uploaded.path.endsWith('.pdf')).toBe(true)

    // Metadata insert landed on the right table with the right
    // provider-level shape — no parent FK column, user_id present,
    // document_type matches the prop.
    expect(tableState.inserts).toHaveLength(1)
    const ins = tableState.inserts[0]
    expect(ins.table).toBe('compliance_documents')
    expect(ins.payload).toMatchObject({
      user_id: 'u-licensee',
      document_type: 'fingerprint_reprint',
      original_filename: 'cert.pdf',
      content_type: 'application/pdf',
      uploaded_by_user_id: 'u-licensee',
    })
    expect(ins.payload.storage_path).toBe(uploaded.path)
    expect(ins.payload.file_size_bytes).toBeGreaterThan(0)
    // retention_until is a date string the slot computes from
    // defaultRetentionUntil() — shape lock without pinning the day.
    expect(ins.payload.retention_until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Critically — no parent FK leaked in (this is the provider-
    // level case; the funding-documents-style funding_source_id
    // must NOT appear).
    expect(ins.payload).not.toHaveProperty('funding_source_id')
    expect(ins.payload).not.toHaveProperty('target_id')
  })

  it('rolls back the storage object if the metadata insert fails (orphan cleanup)', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    tableState.insertError = { code: '23514', message: 'CHECK violation' }

    const { container } = render(
      <ComplianceDocumentSlot documentType="fingerprint_reprint" />
    )
    await screen.findByLabelText(/Drop a file/i)
    const fileInput = container.querySelectorAll('input[type="file"]')[0]
    const file = new File(['x'], 'cert.pdf', { type: 'application/pdf' })

    await act(async () => {
      pickFile(fileInput, file)
    })

    // Insert was attempted but failed; the slot then issues a
    // storage.remove for the orphaned object.
    expect(tableState.inserts).toHaveLength(1)
    const removed = tableState.storageUploads.find(u => u.removed)
    expect(removed).toBeDefined()
    expect(removed.bucket).toBe('compliance-documents')
  })
})

describe('DocumentSlot — archive (Remove button) writes a soft-delete', () => {
  beforeEach(() => {
    // window.confirm is gated on user-confirmation in the slot.
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('Remove sets archived_at + archived_by on the metadata row, scoped by id; storage is NOT deleted (never-hard-delete convention)', async () => {
    // One existing doc → DocumentRow renders with View/Replace/Remove.
    tableState.fetchQueue.push({
      data: [{
        id: 'doc-99',
        user_id: 'u-licensee',
        document_type: 'fingerprint_reprint',
        original_filename: 'cert.pdf',
        storage_path: 'u-licensee/fingerprint_reprint/abc.pdf',
        uploaded_at: '2026-04-01T10:00:00Z',
        retention_until: '2030-04-01',
        archived_at: null,
      }],
      error: null,
    })
    // Refetch after archive returns empty so the UI rests in a
    // clean state.
    tableState.fetchQueue.push({ data: [], error: null })

    render(<ComplianceDocumentSlot documentType="fingerprint_reprint" />)

    await screen.findByText(/cert\.pdf/)
    const removeButton = screen.getByRole('button', { name: /remove/i })

    await act(async () => {
      fireEvent.click(removeButton)
    })

    expect(tableState.updates).toHaveLength(1)
    const upd = tableState.updates[0]
    expect(upd.table).toBe('compliance_documents')
    expect(upd.payload).toMatchObject({
      archived_by: 'u-licensee',
    })
    expect(typeof upd.payload.archived_at).toBe('string')
    expect(upd.payload.archived_at.length).toBeGreaterThan(0)
    // Scoped only by id — the slot relies on RLS for the
    // user_id check, mirroring the funding slot's pattern.
    expect(upd.eqs).toEqual([{ col: 'id', val: 'doc-99' }])

    // Never-hard-delete convention: storage.remove must NOT be
    // called on the existing object during archive (it's gated for
    // retention).
    const removed = tableState.storageUploads.find(u => u.removed)
    expect(removed).toBeUndefined()
  })
})

describe('DocumentSlot — defensive prop handling', () => {
  it('renders null when required props are missing (no crash)', () => {
    // Direct generic-slot invocation with nothing — should warn
    // (suppressed in test) and render nothing.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(<DocumentSlot />)
    expect(container.textContent).toBe('')
    warnSpy.mockRestore()
  })

  it('ComplianceDocumentSlot returns null for an unknown documentType (catalog gate)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <ComplianceDocumentSlot documentType="not_a_real_type" />
    )
    expect(container.textContent).toBe('')
    warnSpy.mockRestore()
  })
})

// -----------------------------------------------------------------------------
// mig 040 — provider-entered next-due date for cycle types
// -----------------------------------------------------------------------------

describe('DocumentSlot — mig 040 due-date capture (cycle types)', () => {
  it('cycle types render a "Next ... due" date input above the dropzone — radon', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    render(<ComplianceDocumentSlot documentType="property_radon_test" />)
    expect(await screen.findByLabelText(/next radon test due/i)).toBeTruthy()
  })

  it('cycle types render a "Next ... due" date input above the dropzone — heating', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    render(<ComplianceDocumentSlot documentType="property_heating_inspection" />)
    expect(await screen.findByLabelText(/next heating inspection due/i)).toBeTruthy()
  })

  it('non-cycle types do NOT render the date input (fingerprint + notebook unregressed)', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    render(<ComplianceDocumentSlot documentType="fingerprint_reprint" />)
    await screen.findByLabelText(/drop a file/i)
    expect(screen.queryByLabelText(/next .* due/i)).toBeNull()

    cleanup()
    tableState.fetchQueue.push({ data: [], error: null })
    render(<ComplianceDocumentSlot documentType="property_licensing_notebook" />)
    await screen.findByLabelText(/drop a file/i)
    expect(screen.queryByLabelText(/next .* due/i)).toBeNull()
  })

  it('cycle upload writes next_due_on on the insert payload (the migration-040 contract)', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    tableState.fetchQueue.push({
      data: [{ id: 'd-1', document_type: 'property_radon_test', uploaded_at: '2026-06-14T00:00:00Z', archived_at: null, next_due_on: '2030-06-15' }],
      error: null,
    })

    const { container } = render(
      <ComplianceDocumentSlot documentType="property_radon_test" />
    )
    const dateInput = await screen.findByLabelText(/next radon test due/i)
    fireEvent.change(dateInput, { target: { value: '2030-06-15' } })

    const fileInputs = container.querySelectorAll('input[type="file"]')
    const file = new File(['radon-report-bytes'], 'radon.pdf', { type: 'application/pdf' })
    await act(async () => {
      pickFile(fileInputs[0], file)
    })

    expect(tableState.inserts).toHaveLength(1)
    expect(tableState.inserts[0].payload).toMatchObject({
      document_type: 'property_radon_test',
      next_due_on: '2030-06-15',
    })
  })

  it('cycle upload BLOCKS when the date input is empty — no storage upload, no metadata insert, error surfaced', async () => {
    tableState.fetchQueue.push({ data: [], error: null })

    const { container } = render(
      <ComplianceDocumentSlot documentType="property_radon_test" />
    )
    // Don't fill the date — go straight to the file picker.
    await screen.findByLabelText(/next radon test due/i)
    const fileInputs = container.querySelectorAll('input[type="file"]')
    const file = new File(['x'], 'radon.pdf', { type: 'application/pdf' })
    await act(async () => {
      pickFile(fileInputs[0], file)
    })

    // Nothing reached the wire — the guard fires client-side.
    expect(tableState.storageUploads).toHaveLength(0)
    expect(tableState.inserts).toHaveLength(0)

    // The provider gets a date-required message they can act on.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent || '').toMatch(/next-due date|due date/i)
  })

  it('non-cycle upload (fingerprint) does NOT write next_due_on on the insert payload (regression lock)', async () => {
    tableState.fetchQueue.push({ data: [], error: null })
    tableState.fetchQueue.push({ data: [], error: null })

    const { container } = render(
      <ComplianceDocumentSlot documentType="fingerprint_reprint" />
    )
    await screen.findByLabelText(/drop a file/i)
    const fileInputs = container.querySelectorAll('input[type="file"]')
    const file = new File(['cert-bytes'], 'cert.pdf', { type: 'application/pdf' })
    await act(async () => {
      pickFile(fileInputs[0], file)
    })

    expect(tableState.inserts).toHaveLength(1)
    expect(tableState.inserts[0].payload).not.toHaveProperty('next_due_on')
  })

  it('cycle slot pre-fills the date input from the active doc\'s next_due_on (Replace UX)', async () => {
    tableState.fetchQueue.push({
      data: [{
        id: 'd-pref',
        document_type: 'property_radon_test',
        original_filename: 'radon.pdf',
        storage_path: 'u-licensee/property_radon_test/x.pdf',
        uploaded_at: '2026-06-14T10:00:00Z',
        retention_until: '2030-06-14',
        archived_at: null,
        next_due_on: '2030-06-15',
      }],
      error: null,
    })

    render(<ComplianceDocumentSlot documentType="property_radon_test" />)
    const dateInput = await screen.findByLabelText(/next radon test due/i)
    // The pre-fill flows through the documents-watching useEffect; the
    // input's value mirrors the active doc's next_due_on so a Replace
    // doesn't force the provider to retype.
    await new Promise(r => setTimeout(r, 0))
    expect(dateInput.value).toBe('2030-06-15')
  })
})
