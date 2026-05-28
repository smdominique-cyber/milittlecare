import { describe, it, expect } from 'vitest'
import {
  addMonthsYMD,
  addYearsYMD,
  nextOccurrence,
  shouldRemindNow,
} from './reminderSchedule'

// ─── Date arithmetic primitives ──────────────────────────────────────

describe('addMonthsYMD', () => {
  it('adds positive months within the same year', () => {
    expect(addMonthsYMD('2026-03-15', 3)).toBe('2026-06-15')
  })

  it('rolls into the next year', () => {
    expect(addMonthsYMD('2026-11-10', 4)).toBe('2027-03-10')
  })

  it('clamps day to destination month length (Jan 31 + 1 = Feb 28)', () => {
    expect(addMonthsYMD('2026-01-31', 1)).toBe('2026-02-28')
  })

  it('clamps to Feb 29 on leap years', () => {
    expect(addMonthsYMD('2024-01-31', 1)).toBe('2024-02-29')
  })

  it('handles negative months (subtraction)', () => {
    expect(addMonthsYMD('2026-03-15', -3)).toBe('2025-12-15')
  })
})

describe('addYearsYMD', () => {
  it('adds 1 year preserving month and day', () => {
    expect(addYearsYMD('2026-05-28', 1)).toBe('2027-05-28')
  })

  it('clamps Feb 29 to Feb 28 in the destination year', () => {
    expect(addYearsYMD('2024-02-29', 1)).toBe('2025-02-28')
  })

  it('handles multi-year intervals (radon / heating cadence: 4 years)', () => {
    expect(addYearsYMD('2026-05-28', 4)).toBe('2030-05-28')
  })
})

// ─── nextOccurrence — three recurrence shapes ─────────────────────────

describe('nextOccurrence — every_n_months', () => {
  it('fire drill: every 3 months from last performed', () => {
    expect(nextOccurrence({
      kind: 'every_n_months',
      lastPerformedOn: '2026-03-10',
      intervalMonths: 3,
    }, '2026-05-28')).toBe('2026-06-10')
  })

  it('returns today when never performed (overdue from day one)', () => {
    expect(nextOccurrence({
      kind: 'every_n_months',
      lastPerformedOn: null,
      intervalMonths: 3,
    }, '2026-05-28')).toBe('2026-05-28')
  })

  it('returns null for non-positive interval', () => {
    expect(nextOccurrence({
      kind: 'every_n_months',
      lastPerformedOn: '2026-01-01',
      intervalMonths: 0,
    }, '2026-05-28')).toBeNull()
    expect(nextOccurrence({
      kind: 'every_n_months',
      lastPerformedOn: '2026-01-01',
      intervalMonths: -3,
    }, '2026-05-28')).toBeNull()
  })
})

describe('nextOccurrence — annual', () => {
  it('one year from last performed (annual review / physician attestation)', () => {
    expect(nextOccurrence({
      kind: 'annual',
      lastPerformedOn: '2026-05-28',
    }, '2026-06-01')).toBe('2027-05-28')
  })

  it('returns today when never performed', () => {
    expect(nextOccurrence({
      kind: 'annual',
      lastPerformedOn: null,
    }, '2026-05-28')).toBe('2026-05-28')
  })

  it('respects leap-year clamping', () => {
    expect(nextOccurrence({
      kind: 'annual',
      lastPerformedOn: '2024-02-29',
    }, '2025-01-01')).toBe('2025-02-28')
  })
})

describe('nextOccurrence — seasonal_window (tornado drill)', () => {
  // Tornado drill spec: 2x annually between March (3) and November (11).
  const tornadoRule = (history) => ({
    kind: 'seasonal_window',
    windowStartMonth: 3,
    windowEndMonth: 11,
    requiredCount: 2,
    historyInWindow: history,
  })

  it('returns null when both required drills are done', () => {
    expect(nextOccurrence(
      tornadoRule(['2026-04-15', '2026-09-10']),
      '2026-10-01',
    )).toBeNull()
  })

  it('returns the first day of the window when window has not started yet (no drills)', () => {
    expect(nextOccurrence(
      tornadoRule([]),
      '2026-01-15',
    )).toBe('2026-03-01')
  })

  it('returns today when window is active and provider is short', () => {
    expect(nextOccurrence(
      tornadoRule(['2026-04-15']),
      '2026-07-20',
    )).toBe('2026-07-20')
  })

  it('returns null when the window is closed and the requirement was not met (sad path)', () => {
    expect(nextOccurrence(
      tornadoRule(['2026-04-15']),
      '2026-12-15',
    )).toBeNull()
  })

  it('only counts history rows in the current year', () => {
    // Two drills from last year don't satisfy this year.
    expect(nextOccurrence(
      tornadoRule(['2025-04-15', '2025-09-10']),
      '2026-01-15',
    )).toBe('2026-03-01')
  })

  it('returns null for invalid window months', () => {
    expect(nextOccurrence({
      kind: 'seasonal_window',
      windowStartMonth: 13,
      windowEndMonth: 11,
      requiredCount: 2,
      historyInWindow: [],
    }, '2026-05-28')).toBeNull()
  })

  it('returns null for non-positive requiredCount', () => {
    expect(nextOccurrence({
      kind: 'seasonal_window',
      windowStartMonth: 3,
      windowEndMonth: 11,
      requiredCount: 0,
      historyInWindow: [],
    }, '2026-05-28')).toBeNull()
  })
})

describe('nextOccurrence — defensive', () => {
  it('returns null for unknown rule kind', () => {
    expect(nextOccurrence({ kind: 'mystery' }, '2026-05-28')).toBeNull()
  })

  it('returns null for nullish input', () => {
    expect(nextOccurrence(null, '2026-05-28')).toBeNull()
    expect(nextOccurrence(undefined, '2026-05-28')).toBeNull()
  })
})

// ─── shouldRemindNow ──────────────────────────────────────────────────

describe('shouldRemindNow', () => {
  it('fires when due is within the lead window', () => {
    // 10 days out, 30-day lead → fire.
    expect(shouldRemindNow('2026-06-07', 30, '2026-05-28')).toBe(true)
  })

  it('does not fire when due is beyond the lead window', () => {
    // 40 days out, 30-day lead → silent.
    expect(shouldRemindNow('2026-07-07', 30, '2026-05-28')).toBe(false)
  })

  it('fires exactly on the lead boundary', () => {
    // 30 days out, 30-day lead → fire (inclusive).
    expect(shouldRemindNow('2026-06-27', 30, '2026-05-28')).toBe(true)
  })

  it('fires when overdue (negative delta)', () => {
    // Due 10 days ago, any lead → fire.
    expect(shouldRemindNow('2026-05-18', 7, '2026-05-28')).toBe(true)
  })

  it('fires on the day-of when due_at == today', () => {
    expect(shouldRemindNow('2026-05-28', 0, '2026-05-28')).toBe(true)
  })

  it('returns false for missing dueAt', () => {
    expect(shouldRemindNow(null, 30, '2026-05-28')).toBe(false)
    expect(shouldRemindNow('', 30, '2026-05-28')).toBe(false)
  })

  it('coerces negative leadTimeDays to 0', () => {
    // 10 days out, lead = -5 → treated as 0 → silent (10 > 0).
    expect(shouldRemindNow('2026-06-07', -5, '2026-05-28')).toBe(false)
  })

  it('coerces non-numeric leadTimeDays to 0', () => {
    expect(shouldRemindNow('2026-06-07', 'foo', '2026-05-28')).toBe(false)
  })
})
