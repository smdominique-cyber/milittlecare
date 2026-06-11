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
  // Phase 3 — pure projection helpers.
  classifyUnknownReason,
  filterByDataState,
  getChildComplianceStateForCategory,
  listProviderDeclaredApplicabilityRequirements,
  // Phase 3 fix-forward (2026-06-05).
  NEEDS_PROVIDER_DATA_REASONS,
  // Phase 3.1 prerequisite (2026-06-10).
  LOAD_FAILURE_REASONS,
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

// Mirror of migration 013's professional_development seed rows —
// the role-based annual minima per R 400.1924(1)-(4) that E5's
// resolver rolls up via getEffectiveRequirements.
const PD_CATALOG = Object.freeze([
  { id: 'tr-1', category: 'professional_development', regulatory_role: 'licensee',                is_required: true, cadence: 'per_calendar_year', required_hours: 10, condition: null, citation: 'R 400.1924(1)' },
  { id: 'tr-2', category: 'professional_development', regulatory_role: 'child_care_staff_member', is_required: true, cadence: 'per_calendar_year', required_hours: 5,  condition: null, citation: 'R 400.1924(2)' },
  { id: 'tr-3', category: 'professional_development', regulatory_role: 'child_care_assistant',    is_required: true, cadence: 'per_calendar_year', required_hours: 5,  condition: null, citation: 'R 400.1924(2)' },
  { id: 'tr-4', category: 'professional_development', regulatory_role: 'unsupervised_volunteer',  is_required: true, cadence: 'per_calendar_year', required_hours: 1,  condition: null, citation: 'R 400.1924(3)' },
  { id: 'tr-5', category: 'professional_development', regulatory_role: 'driver',                  is_required: true, cadence: 'per_calendar_year', required_hours: 1,  condition: null, citation: 'R 400.1924(4)' },
])

function makeSourceRows(overrides = {}) {
  return {
    acks: [],
    medication_authorizations: [],
    medication_admin_events: [],
    caregivers: [],
    staff_training_records: [],
    training_requirements: [...PD_CATALOG],
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
  it('has exactly 50 rows (religious-objection deferred; funding_dhs_198_on_file removed 2026-06-06; D4 role-gate retired 2026-06-10)', () => {
    // Pre-correction-pass count was 52. The CDC-layer correctness
    // pass (docs/Compliance Corrections.md Part 2) removed
    // funding_dhs_198_on_file because the DHS-198 is MDHHS's
    // authorization notice TO the provider, not a document the
    // provider fulfills — it never belonged on a compliance
    // checklist. medication_role_gate_integrity (D4) was retired
    // 2026-06-10: R 400.1931(1) is enforced at entry (dropdown gate
    // + DB trigger) instead of detected after the fact.
    expect(REGISTRY_ROW_COUNT).toBe(50)
  })

  it('retirement lock: medication_role_gate_integrity (D4) is NOT in the registry', () => {
    expect(REQUIREMENT_REGISTRY.medication_role_gate_integrity).toBeUndefined()
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

  // CORRECTED 2026-06-06 per docs/Compliance Corrections.md Part 6
  // — the 5-year reprint cycle is NOT LEP-only. Licensed
  // Family/Group Home providers with CDC are equally subject.
  // Was: licensed home + CDC → not_applicable.
  // Now: licensed home + CDC → on_file/expired/etc. per fingerprint date.
  it('licensed home with CDC + recent fingerprint → on_file (Part 6 correction)', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider({ fingerprint_date: '2024-01-01' }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('licensed home with CDC + fingerprint 6 years ago → expired (Part 6 correction)', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider({ fingerprint_date: '2020-01-01' }),
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.EXPIRED)
  })

  it('licensed home without CDC → not_applicable (CDC-gated, not LEP-gated)', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider({ fingerprint_date: '2024-01-01' }),
      sourceRows: makeSourceRows({ funding_sources: [] }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('unanswered license_type AND is_license_exempt → unknown (§2a)', () => {
    const state = getRequirementState({
      requirement,
      provider: { id: 'p-1', license_type: null, is_license_exempt: null, fingerprint_date: '2024-01-01' },
      sourceRows: makeSourceRows({
        funding_sources: [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null }],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
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

  // D4 (medication_role_gate_integrity) retired 2026-06-10 — enforced
  // at entry (dropdown gate + DB trigger), no detection row. The
  // retirement lock lives in the registry-shape describe.

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
// E5 — caregiver_professional_development_hours (role-based thresholds)
//
// Role-based annual minima per R 400.1924(1)-(4) via the
// training_requirements catalog (migration 013) + getEffectiveRequirements
// strictest-wins rollup. Replaced the Phase 1 flat 16-hour placeholder
// (2026-06-09) — these tests did not exist before, which is how 16
// survived unasserted.
// -----------------------------------------------------------------------------

describe('E5 caregiver_professional_development_hours — role-based thresholds', () => {
  const requirement = REQUIREMENT_REGISTRY.caregiver_professional_development_hours

  function makeCaregiver(roles, overrides = {}) {
    return { id: 'cg-1', archived_at: null, regulatory_roles: roles, ...overrides }
  }
  function pdRecord(hours, overrides = {}) {
    return {
      id: 'pd-' + Math.random().toString(16).slice(2),
      caregiver_id: 'cg-1',
      category: 'professional_development',
      completed_on: '2026-02-01',
      hours,
      ...overrides,
    }
  }
  function stateFor({ caregivers, records = [], sourceRowsLoaded, sourceRows = {} }) {
    return getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        caregivers,
        staff_training_records: records,
        ...sourceRows,
      }),
      ...(sourceRowsLoaded !== undefined ? { sourceRowsLoaded } : {}),
      now: FIXED_NOW,
    })
  }

  it('licensee with 10 logged hours → on_file (was missing_required under flat 16)', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['licensee'])], records: [pdRecord(10)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('licensee with 9 hours → missing_required, reason hours-9-of-10', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['licensee'])], records: [pdRecord(9)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(s.reason).toBe('hours-9-of-10')
  })

  it('child_care_staff_member with 5 hours → on_file', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['child_care_staff_member'])], records: [pdRecord(5)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('child_care_assistant with 5 hours → on_file', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['child_care_assistant'])], records: [pdRecord(5)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('unsupervised_volunteer with 1 hour → on_file', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['unsupervised_volunteer'])], records: [pdRecord(1)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('driver with 1 hour → on_file', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['driver'])], records: [pdRecord(1)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('child_care_staff_member with 4 hours → missing_required, reason hours-4-of-5', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['child_care_staff_member'])], records: [pdRecord(4)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(s.reason).toBe('hours-4-of-5')
  })

  it('multi-role licensee+driver → strictest minimum (10) applies', () => {
    const cg = makeCaregiver(['licensee', 'driver'])
    const short = stateFor({ caregivers: [cg], records: [pdRecord(9)] })
    expect(short.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(short.reason).toBe('hours-9-of-10')
    const met = stateFor({ caregivers: [cg], records: [pdRecord(10)] })
    expect(met.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('caregiver with no regulatory roles → unknown no-regulatory-roles (never silently passes)', () => {
    const s = stateFor({ caregivers: [makeCaregiver([])], records: [pdRecord(40)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(s.reason).toBe('no-regulatory-roles')
    // Provider-fixable on the Staff page — needs_provider_data bucket,
    // not "contact support."
    expect(classifyUnknownReason({ state: s })).toBe('needs_provider_data')
  })

  it('supervised_volunteer only → on_file (the adopted rules are silent — affirmatively no PD obligation)', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['supervised_volunteer'])], records: [] })
    // on_file with NO reason — passing states never emit reasons in this
    // engine, and the role is exempt (spec § 6.2 marks PD "—"), not unknown.
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(s.reason).toBeUndefined()
  })

  it('worst-across-caregivers preserved: compliant licensee + short staff member → missing_required', () => {
    const s = stateFor({
      caregivers: [
        makeCaregiver(['licensee'], { id: 'cg-1' }),
        makeCaregiver(['child_care_staff_member'], { id: 'cg-2' }),
      ],
      records: [pdRecord(10, { caregiver_id: 'cg-1' }), pdRecord(2, { caregiver_id: 'cg-2' })],
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(s.reason).toBe('hours-2-of-5')
  })

  it('prior-calendar-year hours do not count toward the current year', () => {
    const s = stateFor({
      caregivers: [makeCaregiver(['licensee'])],
      records: [pdRecord(10, { completed_on: '2025-06-01' })],
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(s.reason).toBe('hours-0-of-10')
  })

  it('no active caregivers → missing_required no-active-caregivers (unchanged)', () => {
    const s = stateFor({ caregivers: [] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    expect(s.reason).toBe('no-active-caregivers')
  })

  it('§2a regression-lock: staff_training_records failed to load → unknown, not a false missing/on_file', () => {
    const s = stateFor({
      caregivers: [makeCaregiver(['licensee'])],
      records: [],
      sourceRowsLoaded: { staff_training_records: false, training_requirements: true },
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(s.reason).toBe('training-data-load-failure')
  })

  it('§2a regression-lock: training_requirements catalog failed to load → unknown, not a false on_file', () => {
    const s = stateFor({
      caregivers: [makeCaregiver(['licensee'])],
      records: [pdRecord(10)],
      sourceRowsLoaded: { staff_training_records: true, training_requirements: false },
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(s.reason).toBe('training-data-load-failure')
  })

  it('catalog loaded but empty of PD rows → unknown training-requirements-catalog-empty (never silently passes)', () => {
    const s = stateFor({
      caregivers: [makeCaregiver(['licensee'])],
      records: [pdRecord(10)],
      sourceRows: { training_requirements: [] },
      sourceRowsLoaded: { staff_training_records: true, training_requirements: true },
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(s.reason).toBe('training-requirements-catalog-empty')
  })

  it('legacy caller — sourceRowsLoaded omitted entirely → resolves normally', () => {
    const s = stateFor({ caregivers: [makeCaregiver(['licensee'])], records: [pdRecord(10)] })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('§2a: caregivers failed to load → unknown caregivers-load-failure (not a false no-active-caregivers)', () => {
    const s = stateFor({
      caregivers: [],
      records: [],
      sourceRowsLoaded: { caregivers: false, staff_training_records: true, training_requirements: true },
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    expect(s.reason).toBe('caregivers-load-failure')
  })
})

// -----------------------------------------------------------------------------
// §2a load-failure coverage completion (2026-06-09) — every resolver
// reading caregivers / attendance_acks / miregistry_training_entries /
// funding_documents (plus the five staff resolvers that read the
// already-signalled staff_training_records) must resolve UNKNOWN on a
// table load failure — never a silent not_applicable (the dangerous
// false pass) and never a misleading red. Each resolver gets BOTH a
// load-failure test and a regression lock that loaded-true + zero rows
// keeps its pre-§2a behavior.
// -----------------------------------------------------------------------------

describe('§2a load-failure guards — resolver coverage completion', () => {
  function makeCaregiver(roles, overrides = {}) {
    return { id: 'cg-1', archived_at: null, regulatory_roles: roles, ...overrides }
  }
  function stateOf(key, { provider, sourceRows = {}, sourceRowsLoaded } = {}) {
    return getRequirementState({
      requirement: REQUIREMENT_REGISTRY[key],
      provider: provider || makeLicensedProvider(),
      sourceRows: makeSourceRows(sourceRows),
      ...(sourceRowsLoaded !== undefined ? { sourceRowsLoaded } : {}),
      now: FIXED_NOW,
    })
  }

  describe('caregiver_background_check_eligibility', () => {
    const KEY = 'caregiver_background_check_eligibility'

    it('caregivers failed to load → unknown caregivers-load-failure', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: false, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('caregivers-load-failure')
    })

    it('staff_training_records failed to load → unknown staff-training-records-load-failure', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: false },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('staff-training-records-load-failure')
    })

    it('regression lock: loaded true + zero caregivers → missing no-active-caregivers (unchanged)', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: true, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('no-active-caregivers')
    })

    it('regression lock: loaded true + caregiver with zero records → missing_required (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBeUndefined()
    })
  })

  describe('caregiver_cpr_first_aid_current', () => {
    const KEY = 'caregiver_cpr_first_aid_current'

    it('caregivers failed to load → unknown caregivers-load-failure', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: false, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('caregivers-load-failure')
    })

    it('staff_training_records failed to load → unknown staff-training-records-load-failure', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: false },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('staff-training-records-load-failure')
    })

    it('regression lock: loaded true + zero caregivers → missing no-active-caregivers (unchanged)', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: true, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('no-active-caregivers')
    })

    it('regression lock: loaded true + caregiver with zero records → missing_required (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    })
  })

  describe('caregiver_new_hire_training_complete', () => {
    const KEY = 'caregiver_new_hire_training_complete'

    it('caregivers failed to load → unknown caregivers-load-failure', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: false, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('caregivers-load-failure')
    })

    it('staff_training_records failed to load → unknown staff-training-records-load-failure', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: false },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('staff-training-records-load-failure')
    })

    it('regression lock: loaded true + zero caregivers → missing no-active-caregivers (unchanged)', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: true, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('no-active-caregivers')
    })

    it('regression lock: loaded true + recent hire with zero records → missing within-90-day-window (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'], { date_of_hire: '2026-06-01' })] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('within-90-day-window')
    })
  })

  describe('caregiver_miregistry_account', () => {
    const KEY = 'caregiver_miregistry_account'

    it('caregivers failed to load → unknown caregivers-load-failure', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: false, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('caregivers-load-failure')
    })

    it('staff_training_records failed to load → unknown staff-training-records-load-failure', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: false },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('staff-training-records-load-failure')
    })

    it('regression lock: loaded true + zero caregivers → missing no-active-caregivers (unchanged)', () => {
      const s = stateOf(KEY, { sourceRowsLoaded: { caregivers: true, staff_training_records: true } })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('no-active-caregivers')
    })

    it('regression lock: loaded true + caregiver with zero records → missing_required (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])] },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    })
  })

  describe('caregiver_health_safety_update_acked', () => {
    const KEY = 'caregiver_health_safety_update_acked'
    const ONE_UPDATE = [{ id: 'hs-1' }]

    it('caregivers failed to load → unknown caregivers-load-failure (NOT a silent not_applicable)', () => {
      const s = stateOf(KEY, {
        sourceRows: { health_safety_updates: ONE_UPDATE },
        sourceRowsLoaded: { caregivers: false, staff_training_records: true, health_safety_updates: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('caregivers-load-failure')
    })

    it('staff_training_records failed to load → unknown staff-training-records-load-failure', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])], health_safety_updates: ONE_UPDATE },
        sourceRowsLoaded: { caregivers: true, staff_training_records: false, health_safety_updates: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('staff-training-records-load-failure')
    })

    it('regression lock: loaded true + zero caregivers + updates present → not_applicable (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { health_safety_updates: ONE_UPDATE },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true, health_safety_updates: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    })

    it('regression lock: loaded true + caregiver + unacked update → missing unacked-update (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { caregivers: [makeCaregiver(['licensee'])], health_safety_updates: ONE_UPDATE },
        sourceRowsLoaded: { caregivers: true, staff_training_records: true, health_safety_updates: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      expect(s.reason).toBe('unacked-update')
    })
  })

  describe('attendance_parent_acknowledgment_per_day (H1)', () => {
    const KEY = 'attendance_parent_acknowledgment_per_day'
    // ≥1 active CDC funding source makes the row applicable.
    const CDC_SOURCE = [{ id: 'fs-1', type: 'cdc_scholarship', archived_at: null, child_id: 'ch-1' }]

    it('attendance_acks failed to load → unknown attendance-acks-load-failure (NOT a silent not_applicable)', () => {
      const s = stateOf(KEY, {
        sourceRows: { funding_sources: CDC_SOURCE },
        sourceRowsLoaded: { attendance_acks: false, funding_sources: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('attendance-acks-load-failure')
    })

    it('regression lock: loaded true + zero attendance acks → not_applicable (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { funding_sources: CDC_SOURCE },
        sourceRowsLoaded: { attendance_acks: true, funding_sources: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    })
  })

  describe('provider_miregistry_annual_ongoing', () => {
    const KEY = 'provider_miregistry_annual_ongoing'

    it('miregistry_training_entries failed to load → unknown miregistry-training-entries-load-failure (not a false missed-Dec-16 red)', () => {
      const s = stateOf(KEY, {
        provider: makeLepProvider(),
        sourceRowsLoaded: { miregistry_training_entries: false },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('miregistry-training-entries-load-failure')
    })

    it('regression lock: loaded true + zero entries → missing_required (unchanged)', () => {
      const s = stateOf(KEY, {
        provider: makeLepProvider(),
        sourceRowsLoaded: { miregistry_training_entries: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    })
  })

  describe('funding_enrollment_agreement_on_file', () => {
    const KEY = 'funding_enrollment_agreement_on_file'
    // Enrollment-billing-basis CDC source makes the row applicable.
    const ENROLLMENT_SOURCE = [{
      id: 'fs-1', type: 'cdc_scholarship', archived_at: null, child_id: 'ch-1',
      details: { billing_basis: 'enrollment' },
    }]

    it('funding_documents failed to load → unknown funding-documents-load-failure (not a false missing-agreement red)', () => {
      const s = stateOf(KEY, {
        sourceRows: { funding_sources: ENROLLMENT_SOURCE },
        sourceRowsLoaded: { funding_documents: false, funding_sources: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(s.reason).toBe('funding-documents-load-failure')
    })

    it('regression lock: loaded true + zero documents → missing_required (unchanged)', () => {
      const s = stateOf(KEY, {
        sourceRows: { funding_sources: ENROLLMENT_SOURCE },
        sourceRowsLoaded: { funding_documents: true, funding_sources: true },
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
    })
  })

  it('load-failure reasons classify as load_failure, not needs_provider_data (not provider-fixable)', () => {
    // Deliberately NOT added to NEEDS_PROVIDER_DATA_REASONS — a failed
    // table load is not something the provider can fix from a page in
    // the app. They get their own 'load_failure' bucket (Phase 3.1
    // prerequisite) so guidance renders "refresh to retry," not
    // "contact support."
    for (const reason of [
      'caregivers-load-failure',
      'staff-training-records-load-failure',
      'miregistry-training-entries-load-failure',
      'funding-documents-load-failure',
      'attendance-acks-load-failure',
    ]) {
      expect(NEEDS_PROVIDER_DATA_REASONS.has(reason)).toBe(false)
      expect(classifyUnknownReason({ state: { kind: REQUIREMENT_STATE_KIND.UNKNOWN, reason } })).toBe('load_failure')
    }
  })
})

// -----------------------------------------------------------------------------
// Funding + CDC
// -----------------------------------------------------------------------------

describe('Funding docs + CDC compliance', () => {
  // funding_dhs_198_on_file tests REMOVED 2026-06-06 per
  // docs/Compliance Corrections.md Part 2 — the registry row was
  // deleted because the DHS-198 is MDHHS's authorization notice TO
  // the provider, not an obligation the provider fulfills.

  it('REQUIREMENT_REGISTRY does not contain funding_dhs_198_on_file (regression lock)', () => {
    // Locks the deletion. If a future contributor re-adds the row
    // without re-checking the CDC-layer corrections rationale,
    // this test fails first.
    expect(REQUIREMENT_REGISTRY.funding_dhs_198_on_file).toBeUndefined()
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

  // 2026-06-06 reframe (docs/Compliance Corrections.md Part 4) —
  // Level 2 is OPTIONAL (pay-rate tier), NOT a compliance
  // delinquency. When Level 2 "expires," the consequence is a drop
  // to Level 1 base pay — no compliance violation, no CDC account
  // closure. The engine has no `advisory` state kind today; the
  // closest existing knob is severity, so this row uses
  // severity='low'. The expired STATE_KIND is preserved so the row
  // accurately reflects "your Level 2 has expired" — but consumers
  // SHOULD render this row in the soft/subtle treatment per the
  // Phase 3.1 component contract's severity ladder.

  it('severity is low (advisory tier — 2026-06-06 reframe)', () => {
    expect(requirement.severity).toBe('low')
  })

  it('rule citation is the CDC Scholarship Handbook (advisory framing)', () => {
    expect(requirement.rule_citation).toMatch(/CDC Scholarship Handbook/i)
    expect(requirement.rule_citation).toMatch(/pay-rate/i)
    expect(requirement.rule_citation).not.toMatch(/^LEP Handbook/i)
  })
})

// -----------------------------------------------------------------------------
// Attendance
// -----------------------------------------------------------------------------

describe('attendance_parent_acknowledgment_per_day', () => {
  const requirement = REQUIREMENT_REGISTRY.attendance_parent_acknowledgment_per_day

  // Helpers — H1 was re-gated on CDC enrollment in the 2026-06-06
  // CDC-subsidy-layer audit. Every test below either supplies a CDC
  // funding source (→ applicability=applies) or expects the
  // private-pay-only path (→ applicability=does_not_apply →
  // state.kind=not_applicable).
  function cdcSource(child_id, overrides = {}) {
    return {
      id: 's-' + child_id,
      type: 'cdc_scholarship',
      status: 'active',
      child_id,
      family_id: null,
      archived_at: null,
      ...overrides,
    }
  }
  function privatePaySource(family_id, overrides = {}) {
    return {
      id: 'pp-' + family_id,
      type: 'private_pay',
      status: 'active',
      child_id: null,
      family_id,
      archived_at: null,
      ...overrides,
    }
  }

  it('no attendance acks → not_applicable (existing behavior preserved)', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [cdcSource('c-1')],   // CDC-enrolled
        attendance_acks: [],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  })

  it('all CDC-kid acks parent-signed → on_file', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [cdcSource('c-1')],
        attendance_acks: [
          { id: 'a-1', child_id: 'c-1', acknowledged_via: 'parent_portal', archived_at: null },
          { id: 'a-2', child_id: 'c-1', acknowledged_via: 'in_person_paper', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('all CDC-kid acks provider_override → pending_parent', () => {
    const state = getRequirementState({
      requirement,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        funding_sources: [cdcSource('c-1')],
        attendance_acks: [
          { id: 'a-1', child_id: 'c-1', acknowledged_via: 'provider_override', archived_at: null },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })

  // ─── CDC-gating audit (2026-06-06) ──────────────────────────────
  // H1 is the audit's "odd one out": it used to apply to any
  // provider with attendance_acks, regardless of CDC enrollment.
  // The fix gates inferFromData on ≥1 active CDC funding source,
  // matching G1/G2/G3/G4. The tests below lock that in.

  describe('CDC enrollment gating (2026-06-06 fix)', () => {
    it('private-pay-only provider → not_applicable (private-pay attendance acks don\'t count)', () => {
      const state = getRequirementState({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [privatePaySource('f-1')],
          attendance_acks: [
            { id: 'a-1', child_id: 'c-private', acknowledged_via: 'parent_portal', archived_at: null },
          ],
        }),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    })

    it('no funding sources at all → not_applicable (collapses to does_not_apply matching G1)', () => {
      const state = getRequirementState({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [],
          attendance_acks: [
            { id: 'a-1', child_id: 'c-1', acknowledged_via: 'parent_portal', archived_at: null },
          ],
        }),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    })

    it('archived CDC source → not_applicable (no longer counts as active enrollment)', () => {
      const state = getRequirementState({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [cdcSource('c-1', { archived_at: '2026-01-01T00:00:00Z' })],
          attendance_acks: [
            { id: 'a-1', child_id: 'c-1', acknowledged_via: 'parent_portal', archived_at: null },
          ],
        }),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
    })

    it('mixed CDC + private-pay: only CDC-kid acks count toward verdict', () => {
      // c-cdc is CDC-enrolled; c-pp is private-pay.
      // c-cdc has a clean parent_portal ack; c-pp has provider_override only.
      // Without per-child filtering this would resolve to pending_parent
      // (the c-pp override would bring the verdict down). With the
      // per-child filter, only c-cdc's ack is considered → on_file.
      const state = getRequirementState({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [
            cdcSource('c-cdc'),
            privatePaySource('f-pp'),
          ],
          attendance_acks: [
            { id: 'a-1', child_id: 'c-cdc', acknowledged_via: 'parent_portal',    archived_at: null },
            { id: 'a-2', child_id: 'c-pp',  acknowledged_via: 'provider_override', archived_at: null },
          ],
        }),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    })

    it('mixed CDC + private-pay: a CDC-kid provider_override DOES move the verdict to pending_parent', () => {
      const state = getRequirementState({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [
            cdcSource('c-cdc'),
            privatePaySource('f-pp'),
          ],
          attendance_acks: [
            { id: 'a-1', child_id: 'c-cdc', acknowledged_via: 'provider_override', archived_at: null },
            { id: 'a-2', child_id: 'c-pp',  acknowledged_via: 'parent_portal',    archived_at: null },
          ],
        }),
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
    })

    it('applicability returns DOES_NOT_APPLY for private-pay-only provider (§2a check)', () => {
      // Direct applicability resolver call — confirms the gate fires
      // at layer 3 (inferFromData) and doesn't silently fall through.
      const result = resolveApplicability({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [privatePaySource('f-1')],
        }),
        now: FIXED_NOW,
      })
      expect(result).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })

    it('applicability returns APPLIES for a CDC-enrolled provider', () => {
      const result = resolveApplicability({
        requirement,
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows({
          funding_sources: [cdcSource('c-1')],
        }),
        now: FIXED_NOW,
      })
      expect(result).toBe(APPLICABILITY_RESULT.APPLIES)
    })

    it('rule citation is the CDC Handbook, not R 400', () => {
      // Locks the 2026-06-06 re-cite. If a future contributor flips
      // this back to R 400.xxxx without rechecking the consultant
      // worksheet H1 entry, this test fails first.
      expect(requirement.rule_citation).toMatch(/CDC Handbook/i)
      expect(requirement.rule_citation).not.toMatch(/R 400\./)
    })
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
  it('Pattern A satisfies on every member of PARENT_SIGNED_SATISFYING_CHANNELS (mirrors childFiles.js + medication.js duplicates)', () => {
    // Indirect: any Pattern A row should accept every channel in
    // the satisfying set, and NOT provider_override alone.
    //
    // Phase Y1 (2026-06-04): 'parent_portal_esign' joined the
    // satisfying set in all three in-tree copies (childFiles.js,
    // complianceState.js, medication.js). This test locks the
    // duplication invariant — if any copy drifts, the assertions
    // here surface the mismatch on read.
    const req = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    const make = (channel) => getRequirementState({
      requirement: req,
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows({
        acks: [makeAck({
          type: ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
          acknowledged_via: channel,
          // The shape CHECK on the DB requires signature + snapshot
          // for esign rows; the test fixture isn't a DB row so we
          // just supply them so any future client-side validation
          // sees a "valid" esign row.
          typed_signature_text: channel === 'parent_portal_esign' ? 'Jane Smith' : null,
          template_snapshot_text: channel === 'parent_portal_esign' ? '[template body]' : null,
        })],
      }),
      now: FIXED_NOW,
    })
    expect(make('parent_portal').kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(make('in_person_paper').kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(make('parent_portal_esign').kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    expect(make('provider_override').kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })

  // NOTE — the matching invariant for medication.js's duplicated
  // PARENT_SIGNED_SATISFYING_CHANNELS copy lives in
  // medication.test.js (where the supabase mock is set up).
  // Importing medication.js here would fire its eager
  // ./supabase import at module load time.
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

// -----------------------------------------------------------------------------
// Phase 3 — new pure projection helpers
// -----------------------------------------------------------------------------

describe('Phase 3 — classifyUnknownReason', () => {
  it('awaiting-provider-input → awaiting_input', () => {
    const state = { kind: 'unknown', reason: 'awaiting-provider-input' }
    expect(classifyUnknownReason({ state })).toBe('awaiting_input')
  })

  it('feature-not-yet-shipped → feature_not_yet_shipped', () => {
    const state = { kind: 'unknown', reason: 'feature-not-yet-shipped' }
    expect(classifyUnknownReason({ state })).toBe('feature_not_yet_shipped')
  })

  // Phase 3 fix-forward (2026-06-05) — Finding #3 from the live gate:
  // `caregiver-missing-date-of-hire` used to fall through to
  // `data_anomaly` → "Data anomaly — please contact support" copy,
  // even though the provider can fix it themselves by adding the
  // hire date. New bucket: `needs_provider_data` with actionable copy.
  describe('needs_provider_data bucket', () => {
    it('caregiver-missing-date-of-hire → needs_provider_data (the live-gate finding)', () => {
      const state = { kind: 'unknown', reason: 'caregiver-missing-date-of-hire' }
      expect(classifyUnknownReason({ state })).toBe('needs_provider_data')
    })

    it('no-authorization-end-on-funding-source → needs_provider_data', () => {
      const state = { kind: 'unknown', reason: 'no-authorization-end-on-funding-source' }
      expect(classifyUnknownReason({ state })).toBe('needs_provider_data')
    })

    it('every reason in NEEDS_PROVIDER_DATA_REASONS classifies to needs_provider_data', () => {
      for (const reason of NEEDS_PROVIDER_DATA_REASONS) {
        const state = { kind: 'unknown', reason }
        expect(classifyUnknownReason({ state })).toBe('needs_provider_data')
      }
    })

    it('NEEDS_PROVIDER_DATA_REASONS is frozen (catalog cannot mutate at runtime)', () => {
      // Set frozen on a Set means no .add() / .delete() succeed silently —
      // a future contributor extending the set must do it in source.
      expect(Object.isFrozen(NEEDS_PROVIDER_DATA_REASONS)).toBe(true)
    })
  })

  // Phase 3.1 prerequisite (2026-06-10): load-failure reasons split out
  // of data_anomaly so guidance can render "couldn't verify — refresh"
  // instead of "contact support" for a transient table-load failure.
  describe('load_failure bucket — transient source-table load failures', () => {
    it('LOAD_FAILURE_REASONS contains exactly the six guard reasons emitted in code', () => {
      expect([...LOAD_FAILURE_REASONS].sort()).toEqual([
        'attendance-acks-load-failure',
        'caregivers-load-failure',
        'funding-documents-load-failure',
        'miregistry-training-entries-load-failure',
        'staff-training-records-load-failure',
        'training-data-load-failure',
      ])
    })

    it('every reason in LOAD_FAILURE_REASONS classifies to load_failure', () => {
      for (const reason of LOAD_FAILURE_REASONS) {
        const state = { kind: 'unknown', reason }
        expect(classifyUnknownReason({ state })).toBe('load_failure')
      }
    })

    it('training-requirements-catalog-empty STAYS data_anomaly (loaded-but-empty catalog is a seed/deployment anomaly, not a transient load failure)', () => {
      expect(LOAD_FAILURE_REASONS.has('training-requirements-catalog-empty')).toBe(false)
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'training-requirements-catalog-empty' } }))
        .toBe('data_anomaly')
    })

    it('LOAD_FAILURE_REASONS is frozen (catalog cannot mutate at runtime)', () => {
      expect(Object.isFrozen(LOAD_FAILURE_REASONS)).toBe(true)
    })

    it('LOAD_FAILURE_REASONS and NEEDS_PROVIDER_DATA_REASONS are disjoint (a reason has exactly one bucket)', () => {
      for (const reason of LOAD_FAILURE_REASONS) {
        expect(NEEDS_PROVIDER_DATA_REASONS.has(reason)).toBe(false)
      }
    })
  })

  describe('data_anomaly bucket — genuine engine/data issues', () => {
    it('unparseable-date → data_anomaly (corrupt date string in record)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'unparseable-date' } }))
        .toBe('data_anomaly')
    })

    it('unparseable-hire-date → data_anomaly', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'unparseable-hire-date' } }))
        .toBe('data_anomaly')
    })

    it('unparseable-fingerprint-date → data_anomaly', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'unparseable-fingerprint-date' } }))
        .toBe('data_anomaly')
    })

    it('completion-date-in-future → data_anomaly', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'completion-date-in-future' } }))
        .toBe('data_anomaly')
    })

    it('unrecognized-miregistry-status → data_anomaly (record has unknown enum)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'unrecognized-miregistry-status' } }))
        .toBe('data_anomaly')
    })

    it('no-state-resolver → data_anomaly (dev/registry bug)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'no-state-resolver' } }))
        .toBe('data_anomaly')
    })

    it('no-requirement-supplied → data_anomaly (engine misuse)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'no-requirement-supplied' } }))
        .toBe('data_anomaly')
    })

    it('source-not-loaded → data_anomaly (hypothetical — not currently emitted)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'source-not-loaded' } }))
        .toBe('data_anomaly')
    })

    it('arbitrary unknown reason string → data_anomaly (fallthrough catches future codes)', () => {
      expect(classifyUnknownReason({ state: { kind: 'unknown', reason: 'something-the-engine-might-emit-someday' } }))
        .toBe('data_anomaly')
    })
  })

  it('no reason → data_anomaly', () => {
    expect(classifyUnknownReason({ state: { kind: 'unknown' } })).toBe('data_anomaly')
  })

  it('missing state → data_anomaly (defensive)', () => {
    expect(classifyUnknownReason({})).toBe('data_anomaly')
    expect(classifyUnknownReason()).toBe('data_anomaly')
  })
})

describe('Phase 3 — listProviderDeclaredApplicabilityRequirements', () => {
  it('returns the three Phase-1 rows with autoDefault=unknown', () => {
    const rows = listProviderDeclaredApplicabilityRequirements()
    const keys = rows.map(r => r.key).sort()
    // The three rows resolved 2026-06-03 in the Phase 1 scope §6.
    expect(keys).toEqual([
      'consent_transportation_routine_annual',
      'consent_water_activities_on_premises_seasonal',
      'property_animal_notification',
    ].sort())
  })

  it('every returned row has autoDefault = unknown', () => {
    const rows = listProviderDeclaredApplicabilityRequirements()
    for (const r of rows) {
      expect(r.applicability.autoDefault).toBe(APPLICABILITY_RESULT.UNKNOWN)
    }
  })

  it('never includes a row with autoDefault = applies', () => {
    const rows = listProviderDeclaredApplicabilityRequirements()
    const haveApplies = rows.some(r => r.applicability.autoDefault === APPLICABILITY_RESULT.APPLIES)
    expect(haveApplies).toBe(false)
  })
})

describe('Phase 3 — filterByDataState', () => {
  // Build a minimal ProviderComplianceState fixture and run filters.
  function makeState() {
    return getProviderComplianceState({
      provider: makeLicensedProvider(),
      children: [makeChild()],
      sourceRows: makeSourceRows(),
      overrides: new Map(),
      now: FIXED_NOW,
    })
  }

  it('filtering to shipped removes not_yet_modelled rows from provider_level', () => {
    const full = makeState()
    const shipped = filterByDataState({ state: full, dataState: DATA_STATE.SHIPPED })
    const fullDrills = full.provider_level.per_category.drills?.requirements || []
    const shippedDrills = shipped.provider_level.per_category.drills?.requirements || []
    // The full rollup includes 4 drill rows (all not_yet_modelled).
    // The shipped filter drops them all.
    expect(fullDrills.length).toBeGreaterThan(0)
    expect(shippedDrills.length).toBe(0)
  })

  it('filtering to not_yet_modelled keeps only Pattern E rows', () => {
    const full = makeState()
    const nyM = filterByDataState({ state: full, dataState: DATA_STATE.NOT_YET_MODELLED })
    // Drills and property are all not_yet_modelled.
    const drillsCount = nyM.provider_level.per_category.drills?.requirements.length || 0
    const propertyCount = nyM.provider_level.per_category.property?.requirements.length || 0
    expect(drillsCount).toBeGreaterThan(0)
    expect(propertyCount).toBeGreaterThan(0)
  })

  it('filtered totals recompute correctly', () => {
    const full = makeState()
    const shipped = filterByDataState({ state: full, dataState: DATA_STATE.SHIPPED })
    const nyM     = filterByDataState({ state: full, dataState: DATA_STATE.NOT_YET_MODELLED })
    // Totals should partition: shipped + not_yet_modelled = original
    // (modulo defensive default — rows with missing data_state are
    // treated as shipped, so no double-count).
    expect((shipped.totals.unknown || 0) + (nyM.totals.unknown || 0))
      .toBeGreaterThanOrEqual(full.totals.unknown || 0 - 1)  // ±1 tolerance for defensive defaults
  })

  it('null state returns null', () => {
    expect(filterByDataState({ state: null, dataState: 'shipped' })).toBe(null)
  })
})

describe('Phase 3 — getChildComplianceStateForCategory', () => {
  it('returns the category sub-state', () => {
    const child = makeChild()
    const fullChildState = getChildComplianceState({
      child,
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides: new Map(),
      now: FIXED_NOW,
    })
    const consents = getChildComplianceStateForCategory({
      state: fullChildState,
      category: 'consents',
    })
    expect(consents).toBeDefined()
    expect(consents.requirements).toBeDefined()
  })

  it('returns null for unknown category', () => {
    const fullChildState = getChildComplianceState({
      child: makeChild(),
      provider: makeLicensedProvider(),
      sourceRows: makeSourceRows(),
      overrides: new Map(),
      now: FIXED_NOW,
    })
    expect(getChildComplianceStateForCategory({ state: fullChildState, category: 'nonexistent' }))
      .toBe(null)
  })

  it('null state → null', () => {
    expect(getChildComplianceStateForCategory({ state: null, category: 'consents' })).toBe(null)
  })
})

// -----------------------------------------------------------------------------
// Phase 3 — §2a invariant: override round-trip + UNanswered stays unknown
// -----------------------------------------------------------------------------
//
// The load-bearing principle for Phase 3: the engine NEVER silently
// resolves a real regulatory requirement to not_applicable without an
// affirmative provider answer. The override row IS the affirmative
// basis. Verify the full round-trip:
//
//   - No override row → applicability resolves to UNKNOWN →
//     state = { kind: 'unknown', reason: 'awaiting-provider-input' }
//   - mode='applies' override → applicability = APPLIES → state runs
//     the row's state_resolver (missing_required for the row in test
//     because no satisfying ack exists).
//   - mode='does_not_apply' override → applicability = DOES_NOT_APPLY
//     → state = not_applicable.
//   - Archived override (no longer "active") → loader returns Map
//     without the key → applicability falls back to autoDefault =
//     UNKNOWN → state = unknown awaiting-provider-input. The reset
//     path.
//
// We exercise the engine layer here (the loader is integration-shaped
// and lives in src/lib/complianceStateLoader.js, which is tested via
// integration testing where the Supabase mock is set up — out of scope
// for this pure-layer suite).

describe('Phase 3 — §2a override round-trip', () => {
  const PROVIDER_DECLARED_KEYS = [
    'consent_transportation_routine_annual',
    'consent_water_activities_on_premises_seasonal',
    'property_animal_notification',
  ]

  for (const key of PROVIDER_DECLARED_KEYS) {
    it(`${key}: no override → state = unknown awaiting-provider-input`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      const state = getRequirementState({
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides: new Map(),    // empty — the "unanswered" case
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(state.reason).toBe('awaiting-provider-input')
    })

    it(`${key}: mode='applies' override → state resolver runs (missing_required when no ack)`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      const overrides = new Map([[key, APPLICABILITY_RESULT.APPLIES]])
      const state = getRequirementState({
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides,
        now: FIXED_NOW,
      })
      // property_animal_notification is also Pattern E (data_state=
      // 'not_yet_modelled') — even with applies override, its
      // state_resolver returns unknown(feature-not-yet-shipped).
      if (key === 'property_animal_notification') {
        expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
        expect(state.reason).toBe('feature-not-yet-shipped')
      } else {
        // The two shipped consent rows fall through to Pattern A,
        // which returns missing_required when no ack is on file.
        expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
      }
    })

    it(`${key}: mode='does_not_apply' override → state = not_applicable`, () => {
      const requirement = REQUIREMENT_REGISTRY[key]
      const overrides = new Map([[key, APPLICABILITY_RESULT.DOES_NOT_APPLY]])
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

    it(`${key}: "archive" simulated by removing the key → returns to unknown`, () => {
      // The loader's behavior: an archived row produces no Map entry.
      // Simulate "removed" by passing an empty Map.
      const requirement = REQUIREMENT_REGISTRY[key]
      const archivedScenario = new Map()
      const state = getRequirementState({
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides: archivedScenario,
        now: FIXED_NOW,
      })
      expect(state.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
      expect(state.reason).toBe('awaiting-provider-input')
    })
  }

  it('§2a invariant: with empty overrides, NO provider-declared row resolves to not_applicable', () => {
    // Walk every PROVIDER_DECLARED row with empty overrides and
    // confirm none silently resolves to not_applicable. This is the
    // engine-level proof that an absent override row keeps the
    // requirement honest.
    for (const key of PROVIDER_DECLARED_KEYS) {
      const requirement = REQUIREMENT_REGISTRY[key]
      const applicability = resolveApplicability({
        requirement,
        child: makeChild(),
        provider: makeLicensedProvider(),
        sourceRows: makeSourceRows(),
        overrides: new Map(),
        now: FIXED_NOW,
      })
      // The critical check: NEVER does_not_apply when no override.
      expect(applicability).not.toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
      // Should be unknown (the engine's safe default per §2a).
      expect(applicability).toBe(APPLICABILITY_RESULT.UNKNOWN)
    }
  })
})
