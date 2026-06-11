// Phase 3.1b-1 — BusinessInfoPage ?section= deep-linking.
//
// The compliance checklist's awaiting_input fixTargets point at
// /business-info?section=premises and
// /business-info?section=compliance_applicability. This pins the
// param handling: a known id selects that tab on mount; an unknown
// or absent ?section= falls back to the default ('hours') without
// crashing. Mirrors FamiliesPage's KNOWN_TABS validation.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// ─── Mocks (hoisted) ────────────────────────────────────────────────

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'provider-1', email: 'p@example.com' } }),
}))

vi.mock('@/lib/notifications', () => ({
  notifyStateChange: vi.fn(),
}))

// The applicability questionnaire loads its own data — stub it so this
// test exercises only the page's section selection.
vi.mock('@/components/compliance/ApplicabilityQuestionsSection', () => ({
  default: () => <div data-testid="applicability-stub">applicability questionnaire</div>,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'profiles'
              ? {
                  // family_home so the compliance_applicability tab is
                  // in the sections array (it's license-gated).
                  license_type: 'family_home',
                  license_type_review_needed: false,
                  is_license_exempt: false,
                  home_built_before_1978: null,
                  firearms_on_premises: null,
                }
              : null,
            error: null,
          }),
        then: (resolve, reject) =>
          Promise.resolve({ data: [], error: null }).then(resolve, reject),
      }
      return chain
    }),
  },
}))

const { default: BusinessInfoPage } = await import('./BusinessInfoPage')

afterEach(cleanup)

async function mountAt(path) {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <BusinessInfoPage />
    </MemoryRouter>
  )
  // Page shows only a spinner until loadAll() resolves.
  await screen.findByText('Set this once. Stop answering it forever.')
  return utils
}

function activeTabLabel(container) {
  const active = container.querySelector('.bi-tab.active span')
  return active ? active.textContent : null
}

describe('BusinessInfoPage — ?section= deep-linking', () => {
  it('?section=premises selects the Premises tab on mount', async () => {
    const { container } = await mountAt('/business-info?section=premises')
    expect(activeTabLabel(container)).toBe('Premises')
    // Default section is NOT rendered.
    expect(screen.queryByText('Operating Hours')).toBeNull()
  })

  it('?section=compliance_applicability selects the applicability tab and renders the questionnaire', async () => {
    const { container } = await mountAt('/business-info?section=compliance_applicability')
    expect(activeTabLabel(container)).toBe('What applies?')
    expect(screen.getByTestId('applicability-stub')).toBeTruthy()
    expect(screen.queryByText('Operating Hours')).toBeNull()
  })

  it('unknown ?section= falls back to the default tab — no crash', async () => {
    const { container } = await mountAt('/business-info?section=not_a_real_section')
    expect(activeTabLabel(container)).toBe('Hours')
    expect(screen.getByText('Operating Hours')).toBeTruthy()
  })

  it('no ?section= → default behavior unchanged (regression lock)', async () => {
    const { container } = await mountAt('/business-info')
    expect(activeTabLabel(container)).toBe('Hours')
    expect(screen.getByText('Operating Hours')).toBeTruthy()
  })
})
