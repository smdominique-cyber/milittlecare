// Phase 3.1a — ChecklistRow ↔ ActionableGap integration tests.
//
// Mount-level coverage of the wiring: gap states render exactly one
// <ActionableGap> beneath the status line; on_file / not_applicable
// rows render none; the rule citation stays in ChecklistRow either
// way; fixContext threads through to a working deep-link; and the
// awaiting_input rows link to the real BusinessInfo ?section= targets
// (3.1b-1 — 3.1a shipped these text-only).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ChecklistRow from './ChecklistRow'
import { LOAD_FAILURE_GUIDANCE } from './checklistGuidance'

function mountRow(requirementKey, state, fixContext) {
  return render(
    <MemoryRouter>
      <ul>
        <ChecklistRow
          row={{ state: { requirement_key: requirementKey, ...state } }}
          fixContext={fixContext}
        />
      </ul>
    </MemoryRouter>
  )
}

afterEach(cleanup)

const LEAD_CITATION = 'R 400.1907(1)(b)(vi) AND R 400.1932(7)'

describe('ChecklistRow — ActionableGap wiring', () => {
  it('on_file → NO ActionableGap; citation still renders', () => {
    const { container } = mountRow('intake_lead_disclosure', { kind: 'on_file' })
    expect(container.querySelector('.actionable-gap')).toBeNull()
    expect(screen.getByText(LEAD_CITATION)).toBeTruthy()
  })

  it('not_applicable → NO ActionableGap', () => {
    const { container } = mountRow('intake_lead_disclosure', { kind: 'not_applicable' })
    expect(container.querySelector('.actionable-gap')).toBeNull()
  })

  it('missing_required → exactly ONE ActionableGap; citation stays in the row', () => {
    const { container } = mountRow('intake_lead_disclosure', { kind: 'missing_required' })
    const gaps = container.querySelectorAll('.actionable-gap')
    expect(gaps.length).toBe(1)
    expect(gaps[0].textContent).toContain('lead-paint disclosure')
    // Citation renders once, in the row shell — not inside the gap.
    expect(screen.getByText(LEAD_CITATION)).toBeTruthy()
    expect(gaps[0].textContent).not.toContain(LEAD_CITATION)
  })

  it('missing_required + fixContext → working deep-link with the built href', () => {
    mountRow('intake_lead_disclosure', { kind: 'missing_required' },
      { familyId: 'fam-1', childId: 'child-1' })
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/families?family=fam-1&child=child-1&tab=children')
  })

  it('missing_required WITHOUT fixContext → guidance text but no link', () => {
    mountRow('intake_lead_disclosure', { kind: 'missing_required' })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('awaiting_input premises row → working ?section=premises link (3.1b-1)', () => {
    const { container } = mountRow('intake_lead_disclosure',
      { kind: 'unknown', reason: 'awaiting-provider-input' })
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/business-info?section=premises')
    expect(container.innerHTML).not.toContain('section=compliance_applicability')
    expect(screen.getByText('Tell us about this')).toBeTruthy()
    expect(container.querySelector('.actionable-gap').textContent).toContain('1978')
  })

  it('awaiting_input questionnaire row → ?section=compliance_applicability link, no fixContext needed', () => {
    mountRow('consent_water_activities_on_premises_seasonal',
      { kind: 'unknown', reason: 'awaiting-provider-input' })
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/business-info?section=compliance_applicability')
  })

  it('load_failure unknown → refresh-to-retry guidance, no link', () => {
    const { container } = mountRow('caregiver_professional_development_hours',
      { kind: 'unknown', reason: 'training-data-load-failure' })
    expect(screen.getByText('Couldn’t verify')).toBeTruthy()
    expect(container.querySelector('.actionable-gap').textContent)
      .toContain(LOAD_FAILURE_GUIDANCE)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('feature_not_yet_shipped → short status line + PR copy in the gap', () => {
    const { container } = mountRow('drill_fire_quarterly',
      { kind: 'unknown', reason: 'feature-not-yet-shipped' })
    expect(screen.getByText('Not tracked in-app yet')).toBeTruthy()
    expect(container.querySelector('.actionable-gap').textContent)
      .toContain('PR #19 (drills + emergency response plan)')
  })

  it('data_anomaly → contact-support copy moved into the gap', () => {
    const { container } = mountRow('intake_lead_disclosure',
      { kind: 'unknown', reason: 'no-state-resolver' })
    expect(screen.getByText('Data anomaly')).toBeTruthy()
    expect(container.querySelector('.actionable-gap').textContent)
      .toContain('contact support')
  })
})
