// 2026-06-14 — deep-link reactivity regression guard for
// FamilyDetailModal.
//
// PRODUCTION BUG: the compliance fixTarget link
// (/families?family=X&child=Y&tab=children) worked from a cold load
// but did NOTHING when the user was ALREADY inside the family modal
// (e.g. on the Compliance tab clicking a child's row). The URL
// updated and the parent FamiliesPage useEffect re-fired, but the
// modal's internal `tab` state was initialized once from the
// `initialTab` prop and never re-read it. The same problem would
// have applied to focusChildId — but it was never plumbed through.
//
// FIX: a useEffect inside FamilyDetailModal re-syncs `tab` whenever
// `initialTab` changes (and the modal is not in 'new family' mode).
// The Children tab now receives `focusChildId`, exposes a
// `data-focus-child` attribute on each card, and a sibling useEffect
// scrolls + flashes the matching card when focusChildId changes.
//
// Test approach — mount FamilyDetailModal directly via its named
// export (added in the same commit). This isolates the tab-reactivity
// fix from the full FamiliesPage data-load path, which is the
// behavior the URL change is supposed to drive at the modal layer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The modal's children tabs render their own components which import
// supabase + various heavy modules. Mock at the surface so the test
// stays focused on the prop-reactivity behavior under test.
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

function renderModal(props = {}) {
  return render(
    <MemoryRouter>
      <FamilyDetailModal
        userId="u-1"
        family={FAMILY}
        licenseeProfile={{ license_type: 'family_home' }}
        children={[CHILD_A, CHILD_B]}
        guardians={[]}
        emergencyContacts={[]}
        initialTab="overview"
        focusChildId={null}
        onClose={() => {}}
        onChange={async () => {}}
        {...props}
      />
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('FamilyDetailModal — deep-link reactivity (Issue: same-page deep-link did nothing)', () => {
  it('cold mount with initialTab="children" → Children tab is visible (preserves the working cold-load path)', () => {
    renderModal({ initialTab: 'children' })
    // The Children tab renders an "Add child" button — a stable
    // marker that the tab body mounted. Overview never renders this
    // string, so its presence is a reliable tab discriminator.
    expect(screen.getByText(/Add child/i)).toBeTruthy()
  })

  it('cold mount with initialTab="overview" → Overview tab is visible (default path unchanged)', () => {
    renderModal({ initialTab: 'overview' })
    // Overview renders the family-name field. Children tab does
    // not.
    expect(screen.queryByText(/Add child/i)).toBeNull()
  })

  it('prop change initialTab "overview" → "children" while mounted → re-renders to Children tab', async () => {
    const { rerender } = renderModal({ initialTab: 'overview' })
    expect(screen.queryByText(/Add child/i)).toBeNull()

    rerender(
      <MemoryRouter>
        <FamilyDetailModal
          userId="u-1"
          family={FAMILY}
          licenseeProfile={{ license_type: 'family_home' }}
          children={[CHILD_A, CHILD_B]}
          guardians={[]}
          emergencyContacts={[]}
          initialTab="children"
          focusChildId={null}
          onClose={() => {}}
          onChange={async () => {}}
        />
      </MemoryRouter>
    )

    // The useEffect on initialTab fires inside the modal, calling
    // setTab('children'). React schedules the re-render; waitFor
    // catches it once it commits.
    await waitFor(() => {
      expect(screen.getByText(/Add child/i)).toBeTruthy()
    })
  })

  it('prop change initialTab "children" → "overview" while mounted → re-renders to Overview tab (manual click semantics not regressed)', async () => {
    const { rerender } = renderModal({ initialTab: 'children' })
    expect(screen.getByText(/Add child/i)).toBeTruthy()

    rerender(
      <MemoryRouter>
        <FamilyDetailModal
          userId="u-1"
          family={FAMILY}
          licenseeProfile={{ license_type: 'family_home' }}
          children={[CHILD_A, CHILD_B]}
          guardians={[]}
          emergencyContacts={[]}
          initialTab="overview"
          focusChildId={null}
          onClose={() => {}}
          onChange={async () => {}}
        />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.queryByText(/Add child/i)).toBeNull()
    })
  })

  it('on Children tab, focusChildId param exposes a data-focus-child attribute on the matching card (deep-link target)', () => {
    const { container } = renderModal({ initialTab: 'children', focusChildId: 'child-b' })
    const cards = container.querySelectorAll('[data-focus-child]')
    const ids = Array.from(cards).map(c => c.getAttribute('data-focus-child'))
    expect(ids).toEqual(expect.arrayContaining(['child-a', 'child-b']))
    // The actual scroll/flash side effect lives behind
    // requestAnimationFrame + a transient class; happydom doesn't
    // implement scrollIntoView meaningfully. The presence of the
    // attribute is what the deep-link relies on to find the target,
    // and that's what we lock here.
  })
})
