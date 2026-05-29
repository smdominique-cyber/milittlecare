import { describe, it, expect, vi, beforeEach } from 'vitest'

// The hook-style supabase import must be mocked before importing
// childFiles.js (the module reads import.meta.env at load time). Mirrors
// the pattern used by useReminderPreferences.test.js.

const mockState = {
  profile: null,
  children: [],
  acks: [],
  ackError: null,
}

function chainFor(table) {
  // Returns a fluent mock that resolves to the per-table data shape
  // PostgREST gives us. We honor only the filters the SUT actually
  // applies (.eq, .in, .is, .maybeSingle) so the test reads like the
  // actual query.
  const chain = {
    _isMaybeSingle: false,
    select() { return chain },
    eq() { return chain },
    in() { return chain },
    is() { return chain },
    maybeSingle() { chain._isMaybeSingle = true; return chain },
    then(resolve, reject) {
      let data, error
      if (table === 'profiles') {
        data = mockState.profile
        error = null
      } else if (table === 'children') {
        data = mockState.children
        error = null
      } else if (table === 'acknowledgments') {
        data = mockState.acks
        error = mockState.ackError
      } else {
        data = null; error = null
      }
      return Promise.resolve({ data, error }).then(resolve, reject)
    },
  }
  return chain
}

// childFiles.js imports `from './supabase'` (relative, per the Edge
// guardrail). Mock the resolved module — Vitest normalizes both `./supabase`
// and `@/lib/supabase` to the same module ID, so either works.
vi.mock('./supabase', () => ({
  supabase: { from: (table) => chainFor(table) },
}))

const { getChildFilesAuditState } = await import('./childFiles')

beforeEach(() => {
  mockState.profile = null
  mockState.children = []
  mockState.acks = []
  mockState.ackError = null
})

describe('getChildFilesAuditState', () => {
  it('returns the empty/zero shape when no licenseeId is provided', async () => {
    const out = await getChildFilesAuditState(null)
    expect(out).toEqual({
      domain: 'child_files',
      type: 'type_2',
      active_children_count: 0,
      intake_complete_count: 0,
      intake_incomplete_count: 0,
      annual_review_overdue_count: 0,
      pending_lead_disclosures_count: 0,
      pending_firearms_disclosures_count: 0,
    })
  })

  it('matches the documented shape exactly (no extra keys)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'c1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(Object.keys(out).sort()).toEqual([
      'active_children_count',
      'annual_review_overdue_count',
      'domain',
      'intake_complete_count',
      'intake_incomplete_count',
      'pending_firearms_disclosures_count',
      'pending_lead_disclosures_count',
      'type',
    ])
    expect(out.domain).toBe('child_files')
    expect(out.type).toBe('type_2')
  })

  it('counts active children + intake complete/incomplete buckets', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'a', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
      { id: 'b', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'c', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.active_children_count).toBe(3)
    expect(out.intake_complete_count).toBe(1)
    expect(out.intake_incomplete_count).toBe(2)
  })

  // ─── The pending-disclosure tests the spec called out specifically ──

  it('counts a child with an UNSIGNED lead disclosure when home_built_before_1978=true', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []  // no acks recorded
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(1)
  })

  it('drops the lead pending count once a lead_disclosure ack is recorded for the child', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'kid-1', type: 'lead_disclosure' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
  })

  it('does NOT count lead disclosures when home_built_before_1978=false (not required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
  })

  it('counts an UNSIGNED firearms disclosure for every child when firearms answer is set (always required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_firearms_disclosures_count).toBe(2)
  })

  it('firearms_on_premises=false still requires the disclosure ack (copy varies, ack still required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_firearms_disclosures_count).toBe(1)
  })

  it('drops the firearms pending count once a firearms_disclosure ack is recorded', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_firearms_disclosures_count).toBe(0)
  })

  it('per-child independence: one child acks lead, the other does not', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'signed', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'unsigned', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'signed', type: 'lead_disclosure' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(1)
  })

  it('firearms_on_premises = null (provider has not answered) does NOT inflate the firearms pending count', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: null }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    // Firearms ack required only when the provider has answered yes or no.
    expect(out.pending_firearms_disclosures_count).toBe(0)
  })

  it('counts annual-review overdue when last review was > 1 year ago', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const longAgo = '2020-01-01'
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: longAgo, date_of_birth: '2018-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.annual_review_overdue_count).toBe(1)
  })

  it('does NOT count annual-review overdue for a recent review', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const recent = new Date().toISOString().slice(0, 10)
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: recent, date_of_birth: '2018-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.annual_review_overdue_count).toBe(0)
  })

  it('returns children-only zeros when the acknowledgments table is unavailable (migration not applied)', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = null
    mockState.ackError = new Error('relation "public.acknowledgments" does not exist')
    const out = await getChildFilesAuditState('u1')
    expect(out.active_children_count).toBe(1)
    expect(out.intake_incomplete_count).toBe(1)
    // The defensive empty-state fallback omits the disclosure pending
    // counts (no acks table -> we can't decide who's outstanding).
    expect(out.pending_lead_disclosures_count).toBe(0)
    expect(out.pending_firearms_disclosures_count).toBe(0)
  })
})
