import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors the Supabase-mock pattern from childFiles.test.js +
// medication.test.js: a per-table fluent chain records inserts +
// updates and returns configured `data` / `error` per table on
// terminal awaits.

const mockState = {
  inserts: [],          // { table, rows }[]
  updates: [],          // { table, patch, filters }[]
  storageUploads: [],   // { bucket, path }[]
  storageRemoves: [],   // { bucket, paths }[]
  selectByTable: {
    consent_attachments: { data: [], error: null },
    acknowledgments: { data: [], error: null },
    medication_authorizations: { data: [], error: null },
  },
  insertErrorByTable: {
    consent_attachments: null,
    acknowledgments: null,
    medication_authorizations: null,
  },
  updateErrorByTable: {
    consent_attachments: null,
  },
  storageUploadError: null,
  storageSignedUrl: 'https://signed.example/url',
  storageSignedUrlError: null,
}

function tableChain(table) {
  let pendingInsertRows = null
  let pendingUpdatePatch = null
  let pendingSingle = false
  const filters = []
  let limitN = null
  const chain = {
    select() { return chain },
    insert(rows) {
      pendingInsertRows = Array.isArray(rows) ? rows : [rows]
      mockState.inserts.push({ table, rows: pendingInsertRows })
      return chain
    },
    update(patch) {
      pendingUpdatePatch = patch
      return chain
    },
    eq(col, val) { filters.push({ col, val }); return chain },
    in(col, vals) { filters.push({ col, in: vals }); return chain },
    is(col, val) { filters.push({ col, is: val }); return chain },
    order() { return chain },
    limit(n) { limitN = n; return chain },
    maybeSingle() { pendingSingle = true; return chain },
    then(resolve, reject) {
      let data = null, error = null
      if (pendingInsertRows) {
        const err = mockState.insertErrorByTable[table]
        if (err) { error = err; data = null }
        else { data = pendingSingle ? (pendingInsertRows[0] || null) : pendingInsertRows }
      } else if (pendingUpdatePatch) {
        const err = mockState.updateErrorByTable[table]
        mockState.updates.push({ table, patch: pendingUpdatePatch, filters: filters.slice() })
        error = err; data = null
      } else {
        const cfg = mockState.selectByTable[table] || { data: null, error: null }
        data = cfg.data; error = cfg.error
        if (limitN != null && Array.isArray(data)) data = data.slice(0, limitN)
        if (pendingSingle && Array.isArray(data)) data = data[0] || null
      }
      return Promise.resolve({ data, error }).then(resolve, reject)
    },
  }
  return chain
}

function storageChainFor(bucket) {
  return {
    upload(path /* , file, opts */) {
      mockState.storageUploads.push({ bucket, path })
      const err = mockState.storageUploadError
      return Promise.resolve({ data: err ? null : { path }, error: err })
    },
    remove(paths) {
      mockState.storageRemoves.push({ bucket, paths })
      return Promise.resolve({ data: paths.map(p => ({ name: p })), error: null })
    },
    createSignedUrl(path /* , ttl */) {
      const err = mockState.storageSignedUrlError
      const url = err ? null : mockState.storageSignedUrl
      return Promise.resolve({
        data: url ? { signedUrl: url } : null,
        error: err,
      })
    },
  }
}

vi.mock('./supabase', () => ({
  supabase: {
    from: (table) => tableChain(table),
    storage: { from: (bucket) => storageChainFor(bucket) },
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'fake.jwt' } } }),
    },
  },
}))

const {
  BUCKET,
  ALLOWED_TARGET_TYPES,
  buildStoragePath,
  validateAttachmentTarget,
  uploadConsentAttachment,
  archiveConsentAttachment,
  listConsentAttachments,
  getSignedConsentAttachmentUrl,
} = await import('./consentAttachments')

beforeEach(() => {
  mockState.inserts = []
  mockState.updates = []
  mockState.storageUploads = []
  mockState.storageRemoves = []
  mockState.selectByTable = {
    consent_attachments: { data: [], error: null },
    acknowledgments: { data: [], error: null },
    medication_authorizations: { data: [], error: null },
  }
  mockState.insertErrorByTable = {
    consent_attachments: null,
    acknowledgments: null,
    medication_authorizations: null,
  }
  mockState.updateErrorByTable = { consent_attachments: null }
  mockState.storageUploadError = null
  mockState.storageSignedUrl = 'https://signed.example/url'
  mockState.storageSignedUrlError = null
})

// File-like fixture (validateFile / buildStoragePath only read .name, .size, .type).
const fakeFile = ({ name = 'scan.pdf', size = 1024, type = 'application/pdf' } = {}) => ({
  name, size, type,
})

// ─── Constants ─────────────────────────────────────────────────────

describe('consent-attachments constants', () => {
  it('BUCKET is "consent-attachments"', () => {
    expect(BUCKET).toBe('consent-attachments')
  })

  it('ALLOWED_TARGET_TYPES enumerates exactly acknowledgment + medication_authorization', () => {
    expect([...ALLOWED_TARGET_TYPES].sort()).toEqual([
      'acknowledgment',
      'medication_authorization',
    ])
  })
})

// ─── buildStoragePath (consent-attachments-specific wrapper) ────────

describe('buildStoragePath', () => {
  const providerUserId = '00000000-0000-0000-0000-00000000aaaa'
  const targetId       = '00000000-0000-0000-0000-00000000bbbb'

  it('returns a three-segment path', () => {
    const path = buildStoragePath({ providerUserId, targetId, file: fakeFile({ name: 'scan.pdf' }) })
    expect(path.split('/')).toHaveLength(3)
  })

  it('starts with the provider auth.uid() segment (storage RLS gate)', () => {
    const path = buildStoragePath({ providerUserId, targetId, file: fakeFile({ name: 'scan.pdf' }) })
    expect(path.startsWith(`${providerUserId}/`)).toBe(true)
  })

  it('places targetId as the second segment (per-consent listing)', () => {
    const path = buildStoragePath({ providerUserId, targetId, file: fakeFile({ name: 'scan.pdf' }) })
    expect(path.split('/')[1]).toBe(targetId)
  })

  it('preserves and lowercases the file extension', () => {
    const path = buildStoragePath({ providerUserId, targetId, file: fakeFile({ name: 'Photo.HEIC' }) })
    expect(path.endsWith('.heic')).toBe(true)
  })

  it('throws on missing providerUserId, targetId, or file', () => {
    expect(() => buildStoragePath({ targetId, file: fakeFile() })).toThrow(/providerUserId/)
    expect(() => buildStoragePath({ providerUserId, file: fakeFile() })).toThrow(/targetId/)
    expect(() => buildStoragePath({ providerUserId, targetId })).toThrow(/file/)
  })
})

// ─── validateAttachmentTarget ──────────────────────────────────────

describe('validateAttachmentTarget — defense-in-depth for the polymorphic reference', () => {
  it('rejects unknown target_type', async () => {
    const r = await validateAttachmentTarget({ targetType: 'mystery', targetId: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Unknown target_type/)
  })

  it('rejects missing targetId', async () => {
    const r = await validateAttachmentTarget({ targetType: 'acknowledgment', targetId: null })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/targetId/)
  })

  it('accepts an acknowledgment that exists, is non-archived, and belongs to the provider', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'A1', archived_at: null, provider_id: 'P' }],
      error: null,
    }
    const r = await validateAttachmentTarget({
      targetType: 'acknowledgment', targetId: 'A1', providerId: 'P',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects an archived acknowledgment', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'A1', archived_at: new Date().toISOString(), provider_id: 'P' }],
      error: null,
    }
    const r = await validateAttachmentTarget({
      targetType: 'acknowledgment', targetId: 'A1', providerId: 'P',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/archived/)
  })

  it('rejects an acknowledgment belonging to a different provider (cross-tenant defense)', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'A1', archived_at: null, provider_id: 'OTHER' }],
      error: null,
    }
    const r = await validateAttachmentTarget({
      targetType: 'acknowledgment', targetId: 'A1', providerId: 'P',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/does not belong/)
  })

  it('rejects a missing acknowledgment row', async () => {
    mockState.selectByTable.acknowledgments = { data: [], error: null }
    const r = await validateAttachmentTarget({
      targetType: 'acknowledgment', targetId: 'A1', providerId: 'P',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/)
  })

  it('accepts a medication_authorization that exists, is non-archived, belongs to the provider', async () => {
    mockState.selectByTable.medication_authorizations = {
      data: [{ id: 'M1', archived_at: null, provider_id: 'P' }],
      error: null,
    }
    const r = await validateAttachmentTarget({
      targetType: 'medication_authorization', targetId: 'M1', providerId: 'P',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects a medication_authorization belonging to a different provider', async () => {
    mockState.selectByTable.medication_authorizations = {
      data: [{ id: 'M1', archived_at: null, provider_id: 'OTHER' }],
      error: null,
    }
    const r = await validateAttachmentTarget({
      targetType: 'medication_authorization', targetId: 'M1', providerId: 'P',
    })
    expect(r.ok).toBe(false)
  })
})

// ─── uploadConsentAttachment — atomic write + orphan cleanup ────────

describe('uploadConsentAttachment', () => {
  const goodArgs = () => ({
    providerUserId: 'P',
    targetType: 'acknowledgment',
    targetId: 'A1',
    file: fakeFile({ name: 'scan.pdf' }),
  })

  beforeEach(() => {
    // Default: target row exists and is owned by this provider.
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'A1', archived_at: null, provider_id: 'P' }],
      error: null,
    }
  })

  it('uploads then inserts the metadata row on the happy path', async () => {
    const { data, error } = await uploadConsentAttachment(goodArgs())
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(mockState.storageUploads).toHaveLength(1)
    expect(mockState.storageUploads[0].bucket).toBe('consent-attachments')
    expect(mockState.inserts).toHaveLength(1)
    expect(mockState.inserts[0].table).toBe('consent_attachments')
    const row = mockState.inserts[0].rows[0]
    expect(row.provider_id).toBe('P')
    expect(row.target_type).toBe('acknowledgment')
    expect(row.target_id).toBe('A1')
    expect(row.storage_path).toBe(mockState.storageUploads[0].path)
    expect(row.original_filename).toBe('scan.pdf')
    expect(row.content_type).toBe('application/pdf')
    expect(row.file_size_bytes).toBe(1024)
    expect(row.uploaded_by_user_id).toBe('P')
    expect(row.retention_until).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('storage path uses provider/uuid/target shape and the provider id is FIRST', async () => {
    await uploadConsentAttachment(goodArgs())
    const path = mockState.storageUploads[0].path
    expect(path.startsWith('P/')).toBe(true)
    expect(path.split('/')[1]).toBe('A1')
  })

  it('rejects up front if the file fails validation (no upload, no insert)', async () => {
    const { error } = await uploadConsentAttachment({
      ...goodArgs(),
      file: fakeFile({ name: 'doc.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    })
    expect(error).not.toBeNull()
    expect(mockState.storageUploads).toHaveLength(0)
    expect(mockState.inserts).toHaveLength(0)
  })

  it('rejects up front if the target validation fails (no upload, no insert)', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'A1', archived_at: null, provider_id: 'DIFFERENT' }],
      error: null,
    }
    const { error } = await uploadConsentAttachment(goodArgs())
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/does not belong/)
    expect(mockState.storageUploads).toHaveLength(0)
    expect(mockState.inserts).toHaveLength(0)
  })

  it('cleans up the orphan when metadata insert fails after a successful upload', async () => {
    mockState.insertErrorByTable.consent_attachments = {
      message: 'simulated insert failure',
    }
    const { error } = await uploadConsentAttachment(goodArgs())
    expect(error).not.toBeNull()
    expect(error.message).toBe('simulated insert failure')
    // Upload happened (and cleanup was attempted).
    expect(mockState.storageUploads).toHaveLength(1)
    expect(mockState.storageRemoves).toHaveLength(1)
    expect(mockState.storageRemoves[0].paths).toEqual([mockState.storageUploads[0].path])
  })

  it('returns the storage error WITHOUT attempting an insert if upload fails', async () => {
    mockState.storageUploadError = { message: 'upload exploded' }
    const { error } = await uploadConsentAttachment(goodArgs())
    expect(error).not.toBeNull()
    expect(mockState.storageUploads).toHaveLength(1)   // attempted
    expect(mockState.inserts).toHaveLength(0)          // never reached
    expect(mockState.storageRemoves).toHaveLength(0)   // nothing to clean up
  })

  it('defaults uploaded_by_user_id to providerUserId when omitted', async () => {
    await uploadConsentAttachment(goodArgs())
    expect(mockState.inserts[0].rows[0].uploaded_by_user_id).toBe('P')
  })

  it('honors an explicit uploaded_by_user_id', async () => {
    await uploadConsentAttachment({ ...goodArgs(), uploadedByUserId: 'STAFF1' })
    expect(mockState.inserts[0].rows[0].uploaded_by_user_id).toBe('STAFF1')
  })

  it('honors an explicit retention_until', async () => {
    await uploadConsentAttachment({ ...goodArgs(), retentionUntil: '2031-06-02' })
    expect(mockState.inserts[0].rows[0].retention_until).toBe('2031-06-02')
  })

  it('passes notes through', async () => {
    await uploadConsentAttachment({ ...goodArgs(), notes: 'Original signed at intake.' })
    expect(mockState.inserts[0].rows[0].notes).toBe('Original signed at intake.')
  })

  it('throws/returns error on missing providerUserId or file', async () => {
    const a = await uploadConsentAttachment({ targetType: 'acknowledgment', targetId: 'A1', file: fakeFile() })
    expect(a.error.message).toMatch(/providerUserId/)
    const b = await uploadConsentAttachment({ providerUserId: 'P', targetType: 'acknowledgment', targetId: 'A1' })
    expect(b.error.message).toMatch(/file/)
  })
})

// ─── archiveConsentAttachment ──────────────────────────────────────

describe('archiveConsentAttachment (soft-delete only)', () => {
  it('sets archived_at + archived_by on the targeted row', async () => {
    const { error } = await archiveConsentAttachment({
      attachmentId: 'X1',
      archivedByUserId: 'P',
    })
    expect(error).toBeNull()
    expect(mockState.updates).toHaveLength(1)
    expect(mockState.updates[0].table).toBe('consent_attachments')
    expect(mockState.updates[0].patch.archived_at).toBeTruthy()
    expect(mockState.updates[0].patch.archived_by).toBe('P')
    expect(mockState.updates[0].filters).toContainEqual({ col: 'id', val: 'X1' })
  })

  it('returns an error on missing attachmentId', async () => {
    const { error } = await archiveConsentAttachment({})
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/attachmentId/)
  })

  it('never calls storage.remove (the object survives per retention)', async () => {
    await archiveConsentAttachment({ attachmentId: 'X1', archivedByUserId: 'P' })
    expect(mockState.storageRemoves).toHaveLength(0)
  })
})

// ─── listConsentAttachments ────────────────────────────────────────

describe('listConsentAttachments', () => {
  it('returns active rows for a given consent target', async () => {
    mockState.selectByTable.consent_attachments = {
      data: [
        { id: 'a1', target_type: 'acknowledgment', target_id: 'A1', archived_at: null },
        { id: 'a2', target_type: 'acknowledgment', target_id: 'A1', archived_at: null },
      ],
      error: null,
    }
    const { data, error } = await listConsentAttachments({
      targetType: 'acknowledgment', targetId: 'A1',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it('returns empty on missing targetType/targetId', async () => {
    expect((await listConsentAttachments({ targetType: 'acknowledgment' })).data).toEqual([])
    expect((await listConsentAttachments({ targetId: 'A1' })).data).toEqual([])
  })

  it('rejects unknown target_type with an error', async () => {
    const { error } = await listConsentAttachments({
      targetType: 'mystery', targetId: 'A1',
    })
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/Unknown target_type/)
  })

  it('respects limit', async () => {
    mockState.selectByTable.consent_attachments = {
      data: Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`, target_type: 'acknowledgment', target_id: 'A1', archived_at: null,
      })),
      error: null,
    }
    const { data } = await listConsentAttachments({
      targetType: 'acknowledgment', targetId: 'A1', limit: 3,
    })
    expect(data).toHaveLength(3)
  })
})

// ─── Provider-side signed URL ──────────────────────────────────────

describe('getSignedConsentAttachmentUrl (provider-side, owner-only RLS)', () => {
  it('returns the signed URL on success', async () => {
    const url = await getSignedConsentAttachmentUrl('P/A1/scan.pdf')
    expect(url).toBe('https://signed.example/url')
  })

  it('returns null on Supabase error (e.g., RLS denial)', async () => {
    mockState.storageSignedUrlError = { message: 'denied' }
    const url = await getSignedConsentAttachmentUrl('P/A1/scan.pdf')
    expect(url).toBeNull()
  })

  it('returns null on null/empty path', async () => {
    expect(await getSignedConsentAttachmentUrl(null)).toBeNull()
    expect(await getSignedConsentAttachmentUrl('')).toBeNull()
  })
})
