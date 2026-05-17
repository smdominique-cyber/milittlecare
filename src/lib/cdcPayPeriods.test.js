import { describe, it, expect } from 'vitest'
import {
  getCurrentPeriod,
  getNextPeriod,
  getPeriodDisplayStatus,
  getDeadlineCountdown,
  findCatalogContiguityGaps,
  todayYMD,
  PERIOD_STATUS,
} from './cdcPayPeriods'

// -----------------------------------------------------------------------------
// Seed-data fixture
//
// All 52 catalog rows (2025 + 2026), transcribed from
// docs/cdc_pay_periods_spec.md Appendix A — INDEPENDENTLY from the
// transcription in supabase/migrations/010_cdc_pay_period_catalog.sql.
// The contiguity test below runs over this fixture; a gap or overlap
// here means a transcription error in Appendix A (spec § 7.5).
//
// Tuple order: [year, number, start, end, deadline, is4pm, payDate, delayed]
// -----------------------------------------------------------------------------

const mk = ([
  schedule_year, period_number, start_date, end_date,
  reporting_deadline, deadline_is_4pm, expected_payment_date, payment_may_be_delayed,
]) => ({
  id: `seed-${period_number}`,
  schedule_year,
  period_number,
  start_date,
  end_date,
  reporting_deadline,
  deadline_is_4pm,
  expected_payment_date,
  payment_may_be_delayed,
})

const SEED_2025 = [
  [2025, 501, '2024-12-29', '2025-01-11', '2025-01-16', false, '2025-01-24', true],
  [2025, 502, '2025-01-12', '2025-01-25', '2025-01-30', false, '2025-02-06', false],
  [2025, 503, '2025-01-26', '2025-02-08', '2025-02-13', false, '2025-02-21', true],
  [2025, 504, '2025-02-09', '2025-02-22', '2025-02-27', false, '2025-03-06', false],
  [2025, 505, '2025-02-23', '2025-03-08', '2025-03-13', false, '2025-03-20', false],
  [2025, 506, '2025-03-09', '2025-03-22', '2025-03-27', false, '2025-04-03', false],
  [2025, 507, '2025-03-23', '2025-04-05', '2025-04-10', false, '2025-04-17', false],
  [2025, 508, '2025-04-06', '2025-04-19', '2025-04-24', false, '2025-05-01', false],
  [2025, 509, '2025-04-20', '2025-05-03', '2025-05-08', false, '2025-05-15', false],
  [2025, 510, '2025-05-04', '2025-05-17', '2025-05-22', false, '2025-05-30', true],
  [2025, 511, '2025-05-18', '2025-05-31', '2025-06-05', false, '2025-06-12', false],
  [2025, 512, '2025-06-01', '2025-06-14', '2025-06-19', false, '2025-06-26', false],
  [2025, 513, '2025-06-15', '2025-06-28', '2025-07-02', true,  '2025-07-10', false],
  [2025, 514, '2025-06-29', '2025-07-12', '2025-07-17', false, '2025-07-24', false],
  [2025, 515, '2025-07-13', '2025-07-26', '2025-07-31', false, '2025-08-07', false],
  [2025, 516, '2025-07-27', '2025-08-09', '2025-08-14', false, '2025-08-21', false],
  [2025, 517, '2025-08-10', '2025-08-23', '2025-08-28', false, '2025-09-05', true],
  [2025, 518, '2025-08-24', '2025-09-06', '2025-09-11', false, '2025-09-18', false],
  [2025, 519, '2025-09-07', '2025-09-20', '2025-09-25', false, '2025-10-02', false],
  [2025, 520, '2025-09-21', '2025-10-04', '2025-10-09', false, '2025-10-16', false],
  [2025, 521, '2025-10-05', '2025-10-18', '2025-10-23', false, '2025-10-30', false],
  [2025, 522, '2025-10-19', '2025-11-01', '2025-11-06', false, '2025-11-14', true],
  [2025, 523, '2025-11-02', '2025-11-15', '2025-11-19', true,  '2025-11-26', false],
  [2025, 524, '2025-11-16', '2025-11-29', '2025-12-04', false, '2025-12-11', false],
  [2025, 525, '2025-11-30', '2025-12-13', '2025-12-17', true,  '2025-12-26', true],
  [2025, 526, '2025-12-14', '2025-12-27', '2026-01-01', false, '2026-01-08', false],
].map(mk)

const SEED_2026 = [
  [2026, 601, '2025-12-28', '2026-01-10', '2026-01-15', false, '2026-01-23', true],
  [2026, 602, '2026-01-11', '2026-01-24', '2026-01-29', false, '2026-02-05', false],
  [2026, 603, '2026-01-25', '2026-02-07', '2026-02-12', false, '2026-02-20', true],
  [2026, 604, '2026-02-08', '2026-02-21', '2026-02-26', false, '2026-03-05', false],
  [2026, 605, '2026-02-22', '2026-03-07', '2026-03-12', false, '2026-03-19', false],
  [2026, 606, '2026-03-08', '2026-03-21', '2026-03-26', false, '2026-04-02', false],
  [2026, 607, '2026-03-22', '2026-04-04', '2026-04-09', false, '2026-04-16', false],
  [2026, 608, '2026-04-05', '2026-04-18', '2026-04-23', false, '2026-04-30', false],
  [2026, 609, '2026-04-19', '2026-05-02', '2026-05-07', false, '2026-05-14', false],
  [2026, 610, '2026-05-03', '2026-05-16', '2026-05-21', false, '2026-05-29', true],
  [2026, 611, '2026-05-17', '2026-05-30', '2026-06-04', false, '2026-06-11', false],
  [2026, 612, '2026-05-31', '2026-06-13', '2026-06-17', true,  '2026-06-25', false],
  [2026, 613, '2026-06-14', '2026-06-27', '2026-07-01', true,  '2026-07-09', false],
  [2026, 614, '2026-06-28', '2026-07-11', '2026-07-16', false, '2026-07-23', false],
  [2026, 615, '2026-07-12', '2026-07-25', '2026-07-30', false, '2026-08-06', false],
  [2026, 616, '2026-07-26', '2026-08-08', '2026-08-13', false, '2026-08-20', false],
  [2026, 617, '2026-08-09', '2026-08-22', '2026-08-27', false, '2026-09-03', false],
  [2026, 618, '2026-08-23', '2026-09-05', '2026-09-10', false, '2026-09-17', false],
  [2026, 619, '2026-09-06', '2026-09-19', '2026-09-24', false, '2026-10-01', false],
  [2026, 620, '2026-09-20', '2026-10-03', '2026-10-08', false, '2026-10-16', true],
  [2026, 621, '2026-10-04', '2026-10-17', '2026-10-22', false, '2026-10-29', false],
  [2026, 622, '2026-10-18', '2026-10-31', '2026-11-05', false, '2026-11-13', true],
  [2026, 623, '2026-11-01', '2026-11-14', '2026-11-19', false, '2026-12-01', true],
  [2026, 624, '2026-11-15', '2026-11-28', '2026-12-03', false, '2026-12-10', false],
  [2026, 625, '2026-11-29', '2026-12-12', '2026-12-17', false, '2026-12-28', true],
  [2026, 626, '2026-12-13', '2026-12-26', '2026-12-29', false, '2027-01-07', false],
].map(mk)

const CATALOG = [...SEED_2025, ...SEED_2026]

// Convenience accessor for a specific seeded period.
const period = (num) => CATALOG.find(p => p.period_number === num)

// -----------------------------------------------------------------------------
// getCurrentPeriod
// -----------------------------------------------------------------------------

describe('getCurrentPeriod', () => {
  it('finds the period whose window contains today', () => {
    // 2026-05-15 falls inside period 610 (May 3 – May 16, 2026).
    expect(getCurrentPeriod('2026-05-15', CATALOG)?.period_number).toBe(610)
  })

  it('treats start_date as the inclusive lower bound', () => {
    expect(getCurrentPeriod('2026-05-03', CATALOG)?.period_number).toBe(610)
  })

  it('treats end_date as the inclusive upper bound', () => {
    expect(getCurrentPeriod('2026-05-16', CATALOG)?.period_number).toBe(610)
  })

  it('returns the year-boundary period for a late-December date', () => {
    // Period 601 (2026 schedule) runs Dec 28, 2025 – Jan 10, 2026.
    expect(getCurrentPeriod('2025-12-28', CATALOG)?.period_number).toBe(601)
    expect(getCurrentPeriod('2026-01-01', CATALOG)?.period_number).toBe(601)
    expect(getCurrentPeriod('2026-01-10', CATALOG)?.period_number).toBe(601)
  })

  it('searches across schedule years (does not scope to one year)', () => {
    // The 601 case above already crosses years; assert the 2025→2026
    // handoff explicitly: 526 ends Dec 27 2025, 601 starts Dec 28.
    expect(getCurrentPeriod('2025-12-27', CATALOG)?.period_number).toBe(526)
    expect(getCurrentPeriod('2025-12-28', CATALOG)?.period_number).toBe(601)
  })

  it('returns null when today is past the last seeded period', () => {
    // Period 626 ends Dec 26, 2026. Dec 31, 2026 belongs to period
    // 701, which is not seeded yet (spec § 7.4).
    expect(getCurrentPeriod('2026-12-31', CATALOG)).toBeNull()
    expect(getCurrentPeriod('2027-06-01', CATALOG)).toBeNull()
  })

  it('returns null when today is before the first seeded period', () => {
    expect(getCurrentPeriod('2024-01-01', CATALOG)).toBeNull()
  })

  it('handles an empty / missing catalog without throwing', () => {
    expect(getCurrentPeriod('2026-05-15', [])).toBeNull()
    expect(getCurrentPeriod('2026-05-15', undefined)).toBeNull()
  })

  it('defaults today to the local date when omitted', () => {
    // Can't assert the exact period without freezing time; assert the
    // result is internally consistent with todayYMD().
    const expected = getCurrentPeriod(todayYMD(), CATALOG)
    expect(getCurrentPeriod(undefined, CATALOG)).toEqual(expected)
  })
})

// -----------------------------------------------------------------------------
// getNextPeriod
// -----------------------------------------------------------------------------

describe('getNextPeriod', () => {
  it('returns the period with the smallest start_date after today', () => {
    // Inside period 610; the next period is 611 (starts May 17, 2026).
    expect(getNextPeriod('2026-05-15', CATALOG)?.period_number).toBe(611)
  })

  it('does not return a period that starts exactly today (strictly greater)', () => {
    // 2026-05-17 is period 611's start_date; "next" must be 612.
    expect(getNextPeriod('2026-05-17', CATALOG)?.period_number).toBe(612)
  })

  it('crosses the schedule-year boundary', () => {
    // Late in period 526, the next period is 601 of the 2026 schedule.
    expect(getNextPeriod('2025-12-20', CATALOG)?.period_number).toBe(601)
  })

  it('returns null when today is on/after the last seeded start_date', () => {
    // Period 626 starts Dec 13, 2026 — nothing starts later.
    expect(getNextPeriod('2026-12-13', CATALOG)).toBeNull()
    expect(getNextPeriod('2027-01-01', CATALOG)).toBeNull()
  })

  it('returns the very first period when today precedes the schedule', () => {
    expect(getNextPeriod('2024-01-01', CATALOG)?.period_number).toBe(501)
  })

  it('handles an empty / missing catalog without throwing', () => {
    expect(getNextPeriod('2026-05-15', [])).toBeNull()
    expect(getNextPeriod('2026-05-15', null)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// getPeriodDisplayStatus
// -----------------------------------------------------------------------------

describe('getPeriodDisplayStatus', () => {
  // Period 610: care May 3–16, reporting deadline May 21, 2026.
  const p610 = period(610)

  it('reports "upcoming" before the period starts', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-02')).toBe(PERIOD_STATUS.UPCOMING)
  })

  it('reports "current" on the start_date (inclusive)', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-03')).toBe(PERIOD_STATUS.CURRENT)
  })

  it('reports "current" mid-period', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-10')).toBe(PERIOD_STATUS.CURRENT)
  })

  it('reports "current" on the end_date (inclusive)', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-16')).toBe(PERIOD_STATUS.CURRENT)
  })

  it('reports "open_for_billing" the day after the period ends', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-17')).toBe(PERIOD_STATUS.OPEN_FOR_BILLING)
  })

  it('reports "open_for_billing" on the reporting deadline (inclusive)', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-21')).toBe(PERIOD_STATUS.OPEN_FOR_BILLING)
  })

  it('reports "billing_closed" the day after the reporting deadline', () => {
    expect(getPeriodDisplayStatus(p610, '2026-05-22')).toBe(PERIOD_STATUS.BILLING_CLOSED)
  })

  it('walks all four states in order for a single period', () => {
    const seen = [
      getPeriodDisplayStatus(p610, '2026-05-01'),
      getPeriodDisplayStatus(p610, '2026-05-10'),
      getPeriodDisplayStatus(p610, '2026-05-18'),
      getPeriodDisplayStatus(p610, '2026-06-01'),
    ]
    expect(seen).toEqual([
      PERIOD_STATUS.UPCOMING,
      PERIOD_STATUS.CURRENT,
      PERIOD_STATUS.OPEN_FOR_BILLING,
      PERIOD_STATUS.BILLING_CLOSED,
    ])
  })

  it('returns null for a missing period', () => {
    expect(getPeriodDisplayStatus(null, '2026-05-15')).toBeNull()
    expect(getPeriodDisplayStatus(undefined, '2026-05-15')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// getDeadlineCountdown
// -----------------------------------------------------------------------------

describe('getDeadlineCountdown', () => {
  it('counts whole days until the reporting deadline', () => {
    // Period 610 deadline is 2026-05-21; from 2026-05-15 that is 6 days
    // (matches the spec § 3.2 mock — "(6 days left)").
    expect(getDeadlineCountdown(period(610), '2026-05-15')).toBe(6)
  })

  it('returns 0 on the deadline day', () => {
    expect(getDeadlineCountdown(period(610), '2026-05-21')).toBe(0)
  })

  it('returns a negative count once the deadline has passed', () => {
    expect(getDeadlineCountdown(period(610), '2026-05-25')).toBe(-4)
  })

  it('counts correctly across a daylight-saving boundary (UTC math, no off-by-one)', () => {
    // US DST falls back on 2026-11-01. Period 622's deadline is
    // 2026-11-05; from 2026-10-31 that is 5 days, spanning the change.
    expect(getDeadlineCountdown(period(622), '2026-10-31')).toBe(5)
  })

  it('returns null for a missing period', () => {
    expect(getDeadlineCountdown(null, '2026-05-15')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// findCatalogContiguityGaps — the spec § 7.5 seed-data assertion
// -----------------------------------------------------------------------------

describe('findCatalogContiguityGaps (seed-data integrity)', () => {
  it('the 2025 + 2026 seed data is contiguous with no gaps or overlaps', () => {
    expect(findCatalogContiguityGaps(CATALOG)).toEqual([])
  })

  it('the seed data is exactly 52 periods, 26 per schedule year', () => {
    expect(CATALOG).toHaveLength(52)
    expect(SEED_2025).toHaveLength(26)
    expect(SEED_2026).toHaveLength(26)
  })

  it('every period number encodes its schedule year (5xx → 2025, 6xx → 2026)', () => {
    for (const p of CATALOG) {
      expect(Math.floor(p.period_number / 100)).toBe(p.schedule_year - 2020)
    }
  })

  it('every period ends on or after it starts', () => {
    for (const p of CATALOG) {
      expect(p.end_date >= p.start_date).toBe(true)
    }
  })

  it('detects an injected gap', () => {
    // Drop period 502 — 501 → 503 should now be reported as a gap.
    const withGap = CATALOG.filter(p => p.period_number !== 502)
    const gaps = findCatalogContiguityGaps(withGap)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].afterPeriod).toBe(501)
    expect(gaps[0].beforePeriod).toBe(503)
  })

  it('detects an injected overlap', () => {
    const withOverlap = CATALOG.map(p =>
      p.period_number === 502 ? { ...p, start_date: '2025-01-10' } : p
    )
    const gaps = findCatalogContiguityGaps(withOverlap)
    expect(gaps.length).toBeGreaterThan(0)
  })

  it('returns [] for an empty catalog (no pairs to compare)', () => {
    expect(findCatalogContiguityGaps([])).toEqual([])
  })
})
