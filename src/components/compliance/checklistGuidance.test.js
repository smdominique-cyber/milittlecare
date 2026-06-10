// Phase 3.1a — content map tests for checklistGuidance.js.
//
// Pure-function coverage of actionableGapPropsFor: which rows get a
// deep-link fixTarget (category A surfaces only), which stay text-only
// (category B/C, pending_parent, missing context), and that the
// guidance copy honors the three task-directed corrections:
//   1. E5 reads per-role hours from the reason string, never "16".
//   2. load_failure bucket → "refresh to retry" (bucket-driven).
//   3. C2 keeps "Annual" (expiry-removal PR has not landed).

import { describe, it, expect } from 'vitest'
import {
  REQUIREMENT_REGISTRY,
  LOAD_FAILURE_REASONS,
} from '@/lib/complianceState'
import {
  actionableGapPropsFor,
  CHECKLIST_GUIDANCE,
  LOAD_FAILURE_GUIDANCE,
  DATA_ANOMALY_GUIDANCE,
  trackingCopy,
  TRACKING_SHIPS_WITH,
} from './checklistGuidance'

const CTX = { familyId: 'fam-1', childId: 'child-1' }

function gapFor(key, state, context) {
  const requirement = REQUIREMENT_REGISTRY[key]
  expect(requirement, `registry row ${key} must exist`).toBeTruthy()
  return actionableGapPropsFor({ requirement, state, context })
}

// -----------------------------------------------------------------------------
// Null cases — rows that render NO ActionableGap
// -----------------------------------------------------------------------------

describe('actionableGapPropsFor — null cases', () => {
  it('on_file → null', () => {
    expect(gapFor('intake_lead_disclosure', { kind: 'on_file' }, CTX)).toBeNull()
  })

  it('not_applicable → null', () => {
    expect(gapFor('intake_lead_disclosure', { kind: 'not_applicable' }, CTX)).toBeNull()
  })

  it('missing requirement / state / kind → null (defensive)', () => {
    expect(actionableGapPropsFor({})).toBeNull()
    expect(actionableGapPropsFor()).toBeNull()
    expect(actionableGapPropsFor({ requirement: REQUIREMENT_REGISTRY.intake_lead_disclosure })).toBeNull()
    expect(actionableGapPropsFor({
      requirement: REQUIREMENT_REGISTRY.intake_lead_disclosure,
      state: { reason: 'x' },
    })).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Surface 1 — Families / Children deep-links (Group A rows)
// -----------------------------------------------------------------------------

describe('Surface 1 — families children tab', () => {
  it('A row missing + full context → critical + exact children-tab `to`', () => {
    const gap = gapFor('intake_lead_disclosure', { kind: 'missing_required' }, CTX)
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('lead-paint disclosure')
    expect(gap.fixTarget).toEqual({
      label: 'Open this child in Families',
      to: '/families?family=fam-1&child=child-1&tab=children',
    })
  })

  it('A row missing + NO context → same guidance, text-only (no dead button)', () => {
    const gap = gapFor('intake_lead_disclosure', { kind: 'missing_required' })
    expect(gap.guidanceText).toContain('lead-paint disclosure')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('A row missing + partial context (no childId) → text-only for children tab', () => {
    const gap = gapFor('child_immunization_record', { kind: 'missing_required' }, { familyId: 'fam-1' })
    expect(gap.fixTarget).toBeUndefined()
  })

  it('ids are URI-encoded in the built target', () => {
    const gap = gapFor('intake_lead_disclosure', { kind: 'missing_required' },
      { familyId: 'fam/1', childId: 'child&2' })
    expect(gap.fixTarget.to).toBe('/families?family=fam%2F1&child=child%262&tab=children')
  })
})

// -----------------------------------------------------------------------------
// Surface 2 — Families / Funding deep-links (Group G rows)
// -----------------------------------------------------------------------------

describe('Surface 2 — families funding tab', () => {
  it('cdc_authorization_currency expired + family context → funding-tab `to`, warning', () => {
    const gap = gapFor('cdc_authorization_currency', { kind: 'expired' }, { familyId: 'fam-1' })
    expect(gap.severity).toBe('warning')
    expect(gap.guidanceText).toContain('redetermination')
    expect(gap.guidanceText).toContain('844-464-3447')
    expect(gap.fixTarget).toEqual({
      label: 'Open funding in Families',
      to: '/families?family=fam-1&tab=funding',
    })
  })

  it('funding target includes &child= when childId is in context', () => {
    const gap = gapFor('cdc_authorization_currency', { kind: 'expired' }, CTX)
    expect(gap.fixTarget.to).toBe('/families?family=fam-1&child=child-1&tab=funding')
  })

  it('no context (provider-level page rendering a funding row) → text-only', () => {
    const gap = gapFor('cdc_authorization_currency', { kind: 'expired' })
    expect(gap.guidanceText).toContain('redetermination')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('G3 needs_provider_data: missing authorization end date → per-reason copy + funding target', () => {
    const gap = gapFor('cdc_authorization_currency',
      { kind: 'unknown', reason: 'no-authorization-end-on-funding-source' }, { familyId: 'fam-1' })
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('authorization end date')
    expect(gap.fixTarget.to).toBe('/families?family=fam-1&tab=funding')
  })
})

// -----------------------------------------------------------------------------
// Surface 5 — MiRegistry (needs no context)
// -----------------------------------------------------------------------------

describe('Surface 5 — /miregistry', () => {
  it('F1 missing → /miregistry target even with NO context', () => {
    const gap = gapFor('provider_miregistry_annual_ongoing', { kind: 'missing_required' })
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('Dec 16')
    expect(gap.fixTarget).toEqual({ label: 'Open MiRegistry tracker', to: '/miregistry' })
  })

  it('F2 expired → severity INFO (advisory pay-tier reframe, not a violation)', () => {
    const gap = gapFor('provider_miregistry_level_2_currency', { kind: 'expired' })
    expect(gap.severity).toBe('info')
    expect(gap.guidanceText).toContain('NOT a compliance violation')
    expect(gap.fixTarget.to).toBe('/miregistry')
  })
})

// -----------------------------------------------------------------------------
// Category B/C rows — text-only this PR
// -----------------------------------------------------------------------------

describe('category B/C rows render text-only (no fixTarget)', () => {
  it('G4 fingerprint reprint (BusinessInfo surface is 3.1b B-1) → no fixTarget', () => {
    const gap = gapFor('cdc_fingerprint_reprint_currency', { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('5-year cycle')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('E2 CPR/first-aid (StaffTraining surface is 3.1b C-1) → no fixTarget', () => {
    const gap = gapFor('caregiver_cpr_first_aid_current', { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('CPR')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('H1 attendance ack per day → no fixTarget', () => {
    const gap = gapFor('attendance_parent_acknowledgment_per_day', { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('acknowledg')
    expect(gap.fixTarget).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Correction 2 — load_failure bucket (bucket-driven, never reason strings)
// -----------------------------------------------------------------------------

describe('load_failure bucket', () => {
  it('EVERY member of LOAD_FAILURE_REASONS → refresh copy, info, no fixTarget', () => {
    expect(LOAD_FAILURE_REASONS.size).toBeGreaterThan(0)
    for (const reason of LOAD_FAILURE_REASONS) {
      const gap = gapFor('caregiver_professional_development_hours',
        { kind: 'unknown', reason }, CTX)
      expect(gap.guidanceText).toBe(LOAD_FAILURE_GUIDANCE)
      expect(gap.severity).toBe('info')
      expect(gap.fixTarget).toBeUndefined()
    }
  })

  it('refresh copy says refresh-to-retry, not contact-support', () => {
    expect(LOAD_FAILURE_GUIDANCE).toContain('refresh to retry')
    expect(LOAD_FAILURE_GUIDANCE).not.toContain('support')
  })

  it('genuine data_anomaly reason keeps the contact-support copy', () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'unknown', reason: 'no-state-resolver' }, CTX)
    expect(gap.guidanceText).toBe(DATA_ANOMALY_GUIDANCE)
    expect(gap.severity).toBe('info')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('training-requirements-catalog-empty stays data_anomaly (seed anomaly, not transient)', () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'unknown', reason: 'training-requirements-catalog-empty' }, CTX)
    expect(gap.guidanceText).toBe(DATA_ANOMALY_GUIDANCE)
  })

  it('D6 dose-log retention anomaly uses its per-row override copy', () => {
    const gap = gapFor('medication_dose_log_retention',
      { kind: 'unknown', reason: 'dose-event-row-disappeared' })
    expect(gap.guidanceText).toContain('retention')
    expect(gap.guidanceText).toContain('contact support')
  })
})

// -----------------------------------------------------------------------------
// Correction 1 — E5 per-role hours, never a hardcoded count
// -----------------------------------------------------------------------------

describe('E5 — caregiver professional development hours', () => {
  it("reads 'N of M' from the role-based reason string", () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'missing_required', reason: 'hours-4-of-10' })
    expect(gap.guidanceText).toContain('4 of 10 hours')
    expect(gap.guidanceText).not.toContain('16')
  })

  it('handles fractional hours in the reason', () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'missing_required', reason: 'hours-7.5-of-16' })
    expect(gap.guidanceText).toContain('7.5 of 16 hours')
  })

  it("reason without hours (no-active-caregivers) → 'varies by' fallback, no fixed number", () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'missing_required', reason: 'no-active-caregivers' })
    expect(gap.guidanceText).toContain('varies by')
    expect(gap.guidanceText).not.toMatch(/\b16\b/)
  })

  it("unknown 'no-regulatory-roles' → needs_provider_data role copy, critical", () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'unknown', reason: 'no-regulatory-roles' })
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('regulatory role')
    expect(gap.fixTarget).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Correction 3 — C2 keeps "Annual"
// -----------------------------------------------------------------------------

describe('C2 — routine transportation consent', () => {
  it('guidance keeps the Annual baseline (expiry-removal PR has not landed)', () => {
    const gap = gapFor('consent_transportation_routine_annual', { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('Annual')
  })
})

// -----------------------------------------------------------------------------
// pending_parent — guidance-only, never a fixTarget (scope §3 decision #10)
// -----------------------------------------------------------------------------

describe('pending_parent rows', () => {
  it('drift row pending → warning + drift copy + NO fixTarget even with full context', () => {
    const gap = gapFor('child_in_care_statement_envelope_drift', { kind: 'pending_parent' }, CTX)
    expect(gap.severity).toBe('warning')
    expect(gap.guidanceText).toContain('Re-send the intake bundle')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('D2 pending with authorization-changed reason → per-reason drift copy', () => {
    const gap = gapFor('medication_permission_per_authorization',
      { kind: 'pending_parent', reason: 'authorization-changed-since-permission' }, CTX)
    expect(gap.guidanceText).toContain('changed since')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('H1 pending → override-on-file copy', () => {
    const gap = gapFor('attendance_parent_acknowledgment_per_day', { kind: 'pending_parent' })
    expect(gap.guidanceText).toContain('usually clears')
  })
})

// -----------------------------------------------------------------------------
// D4 — high-stakes guidance-only row
// -----------------------------------------------------------------------------

describe('D4 — medication role-gate integrity', () => {
  it('missing → critical, corrective-action copy, NO fixTarget (nothing to open)', () => {
    const gap = gapFor('medication_role_gate_integrity', { kind: 'missing_required' }, CTX)
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('corrective action')
    expect(gap.guidanceText).toContain('R 400.1931(1)')
    expect(gap.fixTarget).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Unknown buckets — feature_not_yet_shipped + awaiting_input
// -----------------------------------------------------------------------------

describe('feature_not_yet_shipped bucket', () => {
  it('drill row (no per-row copy) → generic trackingCopy sentence with PR #19', () => {
    const gap = gapFor('drill_fire_quarterly',
      { kind: 'unknown', reason: 'feature-not-yet-shipped' })
    expect(gap.severity).toBe('info')
    expect(gap.guidanceText).toContain('PR #19 (drills + emergency response plan)')
    expect(gap.guidanceText).toContain('keep paper records')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('E7 arrival/departure → per-row copy naming PR #18 + time-clock nuance', () => {
    const gap = gapFor('caregiver_daily_arrival_departure',
      { kind: 'unknown', reason: 'feature-not-yet-shipped' })
    expect(gap.guidanceText).toContain('PR #18')
    expect(gap.guidanceText).toContain('time-clock')
  })
})

describe('awaiting_input bucket', () => {
  it('A2 lead disclosure → per-row premises question copy, warning, NO fixTarget', () => {
    const gap = gapFor('intake_lead_disclosure',
      { kind: 'unknown', reason: 'awaiting-provider-input' }, CTX)
    expect(gap.severity).toBe('warning')
    expect(gap.guidanceText).toContain('1978')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('A3 firearms disclosure → per-row firearms copy', () => {
    const gap = gapFor('intake_firearms_disclosure',
      { kind: 'unknown', reason: 'awaiting-provider-input' }, CTX)
    expect(gap.guidanceText).toContain('firearms')
  })

  it('row without per-row awaiting copy → generic Business Info sentence', () => {
    const gap = gapFor('consent_field_trip_permission',
      { kind: 'unknown', reason: 'awaiting-provider-input' }, CTX)
    expect(gap.guidanceText).toContain('Business Info')
    expect(gap.fixTarget).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Registry-wide invariants
// -----------------------------------------------------------------------------

describe('registry-wide invariants', () => {
  it('every registry row produces non-empty guidance for missing_required', () => {
    for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
      const gap = gapFor(key, { kind: 'missing_required' }, CTX)
      expect(gap, `${key} must produce gap props`).toBeTruthy()
      expect(typeof gap.guidanceText, key).toBe('string')
      expect(gap.guidanceText.length, `${key} guidance must be non-empty`).toBeGreaterThan(0)
      expect(['critical', 'warning', 'info'], key).toContain(gap.severity)
    }
  })

  it('every fixTarget ever built has both label and to (never a dead button)', () => {
    const kinds = ['missing_required', 'expired', 'pending_parent']
    for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
      for (const kind of kinds) {
        const gap = gapFor(key, { kind }, CTX)
        if (gap && gap.fixTarget) {
          expect(gap.fixTarget.label, `${key}/${kind}`).toBeTruthy()
          expect(gap.fixTarget.to, `${key}/${kind}`).toBeTruthy()
        }
      }
    }
  })

  it('every CHECKLIST_GUIDANCE key exists in REQUIREMENT_REGISTRY (no orphan content)', () => {
    for (const key of Object.keys(CHECKLIST_GUIDANCE)) {
      expect(REQUIREMENT_REGISTRY[key], `orphan guidance entry: ${key}`).toBeTruthy()
    }
  })

  it('CHECKLIST_GUIDANCE is frozen', () => {
    expect(Object.isFrozen(CHECKLIST_GUIDANCE)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Moved helpers — trackingCopy lives here now (ChecklistRow re-exports)
// -----------------------------------------------------------------------------

describe('trackingCopy (moved from ChecklistRow in 3.1a)', () => {
  it('resolves per-key, category, and generic fallbacks', () => {
    expect(trackingCopy({ key: 'caregiver_daily_arrival_departure', category: 'staff_files' }))
      .toBe('PR #18 (staff file gaps)')
    expect(trackingCopy({ key: 'drill_fire_quarterly', category: 'drills' }))
      .toBe('PR #19 (drills + emergency response plan)')
    expect(trackingCopy({ key: 'x', category: 'y' })).toBe('a future MILittleCare build')
    expect(TRACKING_SHIPS_WITH.staff_files).toBeUndefined()
  })
})
