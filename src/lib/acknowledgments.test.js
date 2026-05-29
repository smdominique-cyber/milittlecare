import { describe, it, expect } from 'vitest'
import {
  ACK_TYPES,
  CHILD_IN_CARE_SUB_TYPES,
  arePremisesAnsweredForIntake,
  canonicalForHash,
  fnv1a32Hex,
  computeAckHash,
  computeEnvelopeHash,
  findActiveAck,
  requiredSubTypesForChild,
  getChildFileCompleteness,
  isAnnualReviewDue,
} from './acknowledgments'

// ─── Hashing primitives ────────────────────────────────────────────────

describe('fnv1a32Hex', () => {
  it('returns 8 lowercase hex characters', () => {
    const h = fnv1a32Hex('hello')
    expect(h).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic', () => {
    expect(fnv1a32Hex('mi-little-care')).toBe(fnv1a32Hex('mi-little-care'))
  })

  it('differs across inputs', () => {
    expect(fnv1a32Hex('a')).not.toBe(fnv1a32Hex('b'))
  })

  it('handles empty / null / undefined as ""', () => {
    const a = fnv1a32Hex('')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1a32Hex(null)).toBe(a)
    expect(fnv1a32Hex(undefined)).toBe(a)
  })
})

describe('canonicalForHash', () => {
  it('returns "" for nullish', () => {
    expect(canonicalForHash(null)).toBe('')
    expect(canonicalForHash(undefined)).toBe('')
  })

  it('sorts keys so order does not change the canonical string', () => {
    const a = canonicalForHash({ b: 2, a: 1 })
    const b = canonicalForHash({ a: 1, b: 2 })
    expect(a).toBe(b)
  })

  it('produces distinct strings for distinct payloads', () => {
    expect(canonicalForHash({ x: 1 })).not.toBe(canonicalForHash({ x: 2 }))
  })

  it('recurses into nested objects', () => {
    const flat = canonicalForHash({ a: { x: 1, y: 2 } })
    const reorder = canonicalForHash({ a: { y: 2, x: 1 } })
    expect(flat).toBe(reorder)
  })
})

describe('computeAckHash', () => {
  it('changes when the type changes', () => {
    const p = { foodProvider: 'provider' }
    expect(computeAckHash({ type: ACK_TYPES.FOOD_PROVIDER_AGREEMENT, payload: p }))
      .not.toBe(computeAckHash({ type: ACK_TYPES.LEAD_DISCLOSURE, payload: p }))
  })

  it('changes when the payload changes', () => {
    const t = ACK_TYPES.LEAD_DISCLOSURE
    expect(computeAckHash({ type: t, payload: { copyVersion: 'v1' } }))
      .not.toBe(computeAckHash({ type: t, payload: { copyVersion: 'v2' } }))
  })

  it('is stable for the same input', () => {
    const h1 = computeAckHash({ type: ACK_TYPES.LEAD_DISCLOSURE, payload: { homeBuiltBefore1978: true, copyVersion: 'v1' } })
    const h2 = computeAckHash({ type: ACK_TYPES.LEAD_DISCLOSURE, payload: { homeBuiltBefore1978: true, copyVersion: 'v1' } })
    expect(h1).toBe(h2)
  })

  it('handles missing payload', () => {
    expect(computeAckHash({ type: ACK_TYPES.LICENSING_NOTEBOOK_OFFERED }))
      .toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('computeEnvelopeHash', () => {
  it('is order-independent', () => {
    const a = computeEnvelopeHash(['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
    const b = computeEnvelopeHash(['cccccccc', 'aaaaaaaa', 'bbbbbbbb'])
    expect(a).toBe(b)
  })

  it('differs when the sub-hash set changes', () => {
    const a = computeEnvelopeHash(['11111111', '22222222'])
    const b = computeEnvelopeHash(['11111111', '22222222', '33333333'])
    expect(a).not.toBe(b)
  })

  it('handles empty input', () => {
    expect(computeEnvelopeHash([])).toMatch(/^[0-9a-f]{8}$/)
    expect(computeEnvelopeHash(null)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('filters out empty / non-string entries', () => {
    const clean = computeEnvelopeHash(['aaaaaaaa', 'bbbbbbbb'])
    const dirty = computeEnvelopeHash(['aaaaaaaa', '', null, 'bbbbbbbb', undefined])
    expect(clean).toBe(dirty)
  })
})

// ─── Selectors ─────────────────────────────────────────────────────────

describe('findActiveAck', () => {
  const child = { id: 'c1' }
  const acks = [
    { id: 'a1', type: 'lead_disclosure', subject_type: 'child', subject_id: 'c1', archived_at: null },
    { id: 'a2', type: 'firearms_disclosure', subject_type: 'child', subject_id: 'c1', archived_at: '2026-01-01T00:00:00Z' },
    { id: 'a3', type: 'lead_disclosure', subject_type: 'child', subject_id: 'c2', archived_at: null },
  ]

  it('finds an active row matching all three keys', () => {
    const found = findActiveAck(acks, { type: 'lead_disclosure', subjectType: 'child', subjectId: 'c1' })
    expect(found && found.id).toBe('a1')
  })

  it('skips archived rows', () => {
    expect(findActiveAck(acks, { type: 'firearms_disclosure', subjectType: 'child', subjectId: 'c1' })).toBeNull()
  })

  it('returns null when no row matches', () => {
    expect(findActiveAck(acks, { type: 'lead_disclosure', subjectType: 'child', subjectId: 'missing' })).toBeNull()
  })

  it('returns null when no filter or no type', () => {
    expect(findActiveAck(acks, null)).toBeNull()
    expect(findActiveAck(acks, {})).toBeNull()
  })

  it('matches subject_id=null for provider-level rows', () => {
    const provLevel = [{ type: 't', subject_type: null, subject_id: null, archived_at: null }]
    expect(findActiveAck(provLevel, { type: 't' })).not.toBeNull()
  })
})

// ─── requiredSubTypesForChild ──────────────────────────────────────────

describe('requiredSubTypesForChild', () => {
  const baseChild = { id: 'c1', date_of_birth: '2026-01-01' }

  it('returns base required set with no lead/no firearms set yet', () => {
    const out = requiredSubTypesForChild({
      child: baseChild,
      profile: { home_built_before_1978: null, firearms_on_premises: null },
      today: '2026-05-29',
    })
    expect(out).not.toContain(ACK_TYPES.LEAD_DISCLOSURE)
    expect(out).not.toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
    expect(out).toContain(ACK_TYPES.FOOD_PROVIDER_AGREEMENT)
    expect(out).toContain(ACK_TYPES.HEALTH_CONDITION)
  })

  it('adds lead_disclosure when home_built_before_1978 = true', () => {
    const out = requiredSubTypesForChild({
      child: baseChild,
      profile: { home_built_before_1978: true, firearms_on_premises: null },
      today: '2026-05-29',
    })
    expect(out).toContain(ACK_TYPES.LEAD_DISCLOSURE)
  })

  it('does NOT add lead_disclosure when home_built_before_1978 = false', () => {
    const out = requiredSubTypesForChild({
      child: baseChild,
      profile: { home_built_before_1978: false, firearms_on_premises: null },
    })
    expect(out).not.toContain(ACK_TYPES.LEAD_DISCLOSURE)
  })

  it('adds firearms_disclosure regardless of yes/no (copy varies)', () => {
    const yes = requiredSubTypesForChild({
      child: baseChild,
      profile: { firearms_on_premises: true },
    })
    const no = requiredSubTypesForChild({
      child: baseChild,
      profile: { firearms_on_premises: false },
    })
    expect(yes).toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
    expect(no).toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
  })

  it('adds infant_safe_sleep for children < 18 months old', () => {
    const infant = { id: 'i1', date_of_birth: '2026-01-01' }     // 5 months at 2026-05-29
    const toddler = { id: 't1', date_of_birth: '2024-01-01' }     // 28 months
    const profile = { home_built_before_1978: false, firearms_on_premises: false }
    expect(requiredSubTypesForChild({ child: infant, profile, today: '2026-05-29' }))
      .toContain(ACK_TYPES.INFANT_SAFE_SLEEP)
    expect(requiredSubTypesForChild({ child: toddler, profile, today: '2026-05-29' }))
      .not.toContain(ACK_TYPES.INFANT_SAFE_SLEEP)
  })
})

// ─── getChildFileCompleteness ──────────────────────────────────────────

describe('getChildFileCompleteness', () => {
  const child = { id: 'c1', date_of_birth: '2026-01-01', records_last_reviewed_on: '2026-05-01' }
  const profile = { home_built_before_1978: false, firearms_on_premises: false }

  function ack(type, hash) {
    return {
      type,
      subject_type: 'child',
      subject_id: 'c1',
      archived_at: null,
      snapshot_hash: hash || null,
    }
  }

  it('intakeComplete=false when no envelope exists', () => {
    const out = getChildFileCompleteness({ child, profile, acks: [] })
    expect(out.intakeComplete).toBe(false)
    expect(out.envelopePresent).toBe(false)
    expect(out.acknowledgmentsMissing.length).toBeGreaterThan(0)
  })

  it('intakeComplete=true when envelope + every required sub-row is present', () => {
    const required = requiredSubTypesForChild({ child, profile, today: '2026-05-29' })
    const acks = [
      ack(ACK_TYPES.CHILD_IN_CARE_STATEMENT, 'aaaaaaaa'),
      ...required.map(t => ack(t)),
    ]
    const out = getChildFileCompleteness({ child, profile, acks })
    expect(out.envelopePresent).toBe(true)
    expect(out.acknowledgmentsMissing).toEqual([])
    expect(out.intakeComplete).toBe(true)
  })

  it('detects envelope hash drift when sub-row set has changed', () => {
    const required = requiredSubTypesForChild({ child, profile, today: '2026-05-29' })
    // Acknowledged set was smaller (older intake). The stored envelope hash
    // was computed against that smaller set; the current required set adds
    // a new sub-row.
    const subHashes = required.slice(0, required.length - 1).map(t => computeAckHash({ type: t, payload: {} }))
    const oldEnvelopeHash = computeEnvelopeHash(subHashes)
    const acks = [
      ack(ACK_TYPES.CHILD_IN_CARE_STATEMENT, oldEnvelopeHash),
      ...required.map(t => ack(t)),
    ]
    const subRowPayloads = {}
    for (const t of required) subRowPayloads[t] = {}
    const out = getChildFileCompleteness({ child, profile, acks, subRowPayloads })
    expect(out.envelopeHashDrift).toBe(true)
    expect(out.intakeComplete).toBe(false)
  })

  it('flips to incomplete when home_built_before_1978 toggles after acknowledgment', () => {
    const profileBefore = { home_built_before_1978: false, firearms_on_premises: false }
    const profileAfter = { home_built_before_1978: true, firearms_on_premises: false }
    const required = requiredSubTypesForChild({ child, profile: profileBefore, today: '2026-05-29' })
    // Capture the original sub-row hashes (which did not include lead_disclosure).
    const subHashes = required.map(t => computeAckHash({ type: t, payload: {} }))
    const oldEnvelopeHash = computeEnvelopeHash(subHashes)
    const acks = [
      ack(ACK_TYPES.CHILD_IN_CARE_STATEMENT, oldEnvelopeHash),
      ...required.map(t => ack(t)),
    ]
    const subRowPayloadsAfter = {}
    for (const t of requiredSubTypesForChild({ child, profile: profileAfter, today: '2026-05-29' })) {
      subRowPayloadsAfter[t] = {}
    }
    const out = getChildFileCompleteness({
      child, profile: profileAfter, acks,
      subRowPayloads: subRowPayloadsAfter,
    })
    expect(out.acknowledgmentsMissing).toContain(ACK_TYPES.LEAD_DISCLOSURE)
    expect(out.intakeComplete).toBe(false)
  })
})

// ─── isAnnualReviewDue ─────────────────────────────────────────────────

describe('isAnnualReviewDue', () => {
  it('true for never-reviewed', () => {
    expect(isAnnualReviewDue(null, '2026-05-29')).toBe(true)
  })

  it('false within the last 12 months', () => {
    expect(isAnnualReviewDue('2026-01-01', '2026-05-29')).toBe(false)
  })

  it('true at or beyond 12 months', () => {
    expect(isAnnualReviewDue('2025-05-29', '2026-05-29')).toBe(true)
    expect(isAnnualReviewDue('2024-12-31', '2026-05-29')).toBe(true)
  })
})

// ─── arePremisesAnsweredForIntake (the gate helper) ────────────────────

describe('arePremisesAnsweredForIntake', () => {
  it('ready=true when both booleans are answered (true/true)', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: true, firearms_on_premises: true,
    })
    expect(out.ready).toBe(true)
    expect(out.missing).toEqual([])
  })

  it('ready=true when both booleans are answered false/false (false IS an answer)', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: false, firearms_on_premises: false,
    })
    expect(out.ready).toBe(true)
    expect(out.missing).toEqual([])
  })

  it('ready=false when home_built_before_1978 is null', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: null, firearms_on_premises: true,
    })
    expect(out.ready).toBe(false)
    expect(out.missing).toEqual(['home_built_before_1978'])
  })

  it('ready=false when firearms_on_premises is null', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: false, firearms_on_premises: null,
    })
    expect(out.ready).toBe(false)
    expect(out.missing).toEqual(['firearms_on_premises'])
  })

  it('ready=false naming BOTH when both are null', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: null, firearms_on_premises: null,
    })
    expect(out.ready).toBe(false)
    expect(out.missing).toEqual(['home_built_before_1978', 'firearms_on_premises'])
  })

  it('ready=false naming BOTH when the profile is null', () => {
    const out = arePremisesAnsweredForIntake(null)
    expect(out.ready).toBe(false)
    expect(out.missing).toEqual(['home_built_before_1978', 'firearms_on_premises'])
  })

  it('treats undefined as missing (matches null semantics)', () => {
    const out = arePremisesAnsweredForIntake({
      home_built_before_1978: undefined, firearms_on_premises: undefined,
    })
    expect(out.ready).toBe(false)
    expect(out.missing).toEqual(['home_built_before_1978', 'firearms_on_premises'])
  })
})

// ─── requiredSubTypesForChild + firearms truth-table ───────────────────
//
// The premises gate makes both booleans non-null at write time; this
// pins the consequence — firearms_disclosure must appear in the required
// set for BOTH true AND false answers (only the snapshot payload's
// `firearmsOnPremises` boolean differs). The lead disclosure remains
// gated on home_built_before_1978 = true.

describe('requiredSubTypesForChild — firearms behavior at the gate', () => {
  const child = { id: 'c1', date_of_birth: '2024-01-01' }

  it('firearms_disclosure is REQUIRED when firearms_on_premises = true', () => {
    const out = requiredSubTypesForChild({
      child,
      profile: { home_built_before_1978: false, firearms_on_premises: true },
      today: '2026-05-29',
    })
    expect(out).toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
  })

  it('firearms_disclosure is REQUIRED when firearms_on_premises = false (copy varies; disclosure still required)', () => {
    const out = requiredSubTypesForChild({
      child,
      profile: { home_built_before_1978: false, firearms_on_premises: false },
      today: '2026-05-29',
    })
    expect(out).toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
  })

  it('lead_disclosure REQUIRED only when home_built_before_1978 = true (truth table)', () => {
    const profileTrue = { home_built_before_1978: true, firearms_on_premises: true }
    const profileFalse = { home_built_before_1978: false, firearms_on_premises: true }
    expect(requiredSubTypesForChild({ child, profile: profileTrue }))
      .toContain(ACK_TYPES.LEAD_DISCLOSURE)
    expect(requiredSubTypesForChild({ child, profile: profileFalse }))
      .not.toContain(ACK_TYPES.LEAD_DISCLOSURE)
  })
})

// ─── Surface ───────────────────────────────────────────────────────────

describe('exports', () => {
  it('CHILD_IN_CARE_SUB_TYPES enumerates the seven sub-rows', () => {
    expect(CHILD_IN_CARE_SUB_TYPES).toHaveLength(7)
  })

  it('ACK_TYPES values match scope doc strings', () => {
    expect(ACK_TYPES.CHILD_IN_CARE_STATEMENT).toBe('child_in_care_statement')
    expect(ACK_TYPES.LEAD_DISCLOSURE).toBe('lead_disclosure')
    expect(ACK_TYPES.FIREARMS_DISCLOSURE).toBe('firearms_disclosure')
  })
})
