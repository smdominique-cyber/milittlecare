import { describe, it, expect } from 'vitest'
import {
  partitionChildren,
  activeChildren,
  displayChildName,
  findChildDisplayName,
} from './children'

const active1 = { id: 'a1', first_name: 'Mia', archived_at: null }
const active2 = { id: 'a2', first_name: 'Leo' } // archived_at absent → active
const archived1 = { id: 'r1', first_name: 'Sam', archived_at: '2026-05-01T12:00:00Z' }

describe('partitionChildren', () => {
  it('splits active (null/absent archived_at) from archived (truthy)', () => {
    const { active, archived } = partitionChildren([active1, archived1, active2])
    expect(active.map(c => c.id)).toEqual(['a1', 'a2'])
    expect(archived.map(c => c.id)).toEqual(['r1'])
  })

  it('treats a missing archived_at the same as null (active)', () => {
    const { active, archived } = partitionChildren([active2])
    expect(active).toHaveLength(1)
    expect(archived).toHaveLength(0)
  })

  it('handles empty / nullish input without throwing', () => {
    expect(partitionChildren()).toEqual({ active: [], archived: [] })
    expect(partitionChildren(null)).toEqual({ active: [], archived: [] })
  })

  it('skips null entries in the array', () => {
    const { active, archived } = partitionChildren([active1, null, archived1])
    expect(active).toHaveLength(1)
    expect(archived).toHaveLength(1)
  })
})

describe('activeChildren', () => {
  it('returns only active rows', () => {
    expect(activeChildren([active1, archived1, active2]).map(c => c.id))
      .toEqual(['a1', 'a2'])
  })

  it('returns [] for nullish input', () => {
    expect(activeChildren()).toEqual([])
  })
})

// Phase 3 fix-forward (2026-06-05) — Finding #4: the per-child rollup
// on /compliance was rendering truncated UUIDs instead of names.
// Display helpers extracted from FamilyComplianceTab.jsx's inline
// findChildName + shared with ComplianceChecklistPage.

describe('displayChildName', () => {
  it('first_name + last_name → "First Last"', () => {
    expect(displayChildName({ first_name: 'Audrey', last_name: 'Snayberger' }))
      .toBe('Audrey Snayberger')
  })

  it('only first_name → "First"', () => {
    expect(displayChildName({ first_name: 'Becky', last_name: null }))
      .toBe('Becky')
    expect(displayChildName({ first_name: 'Becky' }))
      .toBe('Becky')
  })

  it('only last_name → "Last" (uncommon but tolerated)', () => {
    expect(displayChildName({ first_name: null, last_name: 'Drambau' }))
      .toBe('Drambau')
  })

  it('trims whitespace in each piece', () => {
    expect(displayChildName({ first_name: '  Mia  ', last_name: '  Brown ' }))
      .toBe('Mia Brown')
  })

  it('returns null when both names are missing/empty', () => {
    expect(displayChildName({ first_name: null, last_name: null })).toBe(null)
    expect(displayChildName({ first_name: '', last_name: '' })).toBe(null)
    expect(displayChildName({})).toBe(null)
  })

  it('returns null for null child', () => {
    expect(displayChildName(null)).toBe(null)
    expect(displayChildName(undefined)).toBe(null)
  })

  it('non-string fields → null (defensive)', () => {
    expect(displayChildName({ first_name: 123, last_name: 456 })).toBe(null)
  })
})

describe('findChildDisplayName', () => {
  const roster = [
    { id: 'c1', first_name: 'Audrey', last_name: 'Snayberger' },
    { id: 'c2', first_name: 'Becky' },
    { id: 'c3', first_name: null, last_name: null },
  ]

  it('finds the child by id and returns their display name', () => {
    expect(findChildDisplayName(roster, 'c1')).toBe('Audrey Snayberger')
    expect(findChildDisplayName(roster, 'c2')).toBe('Becky')
  })

  it('returns null when child not in list', () => {
    expect(findChildDisplayName(roster, 'missing')).toBe(null)
  })

  it('returns null when matching child has no name fields', () => {
    expect(findChildDisplayName(roster, 'c3')).toBe(null)
  })

  it('null/undefined args → null (defensive)', () => {
    expect(findChildDisplayName(null, 'c1')).toBe(null)
    expect(findChildDisplayName(roster, null)).toBe(null)
    expect(findChildDisplayName()).toBe(null)
  })
})
