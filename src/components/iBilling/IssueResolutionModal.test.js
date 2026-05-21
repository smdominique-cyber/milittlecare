import { describe, it, expect } from 'vitest'
import { issueMatchKey, buildOverrideIndex } from './IssueResolutionModal'

describe('issueMatchKey', () => {
  it('builds a stable key including ruleId, childId, date, segmentIndex', () => {
    const k = issueMatchKey({
      ruleId: 'rule_8_missing_parent_initials',
      childId: 'kid-1',
      date: '2026-05-05',
      segmentIndex: 1,
    })
    expect(k).toBe('rule_8_missing_parent_initials|kid-1|2026-05-05|1')
  })

  it('tolerates missing fields with empty-string placeholders', () => {
    expect(issueMatchKey({ ruleId: 'rule_9_missing_provider_name' }))
      .toBe('rule_9_missing_provider_name|||')
  })

  it('returns empty string for null input', () => {
    expect(issueMatchKey(null)).toBe('')
  })
})

describe('buildOverrideIndex', () => {
  it('emits a (ruleId, childId, "", "") key for child-level overrides', () => {
    const idx = buildOverrideIndex([
      { rule_id: 'rule_6_billing_during_school_hours', child_id: 'kid-1' },
    ])
    expect(idx.has('rule_6_billing_during_school_hours|kid-1||')).toBe(true)
  })

  it('also emits the cell-level key when date+segment are present', () => {
    const idx = buildOverrideIndex([
      { rule_id: 'rule_6_billing_during_school_hours',
        child_id: 'kid-1', date: '2026-05-05', segment_index: 0 },
    ])
    expect(idx.has('rule_6_billing_during_school_hours|kid-1|2026-05-05|0')).toBe(true)
    // And the broader child-level key.
    expect(idx.has('rule_6_billing_during_school_hours|kid-1||')).toBe(true)
  })

  it('emits a provider-level key (empty childId) for provider overrides', () => {
    const idx = buildOverrideIndex([
      { rule_id: 'rule_9_missing_provider_name', child_id: null },
    ])
    expect(idx.has('rule_9_missing_provider_name|||')).toBe(true)
  })

  it('returns an empty set for null / non-array input', () => {
    expect(buildOverrideIndex(null).size).toBe(0)
    expect(buildOverrideIndex().size).toBe(0)
  })
})
