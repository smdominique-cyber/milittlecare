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

const { getChildFilesAuditState, pendingEnrollmentConsentsForChild } =
  await import('./childFiles')

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
function emptyEnrollmentConsentsBreakdown() {
  return { field_trip_permission: 0 }
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
    })
  })

  it('matches the documented shape exactly (no extra keys)', async () => {
    // Profile premises answered → firearms is in the required set →
    // firearms counts toward the rollup. With one child and no acks,
    // every always-required parent-signed type is pending (6 total
    // after the 2026-05-29 licensing_rules_offered addition). Consents
    // Phase A (2026-05-30) added six new top-level keys.
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
      'pending_enrollment_consents',
      'pending_enrollment_consents_count',
      'pending_lead_disclosures_count',
      'pending_parent_signatures',
      'pending_parent_signatures_count',
      'pending_provider_protective_consents',
      'pending_provider_protective_consents_count',
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
    it('pending when no record exists (1 child, empty acks → 1 slot, 1 child affected)', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = []
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(1)
      expect(out.pending_enrollment_consents_count).toBe(1)
      expect(out.children_with_pending_enrollment_consents_count).toBe(1)
    })

    it('cleared by in_person_paper record', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_enrollment_consents.field_trip_permission).toBe(0)
      expect(out.pending_enrollment_consents_count).toBe(0)
      expect(out.children_with_pending_enrollment_consents_count).toBe(0)
    })

    it('cleared by parent_portal record (reserved for Phase B; the channel rule already supports it)', async () => {
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
        // Full intake bundle (parent_portal) but NO field_trip / no photo consent.
        { subject_id: 'k1', type: 'child_in_care_statement', acknowledged_via: 'parent_portal' },
        ...['lead_disclosure', 'firearms_disclosure', 'food_provider_agreement',
            'licensing_notebook_offered', 'licensing_rules_offered',
            'health_condition', 'discipline_policy_receipt']
          .map(t => ({ subject_id: 'k1', type: t, acknowledged_via: 'parent_portal' })),
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures_count).toBe(0)              // intake fully cleared
      expect(out.pending_enrollment_consents_count).toBe(1)            // field_trip still pending
      expect(out.pending_provider_protective_consents_count).toBe(1)   // photo still pending
    })

    it('mixed: intake satisfied, field_trip satisfied, photo revoked — every block reads as captured', async () => {
      mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
      mockState.children = [
        { id: 'k1', intake_completed_at: '2026-05-30T12:00:00Z', records_last_reviewed_on: '2026-05-30', date_of_birth: '2024-01-01' },
      ]
      mockState.acks = [
        ...['firearms_disclosure', 'food_provider_agreement',
            'licensing_notebook_offered', 'licensing_rules_offered',
            'health_condition', 'discipline_policy_receipt']
          .map(t => ({ subject_id: 'k1', type: t, acknowledged_via: 'in_person_paper' })),
        { subject_id: 'k1', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
        { subject_id: 'k1', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      ]
      const out = await getChildFilesAuditState('u1')
      expect(out.pending_parent_signatures_count).toBe(0)
      expect(out.pending_enrollment_consents_count).toBe(0)
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
  it('no record → both buckets pending', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: [] })
    expect(v.enrollment_consents_pending).toEqual(['field_trip_permission'])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
    expect(v.any_pending).toBe(true)
  })

  it('field_trip consent via in_person_paper → enrollment block cleared; photo still pending', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
    expect(v.any_pending).toBe(true)
  })

  it('field_trip consent via parent_portal → enrollment block cleared (Phase B-ready)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'parent_portal' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([])
  })

  it('field_trip consent via provider_override → DOES NOT clear (parent has not signed)', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'provider_override' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual(['field_trip_permission'])
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

  it('both blocks satisfied → any_pending = false', () => {
    const v = pendingEnrollmentConsentsForChild({
      activeAcks: [
        { type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
        { type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      ],
    })
    expect(v.enrollment_consents_pending).toEqual([])
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
    // Field trip + photo still pending — none of the above match.
    expect(v.enrollment_consents_pending).toEqual(['field_trip_permission'])
    expect(v.provider_protective_consents_pending).toEqual(['photo_sharing_consent'])
  })

  it('defensive — non-array input returns the empty-state pending verdict (every type still pending)', () => {
    const v = pendingEnrollmentConsentsForChild({ activeAcks: null })
    expect(v.enrollment_consents_pending).toEqual(['field_trip_permission'])
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
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      // kA — empty record → both pending
      { id: 'kA', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kB — field_trip cleared via paper, no photo row → only photo pending
      { id: 'kB', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kC — photo cleared via paper, no field_trip row → only field_trip pending
      { id: 'kC', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kD — field_trip paper + photo revoked paper → both cleared
      { id: 'kD', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
      // kE — field_trip portal + photo consent paper → both cleared
      { id: 'kE', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = [
      // kA: no rows
      { subject_id: 'kB', type: 'field_trip_permission',  acknowledged_via: 'in_person_paper' },
      { subject_id: 'kC', type: 'photo_sharing_consent',  acknowledged_via: 'in_person_paper' },
      { subject_id: 'kD', type: 'field_trip_permission',  acknowledged_via: 'in_person_paper' },
      { subject_id: 'kD', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      { subject_id: 'kE', type: 'field_trip_permission',  acknowledged_via: 'parent_portal' },
      { subject_id: 'kE', type: 'photo_sharing_consent',  acknowledged_via: 'in_person_paper' },
    ]

    // Provider-side aggregation (the helper's children-affected counts).
    const out = await getChildFilesAuditState('u1')

    // Parent-side aggregation — same group-by-child pattern the
    // ParentAcknowledgmentsPage tab badge and the
    // EnrollmentConsentsPendingBanner use post-refactor. Computed
    // INDEPENDENTLY of the helper, calling the same shared function.
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
      })
      if (v.any_pending) parentChildrenAffected += 1
      if (v.enrollment_consents_pending.length > 0) parentEnrollmentAffected += 1
      if (v.provider_protective_consents_pending.length > 0) parentProtectiveAffected += 1
    }

    // Fixture truth:
    //   kA pending both, kB pending photo only, kC pending field_trip only,
    //   kD captured both, kE captured both.
    //   → 3 children affected overall (kA, kB, kC)
    //   → 2 children pending field_trip (kA, kC)
    //   → 2 children pending photo    (kA, kB)
    expect(parentChildrenAffected).toBe(3)
    expect(parentEnrollmentAffected).toBe(2)
    expect(parentProtectiveAffected).toBe(2)

    // Helper agrees on every count.
    expect(out.children_with_pending_enrollment_consents_count).toBe(parentEnrollmentAffected)
    expect(out.children_with_pending_provider_protective_consents_count).toBe(parentProtectiveAffected)

    // And the helper's breakdowns / slot counts match the same logic.
    expect(out.pending_enrollment_consents.field_trip_permission).toBe(2)
    expect(out.pending_enrollment_consents_count).toBe(2)
    expect(out.pending_provider_protective_consents.photo_sharing_consent).toBe(2)
    expect(out.pending_provider_protective_consents_count).toBe(2)
  })

  it('every-channel mix — both paths still agree', async () => {
    // A more pathological fixture: each child exercises a different
    // (channel × type × revocation) combination. The two paths must
    // still arrive at the same children-affected set.
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map(id => ({
      id, intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01',
    }))
    mockState.acks = [
      // k1 — no rows → fully pending
      // k2 — field_trip paper + photo consent override → photo still pending
      { subject_id: 'k2', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k2', type: 'photo_sharing_consent', acknowledged_via: 'provider_override' },
      // k3 — field_trip override + photo revoked paper → field_trip still pending
      { subject_id: 'k3', type: 'field_trip_permission', acknowledged_via: 'provider_override' },
      { subject_id: 'k3', type: 'photo_sharing_consent_revoked', acknowledged_via: 'in_person_paper' },
      // k4 — both via paper → cleared
      { subject_id: 'k4', type: 'field_trip_permission', acknowledged_via: 'in_person_paper' },
      { subject_id: 'k4', type: 'photo_sharing_consent', acknowledged_via: 'in_person_paper' },
      // k5 — both via portal → cleared (Phase B-ready)
      { subject_id: 'k5', type: 'field_trip_permission', acknowledged_via: 'parent_portal' },
      { subject_id: 'k5', type: 'photo_sharing_consent', acknowledged_via: 'parent_portal' },
      // k6 — photo revocation via override (does NOT count) + nothing for field_trip → fully pending
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
      })
      if (v.any_pending) any += 1
      if (v.enrollment_consents_pending.length > 0) enr += 1
      if (v.provider_protective_consents_pending.length > 0) prot += 1
    }

    // Expected pending children: k1 (both), k2 (photo), k3 (field_trip), k6 (both)
    //   → enrollment-pending: k1, k3, k6 = 3
    //   → protective-pending: k1, k2, k6 = 3
    //   → any-pending: k1, k2, k3, k6 = 4
    expect(any).toBe(4)
    expect(enr).toBe(3)
    expect(prot).toBe(3)
    expect(out.children_with_pending_enrollment_consents_count).toBe(enr)
    expect(out.children_with_pending_provider_protective_consents_count).toBe(prot)
  })
})
