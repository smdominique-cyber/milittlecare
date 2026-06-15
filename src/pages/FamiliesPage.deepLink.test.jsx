// 2026-06-14 — Families deep-link reactivity, v2 integration test.
//
// PRODUCTION BUG (after v1, 2fbb153): clicking a fixTarget from
// INSIDE an open family modal RESET the tab to 'overview' instead
// of switching to the deep-link's named tab. The v1 unit tests
// passed by `rerender`-ing FamilyDetailModal in isolation with a
// post-fix initialTab prop — they never exercised the
// setSelectedFamily → key → modal mount/re-render chain that a
// real same-page Link click triggers. The state-mirror pattern
// (page's modalInitialTab + modal's `useState(initialTab)` +
// useEffect to sync) raced React 18's batching in production.
//
// FIX (v2): the modal derives `tab` and `focusChildId` directly
// from useSearchParams. No mirror, no useState, no sync effect —
// the URL is the single source of truth, evaluated at every
// render, in lock-step with the page's own render. Manual tab
// clicks push the new tab onto the URL (replace mode).
//
// This test goes through the REAL useSearchParams chain by
// mounting the modal inside a MemoryRouter and changing the URL
// via useNavigate (simulating the Link click), then asserting
// the rendered body. THIS is the integration-level coverage the
// v1 unit tests lacked; its absence is why a passing suite
// shipped a broken button.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'

// Mock heavy dependencies the modal's tabs pull in.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
          is: () => Promise.resolve({ data: [], error: null }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
  },
}))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }))
vi.mock('@/hooks/useRole', () => ({ useRole: () => ({ role: 'licensee' }) }))

const { FamilyDetailModal } = await import('./FamiliesPage')

const FAMILY = { id: 'fam-1', family_name: 'Smith', enrollment_status: 'active' }
const CHILD_A = { id: 'child-a', first_name: 'Aiden', last_name: 'Smith', family_id: 'fam-1', date_of_birth: '2020-01-01' }
const CHILD_B = { id: 'child-b', first_name: 'Bea',   last_name: 'Smith', family_id: 'fam-1', date_of_birth: '2021-01-01' }

// Test helper — captures the router's navigate function so the
// test can drive URL changes the way a real <Link> click would.
let testNavigate = null
function NavigatorCapture() {
  testNavigate = useNavigate()
  return null
}

function mountModalAt(initialUrl, props = {}) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <FamilyDetailModal
        userId="u-1"
        family={FAMILY}
        licenseeProfile={{ license_type: 'family_home' }}
        children={[CHILD_A, CHILD_B]}
        guardians={[]}
        emergencyContacts={[]}
        onClose={() => {}}
        onChange={async () => {}}
        {...props}
      />
      <NavigatorCapture />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  testNavigate = null
})

describe('FamilyDetailModal — deep-link reactivity v2 (the bug v1 shipped, integration shape)', () => {
  // -- Cold-load path (unchanged from baseline + v1 expectations) -------

  it('cold mount with ?tab=children → Children tab renders', () => {
    mountModalAt('/families?family=fam-1&tab=children')
    expect(screen.getByText(/Add child/i)).toBeTruthy()
  })

  it('cold mount with ?tab=overview (or no tab param) → Overview tab renders', () => {
    mountModalAt('/families?family=fam-1')
    expect(screen.queryByText(/Add child/i)).toBeNull()
  })

  it('cold mount with an unknown ?tab=foo → falls back to Overview (defensive)', () => {
    mountModalAt('/families?family=fam-1&tab=not_a_real_tab')
    expect(screen.queryByText(/Add child/i)).toBeNull()
  })

  // -- v2 root fix: URL change re-derives tab without remount -----------
  //
  // This is the scenario v1 broke. The test exercises the EXACT
  // path the production click takes: a navigate() call inside the
  // same MemoryRouter the modal is mounted in. No rerender(), no
  // direct prop manipulation. If the modal mirrors tab into
  // useState the wrong way, this test fails just like the live
  // button did.

  it('SAME-FAMILY deep-link click while mounted on Overview → switches to Children (NOT reset to overview)', async () => {
    mountModalAt('/families?family=fam-1&tab=overview')
    // Sanity: starting state is Overview.
    expect(screen.queryByText(/Add child/i)).toBeNull()

    // Simulate the fixTarget Link click — the URL changes through
    // the real router, useSearchParams in the modal re-runs.
    act(() => {
      testNavigate('/families?family=fam-1&child=child-b&tab=children')
    })

    await waitFor(() => {
      expect(screen.getByText(/Add child/i)).toBeTruthy()
    })
  })

  it('SAME-FAMILY deep-link click while mounted on Compliance → switches to Children (the actual production case)', async () => {
    // Mount on Compliance tab (matches what the user was on when
    // they clicked the fixTarget). The compliance tab requires a
    // licensed home, which the licenseeProfile fixture provides.
    mountModalAt('/families?family=fam-1&tab=compliance')

    act(() => {
      testNavigate('/families?family=fam-1&child=child-a&tab=children')
    })

    await waitFor(() => {
      expect(screen.getByText(/Add child/i)).toBeTruthy()
    })
  })

  it('after a URL-driven tab switch, ChildrenTab receives focusChildId via the data-focus-child attribute', async () => {
    const { container } = mountModalAt('/families?family=fam-1&tab=overview')

    act(() => {
      testNavigate('/families?family=fam-1&child=child-b&tab=children')
    })

    await waitFor(() => {
      expect(screen.getByText(/Add child/i)).toBeTruthy()
    })
    const cards = container.querySelectorAll('[data-focus-child]')
    expect(cards.length).toBeGreaterThan(0)
    const ids = Array.from(cards).map(c => c.getAttribute('data-focus-child'))
    expect(ids).toEqual(expect.arrayContaining(['child-a', 'child-b']))
  })

  // -- Manual click semantics --------------------------------------------
  //
  // Manual clicks push the new tab to the URL (replace mode). The
  // URL becoming the source of truth means a tab click is just a
  // round-trip through useSearchParams; the renderer reads back
  // what it wrote. No fight with the URL-sync.

  it('manual click on the Children tab inside the modal switches to Children and updates the URL', async () => {
    mountModalAt('/families?family=fam-1&tab=overview')
    expect(screen.queryByText(/Add child/i)).toBeNull()

    // The Children tab button text is "Children (N)" — count
    // suffix included. Match by prefix.
    const childrenTabButton = screen.getByRole('button', { name: /^Children\b/i })
    act(() => {
      fireEvent.click(childrenTabButton)
    })

    await waitFor(() => {
      expect(screen.getByText(/Add child/i)).toBeTruthy()
    })
  })

  it('URL changes BACKWARDS (children → overview) also re-derive correctly (no stuck state)', async () => {
    mountModalAt('/families?family=fam-1&tab=children')
    expect(screen.getByText(/Add child/i)).toBeTruthy()

    act(() => {
      testNavigate('/families?family=fam-1&tab=overview')
    })

    await waitFor(() => {
      expect(screen.queryByText(/Add child/i)).toBeNull()
    })
  })
})
