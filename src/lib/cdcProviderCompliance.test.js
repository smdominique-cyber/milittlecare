import { describe, it, expect } from 'vitest'
import {
  getAnnualTrainingDeadlineState,
  getFingerprintReprintState,
  ANNUAL_TRAINING_DEADLINE_MONTH,
  ANNUAL_TRAINING_DEADLINE_DAY,
  __TEST_THRESHOLDS__,
} from './cdcProviderCompliance'

describe('constants', () => {
  it('the annual deadline is December 16', () => {
    expect(ANNUAL_TRAINING_DEADLINE_MONTH).toBe(12)
    expect(ANNUAL_TRAINING_DEADLINE_DAY).toBe(16)
  })

  it('fingerprint thresholds derive from 4.5 / 5 years × 365.25', () => {
    expect(__TEST_THRESHOLDS__.FINGERPRINT_REMINDER_DAYS).toBe(1643)
    expect(__TEST_THRESHOLDS__.FINGERPRINT_URGENT_DAYS).toBe(1826)
  })
})

describe('getAnnualTrainingDeadlineState — completed-this-year short-circuit', () => {
  it('returns null when training was completed earlier this year', () => {
    expect(getAnnualTrainingDeadlineState('2026-03-15', '2026-05-20')).toBeNull()
  })

  it('returns null even when the completion is from December of this year', () => {
    expect(getAnnualTrainingDeadlineState('2026-12-15', '2026-12-20')).toBeNull()
  })

  it('does NOT short-circuit when completed_at is from last year', () => {
    // Completed Dec 2025; today is May 20, 2026 — banner suppressed only
    // because the deadline is still > 45 days out.
    const s = getAnnualTrainingDeadlineState('2025-12-10', '2026-05-20')
    expect(s).toBeNull()  // because deadline is Dec 16 2026 = 210 days out
  })

  it('does NOT short-circuit when completedDate is null', () => {
    // A never-completed provider in mid-November sees the warning.
    const s = getAnnualTrainingDeadlineState(null, '2026-11-15')
    expect(s).not.toBeNull()
  })
})

describe('getAnnualTrainingDeadlineState — severity ladder', () => {
  it('no banner when more than 45 days out', () => {
    expect(getAnnualTrainingDeadlineState(null, '2026-10-31')).toBeNull()  // 46 days
  })

  it('info at exactly 45 days', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-11-01')
    expect(s.severity).toBe('info')
    expect(s.daysUntilDeadline).toBe(45)
  })

  it('info at 31 days', () => {
    expect(getAnnualTrainingDeadlineState(null, '2026-11-15').severity).toBe('info')
  })

  it('warning at 30 days (boundary)', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-11-16')
    expect(s.severity).toBe('warning')
    expect(s.daysUntilDeadline).toBe(30)
  })

  it('warning at 16 days', () => {
    expect(getAnnualTrainingDeadlineState(null, '2026-11-30').severity).toBe('warning')
  })

  it('urgent at 15 days (boundary)', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-12-01')
    expect(s.severity).toBe('urgent')
    expect(s.daysUntilDeadline).toBe(15)
  })

  it('urgent at 7 days', () => {
    expect(getAnnualTrainingDeadlineState(null, '2026-12-09').severity).toBe('urgent')
  })

  it('critical at 6 days (boundary)', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-12-10')
    expect(s.severity).toBe('critical')
  })

  it('critical at 1 day (singular form in label)', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-12-15')
    expect(s.severity).toBe('critical')
    expect(s.daysUntilDeadline).toBe(1)
    expect(s.label).toMatch(/1 day —/)  // singular, not "days"
  })

  it('critical at exactly 0 days (Dec 16 itself)', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-12-16')
    expect(s.severity).toBe('critical')
    expect(s.daysUntilDeadline).toBe(0)
  })

  it('expired the day after the deadline', () => {
    const s = getAnnualTrainingDeadlineState(null, '2026-12-17')
    expect(s.severity).toBe('expired')
    expect(s.daysUntilDeadline).toBe(-1)
  })

  it('expired through year-end', () => {
    expect(getAnnualTrainingDeadlineState(null, '2026-12-31').severity).toBe('expired')
  })

  it('resets on Jan 1 of the next year — no banner ~350 days out', () => {
    // This documents the spec's reset behaviour: a provider who lapsed
    // last year sees no banner on Jan 1 until the new year's deadline
    // approaches. The handbook says MDHHS closes the lapsed account
    // separately; the banner doesn't model that state.
    const s = getAnnualTrainingDeadlineState('2025-12-10', '2027-01-01')
    expect(s).toBeNull()
  })
})

describe('getFingerprintReprintState — provider-type gate', () => {
  const FINGERPRINT_2_YRS_OLD = '2024-05-20'
  const FINGERPRINT_5_YRS_OLD = '2021-05-20'
  const TODAY = '2026-05-20'

  it('returns null for lep_related providers regardless of fingerprint age', () => {
    expect(getFingerprintReprintState(FINGERPRINT_5_YRS_OLD, 'lep_related', TODAY)).toBeNull()
  })

  it('returns null for licensed_family providers regardless of fingerprint age', () => {
    expect(getFingerprintReprintState(FINGERPRINT_5_YRS_OLD, 'licensed_family', TODAY)).toBeNull()
  })

  it('returns null when provider type is unknown / null', () => {
    expect(getFingerprintReprintState(FINGERPRINT_5_YRS_OLD, null, TODAY)).toBeNull()
  })

  it('returns null when fingerprintDate is missing, even for lep_unrelated', () => {
    expect(getFingerprintReprintState(null, 'lep_unrelated', TODAY)).toBeNull()
  })

  it('returns null when fingerprint is fresh (2 years old)', () => {
    expect(getFingerprintReprintState(FINGERPRINT_2_YRS_OLD, 'lep_unrelated', TODAY)).toBeNull()
  })
})

describe('getFingerprintReprintState — severity', () => {
  // Reminder boundary: 4.5 × 365.25 = 1643.625 → floor 1643.
  // Subtracting 1643 days from 2026-05-20:
  it('reminder at exactly the 4.5-year threshold (1643 days)', () => {
    // 2026-05-20 minus 1643 days ≈ 2021-11-19
    const s = getFingerprintReprintState('2021-11-19', 'lep_unrelated', '2026-05-20')
    expect(s).not.toBeNull()
    expect(s.severity).toBe('reminder')
    expect(s.ageDays).toBe(1643)
  })

  it('still reminder one day before the urgent threshold (1825 days)', () => {
    const s = getFingerprintReprintState('2021-05-21', 'lep_unrelated', '2026-05-20')
    expect(s.severity).toBe('reminder')
    expect(s.ageDays).toBe(1825)
  })

  it('urgent at exactly the 5-year threshold (1826 days)', () => {
    const s = getFingerprintReprintState('2021-05-20', 'lep_unrelated', '2026-05-20')
    expect(s.severity).toBe('urgent')
    expect(s.ageDays).toBe(1826)
  })

  it('urgent well past 5 years', () => {
    const s = getFingerprintReprintState('2019-01-01', 'lep_unrelated', '2026-05-20')
    expect(s.severity).toBe('urgent')
    expect(s.ageDays).toBeGreaterThan(__TEST_THRESHOLDS__.FINGERPRINT_URGENT_DAYS)
  })

  it('fingerprint dated in the future returns null (negative age, no warning)', () => {
    expect(getFingerprintReprintState('2030-01-01', 'lep_unrelated', '2026-05-20')).toBeNull()
  })
})
