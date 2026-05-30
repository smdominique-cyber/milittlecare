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

const { getChildFilesAuditState } = await import('./childFiles')

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
    })
  })

  it('matches the documented shape exactly (no extra keys)', async () => {
    // Profile premises answered → firearms is in the required set →
    // firearms counts toward the rollup. With one child and no acks,
    // every always-required parent-signed type is pending (6 total
    // after the 2026-05-29 licensing_rules_offered addition).
    mockState.profile = { home_built_before_1978: false, firearms_on_premises: false }
    mockState.children = [
      { id: 'c1', intake_completed_at: null, records_last_reviewed_on: null, date_of_birth: '2024-01-01' },
    ]
    mockState.acks = []
    const out = await getChildFilesAuditState('u1')
    expect(Object.keys(out).sort()).toEqual([
      'active_children_count',
      'annual_review_overdue_count',
      'children_with_pending_parent_signatures_count',
      'domain',
      'intake_complete_count',
      'intake_incomplete_count',
      'pending_lead_disclosures_count',
      'pending_parent_signatures',
      'pending_parent_signatures_count',
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
