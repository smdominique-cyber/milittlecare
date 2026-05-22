import { describe, it, expect } from 'vitest'
import {
  getLifecycleDisplayState,
  EXPIRING_WINDOW_DAYS,
} from './cdcAuthorization'

const TODAY = '2026-05-20'

// Helper — minimal funding-source row with a typed authorization_end.
const fs = (overrides = {}) => ({
  id: 'fs-1',
  type: 'cdc_scholarship',
  status: 'active',
  authorization_end: null,
  details: {},
  ...overrides,
})

describe('EXPIRING_WINDOW_DAYS', () => {
  it('is 30 days per the spec § PR #8.5b acceptance criterion', () => {
    expect(EXPIRING_WINDOW_DAYS).toBe(30)
  })
})

describe('getLifecycleDisplayState — static states short-circuit', () => {
  it('renders pending in gray regardless of authorization_end', () => {
    const s = getLifecycleDisplayState(fs({ status: 'pending', authorization_end: '2027-01-01' }), TODAY)
    expect(s).toEqual({ label: 'Pending', color: 'gray' })
  })

  it('renders terminated in red regardless of authorization_end', () => {
    const s = getLifecycleDisplayState(fs({ status: 'terminated', authorization_end: '2027-01-01' }), TODAY)
    expect(s).toEqual({ label: 'Terminated', color: 'red' })
  })

  it('renders renewed in blue regardless of authorization_end', () => {
    const s = getLifecycleDisplayState(fs({ status: 'renewed', authorization_end: '2027-01-01' }), TODAY)
    expect(s).toEqual({ label: 'Renewed', color: 'blue' })
  })
})

describe('getLifecycleDisplayState — date-driven states', () => {
  it('returns Active green when authorization_end is more than 30 days out', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: '2026-07-01' }), TODAY)  // 42 days
    expect(s.label).toBe('Active')
    expect(s.color).toBe('green')
    expect(s.daysRemaining).toBe(42)
  })

  it('treats exactly 30 days out as Expiring (boundary, inclusive)', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: '2026-06-19' }), TODAY)
    expect(s.label).toBe('Expiring')
    expect(s.color).toBe('yellow')
    expect(s.daysRemaining).toBe(30)
  })

  it('treats 31 days out as still Active (boundary, exclusive)', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: '2026-06-20' }), TODAY)
    expect(s.label).toBe('Active')
    expect(s.daysRemaining).toBe(31)
  })

  it('treats today itself as Expiring (0 days remaining, not yet expired)', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: TODAY }), TODAY)
    expect(s.label).toBe('Expiring')
    expect(s.daysRemaining).toBe(0)
  })

  it('treats yesterday as Expired with daysOverdue = 1', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: '2026-05-19' }), TODAY)
    expect(s.label).toBe('Expired')
    expect(s.color).toBe('red')
    expect(s.daysOverdue).toBe(1)
  })

  it('counts daysOverdue from authorization_end, not from today', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: '2026-03-02' }), TODAY)
    expect(s.daysOverdue).toBe(79)
  })
})

describe('getLifecycleDisplayState — missing data', () => {
  it('returns Unknown gray for a null funding source', () => {
    expect(getLifecycleDisplayState(null, TODAY)).toEqual({ label: 'Unknown', color: 'gray' })
  })

  it('returns the bare status in gray when authorization_end is missing everywhere', () => {
    const s = getLifecycleDisplayState(fs({ status: 'active' }), TODAY)
    expect(s).toEqual({ label: 'active', color: 'gray' })
  })

  it('falls back to Unknown gray when status is also missing', () => {
    const s = getLifecycleDisplayState({ id: 'fs-x', details: {} }, TODAY)
    expect(s).toEqual({ label: 'Unknown', color: 'gray' })
  })
})

describe('getLifecycleDisplayState — JSON fallback for legacy rows', () => {
  it('reads authorization_end from details.authorization_end when the typed column is null', () => {
    const legacy = fs({ authorization_end: null, details: { authorization_end: '2026-06-19' } })
    const s = getLifecycleDisplayState(legacy, TODAY)
    expect(s.label).toBe('Expiring')
    expect(s.daysRemaining).toBe(30)
  })

  it('prefers the typed column over details.authorization_end when both are set', () => {
    // Post-PR #8.5b backfill: typed column is the source of truth; if it
    // and the JSON disagree the typed value wins.
    const row = fs({ authorization_end: '2026-07-01', details: { authorization_end: '2026-03-02' } })
    const s = getLifecycleDisplayState(row, TODAY)
    expect(s.label).toBe('Active')
  })

  it('treats an empty details object as no JSON fallback', () => {
    const s = getLifecycleDisplayState(fs({ authorization_end: null, details: {} }), TODAY)
    expect(s.label).toBe('active')
    expect(s.color).toBe('gray')
  })
})
