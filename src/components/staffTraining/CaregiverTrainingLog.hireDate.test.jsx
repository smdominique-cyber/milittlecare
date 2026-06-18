// 2026-06-14 — locks the hire-date edit affordance render rules added
// to close the E3 punch-list hole (caregiver_new_hire_training_complete
// with reason `caregiver-missing-date-of-hire`: the engine guidance
// tells the provider to "edit the caregiver record and set date_of_hire,"
// and before today there was no UI for that).
//
// The affordance is gated on the `onEditHireDate` callback prop:
//   - prop absent (staff self-view)              → no affordance ever
//   - prop present + caregiver.date_of_hire set  → date + Edit
//   - prop present + caregiver.date_of_hire null → "not set" + Set
//
// The licensee branch MUST still render the row when the date is null —
// that is the whole point of the fix; hiding the row would reproduce
// the original integrity hole.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

// 2026-06-17 PR #17/#18 foundation (mig 045) — CaregiverTrainingLog
// now imports ComplianceDocumentSlot, which transitively imports
// @/lib/supabase (a singleton that throws at import time if env vars
// are missing — they are in the test env). This mock keeps the
// hire-date tests focused on their original surface area without
// pulling supabase into the import graph.
vi.mock('@/components/documents/ComplianceDocumentSlot', () => ({
  default: ({ documentType, subjectCaregiverId }) => (
    <div data-testid={`compliance-doc-slot-${documentType}-${subjectCaregiverId || 'none'}`}>
      doc slot {documentType} {subjectCaregiverId || 'provider-level'}
    </div>
  ),
}))

import CaregiverTrainingLog from './CaregiverTrainingLog'

afterEach(cleanup)

const baseCaregiver = {
  id: 'cg-1',
  full_name: 'Alice Alpha',
  regulatory_roles: [],
}

function mount(props) {
  return render(
    <CaregiverTrainingLog
      caregiver={baseCaregiver}
      records={[]}
      onAddRecord={() => {}}
      onEditRecord={() => {}}
      {...props}
    />
  )
}

describe('CaregiverTrainingLog — hire-date affordance', () => {
  it('self-view (no onEditHireDate) + no date → does NOT render a hire-date line', () => {
    mount({ caregiver: { ...baseCaregiver, date_of_hire: null } })
    expect(screen.queryByText(/Hire date/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /set hire date/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
  })

  it('self-view (no onEditHireDate) + date set → renders date only, no edit/set button', () => {
    mount({ caregiver: { ...baseCaregiver, date_of_hire: '2025-03-15' } })
    expect(screen.getByText(/Hire date:/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /set hire date/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
  })

  it('licensee (onEditHireDate provided) + date set → renders date + Edit button that fires the callback with the caregiver', () => {
    const onEditHireDate = vi.fn()
    mount({
      caregiver: { ...baseCaregiver, date_of_hire: '2025-03-15' },
      onEditHireDate,
    })
    expect(screen.getByText(/Hire date:/i)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /^edit$/i })
    fireEvent.click(btn)
    expect(onEditHireDate).toHaveBeenCalledTimes(1)
    expect(onEditHireDate.mock.calls[0][0]).toMatchObject({
      id: 'cg-1', full_name: 'Alice Alpha', date_of_hire: '2025-03-15',
    })
  })

  it('licensee (onEditHireDate provided) + NO date → renders "Hire date: not set" + Set hire date button (the integrity fix)', () => {
    const onEditHireDate = vi.fn()
    mount({
      caregiver: { ...baseCaregiver, date_of_hire: null },
      onEditHireDate,
    })
    // The whole point of the fix: a caregiver with null date_of_hire
    // must surface an edit affordance. The pre-fix component hid the
    // row entirely, which is exactly how the gap formed.
    expect(screen.getByText(/Hire date: not set/i)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /set hire date/i })
    fireEvent.click(btn)
    expect(onEditHireDate).toHaveBeenCalledTimes(1)
    expect(onEditHireDate.mock.calls[0][0]).toMatchObject({ id: 'cg-1', date_of_hire: null })
  })
})
