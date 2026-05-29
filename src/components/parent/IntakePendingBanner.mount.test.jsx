// PR #16 follow-up — IntakePendingBanner regression guard.
//
// Two cases per spec:
//   (a) Parent has ≥1 pending intake_acknowledgment_pending reminder →
//       banner renders with a link to /parent/intake-acknowledge.
//   (b) Parent has no pending intake reminders → banner does NOT render.
//
// CRITICAL data-path assertion: the banner calls the
// `reminder_instance_list_for_parent` RPC, NOT a direct
// `from('reminder_instances').select(...)` chain. Direct SELECTs return
// empty under parent RLS (PR #16 third pass bug). We assert the call
// shape to keep that bug class from reappearing here.
//
// We mount the standalone banner under MemoryRouter — the dashboard is
// 997 lines and pulls heavy data that's irrelevant to this surface.
// Coverage equivalence: the banner is the unit; the dashboard just
// mounts it with `parentId` and `children` props.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const rpcCalls = []
const fromCalls = []

// Default: one pending reminder for kid-1. Tests override `rpcImpl` to
// shape the RPC result.
let rpcImpl = async () => ({
  data: [{ id: 'rem-1', subject_id: 'kid-1' }],
  error: null,
})

vi.mock('@/lib/supabase', () => ({
  supabase: {
    // The banner MUST go through the RPC. If a future refactor changes
    // it to use `.from('reminder_instances').select(...)`, the
    // structural assertion below will fail (fromCalls receives the
    // table name) AND the banner will surface zero results in
    // production (because parent RLS denies the direct read).
    from: vi.fn((table) => {
      fromCalls.push(table)
      return { select: () => ({ eq: () => ({ in: () => ({ is: () => Promise.resolve({ data: [], error: null }) }) }) }) }
    }),
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args })
      if (name === 'reminder_instance_list_for_parent') {
        return rpcImpl(args)
      }
      return { data: null, error: null }
    }),
  },
}))

const { default: IntakePendingBanner } = await import('./IntakePendingBanner')

beforeEach(() => {
  cleanup()
  rpcCalls.length = 0
  fromCalls.length = 0
  // Reset to the "one pending" default.
  rpcImpl = async () => ({
    data: [{ id: 'rem-1', subject_id: 'kid-1' }],
    error: null,
  })
})

const childrenFixture = [
  { id: 'kid-1', first_name: 'Aleshia', last_name: 'Drambo', family_id: 'fam-1' },
  { id: 'kid-2', first_name: 'Aiden',   last_name: 'Drambo', family_id: 'fam-1' },
]

function renderBanner(props = {}) {
  const defaults = { parentId: 'parent-uid', children: childrenFixture }
  return render(
    <MemoryRouter>
      <IntakePendingBanner {...defaults} {...props} />
    </MemoryRouter>
  )
}

describe('IntakePendingBanner', () => {
  it('(a) renders the banner with a link to the Intake page when the RPC returns ≥1 pending reminder', async () => {
    renderBanner()

    // The banner names the affected child (single-child copy path).
    await waitFor(() => {
      expect(screen.queryByText(/Action needed: intake acknowledgment/i)).not.toBeNull()
    }, { timeout: 2000 })
    expect(screen.queryByText(/Aleshia/)).not.toBeNull()

    // The CTA links to /parent/intake-acknowledge (the Intake tab).
    const link = screen.getByRole('link', { name: /Review and confirm/i })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/parent/intake-acknowledge')

    // ── Data-path proof ─────────────────────────────────────────────
    // The banner went through the SECURITY DEFINER RPC, NOT a direct
    // `from('reminder_instances')` chain. This is the structural guard
    // that keeps the RLS-blind direct-SELECT bug class from recurring.
    const listCalls = rpcCalls.filter(
      c => c.name === 'reminder_instance_list_for_parent'
    )
    expect(listCalls).toHaveLength(1)
    expect(fromCalls.includes('reminder_instances')).toBe(false)
  })

  it('(b) renders nothing when the RPC returns no pending reminders', async () => {
    rpcImpl = async () => ({ data: [], error: null })
    const { container } = renderBanner()

    // Wait for the banner's load effect to settle. With zero pending
    // rows the banner stays null — we assert the container is empty
    // and (defensively) that no "Action needed" text appears.
    await waitFor(() => {
      const listCalls = rpcCalls.filter(
        c => c.name === 'reminder_instance_list_for_parent'
      )
      expect(listCalls).toHaveLength(1)
    }, { timeout: 2000 })
    expect(screen.queryByText(/Action needed: intake acknowledgment/i)).toBeNull()
    expect(screen.queryByRole('link', { name: /Review and confirm/i })).toBeNull()
    expect(container.firstChild).toBeNull()
  })

  it('uses multi-child copy when the RPC returns pending reminders for >1 child', async () => {
    rpcImpl = async () => ({
      data: [
        { id: 'rem-1', subject_id: 'kid-1' },
        { id: 'rem-2', subject_id: 'kid-2' },
      ],
      error: null,
    })
    renderBanner()

    // Multi-child copy says "for 2 children" — does not enumerate names.
    await waitFor(() => {
      expect(screen.queryByText(/for 2 children/i)).not.toBeNull()
    }, { timeout: 2000 })
    // Specifically does NOT use single-name copy.
    expect(screen.queryByText(/for Aleshia\./)).toBeNull()
  })

  it('renders nothing when the RPC errors (banner is non-fatal; Intake-tab badge is the backstop)', async () => {
    rpcImpl = async () => ({ data: null, error: { message: 'simulated rpc failure' } })
    renderBanner()

    await waitFor(() => {
      const listCalls = rpcCalls.filter(
        c => c.name === 'reminder_instance_list_for_parent'
      )
      expect(listCalls).toHaveLength(1)
    }, { timeout: 2000 })
    expect(screen.queryByText(/Action needed/i)).toBeNull()
  })

  it('renders nothing while parentId is not yet set (avoids a flash before session lands)', async () => {
    renderBanner({ parentId: null })

    // No RPC call without a parentId; banner stays null.
    await waitFor(() => {
      // Tiny wait to confirm the effect didn't run.
      expect(rpcCalls.filter(c => c.name === 'reminder_instance_list_for_parent')).toHaveLength(0)
    }, { timeout: 200 })
    expect(screen.queryByText(/Action needed/i)).toBeNull()
  })

  it('falls back to the count copy when the pending child is missing from the children prop', async () => {
    // A child present in the RPC result but not in the dashboard's
    // loaded children prop — e.g., a stale family-link change. Banner
    // does NOT silently drop the row; it just uses count-style copy.
    rpcImpl = async () => ({
      data: [{ id: 'rem-X', subject_id: 'kid-unknown' }],
      error: null,
    })
    renderBanner({ children: childrenFixture })

    await waitFor(() => {
      expect(screen.queryByText(/Action needed/i)).not.toBeNull()
    }, { timeout: 2000 })
    // Count-style fallback copy: "for 1 child." (singular unit because
    // pendingChildIds.length === 1). The unknown child contributes to
    // the count but cannot be named.
    expect(screen.queryByText(/for 1 child/i)).not.toBeNull()
    // Definitely does NOT use single-name copy for this case (no name to use).
    expect(screen.queryByText(/for Aleshia/)).toBeNull()
  })
})
