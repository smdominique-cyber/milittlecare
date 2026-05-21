import { describe, it, expect } from 'vitest'
import {
  buildPickerCandidates,
  periodOverlapsAnyCdc,
  statusRank,
} from './iBillingPicker'
import { PERIOD_STATUS } from './cdcPayPeriods'

const period = (over = {}) => ({
  id: `p-${over.period_number ?? 611}`,
  schedule_year: 2026,
  period_number: 611,
  start_date: '2026-05-03',
  end_date: '2026-05-16',
  reporting_deadline: '2026-05-21',
  ...over,
})

const cdc = (over = {}) => ({
  id: `fs-${Math.random().toString(36).slice(2)}`,
  type: 'cdc_scholarship',
  status: 'active',
  child_id: 'kid-1',
  archived_at: null,
  authorization_start: '2026-04-01',
  authorization_end: '2026-09-30',
  ...over,
})

const TODAY_OPEN = '2026-05-19'      // period 611 reporting_deadline = 2026-05-21 → open
const TODAY_CURRENT = '2026-05-10'   // inside period 611's [start_date, end_date]
const TODAY_CLOSED = '2026-09-01'    // past period 611's reporting_deadline + 90d window

describe('periodOverlapsAnyCdc', () => {
  it('returns true when at least one CDC source covers the period', () => {
    expect(periodOverlapsAnyCdc(period(), [cdc()])).toBe(true)
  })

  it('returns false when no CDC source is present', () => {
    expect(periodOverlapsAnyCdc(period(), [])).toBe(false)
  })

  it('skips archived funding sources', () => {
    expect(periodOverlapsAnyCdc(period(), [cdc({ archived_at: '2026-05-01T00:00:00Z' })])).toBe(false)
  })

  it('skips non-CDC funding sources', () => {
    expect(periodOverlapsAnyCdc(period(), [cdc({ type: 'private_pay' })])).toBe(false)
  })

  it('falls back to details.* for legacy pre-PR #8.5b rows', () => {
    const legacy = {
      type: 'cdc_scholarship',
      archived_at: null,
      authorization_start: null,
      authorization_end: null,
      details: { authorization_start: '2026-04-01', authorization_end: '2026-09-30' },
    }
    expect(periodOverlapsAnyCdc(period(), [legacy])).toBe(true)
  })

  it('treats missing endpoints as unbounded', () => {
    const noEnd = cdc({ authorization_end: null })
    expect(periodOverlapsAnyCdc(period(), [noEnd])).toBe(true)
    const noStart = cdc({ authorization_start: null })
    expect(periodOverlapsAnyCdc(period(), [noStart])).toBe(true)
  })

  it('returns false when period is entirely before the authorization window', () => {
    const future = cdc({ authorization_start: '2027-01-01' })
    expect(periodOverlapsAnyCdc(period(), [future])).toBe(false)
  })

  it('returns false when period is entirely after the authorization window', () => {
    const past = cdc({ authorization_end: '2026-01-01' })
    expect(periodOverlapsAnyCdc(period(), [past])).toBe(false)
  })
})

describe('statusRank', () => {
  it('ranks open > current > closed > other', () => {
    expect(statusRank(PERIOD_STATUS.OPEN_FOR_BILLING)).toBe(3)
    expect(statusRank(PERIOD_STATUS.CURRENT)).toBe(2)
    expect(statusRank(PERIOD_STATUS.BILLING_CLOSED)).toBe(1)
    expect(statusRank(PERIOD_STATUS.UPCOMING)).toBe(0)
  })
})

describe('buildPickerCandidates', () => {
  it('returns [] when no period overlaps any CDC source', () => {
    expect(buildPickerCandidates({ catalog: [period()], fundingSources: [], today: TODAY_OPEN })).toEqual([])
  })

  it('emits open_for_billing periods with the open status', () => {
    const list = buildPickerCandidates({
      catalog: [period()],
      fundingSources: [cdc()],
      today: TODAY_OPEN,
    })
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe(PERIOD_STATUS.OPEN_FOR_BILLING)
    expect(list[0].countdown).toBe(2)  // 2026-05-21 - 2026-05-19 = 2
  })

  it('emits current periods', () => {
    const list = buildPickerCandidates({
      catalog: [period()],
      fundingSources: [cdc()],
      today: TODAY_CURRENT,
    })
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe(PERIOD_STATUS.CURRENT)
  })

  it('emits billing_closed periods (UI disables them)', () => {
    const list = buildPickerCandidates({
      catalog: [period()],
      fundingSources: [cdc()],
      today: TODAY_CLOSED,
    })
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe(PERIOD_STATUS.BILLING_CLOSED)
  })

  it('excludes upcoming periods (nothing to bill yet)', () => {
    const future = period({ id: 'p-701', period_number: 701, start_date: '2027-01-04', end_date: '2027-01-17', reporting_deadline: '2027-01-22' })
    const list = buildPickerCandidates({
      catalog: [future],
      fundingSources: [cdc({ authorization_start: '2026-04-01', authorization_end: '2027-09-30' })],
      today: TODAY_OPEN,
    })
    expect(list).toEqual([])
  })

  it('orders by status (open first, then current, then closed) then by start_date desc', () => {
    const open = period({ id: 'p-611', period_number: 611, start_date: '2026-05-03', end_date: '2026-05-16', reporting_deadline: '2026-05-21' })
    const current = period({ id: 'p-612', period_number: 612, start_date: '2026-05-17', end_date: '2026-05-30', reporting_deadline: '2026-06-04' })
    const closed = period({ id: 'p-510', period_number: 510, start_date: '2026-01-11', end_date: '2026-01-24', reporting_deadline: '2026-01-29' })
    const list = buildPickerCandidates({
      catalog: [closed, current, open],
      fundingSources: [cdc({ authorization_start: '2025-12-01', authorization_end: '2026-12-31' })],
      today: TODAY_OPEN,
    })
    expect(list.map(c => c.period.period_number)).toEqual([611, 612, 510])
  })
})
