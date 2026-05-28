import { describe, it, expect, vi } from 'vitest'

// Mock the supabase module so importing the hook file does not throw
// over missing Vite env vars in the test environment.
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }))

import {
  fetchActiveReminders,
  callDismissRpc,
  callResolveRpc,
  removeInstanceById,
} from './useActiveReminders'

// ─── Mock helpers ──────────────────────────────────────────────────────

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

function makeRpcCapture(rpcImpls = {}) {
  const calls = []
  const client = {
    rpc(name, args) {
      calls.push({ name, args })
      const impl = rpcImpls[name]
      if (impl) return impl(args)
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { client, calls }
}

// ─── fetchActiveReminders ──────────────────────────────────────────────

describe('fetchActiveReminders', () => {
  it('filters to active fired instances for the provider', async () => {
    const { client, calls } = makeSelectChain({
      data: [
        { id: 'inst-1', category: 'drill_fire', title: 'Fire drill due', fired_at: '2026-05-20T12:00:00Z' },
      ],
      error: null,
    })
    const rows = await fetchActiveReminders(client, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe('drill_fire')
    expect(calls.table).toBe('reminder_instances')
    // Verify the filter chain includes ownership, fired-not-null,
    // dismissed-null, resolved-null, archived-null, and an order clause.
    expect(calls.ops).toEqual(
      expect.arrayContaining([
        { eq: ['provider_id', 'user-1'] },
        { not: ['fired_at', 'is', null] },
        { is: ['dismissed_at', null] },
        { is: ['resolved_at', null] },
        { is: ['archived_at', null] },
        { order: ['trigger_at', { ascending: false }] },
      ])
    )
  })

  it('returns [] for null data', async () => {
    const { client } = makeSelectChain({ data: null, error: null })
    expect(await fetchActiveReminders(client, 'u')).toEqual([])
  })

  it('throws when Supabase reports an error', async () => {
    const { client } = makeSelectChain({ data: null, error: new Error('rls denied') })
    await expect(fetchActiveReminders(client, 'u')).rejects.toThrow('rls denied')
  })
})

// ─── Dismiss / resolve RPCs ────────────────────────────────────────────

describe('callDismissRpc', () => {
  it('calls reminder_instance_dismiss with p_instance_id', async () => {
    const { client, calls } = makeRpcCapture()
    await callDismissRpc(client, 'inst-1')
    expect(calls).toEqual([
      { name: 'reminder_instance_dismiss', args: { p_instance_id: 'inst-1' } },
    ])
  })

  it('throws on RPC error', async () => {
    const { client } = makeRpcCapture({
      reminder_instance_dismiss: () => Promise.resolve({ data: null, error: new Error('rpc fail') }),
    })
    await expect(callDismissRpc(client, 'inst-1')).rejects.toThrow('rpc fail')
  })
})

describe('callResolveRpc', () => {
  it('calls reminder_instance_resolve with p_instance_id', async () => {
    const { client, calls } = makeRpcCapture()
    await callResolveRpc(client, 'inst-2')
    expect(calls).toEqual([
      { name: 'reminder_instance_resolve', args: { p_instance_id: 'inst-2' } },
    ])
  })

  it('throws on RPC error', async () => {
    const { client } = makeRpcCapture({
      reminder_instance_resolve: () => Promise.resolve({ data: null, error: new Error('rpc fail') }),
    })
    await expect(callResolveRpc(client, 'inst-2')).rejects.toThrow('rpc fail')
  })
})

// ─── removeInstanceById ────────────────────────────────────────────────

describe('removeInstanceById', () => {
  it('removes the matching instance', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(removeInstanceById(list, 'b')).toEqual([{ id: 'a' }, { id: 'c' }])
  })

  it('returns the same shape when id not found', () => {
    const list = [{ id: 'a' }]
    expect(removeInstanceById(list, 'missing')).toEqual([{ id: 'a' }])
  })

  it('handles nullish input', () => {
    expect(removeInstanceById(null, 'a')).toEqual([])
    expect(removeInstanceById(undefined, 'a')).toEqual([])
  })
})
