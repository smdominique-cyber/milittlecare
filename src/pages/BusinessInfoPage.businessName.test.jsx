// 2026-06-15 — Business name input on BusinessInfoPage.
//
// Pins the four behaviors the task brief specified:
//
//   (1) Renders with the current value pre-filled from
//       `profiles.daycare_name`.
//   (2) Saving a non-empty trimmed value writes that exact string to
//       `profiles.daycare_name` via supabase.from('profiles').update({…})
//       .eq('id', user.id) — the canonical pattern shared with
//       saveLicenseStatus / savePremises.
//   (3) Clearing the input writes NULL (not '') so the read-side
//       fallback chain `daycare_name → full_name → 'Your provider'`
//       behaves correctly. Whitespace-only is also nullified.
//   (4) The new section is reachable via ?section=business_name
//       deep-link (mirrors the PR #16 ?section= contract).
//
// Approach: mount the page with a minimal supabase mock that returns a
// profile row and records every .update() payload + .eq() arg. Drive
// the form via fireEvent. No live DB.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ─── Mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'provider-1', email: 'p@example.com' } }),
}))

vi.mock('@/lib/notifications', () => ({
  notifyStateChange: vi.fn(),
}))

vi.mock('@/components/compliance/ApplicabilityQuestionsSection', () => ({
  default: () => <div data-testid="applicability-stub" />,
}))

// Recorded calls, scoped per-test via beforeEach.
let profilesUpdates
let profilesUpdateEqArgs
let currentProfileDaycareName

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table) => {
      // Chainable mock — distinguishes select.maybeSingle (returns the
      // profiles row) from select.eq().then (lists) from update.eq()
      // (write).
      let mode = 'select'
      let updatePayload = null
      const chain = {
        select: () => { mode = 'select'; return chain },
        eq: (col, val) => {
          if (mode === 'update' && table === 'profiles') {
            profilesUpdateEqArgs.push({ col, val })
          }
          return chain
        },
        order: () => chain,
        update: (payload) => {
          mode = 'update'
          updatePayload = payload
          if (table === 'profiles') {
            profilesUpdates.push(payload)
            // Reflect the write in the in-memory snapshot so a
            // subsequent loadAll() returns the new value.
            if (Object.prototype.hasOwnProperty.call(payload, 'daycare_name')) {
              currentProfileDaycareName = payload.daycare_name
            }
          }
          return chain
        },
        upsert: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        delete: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === 'profiles'
                ? {
                    license_type: 'family_home',
                    license_type_review_needed: false,
                    is_license_exempt: false,
                    home_built_before_1978: null,
                    firearms_on_premises: null,
                    daycare_name: currentProfileDaycareName,
                  }
                : null,
            error: null,
          }),
        // update().eq() resolves to {data,error} via this `then`.
        // select queries also fall through here when not .maybeSingle().
        then: (resolve, reject) => {
          if (mode === 'update') {
            return Promise.resolve({ data: null, error: null }).then(resolve, reject)
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject)
        },
      }
      return chain
    }),
  },
}))

const { default: BusinessInfoPage } = await import('./BusinessInfoPage')

beforeEach(() => {
  profilesUpdates = []
  profilesUpdateEqArgs = []
  currentProfileDaycareName = null
})

afterEach(cleanup)

async function mountAt(path) {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <BusinessInfoPage />
    </MemoryRouter>
  )
  await screen.findByText('Set this once. Stop answering it forever.')
  return utils
}

// ─── (4) Deep-link to the new section ─────────────────────────────────

describe('BusinessInfoPage — Business name section deep link', () => {
  it('?section=business_name selects the Business name tab', async () => {
    currentProfileDaycareName = null
    const { container } = await mountAt('/business-info?section=business_name')
    const active = container.querySelector('.bi-tab.active span')
    expect(active?.textContent).toBe('Business name')
    expect(screen.getByLabelText(/daycare \/ business name/i)).toBeTruthy()
  })
})

// ─── (1) Pre-fill with the current value ──────────────────────────────

describe('BusinessInfoPage — Business name input pre-fill', () => {
  it('renders the input pre-filled with profiles.daycare_name when set', async () => {
    currentProfileDaycareName = "Venessa's Daycare"
    await mountAt('/business-info?section=business_name')
    const input = screen.getByLabelText(/daycare \/ business name/i)
    expect(input.value).toBe("Venessa's Daycare")
  })

  it('renders the input empty when profiles.daycare_name is null', async () => {
    currentProfileDaycareName = null
    await mountAt('/business-info?section=business_name')
    const input = screen.getByLabelText(/daycare \/ business name/i)
    expect(input.value).toBe('')
  })
})

// ─── (2) Saving writes daycare_name to profiles for the licensee ──────

describe('BusinessInfoPage — Business name save', () => {
  it('saving a non-empty value writes the trimmed string to profiles.daycare_name for user.id', async () => {
    currentProfileDaycareName = null
    await mountAt('/business-info?section=business_name')
    const input = screen.getByLabelText(/daycare \/ business name/i)
    fireEvent.change(input, { target: { value: '  Bright Beginnings Daycare  ' } })
    fireEvent.click(screen.getByRole('button', { name: /save business name/i }))

    await waitFor(() => {
      expect(profilesUpdates.length).toBeGreaterThan(0)
    })
    const lastUpdate = profilesUpdates[profilesUpdates.length - 1]
    expect(lastUpdate).toEqual({ daycare_name: 'Bright Beginnings Daycare' })

    // .eq('id', user.id) — the RLS policy `auth.uid() = id` requires this.
    const lastEq = profilesUpdateEqArgs[profilesUpdateEqArgs.length - 1]
    expect(lastEq).toEqual({ col: 'id', val: 'provider-1' })
  })
})

// ─── (3) Clearing writes NULL, not '' ─────────────────────────────────

describe('BusinessInfoPage — empty input writes NULL', () => {
  it('clearing the input writes NULL to profiles.daycare_name', async () => {
    currentProfileDaycareName = 'Existing Daycare Name'
    await mountAt('/business-info?section=business_name')
    const input = screen.getByLabelText(/daycare \/ business name/i)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save business name/i }))

    await waitFor(() => {
      expect(profilesUpdates.length).toBeGreaterThan(0)
    })
    const lastUpdate = profilesUpdates[profilesUpdates.length - 1]
    expect(lastUpdate).toEqual({ daycare_name: null })
    // Crucially NOT '' — the read-side fallback chain depends on null.
    expect(lastUpdate.daycare_name).not.toBe('')
  })

  it('a whitespace-only value also writes NULL (defeats the truthy-whitespace trap)', async () => {
    currentProfileDaycareName = 'Existing Daycare Name'
    await mountAt('/business-info?section=business_name')
    const input = screen.getByLabelText(/daycare \/ business name/i)
    fireEvent.change(input, { target: { value: '     ' } })
    fireEvent.click(screen.getByRole('button', { name: /save business name/i }))

    await waitFor(() => {
      expect(profilesUpdates.length).toBeGreaterThan(0)
    })
    const lastUpdate = profilesUpdates[profilesUpdates.length - 1]
    expect(lastUpdate).toEqual({ daycare_name: null })
  })
})

// ─── Done-chip — section is marked complete once a name is saved ──────

describe('BusinessInfoPage — Business name done-chip', () => {
  it('the Business name tab shows the done check when daycare_name is set', async () => {
    currentProfileDaycareName = "Venessa's Daycare"
    const { container } = await mountAt('/business-info?section=business_name')
    const businessTab = Array.from(container.querySelectorAll('.bi-tab')).find(
      el => el.textContent.includes('Business name')
    )
    expect(businessTab?.querySelector('.bi-check')).toBeTruthy()
  })

  it('the Business name tab has no done check when daycare_name is null', async () => {
    currentProfileDaycareName = null
    const { container } = await mountAt('/business-info?section=business_name')
    const businessTab = Array.from(container.querySelectorAll('.bi-tab')).find(
      el => el.textContent.includes('Business name')
    )
    expect(businessTab?.querySelector('.bi-check')).toBeNull()
  })
})
