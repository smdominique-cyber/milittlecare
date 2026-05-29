import { describe, it, expect, vi } from 'vitest'
import {
  listPendingForParent,
  resolvePendingForChild,
  RPC_NAMES,
} from './parentIntakeReminders'

// ─── Honest scope ─────────────────────────────────────────────────────
//
// Vitest has no live database, so these tests CANNOT verify the
// SECURITY DEFINER guard inside the SQL function — only that the
// production code calls the RPC the migration defines, with the
// shape the migration expects, and threads the result through the
// list→resolve loop correctly.
//
// The RLS-equivalent assertions (parent A cannot list parent B's
// reminders; provider X cannot call the parent-scoped resolve) live
// in the migration 024 verification queries in the runbook, not here.
// What this file does cover: the wiring that the silent-cut bug
// hid — that the helpers actually call the right RPCs and that a
// non-empty list reaches the resolve loop.

function mockSupabaseWithRpc(impl) {
  // impl: (name, args) -> { data?, error? } OR throws
  const calls = []
  const client = {
    rpc: vi.fn(async (name, args) => {
      calls.push({ name, args })
      try {
        return impl(name, args)
      } catch (err) {
        throw err
      }
    }),
  }
  return { client, calls }
}

// ─── listPendingForParent ──────────────────────────────────────────────

describe('listPendingForParent', () => {
  it('calls reminder_instance_list_for_parent (no args) and groups by subject_id', async () => {
    const { client, calls } = mockSupabaseWithRpc(() => ({
      data: [
        { id: 'rem-a1', subject_id: 'child-A' },
        { id: 'rem-a2', subject_id: 'child-A' },
        { id: 'rem-b1', subject_id: 'child-B' },
      ],
      error: null,
    }))
    const { pendingByChild, error } = await listPendingForParent(client)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe(RPC_NAMES.list)
    expect(calls[0].name).toBe('reminder_instance_list_for_parent')
    expect(calls[0].args).toBeUndefined()
    expect(error).toBeNull()
    expect(pendingByChild).toEqual({
      'child-A': ['rem-a1', 'rem-a2'],
      'child-B': ['rem-b1'],
    })
  })

  it('returns an empty map and the error when the RPC errors (non-fatal)', async () => {
    const rpcError = { message: 'function not found' }
    const { client } = mockSupabaseWithRpc(() => ({ data: null, error: rpcError }))
    const { pendingByChild, error } = await listPendingForParent(client)
    expect(pendingByChild).toEqual({})
    expect(error).toBe(rpcError)
  })

  it('returns an empty map when the RPC returns a non-array (defensive)', async () => {
    const { client } = mockSupabaseWithRpc(() => ({ data: null, error: null }))
    const { pendingByChild, error } = await listPendingForParent(client)
    expect(pendingByChild).toEqual({})
    expect(error).toBeNull()
  })

  it('returns an empty map and captures the thrown error when the client throws', async () => {
    const boom = new Error('network down')
    const { client } = mockSupabaseWithRpc(() => { throw boom })
    const { pendingByChild, error } = await listPendingForParent(client)
    expect(pendingByChild).toEqual({})
    expect(error).toBe(boom)
  })

  it('skips malformed rows missing id or subject_id', async () => {
    const { client } = mockSupabaseWithRpc(() => ({
      data: [
        { id: 'rem-1', subject_id: 'child-A' },
        { id: null, subject_id: 'child-A' },
        { id: 'rem-2', subject_id: null },
        null,
        { id: 'rem-3', subject_id: 'child-B' },
      ],
      error: null,
    }))
    const { pendingByChild } = await listPendingForParent(client)
    expect(pendingByChild).toEqual({
      'child-A': ['rem-1'],
      'child-B': ['rem-3'],
    })
  })
})

// ─── resolvePendingForChild ────────────────────────────────────────────

describe('resolvePendingForChild', () => {
  it('calls reminder_instance_resolve_for_parent once per pending id', async () => {
    const { client, calls } = mockSupabaseWithRpc(() => ({ data: null, error: null }))
    const pendingByChild = { 'child-A': ['rem-1', 'rem-2'], 'child-B': ['rem-3'] }
    const out = await resolvePendingForChild(client, pendingByChild, 'child-A')
    // Two resolve calls, exact RPC name + p_instance_id arg per call
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ name: RPC_NAMES.resolve, args: { p_instance_id: 'rem-1' } })
    expect(calls[1]).toEqual({ name: RPC_NAMES.resolve, args: { p_instance_id: 'rem-2' } })
    expect(calls[0].name).toBe('reminder_instance_resolve_for_parent')
    expect(out.resolved).toBe(2)
    expect(out.failures).toEqual([])
  })

  it('no-op when the child has no pending ids (zero calls)', async () => {
    const { client, calls } = mockSupabaseWithRpc(() => ({ data: null, error: null }))
    const out = await resolvePendingForChild(client, { 'child-A': [] }, 'child-A')
    expect(calls).toHaveLength(0)
    expect(out.resolved).toBe(0)
    expect(out.failures).toEqual([])
  })

  it('no-op when the child is absent from the map', async () => {
    const { client, calls } = mockSupabaseWithRpc(() => ({ data: null, error: null }))
    const out = await resolvePendingForChild(client, {}, 'child-A')
    expect(calls).toHaveLength(0)
    expect(out.resolved).toBe(0)
  })

  it('collects RPC errors as failures without throwing', async () => {
    const e1 = { message: 'unauthorized' }
    const { client } = mockSupabaseWithRpc((_name, args) => {
      if (args.p_instance_id === 'rem-2') return { data: null, error: e1 }
      return { data: null, error: null }
    })
    const out = await resolvePendingForChild(
      client, { 'child-A': ['rem-1', 'rem-2', 'rem-3'] }, 'child-A',
    )
    expect(out.resolved).toBe(2)
    expect(out.failures).toEqual([{ id: 'rem-2', error: e1 }])
  })

  it('catches thrown client errors and records them as failures', async () => {
    const boom = new Error('connection reset')
    const { client } = mockSupabaseWithRpc(() => { throw boom })
    const out = await resolvePendingForChild(client, { 'child-A': ['rem-1'] }, 'child-A')
    expect(out.resolved).toBe(0)
    expect(out.failures).toEqual([{ id: 'rem-1', error: boom }])
  })

  it('treats null pendingByChild safely', async () => {
    const { client, calls } = mockSupabaseWithRpc(() => ({ data: null, error: null }))
    const out = await resolvePendingForChild(client, null, 'child-A')
    expect(calls).toHaveLength(0)
    expect(out.resolved).toBe(0)
  })
})

// ─── End-to-end wiring (the dead-loop fix) ─────────────────────────────

describe('list -> resolve wiring (the parent flow PR #16 third pass restores)', () => {
  it('a non-empty list result feeds the resolve loop with the right ids', async () => {
    // 1) The list RPC returns three reminder rows across two children.
    // 2) The page would index those into pendingByChild.
    // 3) The parent confirms child-A.
    // 4) Resolve should be called once for each of child-A's two
    //    reminder ids — proving the loop is reachable, which the
    //    direct-SELECT version was not.
    const resolveCalls = []
    const client = {
      rpc: vi.fn(async (name, args) => {
        if (name === RPC_NAMES.list) {
          return {
            data: [
              { id: 'rem-a1', subject_id: 'child-A' },
              { id: 'rem-a2', subject_id: 'child-A' },
              { id: 'rem-b1', subject_id: 'child-B' },
            ],
            error: null,
          }
        }
        if (name === RPC_NAMES.resolve) {
          resolveCalls.push(args.p_instance_id)
          return { data: null, error: null }
        }
        throw new Error(`unexpected rpc call: ${name}`)
      }),
    }

    const { pendingByChild } = await listPendingForParent(client)
    expect(pendingByChild['child-A']).toEqual(['rem-a1', 'rem-a2'])

    // Critical assertion: the resolve loop receives a NON-EMPTY id
    // list. The pre-fix code path produced an empty pendingByChild
    // (RLS denied the direct SELECT) and never got here.
    const { resolved, failures } = await resolvePendingForChild(
      client, pendingByChild, 'child-A',
    )
    expect(resolved).toBe(2)
    expect(failures).toEqual([])
    expect(resolveCalls).toEqual(['rem-a1', 'rem-a2'])
  })
})
