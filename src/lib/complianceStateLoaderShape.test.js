// §2a loader-shape change (2026-06-09) — tests for the 13 rows
// whose applicability inferFromData silently collapsed an empty
// gating-table result set to DOES_NOT_APPLY. With the new
// `sourceRowsLoaded` sibling signal threaded through the engine,
// each row's applicability must now resolve to UNKNOWN when its
// gating table failed to load — and unchanged otherwise.
//
// (Prompt enumerated "12 rows" but the actual list is 13:
//  CDC 4 + Medication 6 + Consents 2 + Staff 1.)
//
// Per docs/pr-compliance-loader-shape-scope.md §2.4 each row gets a
// three-way trio:
//   - loaded + populated → APPLIES (the existing happy path)
//   - loaded + empty     → DOES_NOT_APPLY (the legitimate negative)
//   - not loaded         → UNKNOWN (the §2a fix)
//
// D4 + D6 read TWO precondition tables; each gets an additional
// one-table-failed → UNKNOWN test.
//
// Plus:
//   - Backward-compat assertion against a representative non-opted-in
//     row whose `[]` currently produces `missing_required`, NOT
//     `not_applicable` (the audit's "fuzzier-not-violating" class).
//   - Loader-level test (mocking the supabase client) that the
//     sourceRowsLoaded signal is `true` for empty-success and
//     `false` for PostgREST error / thrown exception.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  REQUIREMENT_REGISTRY,
  REQUIREMENT_STATE_KIND,
  APPLICABILITY_RESULT,
  resolveApplicability,
  getRequirementState,
} from './complianceState'
import { ACK_TYPES } from './acknowledgments'

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z')

function makeLicensedProvider(overrides = {}) {
  return {
    id: 'prov-1',
    license_type: 'family_home',
    home_built_before_1978: false,
    firearms_on_premises: false,
    is_license_exempt: false,
    miregistry_current_level: null,
    miregistry_level_2_expires_on: null,
    fingerprint_date: '2025-01-01',
    ...overrides,
  }
}

function makeChild(overrides = {}) {
  return {
    id: 'child-1',
    family_id: 'family-1',
    date_of_birth: '2020-01-15',
    intake_completed_at: null,
    records_last_reviewed_on: null,
    immunization_status: null,
    food_provider: null,
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
    training_requirements: [],
    health_safety_updates: [],
    funding_sources: [],
    funding_documents: [],
    miregistry_training_entries: [],
    attendance_acks: [],
    // 2026-06-14 batch (mig 039) — property J1/J2/J8 resolvers read this.
    compliance_documents: [],
    drill_logs: null,
    property_records: null,
    ...overrides,
  }
}

// All-loaded = the post-fix default the loader will actually emit
// for a clean load.
const ALL_LOADED = Object.freeze({
  acks:                        true,
  medication_authorizations:   true,
  medication_admin_events:     true,
  caregivers:                  true,
  health_safety_updates:       true,
  funding_sources:             true,
  funding_documents:           true,
  staff_training_records:      true,
  training_requirements:       true,
  miregistry_training_entries: true,
  attendance_acks:             true,
  // 2026-06-14 batch (mig 039) — J1/J2/J8 property resolvers opt in.
  compliance_documents:        true,
})

// Build a sourceRowsLoaded with one or more tables forced false.
function loadedExcept(...failedTables) {
  const o = { ...ALL_LOADED }
  for (const t of failedTables) o[t] = false
  return o
}

function applicabilityOf(key, opts) {
  const req = REQUIREMENT_REGISTRY[key]
  expect(req, `registry should contain ${key}`).toBeDefined()
  return resolveApplicability({ requirement: req, now: FIXED_NOW, ...opts })
}

function stateOf(key, opts) {
  const req = REQUIREMENT_REGISTRY[key]
  return getRequirementState({ requirement: req, now: FIXED_NOW, ...opts })
}

// -----------------------------------------------------------------------------
// CDC group (4) — funding_sources
// -----------------------------------------------------------------------------

describe('§2a loader-shape — CDC group on funding_sources', () => {
  const provider = makeLicensedProvider()

  // G2 — funding_enrollment_agreement_on_file
  describe('G2 funding_enrollment_agreement_on_file', () => {
    const cdcEnrollment = {
      id: 'fs-1',
      type: 'cdc_scholarship',
      archived_at: null,
      details: { billing_basis: 'enrollment' },
    }
    it('loaded + CDC enrollment source present → APPLIES', () => {
      const sourceRows = makeSourceRows({ funding_sources: [cdcEnrollment] })
      expect(applicabilityOf('funding_enrollment_agreement_on_file', {
        provider, sourceRows, sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY (legitimate negative preserved)', () => {
      expect(applicabilityOf('funding_enrollment_agreement_on_file', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN (the §2a fix)', () => {
      expect(applicabilityOf('funding_enrollment_agreement_on_file', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('funding_sources'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
    it('not loaded → REQUIREMENT_STATE_KIND.UNKNOWN at the state layer', () => {
      const s = stateOf('funding_enrollment_agreement_on_file', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('funding_sources'),
      })
      expect(s.kind).toBe(REQUIREMENT_STATE_KIND.UNKNOWN)
    })
  })

  // G3 — cdc_authorization_currency
  describe('G3 cdc_authorization_currency', () => {
    const cdc = { id: 'fs-2', type: 'cdc_scholarship', archived_at: null, authorization_end: '2026-12-01' }
    it('loaded + CDC source present → APPLIES', () => {
      expect(applicabilityOf('cdc_authorization_currency', {
        provider, sourceRows: makeSourceRows({ funding_sources: [cdc] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('cdc_authorization_currency', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('cdc_authorization_currency', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('funding_sources'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // G4 — cdc_fingerprint_reprint_currency. Has a license-status pre-gate
  // that returns UNKNOWN if license_type AND is_license_exempt are both
  // unanswered. With license answered (the licensed-provider fixture),
  // the funding_sources branch is the next gate.
  describe('G4 cdc_fingerprint_reprint_currency', () => {
    const cdc = { id: 'fs-3', type: 'cdc_scholarship', archived_at: null }
    it('loaded + CDC source present → APPLIES (license answered)', () => {
      expect(applicabilityOf('cdc_fingerprint_reprint_currency', {
        provider, sourceRows: makeSourceRows({ funding_sources: [cdc] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY (license answered, no CDC)', () => {
      expect(applicabilityOf('cdc_fingerprint_reprint_currency', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('cdc_fingerprint_reprint_currency', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('funding_sources'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
    it('pre-existing license-status pre-gate still wins on unanswered license', () => {
      const unanswered = { id: 'prov-2', license_type: null, is_license_exempt: null }
      // Even with funding_sources loaded, an unanswered license stays UNKNOWN.
      expect(applicabilityOf('cdc_fingerprint_reprint_currency', {
        provider: unanswered, sourceRows: makeSourceRows({ funding_sources: [cdc] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // H1 — attendance_parent_acknowledgment_per_day
  describe('H1 attendance_parent_acknowledgment_per_day', () => {
    const cdc = { id: 'fs-4', type: 'cdc_scholarship', archived_at: null, child_id: 'child-1' }
    it('loaded + CDC source present → APPLIES', () => {
      expect(applicabilityOf('attendance_parent_acknowledgment_per_day', {
        provider, sourceRows: makeSourceRows({ funding_sources: [cdc] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('attendance_parent_acknowledgment_per_day', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('attendance_parent_acknowledgment_per_day', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('funding_sources'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })
})

// -----------------------------------------------------------------------------
// Medication group (6) — medication_authorizations + medication_admin_events
// -----------------------------------------------------------------------------

describe('§2a loader-shape — medication group', () => {
  const provider = makeLicensedProvider()
  const child = makeChild()

  const auth = {
    id: 'auth-1',
    child_id: 'child-1',
    is_topical_otc: false,
    archived_at: null,
    original_container_confirmed: true,
  }
  const otcAuth = { ...auth, id: 'auth-otc', is_topical_otc: true }
  const event = {
    id: 'ev-1',
    authorization_id: 'auth-1',
    administered_by_caregiver_id: 'cg-1',
    archived_at: null,
  }

  // D1 — medication_authorization_for_authorization
  describe('D1 medication_authorization_for_authorization', () => {
    it('loaded + auth present → APPLIES', () => {
      expect(applicabilityOf('medication_authorization_for_authorization', {
        provider, child, sourceRows: makeSourceRows({ medication_authorizations: [auth] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('medication_authorization_for_authorization', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('medication_authorization_for_authorization', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_authorizations'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // D2 — medication_permission_per_authorization
  describe('D2 medication_permission_per_authorization', () => {
    it('loaded + non-OTC auth → APPLIES', () => {
      expect(applicabilityOf('medication_permission_per_authorization', {
        provider, child, sourceRows: makeSourceRows({ medication_authorizations: [auth] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('medication_permission_per_authorization', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('medication_permission_per_authorization', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_authorizations'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // D3 — medication_permission_otc_blanket (child-scoped)
  describe('D3 medication_permission_otc_blanket', () => {
    it('loaded + OTC auth for child → APPLIES', () => {
      expect(applicabilityOf('medication_permission_otc_blanket', {
        provider, child, sourceRows: makeSourceRows({ medication_authorizations: [otcAuth] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('medication_permission_otc_blanket', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('medication_permission_otc_blanket', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_authorizations'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // D4 (medication_role_gate_integrity) retired 2026-06-10 — its
  // two-table §2a gate left with it. D6 below pins the same
  // two-table-precondition pattern.

  // D5 — medication_original_container_attestation
  describe('D5 medication_original_container_attestation', () => {
    it('loaded + non-OTC auth → APPLIES', () => {
      expect(applicabilityOf('medication_original_container_attestation', {
        provider, sourceRows: makeSourceRows({ medication_authorizations: [auth] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('medication_original_container_attestation', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('medication_original_container_attestation', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_authorizations'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  // D6 — medication_dose_log_retention (TWO precondition tables)
  describe('D6 medication_dose_log_retention (two-table gate)', () => {
    it('loaded + non-OTC event → APPLIES', () => {
      expect(applicabilityOf('medication_dose_log_retention', {
        provider, sourceRows: makeSourceRows({
          medication_authorizations: [auth],
          medication_admin_events: [event],
        }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('medication_dose_log_retention', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('events table failed → UNKNOWN', () => {
      expect(applicabilityOf('medication_dose_log_retention', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_admin_events'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
    it('auths table failed → UNKNOWN', () => {
      expect(applicabilityOf('medication_dose_log_retention', {
        provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('medication_authorizations'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })
})

// -----------------------------------------------------------------------------
// Consents group (2) — acks
// -----------------------------------------------------------------------------

describe('§2a loader-shape — consents per-trip recency', () => {
  const provider = makeLicensedProvider()
  const child = makeChild()

  function ackForChild(type, daysAgo = 30) {
    return {
      id: 'a-' + type,
      type,
      subject_type: 'child',
      subject_id: 'child-1',
      acknowledged_via: 'in_person_paper',
      acknowledged_at: new Date(FIXED_NOW.getTime() - daysAgo * 86400000).toISOString(),
      expires_at: null,
      archived_at: null,
    }
  }

  describe('C4 consent_transportation_nonroutine_per_trip_recency', () => {
    const ack = ackForChild(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)
    it('loaded + recent ack → APPLIES', () => {
      expect(applicabilityOf('consent_transportation_nonroutine_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows({ acks: [ack] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('consent_transportation_nonroutine_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('consent_transportation_nonroutine_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('acks'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })

  describe('C5 consent_water_activities_off_premises_per_trip_recency', () => {
    const ack = ackForChild(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)
    it('loaded + recent ack → APPLIES', () => {
      expect(applicabilityOf('consent_water_activities_off_premises_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows({ acks: [ack] }), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.APPLIES)
    })
    it('loaded + empty → DOES_NOT_APPLY', () => {
      expect(applicabilityOf('consent_water_activities_off_premises_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
      })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    })
    it('not loaded → UNKNOWN', () => {
      expect(applicabilityOf('consent_water_activities_off_premises_per_trip_recency', {
        provider, child, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('acks'),
      })).toBe(APPLICABILITY_RESULT.UNKNOWN)
    })
  })
})

// -----------------------------------------------------------------------------
// Staff group (1) — health_safety_updates
// -----------------------------------------------------------------------------

describe('§2a loader-shape — E6 caregiver_health_safety_update_acked', () => {
  const provider = makeLicensedProvider()
  const update = { id: 'hsu-1', licensee_id: 'prov-1', published_at: '2026-01-01' }

  it('loaded + ≥1 published update → APPLIES', () => {
    expect(applicabilityOf('caregiver_health_safety_update_acked', {
      provider, sourceRows: makeSourceRows({ health_safety_updates: [update] }), sourceRowsLoaded: ALL_LOADED,
    })).toBe(APPLICABILITY_RESULT.APPLIES)
  })
  it('loaded + empty → DOES_NOT_APPLY', () => {
    expect(applicabilityOf('caregiver_health_safety_update_acked', {
      provider, sourceRows: makeSourceRows(), sourceRowsLoaded: ALL_LOADED,
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })
  it('not loaded → UNKNOWN', () => {
    expect(applicabilityOf('caregiver_health_safety_update_acked', {
      provider, sourceRows: makeSourceRows(), sourceRowsLoaded: loadedExcept('health_safety_updates'),
    })).toBe(APPLICABILITY_RESULT.UNKNOWN)
  })
})

// -----------------------------------------------------------------------------
// Backward-compat — non-opted-in rows are EXACTLY unaffected
// -----------------------------------------------------------------------------

describe('§2a loader-shape — backward compat (non-opted-in rows unaffected)', () => {
  const provider = makeLicensedProvider()
  const child = makeChild({ intake_completed_at: null })

  // intake_lead_disclosure reads `acks` in its state_resolver and
  // produces missing_required on []. It is in the "would change to
  // fuzzier but NOT §2a-violating" class — per scope §1.5 it MUST
  // remain on its pre-fix behavior because its `inferFromData` does
  // not opt into the loaded signal.
  it('intake_lead_disclosure: acks not loaded → still missing_required (NOT unknown)', () => {
    const providerWithLead = makeLicensedProvider({ home_built_before_1978: true })
    const s = stateOf('intake_lead_disclosure', {
      provider: providerWithLead,
      child,
      sourceRows: makeSourceRows(),
      sourceRowsLoaded: loadedExcept('acks'),
    })
    expect(s.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('omitting sourceRowsLoaded entirely → identical to pre-fix (DOES_NOT_APPLY for empty CDC group)', () => {
    // No sourceRowsLoaded argument at all — legacy callers must keep
    // working exactly as before the fix.
    expect(applicabilityOf('cdc_authorization_currency', {
      provider, sourceRows: makeSourceRows(),
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    expect(applicabilityOf('attendance_parent_acknowledgment_per_day', {
      provider, sourceRows: makeSourceRows(),
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
    expect(applicabilityOf('medication_authorization_for_authorization', {
      provider, child, sourceRows: makeSourceRows(),
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })

  it('empty sourceRowsLoaded ({}) → identical to omitting it', () => {
    expect(applicabilityOf('cdc_authorization_currency', {
      provider, sourceRows: makeSourceRows(), sourceRowsLoaded: {},
    })).toBe(APPLICABILITY_RESULT.DOES_NOT_APPLY)
  })
})

// -----------------------------------------------------------------------------
// Loader-level — safeQueryWithLoaded paths via the loader entry point
// -----------------------------------------------------------------------------
//
// These tests mock the Supabase client at the module level so the
// loader's per-table query paths can be exercised end-to-end. We
// don't import the loader's safeQueryWithLoaded helper directly
// because it isn't exported; the public surface is the
// loadComplianceSourceRows return shape.

vi.mock('./supabase', () => {
  // Each test installs a fresh fake supabase via the global. The
  // ./supabase mock just re-exports it.
  return {
    get supabase() { return globalThis.__loaderTestSupabase },
  }
})

// Minimal query-builder stub. Records the table name + last `.from()`
// call, and per-table queues a result the test pre-installs.
//
// 2026-06-13: also records every `.eq` / `.in` / `.gte` / `.is`
// filter call as `{ table, op, column, value }` on `__filterCalls`,
// so filter-shape regression tests can assert the loader is NOT
// filtering on a non-existent column (the staff_training_records
// `licensee_id` / attendance_acknowledgments `provider_id` bug
// caught in production 2026-06-13). Existing tests don't inspect
// `__filterCalls`, so this is purely additive.
function makeFakeSupabase(perTableResult) {
  const calls = []
  const filterCalls = []
  function builder(table) {
    const record = (op, column, value) => {
      filterCalls.push({ table, op, column, value })
    }
    const chain = {
      select:  () => chain,
      eq:      (column, value) => { record('eq', column, value); return chain },
      in:      (column, value) => { record('in', column, value); return chain },
      gte:     (column, value) => { record('gte', column, value); return chain },
      is:      (column, value) => { record('is', column, value); return chain },
      // PostgREST returns a thenable; the loader awaits the chain.
      // The loader's safeQueryWithLoaded relies on a thrown error to
      // surface as a rejected promise from `await fn()`, so the fake
      // must propagate the throw through the second `reject` arg of
      // the thenable contract.
      then(resolve, reject) {
        const result = perTableResult[table] !== undefined
          ? perTableResult[table]
          : { data: [], error: null }
        calls.push({ table, result })
        if (typeof result === 'function') {
          try { resolve(result()) }
          catch (err) {
            if (typeof reject === 'function') reject(err)
            // No reject handler — fall through; await will report
            // an unhandled rejection. Tests should always pass a
            // proper thenable to opt into the throw path.
          }
        } else {
          resolve(result)
        }
      },
      maybeSingle() {
        // Used only for the profiles fetch in the loader. Return a
        // minimal valid provider so the loader continues into the
        // table-fetching path.
        const r = perTableResult.profiles
        return Promise.resolve(r !== undefined ? r : { data: { id: 'prov-1', license_type: 'family_home' }, error: null })
      },
    }
    return chain
  }
  return {
    from: (table) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: 'prov-1' } } }) },
    __calls: calls,
    __filterCalls: filterCalls,
  }
}

describe('§2a loader — sourceRowsLoaded signal (loader integration)', () => {
  let loadComplianceSourceRows

  beforeEach(async () => {
    // Re-import the loader once vi.mock is wired.
    const mod = await import('./complianceStateLoader')
    loadComplianceSourceRows = mod.loadComplianceSourceRows
  })

  afterEach(() => {
    globalThis.__loaderTestSupabase = undefined
  })

  it('all tables succeed (empty results) → every opted-in table reports loaded=true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles:                              { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children:                              { data: [{ id: 'child-1' }], error: null },
      funding_sources:                       { data: [], error: null },
      medication_authorizations:             { data: [], error: null },
      medication_administration_events:      { data: [], error: null },
      health_safety_updates:                 { data: [], error: null },
      acknowledgments:                       { data: [], error: null },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.funding_sources).toBe(true)
    expect(out.sourceRowsLoaded.medication_authorizations).toBe(true)
    expect(out.sourceRowsLoaded.medication_admin_events).toBe(true)
    expect(out.sourceRowsLoaded.health_safety_updates).toBe(true)
    expect(out.sourceRowsLoaded.acks).toBe(true)
    expect(out.sourceRowsLoaded.staff_training_records).toBe(true)
    expect(out.sourceRowsLoaded.training_requirements).toBe(true)
    expect(out.sourceRowsLoaded.caregivers).toBe(true)
    expect(out.sourceRowsLoaded.funding_documents).toBe(true)
    expect(out.sourceRowsLoaded.miregistry_training_entries).toBe(true)
    expect(out.sourceRowsLoaded.attendance_acks).toBe(true)
  })

  it('PostgREST error on training_requirements → loaded=false; staff_training_records still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      training_requirements: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.training_requirements).toBe(false)
    expect(out.sourceRowsLoaded.staff_training_records).toBe(true)
  })

  it('PostgREST error on funding_sources → loaded=false; other tables still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      funding_sources: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.funding_sources).toBe(false)
    expect(out.sourceRowsLoaded.medication_authorizations).toBe(true)
    expect(out.sourceRowsLoaded.acks).toBe(true)
  })

  it('thrown exception on medication_authorizations → loaded=false', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      medication_authorizations: () => { throw new Error('network blip') },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.medication_authorizations).toBe(false)
  })

  it('acks loaded=false reports when EITHER childAcks or medAcks half fails', async () => {
    // childAcks query is the first acknowledgments fetch; medAcks is
    // the second. The fake supabase stub returns the same result for
    // every acknowledgments call — verify that a single shared error
    // propagates to the combined acks signal.
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      acknowledgments: { data: null, error: { code: 'PGRST116' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.acks).toBe(false)
  })

  it('no providerId → emptySourceRowsLoaded() shape (all true; legacy preserved)', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({})
    const out = await loadComplianceSourceRows({})
    // No providerId is a precondition failure, not a load failure;
    // we preserve legacy DOES_NOT_APPLY behavior by reporting true.
    expect(out.sourceRowsLoaded).toEqual({
      acks:                        true,
      medication_authorizations:   true,
      medication_admin_events:     true,
      caregivers:                  true,
      health_safety_updates:       true,
      funding_sources:             true,
      funding_documents:           true,
      staff_training_records:      true,
      training_requirements:       true,
      miregistry_training_entries: true,
      attendance_acks:             true,
      compliance_documents:        true,
    })
  })

  it('PostgREST error on caregivers → loaded=false; staff_training_records also propagates false (corrected dependency, 2026-06-13)', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      caregivers: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.caregivers).toBe(false)
    // Pre-2026-06-13 behavior: staff_training_records was filtered
    // independently via `.eq('licensee_id', providerId)` (a column
    // that does not exist) and the old test asserted loaded=true on
    // this branch. After the production-bug fix the loader filters
    // staff_training_records via `.in('caregiver_id', caregiverIds)`
    // from the loaded caregiver list, so a failed caregivers load
    // propagates to staff_training_records.loaded — a resolver can't
    // honestly answer "no records" when the caregiver roster itself
    // is unknown. This is the §2a guard pattern working correctly.
    expect(out.sourceRowsLoaded.staff_training_records).toBe(false)
  })

  it('PostgREST error on funding_documents → loaded=false; funding_sources still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      funding_documents: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.funding_documents).toBe(false)
    expect(out.sourceRowsLoaded.funding_sources).toBe(true)
  })

  it('PostgREST error on miregistry_training_entries → loaded=false; caregivers still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      miregistry_training_entries: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.miregistry_training_entries).toBe(false)
    expect(out.sourceRowsLoaded.caregivers).toBe(true)
  })

  it('PostgREST error on attendance_acknowledgments → attendance_acks loaded=false; acks still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      attendance_acknowledgments: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.attendance_acks).toBe(false)
    expect(out.sourceRowsLoaded.acks).toBe(true)
  })

  it('compliance_documents load (2026-06-14 batch): cleanly empty → rows=[], loaded=true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      compliance_documents: { data: [], error: null },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.compliance_documents).toBe(true)
    expect(out.sourceRows.compliance_documents).toEqual([])
  })

  it('compliance_documents load (2026-06-14 batch): populated → rows pass through, loaded=true', async () => {
    const docs = [
      { id: 'd1', document_type: 'property_radon_test', uploaded_at: '2026-06-01T00:00:00Z', archived_at: null },
      { id: 'd2', document_type: 'property_heating_inspection', uploaded_at: '2026-06-02T00:00:00Z', archived_at: null },
    ]
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      compliance_documents: { data: docs, error: null },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.compliance_documents).toBe(true)
    expect(out.sourceRows.compliance_documents).toEqual(docs)
  })

  it('PostgREST error on compliance_documents → loaded=false (the §2a guard); other tables still true', async () => {
    globalThis.__loaderTestSupabase = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-1' }], error: null },
      compliance_documents: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })
    expect(out.sourceRowsLoaded.compliance_documents).toBe(false)
    expect(out.sourceRowsLoaded.funding_sources).toBe(true)
    expect(out.sourceRowsLoaded.acks).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Filter-shape regression — production-bug lock (2026-06-13)
// -----------------------------------------------------------------------------
//
// Background: production hit 400 errors on /compliance because the
// loader was filtering `staff_training_records.licensee_id` and
// `attendance_acknowledgments.provider_id` — NEITHER COLUMN EXISTS.
//   - staff_training_records reaches the licensee via
//     caregiver_id → caregivers.licensee_id (its RLS shape).
//   - attendance_acknowledgments reaches the provider via
//     child_id → children.user_id (its RLS shape).
// The §2a guard correctly surfaced both as "couldn't verify," but no
// test had locked the loader's filter shape against the actual
// schema, so the bug shipped. These tests lock the corrected shape:
// the loader must NEVER filter either table on the non-existent
// column, and MUST filter through the correct relationship.

describe('production-bug regression: loader filter shape vs real schema', () => {
  let loadComplianceSourceRows

  beforeEach(async () => {
    const mod = await import('./complianceStateLoader')
    loadComplianceSourceRows = mod.loadComplianceSourceRows
  })

  afterEach(() => {
    globalThis.__loaderTestSupabase = undefined
  })

  it('staff_training_records: filters .in("caregiver_id", ...), NEVER .eq("licensee_id", ...) — main loader path', async () => {
    const fake = makeFakeSupabase({
      profiles:   { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children:   { data: [{ id: 'child-1' }], error: null },
      caregivers: { data: [{ id: 'careg-1', full_name: 'Test', archived_at: null }], error: null },
    })
    globalThis.__loaderTestSupabase = fake
    await loadComplianceSourceRows({ providerId: 'prov-1' })

    const staffCalls = fake.__filterCalls.filter(c => c.table === 'staff_training_records')
    // The bug: .eq('licensee_id', ...) on a table with no such column.
    // PostgREST returns 400; the resolver loses visibility on every
    // staff-files row. This assertion fails loudly if anyone
    // reintroduces the licensee_id filter.
    expect(
      staffCalls.find(c => c.op === 'eq' && c.column === 'licensee_id')
    ).toBeUndefined()
    // The corrected shape: an IN filter through caregiver_id, sourced
    // from the loaded caregiver list.
    const inCall = staffCalls.find(c => c.op === 'in' && c.column === 'caregiver_id')
    expect(inCall).toBeDefined()
    expect(Array.isArray(inCall.value)).toBe(true)
    expect(inCall.value).toContain('careg-1')
  })

  it('staff_training_records: no caregivers ⇒ no query issued; loaded mirrors caregivers.loaded', async () => {
    const fake = makeFakeSupabase({
      profiles:   { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children:   { data: [{ id: 'child-1' }], error: null },
      caregivers: { data: [], error: null },
    })
    globalThis.__loaderTestSupabase = fake
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })

    // Skip-query shortcut: nothing should have hit the staff table.
    expect(
      fake.__calls.find(c => c.table === 'staff_training_records')
    ).toBeUndefined()
    // Clean-empty case ⇒ loaded=true (genuine zero, not a failure).
    expect(out.sourceRowsLoaded.staff_training_records).toBe(true)
    expect(out.sourceRows.staff_training_records).toEqual([])
  })

  it('staff_training_records: caregivers failed-to-load ⇒ no query; loaded propagates false', async () => {
    const fake = makeFakeSupabase({
      profiles:   { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children:   { data: [{ id: 'child-1' }], error: null },
      caregivers: { data: null, error: { code: 'PGRST116', message: 'RLS' } },
    })
    globalThis.__loaderTestSupabase = fake
    const out = await loadComplianceSourceRows({ providerId: 'prov-1' })

    // The §2a guard reads sourceRowsLoaded.staff_training_records;
    // an honest false here resolves the eight staff-files rows to
    // UNKNOWN. A false-positive `true` would surface them as
    // "no records ⇒ missing_required" — exactly the failure mode
    // the production bug produced.
    expect(out.sourceRowsLoaded.staff_training_records).toBe(false)
    expect(
      fake.__calls.find(c => c.table === 'staff_training_records')
    ).toBeUndefined()
  })

  it('staff_training_records: filters .in("caregiver_id", ...), NEVER .eq("licensee_id", ...) — sub-loader (no-children path)', async () => {
    const fake = makeFakeSupabase({
      profiles:   { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      // No children — the loader falls through to loadProviderLevelRows.
      children:   { data: [], error: null },
      caregivers: { data: [{ id: 'careg-2', full_name: 'Test 2', archived_at: null }], error: null },
    })
    globalThis.__loaderTestSupabase = fake
    await loadComplianceSourceRows({ providerId: 'prov-1' })

    const staffCalls = fake.__filterCalls.filter(c => c.table === 'staff_training_records')
    expect(
      staffCalls.find(c => c.op === 'eq' && c.column === 'licensee_id')
    ).toBeUndefined()
    const inCall = staffCalls.find(c => c.op === 'in' && c.column === 'caregiver_id')
    expect(inCall).toBeDefined()
    expect(inCall.value).toContain('careg-2')
  })

  it('attendance_acknowledgments: filters .in("child_id", ...), NEVER .eq("provider_id", ...) and NEVER .eq("licensee_id", ...)', async () => {
    const fake = makeFakeSupabase({
      profiles: { data: { id: 'prov-1', license_type: 'family_home' }, error: null },
      children: { data: [{ id: 'child-A' }, { id: 'child-B' }], error: null },
    })
    globalThis.__loaderTestSupabase = fake
    await loadComplianceSourceRows({ providerId: 'prov-1' })

    const ackCalls = fake.__filterCalls.filter(c => c.table === 'attendance_acknowledgments')
    // The bug shape (the loader had .eq('provider_id', ...); the user
    // task report cited a licensee_id form — neither column exists,
    // so both filter shapes are wrong and both must stay out).
    expect(
      ackCalls.find(c => c.op === 'eq' && c.column === 'provider_id')
    ).toBeUndefined()
    expect(
      ackCalls.find(c => c.op === 'eq' && c.column === 'licensee_id')
    ).toBeUndefined()
    // The corrected shape: filter through the loaded children list.
    const inCall = ackCalls.find(c => c.op === 'in' && c.column === 'child_id')
    expect(inCall).toBeDefined()
    expect(inCall.value).toEqual(expect.arrayContaining(['child-A', 'child-B']))
  })
})
