import { describe, it, expect, vi } from 'vitest'

// The hook file imports `supabase` from `@/lib/supabase`, which throws
// at import time when the Vite env vars are not set (test environment).
// Mock the module so the hook file's import side-effect is a no-op.
// vi.mock is hoisted above the imports below.
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }))

import {
  defaultLeadTimeFor,
  buildEnablePatch,
  buildDisablePatch,
  byCategoryMap,
  fetchPreferences,
  upsertPreference,
  replacePreference,
} from './useReminderPreferences'

// ─── Mock Supabase chain builders ──────────────────────────────────────
//
// Supabase's PostgREST query builder is fluent and thenable; the chain
// returns itself from each step until awaited. We mirror that with tiny
// inline mocks below.

function makeSelectChain(result) {
  const calls = { table: null, ops: [] }
  const chain = {
    select(cols) { calls.ops.push({ select: cols }); return chain },
    eq(col, val) { calls.ops.push({ eq: [col, val] }); return chain },
    is(col, val) { calls.ops.push({ is: [col, val] }); return chain },
    not(col, op, val) { calls.ops.push({ not: [col, op, val] }); return chain },
    order(col, opts) { calls.ops.push({ order: [col, opts] }); return chain },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject) },
  }
  const client = {
    from(table) { calls.table = table; return chain },
  }
  return { client, calls }
}

function makeUpsertChain(returnRow, error = null) {
  const captured = { table: null, payload: null, opts: null }
  const chain = {
    upsert(payload, opts) {
      captured.payload = payload
      captured.opts = opts
      return chain
    },
    select() { return chain },
    maybeSingle() {
      if (error) return Promise.resolve({ data: null, error })
      return Promise.resolve({ data: { ...captured.payload, ...returnRow }, error: null })
    },
  }
  const client = {
    from(table) { captured.table = table; return chain },
  }
  return { client, captured }
}

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('defaultLeadTimeFor', () => {
  it('returns the catalog entry value for a known category', () => {
    // drill_fire defaults to 14 days per the catalog.
    expect(defaultLeadTimeFor('drill_fire')).toBe(14)
  })

  it('returns the catalog entry value for compliance categories', () => {
    expect(defaultLeadTimeFor('cpr_first_aid_expiration')).toBe(30)
    expect(defaultLeadTimeFor('medication_authorization_renewal')).toBe(7)
  })

  it('falls back to 7 for unknown categories', () => {
    expect(defaultLeadTimeFor('mystery_category')).toBe(7)
  })
})

describe('buildEnablePatch', () => {
  it('preserves the existing row when present (no defaults overwrite)', () => {
    const existing = { category: 'drill_fire', enabled: false, lead_time_days: 21, channel: 'email' }
    expect(buildEnablePatch(existing, 14)).toEqual({ enabled: true })
  })

  it('seeds defaults when no existing row', () => {
    expect(buildEnablePatch(null, 14)).toEqual({
      enabled: true,
      lead_time_days: 14,
      channel: 'in_app',
    })
  })

  it('clamps the default lead time to the CHECK constraint range (0-365)', () => {
    expect(buildEnablePatch(null, 999).lead_time_days).toBe(365)
    expect(buildEnablePatch(null, -1).lead_time_days).toBe(0)
  })

  it('falls back to 7 when no default supplied', () => {
    expect(buildEnablePatch(null).lead_time_days).toBe(7)
  })
})

describe('buildDisablePatch', () => {
  it('flips enabled to false WITHOUT touching channel or lead_time_days', () => {
    expect(buildDisablePatch()).toEqual({ enabled: false })
  })
})

describe('byCategoryMap', () => {
  it('keys rows by category', () => {
    const map = byCategoryMap([
      { category: 'drill_fire', enabled: true },
      { category: 'drill_tornado', enabled: false },
    ])
    expect(map.drill_fire).toEqual({ category: 'drill_fire', enabled: true })
    expect(map.drill_tornado).toEqual({ category: 'drill_tornado', enabled: false })
  })

  it('returns an empty object for nullish input', () => {
    expect(byCategoryMap()).toEqual({})
    expect(byCategoryMap(null)).toEqual({})
  })

  it('skips rows without a category', () => {
    const map = byCategoryMap([null, undefined, { enabled: true }, { category: 'cpr_first_aid_expiration' }])
    expect(Object.keys(map)).toEqual(['cpr_first_aid_expiration'])
  })
})

describe('replacePreference', () => {
  it('updates an existing row in place', () => {
    const prev = [
      { id: 'a', category: 'drill_fire', enabled: true },
      { id: 'b', category: 'drill_tornado', enabled: false },
    ]
    const next = replacePreference(prev, { id: 'a', category: 'drill_fire', enabled: false })
    expect(next).toEqual([
      { id: 'a', category: 'drill_fire', enabled: false },
      { id: 'b', category: 'drill_tornado', enabled: false },
    ])
  })

  it('appends when the category is not yet present', () => {
    const next = replacePreference([], { id: 'c', category: 'cpr_first_aid_expiration', enabled: true })
    expect(next).toHaveLength(1)
    expect(next[0].category).toBe('cpr_first_aid_expiration')
  })

  it('returns the original list for malformed input', () => {
    const prev = [{ id: 'a', category: 'x' }]
    expect(replacePreference(prev, null)).toBe(prev)
    expect(replacePreference(prev, {})).toBe(prev)
  })
})

// ─── Supabase round-trips ──────────────────────────────────────────────

describe('fetchPreferences', () => {
  it('loads the full row set for the provider in one round-trip', async () => {
    const { client, calls } = makeSelectChain({
      data: [
        { id: 'a', category: 'drill_fire', enabled: true, lead_time_days: 14, channel: 'in_app' },
      ],
      error: null,
    })
    const rows = await fetchPreferences(client, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('drill_fire')
    expect(calls.table).toBe('reminder_preferences')
    expect(calls.ops.find(o => o.eq)).toEqual({ eq: ['provider_id', 'user-1'] })
  })

  it('returns [] for null data', async () => {
    const { client } = makeSelectChain({ data: null, error: null })
    expect(await fetchPreferences(client, 'u')).toEqual([])
  })

  it('throws when Supabase reports an error', async () => {
    const { client } = makeSelectChain({ data: null, error: new Error('boom') })
    await expect(fetchPreferences(client, 'u')).rejects.toThrow('boom')
  })
})

describe('upsertPreference', () => {
  it('upserts with onConflict on (provider_id, category) and returns the merged row', async () => {
    const { client, captured } = makeUpsertChain({ id: 'gen', updated_at: '2026-06-01T00:00:00Z' })
    const result = await upsertPreference(client, 'user-1', 'drill_fire', {
      enabled: true,
      lead_time_days: 14,
      channel: 'in_app',
    })
    expect(captured.table).toBe('reminder_preferences')
    expect(captured.opts).toEqual({ onConflict: 'provider_id,category' })
    expect(captured.payload).toEqual({
      provider_id: 'user-1',
      category: 'drill_fire',
      enabled: true,
      lead_time_days: 14,
      channel: 'in_app',
    })
    expect(result).toMatchObject({
      id: 'gen',
      provider_id: 'user-1',
      category: 'drill_fire',
      enabled: true,
    })
  })

  it('passes through a partial patch (e.g. just channel)', async () => {
    const { client, captured } = makeUpsertChain({ id: 'gen' })
    await upsertPreference(client, 'user-1', 'drill_fire', { channel: 'email' })
    expect(captured.payload).toEqual({
      provider_id: 'user-1',
      category: 'drill_fire',
      channel: 'email',
    })
  })

  it('throws on Supabase error', async () => {
    const { client } = makeUpsertChain(null, new Error('rls denied'))
    await expect(
      upsertPreference(client, 'user-1', 'drill_fire', { enabled: true })
    ).rejects.toThrow('rls denied')
  })
})

// ─── Toggle-flow integration (composition of helpers) ─────────────────

describe('enable flow composition', () => {
  it('new category -> seeds catalog defaults and writes via upsert', async () => {
    const { client, captured } = makeUpsertChain({ id: 'new' })
    const existing = null
    const patch = buildEnablePatch(existing, defaultLeadTimeFor('drill_tornado'))
    await upsertPreference(client, 'u', 'drill_tornado', patch)
    // drill_tornado default_lead_time_days = 14.
    expect(captured.payload.enabled).toBe(true)
    expect(captured.payload.lead_time_days).toBe(14)
    expect(captured.payload.channel).toBe('in_app')
  })

  it('previously-disabled category -> ONLY flips enabled, no channel reset', async () => {
    const { client, captured } = makeUpsertChain({ id: 'kept' })
    const existing = { category: 'drill_fire', enabled: false, lead_time_days: 30, channel: 'email' }
    const patch = buildEnablePatch(existing, defaultLeadTimeFor('drill_fire'))
    await upsertPreference(client, 'u', 'drill_fire', patch)
    expect(captured.payload).toEqual({
      provider_id: 'u',
      category: 'drill_fire',
      enabled: true,
    })
    expect(captured.payload.channel).toBeUndefined()
    expect(captured.payload.lead_time_days).toBeUndefined()
  })
})

describe('disable flow composition', () => {
  it('writes ONLY enabled=false (preserves stored channel + lead_time_days)', async () => {
    const { client, captured } = makeUpsertChain({ id: 'kept' })
    await upsertPreference(client, 'u', 'drill_fire', buildDisablePatch())
    expect(captured.payload).toEqual({
      provider_id: 'u',
      category: 'drill_fire',
      enabled: false,
    })
  })
})
