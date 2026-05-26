import { describe, it, expect } from 'vitest'
import { partitionChildren, activeChildren } from './children'

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
