import { describe, it, expect } from 'vitest'
import {
  checkPayPeriodHoursCap,
  checkBillingOutsideAuthorization,
  checkSubmissionWindowExpired,
  checkBillingWithoutActiveCdc,
  runValidation,
  segmentHours,
  PAY_PERIOD_HOURS_CAP,
  SUBMISSION_WINDOW_DAYS,
  SEVERITY,
  RULE,
} from './iBilling'

// Fixed today + a synthetic pay period so every test is deterministic.
const TODAY = '2026-05-20'

const payPeriod = (overrides = {}) => ({
  period_number: 611,
  start_date: '2026-05-03',
  end_date: '2026-05-16',
  reporting_deadline: '2026-05-21',
  ...overrides,
})

const attendanceRow = (overrides = {}) => ({
  id: `att-${Math.random().toString(36).slice(2)}`,
  user_id: 'provider-1',
  child_id: 'child-1',
  date: '2026-05-05',
  segment_index: 0,
  status: 'present',
  check_in: '07:30',
  check_out: '17:30',
  notes: null,
  ...overrides,
})

const cdcSource = (overrides = {}) => ({
  id: `fs-${Math.random().toString(36).slice(2)}`,
  type: 'cdc_scholarship',
  status: 'active',
  child_id: 'child-1',
  archived_at: null,
  authorization_start: '2026-04-01',
  authorization_end: '2026-09-30',
  details: {},
  ...overrides,
})

// -----------------------------------------------------------------------------

describe('segmentHours', () => {
  it('returns the in→out duration in decimal hours for a present segment', () => {
    expect(segmentHours(attendanceRow({ check_in: '07:30', check_out: '17:30' }))).toBe(10)
  })

  it('handles HH:MM:SS', () => {
    expect(segmentHours(attendanceRow({ check_in: '07:30:00', check_out: '08:00:30' }))).toBeCloseTo(0.5083, 3)
  })

  it('returns 0 for absent records regardless of times', () => {
    expect(segmentHours(attendanceRow({ status: 'absent', check_in: '07:30', check_out: '17:30' }))).toBe(0)
  })

  it('returns 0 for partial-data records (no check_in)', () => {
    expect(segmentHours(attendanceRow({ check_in: null }))).toBe(0)
  })

  it('returns 0 for a degenerate segment (check_out before check_in — Rule 7 catches midnight crossings)', () => {
    expect(segmentHours(attendanceRow({ check_in: '23:00', check_out: '01:00' }))).toBe(0)
  })
})

describe('Rule 1 — pay-period hours cap', () => {
  it('passes when total billable hours are under the cap', () => {
    const issues = checkPayPeriodHoursCap({
      attendance: [
        attendanceRow({ check_in: '07:00', check_out: '17:00' }), // 10h
        attendanceRow({ child_id: 'child-2', check_in: '08:00', check_out: '16:00' }), // 8h
      ],
    })
    expect(issues).toEqual([])
  })

  it('flags blocking when total billable hours exceed the cap', () => {
    // 2017 hours via 202 ten-hour segments (one over the cap)
    const fake = []
    for (let i = 0; i < 202; i++) {
      fake.push(attendanceRow({ id: `att-${i}`, check_in: '07:00', check_out: '17:00' }))
    }
    const issues = checkPayPeriodHoursCap({ attendance: fake })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].ruleId).toBe(RULE.PAY_PERIOD_HOURS_CAP)
    expect(issues[0].message).toMatch(/2020\.00.*2016/)
  })

  it('cap value is 2016 per the LEP handbook', () => {
    expect(PAY_PERIOD_HOURS_CAP).toBe(2016)
  })
})

describe('Rule 5 — billing outside authorization', () => {
  it('passes when every attendance segment falls inside the auth window', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [
        attendanceRow({ date: '2026-05-05' }),
        attendanceRow({ date: '2026-09-30' }),  // boundary, inclusive
      ],
      fundingSources: [cdcSource()],
    })
    expect(issues).toEqual([])
  })

  it('flags segments before authorization_start', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [attendanceRow({ date: '2026-03-31' })],
      fundingSources: [cdcSource({ authorization_start: '2026-04-01' })],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].auditCitation).toMatch(/IPV/)
  })

  it('flags segments after authorization_end', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [attendanceRow({ date: '2026-10-01' })],
      fundingSources: [cdcSource({ authorization_end: '2026-09-30' })],
    })
    expect(issues).toHaveLength(1)
  })

  it('uses details.authorization_end as fallback when typed column is null', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [attendanceRow({ date: '2026-10-01' })],
      fundingSources: [cdcSource({
        authorization_start: null,
        authorization_end: null,
        details: { authorization_start: '2026-04-01', authorization_end: '2026-09-30' },
      })],
    })
    expect(issues).toHaveLength(1)
  })

  it('absent records do not generate out-of-window issues', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [attendanceRow({ status: 'absent', date: '2026-03-31' })],
      fundingSources: [cdcSource()],
    })
    expect(issues).toEqual([])
  })

  it('passes the segment when ANY funding source covers it (multi-auth period coverage)', () => {
    const issues = checkBillingOutsideAuthorization({
      attendance: [attendanceRow({ date: '2026-05-05' })],
      fundingSources: [
        cdcSource({ authorization_start: '2025-01-01', authorization_end: '2025-12-31' }),
        cdcSource({ authorization_start: '2026-04-01', authorization_end: '2026-09-30' }),
      ],
    })
    expect(issues).toEqual([])
  })
})

describe('Rule 10 — submission window expired', () => {
  it('passes when today is within 90 days of period end', () => {
    const issues = checkSubmissionWindowExpired({
      payPeriod: payPeriod({ end_date: '2026-05-16' }),
      today: TODAY,  // 4 days after end
    })
    expect(issues).toEqual([])
  })

  it('passes at exactly 90 days after end (boundary, inclusive)', () => {
    const issues = checkSubmissionWindowExpired({
      payPeriod: payPeriod({ end_date: '2026-02-19' }),  // 2026-05-20 is exactly 90 days later
      today: TODAY,
    })
    expect(issues).toEqual([])
  })

  it('flags blocking at 91 days past end', () => {
    const issues = checkSubmissionWindowExpired({
      payPeriod: payPeriod({ end_date: '2026-02-18' }),  // 91 days
      today: TODAY,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].ruleId).toBe(RULE.SUBMISSION_WINDOW_EXPIRED)
  })

  it('returns [] when payPeriod is missing', () => {
    expect(checkSubmissionWindowExpired({ payPeriod: null, today: TODAY })).toEqual([])
  })

  it('cap is 90 days per the LEP handbook', () => {
    expect(SUBMISSION_WINDOW_DAYS).toBe(90)
  })
})

describe('Rule 11 — billing without active CDC', () => {
  it('passes when every billed child has an active covering CDC source', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-1' })],
      fundingSources: [cdcSource({ child_id: 'child-1' })],
      payPeriod: payPeriod(),
    })
    expect(issues).toEqual([])
  })

  it('flags a child with no CDC source at all', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-2' })],
      fundingSources: [cdcSource({ child_id: 'child-1' })],
      payPeriod: payPeriod(),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].childId).toBe('child-2')
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
  })

  it('flags a child whose only CDC source is archived', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-3' })],
      fundingSources: [cdcSource({ child_id: 'child-3', archived_at: '2026-04-01T00:00:00Z' })],
      payPeriod: payPeriod(),
    })
    expect(issues).toHaveLength(1)
  })

  it('flags a child whose only CDC source is paused', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-4' })],
      fundingSources: [cdcSource({ child_id: 'child-4', status: 'paused' })],
      payPeriod: payPeriod(),
    })
    expect(issues).toHaveLength(1)
  })

  it('flags a child whose only CDC source ended before the period', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-5', date: '2026-05-05' })],
      fundingSources: [cdcSource({
        child_id: 'child-5',
        authorization_start: '2025-01-01',
        authorization_end: '2025-12-31',
      })],
      payPeriod: payPeriod({ start_date: '2026-05-03', end_date: '2026-05-16' }),
    })
    expect(issues).toHaveLength(1)
  })

  it('absent-only attendance does not trigger the rule (nothing is being billed)', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [attendanceRow({ child_id: 'child-x', status: 'absent' })],
      fundingSources: [],
      payPeriod: payPeriod(),
    })
    expect(issues).toEqual([])
  })

  it('returns one issue per child even when the child has many segments', () => {
    const issues = checkBillingWithoutActiveCdc({
      attendance: [
        attendanceRow({ id: 'a', child_id: 'child-7' }),
        attendanceRow({ id: 'b', child_id: 'child-7', date: '2026-05-06' }),
        attendanceRow({ id: 'c', child_id: 'child-7', date: '2026-05-07' }),
      ],
      fundingSources: [],
      payPeriod: payPeriod(),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].childId).toBe('child-7')
  })
})

describe('runValidation — orchestration', () => {
  it('returns combined issues sorted blocking → warning → info', () => {
    const issues = runValidation({
      attendance: [attendanceRow({ child_id: 'no-source' })],
      fundingSources: [],
      payPeriod: payPeriod({ end_date: '2026-02-18' }),  // also triggers Rule 10
      today: TODAY,
    })
    expect(issues.length).toBeGreaterThanOrEqual(2)
    // All blocking issues first
    for (let i = 1; i < issues.length; i++) {
      const a = issues[i - 1].severity
      const b = issues[i].severity
      expect(['blocking', 'warning', 'info'].indexOf(a))
        .toBeLessThanOrEqual(['blocking', 'warning', 'info'].indexOf(b))
    }
  })

  it('returns [] when nothing is flagged across any of the 11 rules', () => {
    const issues = runValidation({
      attendance: [attendanceRow({ child_id: 'child-1', check_in: '07:00', check_out: '17:00' })],
      children: [{ id: 'child-1', school_enrolled: false }],
      fundingSources: [cdcSource({ child_id: 'child-1' })],
      payPeriod: payPeriod(),
      profile: { id: 'provider-1', full_name: 'Venessa' },
      fiscalYearAttendance: [],
      today: TODAY,
    })
    expect(issues).toEqual([])
  })

  it('does not crash when called with no arguments', () => {
    expect(() => runValidation()).not.toThrow()
    expect(runValidation()).toEqual([])
  })

  it('stub rules (2, 3, 4, 6, 7, 8, 9) return empty without throwing', () => {
    // Defensive check that the placeholder stubs don't accidentally
    // emit issues. When each stub is filled in, the existing tests in
    // this file should still pass — the stubs are opt-in.
    const issues = runValidation({
      attendance: [],
      fundingSources: [],
      payPeriod: payPeriod(),
      profile: {},
      today: TODAY,
    })
    expect(issues).toEqual([])
  })
})
