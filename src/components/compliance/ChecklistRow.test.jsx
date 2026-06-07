// Unit tests for the exported helpers from ChecklistRow.jsx.
//
// Scope today: the trackingCopy() helper that resolves the
// "tracking ships with PR #N" copy for not_yet_modelled rows.
// Pre-fix (before 2026-06-06), the lookup keyed only on
// req.category — which meant all three staff_files not_yet_modelled
// rows (physician attestation, discipline-policy ack, arrival/
// departure log) rendered the same combined "PR #18 ... and PR
// #17 ..." mashup. Fixed by switching to a per-key map with a
// category fallback.
//
// The component itself is presentational JSX without further pure
// surface; mount-test coverage is deferred.

import { describe, it, expect } from 'vitest'
import { trackingCopy, TRACKING_SHIPS_WITH } from './ChecklistRow'

// -----------------------------------------------------------------------------
// Per-row entries — the bug-fix coverage
// -----------------------------------------------------------------------------

describe('trackingCopy — per-row entries (the staff_files mashup fix)', () => {
  it('caregiver_physician_attestation_annual → PR #18', () => {
    const req = {
      key: 'caregiver_physician_attestation_annual',
      category: 'staff_files',
    }
    expect(trackingCopy(req)).toBe('PR #18 (staff file gaps)')
  })

  it('caregiver_discipline_policy_ack_at_hire → PR #17', () => {
    const req = {
      key: 'caregiver_discipline_policy_ack_at_hire',
      category: 'staff_files',
    }
    expect(trackingCopy(req)).toBe('PR #17 (discipline policy receipt at hire)')
  })

  it('caregiver_daily_arrival_departure → PR #18', () => {
    const req = {
      key: 'caregiver_daily_arrival_departure',
      category: 'staff_files',
    }
    expect(trackingCopy(req)).toBe('PR #18 (staff file gaps)')
  })

  it('the three staff_files rows render DISTINCT strings (no mashup)', () => {
    // Regression lock for the original bug: all three rows used to
    // render the same combined "PR #18 ... and PR #17 ..." string
    // because the lookup keyed on category alone.
    const physician = trackingCopy({
      key: 'caregiver_physician_attestation_annual', category: 'staff_files',
    })
    const discipline = trackingCopy({
      key: 'caregiver_discipline_policy_ack_at_hire', category: 'staff_files',
    })
    const arrival = trackingCopy({
      key: 'caregiver_daily_arrival_departure', category: 'staff_files',
    })
    // discipline differs from the two PR-#18 rows.
    expect(discipline).not.toBe(physician)
    expect(discipline).not.toBe(arrival)
    // None contains the mashup substring "PR #18 ... and PR #17".
    for (const s of [physician, discipline, arrival]) {
      expect(s).not.toMatch(/PR #18.*and.*PR #17/)
    }
  })
})

// -----------------------------------------------------------------------------
// Category-level fallback — drills + property must keep working
// -----------------------------------------------------------------------------

describe('trackingCopy — category fallback (drills + property unaffected)', () => {
  it('drills → PR #19 via category fallback (all four drill rows)', () => {
    // The four drill not_yet_modelled rows: drill_fire_quarterly,
    // drill_tornado_seasonal, drill_other_emergencies_annual,
    // emergency_response_plan_on_file. All four hit the category
    // entry — no per-key override.
    const drillKeys = [
      'drill_fire_quarterly',
      'drill_tornado_seasonal',
      'drill_other_emergencies_annual',
      'emergency_response_plan_on_file',
    ]
    for (const key of drillKeys) {
      expect(trackingCopy({ key, category: 'drills' }))
        .toBe('PR #19 (drills + emergency response plan)')
    }
  })

  it('property → PR #21 via category fallback (all eight property rows)', () => {
    const propertyKeys = [
      'property_radon_test_quadrennial',
      'property_heating_inspection_quadrennial',
      'property_co_detectors_per_level',
      'property_smoke_detectors_per_floor',
      'property_fire_extinguishers_per_floor',
      'property_animal_notification',
      'property_smoking_prohibition_posted',
      'property_licensing_notebook_archive',
    ]
    for (const key of propertyKeys) {
      expect(trackingCopy({ key, category: 'property' }))
        .toBe('PR #21 (property records)')
    }
  })
})

// -----------------------------------------------------------------------------
// Generic fallback + defensive defaults
// -----------------------------------------------------------------------------

describe('trackingCopy — generic fallback', () => {
  it('unmapped category → generic fallback', () => {
    expect(trackingCopy({ key: 'something_else', category: 'attendance' }))
      .toBe('a future MILittleCare build')
  })

  it('null requirement → generic fallback (defensive)', () => {
    expect(trackingCopy(null)).toBe('a future MILittleCare build')
    expect(trackingCopy(undefined)).toBe('a future MILittleCare build')
  })

  it('row with no key but a mapped category → category fallback', () => {
    // Defensive: a malformed row missing `key` still resolves
    // through category.
    expect(trackingCopy({ category: 'drills' }))
      .toBe('PR #19 (drills + emergency response plan)')
  })

  it('staff_files category alone is NOT in the map (regression lock)', () => {
    // Pre-fix, TRACKING_SHIPS_WITH had a `staff_files` category
    // entry that produced the mashup. The fix removed it. This
    // test fails if a future contributor re-adds the category-level
    // entry without re-checking the bug rationale.
    expect(TRACKING_SHIPS_WITH.staff_files).toBeUndefined()
  })
})
