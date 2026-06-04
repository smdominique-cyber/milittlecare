// Parent-side compliance projections — unit tests.
// Per docs/pr-parent-self-service-scope.md (Phase X §4) — locks the
// invariants behind the three parent-view bug fixes.

import { describe, it, expect } from 'vitest'
import { ACK_TYPES, PER_OCCURRENCE_CONSENT_TYPES } from './acknowledgments'
import {
  INTAKE_BUNDLE_ACK_TYPES,
  PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES,
  labelForAckType,
  isIntakeBundleAckType,
  isPerOccurrenceAckType,
} from './parentComplianceProjections'

describe('INTAKE_BUNDLE_ACK_TYPES — set contents (Bug 2 fix)', () => {
  it('includes the envelope + 8 parent-signed sub-rows + lead', () => {
    // The bundle includes:
    //   envelope (1) + 8 sub-rows including inform-only lead
    //   = 9 ack types total
    expect(INTAKE_BUNDLE_ACK_TYPES.length).toBe(9)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.CHILD_IN_CARE_STATEMENT)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.LEAD_DISCLOSURE)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.FOOD_PROVIDER_AGREEMENT)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.LICENSING_RULES_OFFERED)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.INFANT_SAFE_SLEEP)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.HEALTH_CONDITION)
    expect(INTAKE_BUNDLE_ACK_TYPES).toContain(ACK_TYPES.DISCIPLINE_POLICY_RECEIPT)
  })

  it('EXCLUDES per-occurrence types (Bug 2 fix invariant)', () => {
    for (const t of PER_OCCURRENCE_CONSENT_TYPES) {
      expect(INTAKE_BUNDLE_ACK_TYPES).not.toContain(t)
    }
  })

  it('EXCLUDES enrollment-level (durable + Phase B) consents', () => {
    expect(INTAKE_BUNDLE_ACK_TYPES).not.toContain(ACK_TYPES.FIELD_TRIP_PERMISSION)
    expect(INTAKE_BUNDLE_ACK_TYPES).not.toContain(ACK_TYPES.PHOTO_SHARING_CONSENT)
    expect(INTAKE_BUNDLE_ACK_TYPES).not.toContain(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)
    expect(INTAKE_BUNDLE_ACK_TYPES).not.toContain(ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL)
  })

  it('the set is frozen', () => {
    expect(Object.isFrozen(INTAKE_BUNDLE_ACK_TYPES)).toBe(true)
  })
})

describe('PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES (Bug 3 fix)', () => {
  it('matches the engine PER_OCCURRENCE_CONSENT_TYPES', () => {
    expect(PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES.length)
      .toBe(PER_OCCURRENCE_CONSENT_TYPES.length)
    for (const t of PER_OCCURRENCE_CONSENT_TYPES) {
      expect(PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES).toContain(t)
    }
  })

  it('includes both per-occurrence types', () => {
    expect(PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES)
      .toContain(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)
    expect(PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES)
      .toContain(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)
  })
})

describe('labelForAckType (Bug 1 fix)', () => {
  it('returns the registry label for every intake-bundle ack type', () => {
    for (const ackType of INTAKE_BUNDLE_ACK_TYPES) {
      const label = labelForAckType(ackType)
      expect(label).toBeTruthy()
      expect(typeof label).toBe('string')
      // Critical invariant: never returns the raw ack-type string.
      expect(label).not.toBe(ackType)
    }
  })

  it('returns the registry label for every enrollment consent', () => {
    expect(labelForAckType(ACK_TYPES.FIELD_TRIP_PERMISSION)).toBeTruthy()
    expect(labelForAckType(ACK_TYPES.PHOTO_SHARING_CONSENT)).toBeTruthy()
    expect(labelForAckType(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)).toBeTruthy()
    expect(labelForAckType(ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL)).toBeTruthy()
  })

  it('returns the registry label for per-occurrence types', () => {
    expect(labelForAckType(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)).toBeTruthy()
    expect(labelForAckType(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)).toBeTruthy()
  })

  it('returns the engine label for lead disclosure (Bug 1 specific case — was raw before)', () => {
    const label = labelForAckType(ACK_TYPES.LEAD_DISCLOSURE)
    expect(label).toContain('Lead')
    expect(label).not.toBe('lead_disclosure')
  })

  it('returns null for unknown ack types (caller decides fallback)', () => {
    expect(labelForAckType('unknown_type_xyz')).toBeNull()
    expect(labelForAckType('')).toBeNull()
    expect(labelForAckType(null)).toBeNull()
    expect(labelForAckType(undefined)).toBeNull()
  })

  it('returns label that is not the raw type string for every mapped type', () => {
    // The whole point of the helper: replace raw-type-string rendering.
    const allMappedTypes = [
      ...INTAKE_BUNDLE_ACK_TYPES,
      ACK_TYPES.FIELD_TRIP_PERMISSION,
      ACK_TYPES.PHOTO_SHARING_CONSENT,
      ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL,
      ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL,
      ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP,
      ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP,
    ]
    for (const t of allMappedTypes) {
      const label = labelForAckType(t)
      expect(label).not.toBe(t)
    }
  })
})

describe('isIntakeBundleAckType', () => {
  it('returns true for every intake bundle type', () => {
    for (const t of INTAKE_BUNDLE_ACK_TYPES) {
      expect(isIntakeBundleAckType(t)).toBe(true)
    }
  })

  it('returns false for per-occurrence types (Bug 2 invariant)', () => {
    expect(isIntakeBundleAckType(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)).toBe(false)
    expect(isIntakeBundleAckType(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)).toBe(false)
  })

  it('returns false for enrollment-level types', () => {
    expect(isIntakeBundleAckType(ACK_TYPES.FIELD_TRIP_PERMISSION)).toBe(false)
    expect(isIntakeBundleAckType(ACK_TYPES.PHOTO_SHARING_CONSENT)).toBe(false)
    expect(isIntakeBundleAckType(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)).toBe(false)
  })

  it('returns false for unknown / null / undefined', () => {
    expect(isIntakeBundleAckType('unknown_xyz')).toBe(false)
    expect(isIntakeBundleAckType('')).toBe(false)
    expect(isIntakeBundleAckType(null)).toBe(false)
    expect(isIntakeBundleAckType(undefined)).toBe(false)
  })
})

describe('isPerOccurrenceAckType', () => {
  it('returns true for both per-occurrence types', () => {
    expect(isPerOccurrenceAckType(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)).toBe(true)
    expect(isPerOccurrenceAckType(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)).toBe(true)
  })

  it('returns false for intake bundle types', () => {
    for (const t of INTAKE_BUNDLE_ACK_TYPES) {
      expect(isPerOccurrenceAckType(t)).toBe(false)
    }
  })

  it('returns false for enrollment-level types', () => {
    expect(isPerOccurrenceAckType(ACK_TYPES.FIELD_TRIP_PERMISSION)).toBe(false)
    expect(isPerOccurrenceAckType(ACK_TYPES.PHOTO_SHARING_CONSENT)).toBe(false)
    expect(isPerOccurrenceAckType(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)).toBe(false)
  })

  it('returns false for unknown / null', () => {
    expect(isPerOccurrenceAckType('unknown_xyz')).toBe(false)
    expect(isPerOccurrenceAckType(null)).toBe(false)
  })
})

describe('Registry mapping invariant', () => {
  it('every intake-bundle ack type resolves to a real registry row', () => {
    // The hand-maintained INTAKE_BUNDLE_TYPE_TO_REQUIREMENT_KEY map
    // must point at registry keys that actually exist. labelForAckType
    // returning non-null for every member proves the lookup chain.
    for (const t of INTAKE_BUNDLE_ACK_TYPES) {
      expect(labelForAckType(t)).not.toBeNull()
    }
  })

  it('every per-occurrence ack type resolves to a real registry row', () => {
    for (const t of PER_OCCURRENCE_PARENT_SURFACE_ACK_TYPES) {
      expect(labelForAckType(t)).not.toBeNull()
    }
  })
})
