import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors the Supabase-mock pattern from `medication.test.js` /
// `childFiles.test.js`. The helper under test calls
// `supabase.from('caregivers')…`; the mock records the insert and
// returns configured data/error from the chain.

const mockState = {
  // Captured inserts: { table, rows }[]
  inserts: [],
  // Per-table select result (used by .maybeSingle()).
  selectByTable: {
    caregivers: { data: null, error: null },
  },
  // Insert error per table (for unique-violation + generic-error tests).
  insertErrorByTable: {
    caregivers: null,
  },
}

function chainFor(table) {
  let pendingInsertRows = null
  const filters = []
  const chain = {
    select() { return chain },
    insert(rows) {
      pendingInsertRows = Array.isArray(rows) ? rows : [rows]
      mockState.inserts.push({ table, rows: pendingInsertRows })
      return chain
    },
    eq(col, val) { filters.push({ col, val }); return chain },
    is(col, val) { filters.push({ col, is: val }); return chain },
    maybeSingle() { chain._isMaybeSingle = true; return chain },
    then(resolve, reject) {
      let data = null, error = null
      if (pendingInsertRows) {
        const err = mockState.insertErrorByTable[table]
        if (err) {
          error = err
        } else {
          data = pendingInsertRows[0] || null
        }
      } else {
        const cfg = mockState.selectByTable[table] || { data: null, error: null }
        data = cfg.data
        error = cfg.error
      }
      return Promise.resolve({ data, error }).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('./supabase', () => ({
  supabase: { from: (table) => chainFor(table) },
}))

const { ensureLicenseeSelfCaregiverRow } = await import('./licenseeRoster')

beforeEach(() => {
  mockState.inserts = []
  mockState.selectByTable.caregivers = { data: null, error: null }
  mockState.insertErrorByTable.caregivers = null
})

const USER = {
  id: 'L1',
  email: 'venessa@example.com',
  user_metadata: { full_name: 'Venessa Provider' },
}

describe('ensureLicenseeSelfCaregiverRow', () => {
  it('inserts a self-row when none exists, using the historical 3-column shape', async () => {
    mockState.selectByTable.caregivers = { data: null, error: null }
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: USER })
    expect(error).toBeNull()
    expect(created).toBe(true)
    expect(mockState.inserts).toHaveLength(1)
    const insertedRow = mockState.inserts[0].rows[0]
    // Exact column shape — must match the historical insert in
    // useStaffTraining.js so backfill + new-create produce identical
    // rows.
    expect(Object.keys(insertedRow).sort()).toEqual(['app_user_id', 'full_name', 'licensee_id'])
    expect(insertedRow.licensee_id).toBe('L1')
    expect(insertedRow.app_user_id).toBe('L1')
    expect(insertedRow.full_name).toBe('Venessa Provider')
  })

  it('returns created=false (no insert) when the self-row already exists', async () => {
    mockState.selectByTable.caregivers = { data: { id: 'cg-existing' }, error: null }
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: USER })
    expect(error).toBeNull()
    expect(created).toBe(false)
    expect(mockState.inserts).toHaveLength(0) // steady-state path is read-only
  })

  it('full_name falls back to user.email when user_metadata.full_name is absent', async () => {
    const userNoMeta = { id: 'L2', email: 'jane@example.com', user_metadata: {} }
    await ensureLicenseeSelfCaregiverRow({ user: userNoMeta })
    expect(mockState.inserts[0].rows[0].full_name).toBe('jane@example.com')
  })

  it('full_name falls back to "You (licensee)" when both metadata and email are missing', async () => {
    const userBare = { id: 'L3' }
    await ensureLicenseeSelfCaregiverRow({ user: userBare })
    expect(mockState.inserts[0].rows[0].full_name).toBe('You (licensee)')
  })

  // 2026-06-18 Step 2 review — JS fallback chain must match mig 046's
  // SQL idiom byte-for-byte: `coalesce(nullif(trim(full_name), ''),
  // email, 'You (licensee)')`. The trim + nullif applies ONLY to the
  // first candidate (user_metadata.full_name); the email and literal
  // fallback are passed through as-is.

  it('whitespace-only user_metadata.full_name falls THROUGH to email (not stored as blank)', async () => {
    const userBlankName = { id: 'L4', email: 'venessa@example.com', user_metadata: { full_name: '   ' } }
    await ensureLicenseeSelfCaregiverRow({ user: userBlankName })
    // Without the trim, this would have inserted '   ' as the visible
    // roster label. The trim collapses it to empty, so the chain
    // falls through to email.
    expect(mockState.inserts[0].rows[0].full_name).toBe('venessa@example.com')
  })

  it('empty-string user_metadata.full_name falls through to email', async () => {
    const userEmptyName = { id: 'L5', email: 'venessa@example.com', user_metadata: { full_name: '' } }
    await ensureLicenseeSelfCaregiverRow({ user: userEmptyName })
    expect(mockState.inserts[0].rows[0].full_name).toBe('venessa@example.com')
  })

  it('whitespace-padded user_metadata.full_name is stored TRIMMED', async () => {
    // Matches the SQL: `trim(full_name)` produces the trimmed value
    // before the nullif check, so a padded name is stored without
    // its padding. (The SQL stores the trimmed value, not the raw.)
    const userPaddedName = { id: 'L6', email: 'x@y.com', user_metadata: { full_name: '  Venessa Provider  ' } }
    await ensureLicenseeSelfCaregiverRow({ user: userPaddedName })
    expect(mockState.inserts[0].rows[0].full_name).toBe('Venessa Provider')
  })

  it('non-string user_metadata.full_name (defensive — never expected, but possible if the auth payload is corrupt) falls through to email', async () => {
    const userCorrupt = { id: 'L7', email: 'x@y.com', user_metadata: { full_name: 12345 } }
    await ensureLicenseeSelfCaregiverRow({ user: userCorrupt })
    expect(mockState.inserts[0].rows[0].full_name).toBe('x@y.com')
  })

  it('treats a unique-violation (23505) as benign — the desired end state is already true', async () => {
    // Concurrent path: the SELECT showed no row, but by the time the
    // INSERT fired (e.g. another tab / the backfill migration), the
    // row had been created. The unique constraint rejects the
    // duplicate — we report created=false / error=null because the
    // end state matches the caller's intent.
    mockState.selectByTable.caregivers = { data: null, error: null }
    mockState.insertErrorByTable.caregivers = { code: '23505', message: 'duplicate key value violates unique constraint' }
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: USER })
    expect(error).toBeNull()
    expect(created).toBe(false)
  })

  it('surfaces a SELECT error (non-23505) instead of attempting the insert', async () => {
    mockState.selectByTable.caregivers = { data: null, error: { code: 'PGRST301', message: 'rls denied' } }
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: USER })
    expect(error).not.toBeNull()
    expect(error.code).toBe('PGRST301')
    expect(created).toBe(false)
    expect(mockState.inserts).toHaveLength(0)
  })

  it('surfaces a non-23505 INSERT error (e.g. RLS, NOT NULL) — does not swallow', async () => {
    mockState.selectByTable.caregivers = { data: null, error: null }
    mockState.insertErrorByTable.caregivers = { code: '23502', message: 'NOT NULL violation' }
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: USER })
    expect(error).not.toBeNull()
    expect(error.code).toBe('23502')
    expect(created).toBe(false)
  })

  it('refuses to act without a user.id (defensive)', async () => {
    const { created, error } = await ensureLicenseeSelfCaregiverRow({ user: null })
    expect(created).toBe(false)
    expect(error).toBeInstanceOf(Error)
    expect(mockState.inserts).toHaveLength(0)

    const r2 = await ensureLicenseeSelfCaregiverRow({})
    expect(r2.created).toBe(false)
    expect(r2.error).toBeInstanceOf(Error)
    expect(mockState.inserts).toHaveLength(0)

    const r3 = await ensureLicenseeSelfCaregiverRow({ user: { email: 'x' } })  // no id
    expect(r3.created).toBe(false)
    expect(r3.error).toBeInstanceOf(Error)
    expect(mockState.inserts).toHaveLength(0)
  })

  it('matches the historical useStaffTraining create exactly (insert-shape regression lock)', async () => {
    // Locks the rule that the relocated create + the mig 046 backfill
    // produce rows indistinguishable from the historical mount-time
    // create. If this assertion fails, the migration runbook entry
    // for 046 needs to be re-validated against the new shape.
    mockState.selectByTable.caregivers = { data: null, error: null }
    await ensureLicenseeSelfCaregiverRow({ user: USER })
    const inserted = mockState.inserts[0].rows[0]
    // No date_of_hire, no email, no archived_at, no created_at, no
    // updated_at — those use table defaults. Same as the pre-2026-06-18
    // useStaffTraining.js insert.
    expect(inserted).toEqual({
      licensee_id: 'L1',
      app_user_id: 'L1',
      full_name: 'Venessa Provider',
    })
  })
})
