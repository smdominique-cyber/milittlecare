// 2026-06-17 PR #17/#18 foundation (mig 045) — verifies the
// per-caregiver physician attestation slot in CaregiverTrainingLog.
//
// What this pins:
//   - The slot renders ONLY in the licensee drill-in view (the
//     `onAssignRoles` callback is the proxy for "this is the
//     licensee viewing this caregiver"; the staff self-view does
//     NOT see the upload affordance in V1).
//   - When rendered, the slot receives the caregiver's id as
//     `subjectCaregiverId` so the underlying DocumentSlot's
//     parentScope kicks in (the actual scoping plumbing is
//     unit-tested in DocumentSlot.test.jsx; this test confirms the
//     CaregiverTrainingLog wiring).
//   - The slot is NOT rendered when caregiver is null (defensive —
//     the per-caregiver scoping requires a real id).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

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
  id: 'cg-alpha',
  full_name: 'Alice Alpha',
  regulatory_roles: [],
}

function mount(props) {
  return render(
    <CaregiverTrainingLog
      caregiver={baseCaregiver}
      records={[]}
      {...props}
    />
  )
}

describe('CaregiverTrainingLog — physician attestation slot (PR #17/#18 foundation)', () => {
  it('licensee view (onAssignRoles present) renders the per-caregiver attestation slot with the caregiver id', () => {
    mount({ onAssignRoles: vi.fn(), onEditHireDate: vi.fn() })
    const slot = screen.getByTestId('compliance-doc-slot-caregiver_physician_attestation-cg-alpha')
    expect(slot).toBeTruthy()
    expect(slot.textContent).toContain('cg-alpha')
  })

  it('staff self-view (NO onAssignRoles) does NOT render the attestation slot', () => {
    // Self-view: no onAssignRoles passed (matches the existing
    // hire-date affordance contract — self-view doesn't get the
    // licensee-only callbacks).
    mount({})
    expect(screen.queryByTestId(/compliance-doc-slot-caregiver_physician_attestation/)).toBeNull()
  })

  it('caregiver without an id does NOT render the slot (defensive)', () => {
    render(
      <CaregiverTrainingLog
        caregiver={{ ...baseCaregiver, id: null }}
        records={[]}
        onAssignRoles={vi.fn()}
      />
    )
    expect(screen.queryByTestId(/compliance-doc-slot-caregiver_physician_attestation/)).toBeNull()
  })

  it('the section heading "Physician attestation (annual)" appears only in the licensee view', () => {
    const { rerender } = render(
      <CaregiverTrainingLog
        caregiver={baseCaregiver}
        records={[]}
      />
    )
    expect(screen.queryByText(/Physician attestation \(annual\)/i)).toBeNull()
    rerender(
      <CaregiverTrainingLog
        caregiver={baseCaregiver}
        records={[]}
        onAssignRoles={vi.fn()}
      />
    )
    expect(screen.getByText(/Physician attestation \(annual\)/i)).toBeTruthy()
  })
})
