import { describe, it, expect, vi, beforeEach } from 'vitest'

// The hook-style supabase import must be mocked before importing
// childFiles.js (the module reads import.meta.env at load time). Mirrors
// the pattern used by useReminderPreferences.test.js.

const mockState = {
  profile: null,
  children: [],
  acks: [],
  ackError: null,
}

function chainFor(table) {
  // Returns a fluent mock that resolves to the per-table data shape
  // PostgREST gives us. We honor only the filters the SUT actually
  // applies (.eq, .in, .is, .maybeSingle) so the test reads like the
  // actual query.
  const chain = {
    _isMaybeSingle: false,
    select() { return chain },
    eq() { return chain },
    in() { return chain },
    is() { return chain },
    maybeSingle() { chain._isMaybeSingle = true; return chain },
    then(resolve, reject) {
      let data, error
      if (table === 'profiles') {
        data = mockState.profile
        error = null
      } else if (table === 'children') {
        data = mockState.children
        error = null
      } else if (table === 'acknowledgments') {
        data = mockState.acks
        error = mockState.ackError
      } else {
        data = null; error = null
      }
      return Promise.resolve({ data, error }).then(resolve, reject)
    },
  }
  return chain
}

// childFiles.js imports `from './supabase'` (relative, per the Edge
// guardrail). Mock the resolved module — Vitest normalizes both `./supabase`
// and `@/lib/supabase` to the same module ID, so either works.
vi.mock('./supabase', () => ({
  supabase: { from: (table) => chainFor(table) },
}))

const {
  getChildFilesAuditState,
  pendingEnrollmentConsentsForChild,
  photoConsentNeedsReminderForChild,
  computePhaseBExpiresAt,
  partitionAcksByExpiry,
  TIME_BOUND_TYPES,
} = await import('./childFiles')

beforeEach(() => {
  mockState.profile = null
  mockState.children = []
  mockState.acks = []
  mockState.ackError = null
})

// Reused fixture builder — the empty parent-signatures breakdown is
// generated freshly per call so individual cases can mutate without
// leaking to other cases.
//
// 2026-05-29: extended with `licensing_rules_offered` per
// R 400.1907(1)(b)(iii) — the genuinely-missing acknowledgment now
// captured. The `licensing_notebook_offered` key is the DB string
// for the JS constant LICENSING_NOTEBOOK_AVAILABILITY ((b)(vii)).
function emptyBreakdown() {
  return {
    firearms_disclosure: 0,
    food_provider_agreement: 0,
    licensing_notebook_offered: 0,
    licensing_rules_offered: 0,
    health_condition: 0,
    discipline_policy_receipt: 0,
  }
}

// Phase A breakdown helpers — separate fixture so the existing
// intake-bundle emptyBreakdown stays focused on parent-signed types.
// Phase B (2026-06-01) added two licensing-required types to
// ENROLLMENT_CONSENT_TYPES: transportation_routine_annual and
// water_activities_on_premises_seasonal. The breakdown carries
// every key initialized to 0 (stable shape across all return paths).
function emptyEnrollmentConsentsBreakdown() {
  return {
    field_trip_permission: 0,
    transportation_routine_annual: 0,
    water_activities_on_premises_seasonal: 0,
  }
}
function emptyProviderProtectiveConsentsBreakdown() {
  return { photo_sharing_consent: 0 }
}

describe('getChildFilesAuditState', () => {
  it('returns the empty/zero shape when no licenseeId is provided', async () => {
    const out = await getChildFilesAuditState(null)
    expect(out).toEqual({
      domain: 'child_files',
      type: 'type_2',
      active_children_count: 0,
      intake_complete_count: 0,
      intake_incomplete_count: 0,
      annual_review_overdue_count: 0,
      pending_lead_disclosures_count: 0,
      pending_parent_signatures_count: 0,
      pending_parent_signatures: emptyBreakdown(),
      children_with_pending_parent_signatures_count: 0,
      pending_enrollment_consents_count: 0,
      pending_enrollment_consents: emptyEnrollmentConsentsBreakdown(),
      pending_provider_protective_consents_count: 0,
      pending_provider_protective_consents: emptyProviderProtectiveConsentsBreakdown(),
      children_with_pending_enrollment_consents_count: 0,
      children_with_pending_provider_protective_consents_count: 0,
      // Phase B (2026-06-01) — expired-state tracking on time-bound types.
      pending_enrollment_consents_expired_count: 0,
      pending_enrollment_consents_expired: emptyEnrollmentConsentsBreakdown(),
      // Phase C (2026-06-01) — per-occurrence event-record rollup
      // (informational, NOT a compliance signal).
      per_occurrence_consents_recorded: {
        transportation_nonroutine_per_trip: 0,
        water_activities_off_premises_per_trip: 0,
      },
    })
  })

  it('matches the documented shape exactly (no extra keys)', async () => {
    // Profile premises answered → firearms is in the required set →
    // firearms counts toward the rollup. With one child and no acks,
    // every always-required parent-signed type is pending (6 total
    // after the 2026-05-29 licensing_rules_offered addition). Consents
    // Phase A (2026-05-30) added six new top-level keys; Phase B
    // (2026-06-01) added two more (pending_enrollment_consents_expired
    // + its count).
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'c1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(Object.keys(out).sort()).toEqual([
      'active_children_count',
      'annual_review_overdue_count',
      'children_with_pending_enrollment_consents_count',
      'children_with_pending_parent_signatures_count',
      'children_with_pending_provider_protective_consents_count',
      'domain',
      'intake_complete_count',
      'intake_incomplete_count',
      // Phase C (2026-06-01) — informational per-occurrence rollup.
      'pending_enrollment_consents',
      'pending_enrollment_consents_count',
      'pending_enrollment_consents_expired',
      'pending_enrollment_consents_expired_count',
      'pending_lead_disclosures_count',
      'pending_parent_signatures',
      'pending_parent_signatures_count',
      'pending_provider_protective_consents',
      'pending_provider_protective_consents_count',
      'per_occurrence_consents_recorded',
      'type',
    ])
    expect(out.domain).toBe('child_files')
    expect(out.type).toBe('type_2')
    // pending_parent_signatures always carries every PARENT_SIGNED_TYPES
    // key — consumers can rely on the shape. After 2026-05-29, six keys:
    // the original five + licensing_rules_offered ((b)(iii)).
    expect(Object.keys(out.pending_parent_signatures).sort()).toEqual([
      'discipline_policy_receipt',
      'firearms_disclosure',
      'food_provider_agreement',
      'health_condition',
      'licensing_notebook_offered',
      'licensing_rules_offered',
    ])
  })

  it('counts active children + intake complete/incomplete buckets', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'a', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
      { id: 'b', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'c', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.active_children_count).toBe(3)
    expect(out.intake_complete_count).toBe(1)
    expect(out.intake_incomplete_count).toBe(2)
  })

  // ─── The pending-disclosure tests the spec called out specifically ──

  it('counts a child with an UNSIGNED lead disclosure when home_built_before_1978=true', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []  // no acks recorded
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(1)
  })

  it('drops the lead pending count once a lead_disclosure ack is recorded for the child', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'kid-1', type: 'lead_disclosure' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
  })

  it('does NOT count lead disclosures when home_built_before_1978=false (not required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'kid-1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
  })

  it('counts an UNSIGNED firearms disclosure for every child when firearms answer is set (always required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(2)
  })

  it('firearms_on_premises=false still requires the disclosure ack (copy varies, ack still required)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(1)
  })

  it('drops the firearms pending count once a parent-signed firearms_disclosure ack is recorded (parent_portal)', async () => {
    // PR #16 follow-up (channel-aware audit, 2026-05-29). Firearms is
    // a parent-signed item per R 400.1907; satisfied only by
    // parent_portal or in_person_paper.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'parent_portal' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
  })

  it('drops the firearms pending count under in_person_paper too (paper signature is the parent signature)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'in_person_paper' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
  })

  it('does NOT drop firearms pending count under provider_override alone (parent has not signed yet)', async () => {
    // The regulatory-interpretation call documented in childFiles.js:
    // provider_override is the licensee's attestation, not the parent's
    // signature. R 400.1907's plain-text "signed by the parent" is not
    // satisfied by it. To revisit: see the top-of-file note in
    // src/lib/childFiles.js.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'provider_override' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(1)
  })

  it('drops the lead pending count under provider_override (lead is inform-only — channel does not matter)', async () => {
    // Lead disclosure is R 400.1907(1)(b)(vi) — "the licensee shall
    // inform the parent." The act of informing satisfies the rule;
    // provider_override is exactly that act recorded.
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'lead_disclosure', acknowledged_via: 'provider_override' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
  })

  it('per-child independence: one child acks lead, the other does not', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: false }
    mockState.children = [
      { id: 'signed', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'unsigned', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'signed', type: 'lead_disclosure' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(1)
  })

  it('firearms_on_premises = null (provider has not answered) does NOT inflate the firearms pending count', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: null }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    // Firearms ack required only when the provider has answered yes or no.
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
  })

  it('counts annual-review overdue when last review was > 1 year ago', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const longAgo = '2020-01-01'
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: longAgo, date_of_birth: '2018-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.annual_review_overdue_count).toBe(1)
  })

  it('does NOT count annual-review overdue for a recent review', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const recent = new Date().toISOString().slice(0, 10)
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: recent, date_of_birth: '2018-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.annual_review_overdue_count).toBe(0)
  })

  // ─── 16patch follow-up: compliance-meaningful confirm loop ──
  //
  // The "Send to parent's portal" channel now pre-writes the bundle as
  // provider_override sub-rows; the parent's portal confirm archives
  // them and re-stamps the bundle as parent_portal. Per R 400.1907
  // (and per the audit-semantic update of 2026-05-29), the audit-state
  // helper now applies channel-aware satisfaction:
  //   - Lead is inform-only — any active ack satisfies, including
  //     provider_override (phase A clears lead's count).
  //   - Firearms (and the other four parent-signed types) are
  //     satisfied only by parent_portal or in_person_paper —
  //     provider_override alone does NOT satisfy them (phase A keeps
  //     the firearms count pending; phase B clears it once the parent
  //     confirms).
  // Phase A and phase B together prove the channel transition is the
  // compliance signal — not the mere presence of an ack row.

  it('phase A — post-send-to-portal: provider_override clears LEAD; ALL SIX parent-signed types STAY PENDING (2026-05-29: 5→6 after licensing_rules_offered addition)', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
    ]
    // Provider has clicked Send-to-Portal: the bundle is fully written
    // as provider_override; the parent has not confirmed yet. Every
    // parent-signed type is present-but-not-parent-signed. After
    // 2026-05-29 the bundle includes licensing_rules_offered (b)(iii).
    mockState.acks = [
      { subject_id: 'k1', type: 'child_in_care_statement', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'lead_disclosure', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'food_provider_agreement', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'licensing_notebook_offered', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'licensing_rules_offered', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'health_condition', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'discipline_policy_receipt', acknowledged_via: 'provider_override' },
    ]
    const out = await getChildFilesAuditState('u1')
    // Lead (inform-only): provider_override IS the licensee's act of
    // informing per R 400.1907(1)(b)(vi). Cleared.
    expect(out.pending_lead_disclosures_count).toBe(0)
    // All six parent-signed types: provider_override does NOT satisfy.
    // Each type has 1 child pending.
    expect(out.pending_parent_signatures).toEqual({
      firearms_disclosure: 1,
      food_provider_agreement: 1,
      licensing_notebook_offered: 1,
      licensing_rules_offered: 1,
      health_condition: 1,
      discipline_policy_receipt: 1,
    })
    // Rollup: 6 slots pending.
    expect(out.pending_parent_signatures_count).toBe(6)
    // Children-affected: 1 child has ≥1 pending signature.
    expect(out.children_with_pending_parent_signatures_count).toBe(1)
    expect(out.intake_complete_count).toBe(1)
  })

  it('phase B — post-parent-confirm: parent_portal rows clear ALL SIX parent-signed types AND lead', async () => {
    // After the parent confirms via the portal, the provider_override
    // rows are archived (RLS soft-delete) and parent_portal rows are
    // active. The channel transition is the audit story: provider
    // attested, parent then confirmed. 2026-05-29: bundle now includes
    // licensing_rules_offered.
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'child_in_care_statement', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'lead_disclosure', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'food_provider_agreement', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'licensing_notebook_offered', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'licensing_rules_offered', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'health_condition', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'discipline_policy_receipt', acknowledged_via: 'parent_portal' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_lead_disclosures_count).toBe(0)
    expect(out.pending_parent_signatures).toEqual(emptyBreakdown())
    expect(out.pending_parent_signatures_count).toBe(0)
    expect(out.children_with_pending_parent_signatures_count).toBe(0)
    expect(out.intake_complete_count).toBe(1)
  })

  it('mixed two children: k1 phase A (full bundle provider_override), k2 phase B (full bundle parent_portal)', async () => {
    // Each child carries the FULL bundle so the per-child satisfaction
    // is unambiguous: k1 has every parent-signed type stamped
    // provider_override (none satisfied), k2 has every parent-signed
    // type stamped parent_portal (all satisfied). Lead is cleared for
    // both (any-channel rule). 2026-05-29: bundle width is now 6.
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: '2026-05-29T13:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2023-06-15' },
    ]
    const fullBundle = [
      'lead_disclosure', 'firearms_disclosure', 'food_provider_agreement',
      'licensing_notebook_offered', 'licensing_rules_offered',
      'health_condition', 'discipline_policy_receipt',
    ]
    mockState.acks = [
      // k1 — phase A: every type provider_override
      ...fullBundle.map(t => ({ subject_id: 'k1', type: t, acknowledged_via: 'provider_override' })),
      // k2 — phase B: every type parent_portal
      ...fullBundle.map(t => ({ subject_id: 'k2', type: t, acknowledged_via: 'parent_portal' })),
    ]
    const out = await getChildFilesAuditState('u1')
    // Lead inform-only: both cleared.
    expect(out.pending_lead_disclosures_count).toBe(0)
    // Parent-signed: only k1 contributes; every parent-signed type = 1.
    expect(out.pending_parent_signatures).toEqual({
      firearms_disclosure: 1,
      food_provider_agreement: 1,
      licensing_notebook_offered: 1,
      licensing_rules_offered: 1,
      health_condition: 1,
      discipline_policy_receipt: 1,
    })
    expect(out.pending_parent_signatures_count).toBe(6)
    // Children-affected: 1 (k1), not 2 — k2 is fully satisfied.
    expect(out.children_with_pending_parent_signatures_count).toBe(1)
    expect(out.intake_complete_count).toBe(2)
  })

  // ─── All six parent-signed types: channel-aware coverage ──
  //
  // The 2026-05-29 audit-state extension tracks ALL six parent-signed
  // types: firearms_disclosure + food_provider_agreement +
  // licensing_notebook_offered + licensing_rules_offered (added
  // 2026-05-29) + health_condition + discipline_policy_receipt.
  // These cases pin the channel-aware rule for each of the five non-
  // firearms types. Per-type pattern: provider_override → pending,
  // parent_portal → cleared, in_person_paper → cleared.

  const OTHER_PARENT_SIGNED_TYPES = [
    'food_provider_agreement',
    'licensing_notebook_offered',
    'licensing_rules_offered',  // added 2026-05-29 — R 400.1907(1)(b)(iii)
    'health_condition',
    'discipline_policy_receipt',
  ]

  for (const type of OTHER_PARENT_SIGNED_TYPES) {
    it(`provider_override does NOT satisfy ${type} (parent-signed)`, async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type, acknowledged_via: 'provider_override' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures[type]).toBe(1)
    })

    it(`parent_portal satisfies ${type} (parent signature)`, async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type, acknowledged_via: 'parent_portal' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures[type]).toBe(0)
    })

    it(`in_person_paper satisfies ${type} (real paper signature)`, async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type, acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures[type]).toBe(0)
    })
  }

  // ─── Rollup and children-affected semantics ──

  it('rollup counts SIGNATURE SLOTS — 3 children each missing 1 signature = rollup 3, children-affected 3', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k3', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    // Each child has 5 of 6 parent-signed types covered by parent_portal,
    // missing only discipline_policy_receipt. (2026-05-29 bundle width
    // is 6: firearms + food + notebook + rules + health + discipline.)
    mockState.acks = [
      ...['k1', 'k2', 'k3'].flatMap(id =>
        ['firearms_disclosure', 'food_provider_agreement',
         'licensing_notebook_offered', 'licensing_rules_offered',
         'health_condition']
          .map(t => ({ subject_id: id, type: t, acknowledged_via: 'parent_portal' }))
      ),
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.discipline_policy_receipt).toBe(3)
    expect(out.pending_parent_signatures_count).toBe(3)
    expect(out.children_with_pending_parent_signatures_count).toBe(3)
  })

  it('rollup vs children-affected diverge — 1 child missing 6 signatures = rollup 6, children-affected 1', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k3', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    // k1 fully missing, k2 and k3 fully satisfied via parent_portal.
    // Full bundle is now 6 parent-signed types.
    mockState.acks = [
      ...['k2', 'k3'].flatMap(id =>
        ['firearms_disclosure', 'food_provider_agreement',
         'licensing_notebook_offered', 'licensing_rules_offered',
         'health_condition', 'discipline_policy_receipt']
          .map(t => ({ subject_id: id, type: t, acknowledged_via: 'parent_portal' }))
      ),
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures_count).toBe(6)             // slots
    expect(out.children_with_pending_parent_signatures_count).toBe(1) // distinct kids
  })

  it('children-affected is distinct count — a child contributes once even when missing many types', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    // Empty — every parent-signed type pending for k1. With premises
    // answered, all 6 always-required types are pending.
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures_count).toBe(6)
    expect(out.children_with_pending_parent_signatures_count).toBe(1) // one kid, not six
  })

  it('firearms not in required set when firearms_on_premises is null — does not contribute to rollup', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: null }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    // firearms_disclosure is not in requiredSubTypesForChild's output
    // when premises is unanswered, so it doesn't contribute to the
    // rollup. The other five parent-signed types are always required:
    // food, notebook ((vii)), rules ((iii) added 2026-05-29), health,
    // discipline.
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
    expect(out.pending_parent_signatures_count).toBe(5)              // 5 slots: food + notebook + rules + health + discipline
    expect(out.children_with_pending_parent_signatures_count).toBe(1)
  })

  it('mixed satisfaction per-type for one child — 3 satisfied parent_portal, 3 pending provider_override (2026-05-29 width 6)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'food_provider_agreement', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'licensing_rules_offered', acknowledged_via: 'parent_portal' },
      { subject_id: 'k1', type: 'licensing_notebook_offered', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'health_condition', acknowledged_via: 'provider_override' },
      { subject_id: 'k1', type: 'discipline_policy_receipt', acknowledged_via: 'provider_override' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures).toEqual({
      firearms_disclosure: 0,
      food_provider_agreement: 0,
      licensing_rules_offered: 0,
      licensing_notebook_offered: 1,
      health_condition: 1,
      discipline_policy_receipt: 1,
    })
    expect(out.pending_parent_signatures_count).toBe(3)
    expect(out.children_with_pending_parent_signatures_count).toBe(1)
  })

  it('in_person_paper satisfies firearms (real paper signature from parent)', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: '2026-05-29T12:00:00Z', records_last_reviewed_on: '2026-05-29', date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'firearms_disclosure', acknowledged_via: 'in_person_paper' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
  })

  // ─── Consents Phase A — enrollment-level consents (2026-05-30) ──
  //
  // Two separate audit blocks per Option A:
  //   - LICENSING-REQUIRED (field_trip_permission)
  //   - PROVIDER-PROTECTIVE (photo_sharing_consent) with revocation pair
  //
  // Channel-aware satisfaction same as the intake parent-signed types.
  // The provider-protective block ALSO recognizes an active revocation-
  // pair row as "preference captured" (only no-record-either-way counts
  // as pending).
  //
  // Phase A is intentionally provider-recorded: in_person_paper /
  // provider_override only. No parent-portal self-confirm. Tests
  // pin the channel rule the same way the intake-bundle tests do.

  describe('enrollment_consents (licensing-required) — field_trip_permission', () => {
    it('pending when no record exists (1 child, empty acks → 1 slot per type, 1 child affected)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = []
      const out = await getChildFilesAuditState('u1')
      // Phase B (2026-06-01): ENROLLMENT_CONSENT_TYPES expanded from
      // [field_trip] to [field_trip, transport_annual, water_seasonal],
      // so empty-acks reports 3 pending slots per child, not 1.
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(1)
      expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(1)
      expect(out.pending_enrollment_consents.water_activities_on_premises_seasonal).toBe(1)
      expect(out.pending_enrollment_consents_count).toBe(3)
      expect(out.children_with_pending_enrollment_consents_count).toBe(1)
    })

    it('cleared by in_person_paper record (field_trip-specific; other Phase B types still pending)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(0)
      // Phase B types still pending (the test only captures field_trip).
      expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(1)
      expect(out.pending_enrollment_consents.water_activities_on_premises_seasonal).toBe(1)
      expect(out.pending_enrollment_consents_count).toBe(2)
      // Child still affected because transport + water are pending.
      expect(out.children_with_pending_enrollment_consents_count).toBe(1)
    })

    it('cleared by parent_portal record (channel rule supports it)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'parent_portal' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(0)
    })

    it('NOT cleared by provider_override alone (parent has not signed — same parent-signed rule as intake)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'provider_override' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(1)
    })

    it('does NOT mix into intake parent-signed rollup (audit blocks are distinct)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      // field_trip ack does NOT appear under the intake bundle.
      expect(out.pending_parent_signatures).not.toHaveProperty('field_trip_permission')
      // Intake count is computed independently (no parent-signed intake
      // acks here, premises both false so 6 intake types still pending).
      expect(out.pending_parent_signatures_count).toBe(6)
    })
  })

  describe('provider_protective_consents — photo_sharing_consent (revocation-aware)', () => {
    it('pending when no record either way', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = []
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(1)
      expect(out.pending_provider_protective_consents_count).toBe(1)
      expect(out.children_with_pending_provider_protective_consents_count).toBe(1)
    })

    it('cleared by a parent-signed consent (in_person_paper)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(0)
    })

    it('cleared by a parent-signed REVOCATION pair (preference is captured, just as a no)', async () => {
      // The revocation pair is the audit-trail signal that the parent
      // expressed a no. From the audit-state's standpoint, that's
      // "preference recorded" — distinct from "no record either way."
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(0)
      expect(out.pending_provider_protective_consents_count).toBe(0)
    })

    it('NOT cleared by provider_override consent alone (same parent-signed rule)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'photo_sharing_consent', acknowledged_via: 'provider_override' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(1)
    })

    it('NOT cleared by provider_override revocation alone (the parent-signed rule applies to both sides)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'photo_sharing_consent_revoked', acknowledged_via: 'provider_override' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(1)
    })
  })

  describe('Phase A blocks are independent of intake', () => {
    it('a fully satisfied intake bundle does NOT clear enrollment-consent pending counts', async () => {
      mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
      mockState.children = [
        { id: 'k1', intake_completed_at: '2026-05-30T12:00:00Z', records_last_reviewed_on: '2026-05-30', date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        // Full intake bundle (parent_portal) but NO enrollment consents
        // (field_trip / transport / water) and no photo consent.
        { subject_id: 'k1', type: 'child_in_care_statement', acknowledged_via: 'parent_portal' },
        ...['lead_disclosure', 'firearms_disclosure', 'food_provider_agreement',
            'licensing_notebook_offered', 'licensing_rules_offered',
            'health_condition', 'discipline_policy_receipt']
          .map(t => ({ subject_id: 'k1', type: t, acknowledged_via: 'parent_portal' })),
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures_count).toBe(0)              // intake fully cleared
      // Phase B expansion: enrollment block has 3 types, all pending.
      expect(out.pending_enrollment_consents_count).toBe(3)
      expect(out.pending_provider_protective_consents_count).toBe(1)   // photo still pending
    })

    it('mixed: intake satisfied, every enrollment consent captured, photo revoked — every block reads as captured', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      const inOneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      mockState.children = [
        { id: 'k1', intake_completed_at: '2026-05-30T12:00:00Z', records_last_reviewed_on: '2026-05-30', date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        ...['firearms_disclosure', 'food_provider_agreement',
            'licensing_notebook_offered', 'licensing_rules_offered',
            'health_condition', 'discipline_policy_receipt']
          .map(t => ({ subject_id: 'k1', type: t, acknowledged_via: 'in_person_paper' })),
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
        // Phase B types captured with a future expires_at → currently valid.
        { subject_id: 'k1', type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: inOneYear },
        { subject_id: 'k1', type: 'water_activities_on_premises_seasonal', acknowledged_via: 'in_person_paper', expires_at: inOneYear },
        { subject_id: 'k1', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures_count).toBe(0)
      expect(out.pending_enrollment_consents_count).toBe(0)
      expect(out.pending_enrollment_consents_expired_count).toBe(0)
      expect(out.pending_provider_protective_consents_count).toBe(0)
      expect(out.children_with_pending_enrollment_consents_count).toBe(0)
      expect(out.children_with_pending_provider_protective_consents_count).toBe(0)
    })
  })

  it('returns children-only zeros when the acknowledgments table is unavailable (migration not applied)', async () => {
    mockState.profile = { home_built_before_1978: true, firearms_on_premises: true }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = null
    mockState.ackError = new Error('relation "public.acknowledgments" does not exist')
    const out = await getChildFilesAuditState('u1')
    expect(out.active_children_count).toBe(1)
    expect(out.intake_incomplete_count).toBe(1)
    // The defensive empty-state fallback omits the disclosure pending
    // counts (no acks table -> we can't decide who's outstanding).
    expect(out.pending_lead_disclosures_count).toBe(0)
    expect(out.pending_parent_signatures.firearms_disclosure).toBe(0)
  })
})

// ─── pendingEnrollmentConsentsForChild — shared verdict function ──
//
// Single source of truth for the channel + revocation-pair rule used
// by the provider audit helper and BOTH parent-side surfaces
// (ParentAcknowledgmentsPage badge + EnrollmentConsentsPendingBanner).
// These cases exercise the function directly with raw ack fixtures —
// no Supabase, no I/O.

describe('pendingEnrollmentConsentsForChild — pure verdict', () => {
  it('no record → both buckets pending (Phase B added two more enrollment types)', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: [] })
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
    expect(v.enrollment_consents_expired).toEqual([])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
    expect(v.any_pending).toBe(true)
  })

  it('field_trip consent via in_person_paper → only field_trip cleared; Phase B types still pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
    expect(v.enrollment_consents_expired).toEqual([])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
    expect(v.any_pending).toBe(true)
  })

  it('field_trip consent via parent_portal → field_trip cleared; Phase B types remain pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'parent_portal' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
  })

  it('field_trip consent via provider_override → DOES NOT clear (parent has not signed); Phase B still pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'provider_override' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
  })

  it('photo consent via in_person_paper → provider-protective block cleared', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.provider_protective_consents_pending).toEqual([])
  })

  it('photo REVOCATION via in_person_paper → provider-protective block CLEARED (preference captured, as a no)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.provider_protective_consents_pending).toEqual([])
  })

  it('photo REVOCATION via provider_override → DOES NOT clear (the parent-signed rule applies to revocations too)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'provider_override' },
      ],
    })
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
  })

  it('photo consent via provider_override AND revocation via in_person_paper → cleared via the revocation (channel rule wins)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'provider_override' },
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.provider_protective_consents_pending).toEqual([])
  })

  it('all enrollment + protective types satisfied → any_pending = false', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
        { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper' },
        { type: 'water_activities_on_premises_seasonal', acknowledged_via: 'in_person_paper' },
        { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([])
    expect(v.enrollment_consents_expired).toEqual([])
    expect(v.provider_protective_consents_pending).toEqual([])
    expect(v.any_pending).toBe(false)
  })

  it('intake-bundle rows in the fixture are ignored (only enrollment + provider-protective types are evaluated)', () => {
    // Robustness: if a caller accidentally passes the child's FULL ack
    // list (including intake-bundle rows), the function ignores types
    // not in ENROLLMENT_CONSENT_TYPES or PROVIDER_PROTECTIVE_CONSENT_TYPES.
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'lead_disclosure', acknowledged_via: 'parent_portal' },
        { type: 'firearms_disclosure', acknowledged_via: 'parent_portal' },
        { type: 'food_provider_agreement', acknowledged_via: 'parent_portal' },
        { type: 'health_condition', acknowledged_via: 'parent_portal' },
        { type: 'discipline_policy_receipt', acknowledged_via: 'parent_portal' },
      ],
    })
    // All enrollment + protective types still pending — none of the
    // intake rows match the ENROLLMENT_CONSENT_TYPES or
    // PROVIDER_PROTECTIVE_CONSENT_TYPES lists.
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
  })

  it('defensive — non-array input returns the empty-state pending verdict (every type still pending)', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: null })
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
    expect(v.enrollment_consents_expired).toEqual([])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
  })
})

// ─── Parity — provider helper aggregation vs parent-side aggregation ──
//
// cc-followup-consent-count-parity.md asked for a structural guard
// against the two paths drifting. After the refactor both call sites
// use `pendingEnrollmentConsentsForChild` directly, so divergence is
// architecturally impossible — but the test here is the safety net:
// given a representative fixture, the helper's set of children-
// affected-by-enrollment-pending must equal the parent-side
// aggregation's set. If a future edit replaces one path's call to the
// shared function with inline logic that gets the rule wrong, this
// test fails.

describe('parity — provider audit helper vs parent-side aggregation agree on children-affected', () => {
  it('the same fixture yields the same children-affected counts on both sides', async () => {
    // Fixture intent: focus on the field_trip + photo paths the
    // original parity test covered. Phase B (2026-06-01) added two
    // more licensing-required types, so we capture them via paper
    // for every child to keep them out of this fixture's scope —
    // a separate Phase B parity test below exercises the expired
    // path. The "captured both" children also capture Phase B; the
    // "pending field_trip" / "pending photo" children intentionally
    // leave the Phase B types pending so the only enrollment-block
    // pending differences track field_trip.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    mockState.children = [
      // kA — empty record → both blocks pending (field_trip + transport + water + photo)
      { id: 'kA', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kB — every enrollment consent cleared via paper, no photo row → only photo pending
      { id: 'kB', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kC — photo cleared via paper, NO field_trip + NO Phase B → enrollment block pending
      { id: 'kC', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kD — every enrollment consent paper + photo revoked paper → both blocks cleared
      { id: 'kD', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kE — every enrollment consent portal/paper + photo consent paper → both blocks cleared
      { id: 'kE', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      // kA: no rows
      // kB: all enrollment consents captured (field_trip + Phase B), photo missing
      { subject_id: 'kB', type: 'field_trip_permission',  acknowledged_via: 'in_person_paper' },
      { subject_id: 'kB', type: 'transportation_routine_annual',           acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'kB', type: 'water_activities_on_premises_seasonal',   acknowledged_via: 'in_person_paper', expires_at: farFuture },
      // kC: only photo captured (intentionally leave entire enrollment block pending)
      { subject_id: 'kC', type: 'photo_sharing_consent',  acknowledged_via: 'in_person_paper' },
      // kD: all enrollment consents captured + photo revoked
      { subject_id: 'kD', type: 'field_trip_permission',  acknowledged_via: 'in_person_paper' },
      { subject_id: 'kD', type: 'transportation_routine_annual',           acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'kD', type: 'water_activities_on_premises_seasonal',   acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'kD', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      // kE: all enrollment consents (mix of channels) + photo consent
      { subject_id: 'kE', type: 'field_trip_permission',  acknowledged_via: 'parent_portal' },
      { subject_id: 'kE', type: 'transportation_routine_annual',           acknowledged_via: 'parent_portal', expires_at: farFuture },
      { subject_id: 'kE', type: 'water_activities_on_premises_seasonal',   acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'kE', type: 'photo_sharing_consent',  acknowledged_via: 'in_person_paper' },
    ]

    // Provider-side aggregation (the helper's children-affected counts).
    const out = await getChildFilesAuditState('u1')

    // Parent-side aggregation — same group-by-child pattern the
    // ParentAcknowledgmentsPage tab badge and the
    // EnrollmentConsentsPendingBanner use post-refactor. Computed
    // INDEPENDENTLY of the helper, calling the same shared function.
    // Phase B (2026-06-01): both paths partition by expiry first via
    // `partitionAcksByExpiry`, so the parent-side aggregation also
    // splits its acks before feeding the verdict. Here every row has
    // a far-future expires_at (or NULL), so the partition puts
    // everything in activeAcks — same result as pre-Phase-B.
    const acksByChild = new Map()
    for (const a of mockState.acks) {
      let list = acksByChild.get(a.subject_id)
      if (!list) { list = []; acksByChild.set(a.subject_id, list) }
      list.push(a)
    }
    let parentChildrenAffected = 0
    let parentEnrollmentAffected = 0
    let parentProtectiveAffected = 0
    for (const k of mockState.children) {
      const v = pendingEnrollmentConsentsForChild({
        activeAcks: acksByChild.get(k.id) || [],
        expiredAcks: [],
      })
      if (v.any_pending) parentChildrenAffected += 1
      if (v.enrollment_consents_pending.length > 0) parentEnrollmentAffected += 1
      if (v.provider_protective_consents_pending.length > 0) parentProtectiveAffected += 1
    }

    // Fixture truth (post-Phase-B):
    //   kA pending all enrollment + photo
    //   kB enrollment fully captured, photo pending
    //   kC enrollment fully pending (3 types), photo captured
    //   kD all blocks cleared
    //   kE all blocks cleared
    //   → 3 children affected overall (kA, kB, kC)
    //   → 2 children pending ≥1 enrollment consent (kA, kC)
    //   → 2 children pending photo (kA, kB)
    expect(parentChildrenAffected).toBe(3)
    expect(parentEnrollmentAffected).toBe(2)
    expect(parentProtectiveAffected).toBe(2)

    // Helper agrees on every count.
    expect(out.children_with_pending_enrollment_consents_count).toBe(parentEnrollmentAffected)
    expect(out.children_with_pending_provider_protective_consents_count).toBe(parentProtectiveAffected)

    // Slot counts (post-Phase-B): kA + kC each have 3 enrollment
    // types pending = 6 slots. Photo: kA + kB = 2.
    expect(out.pending_enrollment_consents.field_trip_permission).toBe(2)
    expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(2)
    expect(out.pending_enrollment_consents.water_activities_on_premises_seasonal).toBe(2)
    expect(out.pending_enrollment_consents_count).toBe(6)
    expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(2)
    expect(out.pending_provider_protective_consents_count).toBe(2)
  })

  it('every-channel mix — both paths still agree', async () => {
    // A more pathological fixture: each child exercises a different
    // (channel × type × revocation) combination. The two paths must
    // still arrive at the same children-affected set. Phase B
    // (2026-06-01) captures Phase B types via paper for children that
    // were already "captured" pre-Phase-B (k4, k5), keeping the
    // fixture's enrollment-block focus on field_trip vs the Phase B
    // pending state.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    mockState.children = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map(id => ({
      id, intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01',
    }))
    mockState.acks = [
      // k1 — no rows → fully pending (every enrollment + photo)
      // k2 — field_trip paper + photo consent override → photo pending, Phase B pending
      { subject_id: 'k2', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k2', type: 'photo_sharing_consent', acknowledged_via: 'provider_override' },
      // k3 — field_trip override + photo revoked paper → field_trip pending, Phase B pending
      { subject_id: 'k3', type: 'field_trip_permission', acknowledged_via: 'provider_override' },
      { subject_id: 'k3', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      // k4 — all enrollment paper + photo paper → fully cleared
      { subject_id: 'k4', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k4', type: 'transportation_routine_annual',         acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'k4', type: 'water_activities_on_premises_seasonal', acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { subject_id: 'k4', type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      // k5 — all enrollment portal + photo portal → fully cleared
      { subject_id: 'k5', type: 'field_trip_permission', acknowledged_via: 'parent_portal' },
      { subject_id: 'k5', type: 'transportation_routine_annual',         acknowledged_via: 'parent_portal', expires_at: farFuture },
      { subject_id: 'k5', type: 'water_activities_on_premises_seasonal', acknowledged_via: 'parent_portal', expires_at: farFuture },
      { subject_id: 'k5', type: 'photo_sharing_consent', acknowledged_via: 'parent_portal' },
      // k6 — photo revocation via override (does NOT count) + nothing for enrollment → fully pending
      { subject_id: 'k6', type: 'photo_sharing_consent_revoked', acknowledged_via: 'provider_override' },
    ]

    const out = await getChildFilesAuditState('u1')

    const acksByChild = new Map()
    for (const a of mockState.acks) {
      let list = acksByChild.get(a.subject_id)
      if (!list) { list = []; acksByChild.set(a.subject_id, list) }
      list.push(a)
    }
    let any = 0
    let enr = 0
    let prot = 0
    for (const k of mockState.children) {
      const v = pendingEnrollmentConsentsForChild({
        activeAcks: acksByChild.get(k.id) || [],
        expiredAcks: [],
      })
      if (v.any_pending) any += 1
      if (v.enrollment_consents_pending.length > 0) enr += 1
      if (v.provider_protective_consents_pending.length > 0) prot += 1
    }

    // Expected pending children (post-Phase-B):
    //   k1 — every type pending
    //   k2 — field_trip cleared but Phase B + photo pending
    //   k3 — every enrollment type pending; photo cleared via revocation
    //   k4 — fully cleared
    //   k5 — fully cleared
    //   k6 — every type pending
    //   → enrollment-pending: k1, k2 (Phase B), k3 (all), k6 = 4
    //   → protective-pending: k1, k2, k6 = 3
    //   → any-pending: k1, k2, k3, k6 = 4
    expect(any).toBe(4)
    expect(enr).toBe(4)
    expect(prot).toBe(3)
    expect(out.children_with_pending_enrollment_consents_count).toBe(enr)
    expect(out.children_with_pending_provider_protective_consents_count).toBe(prot)
  })
})

// ─── photoConsentNeedsReminderForChild — messaging-reminder verdict ──
//
// Thin sibling over `pendingEnrollmentConsentsForChild` — used by
// MessageThreadPage to decide whether to show the non-blocking
// photo-consent reminder modal at attach/send time. Same channel +
// revocation-pair rule; no inline reimplementation. These cases pin
// the four behaviors the scope listed.

describe('photoConsentNeedsReminderForChild — messaging reminder verdict', () => {
  it('no consent record either way → reminder fires (true)', () => {
    expect(photoConsentNeedsReminderForChild({ activeAcks: [] })).toBe(true)
  })

  it('revoked via in_person_paper → reminder fires (true) — preference captured as no', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ],
    })).toBe(true)
  })

  it('revoked via parent_portal → reminder fires (true) — Phase B-ready', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'parent_portal' },
      ],
    })).toBe(true)
  })

  it('affirmative consent via in_person_paper → NO reminder (false)', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      ],
    })).toBe(false)
  })

  it('affirmative consent via parent_portal → NO reminder (false)', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'parent_portal' },
      ],
    })).toBe(false)
  })

  it('consent via provider_override only → reminder fires (true) — provider attestation does not satisfy the parent-signed rule', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'provider_override' },
      ],
    })).toBe(true)
  })

  it('revocation via provider_override only → reminder fires (true) — same parent-signed rule applies to revocations', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'provider_override' },
      ],
    })).toBe(true)
  })

  it('ignores unrelated intake-bundle acks (only photo_sharing rows enter the verdict)', () => {
    expect(photoConsentNeedsReminderForChild({
      activeAcks: [
        { type: 'lead_disclosure', acknowledged_via: 'parent_portal' },
        { type: 'firearms_disclosure', acknowledged_via: 'parent_portal' },
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ],
    })).toBe(true)
  })

  it('defensive — non-array input returns true (treat as no record captured)', () => {
    expect(photoConsentNeedsReminderForChild({ activeAcks: null })).toBe(true)
  })
})

// ─── Structural guard: messaging reminder uses the shared channel rule ──
//
// `photoConsentNeedsReminderForChild` deliberately diverges from
// `pendingEnrollmentConsentsForChild` on the revoked-state case: the
// audit helper counts revoked as "captured" (compliance-correct), but
// the messaging reminder fires for revoked (the case the provider most
// needs to be reminded of). The parity invariant being preserved is
// the CHANNEL RULE — both helpers consult
// `PARENT_SIGNED_SATISFYING_CHANNELS`, so a future change to the set
// of satisfying channels updates both helpers in lockstep.
//
// The test below uses an independent computation against the same
// channel constant. If a future edit hard-codes the channel list in
// `photoConsentNeedsReminderForChild` (forgetting parent_portal, say)
// the test fails.

describe('photoConsentNeedsReminderForChild — channel-rule parity', () => {
  it('agrees with the "active affirmative parent-signed photo_sharing_consent?" question for every fixture variant', () => {
    // Independent inline computation of the same predicate — uses the
    // same constant the helper does, so the test catches drift in the
    // helper's logic without re-encoding the channel rule.
    const SATISFYING = new Set(['parent_portal', 'in_person_paper'])
    const hasAffirmativeParentSigned = (acks) => {
      for (const a of acks || []) {
        if (a && a.type === 'photo_sharing_consent' && SATISFYING.has(a.acknowledged_via)) {
          return true
        }
      }
      return false
    }
    const fixtures = [
      { name: 'empty',                 acks: [] },
      { name: 'consent-paper',         acks: [{ type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' }] },
      { name: 'consent-portal',        acks: [{ type: 'photo_sharing_consent', acknowledged_via: 'parent_portal' }] },
      { name: 'consent-override',      acks: [{ type: 'photo_sharing_consent', acknowledged_via: 'provider_override' }] },
      { name: 'revoked-paper',         acks: [{ type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' }] },
      { name: 'revoked-portal',        acks: [{ type: 'photo_sharing_consent_revoked', acknowledged_via: 'parent_portal' }] },
      { name: 'revoked-override',      acks: [{ type: 'photo_sharing_consent_revoked', acknowledged_via: 'provider_override' }] },
      { name: 'consent+revoked-paper', acks: [
        { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
        { type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ] },
    ]
    for (const f of fixtures) {
      const wrapperSaysReminder = photoConsentNeedsReminderForChild({ activeAcks: f.acks })
      const expectedReminder = !hasAffirmativeParentSigned(f.acks)
      expect(wrapperSaysReminder, `disagreement on fixture "${f.name}"`).toBe(expectedReminder)
    }
  })

  // The wrapper deliberately diverges from the audit verdict on revoked
  // state — pin both behaviors so a future "let's just call
  // pendingEnrollmentConsentsForChild instead" refactor fails this
  // test and the divergence stays explicit.
  it('diverges from pendingEnrollmentConsentsForChild on the revoked-via-paper case (intentional)', () => {
    const acks = [{ type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' }]
    const auditVerdict = pendingEnrollmentConsentsForChild({ activeAcks: acks })
    const photoIsAuditCaptured = !auditVerdict.provider_protective_consents_pending.includes('photo_sharing_consent')
    const reminderFires = photoConsentNeedsReminderForChild({ activeAcks: acks })

    // Audit helper says "captured" (preference recorded, as a no).
    expect(photoIsAuditCaptured).toBe(true)
    // Messaging reminder says "fire" (parent said no — most important
    // case to remind about).
    expect(reminderFires).toBe(true)
  })
})

// ─── Consents Phase B (2026-06-01) — time-bound recurring consents ──
//
// Exercises the expiry-aware verdict, the cadence write helper, the
// caller-side partition helper, and the audit-state expired-counts
// rollup. Verdict stays pure (no now() inside); the caller does
// every wall-clock comparison.

describe('Phase B cadence — computePhaseBExpiresAt', () => {
  it('returns acknowledged_at + 1 year (UTC) for a string input', () => {
    const out = computePhaseBExpiresAt('2026-06-01T12:00:00.000Z')
    expect(out).toBe('2027-06-01T12:00:00.000Z')
  })

  it('handles Date input identically to ISO-string input', () => {
    const d = new Date('2026-06-01T12:00:00.000Z')
    expect(computePhaseBExpiresAt(d)).toBe('2027-06-01T12:00:00.000Z')
  })

  it('handles leap-day edge case (Feb 29 + 1y = Feb 29 next year only when leap)', () => {
    // 2024 was leap; 2025 was not. setUTCFullYear(year+1) on Feb 29
    // 2024 rolls to Mar 1 2025 in JavaScript's Date semantics.
    const out = computePhaseBExpiresAt('2024-02-29T00:00:00.000Z')
    // Implementation-defined behavior — accept either Feb-28-2025 or
    // Mar-1-2025; assert the year and a plausible month.
    const d = new Date(out)
    expect(d.getUTCFullYear()).toBe(2025)
  })

  it('TIME_BOUND_TYPES enumerates exactly the two Phase B types', () => {
    expect([...TIME_BOUND_TYPES].sort()).toEqual([
      'transportation_routine_annual',
      'water_activities_on_premises_seasonal',
    ])
  })
})

describe('partitionAcksByExpiry — caller-side expiry split', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z')

  it('rows with NULL expires_at land in activeAcks (Phase A behavior preserved)', () => {
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({
      rows: [
        { type: 'field_trip_permission', expires_at: null },
        { type: 'photo_sharing_consent' /* expires_at undefined */ },
      ],
      now: NOW,
    })
    expect(activeAcks.map(r => r.type).sort()).toEqual(
      ['field_trip_permission', 'photo_sharing_consent']
    )
    expect(expiredAcks).toEqual([])
  })

  it('rows with future expires_at land in activeAcks', () => {
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({
      rows: [
        { type: 'transportation_routine_annual', expires_at: '2027-06-01T12:00:00.000Z' },
      ],
      now: NOW,
    })
    expect(activeAcks).toHaveLength(1)
    expect(expiredAcks).toEqual([])
  })

  it('rows with past expires_at land in expiredAcks', () => {
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({
      rows: [
        { type: 'transportation_routine_annual', expires_at: '2025-06-01T12:00:00.000Z' },
      ],
      now: NOW,
    })
    expect(activeAcks).toEqual([])
    expect(expiredAcks).toHaveLength(1)
  })

  it('rows with expires_at === now() land in expiredAcks (boundary: > now() is the active rule)', () => {
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({
      rows: [
        { type: 'transportation_routine_annual', expires_at: NOW.toISOString() },
      ],
      now: NOW,
    })
    expect(activeAcks).toEqual([])
    expect(expiredAcks).toHaveLength(1)
  })

  it('non-array input is tolerated (defensive)', () => {
    expect(partitionAcksByExpiry({ rows: null, now: NOW }))
      .toEqual({ activeAcks: [], expiredAcks: [] })
  })
})

describe('pendingEnrollmentConsentsForChild — Phase B expired state', () => {
  it('transport expired-via-paper → reports as expired, NOT pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [],
      expiredAcks: [
        { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      // transport NOT in pending — it's in expired.
      'water_activities_on_premises_seasonal',
    ])
    expect(v.enrollment_consents_expired).toEqual(['transportation_routine_annual'])
    expect(v.any_pending).toBe(true)
  })

  it('water expired-via-portal → reports as expired, NOT pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [],
      expiredAcks: [
        { type: 'water_activities_on_premises_seasonal', acknowledged_via: 'parent_portal' },
      ],
    })
    expect(v.enrollment_consents_expired).toEqual(['water_activities_on_premises_seasonal'])
  })

  it('expired-via-provider_override → NEITHER pending NOR expired logic counts it (parent never signed); type stays pending', () => {
    // An expired provider_override row is "the provider attested
    // something a year ago that lapsed" — the parent never signed in
    // the first place. The verdict treats this as never-captured.
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [],
      expiredAcks: [
        { type: 'transportation_routine_annual', acknowledged_via: 'provider_override' },
      ],
    })
    expect(v.enrollment_consents_pending).toContain('transportation_routine_annual')
    expect(v.enrollment_consents_expired).toEqual([])
  })

  it('current valid row wins over an expired row of the same type (renewed → not expired)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper' },
      ],
      expiredAcks: [
        // An older row of the same type that lapsed before the renewal
        // (would normally be archived; the partition helper would have
        // returned it as expired if it weren't yet archived).
        { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([
      'field_trip_permission',
      'water_activities_on_premises_seasonal',
    ])
    expect(v.enrollment_consents_expired).toEqual([])
  })

  it('omitting expiredAcks (Phase A callers) returns the pre-Phase-B shape', () => {
    // Phase A callers that pass only activeAcks (no expiredAcks) get
    // an empty expired array and identical pending semantics.
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_expired).toEqual([])
    expect(v.any_pending).toBe(true) // Phase B types still pending.
  })
})

describe('getChildFilesAuditState — Phase B expiry rollup', () => {
  it('transport captured fresh (future expires_at) → on file; no expired count', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: farFuture },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(0)
    expect(out.pending_enrollment_consents_expired.transportation_routine_annual).toBe(0)
    expect(out.pending_enrollment_consents_expired_count).toBe(0)
  })

  it('transport captured but expired (past expires_at) → expired count = 1, pending count for this type = 0', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: dayAgo },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(0)
    expect(out.pending_enrollment_consents_expired.transportation_routine_annual).toBe(1)
    expect(out.pending_enrollment_consents_expired_count).toBe(1)
    // children_with_pending_enrollment_consents_count includes expired
    // children (any compliance gap).
    expect(out.children_with_pending_enrollment_consents_count).toBe(1)
  })

  it('two children, transport expired vs current → only the expired one is in the expired bucket', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: dayAgo },
      { subject_id: 'k2', type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: farFuture },
    ]
    const out = await getChildFilesAuditState('u1')
    // For transport: k1 expired (1 slot in expired), k2 currently
    // valid (0 slots in pending; the verdict puts a captured-but-
    // lapsed type in `_expired`, not `_pending`, AND a currently-valid
    // type in neither).
    expect(out.pending_enrollment_consents_expired.transportation_routine_annual).toBe(1)
    expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(0)
    // Both children still affected because they're each missing 2 of
    // the other Phase B types (water + field_trip) — children-affected
    // captures any compliance gap.
    expect(out.children_with_pending_enrollment_consents_count).toBe(2)
  })

  it('an expired provider_override row stays in the pending bucket (parent never signed)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_routine_annual', acknowledged_via: 'provider_override', expires_at: dayAgo },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_enrollment_consents.transportation_routine_annual).toBe(1)
    expect(out.pending_enrollment_consents_expired.transportation_routine_annual).toBe(0)
  })

  it('Phase A types remain unaffected by Phase B expiry — backward-compat invariant', async () => {
    // field_trip_permission has no expires_at; the row should read
    // identically before and after Phase B. This test pins the
    // backward-compat invariant from §8 of pr-consents-B-scope.md.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper', expires_at: null },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_enrollment_consents.field_trip_permission).toBe(0)
    expect(out.pending_enrollment_consents_expired.field_trip_permission).toBe(0)
  })
})

describe('Phase B renewal protocol — archive-then-insert state transitions', () => {
  // These tests exercise the verdict + partition surfaces with the
  // exact row shapes the renewal flow produces. The renewal logic
  // itself lives in EnrollmentConsentsModal (provider modal, decision
  // 9); these tests pin that the verdict reports each transition
  // correctly so the modal's render branches stay accurate.
  const NOW = new Date('2026-12-01T12:00:00.000Z')

  it('initial capture: one active row, expires_at + 1y → currently satisfied', () => {
    const rows = [
      // The just-inserted row from the modal's initial-capture path.
      {
        type: 'transportation_routine_annual',
        acknowledged_via: 'in_person_paper',
        archived_at: null,
        expires_at: '2027-12-01T12:00:00.000Z',
      },
    ]
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows, now: NOW })
    const v = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
    expect(v.enrollment_consents_pending).not.toContain('transportation_routine_annual')
    expect(v.enrollment_consents_expired).not.toContain('transportation_routine_annual')
  })

  it('expired-but-not-archived state: row past expires_at, archived_at still NULL → reports as expired', () => {
    const rows = [
      {
        type: 'transportation_routine_annual',
        acknowledged_via: 'in_person_paper',
        archived_at: null,
        expires_at: '2025-12-01T12:00:00.000Z', // 1y before NOW
      },
    ]
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows, now: NOW })
    const v = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
    expect(v.enrollment_consents_expired).toContain('transportation_routine_annual')
    expect(v.enrollment_consents_pending).not.toContain('transportation_routine_annual')
    expect(v.any_pending).toBe(true)
  })

  it('renewal complete: prior row archived (caller filters), new row active → reports as satisfied', () => {
    // Post-renewal, the partition helper sees only the rows the audit
    // path's Supabase query returns (filtered by archived_at IS NULL).
    // The archived prior row is excluded by the DB filter; only the
    // new row reaches the verdict.
    const rows = [
      {
        type: 'transportation_routine_annual',
        acknowledged_via: 'in_person_paper',
        archived_at: null,
        expires_at: '2027-12-01T12:00:00.000Z',
      },
    ]
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows, now: NOW })
    const v = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
    expect(v.enrollment_consents_pending).not.toContain('transportation_routine_annual')
    expect(v.enrollment_consents_expired).not.toContain('transportation_routine_annual')
  })

  it('early renewal: archive-then-insert produces exactly one active row with a fresh expires_at', () => {
    // The modal archives the prior row immediately (no coexistence
    // period — decision 8). After renewal the audit query returns
    // ONLY the new row. This test pins that semantic.
    const priorAtExpiry = '2027-03-01T12:00:00.000Z'  // future at NOW
    const renewedExpiry = '2027-12-01T12:00:00.000Z'
    // Audit query post-renewal: prior is archived, only the new row
    // is in the result set.
    const rows = [
      {
        type: 'transportation_routine_annual',
        acknowledged_via: 'in_person_paper',
        archived_at: null,
        expires_at: renewedExpiry,
      },
    ]
    const { activeAcks } = partitionAcksByExpiry({ rows, now: NOW })
    expect(activeAcks).toHaveLength(1)
    expect(activeAcks[0].expires_at).toBe(renewedExpiry)
    // Sanity: priorAtExpiry is in the future at NOW (i.e., early
    // renewal really is "renewing before lapse").
    expect(Date.parse(priorAtExpiry)).toBeGreaterThan(NOW.getTime())
  })
})

// ─── Consents Phase C (2026-06-01) — per-occurrence consents ──
//
// Exercises the verdict exclusion (per-occurrence types are NOT in
// the pending/expired rollup — a child with no recorded trips is NOT
// non-compliant), the metadata helpers (single source of truth for
// the jsonb shape; throw on missing required fields; strip unknown
// keys), the audit-state rollup (per_occurrence_consents_recorded
// counts distinct children per type), and the backward-compat
// invariant (durable types and existing rows unaffected).

const {
  PER_OCCURRENCE_CONSENT_TYPES,
  WATER_BODY_TYPE_OPTIONS,
  buildTransportNonroutineOccurrenceMetadata,
  buildWaterOffPremisesOccurrenceMetadata,
} = await import('./childFiles')

describe('Phase C constants — PER_OCCURRENCE_CONSENT_TYPES', () => {
  it('enumerates exactly the two per-occurrence types', () => {
    expect([...PER_OCCURRENCE_CONSENT_TYPES].sort()).toEqual([
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip',
    ])
  })

  it('water-body-type options match the helper enum', () => {
    expect([...WATER_BODY_TYPE_OPTIONS]).toEqual([
      'pool', 'lake', 'pond', 'river', 'beach', 'other',
    ])
  })
})

describe('Phase C metadata helpers — single source of truth', () => {
  describe('buildTransportNonroutineOccurrenceMetadata', () => {
    it('returns the validated shape for the happy path', () => {
      const out = buildTransportNonroutineOccurrenceMetadata({
        trip_date: '2026-07-15',
        destination: 'Public library',
        purpose: 'Story time',
        vehicle_description: "Provider's minivan",
        estimated_return: '2026-07-15T12:00:00Z',
      })
      expect(out).toEqual({
        trip_date: '2026-07-15',
        destination: 'Public library',
        purpose: 'Story time',
        vehicle_description: "Provider's minivan",
        estimated_return: '2026-07-15T12:00:00Z',
      })
    })

    it('throws on missing required field (trip_date)', () => {
      expect(() => buildTransportNonroutineOccurrenceMetadata({
        destination: 'Library',
      })).toThrow(/trip_date/)
    })

    it('throws on missing required field (destination)', () => {
      expect(() => buildTransportNonroutineOccurrenceMetadata({
        trip_date: '2026-07-15',
      })).toThrow(/destination/)
    })

    it('throws on blank required field', () => {
      expect(() => buildTransportNonroutineOccurrenceMetadata({
        trip_date: '2026-07-15',
        destination: '   ',
      })).toThrow(/destination/)
    })

    it('omits empty optional fields rather than carrying them as blank strings', () => {
      const out = buildTransportNonroutineOccurrenceMetadata({
        trip_date: '2026-07-15',
        destination: 'Library',
        purpose: '',
        vehicle_description: '   ',
      })
      expect(out).toEqual({
        trip_date: '2026-07-15',
        destination: 'Library',
      })
    })

    it('strips unknown keys (defense against field-name typos at call sites)', () => {
      const out = buildTransportNonroutineOccurrenceMetadata({
        trip_date: '2026-07-15',
        destination: 'Library',
        tripDate: '2026-08-20',   // typo: camelCase, should be silently dropped
        random: 'noise',
      })
      expect(out).not.toHaveProperty('tripDate')
      expect(out).not.toHaveProperty('random')
      expect(out.trip_date).toBe('2026-07-15')
    })

    it('trims string values', () => {
      const out = buildTransportNonroutineOccurrenceMetadata({
        trip_date: '  2026-07-15  ',
        destination: '  Library  ',
      })
      expect(out.trip_date).toBe('2026-07-15')
      expect(out.destination).toBe('Library')
    })
  })

  describe('buildWaterOffPremisesOccurrenceMetadata', () => {
    it('returns the validated shape for the happy path', () => {
      const out = buildWaterOffPremisesOccurrenceMetadata({
        outing_date: '2026-08-10',
        water_body_type: 'pool',
        location: 'Community Pool',
        address: '123 Main St',
        supervising_adult: 'Provider',
      })
      expect(out).toEqual({
        outing_date: '2026-08-10',
        water_body_type: 'pool',
        location: 'Community Pool',
        address: '123 Main St',
        supervising_adult: 'Provider',
      })
    })

    it('throws on missing required field (water_body_type)', () => {
      expect(() => buildWaterOffPremisesOccurrenceMetadata({
        outing_date: '2026-08-10',
        location: 'Pool',
      })).toThrow(/water_body_type/)
    })

    it('throws on water_body_type outside the enum', () => {
      expect(() => buildWaterOffPremisesOccurrenceMetadata({
        outing_date: '2026-08-10',
        water_body_type: 'aquifer',
        location: 'Pool',
      })).toThrow(/water_body_type must be one of/)
    })

    it('accepts every enum value', () => {
      for (const t of WATER_BODY_TYPE_OPTIONS) {
        const out = buildWaterOffPremisesOccurrenceMetadata({
          outing_date: '2026-08-10',
          water_body_type: t,
          location: 'X',
        })
        expect(out.water_body_type).toBe(t)
      }
    })
  })
})

describe('Phase C verdict — per-occurrence types excluded from pending/expired', () => {
  it('a child with NO rows of any type → per-occurrence types do NOT appear in enrollment_consents_pending', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: [], expiredAcks: [] })
    expect(v.enrollment_consents_pending).not.toContain('transportation_nonroutine_per_trip')
    expect(v.enrollment_consents_pending).not.toContain('water_activities_off_premises_per_trip')
    expect(v.enrollment_consents_expired).not.toContain('transportation_nonroutine_per_trip')
    expect(v.enrollment_consents_expired).not.toContain('water_activities_off_premises_per_trip')
  })

  it('a child with multiple active per-occurrence rows → still not in pending/expired (event records, not enrollment state)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
        { type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
        { type: 'water_activities_off_premises_per_trip', acknowledged_via: 'in_person_paper' },
      ],
      expiredAcks: [],
    })
    expect(v.enrollment_consents_pending).not.toContain('transportation_nonroutine_per_trip')
    expect(v.enrollment_consents_pending).not.toContain('water_activities_off_premises_per_trip')
    expect(v.enrollment_consents_expired).not.toContain('transportation_nonroutine_per_trip')
  })

  it('a child with every durable consent captured AND per-occurrence rows → any_pending=false', () => {
    // The any_pending verdict must NOT trip just because per-occurrence
    // rows exist. The presence of trip consents is not a compliance gap.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const rows = [
      { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { type: 'water_activities_on_premises_seasonal', acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      // Per-occurrence rows — must NOT trigger any_pending.
      { type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
      { type: 'water_activities_off_premises_per_trip', acknowledged_via: 'in_person_paper' },
    ]
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows, now: new Date() })
    const v = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
    expect(v.any_pending).toBe(false)
  })

  it('absent per-occurrence rows do NOT mark a child non-compliant (the perpetual-pending failure mode)', () => {
    // This is the decision-5 failure-mode test: a child with every
    // durable consent captured BUT no per-occurrence rows must read
    // as any_pending=false. Phase C's exclusion is what prevents the
    // perpetual-pending bug.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const rows = [
      { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { type: 'transportation_routine_annual', acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { type: 'water_activities_on_premises_seasonal', acknowledged_via: 'in_person_paper', expires_at: farFuture },
      { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      // NO per-occurrence rows — child has had no trips this year.
    ]
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows, now: new Date() })
    const v = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
    expect(v.any_pending).toBe(false)
    expect(v.enrollment_consents_pending).toEqual([])
    expect(v.enrollment_consents_expired).toEqual([])
  })
})

describe('getChildFilesAuditState — Phase C per-occurrence rollup', () => {
  it('empty acks → per_occurrence_consents_recorded zero for both types', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(out.per_occurrence_consents_recorded).toEqual({
      transportation_nonroutine_per_trip: 0,
      water_activities_off_premises_per_trip: 0,
    })
  })

  it('one child with two transport-trip rows → contributes 1 to the type (distinct children, not row count)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k1', type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
    ]
    const out = await getChildFilesAuditState('u1')
    // Distinct-child count: 1 (not 2). Multiple trips per child do
    // not inflate the rollup.
    expect(out.per_occurrence_consents_recorded.transportation_nonroutine_per_trip).toBe(1)
    expect(out.per_occurrence_consents_recorded.water_activities_off_premises_per_trip).toBe(0)
  })

  it('two children with mixed per-occurrence rows → distinct-child counts per type', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      { id: 'k2', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k2', type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k2', type: 'water_activities_off_premises_per_trip', acknowledged_via: 'in_person_paper' },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.per_occurrence_consents_recorded.transportation_nonroutine_per_trip).toBe(2)
    expect(out.per_occurrence_consents_recorded.water_activities_off_premises_per_trip).toBe(1)
  })

  it('per-occurrence rows do NOT count toward children_with_pending_enrollment_consents_count', async () => {
    // Even if a child has only per-occurrence rows (no durable
    // enrollment consents), the child is NOT counted as "pending"
    // for enrollment-consent purposes. The per-occurrence rollup is
    // orthogonal to the pending/expired rollup.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      { subject_id: 'k1', type: 'transportation_nonroutine_per_trip', acknowledged_via: 'in_person_paper' },
    ]
    const out = await getChildFilesAuditState('u1')
    // The child IS counted as pending because field_trip_permission
    // is missing (durable Phase A type, not satisfied).
    expect(out.children_with_pending_enrollment_consents_count).toBe(1)
    // But the per-occurrence type is NOT in the pending breakdown —
    // not even as a zero-key.
    expect(out.pending_enrollment_consents).not.toHaveProperty('transportation_nonroutine_per_trip')
    expect(out.pending_enrollment_consents).not.toHaveProperty('water_activities_off_premises_per_trip')
  })

  it('per-occurrence breakdown shape is stable (both keys always present, initialized to 0)', async () => {
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(Object.keys(out.per_occurrence_consents_recorded).sort()).toEqual([
      'transportation_nonroutine_per_trip',
      'water_activities_off_premises_per_trip',
    ])
  })
})

describe('Phase C — backward compatibility', () => {
  it('durable types remain in enrollment_consents_pending (Phase A + B unaffected by Phase C)', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: [], expiredAcks: [] })
    expect(v.enrollment_consents_pending).toEqual(
      expect.arrayContaining([
        'field_trip_permission',
        'transportation_routine_annual',
        'water_activities_on_premises_seasonal',
      ])
    )
  })

  it('rows with NULL occurrence_metadata are unaffected (Phase A/B rows untouched)', async () => {
    // A pre-Phase-C row with NULL occurrence_metadata is the
    // backward-compat scenario. The audit-state must read it
    // identically to before Phase C.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      // A typical Phase A row — no expires_at, no occurrence_metadata.
      {
        subject_id: 'k1',
        type: 'field_trip_permission',
        acknowledged_via: 'in_person_paper',
        expires_at: null,
        occurrence_metadata: null,
      },
    ]
    const out = await getChildFilesAuditState('u1')
    expect(out.pending_enrollment_consents.field_trip_permission).toBe(0)
    expect(out.pending_enrollment_consents_expired.field_trip_permission).toBe(0)
    expect(out.per_occurrence_consents_recorded.transportation_nonroutine_per_trip).toBe(0)
  })
})
