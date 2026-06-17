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
  it('G4 fingerprint reprint (Phase A upload surface, 2026-06-14): fixTarget → /business-info?section=licensing', () => {
    const gap = gapFor('cdc_fingerprint_reprint_currency', { kind: 'missing_required' }, CTX)
    // Preserved: the 5-year cycle reality + the "keep records" tone.
    expect(gap.guidanceText).toContain('5-year cycle')
    expect(gap.guidanceText).toMatch(/keep records/i)
    expect(gap.guidanceText).toMatch(/auditor/i)

    // Phase A: G4 now points at the real upload surface.
    expect(gap.fixTarget).toBeDefined()
    expect(gap.fixTarget.to).toBe('/business-info?section=licensing')
    // Label is provider-readable, not just a slug.
    expect(gap.fixTarget.label).toMatch(/licens/i)

    // Integrity-hole regression locks (carried forward from the
    // 2026-06-14 softening commit): the original copy promised an
    // in-app `fingerprint_date` field update that no UI delivers.
    // Those phrases must stay out — the fix is the upload surface
    // now, not a field-update promise.
    expect(gap.guidanceText).not.toMatch(/fingerprint_date/i)
    expect(gap.guidanceText).not.toMatch(/update after each reprint/i)

    // Phase A reality lock: the upload covers the LICENSEE's own
    // records only. The household-members-on-paper truth must stay
    // visible — promising in-app coverage for staff/household members
    // would re-open a smaller-scale version of the same hole.
    expect(gap.guidanceText).toMatch(/household/i)
    expect(gap.guidanceText).toMatch(/paper/i)
  })

  it('H1 attendance acks (/acknowledgments ?child= is 3.1b-3+) → no fixTarget', () => {
    const gap = gapFor('attendance_parent_acknowledgment_per_day', { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('acknowledg')
    expect(gap.fixTarget).toBeUndefined()
  })

  // 2026-06-14 batch (mig 039): three property rows gained a real
  // fixTarget into the new /business-info?section=property surface
  // hosting ComplianceDocumentSlot. Lock the fixTarget shape and
  // assert that the copy actually mentions the surface — the
  // integrity-hole pattern from the G4 softening test.
  describe('J1/J2/J8 property doc rows — Business Info → Property fixTarget', () => {
    const ROWS = [
      'property_radon_test_quadrennial',
      'property_heating_inspection_quadrennial',
      'property_licensing_notebook_archive',
    ]
    for (const key of ROWS) {
      it(`${key}: missing_required → /business-info?section=property`, () => {
        const gap = gapFor(key, { kind: 'missing_required' }, CTX)
        expect(gap).toBeDefined()
        expect(gap.fixTarget).toBeDefined()
        expect(gap.fixTarget.to).toBe('/business-info?section=property')
        expect(gap.fixTarget.label).toMatch(/property/i)
        // Copy honesty: each row's guidance mentions the surface so
        // the provider knows where to go even if they don't click.
        expect(gap.guidanceText).toMatch(/business info/i)
        expect(gap.guidanceText).toMatch(/property/i)
        // Severity matches the registry severity rank — missing
        // required without an explicit override is 'critical'.
        expect(gap.severity).toBe('critical')
      })
    }
  })
})

// -----------------------------------------------------------------------------
// 3.1b-2 — Staff Training surface (E1-E6)
// -----------------------------------------------------------------------------

describe('staff rows — /staff-training fixTargets (3.1b-2)', () => {
  const STAFF_ROWS = [
    'caregiver_background_check_eligibility',
    'caregiver_cpr_first_aid_current',
    'caregiver_new_hire_training_complete',
    'caregiver_miregistry_account',
    'caregiver_professional_development_hours',
    'caregiver_health_safety_update_acked',
  ]
  const PAGE_LEVEL = { label: 'Open Staff Training', to: '/staff-training' }

  it.each(STAFF_ROWS)('%s missing → PAGE-LEVEL link (engine aggregates worst-across-caregivers; no caregiver id at render)', (key) => {
    // CTX carries familyId/childId only — exactly what real consumers
    // supply today. No caregiverId → no ?caregiver= param.
    const gap = gapFor(key, { kind: 'missing_required' }, CTX)
    expect(gap.fixTarget).toEqual(PAGE_LEVEL)
  })

  it.each(STAFF_ROWS)('%s missing + NO context at all → still the page-level link', (key) => {
    const gap = gapFor(key, { kind: 'missing_required' })
    expect(gap.fixTarget).toEqual(PAGE_LEVEL)
  })

  it('a context that DOES carry caregiverId upgrades to ?caregiver=<id>', () => {
    const gap = gapFor('caregiver_cpr_first_aid_current', { kind: 'missing_required' },
      { caregiverId: 'cg-1' })
    expect(gap.fixTarget).toEqual({
      label: 'Open this caregiver in Staff Training',
      to: '/staff-training?caregiver=cg-1',
    })
  })

  it('caregiverId is URI-encoded in the built target', () => {
    const gap = gapFor('caregiver_cpr_first_aid_current', { kind: 'missing_required' },
      { caregiverId: 'cg/1&x' })
    expect(gap.fixTarget.to).toBe('/staff-training?caregiver=cg%2F1%26x')
  })

  it('E1 pending background check stays guidance-only (pending_parent never links)', () => {
    const gap = gapFor('caregiver_background_check_eligibility',
      { kind: 'pending_parent' }, { caregiverId: 'cg-1' })
    expect(gap.fixTarget).toBeUndefined()
  })

  it("E3 needs_provider_data 'caregiver-missing-date-of-hire' → hire-date copy + staff link", () => {
    const gap = gapFor('caregiver_new_hire_training_complete',
      { kind: 'unknown', reason: 'caregiver-missing-date-of-hire' }, CTX)
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('date_of_hire')
    expect(gap.fixTarget).toEqual(PAGE_LEVEL)
  })

  it('E7-E9 feature_not_yet_shipped rows still get NO fixTarget', () => {
    for (const key of [
      'caregiver_physician_attestation_annual',
      'caregiver_discipline_policy_ack_at_hire',
      'caregiver_daily_arrival_departure',
    ]) {
      const gap = gapFor(key, { kind: 'unknown', reason: 'feature-not-yet-shipped' }, CTX)
      expect(gap.fixTarget, key).toBeUndefined()
    }
  })

  it('ONLY the six E-rows ever link to /staff-training (registry-wide)', () => {
    const staff = new Set(STAFF_ROWS)
    const kinds = ['missing_required', 'expired', 'pending_parent']
    for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
      for (const kind of kinds) {
        const gap = gapFor(key, { kind }, { ...CTX, caregiverId: 'cg-1' })
        const to = gap && gap.fixTarget ? gap.fixTarget.to : ''
        if (to.includes('/staff-training')) {
          expect(staff.has(key), `${key}/${kind} must not link to /staff-training`).toBe(true)
          expect(kind, `${key} pending_parent must not link`).not.toBe('pending_parent')
        }
      }
    }
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

  it("unknown 'no-regulatory-roles' → needs_provider_data role copy, critical, staff page link (3.1b-2)", () => {
    const gap = gapFor('caregiver_professional_development_hours',
      { kind: 'unknown', reason: 'no-regulatory-roles' })
    expect(gap.severity).toBe('critical')
    expect(gap.guidanceText).toContain('regulatory role')
    expect(gap.fixTarget).toEqual({ label: 'Open Staff Training', to: '/staff-training' })
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
// 3.1b-2 — H1 copy reads the aggregated N-days reasons
// -----------------------------------------------------------------------------

describe('H1 — aggregated attendance-ack copy (per-day copy was wrong)', () => {
  const KEY = 'attendance_parent_acknowledgment_per_day'

  it("missing '3-days-missing-ack' → plural multi-day phrasing, no fixTarget", () => {
    const gap = gapFor(KEY, { kind: 'missing_required', reason: '3-days-missing-ack' }, CTX)
    expect(gap.guidanceText).toContain('3 days of attendance')
    expect(gap.guidanceText).toContain('haven’t been acknowledged')
    expect(gap.guidanceText).not.toContain('This day’s')
    expect(gap.fixTarget).toBeUndefined()
  })

  it("missing '1-days-missing-ack' → singular phrasing", () => {
    const gap = gapFor(KEY, { kind: 'missing_required', reason: '1-days-missing-ack' }, CTX)
    expect(gap.guidanceText).toContain('1 day of attendance')
    expect(gap.guidanceText).toContain('hasn’t been acknowledged')
  })

  it("pending '2-days-provider-override-only' → plural override phrasing, no fixTarget", () => {
    const gap = gapFor(KEY, { kind: 'pending_parent', reason: '2-days-provider-override-only' }, CTX)
    expect(gap.guidanceText).toContain('overrides are on file for 2 days')
    expect(gap.guidanceText).toContain('usually clears')
    expect(gap.fixTarget).toBeUndefined()
  })

  it("pending '1-days-provider-override-only' → singular override phrasing", () => {
    const gap = gapFor(KEY, { kind: 'pending_parent', reason: '1-days-provider-override-only' }, CTX)
    expect(gap.guidanceText).toContain('on file for 1 day but')
  })

  it('reason without a parseable count → count-free fallback, never crashes', () => {
    const gap = gapFor(KEY, { kind: 'missing_required' }, CTX)
    expect(gap.guidanceText).toContain('Some days of attendance')
    const pendingGap = gapFor(KEY, { kind: 'pending_parent' }, CTX)
    expect(pendingGap.guidanceText).toContain('usually clears')
  })
})

// -----------------------------------------------------------------------------
// D4 (medication_role_gate_integrity) retired 2026-06-10 — enforced at
// entry (dropdown gate + DB trigger); no guidance entry remains.
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

describe('awaiting_input bucket (3.1b-1 — BusinessInfo ?section= fixTargets)', () => {
  const AWAITING = { kind: 'unknown', reason: 'awaiting-provider-input' }

  const PREMISES_TARGET = {
    label: 'Answer in Business Info → Premises',
    to: '/business-info?section=premises',
  }
  const APPLICABILITY_TARGET = {
    label: 'Answer in Business Info → What applies to my program?',
    to: '/business-info?section=compliance_applicability',
  }

  // The split is the likely bug: premises rows must NOT point at the
  // applicability questionnaire, and vice versa.
  const PREMISES_ROWS = ['intake_lead_disclosure', 'intake_firearms_disclosure']
  const APPLICABILITY_ROWS = [
    'consent_transportation_routine_annual',
    'consent_water_activities_on_premises_seasonal',
    'property_animal_notification',
  ]

  it('A2 lead disclosure → per-row premises copy, warning, premises fixTarget', () => {
    const gap = gapFor('intake_lead_disclosure', AWAITING, CTX)
    expect(gap.severity).toBe('warning')
    expect(gap.guidanceText).toContain('1978')
    expect(gap.fixTarget).toEqual(PREMISES_TARGET)
  })

  it('A3 firearms disclosure → per-row firearms copy + premises fixTarget', () => {
    const gap = gapFor('intake_firearms_disclosure', AWAITING, CTX)
    expect(gap.guidanceText).toContain('firearms')
    expect(gap.fixTarget).toEqual(PREMISES_TARGET)
  })

  it.each(PREMISES_ROWS)('%s → section=premises, NEVER the applicability id', (key) => {
    const gap = gapFor(key, AWAITING, CTX)
    expect(gap.fixTarget.to).toBe('/business-info?section=premises')
    expect(gap.fixTarget.to).not.toContain('compliance_applicability')
  })

  it.each(APPLICABILITY_ROWS)('%s → section=compliance_applicability, NEVER the premises id', (key) => {
    const gap = gapFor(key, AWAITING, CTX)
    expect(gap.fixTarget).toEqual(APPLICABILITY_TARGET)
    expect(gap.fixTarget.to).not.toContain('section=premises')
  })

  it('BusinessInfo fixTargets are provider-level — built with NO context', () => {
    for (const key of [...PREMISES_ROWS, ...APPLICABILITY_ROWS]) {
      const gap = gapFor(key, AWAITING)
      expect(gap.fixTarget, key).toBeTruthy()
      expect(gap.fixTarget.to, key).toContain('/business-info?section=')
    }
  })

  it('ONLY the five questionnaire/premises rows get an awaiting fixTarget (registry-wide)', () => {
    const linked = new Set([...PREMISES_ROWS, ...APPLICABILITY_ROWS])
    for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
      const gap = gapFor(key, AWAITING, CTX)
      if (linked.has(key)) {
        expect(gap.fixTarget, key).toBeTruthy()
      } else {
        expect(gap.fixTarget, `${key} must stay text-only on awaiting_input`).toBeUndefined()
      }
    }
  })

  it('row without per-row awaiting copy → generic Business Info sentence (C1 — no fixTarget: autoDefault APPLIES)', () => {
    const gap = gapFor('consent_field_trip_permission', AWAITING, CTX)
    expect(gap.guidanceText).toContain('Business Info')
    expect(gap.fixTarget).toBeUndefined()
  })

  it('animal notification has no per-row awaiting copy → generic sentence + applicability fixTarget', () => {
    const gap = gapFor('property_animal_notification', AWAITING, CTX)
    expect(gap.guidanceText).toContain('What applies to my program?')
    expect(gap.fixTarget).toEqual(APPLICABILITY_TARGET)
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

  it('non-awaiting state /business-info links: only the explicitly-allowed rows (G4 fingerprint, 2026-06-14)', () => {
    // The 3.1a invariant was "no non-awaiting state ever links to
    // /business-info" — that policy was correct when BusinessInfo
    // only served the awaiting_input questionnaire (premises +
    // applicability). Phase A of compliance_documents (2026-06-14)
    // added /business-info?section=licensing as a real provider-
    // level fix surface for G4 fingerprint reprint, so the
    // invariant is relaxed to an allowlist: any future addition
    // forces an explicit decision here.
    // expired falls back to the missing copy + the same surface
    // (actionableGapPropsFor), so a row with a surface property
    // produces a fixTarget for BOTH kinds even if its resolver
    // happens to only emit one. Allowlist both for G4 so the
    // invariant stays a meaningful gate without being brittle
    // against state-kind iteration. pending_parent never builds a
    // fixTarget (gated null in the resolver) and so is not listed.
    const NON_AWAITING_BUSINESS_INFO_ALLOWED = new Set([
      'cdc_fingerprint_reprint_currency:missing_required',
      'cdc_fingerprint_reprint_currency:expired',
      // 2026-06-14 batch (mig 039) — J1/J2/J8 property docs.
      'property_radon_test_quadrennial:missing_required',
      'property_radon_test_quadrennial:expired',
      'property_heating_inspection_quadrennial:missing_required',
      'property_heating_inspection_quadrennial:expired',
      'property_licensing_notebook_archive:missing_required',
      'property_licensing_notebook_archive:expired',
      // 2026-06-17 PR #21 inventory batch (mig 043). All five rows
      // are existence-only (no cycle), so only missing_required is
      // expected to fire. The :expired allowlist entries are
      // belt-and-suspenders against a future flip to a cycle-mode
      // resolver — adding both kinds keeps the gate stable.
      'property_co_detectors_per_level:missing_required',
      'property_co_detectors_per_level:expired',
      'property_smoke_detectors_per_floor:missing_required',
      'property_smoke_detectors_per_floor:expired',
      'property_fire_extinguishers_per_floor:missing_required',
      'property_fire_extinguishers_per_floor:expired',
      'property_animal_notification:missing_required',
      'property_animal_notification:expired',
      'property_smoking_prohibition_posted:missing_required',
      'property_smoking_prohibition_posted:expired',
    ])
    const kinds = ['missing_required', 'expired', 'pending_parent']
    for (const key of Object.keys(REQUIREMENT_REGISTRY)) {
      for (const kind of kinds) {
        const gap = gapFor(key, { kind }, CTX)
        if (gap && gap.fixTarget && gap.fixTarget.to.includes('/business-info')) {
          const pair = `${key}:${kind}`
          expect(
            NON_AWAITING_BUSINESS_INFO_ALLOWED.has(pair),
            `${pair} links to ${gap.fixTarget.to}. ` +
            'Add it to NON_AWAITING_BUSINESS_INFO_ALLOWED above if intentional.'
          ).toBe(true)
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
