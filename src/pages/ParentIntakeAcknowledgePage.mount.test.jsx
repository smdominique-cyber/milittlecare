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
  //
  // 2026-06-14 mig 041 — the page now dispatches via
  // findPendingPacketForChild before calling the legacy
  // intake_confirm_for_parent RPC; that query terminates with
  // .order().limit().maybeSingle(). The chain has to handle all
  // three. maybeSingle resolves from `tableData[table]` shaped as
  // a single object (or null if missing) so a default empty
  // tableData implies "no pending packet" → the page falls through
  // to the legacy RPC, preserving every existing test's contract.
  let mode = 'select'
  let updatePayload = null
  const chain = {
    select() { mode = 'select'; return chain },
    eq() { return chain },
    in() { return chain },
    is() { return chain },
    order() { return chain },
    limit() { return chain },
    maybeSingle() {
      const raw = tableData[table]
      const single = Array.isArray(raw)
        ? (raw[0] ?? null)
        : (raw ?? null)
      return Promise.resolve({ data: single, error: null })
    },
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

// ─── Confirm path (the parent-confirm RPC fix, 2026-05-29) ──────────
//
// PRODUCTION BUG (the one that shipped through the previous test suite):
// confirmChild issued two separate HTTP requests — first an archive
// UPDATE on acknowledgments, then a parent_portal INSERT. The archive
// ran under the parent's session, which has NO update policy on
// acknowledgments (migration 024 only grants UPDATE to providers via
// `provider_id = auth.uid()`). PostgREST returned HTTP 200 with zero
// rows affected; no JS error. The INSERT then collided with the still-
// active provider_override rows on the `acknowledgments_active_unique`
// partial index. Duplicate-key error.
//
// FIX: migration 025 introduces `intake_confirm_for_parent`, a
// SECURITY DEFINER RPC that does archive + insert + reminder-resolve
// atomically in one transaction. confirmChild now makes ONE rpc()
// call and zero direct DB writes.
//
// TEST APPROACH — structural, with an honest limitation:
//
// The bug class we are guarding against is "JS does separate
// archive + insert HTTP calls on `acknowledgments`." The structural
// assertion is therefore:
//   1. The page makes ONE rpc('intake_confirm_for_parent') call with
//      the correct payload shape.
//   2. The page makes ZERO direct `.from('acknowledgments').update()`
//      or `.insert()` calls during confirm.
//   3. The legacy separate `reminder_instance_resolve_for_parent` rpc
//      call is GONE (the RPC handles resolve inline; a separate call
//      would prove the JS still owns the resolve, defeating the
//      atomicity guarantee).
//
// This makes the bug class impossible to recur from the JS side: if a
// future refactor brings back the separate archive/insert pattern,
// these tests fail.
//
// What the tests DO NOT prove (flagged honestly): the unique-
// constraint behavior INSIDE the RPC. The atomic archive-then-insert,
// the channel-override behavior, the parent_family_links scoping —
// those are database-level invariants. The chainFor mock here does
// not model the partial unique index, RLS, or transactional
// semantics. The migration's verification queries (and the planned
// manual smoke test) cover those.
//
// We considered (b) modeling per-(type, subject) active-row state in
// the mock so a missed archive would simulate the constraint
// violation. Rejected: the post-fix code makes ZERO direct DB writes
// to acknowledgments, so a JS-side missed archive is no longer the
// failure mode — the structural assertions above eliminate that
// class without needing constraint modeling. Adding constraint
// modeling would test a code path that no longer exists.

describe('ParentIntakeAcknowledgePage confirm path — RPC-driven', () => {
  // Shared helper: collect the calls to intake_confirm_for_parent.
  function intakeConfirmCalls() {
    return rpcCalls.filter(c => c.name === 'intake_confirm_for_parent')
  }

  it(
    'portal-trigger normal state (no pre-existing acks): ' +
    'clicking confirm makes ONE intake_confirm_for_parent RPC call ' +
    'with the envelope row, and NO direct archive/insert on acknowledgments',
    async () => {
      // Default fixture: one pending reminder for kid-1, zero acks,
      // children carry user_id = TEST_PROVIDER_ID. Pre-122f2ab this was
      // the production state where the dead-button bug was hit.
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
        expect(intakeConfirmCalls().length).toBe(1)
      }, { timeout: 2000 })

      // The single RPC call's payload.
      const [call] = intakeConfirmCalls()
      expect(call.args.p_child_id).toBe('kid-1')
      expect(Array.isArray(call.args.p_rows)).toBe(true)
      // No pre-existing sub-rows → envelope only.
      expect(call.args.p_rows).toHaveLength(1)
      const envelope = call.args.p_rows[0]
      expect(envelope.type).toBe('child_in_care_statement')
      // Server-overridden fields are NOT included in the parent's
      // payload — the RPC sets them from auth.uid() / children.user_id.
      // The JS contributes only the bundle shape.
      expect(envelope).toEqual({
        type: 'child_in_care_statement',
        snapshot_hash: expect.any(String),
        snapshot_version: null,
      })

      // STRUCTURAL — the bug-class assertion:
      // confirmChild makes NO direct writes to acknowledgments.
      expect(inserts.filter(i => i.table === 'acknowledgments')).toEqual([])
      expect(updates.filter(u => u.table === 'acknowledgments')).toEqual([])

      // STRUCTURAL — the legacy resolve-as-separate-call pattern is
      // GONE. The RPC resolves the reminder inline as part of the
      // same atomic transaction.
      expect(rpcCalls.filter(c => c.name === 'reminder_instance_resolve_for_parent'))
        .toEqual([])

      // No error banner.
      expect(screen.queryByText(/No provider on file/i)).toBeNull()
    },
  )

  it(
    'existing-acks state (in_person_paper bundle): the RPC call carries ' +
    'envelope + every pre-existing sub-row type, parent contributes only the shape',
    async () => {
      // Provider previously used in_person_paper. The parent's confirm
      // re-stamps via the RPC; the JS sends the type+hash+version per
      // row, the RPC overrides the channel + parent identity server-side.
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
        expect(intakeConfirmCalls().length).toBe(1)
      }, { timeout: 2000 })

      const [call] = intakeConfirmCalls()
      expect(call.args.p_child_id).toBe('kid-1')
      const rows = call.args.p_rows
      expect(rows).toHaveLength(3)  // envelope + lead + firearms
      const types = rows.map(r => r.type).sort()
      expect(types).toEqual([
        'child_in_care_statement', 'firearms_disclosure', 'lead_disclosure',
      ])
      // The parent's payload carries only type / snapshot_hash /
      // snapshot_version. No security-critical fields.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          'snapshot_hash', 'snapshot_version', 'type',
        ])
      }

      // Structural: zero direct acknowledgments writes; zero separate
      // resolve RPC call.
      expect(inserts.filter(i => i.table === 'acknowledgments')).toEqual([])
      expect(updates.filter(u => u.table === 'acknowledgments')).toEqual([])
      expect(rpcCalls.filter(c => c.name === 'reminder_instance_resolve_for_parent'))
        .toEqual([])
    },
  )

  it(
    'post-send-to-portal state (full 7-row provider_override bundle): ' +
    'RPC call carries every type — the unique-constraint scenario can no ' +
    'longer recur from the JS side',
    async () => {
      // Reproduce the EXACT production state where Aleshia\'s confirm
      // hit acknowledgments_active_unique: a single provider_override
      // bundle, 5 active sub-rows + 1 envelope = 6 active rows. (The
      // production case had 5 because lead+firearms weren\'t required;
      // here we exercise the full 8-row case (envelope + 7 sub-rows
      // post the 2026-05-29 licensing_rules_offered addition) so the
      // full sweep is tested. Both shapes go through the same RPC call.)
      const PROVIDER_REASON =
        'Provider attested at intake on 2026-05-29; parent notified to confirm.'
      tableData.acknowledgments = [
        // envelope
        {
          id: 'a-env', provider_id: TEST_PROVIDER_ID,
          type: 'child_in_care_statement', subject_id: 'kid-1',
          snapshot_hash: 'env-hash-1', snapshot_version: null,
          acknowledged_via: 'provider_override',
          provider_override_reason: PROVIDER_REASON,
          archived_at: null,
        },
        // sub-rows (7 after 2026-05-29 — licensing_rules_offered added)
        ...[
          'lead_disclosure',
          'firearms_disclosure',
          'food_provider_agreement',
          'licensing_notebook_offered',   // R 400.1907(1)(b)(vii)
          'licensing_rules_offered',      // R 400.1907(1)(b)(iii) — new 2026-05-29
          'health_condition',
          'discipline_policy_receipt',
        ].map((t, i) => ({
          id: `a-sub-${i}`, provider_id: TEST_PROVIDER_ID,
          type: t, subject_id: 'kid-1',
          snapshot_hash: `sub-hash-${i}`, snapshot_version: 'v1',
          acknowledged_via: 'provider_override',
          provider_override_reason: PROVIDER_REASON,
          archived_at: null,
        })),
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
        expect(intakeConfirmCalls().length).toBe(1)
      }, { timeout: 2000 })

      const [call] = intakeConfirmCalls()
      const rows = call.args.p_rows
      // 8 rows: envelope + 7 sub-rows (2026-05-29 width — adds
      // licensing_rules_offered for R 400.1907(1)(b)(iii)).
      expect(rows).toHaveLength(8)
      expect(rows.map(r => r.type).sort()).toEqual([
        'child_in_care_statement',
        'discipline_policy_receipt',
        'firearms_disclosure',
        'food_provider_agreement',
        'health_condition',
        'lead_disclosure',
        'licensing_notebook_offered',
        'licensing_rules_offered',  // added 2026-05-29
      ])

      // STRUCTURAL — the production duplicate-key bug class cannot
      // recur from the client side: no separate archive UPDATE, no
      // separate INSERT, no separate resolve RPC. The RPC's
      // transactional archive+insert+resolve is the only writer.
      expect(inserts.filter(i => i.table === 'acknowledgments')).toEqual([])
      expect(updates.filter(u => u.table === 'acknowledgments')).toEqual([])
      expect(rpcCalls.filter(c => c.name === 'reminder_instance_resolve_for_parent'))
        .toEqual([])

      // The single intake_confirm_for_parent rpc is the only writer
      // touching acknowledgments / reminder_instances during confirm.
      const writerCalls = rpcCalls.filter(c =>
        c.name === 'intake_confirm_for_parent' ||
        c.name === 'reminder_instance_resolve_for_parent'
      )
      expect(writerCalls).toHaveLength(1)
      expect(writerCalls[0].name).toBe('intake_confirm_for_parent')
    },
  )

  it(
    'RPC error surfaces to the user via the error banner ' +
    '(auth failure is visible, not silently no-op)',
    async () => {
      // The RPC raises (e.g., parent↔child link missing) — supabase.rpc
      // returns { error }. The JS surfaces it via setError. Mirrors the
      // production behavior the RPC\'s "raise on invalid auth" choice
      // is supposed to give us.
      //
      // Override the rpc mock for THIS test only — intake_confirm_for_parent
      // returns the auth-failure error.
      const supa = (await import('@/lib/supabase')).supabase
      const originalRpc = supa.rpc
      supa.rpc = vi.fn(async (name, args) => {
        rpcCalls.push({ name, args })
        if (name === 'reminder_instance_list_for_parent') {
          return { data: [{ id: 'rem-1', subject_id: 'kid-1' }], error: null }
        }
        if (name === 'intake_confirm_for_parent') {
          return {
            data: null,
            error: {
              message:
                'intake_confirm_for_parent: caller is not an active parent ' +
                'for this child, or child not found',
            },
          }
        }
        return { data: null, error: null }
      })
      try {
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

        // The page's existing error banner surfaces it.
        await waitFor(() => {
          expect(screen.queryByText(/not an active parent/i)).not.toBeNull()
        }, { timeout: 2000 })

        // No optimistic state change — confirmChild's try/catch caught
        // the error and the RPC's atomicity means no rows were
        // partially written. Structural: zero direct DB writes either.
        expect(inserts.filter(i => i.table === 'acknowledgments')).toEqual([])
        expect(updates.filter(u => u.table === 'acknowledgments')).toEqual([])
      } finally {
        supa.rpc = originalRpc
      }
    },
  )
})
