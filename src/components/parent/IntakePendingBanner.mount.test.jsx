// 2026-06-15 — mount test for the new IntakePendingBanner.
//
// The road-to-publishable doc flagged "intake banner doesn't show when
// it should." The CONFIRMED cause was that no such banner existed on
// the dashboard. This file pins the new behavior:
//   - empty pending list → renders nothing
//   - one pending child → renders the banner with the child's name
//     and a deep link to /parent/intake-acknowledge?child=<id>
//   - multiple pending children → renders a count and links to
//     /parent/acknowledge?tab=intake
//   - an RPC error from the lib helper → hides the banner (the email
//     dispatcher is fire-once, so the parent still gets reached)
//
// Mocks supabase.rpc directly because listPendingForParent reads from
// it under the hood. No live DB, no live RPC.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ─── Mock supabase before importing the banner ─────────────────────────

let rpcImpl

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (name, args) => {
      if (typeof rpcImpl === 'function') return rpcImpl(name, args)
      return { data: null, error: null }
    }),
  },
}))

const { default: IntakePendingBanner } = await import('./IntakePendingBanner')

beforeEach(() => {
  cleanup()
  rpcImpl = null
})

function renderBanner(props) {
  return render(
    <MemoryRouter>
      <IntakePendingBanner {...props} />
    </MemoryRouter>
  )
}

const PARENT_ID = 'parent-uid-1'

// ─── Empty state ───────────────────────────────────────────────────────

describe('IntakePendingBanner — empty state', () => {
  it('renders nothing when the RPC returns no pending reminders', async () => {
    rpcImpl = () => ({ data: [], error: null })
    renderBanner({ parentId: PARENT_ID, children: [] })
    // Wait for the effect to settle; banner should NEVER appear.
    await waitFor(() => {
      expect(screen.queryByTestId('intake-pending-banner')).toBeNull()
    })
  })

  it('renders nothing when no parentId is supplied', () => {
    renderBanner({ children: [] })
    expect(screen.queryByTestId('intake-pending-banner')).toBeNull()
  })
})

// ─── Error state — banner stays hidden ─────────────────────────────────

describe('IntakePendingBanner — RPC error', () => {
  it('hides the banner when the RPC returns an error', async () => {
    rpcImpl = () => ({ data: null, error: { message: 'rls denied' } })
    renderBanner({ parentId: PARENT_ID, children: [] })
    // Give the effect a chance to run; banner should never mount.
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByTestId('intake-pending-banner')).toBeNull()
  })
})

// ─── Single-child pending ──────────────────────────────────────────────

describe('IntakePendingBanner — one pending child', () => {
  it('renders the banner with the child first name and a child-deep-link', async () => {
    rpcImpl = () => ({
      data: [
        { id: 'rem-1', subject_id: 'child-A' },
        { id: 'rem-2', subject_id: 'child-A' }, // duplicate ids for same child
      ],
      error: null,
    })
    renderBanner({
      parentId: PARENT_ID,
      children: [{ id: 'child-A', first_name: 'Aiden' }],
    })
    await screen.findByTestId('intake-pending-banner')
    expect(screen.getByText(/Aiden's intake packet/i)).toBeTruthy()

    const link = screen.getByRole('link', { name: /review intake/i })
    expect(link.getAttribute('href')).toBe('/parent/intake-acknowledge?child=child-A')
  })

  it('falls back to a no-name sentence when the children prop omits the match', async () => {
    rpcImpl = () => ({
      data: [{ id: 'rem-1', subject_id: 'child-A' }],
      error: null,
    })
    renderBanner({ parentId: PARENT_ID, children: [] })
    await screen.findByTestId('intake-pending-banner')
    expect(screen.getByText(/An intake packet has updates/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /review intake/i })
    // Single child still deep-links to /parent/intake-acknowledge?child=<id>
    expect(link.getAttribute('href')).toBe('/parent/intake-acknowledge?child=child-A')
  })
})

// ─── Multi-child pending ───────────────────────────────────────────────

describe('IntakePendingBanner — multiple pending children', () => {
  it('renders a count and links to the tabbed picker', async () => {
    rpcImpl = () => ({
      data: [
        { id: 'rem-1', subject_id: 'child-A' },
        { id: 'rem-2', subject_id: 'child-B' },
        { id: 'rem-3', subject_id: 'child-C' },
      ],
      error: null,
    })
    renderBanner({
      parentId: PARENT_ID,
      children: [
        { id: 'child-A', first_name: 'Aiden' },
        { id: 'child-B', first_name: 'Bea' },
        { id: 'child-C', first_name: 'Cy' },
      ],
    })
    await screen.findByTestId('intake-pending-banner')
    expect(screen.getByText(/Intake packets for 3 of your children/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /review intake/i })
    expect(link.getAttribute('href')).toBe('/parent/acknowledge?tab=intake')
  })
})

// ─── Wiring contract: actually calls the list RPC ──────────────────────

describe('IntakePendingBanner — wiring', () => {
  it('calls the listPendingForParent RPC name when parentId is present', async () => {
    const seen = []
    rpcImpl = (name) => {
      seen.push(name)
      return { data: [], error: null }
    }
    renderBanner({ parentId: PARENT_ID, children: [] })
    await new Promise(r => setTimeout(r, 0))
    // The lib uses 'reminder_instance_list_for_parent' — encoded in
    // src/lib/parentIntakeReminders.js. Pinning the call here protects
    // against accidental rename without a coordinated migration.
    expect(seen).toContain('reminder_instance_list_for_parent')
  })
})
