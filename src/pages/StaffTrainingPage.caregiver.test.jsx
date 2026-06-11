// Phase 3.1b-2 — StaffTrainingPage ?caregiver= deep-linking.
//
// The compliance checklist's staff fixTargets are page-level today
// (the engine aggregates worst-across-caregivers), but the page
// consumes ?caregiver=<id> so any future caregiver-scoped link lands
// on the named caregiver's training-log drill-in. This pins: a known
// id selects that caregiver on mount; an unknown or absent id falls
// back to the roster view without crashing. Mirrors the FamiliesPage
// ?family= validation precedent.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const hookState = vi.hoisted(() => ({ isLicensee: true }))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' } }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}))

vi.mock('@/hooks/useStaffTraining', () => ({
  useStaffTraining: () => ({
    loading: false,
    error: null,
    isLicensee: hookState.isLicensee,
    roster: [
      { id: 'cg-1', full_name: 'Alice Alpha', app_user_id: 'u-1', archived_at: null },
      { id: 'cg-2', full_name: 'Bob Beta', app_user_id: null, archived_at: null },
    ],
    records: [],
    requirements: [],
    updates: [],
    refresh: vi.fn(),
  }),
}))

// Stub the heavy children — this test exercises only the page's
// caregiver selection, not the matrix/log internals.
vi.mock('@/components/staffTraining/StaffComplianceMatrix', () => ({
  default: () => <div data-testid="matrix">roster matrix</div>,
}))
vi.mock('@/components/staffTraining/CaregiverTrainingLog', () => ({
  default: ({ caregiver }) => <div data-testid="log">{caregiver.full_name}</div>,
}))
vi.mock('@/components/staffTraining/ExpiringSoonList', () => ({
  default: () => null,
}))

const { default: StaffTrainingPage } = await import('./StaffTrainingPage')

afterEach(() => {
  cleanup()
  hookState.isLicensee = true
})

function mountAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StaffTrainingPage />
    </MemoryRouter>
  )
}

describe('StaffTrainingPage — ?caregiver= deep-linking', () => {
  it('?caregiver=<known id> opens that caregiver’s training-log drill-in', () => {
    mountAt('/staff-training?caregiver=cg-2')
    expect(screen.getByTestId('log').textContent).toBe('Bob Beta')
    expect(screen.queryByTestId('matrix')).toBeNull()
  })

  it('unknown ?caregiver= falls back to the roster view — no crash', () => {
    mountAt('/staff-training?caregiver=not-on-roster')
    expect(screen.getByTestId('matrix')).toBeTruthy()
    expect(screen.queryByTestId('log')).toBeNull()
  })

  it('no ?caregiver= → roster view unchanged (regression lock)', () => {
    mountAt('/staff-training')
    expect(screen.getByTestId('matrix')).toBeTruthy()
    expect(screen.queryByTestId('log')).toBeNull()
  })

  it('staff self-view ignores the param (selectedId is licensee-only)', () => {
    hookState.isLicensee = false
    mountAt('/staff-training?caregiver=cg-2')
    // Staff view renders THEIR log (roster[0]) regardless of the param.
    expect(screen.getByTestId('log').textContent).toBe('Alice Alpha')
  })
})
