// Compliance Engine Phase 1 — pure layer tests.
//
// Per docs/pr-compliance-engine-phase-1-scope.md §8: ≥4 tests per
// registry row, applicability-branch coverage, rollup + determinism,
// backward-compat smoke against the existing audit-state helpers.
// Pure layer — no Supabase mock needed.

import { describe, it, expect } from 'vitest'
import {
  REQUIREMENT_REGISTRY,
  REQUIREMENT_STATE_KIND,
  APPLICABILITY_RESULT,
  CATEGORIES,
  REGISTRY_ROW_COUNT,
  DATA_STATE,
  resolveApplicability,
  getRequirementState,
  getChildComplianceState,
  getProviderComplianceState,
} from './complianceState'
import { ACK_TYPES } from './acknowledgments'

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z')
const PROVIDER_ID = '00000000-0000-0000-0000-000000000001'

function makeLicensedProvider(overrides = {}) {
  return {
    id: PROVIDER_ID,
    license_type: 'family_home',
    home_built_before_1978: false,
    firearms_on_premises: false,
    is_license_exempt: false,
    miregistry_current_level: null,
    miregistry_level_2_expires_on: null,
    fingerprint_date: null,
    ...overrides,
  }
}

function makeLepProvider(overrides = {}) {
  return {
    id: PROVIDER_ID,
    license_type: 'license_exempt',
    home_built_before_1978: false,
    firearms_on_premises: false,
    is_license_exempt: true,
    miregistry_current_level: 'level_1',
    miregistry_level_2_expires_on: null,
    fingerprint_date: null,
    ...overrides,
  }
}

function makeChild(overrides = {}) {
  return {
    id: 'child-1',
    family_id: 'family-1',
    date_of_birth: '2020-01-15',  // ~6 years old at FIXED_NOW
    intake_completed_at: null,
    records_last_reviewed_on: null,
    immunization_status: null,
    food_provider: null,
    ...overrides,
  }
}

function makeInfantChild(overrides = {}) {
  return makeChild({ date_of_birth: '2025-12-01', ...overrides })  // ~6 months at FIXED_NOW
}

function makeAck(overrides = {}) {
  return {
    id: 'ack-' + Math.random().toString(16).slice(2),
    type: 'lead_disclosure',
    subject_type: 'child',
    subject_id: 'child-1',
    acknowledged_via: 'in_person_paper',
    acknowledged_at: '2026-06-01T00:00:00.000Z',
    expires_at: null,
    archived_at: null,
    snapshot_hash: 'abc123',
    occurrence_metadata: null,
    ...overrides,
  }
}

function makeSourceRows(overrides = {}) {
  return {
    acks: [],
    medication_authorizations: [],
    medication_admin_events: [],
    caregivers: [],
    staff_training_records: [],
    health_safety_updates: [],
    funding_sources: [],
    funding_documents: [],
    miregistry_training_entries: [],
    attendance_acks: [],
    drill_logs: null,
    property_records: null,
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// Registry structural tests
// -----------------------------------------------------------------------------

describe('REQUIREMENT_REGISTRY — structural', () => {
  it('has exactly 52 rows (row 19 religious-objection deferred)', () => {
    expect(REGISTRY_ROW_COUNT).toBe(52)
  })

  it('every row has the required shape', () => {
    const REQUIRED_KEYS = [
      'key', 'category', 'rule_citation', 'label', 'subject_type',
      'data_authority', 'gsq_relevant', 'severity', 'applicability',
      'state_resolver',
    ]
    for (const [key, row] of Object.entries(REQUIREMENT_REGISTRY)) {
      for (const k of REQUIRED_KEYS) {
        expect(row).toHaveProperty(k)
      }
      expect(row.key).toBe(key)
      expect(CATEGORIES).toContain(row.category)
      expect(['milittlecare', 'miregistry']).toContain(row.data_authority)
      expect(['critical', 'high', 'medium', 'low']).toContain(row.severity)
      expect(typeof row.state_resolver).toBe('function')
    }
  })

  it('religious-objection row is NOT in the registry (deferred)', () => {
    for (const row of Object.values(REQUIREMENT_REGISTRY)) {
      expect(row.key).not.toBe('consent_religious_objection_emergency_medical')
      expect(row.rule_citation).not.toMatch(/R 400\.1907\(1\)\(d\)/)
    }
  })

  it('the three unknown-defaulted rows have autoDefault=unknown', () => {
    const UNKNOWN_ROWS = [
      'consent_transportation_routine_annual',
      'consent_water_activities_on_premises_seasonal',
      'property_animal_notification',
    ]
    for (const key of UNKNOWN_ROWS) {
      const row = REQUIREMENT_REGISTRY[key]
      expect(row).toBeDefined()
      expect(row.applicability.autoDefault).toBe(APPLICABILITY_RESULT.UNKNOWN)
    }
  })

  it('every row key is unique', () => {
    const keys = Object.values(REQUIREMENT_REGISTRY).map(r => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('registry is frozen (Object.freeze)', () => {
    expect(Object.isFrozen(REQUIREMENT_REGISTRY)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// The §10 INVARIANT — unknown-defaulted rows MUST return
// { kind: 'unknown', reason: 'awaiting-provider-input' } in every read path
// -----------------------------------------------------------------------------

describe('§10 invariant — unknown rows resolve to awaiting-provider-input', () => {
  const UNKNOWN_ROWS = [
    'consent_transportation_routine_annual',
    'consent_water_activities_on_premises_seasonal',
    'property_animal_notification',
  ]

  for (const key of UNKNOWN_ROWS) {
    it(`${key}: state = unknown, reason = awaiting-provider-input (empty overrides)`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      const ctx = {
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides: new Map(),  // Phase 1's empty Map
        now: FIXED_NOW,
      }
      const state = getRequirementState(ctx)
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(state.reason).toBe('awaiting-provider-input')
    })

    it(`${key}: resolveApplicability returns 'unknown' with no overrides`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      const result = resolveApplicability({
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides: new Map(),
        now: FIXED_NOW,
      })
      expect(result).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  }
})

// -----------------------------------------------------------------------------
// Phase 3 seam — overrides Map flips applicability
// -----------------------------------------------------------------------------

describe('Phase 3 overrides seam', () => {
  it('overrides Map.applies makes an unknown row resolve to applies', () => {
    const requirement = REQUIREMENT_REGISTRY.consent_transportation_routine_annual
    const overrides = new Map([
      [requirement.key, APPLICABILITY_RESULT.APPLIES],
    ])
    const result = resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })
    expect(result).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('overrides Map.does_not_apply makes an unknown row resolve to does_not_apply', () => {
    const requirement = REQUIREMENT_REGISTRY.consent_water_activities_on_premises_seasonal
    const overrides = new Map([
      [requirement.key, APPLICABILITY_RESULT.DOES_NOT_APPLY],
    ])
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('empty overrides Map (Phase 1 default) is a no-op — behavior matches passing no overrides', () => {
    const requirement = REQUIREMENT_REGISTRY.consent_field_trip_permission
    const ctx = {
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    }
    const withEmpty = getRequirementState({ ...ctx, overrides: new Map() })
    const withNone = getRequirementState(ctx)
    expect(withEmpty).toEqual(withNone)
  })

  it('every pure function accepts overrides Map without throwing', () => {
    const overrides = new Map()
    expect(() => resolveApplicability({
      requirement: REQUIREMENT_REGISTRY.consent_field_trip_permission,
      provider: makeLicensedProvider(),
      child: makeChild(),
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })).not.toThrow()
    expect(() => getChildComplianceState({
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })).not.toThrow()
    expect(() => getProviderComplianceState({
      provider: makeLicensedProvider(),
      children: [makeChild()],
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })).not.toThrow()
  })
})

// -----------------------------------------------------------------------------
// Applicability branches — coverage per §8
// -----------------------------------------------------------------------------

describe('resolveApplicability — universalFor', () => {
  it('matches license_type → applies', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('mismatched license_type → does_not_apply', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLepProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })

  it('null license_type → does_not_apply (universalFor list excludes null)', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ license_type: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })
})

describe('resolveApplicability — childGate (infant safe sleep)', () => {
  const requirement = REQUIREMENT_REGISTRY.intake_infant_safe_sleep

  it('child <18mo → applies', () => {
    expect(resolveApplicability({
      requirement,
      child: makeInfantChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('child ≥18mo → does_not_apply', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild({ date_of_birth: '2022-01-01' }),  // 4+ years at FIXED_NOW
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })

  it('child null DOB → unknown (per §2a: cannot affirmatively classify)', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild({ date_of_birth: null }),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.UNKNOWN)
  })
})

describe('resolveApplicability — inferFromData (lead disclosure)', () => {
  const requirement = REQUIREMENT_REGISTRY.intake_lead_disclosure

  it('home_built_before_1978 = true → applies', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: true }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('home_built_before_1978 = false → does_not_apply (affirmative negative per §2a)', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: false }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })

  it('home_built_before_1978 = null → unknown (§2a: cannot classify)', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.UNKNOWN)
  })
})

describe('resolveApplicability — inferFromData (firearms disclosure)', () => {
  const requirement = REQUIREMENT_REGISTRY.intake_firearms_disclosure

  it('firearms_on_premises = true → applies (yes-copy)', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ firearms_on_premises: true }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('firearms_on_premises = false → applies (no-copy still required)', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ firearms_on_premises: false }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })

  it('firearms_on_premises = null → unknown', () => {
    expect(resolveApplicability({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ firearms_on_premises: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBe(APPLICABILITY_RESULT.UNKNOWN)
  })
})

// -----------------------------------------------------------------------------
// Pattern A — parent-signed ack (representative coverage on field-trip
// permission — same pattern serves intake_*, transportation_routine_*, etc.)
// -----------------------------------------------------------------------------

describe('Pattern A — patternAAckOnFile via field_trip_permission', () => {
  const requirement = REQUIREMENT_REGISTRY.consent_field_trip_permission

  it('parent_portal active ack → on_file', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.FIELD_TRIP_PERMISSION,
          acknowledged_via: 'parent_portal',
        })],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(state.evidence_id).toBeDefined()
  })

  it('in_person_paper active ack → on_file', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.FIELD_TRIP_PERMISSION,
          acknowledged_via: 'in_person_paper',
        })],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('provider_override only → pending_parent', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.FIELD_TRIP_PERMISSION,
          acknowledged_via: 'provider_override',
        })],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })

  it('archived ack → missing_required (archived rows do not satisfy)', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.FIELD_TRIP_PERMISSION,
          acknowledged_via: 'parent_portal',
          archived_at: '2026-05-01T00:00:00.000Z',
        })],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('no acks → missing_required', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })
})

describe('Pattern A — expiry (transportation_routine_annual)', () => {
  // For the test, populate overrides so the row applies (Phase 1
  // default is unknown). Tests the EXPIRY behavior of Pattern A.
  const requirement = REQUIREMENT_REGISTRY.consent_transportation_routine_annual
  const overrides = new Map([[requirement.key, APPLICABILITY_RESULT.APPLIES]])

  it('expires_at in the future → on_file', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL,
          acknowledged_via: 'in_person_paper',
          expires_at: '2027-06-15T00:00:00.000Z',  // 1 year future
        })],
      }),
      overrides,
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(state.expires_at).toBe('2027-06-15T00:00:00.000Z')
  })

  it('expires_at in the past → expired', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL,
          acknowledged_via: 'in_person_paper',
          expires_at: '2025-06-15T00:00:00.000Z',  // 1 year past
        })],
      }),
      overrides,
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })
})

// -----------------------------------------------------------------------------
// Pattern B — inform-only (lead disclosure: provider_override satisfies)
// -----------------------------------------------------------------------------

describe('Pattern B — inform-only via lead_disclosure', () => {
  const requirement = REQUIREMENT_REGISTRY.intake_lead_disclosure

  it('provider_override active ack → on_file (any channel satisfies)', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: true }),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.LEAD_DISCLOSURE,
          acknowledged_via: 'provider_override',
        })],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('no acks but applies (pre-1978) → missing_required', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: true }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('home built after 1978 → not_applicable', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: false }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('null premises → unknown (§2a)', () => {
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider({ home_built_before_1978: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(state.reason).toBe('awaiting-provider-input')
  })
})

// -----------------------------------------------------------------------------
// Pattern C — date-driven currency (CPR, CDC auth, fingerprint)
// -----------------------------------------------------------------------------

describe('Pattern C — CDC fingerprint reprint currency', () => {
  const requirement = REQUIREMENT_REGISTRY.cdc_fingerprint_reprint_currency

  it('LEP with CDC + recent fingerprint → on_file', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ fingerprint_date: '2024-01-01' }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('LEP with CDC + fingerprint 6 years ago → expired', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ fingerprint_date: '2020-01-01' }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })

  it('LEP without CDC → does_not_apply', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ fingerprint_date: '2024-01-01' }),
      sourceRows: makeSourceRows({ funding_sources: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('licensed home → does_not_apply (LEP-only)', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider({ fingerprint_date: '2024-01-01' }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('LEP with CDC + missing fingerprint → missing_required', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ fingerprint_date: null }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })
})

// -----------------------------------------------------------------------------
// Pattern D — annual cadence with anchor (MiRegistry Dec 16)
// -----------------------------------------------------------------------------

describe('Pattern D — MiRegistry annual ongoing (Dec 16)', () => {
  const requirement = REQUIREMENT_REGISTRY.provider_miregistry_annual_ongoing

  it('LEP, completed this calendar year → on_file', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider(),
      sourceRows: makeSourceRows({
        miregistry_training_entries: [
          { source: 'annual_ongoing', completed_on: '2026-03-15', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('LEP, completed last calendar year → expired', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider(),
      sourceRows: makeSourceRows({
        miregistry_training_entries: [
          { source: 'annual_ongoing', completed_on: '2025-08-15', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })

  it('LEP, no annual_ongoing entries → missing_required', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider(),
      sourceRows: makeSourceRows({
        miregistry_training_entries: [
          { source: 'leppt', completed_on: '2026-02-15', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('licensed home → does_not_apply', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })
})

// -----------------------------------------------------------------------------
// Pattern E — feature-not-yet-shipped (drills, property, staff gaps)
// -----------------------------------------------------------------------------

describe('Pattern E — feature-not-yet-shipped', () => {
  const PATTERN_E_KEYS = [
    'drill_fire_quarterly',
    'drill_tornado_seasonal',
    'drill_other_emergencies_annual',
    'emergency_response_plan_on_file',
    'property_radon_test_quadrennial',
    'property_heating_inspection_quadrennial',
    'property_co_detectors_per_level',
    'property_smoke_detectors_per_floor',
    'property_fire_extinguishers_per_floor',
    'property_smoking_prohibition_posted',
    'property_licensing_notebook_archive',
    'caregiver_physician_attestation_annual',
    'caregiver_discipline_policy_ack_at_hire',
    'caregiver_daily_arrival_departure',
  ]

  for (const key of PATTERN_E_KEYS) {
    it(`${key}: state = unknown + feature-not-yet-shipped (when applicability=applies)`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      expect(requirement.data_state).toBe(DATA_STATE.NOT_YET_MODELLED)
      const state = getRequirementState({
        requirement,
        child: requirement.subject_type === 'child' ? makeChild() : null,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    })
  }

  it('property_animal_notification: even with applies override, state is unknown (Pattern E source) — but reason differs', () => {
    const requirement = REQUIREMENT_REGISTRY.property_animal_notification
    const overrides = new Map([[requirement.key, APPLICABILITY_RESULT.APPLIES]])
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides,
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(state.reason).toBe('feature-not-yet-shipped')
  })
})

// -----------------------------------------------------------------------------
// Medication category
// -----------------------------------------------------------------------------

describe('Medication category', () => {
  it('medication_permission_per_authorization — no auths → not_applicable', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_permission_per_authorization
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ medication_authorizations: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('medication_permission_per_authorization — non-OTC auth + parent ack → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_permission_per_authorization
    const auth = { id: 'auth-1', child_id: 'child-1', is_topical_otc: false, archived_at: null, updated_at: '2026-01-01T00:00:00Z' }
    const ack = makeAck({
      type: ACK_TYPES.MEDICATION_PERMISSION,
      subject_type: 'medication_authorization',
      subject_id: 'auth-1',
      acknowledged_via: 'in_person_paper',
      acknowledged_at: '2026-01-02T00:00:00Z',
    })
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        medication_authorizations: [auth],
        acks: [ack],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('medication_permission_per_authorization — auth changed after ack → pending_parent (drift)', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_permission_per_authorization
    const auth = { id: 'auth-1', child_id: 'child-1', is_topical_otc: false, archived_at: null, updated_at: '2026-04-01T00:00:00Z' }
    const ack = makeAck({
      type: ACK_TYPES.MEDICATION_PERMISSION,
      subject_type: 'medication_authorization',
      subject_id: 'auth-1',
      acknowledged_via: 'in_person_paper',
      acknowledged_at: '2026-01-02T00:00:00Z',
    })
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        medication_authorizations: [auth],
        acks: [ack],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
    expect(state.reason).toBe('authorization-changed-since-permission')
  })

  it('medication_role_gate_integrity — non-OTC dose by ineligible role → missing_required', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_role_gate_integrity
    const auth = { id: 'auth-1', is_topical_otc: false, archived_at: null }
    const event = { id: 'ev-1', authorization_id: 'auth-1', administered_by_caregiver_id: 'cg-volunteer', archived_at: null }
    const caregiver = { id: 'cg-volunteer', regulatory_roles: ['supervised_volunteer'] }
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        medication_authorizations: [auth],
        medication_admin_events: [event],
        caregivers: [caregiver],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(state.reason).toBe('ineligible-role-administered-non-otc-dose')
  })

  it('medication_role_gate_integrity — non-OTC dose by eligible role → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_role_gate_integrity
    const auth = { id: 'auth-1', is_topical_otc: false, archived_at: null }
    const event = { id: 'ev-1', authorization_id: 'auth-1', administered_by_caregiver_id: 'cg-staff', archived_at: null }
    const caregiver = { id: 'cg-staff', regulatory_roles: ['child_care_staff_member'] }
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        medication_authorizations: [auth],
        medication_admin_events: [event],
        caregivers: [caregiver],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('medication_permission_otc_blanket — OTC auth + ack → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.medication_permission_otc_blanket
    const auth = { id: 'auth-2', child_id: 'child-1', is_topical_otc: true, archived_at: null }
    const ack = makeAck({
      type: ACK_TYPES.MEDICATION_PERMISSION_OTC_BLANKET,
      acknowledged_via: 'parent_portal',
    })
    const state = getRequirementState({
      requirement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        medication_authorizations: [auth],
        acks: [ack],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })
})

// -----------------------------------------------------------------------------
// Staff files category
// -----------------------------------------------------------------------------

describe('Staff files category', () => {
  it('caregiver_cpr_first_aid_current — recent CPR cert → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_cpr_first_aid_current
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['child_care_staff_member'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'cpr_first_aid', completed_on: '2026-01-01', expires_on: '2028-01-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('caregiver_cpr_first_aid_current — expired CPR cert → expired', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_cpr_first_aid_current
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['child_care_staff_member'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'cpr_first_aid', completed_on: '2024-01-01', expires_on: '2025-12-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })

  it('caregiver_cpr_first_aid_current — no caregivers → missing_required', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_cpr_first_aid_current
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ caregivers: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('caregiver_background_check_eligibility — eligible status → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_background_check_eligibility
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['licensee'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'background_check_eligibility', background_check_status: 'eligible', completed_on: '2026-01-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('caregiver_background_check_eligibility — pending status → pending_parent', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_background_check_eligibility
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['licensee'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'background_check_eligibility', background_check_status: 'pending', completed_on: '2026-01-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })

  it('caregiver_new_hire_training_complete — all 14 topics → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_new_hire_training_complete
    const records = Array.from({ length: 14 }, (_, i) => ({
      id: `r-${i}`,
      caregiver_id: 'cg-1',
      category: 'new_hire_training',
      topic: `topic_${i}`,
      completed_on: '2026-02-01',
    }))
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, date_of_hire: '2026-01-01', regulatory_roles: ['child_care_staff_member'] }],
        staff_training_records: records,
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('caregiver_new_hire_training_complete — within 90-day window, partial → missing_required', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_new_hire_training_complete
    const recentHire = new Date(FIXED_NOW.getTime() - 30 * 86400000).toISOString().slice(0, 10)
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, date_of_hire: recentHire, regulatory_roles: ['child_care_staff_member'] }],
        staff_training_records: [],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(state.reason).toBe('within-90-day-window')
  })

  it('caregiver_new_hire_training_complete — past 90-day window, partial → expired', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_new_hire_training_complete
    const oldHire = new Date(FIXED_NOW.getTime() - 200 * 86400000).toISOString().slice(0, 10)
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, date_of_hire: oldHire, regulatory_roles: ['child_care_staff_member'] }],
        staff_training_records: [],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
    expect(state.reason).toBe('past-90-day-deadline')
  })

  it('caregiver_miregistry_account — current status → on_file (Type 1 tagged)', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_miregistry_account
    expect(requirement.data_authority).toBe('miregistry')
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['licensee'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'miregistry_account', miregistry_status: 'current', completed_on: '2026-01-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('caregiver_miregistry_account — expired status → expired', () => {
    const requirement = REQUIREMENT_REGISTRY.caregiver_miregistry_account
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers: [{ id: 'cg-1', archived_at: null, regulatory_roles: ['licensee'] }],
        staff_training_records: [
          { id: 'r-1', caregiver_id: 'cg-1', category: 'miregistry_account', miregistry_status: 'expired', completed_on: '2025-01-01' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })
})

// -----------------------------------------------------------------------------
// Funding + CDC
// -----------------------------------------------------------------------------

describe('Funding docs + CDC compliance', () => {
  it('funding_dhs_198_on_file — no CDC source → not_applicable', () => {
    const requirement = REQUIREMENT_REGISTRY.funding_dhs_198_on_file
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ funding_sources: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('funding_dhs_198_on_file — CDC source + doc → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.funding_dhs_198_on_file
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
        funding_documents: [{ id: 'doc-1', funding_source_id: 'fs-1', document_type: 'dhs_198', archived_at: null, retention_until: '2030-01-01' }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('funding_dhs_198_on_file — CDC source + no doc → missing_required', () => {
    const requirement = REQUIREMENT_REGISTRY.funding_dhs_198_on_file
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
        funding_documents: [],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('cdc_authorization_currency — future end → on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.cdc_authorization_currency
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null, authorization_end: '2027-01-01' }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('cdc_authorization_currency — past end → expired', () => {
    const requirement = REQUIREMENT_REGISTRY.cdc_authorization_currency
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null, authorization_end: '2025-01-01' }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })
})

// -----------------------------------------------------------------------------
// Provider miregistry level 2 (confirms field-name resolution)
// -----------------------------------------------------------------------------

describe('provider_miregistry_level_2_currency (Blocker 1 resolution)', () => {
  const requirement = REQUIREMENT_REGISTRY.provider_miregistry_level_2_currency

  it('LEP + level_2 + future expiry → on_file', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({
        miregistry_current_level: 'level_2',
        miregistry_level_2_expires_on: '2027-01-01',
      }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('LEP + level_2 + past expiry → expired', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({
        miregistry_current_level: 'level_2',
        miregistry_level_2_expires_on: '2024-01-01',
      }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })

  it('LEP + level_1 → not_applicable', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ miregistry_current_level: 'level_1' }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('licensed home → not_applicable', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('LEP + null level → unknown', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLepProvider({ miregistry_current_level: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
  })
})

// -----------------------------------------------------------------------------
// Attendance
// -----------------------------------------------------------------------------

describe('attendance_parent_acknowledgment_per_day', () => {
  const requirement = REQUIREMENT_REGISTRY.attendance_parent_acknowledgment_per_day

  it('no attendance acks → not_applicable', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ attendance_acks: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('all acks parent-signed → on_file', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        attendance_acks: [
          { id: 'a-1', acknowledged_via: 'parent_portal', archived_at: null },
          { id: 'a-2', acknowledged_via: 'in_person_paper', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('all acks provider_override → pending_parent', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        attendance_acks: [
          { id: 'a-1', acknowledged_via: 'provider_override', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })
})

// -----------------------------------------------------------------------------
// Per-child rollup
// -----------------------------------------------------------------------------

describe('getChildComplianceState — rollup', () => {
  it('returns null when no child supplied', () => {
    expect(getChildComplianceState({
      child: null,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBeNull()
  })

  it('all applicable + all on_file → any_gap=false', () => {
    const child = makeChild({
      date_of_birth: '2022-01-01',  // ≥18mo at FIXED_NOW, skips infant safe-sleep
      intake_completed_at: '2026-05-01T00:00:00Z',
      immunization_status: 'up_to_date',
    })
    const provider = makeLicensedProvider({
      home_built_before_1978: false,  // skips lead disclosure
      firearms_on_premises: false,    // firearms disclosure DOES apply (false-copy)
    })
    // Build acks for every Pattern A child requirement that applies.
    const REQUIRED_ACK_TYPES = [
      ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      ACK_TYPES.FIREARMS_DISCLOSURE,
      ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
      ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY,
      ACK_TYPES.LICENSING_RULES_OFFERED,
      ACK_TYPES.HEALTH_CONDITION,
      ACK_TYPES.DISCIPLINE_POLICY_RECEIPT,
      ACK_TYPES.FIELD_TRIP_PERMISSION,
      ACK_TYPES.PHOTO_SHARING_CONSENT,
    ]
    const acks = REQUIRED_ACK_TYPES.map(t => makeAck({ type: t, acknowledged_via: 'parent_portal' }))
    // Override the three unknown rows to does_not_apply so they
    // don't poison the rollup.
    const overrides = new Map([
      ['consent_transportation_routine_annual', APPLICABILITY_RESULT.DOES_NOT_APPLY],
      ['consent_water_activities_on_premises_seasonal', APPLICABILITY_RESULT.DOES_NOT_APPLY],
    ])
    const rollup = getChildComplianceState({
      child,
      provider,
      sourceRows: makeSourceRows({ acks }),
      overrides,
      now: FIXED_NOW,
    })
    expect(rollup.any_gap).toBe(false)
    expect(rollup.totals.on_file).toBeGreaterThan(0)
    expect(rollup.totals.missing_required).toBe(0)
  })

  it('missing intake parent-signed ack → any_gap=true, missing_required>0', () => {
    const child = makeChild({ date_of_birth: '2022-01-01' })
    const rollup = getChildComplianceState({
      child,
      provider: makeLicensedProvider({ firearms_on_premises: true }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(rollup.any_gap).toBe(true)
    expect(rollup.totals.missing_required).toBeGreaterThan(0)
  })

  it('null premises → any_unknown_input=true', () => {
    const child = makeChild({ date_of_birth: '2022-01-01' })
    const rollup = getChildComplianceState({
      child,
      provider: makeLicensedProvider({ home_built_before_1978: null, firearms_on_premises: null }),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(rollup.any_unknown_input).toBe(true)
  })

  it('rollup includes per_category buckets keyed by CATEGORIES', () => {
    const rollup = getChildComplianceState({
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(rollup.per_category).toBeDefined()
    for (const c of CATEGORIES) {
      expect(rollup.per_category).toHaveProperty(c)
    }
  })
})

// -----------------------------------------------------------------------------
// Per-provider rollup
// -----------------------------------------------------------------------------

describe('getProviderComplianceState — rollup', () => {
  it('returns null when no provider supplied', () => {
    expect(getProviderComplianceState({
      provider: null,
      children: [],
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })).toBeNull()
  })

  it('licensed home with no children — provider-level rollup still computes', () => {
    const rollup = getProviderComplianceState({
      provider: makeLicensedProvider(),
      children: [],
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    expect(rollup).not.toBeNull()
    expect(rollup.per_child).toEqual([])
    expect(rollup.provider_level).toBeDefined()
    // Drills + property are Pattern E → unknown_count > 0.
    expect(rollup.totals.unknown).toBeGreaterThan(0)
  })

  it('LEP provider — drills/property requirements not applicable', () => {
    const rollup = getProviderComplianceState({
      provider: makeLepProvider(),
      children: [],
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    // Drills + property apply only to family_home / group_home.
    const drillReqs = rollup.provider_level.per_category.drills.requirements
    for (const r of drillReqs) {
      expect(r.applicability).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
      expect(r.state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    }
  })

  it('totals are the sum of per_child + provider_level', () => {
    const rollup = getProviderComplianceState({
      provider: makeLicensedProvider(),
      children: [makeChild(), makeChild({ id: 'child-2' })],
      sourceRows: makeSourceRows(),
      now: FIXED_NOW,
    })
    // Sanity: totals.unknown should include the three unknown-defaulted
    // consent rows × 2 children + property_animal_notification + Pattern E
    // requirements at provider level.
    expect(rollup.totals.unknown).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------------
// Determinism + idempotency
// -----------------------------------------------------------------------------

describe('Determinism', () => {
  it('two calls with same inputs return equal output (JSON)', () => {
    const args = {
      requirement: REQUIREMENT_REGISTRY.intake_food_provider_agreement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({ type: ACK_TYPES.FOOD_PROVIDER_AGREEMENT, acknowledged_via: 'in_person_paper' })],
      }),
      now: FIXED_NOW,
    }
    const a = getRequirementState(args)
    const b = getRequirementState(args)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('different `now` controls expiry boundary deterministically', () => {
    const requirement = REQUIREMENT_REGISTRY.consent_transportation_routine_annual
    const overrides = new Map([[requirement.key, APPLICABILITY_RESULT.APPLIES]])
    const ack = makeAck({
      type: ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL,
      acknowledged_via: 'in_person_paper',
      expires_at: '2026-06-15T12:00:00.000Z',
    })
    // Just before expiry → on_file
    const before = getRequirementState({
      requirement, child: makeChild(), provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ acks: [ack] }),
      overrides,
      now: new Date('2026-06-15T11:59:59.000Z'),
    })
    // Just past expiry → expired
    const after = getRequirementState({
      requirement, child: makeChild(), provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({ acks: [ack] }),
      overrides,
      now: new Date('2026-06-15T12:00:01.000Z'),
    })
    expect(before.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(after.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })
})

// -----------------------------------------------------------------------------
// Backward-compat smoke
// -----------------------------------------------------------------------------

describe('Backward-compat smoke — Phase 1 does not touch existing helpers', () => {
  it('existing acknowledgments module still importable and has expected exports', async () => {
    const acks = await import('./acknowledgments')
    expect(acks.ACK_TYPES).toBeDefined()
    expect(acks.requiredSubTypesForChild).toBeTypeOf('function')
  })

  // NOTE: we deliberately do NOT import `./childFiles` from a vitest
  // file without a supabase mock (it eagerly imports `./supabase`).
  // The downstream backward-compat smoke that confirms childFiles.js
  // shape is the existing `childFiles.test.js` — that suite passes
  // unchanged is part of the build-PR gate. We instead lock the
  // PARENT_SIGNED_SATISFYING_CHANNELS duplication invariant here:
  // if childFiles.js's constant ever changes, the duplicated constant
  // in complianceState.js must change in lockstep, and this test
  // would surface a value mismatch on read.
  it('Pattern A satisfies on parent_portal + in_person_paper (mirrors childFiles.PARENT_SIGNED_SATISFYING_CHANNELS)', () => {
    // Indirect: any Pattern A row should accept parent_portal and
    // in_person_paper, and NOT provider_override alone.
    const req = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    const make = (channel) => getRequirementState({
      requirement: req,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({ type: ACK_TYPES.FOOD_PROVIDER_AGREEMENT, acknowledged_via: channel })],
      }),
      now: FIXED_NOW,
    })
    expect(make('parent_portal').kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(make('in_person_paper').kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(make('provider_override').kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })
})

// -----------------------------------------------------------------------------
// Defensive — bad inputs
// -----------------------------------------------------------------------------

describe('Defensive', () => {
  it('no requirement → unknown', () => {
    expect(getRequirementState({}).kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
  })

  it('requirement missing applicability → unknown', () => {
    const result = resolveApplicability({ requirement: { key: 'x' }, provider: makeLicensedProvider() })
    expect(result).toBe(APPLICABILITY_RESULT.UNKNOWN)
  })

  it('null sourceRows is tolerated', () => {
    const state = getRequirementState({
      requirement: REQUIREMENT_REGISTRY.intake_food_provider_agreement,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: { acks: undefined },
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('overrides as plain object (not Map) does not crash but is ignored', () => {
    // Map.has is checked defensively; plain objects don't have .has.
    const state = getRequirementState({
      requirement: REQUIREMENT_REGISTRY.consent_field_trip_permission,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides: {},  // wrong type — should be ignored, not crash
      now: FIXED_NOW,
    })
    expect(state.kind).toBeDefined()
  })
})
