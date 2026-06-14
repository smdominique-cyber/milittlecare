// 2026-06-14 — page-level wiring for the new EditHireDateModal that
// closes the E3 punch-list hole:
//
//   * The licensee branch MUST pass `onEditHireDate` to CaregiverTrainingLog
//     (so the affordance renders inside the drill-in).
//   * The staff self-view MUST NOT pass it (the field is licensee-only;
//     the RLS UPDATE policy at migration 012:250-253 enforces the same
//     boundary at the DB layer).
//   * When the modal saves, the .update call MUST be scoped by BOTH
//     id AND licensee_id (defense-in-depth alongside RLS) and write the
//     selected date (empty input clears via null).
//
// We mock CaregiverTrainingLog with a tiny stub that exposes the
// received props and a button that triggers the captured callback —
// the modal then mounts inside the page and we exercise its real
// save path against a recording supabase stub.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const hookState = vi.hoisted(() => ({ isLicensee: true }))
const captures = vi.hoisted(() => ({ receivedProps: null }))
const supabaseCalls = vi.hoisted(() => ({
  from: [], update: [], eq: [], error: null,
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-licensee' } }),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from(table) {
      supabaseCalls.from.push(table)
      const chain = {
        update(payload) {
          supabaseCalls.update.push({ table, payload })
          return chain
        },
        eq(col, val) {
          supabaseCalls.eq.push({ table, col, val })
          return chain
        },
        then(resolve) {
          resolve({ data: null, error: supabaseCalls.error })
        },
      }
      return chain
    },
  },
}))

const refreshSpy = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useStaffTraining', () => ({
  useStaffTraining: () => ({
    loading: false,
    error: null,
    isLicensee: hookState.isLicensee,
    roster: [
      // The self-view falls back to roster[0]; keep cg-A there so the
      // self-view test below renders consistently.
      { id: 'cg-A', full_name: 'Self Caregiver', app_user_id: 'u-licensee', archived_at: null, date_of_hire: '2025-01-01' },
      { id: 'cg-target', full_name: 'Target Caregiver', app_user_id: null, archived_at: null, date_of_hire: null },
    ],
    records: [],
    requirements: [],
    updates: [],
    refresh: refreshSpy,
  }),
}))

// Stub the heavy children — same pattern as the ?caregiver= test file.
vi.mock('@/components/staffTraining/StaffComplianceMatrix', () => ({
  default: () => <div data-testid="matrix">roster matrix</div>,
}))
vi.mock('@/components/staffTraining/ExpiringSoonList', () => ({
  default: () => null,
}))
vi.mock('@/components/staffTraining/TrainingEntryForm', () => ({
  default: () => null,
}))
vi.mock('@/components/staffTraining/RegulatoryRoleAssignment', () => ({
  default: () => null,
}))

vi.mock('@/components/staffTraining/CaregiverTrainingLog', () => ({
  default: (props) => {
    captures.receivedProps = props
    return (
      <div data-testid="log">
        <span data-testid="log-name">{props.caregiver.full_name}</span>
        {props.onEditHireDate ? (
          <button
            data-testid="trigger-edit-hire"
            onClick={() => props.onEditHireDate(props.caregiver)}
          >
            trigger edit
          </button>
        ) : (
          <span data-testid="no-edit-hire">prop-absent</span>
        )}
      </div>
    )
  },
}))

const { default: StaffTrainingPage } = await import('./StaffTrainingPage')

beforeEach(() => {
  supabaseCalls.from.length = 0
  supabaseCalls.update.length = 0
  supabaseCalls.eq.length = 0
  supabaseCalls.error = null
  captures.receivedProps = null
  refreshSpy.mockClear()
})

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

describe('StaffTrainingPage — onEditHireDate wiring (licensee-only)', () => {
  it('licensee drill-in: CaregiverTrainingLog receives onEditHireDate as a function', () => {
    mountAt('/staff-training?caregiver=cg-target')
    expect(screen.getByTestId('log-name').textContent).toBe('Target Caregiver')
    expect(captures.receivedProps).not.toBeNull()
    expect(typeof captures.receivedProps.onEditHireDate).toBe('function')
  })

  it('staff self-view: CaregiverTrainingLog does NOT receive onEditHireDate (the field is licensee-only)', () => {
    hookState.isLicensee = false
    mountAt('/staff-training')
    expect(screen.getByTestId('log-name').textContent).toBe('Self Caregiver')
    expect(captures.receivedProps).not.toBeNull()
    expect(captures.receivedProps.onEditHireDate).toBeUndefined()
    // And the stub's "prop-absent" branch rendered, locking the
    // visible-affordance gating too.
    expect(screen.getByTestId('no-edit-hire')).toBeTruthy()
  })
})

describe('EditHireDateModal — save path', () => {
  async function openModalAndFillDate(value) {
    mountAt('/staff-training?caregiver=cg-target')
    fireEvent.click(screen.getByTestId('trigger-edit-hire'))
    const input = await screen.findByLabelText(/date of hire/i)
    fireEvent.change(input, { target: { value } })
    const save = screen.getByRole('button', { name: /^save$/i })
    await act(async () => {
      fireEvent.click(save)
    })
  }

  it('clicking Save writes a .update({date_of_hire}) on caregivers, scoped by BOTH id and licensee_id (defense-in-depth alongside RLS)', async () => {
    await openModalAndFillDate('2025-03-15')

    expect(supabaseCalls.from).toContain('caregivers')
    expect(supabaseCalls.update).toHaveLength(1)
    expect(supabaseCalls.update[0]).toEqual({
      table: 'caregivers',
      payload: { date_of_hire: '2025-03-15' },
    })
    // Both filters present, in the order the modal writes them. The
    // licensee_id filter is the belt-and-suspenders pair to the RLS
    // policy from migration 012:250-253.
    expect(supabaseCalls.eq).toEqual([
      { table: 'caregivers', col: 'id', val: 'cg-target' },
      { table: 'caregivers', col: 'licensee_id', val: 'u-licensee' },
    ])
    // Successful save → refresh fires (handleSaved on the page).
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('empty date input clears the field (saves date_of_hire: null)', async () => {
    await openModalAndFillDate('')
    expect(supabaseCalls.update[0]).toEqual({
      table: 'caregivers',
      payload: { date_of_hire: null },
    })
  })

  it('supabase returns an error → refresh is NOT called and the modal stays mounted with an alert', async () => {
    supabaseCalls.error = { code: 'PGRST301', message: 'denied' }
    await openModalAndFillDate('2025-03-15')

    // Write was attempted (the chain was built) but refresh did not
    // fire — the page's handleSaved is only called on success.
    expect(supabaseCalls.update).toHaveLength(1)
    expect(refreshSpy).not.toHaveBeenCalled()

    // The modal's role="alert" error banner is rendered. (Loose match
    // on the user-visible message so a copy tweak doesn't break the
    // structural assertion.)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent || '').toMatch(/couldn’t save|couldn't save/i)
  })
})
