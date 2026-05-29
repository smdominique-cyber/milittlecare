// PR #16 follow-up — Issue #1 regression guard PLUS confirm-path
// coverage (parent-confirm bug fix, 2026-05-29).
//
// The third-pass build introduced a Rules-of-Hooks violation
// (useMemo below the `if (loading) return` early-return) that
// crashed every parent's session at /parent/intake-acknowledge with
// React minified error #310. The fix was the hook reorder; this
// file's two original cases (no-focus / with-focus mounts) are the
// regression guard for that.
//
// The 2026-05-29 follow-up discovered that even with the page
// rendering, clicking "I confirm these acknowledgments" silently
// bailed: confirmChild derived providerId from existing[0]?.provider_id,
// which is empty whenever the provider used the "Send to parent's
// portal" channel (that channel writes only reminder_instances, no
// pre-existing acks). Same gap that let the dead button ship — the
// mount test proved the render but not the confirm. The new cases
// in `describe('confirm path')` close that hole: click the button,
// assert acknowledgments.insert was called with a well-formed
// envelope row, and assert reminder_instance_resolve_for_parent was
// invoked with the pending reminder's id.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// ─── Mock state and supabase shim ────────────────────────────────────

const mockUser = { id: 'parent-uid', email: 'parent@example.com' }
const TEST_PROVIDER_ID = 'provider-uid'

// Mutable per-test state so the test cases that mutate `tableData`
// don't leak across runs. beforeEach resets to defaults.
let tableData
let inserts
let updates

function defaultTableData() {
  return {
    parent_family_links: [{ family_id: 'fam-1' }],
    // Children rows include user_id — the canonical provider id, per the
    // 2026-05-29 confirm fix. The earlier confirm path bypassed this
    // entirely; the new path reads it.
    children: [{
      id: 'kid-1',
      first_name: 'Aiden',
      last_name: 'Tester',
      family_id: 'fam-1',
      date_of_birth: '2024-01-01',
      user_id: TEST_PROVIDER_ID,
    }],
    acknowledgments: [],
  }
}

function chainFor(table) {
  // Fluent mock that handles:
  //   - SELECT chains:    .select().eq().in().is()  -> awaitable { data, error }
  //   - UPDATE chains:    .update(patch).in(...)    -> awaitable { error }
  //   - INSERT call:      .insert(rows)             -> awaitable { error }
  // For UPDATE and INSERT we record the call so the test can assert
  // shape; SELECT just resolves from `tableData[table]`.
  let mode = 'select'
  let updatePayload = null
  const chain = {
    select() { mode = 'select'; return chain },
    eq() { return chain },
    in() { return chain },
    is() { return chain },
    update(payload) {
      mode = 'update'
      updatePayload = payload
      return chain
    },
    insert(rows) {
      inserts.push({ table, rows })
      return Promise.resolve({ data: null, error: null })
    },
    then(resolve, reject) {
      if (mode === 'update') {
        updates.push({ table, payload: updatePayload })
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      }
      return Promise.resolve({ data: tableData[table] ?? [], error: null })
        .then(resolve, reject)
    },
  }
  return chain
}

const rpcCalls = []

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: mockUser } })) },
    from: vi.fn((t) => chainFor(t)),
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args })
      if (name === 'reminder_instance_list_for_parent') {
        return {
          data: [{ id: 'rem-1', subject_id: 'kid-1' }],
          error: null,
        }
      }
      if (name === 'reminder_instance_resolve_for_parent') {
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }),
  },
}))

const { default: ParentIntakeAcknowledgePage } = await import(
  './ParentIntakeAcknowledgePage'
)

beforeEach(() => {
  cleanup()
  tableData = defaultTableData()
  inserts = []
  updates = []
  rpcCalls.length = 0
})

describe('ParentIntakeAcknowledgePage mount (Rules-of-Hooks regression guard)', () => {
  it('renders through loading → loaded without throwing React #310', async () => {
    // Render under MemoryRouter so useNavigate / useSearchParams resolve.
    // No `?child=<id>` here — exercises the no-focus path.
    render(
      <MemoryRouter initialEntries={['/parent/intake-acknowledge']}>
        <Routes>
          <Route path="/parent/intake-acknowledge"
            element={<ParentIntakeAcknowledgePage />} />
        </Routes>
      </MemoryRouter>
    )

    // Initial render: loading state. The pre-fix code threw here on
    // the SECOND render (after setLoading(false)) because the useMemo
    // below the early-return changed the hook count. Wait for the
    // post-fetch render — if hook ordering is wrong, React throws
    // inside waitFor and the test fails.
    expect(screen.getByText(/Loading your child files/i)).toBeTruthy()

    // After the async data load, the page transitions to the loaded
    // surface. With one pending reminder + zero acks, the child card
    // does NOT appear (the existing render gating shows cards only
    // when acks > 0). The page should still mount without throwing,
    // landing on the empty/done state or the header.
    await waitFor(() => {
      // Title is present in the loaded render path.
      expect(screen.getByText(/Confirm intake acknowledgments/i)).toBeTruthy()
    }, { timeout: 2000 })
  })

  it('renders with a ?child=<id> focus param without throwing', async () => {
    render(
      <MemoryRouter initialEntries={['/parent/intake-acknowledge?child=kid-1']}>
        <Routes>
          <Route path="/parent/intake-acknowledge"
            element={<ParentIntakeAcknowledgePage />} />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.getByText(/Loading your child files/i)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/Confirm intake acknowledgments/i)).toBeTruthy()
    }, { timeout: 2000 })
  })
})

// ─── Confirm path (the parent-confirm bug fix, 2026-05-29) ──────────
//
// These cases would have caught the dead button: existing test mocks
// the helpers but never CLICKED the button. The current cases mount
// the page, wait for the loaded surface, click "I confirm…", and
// assert (a) the acknowledgments insert was called with the right
// shape, (b) reminder_instance_resolve_for_parent was invoked with
// the pending reminder's id.

describe('ParentIntakeAcknowledgePage confirm path', () => {
  it(
    'portal-trigger normal state (no pre-existing acks): clicking confirm ' +
    'inserts the envelope ack and calls resolve_for_parent',
    async () => {
      // Default fixture: one pending reminder for kid-1, zero acks,
      // children carry user_id = TEST_PROVIDER_ID. This is exactly the
      // production state the bug was hit in.
      render(
        <MemoryRouter initialEntries={['/parent/intake-acknowledge?child=kid-1']}>
          <Routes>
            <Route path="/parent/intake-acknowledge"
              element={<ParentIntakeAcknowledgePage />} />
          </Routes>
        </MemoryRouter>
      )

      // Wait for the child's card to appear. The pending reminder
      // alone is enough to surface the card under the new code path
      // (and was before the fix too — the card surfaced; the button
      // was just dead).
      const button = await screen.findByRole('button', {
        name: /I confirm these acknowledgments/i,
      }, { timeout: 2000 })

      fireEvent.click(button)

      // The bug pre-fix would: throw "No provider on file for this
      // child", set error, and never call insert or rpc. After fix:
      // insert called once for acknowledgments, rpc called once for
      // the resolve.
      await waitFor(() => {
        expect(inserts.length).toBeGreaterThan(0)
      }, { timeout: 2000 })

      // Exactly one acknowledgments insert (the envelope row).
      const ackInserts = inserts.filter(i => i.table === 'acknowledgments')
      expect(ackInserts).toHaveLength(1)
      const rows = ackInserts[0].rows
      expect(Array.isArray(rows)).toBe(true)
      expect(rows).toHaveLength(1)   // envelope only — no sub-rows

      // Envelope row shape — every CHECK in migration 024 satisfied.
      const envelope = rows[0]
      expect(envelope.type).toBe('child_in_care_statement')
      expect(envelope.subject_type).toBe('child')
      expect(envelope.subject_id).toBe('kid-1')
      expect(envelope.acknowledged_via).toBe('parent_portal')
      expect(envelope.acknowledged_by_user_id).toBe(mockUser.id)
      expect(envelope.provider_override_reason).toBe(null)
      // The bug fix: provider_id resolves from child.user_id
      // (canonical) — NOT from existing[0]?.provider_id which is the
      // empty array's [0] = undefined.
      expect(envelope.provider_id).toBe(TEST_PROVIDER_ID)
      // Hash is a deterministic non-empty string.
      expect(typeof envelope.snapshot_hash).toBe('string')
      expect(envelope.snapshot_hash.length).toBeGreaterThan(0)

      // The resolve RPC fires for the pending reminder.
      const resolveCalls = rpcCalls.filter(
        c => c.name === 'reminder_instance_resolve_for_parent'
      )
      expect(resolveCalls).toHaveLength(1)
      expect(resolveCalls[0].args).toEqual({ p_instance_id: 'rem-1' })

      // No error banner.
      expect(screen.queryByText(/No provider on file/i)).toBeNull()
    },
  )

  it(
    'existing-acks state: confirm archives prior acks, writes envelope + ' +
    'sub-rows, and calls resolve_for_parent',
    async () => {
      // Provider previously used in_person_paper or provider_override
      // channel — there are existing sub-row acks. The parent's confirm
      // archives them and re-stamps as parent_portal.
      tableData.acknowledgments = [
        {
          id: 'ack-1', provider_id: TEST_PROVIDER_ID,
          type: 'child_in_care_statement', subject_id: 'kid-1',
          snapshot_hash: 'abcdef12', snapshot_version: null,
          acknowledged_via: 'in_person_paper', archived_at: null,
        },
        {
          id: 'ack-2', provider_id: TEST_PROVIDER_ID,
          type: 'lead_disclosure', subject_id: 'kid-1',
          snapshot_hash: '11111111', snapshot_version: 'v1',
          acknowledged_via: 'in_person_paper', archived_at: null,
        },
        {
          id: 'ack-3', provider_id: TEST_PROVIDER_ID,
          type: 'firearms_disclosure', subject_id: 'kid-1',
          snapshot_hash: '22222222', snapshot_version: 'v1',
          acknowledged_via: 'in_person_paper', archived_at: null,
        },
      ]

      render(
        <MemoryRouter initialEntries={['/parent/intake-acknowledge?child=kid-1']}>
          <Routes>
            <Route path="/parent/intake-acknowledge"
              element={<ParentIntakeAcknowledgePage />} />
          </Routes>
        </MemoryRouter>
      )

      const button = await screen.findByRole('button', {
        name: /I confirm these acknowledgments/i,
      }, { timeout: 2000 })

      fireEvent.click(button)

      await waitFor(() => {
        expect(inserts.filter(i => i.table === 'acknowledgments').length)
          .toBeGreaterThan(0)
      }, { timeout: 2000 })

      // Archive UPDATE on the existing rows.
      const ackArchives = updates.filter(
        u => u.table === 'acknowledgments' && u.payload.archived_at,
      )
      expect(ackArchives).toHaveLength(1)

      // INSERT of envelope + 2 sub-rows = 3 rows.
      const ackInserts = inserts.filter(i => i.table === 'acknowledgments')
      expect(ackInserts).toHaveLength(1)
      const rows = ackInserts[0].rows
      expect(rows).toHaveLength(3)
      const types = rows.map(r => r.type).sort()
      expect(types).toEqual([
        'child_in_care_statement', 'firearms_disclosure', 'lead_disclosure',
      ])
      for (const row of rows) {
        expect(row.provider_id).toBe(TEST_PROVIDER_ID)
        expect(row.acknowledged_via).toBe('parent_portal')
        expect(row.acknowledged_by_user_id).toBe(mockUser.id)
      }

      // Resolve RPC fired once.
      const resolveCalls = rpcCalls.filter(
        c => c.name === 'reminder_instance_resolve_for_parent'
      )
      expect(resolveCalls).toHaveLength(1)
    },
  )

  it(
    'child without user_id AND no existing acks: shows the legacy error ' +
    '(defensive — we do not invent a provider)',
    async () => {
      // Pathological row: a legacy child missing user_id and no acks.
      // Should NOT silently write rows with provider_id = null.
      tableData.children = [{
        id: 'kid-1',
        first_name: 'Aiden',
        last_name: 'Tester',
        family_id: 'fam-1',
        date_of_birth: '2024-01-01',
        // user_id intentionally absent
      }]
      tableData.acknowledgments = []

      render(
        <MemoryRouter initialEntries={['/parent/intake-acknowledge?child=kid-1']}>
          <Routes>
            <Route path="/parent/intake-acknowledge"
              element={<ParentIntakeAcknowledgePage />} />
          </Routes>
        </MemoryRouter>
      )

      const button = await screen.findByRole('button', {
        name: /I confirm these acknowledgments/i,
      }, { timeout: 2000 })

      fireEvent.click(button)

      await waitFor(() => {
        expect(screen.queryByText(/No provider on file/i)).not.toBeNull()
      }, { timeout: 2000 })

      // No insert; no rpc.
      expect(inserts.filter(i => i.table === 'acknowledgments')).toEqual([])
      expect(rpcCalls.filter(c => c.name === 'reminder_instance_resolve_for_parent'))
        .toEqual([])
    },
  )
})
