import { describe, it, expect } from 'vitest'
import { buildReviewGrid, daysInPeriod, RULE_LABEL } from './iBillingGrid'
import { RULE, SEVERITY } from './iBilling'

const payPeriod = (over = {}) => ({
  period_number: 611,
  start_date: '2026-05-03',
  end_date: '2026-05-16',
  reporting_deadline: '2026-05-21',
  ...over,
})

const child = (over = {}) => ({
  id: 'kid-1',
  first_name: 'Mia',
  last_name: 'Reeves',
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

const att = (over = {}) => ({
  id: `att-${Math.random().toString(36).slice(2)}`,
  child_id: 'kid-1',
  date: '2026-05-05',
  segment_index: 0,
  status: 'present',
  check_in: '08:00',
  check_out: '16:00',
  ...over,
})

describe('daysInPeriod', () => {
  it('returns all 14 days inclusive for a standard pay period', () => {
    const d = daysInPeriod(payPeriod())
    expect(d).toHaveLength(14)
    expect(d[0]).toBe('2026-05-03')
    expect(d[13]).toBe('2026-05-16')
  })

  it('returns [] for a missing or malformed period', () => {
    expect(daysInPeriod()).toEqual([])
    expect(daysInPeriod({ start_date: null })).toEqual([])
  })

  it('handles month-boundary periods (Apr -> May)', () => {
    const d = daysInPeriod({ start_date: '2026-04-26', end_date: '2026-05-02' })
    expect(d).toEqual([
      '2026-04-26', '2026-04-27', '2026-04-28', '2026-04-29',
      '2026-04-30', '2026-05-01', '2026-05-02',
    ])
  })
})

describe('buildReviewGrid', () => {
  it('emits 14 day columns, one row per included child', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att()],
      children: [child(), child({ id: 'kid-2', first_name: 'Leo' })],
      fundingSources: [cdc(), cdc({ id: 'fs-2', child_id: 'kid-2' })],
      issues: [],
    })
    expect(g.days).toHaveLength(14)
    expect(g.rows).toHaveLength(2)
    // Alphabetical order by full name: Leo before Mia.
    expect(g.rows[0].child.id).toBe('kid-2')
    expect(g.rows[1].child.id).toBe('kid-1')
  })

  it('includes children with attendance but no CDC source', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ child_id: 'orphan' })],
      children: [child({ id: 'orphan', first_name: 'O', last_name: '' })],
      fundingSources: [],
      issues: [],
    })
    expect(g.rows).toHaveLength(1)
  })

  it('includes active+overlapping CDC-funded children with no attendance (empty row)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [],
      children: [child()],
      fundingSources: [cdc()],
      issues: [],
    })
    expect(g.rows).toHaveLength(1)
    expect(g.rows[0].totalHours).toBe(0)
  })

  // -- Bug 2 (2026-05-21): grid was showing every child with any CDC row,
  // regardless of status or period overlap.
  it('excludes children whose only CDC source is non-active (no attendance)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [],
      children: [child()],
      fundingSources: [cdc({ status: 'ended' })],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  it('excludes children whose CDC authorization does not overlap the period (no attendance)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),  // 2026-05-03 → 2026-05-16
      attendance: [],
      children: [child()],
      // authorization ended in February — well before the period.
      fundingSources: [cdc({ authorization_start: '2026-01-01', authorization_end: '2026-02-28' })],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  it('still includes a child with billable attendance even if their CDC source is inactive/non-overlapping', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att()],  // kid-1 has 8 billable hours in the period
      children: [child()],
      fundingSources: [cdc({ status: 'ended', authorization_end: '2026-02-28' })],
      issues: [],
    })
    expect(g.rows).toHaveLength(1)
  })

  // -- Bug 2 follow-up (2026-05-22): a bare attendance row with zero
  // billable hours must NOT pull a child onto the grid. Only present
  // segments with positive segmentHours() count as "billable attendance."
  it('excludes a child whose only attendance row has a null check_out (no CDC)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ check_in: '08:00', check_out: null })],
      children: [child()],
      fundingSources: [],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  it('excludes a child whose only attendance row has both timestamps null (no CDC)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ check_in: null, check_out: null })],
      children: [child()],
      fundingSources: [],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  it('excludes a child whose only attendance row has check_in === check_out (zero duration, no CDC)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ check_in: '09:00', check_out: '09:00' })],
      children: [child()],
      fundingSources: [],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  // Overnight row (check_out earlier than check_in) currently parses as
  // zero/negative duration via segmentHours, so it's excluded here. This
  // is the Audrey 22:09→12:09 case — genuinely overnight care that should
  // be split at midnight (Rule 7). Until that split happens, segmentHours
  // returns 0 and the child won't appear on the grid on attendance alone.
  // Tracked in docs/tech_debt.md § overnight segments parse as zero hours.
  it('excludes a child whose only attendance row is an unsplit overnight span (no CDC)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ check_in: '22:09', check_out: '12:09' })],
      children: [child()],
      fundingSources: [],
      issues: [],
    })
    expect(g.rows).toHaveLength(0)
  })

  it('zero-hour attendance still appears if the child has active overlapping CDC funding', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ check_in: '08:00', check_out: null })],  // zero billable
      children: [child()],
      fundingSources: [cdc()],  // active + overlapping
      issues: [],
    })
    expect(g.rows).toHaveLength(1)
  })

  it('reads the authorization window from details JSON when typed columns are null (pre-backfill rows)', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [],
      children: [child()],
      fundingSources: [cdc({
        authorization_start: null,
        authorization_end: null,
        details: { authorization_start: '2026-04-01', authorization_end: '2026-09-30' },
      })],
      issues: [],
    })
    expect(g.rows).toHaveLength(1)
  })

  it('aggregates multi-segment days correctly', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [
        att({ segment_index: 0, check_in: '07:00', check_out: '08:30' }),
        att({ segment_index: 1, check_in: '14:30', check_out: '17:30' }),
      ],
      children: [child()],
      fundingSources: [cdc()],
      issues: [],
    })
    const cell = g.rows[0].cells['2026-05-05']
    expect(cell.segments).toHaveLength(2)
    expect(cell.hours).toBeCloseTo(1.5 + 3, 5)
    expect(g.rows[0].totalHours).toBeCloseTo(4.5, 5)
    expect(g.totals.perDay['2026-05-05']).toBeCloseTo(4.5, 5)
    expect(g.totals.grand).toBeCloseTo(4.5, 5)
  })

  it('marks absent days as isAbsent=true with no hours', () => {
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att({ status: 'absent', check_in: null, check_out: null })],
      children: [child()],
      fundingSources: [cdc()],
      issues: [],
    })
    const cell = g.rows[0].cells['2026-05-05']
    expect(cell.isAbsent).toBe(true)
    expect(cell.hours).toBe(0)
  })

  it('joins cell-level issues + tracks worst severity', () => {
    const blocking = {
      ruleId: RULE.BILLING_OUTSIDE_AUTHORIZATION,
      severity: SEVERITY.BLOCKING,
      childId: 'kid-1',
      date: '2026-05-05',
      segmentIndex: 0,
    }
    const warning = {
      ruleId: RULE.MISSING_PARENT_INITIALS,
      severity: SEVERITY.WARNING,
      childId: 'kid-1',
      date: '2026-05-05',
      segmentIndex: 0,
    }
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att()],
      children: [child()],
      fundingSources: [cdc()],
      issues: [blocking, warning],
    })
    const cell = g.rows[0].cells['2026-05-05']
    expect(cell.issues).toHaveLength(2)
    expect(cell.worstSeverity).toBe(SEVERITY.BLOCKING)
  })

  it('routes child-level issues to row.childIssues', () => {
    const childIssue = {
      ruleId: RULE.BILLING_WITHOUT_ACTIVE_CDC,
      severity: SEVERITY.BLOCKING,
      childId: 'kid-1',
    }
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att()],
      children: [child()],
      fundingSources: [cdc()],
      issues: [childIssue],
    })
    expect(g.rows[0].childIssues).toHaveLength(1)
  })

  it('routes provider-level issues to providerIssues', () => {
    const provider = {
      ruleId: RULE.MISSING_PROVIDER_NAME,
      severity: SEVERITY.WARNING,
    }
    const g = buildReviewGrid({
      payPeriod: payPeriod(),
      attendance: [att()],
      children: [child()],
      fundingSources: [cdc()],
      issues: [provider],
    })
    expect(g.providerIssues).toHaveLength(1)
  })

  it('does not throw with no inputs', () => {
    expect(() => buildReviewGrid()).not.toThrow()
    const g = buildReviewGrid()
    expect(g.days).toEqual([])
    expect(g.rows).toEqual([])
    expect(g.totals.grand).toBe(0)
  })
})

describe('RULE_LABEL', () => {
  it('has a label for every rule id', () => {
    for (const id of Object.values(RULE)) {
      expect(RULE_LABEL[id]).toBeTruthy()
    }
  })
})
