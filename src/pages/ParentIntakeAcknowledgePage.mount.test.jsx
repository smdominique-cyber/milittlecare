// PR #16 follow-up — Issue #1 regression guard.
//
// The third-pass build introduced a Rules-of-Hooks violation
// (useMemo below the `if (loading) return` early-return) that
// crashed every parent's session at /parent/intake-acknowledge with
// React minified error #310 "Rendered more hooks than during the
// previous render." It shipped because the existing tests for this
// PR mock the helpers but never MOUNT the component — green tests
// proved nothing about render-time hook ordering.
//
// This test mounts the page through the loading→loaded transition
// with a mocked parent session, one pending reminder, and zero
// existing acks, asserting the render does not throw and the
// post-fetch UI appears. It is the test class that would have
// caught #310 and didn't exist.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// ─── Mock supabase + parentIntakeReminders before importing the page ──

const mockUser = { id: 'parent-uid', email: 'parent@example.com' }

// The chain the page uses:
//   supabase.auth.getUser()
//   supabase.from('parent_family_links').select(...).eq(...).eq(...) ⇒ data
//   supabase.from('children').select(...).in(...).is(...) ⇒ data
//   supabase.from('acknowledgments').select(...).eq(...).in(...).is(...) ⇒ data
//   supabase.rpc('reminder_instance_list_for_parent') ⇒ data
//
// We hand-roll a fluent mock that resolves each .from(table) chain
// to a table-specific dataset, and supabase.rpc returns a fixed
// pending-list result. This is the minimum surface to exercise the
// page's load path through to first render.

const tableData = {
  parent_family_links: [{ family_id: 'fam-1' }],
  children: [{
    id: 'kid-1',
    first_name: 'Aiden',
    last_name: 'Tester',
    family_id: 'fam-1',
    date_of_birth: '2024-01-01',
  }],
  acknowledgments: [],
}

function chainFor(table) {
  const chain = {
    select() { return chain },
    eq() { return chain },
    in() { return chain },
    is() { return chain },
    then(resolve, reject) {
      return Promise.resolve({ data: tableData[table] ?? [], error: null })
        .then(resolve, reject)
    },
  }
  return chain
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: mockUser } })) },
    from: vi.fn((t) => chainFor(t)),
    rpc: vi.fn(async (name) => {
      if (name === 'reminder_instance_list_for_parent') {
        return {
          data: [{ id: 'rem-1', subject_id: 'kid-1' }],
          error: null,
        }
      }
      return { data: null, error: null }
    }),
  },
}))

// parentIntakeReminders is imported by the page and calls supabase.rpc
// internally. The mock above already returns the right shape; we
// don't need to re-mock the helper. Verified by the resolve path
// test in parentIntakeReminders.test.js.

const { default: ParentIntakeAcknowledgePage } = await import(
  './ParentIntakeAcknowledgePage'
)

beforeEach(() => {
  cleanup()
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
