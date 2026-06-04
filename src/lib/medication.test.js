import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mirrors the Supabase-mock pattern from `childFiles.test.js`. The
// helpers under test call `supabase.from(table)…`; the mock state
// records inserts/updates and returns the configured `data` /
// `error` per table.

const mockState = {
  // Per-table insert capture for assertions.
  inserts: [],          // { table, rows: object[] }[]
  updates: [],          // { table, patch, filters: {col:val}[] }[]
  // Per-table fetch state. The chain returns `data` / `error` from
  // here based on the last `from(table)` call.
  selectByTable: {
    medication_authorizations: { data: [], error: null },
    medication_administration_events: { data: [], error: null },
  },
  // The result returned from .select().maybeSingle() chained AFTER
  // an insert (Supabase returns the inserted row). We default to
  // echoing the first row from the most recent insert.
  insertEcho: true,
  // Error to return from inserts (simulates trigger / RLS rejection).
  insertErrorByTable: {
    medication_authorizations: null,
    medication_administration_events: null,
  },
  updateErrorByTable: {
    medication_authorizations: null,
    medication_administration_events: null,
  },
}

function chainFor(table) {
  // Track the last set of insert rows / update patch so the
  // terminal .maybeSingle() / .then() resolution can return them.
  let pendingInsertRows = null
  let pendingUpdatePatch = null
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
    maybeSingle() { chain._isMaybeSingle = true; return chain },
    then(resolve, reject) {
      let data = null, error = null
      if (pendingInsertRows) {
        const err = mockState.insertErrorByTable[table]
        if (err) {
          data = null
          error = err
        } else {
          data = mockState.insertEcho ? (pendingInsertRows[0] || null) : null
        }
      } else if (pendingUpdatePatch) {
        const err = mockState.updateErrorByTable[table]
        mockState.updates.push({ table, patch: pendingUpdatePatch, filters: filters.slice() })
        error = err
        data = null
      } else {
        const cfg = mockState.selectByTable[table] || { data: null, error: null }
        data = cfg.data
        error = cfg.error
        if (limitN != null && Array.isArray(data)) data = data.slice(0, limitN)
      }
      return Promise.resolve({ data, error }).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('./supabase', () => ({
  supabase: { from: (table) => chainFor(table) },
}))

const {
  ELIGIBLE_ADMINISTERING_ROLES,
  buildMedicationPermissionPayload,
  computeMedicationPermissionHash,
  isTopicalOtcExempt,
  mayAdminister,
  getDoseLogState,
  createMedicationAuthorization,
  archiveMedicationAuthorization,
  recordDoseEvent,
  archiveDoseEvent,
  listActiveAuthorizationsForChild,
  listActiveEventsForAuthorization,
  // Part 2 helpers (PR #20 UI surface) — caregiver roster, eligibility
  // filter, consent capture, consent fetch, consent satisfaction.
  listCaregiversWithRoles,
  eligibleCaregiversForAdministration,
  recordMedicationPermission,
  recordOtcBlanketPermission,
  listMedicationConsentsForChild,
  medicationConsentSatisfied,
} = await import('./medication')

beforeEach(() => {
  mockState.inserts = []
  mockState.updates = []
  mockState.selectByTable = {
    medication_authorizations: { data: [], error: null },
    medication_administration_events: { data: [], error: null },
    caregivers: { data: [], error: null },
    caregiver_regulatory_roles: { data: [], error: null },
    acknowledgments: { data: [], error: null },
  }
  mockState.insertEcho = true
  mockState.insertErrorByTable = {
    medication_authorizations: null,
    medication_administration_events: null,
    acknowledgments: null,
  }
  mockState.updateErrorByTable = {
    medication_authorizations: null,
    medication_administration_events: null,
    acknowledgments: null,
  }
})

// ─── Eligible-role whitelist constant ──────────────────────────────

describe('ELIGIBLE_ADMINISTERING_ROLES', () => {
  it('enumerates exactly licensee + child_care_staff_member (R 400.1931(1))', () => {
    expect([...ELIGIBLE_ADMINISTERING_ROLES].sort()).toEqual([
      'child_care_staff_member',
      'licensee',
    ])
  })

  it('does NOT include child_care_assistant (R 400.1931(1) explicitly prohibits)', () => {
    expect(ELIGIBLE_ADMINISTERING_ROLES).not.toContain('child_care_assistant')
  })

  it('does NOT include supervised_volunteer (R 400.1931(1) explicitly prohibits)', () => {
    expect(ELIGIBLE_ADMINISTERING_ROLES).not.toContain('supervised_volunteer')
  })

  it('does NOT include unsupervised_volunteer or driver (only the listed two are eligible)', () => {
    expect(ELIGIBLE_ADMINISTERING_ROLES).not.toContain('unsupervised_volunteer')
    expect(ELIGIBLE_ADMINISTERING_ROLES).not.toContain('driver')
  })
})

// ─── isTopicalOtcExempt ─────────────────────────────────────────────

describe('isTopicalOtcExempt (R 400.1931(8))', () => {
  it('true when authorization.is_topical_otc=true', () => {
    expect(isTopicalOtcExempt({ is_topical_otc: true })).toBe(true)
  })
  it('false when authorization.is_topical_otc=false', () => {
    expect(isTopicalOtcExempt({ is_topical_otc: false })).toBe(false)
  })
  it('false when authorization is null/undefined (safe-by-default)', () => {
    expect(isTopicalOtcExempt(null)).toBe(false)
    expect(isTopicalOtcExempt(undefined)).toBe(false)
  })
  it('false when is_topical_otc is missing (treated as not-OTC)', () => {
    expect(isTopicalOtcExempt({})).toBe(false)
  })
})

// ─── mayAdminister (UI affordance — DB trigger is authoritative) ────

describe('mayAdminister', () => {
  it('true for licensee on a NON-OTC authorization', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['licensee'] },
      authorization: { is_topical_otc: false },
    })).toBe(true)
  })

  it('true for child_care_staff_member on a NON-OTC authorization', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['child_care_staff_member'] },
      authorization: { is_topical_otc: false },
    })).toBe(true)
  })

  it('FALSE for child_care_assistant on a NON-OTC authorization (R 400.1931(1))', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['child_care_assistant'] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })

  it('FALSE for supervised_volunteer on a NON-OTC authorization (R 400.1931(1))', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['supervised_volunteer'] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })

  it('FALSE for unsupervised_volunteer (not in eligible list)', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['unsupervised_volunteer'] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })

  it('FALSE for driver (not in eligible list)', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['driver'] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })

  it('FALSE for caregiver with no regulatory_roles at all', () => {
    expect(mayAdminister({
      caregiver: { regulatory_roles: [] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
    expect(mayAdminister({
      caregiver: { },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })

  it('TRUE for ANY caregiver when authorization is topical OTC (R 400.1931(8))', () => {
    // (8) exempts topical OTC from (1) — any caregiver, including
    // assistants and supervised volunteers, may apply sunscreen /
    // repellent / diaper rash cream.
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['child_care_assistant'] },
      authorization: { is_topical_otc: true },
    })).toBe(true)
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['supervised_volunteer'] },
      authorization: { is_topical_otc: true },
    })).toBe(true)
    expect(mayAdminister({
      caregiver: { regulatory_roles: [] },
      authorization: { is_topical_otc: true },
    })).toBe(true)
  })

  it('accepts caregiver with multi-role (eligible if ANY role qualifies)', () => {
    // A caregiver who is BOTH a child_care_assistant AND a
    // licensee (rare in practice but possible per the schema)
    // qualifies via their licensee role.
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['child_care_assistant', 'licensee'] },
      authorization: { is_topical_otc: false },
    })).toBe(true)
  })

  it('accepts the raw-join shape (caregiver_regulatory_roles array)', () => {
    expect(mayAdminister({
      caregiver: { caregiver_regulatory_roles: [{ regulatory_role: 'licensee' }] },
      authorization: { is_topical_otc: false },
    })).toBe(true)
    expect(mayAdminister({
      caregiver: { caregiver_regulatory_roles: [{ regulatory_role: 'child_care_assistant' }] },
      authorization: { is_topical_otc: false },
    })).toBe(false)
  })
})

// ─── buildMedicationPermissionPayload + hash ────────────────────────

describe('buildMedicationPermissionPayload (single source of truth for the per-authorization ack)', () => {
  it('returns the canonical shape with every documented field', () => {
    const out = buildMedicationPermissionPayload({
      authorization: {
        medication_name: 'Children\'s Tylenol',
        dose_text: '5 mL',
        schedule_text: 'every 6 hours as needed',
        prescriber_name: 'Dr. Smith',
        is_topical_otc: false,
        starts_on: '2026-06-01',
        ends_on: null,
        original_container_confirmed: true,
      },
    })
    expect(out).toEqual({
      medication_name: 'Children\'s Tylenol',
      dose_text: '5 mL',
      schedule_text: 'every 6 hours as needed',
      prescriber_name: 'Dr. Smith',
      is_topical_otc: false,
      starts_on: '2026-06-01',
      ends_on: null,
      original_container_confirmed: true,
    })
  })

  it('throws when authorization is missing', () => {
    expect(() => buildMedicationPermissionPayload()).toThrow(/authorization/)
    expect(() => buildMedicationPermissionPayload({})).toThrow(/authorization/)
  })

  it('coerces optional fields to safe defaults', () => {
    const out = buildMedicationPermissionPayload({
      authorization: { medication_name: 'X' },
    })
    expect(out.medication_name).toBe('X')
    expect(out.dose_text).toBe('')
    expect(out.is_topical_otc).toBe(false)
    expect(out.starts_on).toBe(null)
    expect(out.original_container_confirmed).toBe(false)
  })
})

describe('computeMedicationPermissionHash', () => {
  it('returns a stable 8-char hex for the same input', () => {
    const h1 = computeMedicationPermissionHash({
      authorization: {
        medication_name: 'Tylenol', dose_text: '5 mL', schedule_text: 'q6h',
        prescriber_name: 'Dr. Smith', is_topical_otc: false,
      },
    })
    const h2 = computeMedicationPermissionHash({
      authorization: {
        medication_name: 'Tylenol', dose_text: '5 mL', schedule_text: 'q6h',
        prescriber_name: 'Dr. Smith', is_topical_otc: false,
      },
    })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when dose_text changes (drift detection)', () => {
    const h1 = computeMedicationPermissionHash({
      authorization: { medication_name: 'X', dose_text: '5 mL' },
    })
    const h2 = computeMedicationPermissionHash({
      authorization: { medication_name: 'X', dose_text: '10 mL' },
    })
    expect(h1).not.toBe(h2)
  })

  it('changes when is_topical_otc flips', () => {
    const h1 = computeMedicationPermissionHash({
      authorization: { medication_name: 'X', is_topical_otc: false },
    })
    const h2 = computeMedicationPermissionHash({
      authorization: { medication_name: 'X', is_topical_otc: true },
    })
    expect(h1).not.toBe(h2)
  })
})

// ─── getDoseLogState ────────────────────────────────────────────────

describe('getDoseLogState', () => {
  it('topical OTC: doseLogRequired=false, roleGateApplies=false (R 400.1931(8))', () => {
    const s = getDoseLogState({
      authorization: { is_topical_otc: true, medication_name: 'Sunscreen' },
      events: [],
    })
    expect(s.isTopicalOtc).toBe(true)
    expect(s.doseLogRequired).toBe(false)
    expect(s.roleGateApplies).toBe(false)
  })

  it('non-OTC: doseLogRequired=true, roleGateApplies=true', () => {
    const s = getDoseLogState({
      authorization: { is_topical_otc: false, medication_name: 'Tylenol' },
      events: [],
    })
    expect(s.doseLogRequired).toBe(true)
    expect(s.roleGateApplies).toBe(true)
  })

  it('counts non-archived events; reports last administered timestamp', () => {
    const s = getDoseLogState({
      authorization: { medication_name: 'X' },
      events: [
        { administered_at: '2026-06-02T08:00:00Z', archived_at: null },
        { administered_at: '2026-06-02T14:00:00Z', archived_at: null },
        { administered_at: '2026-06-02T20:00:00Z', archived_at: '2026-06-02T20:01:00Z' }, // archived → excluded
      ],
    })
    expect(s.eventCount).toBe(2)
    expect(s.lastAdministeredAt).toBe('2026-06-02T14:00:00Z')
  })

  it('dosesInLast24Hours respects the 24-hour window (uses real Date.now)', () => {
    const now = Date.now()
    const inWindow = new Date(now - 6 * 60 * 60 * 1000).toISOString()  // 6h ago
    const outOfWindow = new Date(now - 30 * 60 * 60 * 1000).toISOString()  // 30h ago
    const s = getDoseLogState({
      authorization: { medication_name: 'X' },
      events: [
        { administered_at: inWindow, archived_at: null },
        { administered_at: outOfWindow, archived_at: null },
      ],
    })
    expect(s.dosesInLast24Hours).toBe(1)
  })

  it('needsReacknowledgment: false when no permission ack on file', () => {
    const s = getDoseLogState({
      authorization: { medication_name: 'X', dose_text: '5 mL' },
      events: [],
      activePermissionAck: null,
    })
    expect(s.permissionOnFile).toBe(false)
    expect(s.needsReacknowledgment).toBe(false)
  })

  it('needsReacknowledgment: false when stored hash matches current authorization', () => {
    const authorization = {
      medication_name: 'X', dose_text: '5 mL', schedule_text: 'q6h',
      prescriber_name: 'Dr. Smith', is_topical_otc: false,
    }
    const currentHash = computeMedicationPermissionHash({ authorization })
    const s = getDoseLogState({
      authorization,
      events: [],
      activePermissionAck: { snapshot_hash: currentHash, archived_at: null },
    })
    expect(s.permissionOnFile).toBe(true)
    expect(s.needsReacknowledgment).toBe(false)
  })

  it('needsReacknowledgment: TRUE when stored hash differs from current (drift detected)', () => {
    const authorization = {
      medication_name: 'X', dose_text: '10 mL',
    }
    const s = getDoseLogState({
      authorization,
      events: [],
      activePermissionAck: { snapshot_hash: 'staledead', archived_at: null },
    })
    expect(s.needsReacknowledgment).toBe(true)
  })

  it('archived permission ack is not counted as on-file', () => {
    const s = getDoseLogState({
      authorization: { medication_name: 'X' },
      events: [],
      activePermissionAck: { snapshot_hash: 'abc', archived_at: new Date().toISOString() },
    })
    expect(s.permissionOnFile).toBe(false)
  })
})

// ─── createMedicationAuthorization ──────────────────────────────────

describe('createMedicationAuthorization', () => {
  it('inserts the row with required + defaulted fields', async () => {
    await createMedicationAuthorization({
      providerId: 'P', childId: 'C',
      fields: { medication_name: '  Tylenol  ', dose_text: '5 mL', is_topical_otc: false },
    })
    expect(mockState.inserts).toHaveLength(1)
    expect(mockState.inserts[0].table).toBe('medication_authorizations')
    const row = mockState.inserts[0].rows[0]
    expect(row.provider_id).toBe('P')
    expect(row.child_id).toBe('C')
    expect(row.medication_name).toBe('Tylenol')   // trimmed
    expect(row.dose_text).toBe('5 mL')
    expect(row.is_topical_otc).toBe(false)
    expect(row.original_container_confirmed).toBe(false)   // default
  })

  it('throws on missing required args', async () => {
    await expect(createMedicationAuthorization({ childId: 'C', fields: { medication_name: 'X' } }))
      .rejects.toThrow(/providerId/)
    await expect(createMedicationAuthorization({ providerId: 'P', fields: { medication_name: 'X' } }))
      .rejects.toThrow(/childId/)
    await expect(createMedicationAuthorization({ providerId: 'P', childId: 'C', fields: {} }))
      .rejects.toThrow(/medication_name/)
    await expect(createMedicationAuthorization({ providerId: 'P', childId: 'C', fields: { medication_name: '   ' } }))
      .rejects.toThrow(/medication_name/)
  })

  it('surfaces a unique-violation error from the DB (per-child, per-medication uniqueness)', async () => {
    mockState.insertErrorByTable.medication_authorizations = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_med_auth_active_per_child_med"',
    }
    const { data, error } = await createMedicationAuthorization({
      providerId: 'P', childId: 'C',
      fields: { medication_name: 'Tylenol' },
    })
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error.code).toBe('23505')
  })

  it('topical OTC authorization sets is_topical_otc=true', async () => {
    await createMedicationAuthorization({
      providerId: 'P', childId: 'C',
      fields: { medication_name: 'Sunscreen', is_topical_otc: true },
    })
    expect(mockState.inserts[0].rows[0].is_topical_otc).toBe(true)
  })
})

// ─── archiveMedicationAuthorization ─────────────────────────────────

describe('archiveMedicationAuthorization', () => {
  it('sets archived_at on the targeted row (soft-delete)', async () => {
    await archiveMedicationAuthorization({ authorizationId: 'A1' })
    expect(mockState.updates).toHaveLength(1)
    expect(mockState.updates[0].table).toBe('medication_authorizations')
    expect(mockState.updates[0].patch.archived_at).toBeTruthy()
    expect(mockState.updates[0].filters).toContainEqual({ col: 'id', val: 'A1' })
  })

  it('throws on missing authorizationId', async () => {
    await expect(archiveMedicationAuthorization({}))
      .rejects.toThrow(/authorizationId/)
  })
})

// ─── recordDoseEvent ────────────────────────────────────────────────

describe('recordDoseEvent', () => {
  it('inserts an event with the required fields', async () => {
    await recordDoseEvent({
      providerId: 'P',
      authorizationId: 'A',
      childId: 'C',
      administeredByCaregiverId: 'CG',
      administeredAt: '2026-06-02T10:00:00Z',
      doseAdministeredText: '5 mL',
    })
    expect(mockState.inserts).toHaveLength(1)
    expect(mockState.inserts[0].table).toBe('medication_administration_events')
    const row = mockState.inserts[0].rows[0]
    expect(row.provider_id).toBe('P')
    expect(row.authorization_id).toBe('A')
    expect(row.child_id).toBe('C')
    expect(row.administered_by_caregiver_id).toBe('CG')
    expect(row.administered_at).toBe('2026-06-02T10:00:00Z')
    expect(row.dose_administered_text).toBe('5 mL')
  })

  it('throws on every missing required arg', async () => {
    await expect(recordDoseEvent({
      authorizationId: 'A', childId: 'C', administeredByCaregiverId: 'CG',
    })).rejects.toThrow(/providerId/)
    await expect(recordDoseEvent({
      providerId: 'P', childId: 'C', administeredByCaregiverId: 'CG',
    })).rejects.toThrow(/authorizationId/)
    await expect(recordDoseEvent({
      providerId: 'P', authorizationId: 'A', administeredByCaregiverId: 'CG',
    })).rejects.toThrow(/childId/)
    await expect(recordDoseEvent({
      providerId: 'P', authorizationId: 'A', childId: 'C',
    })).rejects.toThrow(/administeredByCaregiverId/)
  })

  it('surfaces the DB trigger\'s rejection (the legally-consequential path)', async () => {
    // Simulates the role-gate trigger rejecting an
    // administered_by_caregiver_id whose role is child_care_assistant.
    mockState.insertErrorByTable.medication_administration_events = {
      code: 'P0001',
      message: 'Only licensee or child care staff member may administer medication (R 400.1931(1))',
    }
    const { data, error } = await recordDoseEvent({
      providerId: 'P', authorizationId: 'A', childId: 'C',
      administeredByCaregiverId: 'CG-assistant',
    })
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/R 400\.1931/)
  })

  it('defaults administered_at to now() when omitted', async () => {
    const before = Date.now()
    await recordDoseEvent({
      providerId: 'P', authorizationId: 'A', childId: 'C',
      administeredByCaregiverId: 'CG',
    })
    const after = Date.now()
    const row = mockState.inserts[0].rows[0]
    const ms = Date.parse(row.administered_at)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })
})

// ─── archiveDoseEvent ───────────────────────────────────────────────

describe('archiveDoseEvent', () => {
  it('sets archived_at on the targeted event', async () => {
    await archiveDoseEvent({ eventId: 'E1' })
    expect(mockState.updates).toHaveLength(1)
    expect(mockState.updates[0].table).toBe('medication_administration_events')
    expect(mockState.updates[0].filters).toContainEqual({ col: 'id', val: 'E1' })
  })

  it('throws on missing eventId', async () => {
    await expect(archiveDoseEvent({})).rejects.toThrow(/eventId/)
  })
})

// ─── List fetchers ─────────────────────────────────────────────────

describe('listActiveAuthorizationsForChild', () => {
  it('returns the data array from Supabase for the child', async () => {
    mockState.selectByTable.medication_authorizations = {
      data: [
        { id: 'A1', medication_name: 'Tylenol', is_topical_otc: false, archived_at: null },
        { id: 'A2', medication_name: 'Sunscreen', is_topical_otc: true, archived_at: null },
      ],
      error: null,
    }
    const { data, error } = await listActiveAuthorizationsForChild({ providerId: 'P', childId: 'C' })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
  })

  it('returns empty array on missing args', async () => {
    expect((await listActiveAuthorizationsForChild({ providerId: 'P' })).data).toEqual([])
    expect((await listActiveAuthorizationsForChild({ childId: 'C' })).data).toEqual([])
  })
})

describe('listActiveEventsForAuthorization', () => {
  it('returns the events for the authorization', async () => {
    mockState.selectByTable.medication_administration_events = {
      data: [
        { id: 'E1', authorization_id: 'A', administered_at: '2026-06-02T10:00:00Z' },
        { id: 'E2', authorization_id: 'A', administered_at: '2026-06-01T10:00:00Z' },
      ],
      error: null,
    }
    const { data } = await listActiveEventsForAuthorization({ authorizationId: 'A' })
    expect(data).toHaveLength(2)
  })

  it('respects limit', async () => {
    mockState.selectByTable.medication_administration_events = {
      data: Array.from({ length: 10 }, (_, i) => ({ id: `E${i}`, authorization_id: 'A' })),
      error: null,
    }
    const { data } = await listActiveEventsForAuthorization({ authorizationId: 'A', limit: 3 })
    expect(data).toHaveLength(3)
  })

  it('empty on missing authorizationId', async () => {
    const { data } = await listActiveEventsForAuthorization({})
    expect(data).toEqual([])
  })
})

// ─── Topical-OTC end-to-end branch (R 400.1931(8) full scenario) ───

describe('Topical OTC (R 400.1931(8)) — full data-layer branch', () => {
  it('OTC authorization can be created, parent permission rides the existing OTC-blanket ACK_TYPE, dose log is OPTIONAL', async () => {
    // (1) Create the authorization as is_topical_otc=true.
    await createMedicationAuthorization({
      providerId: 'P', childId: 'C',
      fields: {
        medication_name: 'Diaper rash ointment',
        is_topical_otc: true,
        original_container_confirmed: true,
      },
    })
    expect(mockState.inserts[0].rows[0].is_topical_otc).toBe(true)

    // (2) The dose-log state reports it as exempt from (1) AND (7).
    //     doseLogRequired=false, roleGateApplies=false.
    const state = getDoseLogState({
      authorization: { is_topical_otc: true, medication_name: 'Diaper rash ointment' },
      events: [],
    })
    expect(state.doseLogRequired).toBe(false)
    expect(state.roleGateApplies).toBe(false)

    // (3) mayAdminister returns true for ANY caregiver on OTC.
    expect(mayAdminister({
      caregiver: { regulatory_roles: ['child_care_assistant'] },
      authorization: { is_topical_otc: true },
    })).toBe(true)
  })
})

// ─── Part 2 (UI surface) helpers ──────────────────────────────────

describe('listCaregiversWithRoles', () => {
  it('returns caregivers with their regulatory_roles attached as arrays', async () => {
    mockState.selectByTable.caregivers = {
      data: [
        { id: 'cg-1', licensee_id: 'L', app_user_id: 'L',   full_name: 'Owner Bob',   archived_at: null },
        { id: 'cg-2', licensee_id: 'L', app_user_id: 'U2',  full_name: 'Staff Sue',   archived_at: null },
        { id: 'cg-3', licensee_id: 'L', app_user_id: 'U3',  full_name: 'Helper Henry', archived_at: null },
      ],
      error: null,
    }
    mockState.selectByTable.caregiver_regulatory_roles = {
      data: [
        { caregiver_id: 'cg-1', regulatory_role: 'licensee' },
        { caregiver_id: 'cg-2', regulatory_role: 'child_care_staff_member' },
        { caregiver_id: 'cg-3', regulatory_role: 'child_care_assistant' },
      ],
      error: null,
    }
    const { data, error } = await listCaregiversWithRoles({ licenseeId: 'L' })
    expect(error).toBeNull()
    expect(data).toHaveLength(3)
    const byName = Object.fromEntries(data.map(c => [c.full_name, c.regulatory_roles]))
    expect(byName['Owner Bob']).toEqual(['licensee'])
    expect(byName['Staff Sue']).toEqual(['child_care_staff_member'])
    expect(byName['Helper Henry']).toEqual(['child_care_assistant'])
  })

  it('returns empty array on missing licenseeId', async () => {
    const { data } = await listCaregiversWithRoles({})
    expect(data).toEqual([])
  })

  it('returns empty array when no caregivers exist for the licensee', async () => {
    mockState.selectByTable.caregivers = { data: [], error: null }
    const { data } = await listCaregiversWithRoles({ licenseeId: 'L' })
    expect(data).toEqual([])
  })

  it('caregivers with no roles get an empty regulatory_roles array', async () => {
    mockState.selectByTable.caregivers = {
      data: [{ id: 'cg-1', licensee_id: 'L', full_name: 'No Roles', archived_at: null }],
      error: null,
    }
    mockState.selectByTable.caregiver_regulatory_roles = { data: [], error: null }
    const { data } = await listCaregiversWithRoles({ licenseeId: 'L' })
    expect(data[0].regulatory_roles).toEqual([])
  })

  it('multi-role caregivers get all their roles attached', async () => {
    mockState.selectByTable.caregivers = {
      data: [{ id: 'cg-1', licensee_id: 'L', full_name: 'Dual Role', archived_at: null }],
      error: null,
    }
    mockState.selectByTable.caregiver_regulatory_roles = {
      data: [
        { caregiver_id: 'cg-1', regulatory_role: 'child_care_staff_member' },
        { caregiver_id: 'cg-1', regulatory_role: 'driver' },
      ],
      error: null,
    }
    const { data } = await listCaregiversWithRoles({ licenseeId: 'L' })
    expect([...data[0].regulatory_roles].sort()).toEqual([
      'child_care_staff_member', 'driver',
    ])
  })
})

describe('eligibleCaregiversForAdministration — the UI mirror of R 400.1931(1)+(8)', () => {
  const roster = [
    { id: 'cg-1', full_name: 'Licensee',  regulatory_roles: ['licensee'] },
    { id: 'cg-2', full_name: 'Staff',     regulatory_roles: ['child_care_staff_member'] },
    { id: 'cg-3', full_name: 'Assistant', regulatory_roles: ['child_care_assistant'] },
    { id: 'cg-4', full_name: 'SupVol',    regulatory_roles: ['supervised_volunteer'] },
    { id: 'cg-5', full_name: 'NoRoles',   regulatory_roles: [] },
    { id: 'cg-6', full_name: 'Driver',    regulatory_roles: ['driver'] },
    { id: 'cg-7', full_name: 'UnsupVol',  regulatory_roles: ['unsupervised_volunteer'] },
  ]

  it('NON-OTC: only licensee + child_care_staff_member appear (R 400.1931(1))', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: { is_topical_otc: false },
    })
    const names = out.map(c => c.full_name).sort()
    expect(names).toEqual(['Licensee', 'Staff'])
  })

  it('NON-OTC: assistant + supervised_volunteer are filtered OUT (R 400.1931(1) prohibits)', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: { is_topical_otc: false },
    })
    const names = out.map(c => c.full_name)
    expect(names).not.toContain('Assistant')
    expect(names).not.toContain('SupVol')
  })

  it('NON-OTC: caregivers with no roles, drivers, and unsupervised volunteers are filtered OUT', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: { is_topical_otc: false },
    })
    const names = out.map(c => c.full_name)
    expect(names).not.toContain('NoRoles')
    expect(names).not.toContain('Driver')
    expect(names).not.toContain('UnsupVol')
  })

  it('TOPICAL OTC: EVERY caregiver appears (R 400.1931(8) role-gate exempt)', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: { is_topical_otc: true },
    })
    expect(out).toHaveLength(roster.length)
    const names = out.map(c => c.full_name).sort()
    expect(names).toEqual([
      'Assistant', 'Driver', 'Licensee', 'NoRoles',
      'Staff', 'SupVol', 'UnsupVol',
    ])
  })

  it('TOPICAL OTC: returns a shallow copy (not a mutating reference)', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: { is_topical_otc: true },
    })
    expect(out).not.toBe(roster)
  })

  it('empty roster → empty result regardless of authorization shape', () => {
    expect(eligibleCaregiversForAdministration({
      caregivers: [], authorization: { is_topical_otc: false },
    })).toEqual([])
    expect(eligibleCaregiversForAdministration({
      caregivers: [], authorization: { is_topical_otc: true },
    })).toEqual([])
  })

  it('null roster → empty result (defensive)', () => {
    expect(eligibleCaregiversForAdministration({
      caregivers: null, authorization: { is_topical_otc: false },
    })).toEqual([])
  })

  it('null authorization → role-gate applies (safe-by-default)', () => {
    const out = eligibleCaregiversForAdministration({
      caregivers: roster,
      authorization: null,
    })
    const names = out.map(c => c.full_name).sort()
    expect(names).toEqual(['Licensee', 'Staff'])
  })
})

// ─── Consent capture (parent permission for medication) ──────────────

describe('recordMedicationPermission (per-authorization)', () => {
  const auth = {
    id: 'A1',
    medication_name: "Children's Tylenol",
    dose_text: '5 mL',
    schedule_text: 'every 6 hours as needed',
    prescriber_name: 'Dr. Smith',
    is_topical_otc: false,
    starts_on: '2026-06-01',
    ends_on: null,
    original_container_confirmed: true,
  }

  it('archives any prior active ack of the same type+subject, then inserts a fresh row with snapshot_hash drift detection', async () => {
    // Pre-existing active ack for this authorization.
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'prior-ack' }],
      error: null,
    }
    const { error } = await recordMedicationPermission({
      providerId: 'P',
      authorization: auth,
      channel: 'in_person_paper',
      parentLabel: 'Test Parent',
    })
    expect(error).toBeNull()
    // 1) Archive update — sets archived_at on the prior row.
    expect(mockState.updates).toHaveLength(1)
    expect(mockState.updates[0].table).toBe('acknowledgments')
    expect(mockState.updates[0].patch.archived_at).toBeTruthy()
    // 2) Insert — the new row.
    expect(mockState.inserts).toHaveLength(1)
    const row = mockState.inserts[0].rows[0]
    expect(row.provider_id).toBe('P')
    expect(row.type).toBe('medication_permission')
    expect(row.subject_type).toBe('medication_authorization')
    expect(row.subject_id).toBe('A1')
    expect(row.acknowledged_via).toBe('in_person_paper')
    expect(row.acknowledged_by_label).toBe('Test Parent')
    expect(row.snapshot_hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('inserts under provider_override channel — captured but does NOT satisfy parent-signed', async () => {
    await recordMedicationPermission({
      providerId: 'P',
      authorization: auth,
      channel: 'provider_override',
      providerReason: 'Parent verbally consented; paper signature pending.',
    })
    const row = mockState.inserts[0].rows[0]
    expect(row.acknowledged_via).toBe('provider_override')
    expect(row.provider_override_reason).toBe('Parent verbally consented; paper signature pending.')
    expect(row.acknowledged_by_label).toBeNull()
  })

  it('throws on missing providerId or authorization', async () => {
    await expect(recordMedicationPermission({
      authorization: auth, channel: 'in_person_paper', parentLabel: 'X',
    })).rejects.toThrow(/providerId/)
    await expect(recordMedicationPermission({
      providerId: 'P', channel: 'in_person_paper', parentLabel: 'X',
    })).rejects.toThrow(/authorization/)
  })

  it('throws when in_person_paper channel is selected without a parentLabel', async () => {
    await expect(recordMedicationPermission({
      providerId: 'P',
      authorization: auth,
      channel: 'in_person_paper',
      parentLabel: '   ',
    })).rejects.toThrow(/parentLabel/)
  })

  it('throws when provider_override channel is selected without a reason', async () => {
    await expect(recordMedicationPermission({
      providerId: 'P',
      authorization: auth,
      channel: 'provider_override',
      providerReason: '',
    })).rejects.toThrow(/providerReason/)
  })

  it('produces a hash that drifts when the authorization changes (drift detection wiring)', async () => {
    await recordMedicationPermission({
      providerId: 'P',
      authorization: auth,
      channel: 'in_person_paper',
      parentLabel: 'X',
    })
    const firstHash = mockState.inserts[0].rows[0].snapshot_hash

    mockState.inserts = []
    mockState.updates = []
    await recordMedicationPermission({
      providerId: 'P',
      authorization: { ...auth, dose_text: '10 mL' },
      channel: 'in_person_paper',
      parentLabel: 'X',
    })
    const secondHash = mockState.inserts[0].rows[0].snapshot_hash
    expect(firstHash).not.toBe(secondHash)
  })
})

describe('recordOtcBlanketPermission (one per child, covers all topical OTC)', () => {
  it('archives prior + inserts under subject_type=child / subject_id=childId', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [{ id: 'prior-otc-ack' }],
      error: null,
    }
    const { error } = await recordOtcBlanketPermission({
      providerId: 'P',
      childId: 'C',
      channel: 'in_person_paper',
      parentLabel: 'Test Parent',
    })
    expect(error).toBeNull()
    expect(mockState.updates).toHaveLength(1)
    expect(mockState.inserts).toHaveLength(1)
    const row = mockState.inserts[0].rows[0]
    expect(row.type).toBe('medication_permission_otc_blanket')
    expect(row.subject_type).toBe('child')
    expect(row.subject_id).toBe('C')
    expect(row.acknowledged_via).toBe('in_person_paper')
  })

  it('throws on missing providerId or childId', async () => {
    await expect(recordOtcBlanketPermission({
      childId: 'C', channel: 'in_person_paper', parentLabel: 'X',
    })).rejects.toThrow(/providerId/)
    await expect(recordOtcBlanketPermission({
      providerId: 'P', channel: 'in_person_paper', parentLabel: 'X',
    })).rejects.toThrow(/childId/)
  })
})

describe('listMedicationConsentsForChild', () => {
  it('returns the OTC-blanket and per-authorization acks keyed by subject_id', async () => {
    // The helper makes two acknowledgments queries in sequence: first
    // the OTC-blanket (subject_type='child', limit 1), then the
    // per-authorization fetch (subject_type='medication_authorization',
    // .in() over auth ids). The mock chain returns the same
    // selectByTable.acknowledgments.data for both — for this test
    // both queries see the same data, and the helper picks the
    // right subset by subject_type.
    //
    // The OTC-blanket result is whatever is sliced off by the .limit(1)
    // — the chain's limit handler slices the data array to that length.
    // We arrange the data so the OTC row is first.
    mockState.selectByTable.acknowledgments = {
      data: [
        { id: 'otc',  type: 'medication_permission_otc_blanket', subject_type: 'child',
          subject_id: 'C', acknowledged_via: 'in_person_paper', acknowledged_at: '2026-06-01T00:00:00Z' },
        { id: 'pa1', type: 'medication_permission', subject_type: 'medication_authorization',
          subject_id: 'A1', acknowledged_via: 'in_person_paper', acknowledged_at: '2026-06-02T00:00:00Z' },
        { id: 'pa2', type: 'medication_permission', subject_type: 'medication_authorization',
          subject_id: 'A2', acknowledged_via: 'parent_portal',   acknowledged_at: '2026-06-03T00:00:00Z' },
      ],
      error: null,
    }
    const { data, error } = await listMedicationConsentsForChild({
      providerId: 'P',
      childId: 'C',
      authorizationIds: ['A1', 'A2'],
    })
    expect(error).toBeNull()
    // OTC row: comes from the limit(1) query — first row in the array.
    expect(data.otcBlanket).not.toBeNull()
    expect(data.otcBlanket.type).toBe('medication_permission_otc_blanket')
    // Per-authorization: keyed by subject_id; only rows of type
    // medication_permission are considered (the helper filters by type
    // in the .eq call, but our mock returns the full array — the
    // helper assigns whatever it sees per subject_id, which matches
    // because the prior OTC row's subject_id ('C') is not in the
    // authorizationIds set, so it's never overwritten in the map).
    expect(Object.keys(data.perAuthorization).sort()).toEqual(['A1', 'A2'])
    expect(data.perAuthorization['A1'].id).toBe('pa1')
    expect(data.perAuthorization['A2'].id).toBe('pa2')
  })

  it('returns empty perAuthorization when no authorization ids are provided', async () => {
    mockState.selectByTable.acknowledgments = {
      data: [
        { id: 'otc', type: 'medication_permission_otc_blanket', subject_type: 'child',
          subject_id: 'C', acknowledged_via: 'in_person_paper', acknowledged_at: '2026-06-01T00:00:00Z' },
      ],
      error: null,
    }
    const { data } = await listMedicationConsentsForChild({
      providerId: 'P', childId: 'C',
    })
    expect(data.otcBlanket).not.toBeNull()
    expect(data.perAuthorization).toEqual({})
  })

  it('empty shape on missing providerId / childId', async () => {
    const { data } = await listMedicationConsentsForChild({})
    expect(data).toEqual({ otcBlanket: null, perAuthorization: {} })
  })
})

describe('medicationConsentSatisfied', () => {
  const goodAck = {
    archived_at: null,
    acknowledged_via: 'in_person_paper',
  }
  const overrideAck = {
    archived_at: null,
    acknowledged_via: 'provider_override',
  }

  it('NON-OTC: true when the per-auth ack is parent-signed', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: goodAck,
    })).toBe(true)
  })

  it('NON-OTC: false when the per-auth ack is provider_override only', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: overrideAck,
    })).toBe(false)
  })

  it('NON-OTC: false when the per-auth ack is missing', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: null,
    })).toBe(false)
  })

  it('NON-OTC: false when the OTC-blanket is satisfied but per-auth is missing', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: null,
      otcBlanketAck: goodAck,
    })).toBe(false)
  })

  it('TOPICAL OTC: true when the OTC-blanket ack is parent-signed', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: true },
      otcBlanketAck: goodAck,
    })).toBe(true)
  })

  it('TOPICAL OTC: false when the OTC-blanket is provider_override only', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: true },
      otcBlanketAck: overrideAck,
    })).toBe(false)
  })

  it('TOPICAL OTC: ignores the per-auth ack entirely (consent rides the blanket)', () => {
    // Even if a per-auth ack happened to exist, OTC reads the blanket.
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: true },
      perAuthAck: goodAck,
      otcBlanketAck: null,
    })).toBe(false)
  })

  it('archived ack does NOT satisfy (soft-deleted = not on file)', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: { ...goodAck, archived_at: new Date().toISOString() },
    })).toBe(false)
  })

  // Phase Y1 (2026-06-04) — duplication invariant: this file's
  // copy of PARENT_SIGNED_SATISFYING_CHANNELS must include every
  // channel the engine's copy includes. The matching engine-side
  // assertion lives in complianceState.test.js; this is the
  // medication-side half. Test the BEHAVIOR per channel (the
  // constant itself is module-internal).
  it('NON-OTC: parent_portal_esign satisfies (Phase Y1 channel)', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: { archived_at: null, acknowledged_via: 'parent_portal_esign' },
    })).toBe(true)
  })

  it('TOPICAL OTC: parent_portal_esign on the OTC-blanket satisfies (Phase Y1 channel)', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: true },
      otcBlanketAck: { archived_at: null, acknowledged_via: 'parent_portal_esign' },
    })).toBe(true)
  })

  it('parent_portal satisfies (the original channel — sanity check)', () => {
    expect(medicationConsentSatisfied({
      authorization: { is_topical_otc: false },
      perAuthAck: { archived_at: null, acknowledged_via: 'parent_portal' },
    })).toBe(true)
  })
})
