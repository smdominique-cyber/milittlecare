import { describe, it, expect } from 'vitest'
import {
  checkPayPeriodHoursCap,
  checkBillingOutsideAuthorization,
  checkSubmissionWindowExpired,
  checkBillingWithoutActiveCdc,
  checkMissingProviderName,
  checkOvernightNotSplitAtMidnight,
  checkMissingParentInitials,
  checkFiscalYearAbsenceCap,
  checkConsecutiveAbsenceDays,
  checkBillingDuringSchoolHours,
  checkConcurrentChildrenCap,
  runValidation,
  segmentHours,
  PAY_PERIOD_HOURS_CAP,
  SUBMISSION_WINDOW_DAYS,
  CONSECUTIVE_ABSENCE_DAYS_CAP,
  LEP_CONCURRENT_CHILDREN_CAP,
  FISCAL_YEAR_ABSENCE_HOURS_CAP,
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

describe('Rule 9 — missing provider name', () => {
  it('passes when profile.full_name is set', () => {
    expect(checkMissingProviderName({ profile: { full_name: 'Venessa' } })).toEqual([])
  })
  it('warns when profile is null', () => {
    const issues = checkMissingProviderName({ profile: null })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.WARNING)
  })
  it('warns when full_name is whitespace-only', () => {
    expect(checkMissingProviderName({ profile: { full_name: '   ' } })).toHaveLength(1)
  })
})

describe('Rule 7 — overnight not split at midnight', () => {
  it('passes a normal same-day segment', () => {
    expect(checkOvernightNotSplitAtMidnight({
      attendance: [attendanceRow({ check_in: '07:00', check_out: '17:00' })],
    })).toEqual([])
  })
  it('flags a segment that crosses midnight (out < in)', () => {
    const issues = checkOvernightNotSplitAtMidnight({
      attendance: [attendanceRow({ check_in: '21:00', check_out: '05:00' })],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].proposedFix.action.kind).toBe('split_at_midnight')
  })
  it('does not flag a degenerate segment that has equal times (treats as zero-length, not overnight)', () => {
    expect(checkOvernightNotSplitAtMidnight({
      attendance: [attendanceRow({ check_in: '08:00', check_out: '08:00' })],
    })).toEqual([])
  })
  it('ignores absent records', () => {
    expect(checkOvernightNotSplitAtMidnight({
      attendance: [attendanceRow({ status: 'absent', check_in: '21:00', check_out: '05:00' })],
    })).toEqual([])
  })
})

describe('Rule 8 — missing parent initials', () => {
  it('warns once at the provider level when any segment has billed hours', () => {
    const issues = checkMissingParentInitials({
      attendance: [
        attendanceRow({ child_id: 'a', check_in: '08:00', check_out: '16:00' }),
        attendanceRow({ child_id: 'b', check_in: '07:30', check_out: '17:30' }),
      ],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.WARNING)
  })
  it('returns [] when there are no billed hours (absence-only or empty period)', () => {
    expect(checkMissingParentInitials({
      attendance: [attendanceRow({ status: 'absent' })],
    })).toEqual([])
    expect(checkMissingParentInitials({ attendance: [] })).toEqual([])
  })
})

describe('Rule 2 — fiscal-year absence cap', () => {
  // Each absence day counts as 8h (coarse approximation pending the
  // spec's "historical schedule average" derivation in Screen 3).
  // 360-hour cap → 45 days. Warning threshold (80%) → 36 days.
  const absenceDay = (date, childId = 'child-1') => attendanceRow({ child_id: childId, date, status: 'absent', check_in: null, check_out: null })

  it('returns [] when well below the warning threshold', () => {
    const issues = checkFiscalYearAbsenceCap({
      fiscalYearAttendance: [absenceDay('2026-01-15'), absenceDay('2026-02-01')],
      today: TODAY,
    })
    expect(issues).toEqual([])
  })

  it('warns when at 80% of the cap (36 absence days = 288 hours)', () => {
    const fy = []
    for (let i = 0; i < 36; i++) {
      const day = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
      fy.push(absenceDay(day, `child-${i}`))
    }
    const issues = checkFiscalYearAbsenceCap({ fiscalYearAttendance: fy, today: TODAY })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.WARNING)
  })

  it('blocks when at 100% of the cap (45+ absence days)', () => {
    const fy = []
    for (let i = 0; i < 45; i++) {
      // Spread across multiple children so dedupe doesn't collapse them
      fy.push(absenceDay(`2026-02-${String((i % 28) + 1).padStart(2, '0')}`, `child-${i}`))
    }
    const issues = checkFiscalYearAbsenceCap({ fiscalYearAttendance: fy, today: TODAY })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
  })

  it('only counts absence rows since fiscal-year start (Oct 1)', () => {
    // Today is 2026-05-20 → fiscal year start = 2025-10-01.
    // An absence dated 2025-09-30 should NOT count.
    const fy = []
    for (let i = 0; i < 45; i++) {
      fy.push(absenceDay('2025-09-30', `child-${i}`))
    }
    const issues = checkFiscalYearAbsenceCap({ fiscalYearAttendance: fy, today: TODAY })
    expect(issues).toEqual([])
  })

  it('dedupes multi-segment absent days (same child, same date)', () => {
    // 45 segments on the same day for the same child should count as 1 day.
    const fy = []
    for (let i = 0; i < 45; i++) {
      fy.push({ ...absenceDay('2026-02-15', 'child-1'), id: `a-${i}`, segment_index: i })
    }
    expect(checkFiscalYearAbsenceCap({ fiscalYearAttendance: fy, today: TODAY })).toEqual([])
  })

  it('cap is 360 hours per the LEP handbook', () => {
    expect(FISCAL_YEAR_ABSENCE_HOURS_CAP).toBe(360)
  })
})

describe('Rule 3 — consecutive absence days', () => {
  const period = payPeriod({ start_date: '2026-05-03', end_date: '2026-05-16' })

  const absent = (date, childId = 'child-1') => attendanceRow({
    child_id: childId, date, status: 'absent', check_in: null, check_out: null,
  })

  it('passes a 9-day absence streak (one below the cap)', () => {
    const attendance = []
    for (let d = 4; d <= 12; d++) {
      attendance.push(absent(`2026-05-${String(d).padStart(2, '0')}`))
    }
    expect(checkConsecutiveAbsenceDays({
      attendance, fiscalYearAttendance: [], payPeriod: period,
    })).toEqual([])
  })

  it('blocks a 10-day consecutive absence streak overlapping the period', () => {
    const attendance = []
    for (let d = 4; d <= 13; d++) {
      attendance.push(absent(`2026-05-${String(d).padStart(2, '0')}`))
    }
    const issues = checkConsecutiveAbsenceDays({
      attendance, fiscalYearAttendance: [], payPeriod: period,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].childId).toBe('child-1')
  })

  it('billed care in the middle of the run breaks the streak', () => {
    const attendance = [
      absent('2026-05-04'), absent('2026-05-05'), absent('2026-05-06'),
      absent('2026-05-07'), absent('2026-05-08'),
      // Billed in the middle
      attendanceRow({ child_id: 'child-1', date: '2026-05-09', check_in: '08:00', check_out: '16:00' }),
      absent('2026-05-10'), absent('2026-05-11'), absent('2026-05-12'),
      absent('2026-05-13'), absent('2026-05-14'),
    ]
    expect(checkConsecutiveAbsenceDays({ attendance, fiscalYearAttendance: [], payPeriod: period })).toEqual([])
  })

  it('considers fiscalYearAttendance for runs starting before the current period', () => {
    // 6 days of absence in late April + 4 days in early May → 10 consecutive
    const fy = []
    for (let d = 28; d <= 30; d++) fy.push(absent(`2026-04-${String(d).padStart(2, '0')}`))
    fy.push(absent('2026-05-01'), absent('2026-05-02'), absent('2026-05-03'))
    const attendance = []
    for (let d = 4; d <= 7; d++) attendance.push(absent(`2026-05-${String(d).padStart(2, '0')}`))
    const issues = checkConsecutiveAbsenceDays({ attendance, fiscalYearAttendance: fy, payPeriod: period })
    expect(issues).toHaveLength(1)
  })

  it('cap is 10 days per the LEP handbook', () => {
    expect(CONSECUTIVE_ABSENCE_DAYS_CAP).toBe(10)
  })
})

describe('Rule 6 — billing during school hours', () => {
  const schoolKid = (overrides = {}) => ({
    id: 'kid-1',
    school_enrolled: true,
    school_bell_schedule_json: {
      monday:    { start: '08:00', end: '15:00' },
      tuesday:   { start: '08:00', end: '15:00' },
      wednesday: { start: '08:00', end: '15:00' },
      thursday:  { start: '08:00', end: '15:00' },
      friday:    { start: '08:00', end: '15:00' },
    },
    ...overrides,
  })

  it('rule does not apply when school_enrolled is false', () => {
    const issues = checkBillingDuringSchoolHours({
      attendance: [attendanceRow({ child_id: 'kid-1', date: '2026-05-04', check_in: '09:00', check_out: '14:00' })], // monday school hours
      children: [schoolKid({ school_enrolled: false })],
    })
    expect(issues).toEqual([])
  })

  it('warns once per school-enrolled child with no schedule on file', () => {
    const issues = checkBillingDuringSchoolHours({
      attendance: [
        attendanceRow({ child_id: 'kid-1', date: '2026-05-04', check_in: '09:00', check_out: '14:00' }),
        attendanceRow({ id: 'a2', child_id: 'kid-1', date: '2026-05-05', check_in: '09:00', check_out: '14:00' }),
      ],
      children: [schoolKid({ school_bell_schedule_json: null })],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.WARNING)
  })

  it('blocks when a Monday segment overlaps the bell schedule (8-3)', () => {
    const issues = checkBillingDuringSchoolHours({
      attendance: [attendanceRow({ child_id: 'kid-1', date: '2026-05-04', check_in: '07:30', check_out: '12:00' })],
      children: [schoolKid()],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].auditCitation).toMatch(/IPV/)
  })

  it('passes a strictly-before-school segment (7:00–7:59)', () => {
    expect(checkBillingDuringSchoolHours({
      attendance: [attendanceRow({ child_id: 'kid-1', date: '2026-05-04', check_in: '07:00', check_out: '07:59' })],
      children: [schoolKid()],
    })).toEqual([])
  })

  it('passes an after-school segment (15:00–18:00)', () => {
    expect(checkBillingDuringSchoolHours({
      attendance: [attendanceRow({ child_id: 'kid-1', date: '2026-05-04', check_in: '15:00', check_out: '18:00' })],
      children: [schoolKid()],
    })).toEqual([])
  })

  it('does not flag a Saturday segment (no school that day in fixture)', () => {
    expect(checkBillingDuringSchoolHours({
      attendance: [attendanceRow({ child_id: 'kid-1', date: '2026-05-02', check_in: '09:00', check_out: '14:00' })], // Saturday
      children: [schoolKid()],
    })).toEqual([])
  })
})

describe('Rule 4 — concurrent children cap (LEP only)', () => {
  const lepProfile = { provider_type: 'lep_unrelated' }
  const licensedProfile = { provider_type: 'licensed_family' }

  const block = (childId, date, check_in, check_out) => attendanceRow({
    id: `${childId}-${date}-${check_in}`,
    child_id: childId, date, check_in, check_out,
  })

  it('passes when no more than 6 children are concurrent', () => {
    const issues = checkConcurrentChildrenCap({
      attendance: [
        block('c1', '2026-05-05', '08:00', '17:00'),
        block('c2', '2026-05-05', '08:00', '17:00'),
        block('c3', '2026-05-05', '08:00', '17:00'),
        block('c4', '2026-05-05', '08:00', '17:00'),
        block('c5', '2026-05-05', '08:00', '17:00'),
        block('c6', '2026-05-05', '08:00', '17:00'),
      ],
      profile: lepProfile,
    })
    expect(issues).toEqual([])
  })

  it('blocks when 7 children are concurrent at any timestamp', () => {
    const issues = checkConcurrentChildrenCap({
      attendance: [
        block('c1', '2026-05-05', '08:00', '17:00'),
        block('c2', '2026-05-05', '08:00', '17:00'),
        block('c3', '2026-05-05', '08:00', '17:00'),
        block('c4', '2026-05-05', '08:00', '17:00'),
        block('c5', '2026-05-05', '08:00', '17:00'),
        block('c6', '2026-05-05', '08:00', '17:00'),
        block('c7', '2026-05-05', '10:00', '14:00'),
      ],
      profile: lepProfile,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe(SEVERITY.BLOCKING)
    expect(issues[0].auditCitation).toMatch(/IPV/)
  })

  it('does not double-count when one child checks out as another checks in (same instant)', () => {
    // 6 children present 08:00-12:00; one leaves at 12:00 exactly; new child arrives 12:00.
    // Peak should be 6, not 7.
    const issues = checkConcurrentChildrenCap({
      attendance: [
        block('c1', '2026-05-05', '08:00', '12:00'),
        block('c2', '2026-05-05', '08:00', '17:00'),
        block('c3', '2026-05-05', '08:00', '17:00'),
        block('c4', '2026-05-05', '08:00', '17:00'),
        block('c5', '2026-05-05', '08:00', '17:00'),
        block('c6', '2026-05-05', '08:00', '17:00'),
        block('c7', '2026-05-05', '12:00', '17:00'),
      ],
      profile: lepProfile,
    })
    expect(issues).toEqual([])
  })

  it('returns [] for licensed providers regardless of concurrent count', () => {
    const issues = checkConcurrentChildrenCap({
      attendance: Array.from({ length: 12 }, (_, i) => block(`c${i}`, '2026-05-05', '08:00', '17:00')),
      profile: licensedProfile,
    })
    expect(issues).toEqual([])
  })

  it('returns [] when profile is missing', () => {
    expect(checkConcurrentChildrenCap({ attendance: [], profile: null })).toEqual([])
  })

  it('cap is 6 per the LEP handbook', () => {
    expect(LEP_CONCURRENT_CHILDREN_CAP).toBe(6)
  })
})

describe('runValidation — orchestration', () => {
  it('returns combined issues sorted blocking → warning → info', () => {
    const issues = runValidation({
      attendance: [attendanceRow({ child_id: 'no-source' })],
      fundingSources: [],
      payPeriod: payPeriod({ end_date: '2026-02-18' }),  // also triggers Rule 10
      profile: { full_name: 'Venessa' },
      today: TODAY,
    })
    expect(issues.length).toBeGreaterThanOrEqual(2)
    // Severity-rank descending: blocking first.
    const ranks = { blocking: 3, warning: 2, info: 1 }
    for (let i = 1; i < issues.length; i++) {
      expect(ranks[issues[i - 1].severity]).toBeGreaterThanOrEqual(ranks[issues[i].severity])
    }
  })

  it('clean-pass: only Rule 8 warning (parent-initials gap is a known schema limitation)', () => {
    // Even a fully compliant provider gets one warning today, because
    // the attendance schema has no parent-initials column. When that
    // schema gap closes (future PR), this test changes.
    const issues = runValidation({
      attendance: [attendanceRow({ child_id: 'child-1', check_in: '07:00', check_out: '17:00' })],
      children: [{ id: 'child-1', school_enrolled: false }],
      fundingSources: [cdcSource({ child_id: 'child-1' })],
      payPeriod: payPeriod(),
      profile: { id: 'provider-1', full_name: 'Venessa' },
      fiscalYearAttendance: [],
      today: TODAY,
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].ruleId).toBe(RULE.MISSING_PARENT_INITIALS)
    expect(issues[0].severity).toBe(SEVERITY.WARNING)
  })

  it('does not crash when called with no arguments', () => {
    expect(() => runValidation()).not.toThrow()
    // With no args every rule short-circuits except Rule 9 (no profile = warning).
    const issues = runValidation()
    expect(issues).toHaveLength(1)
    expect(issues[0].ruleId).toBe(RULE.MISSING_PROVIDER_NAME)
  })
})
