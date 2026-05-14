import { describe, it, expect } from 'vitest'
import {
  getAnnualDeadlineStatus,
  getLoggedHoursThisYear,
  getLeppTCompletion,
  todayYMD,
  SOURCE,
} from './miregistry'

// Small helper: a default training entry with the fields these
// helpers care about. Override per test.
const e = (overrides = {}) => ({
  id: 'fake-uuid',
  user_id: 'user-1',
  completed_on: '2026-05-14',
  hours: 1.0,
  title: 'Some training',
  source: SOURCE.OTHER,
  archived_at: null,
  ...overrides,
})

// -----------------------------------------------------------------------------
// getAnnualDeadlineStatus
// -----------------------------------------------------------------------------

describe('getAnnualDeadlineStatus', () => {
  describe('completion detection', () => {
    it('reports not completed when there are no entries', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [],
        today: '2026-05-14',
      })
      expect(r.completed).toBe(false)
      expect(r.completionDate).toBeNull()
    })

    it('reports completed when an annual_ongoing entry sits inside the window', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-11-05' })],
        today: '2026-12-01',
      })
      expect(r.completed).toBe(true)
      expect(r.completionDate).toBe('2026-11-05')
    })

    it('treats Jan 1 as the inclusive lower bound', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-01-01' })],
        today: '2026-06-01',
      })
      expect(r.completed).toBe(true)
      expect(r.completionDate).toBe('2026-01-01')
    })

    it('treats Dec 16 as the inclusive upper bound', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-12-16' })],
        today: '2026-12-16',
      })
      expect(r.completed).toBe(true)
      expect(r.completionDate).toBe('2026-12-16')
    })

    it('does NOT count Dec 17 of year Y as completing year Y', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-12-17' })],
        today: '2026-12-20',
      })
      expect(r.completed).toBe(false)
      expect(r.completionDate).toBeNull()
    })

    it('a Dec 17 of year Y entry also does NOT count for year Y+1 (strict per-year window)', () => {
      // Per handbook page 12 + spec § 5.2: missing Dec 16 closes the
      // account, no carry-over. Year Y+1 needs its own completion
      // inside year Y+1.
      const r = getAnnualDeadlineStatus({
        year: 2027,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-12-17' })],
        today: '2027-01-15',
      })
      expect(r.completed).toBe(false)
    })

    it('does NOT count an annual_ongoing entry from a previous year', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2025-11-05' })],
        today: '2026-06-01',
      })
      expect(r.completed).toBe(false)
    })

    it('does NOT count a future-year entry', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2027-03-01' })],
        today: '2026-06-01',
      })
      expect(r.completed).toBe(false)
    })

    it('excludes archived annual_ongoing entries', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [
          e({
            source: SOURCE.ANNUAL_ONGOING,
            completed_on: '2026-11-05',
            archived_at: '2026-11-06T10:00:00Z',
          }),
        ],
        today: '2026-12-01',
      })
      expect(r.completed).toBe(false)
    })

    it('does NOT count non-annual_ongoing entries (leppt, level_2, other)', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [
          e({ source: SOURCE.LEPPT,            completed_on: '2026-03-01' }),
          e({ source: SOURCE.LEVEL_2_APPROVED, completed_on: '2026-04-01' }),
          e({ source: SOURCE.OTHER,            completed_on: '2026-05-01' }),
        ],
        today: '2026-12-01',
      })
      expect(r.completed).toBe(false)
    })

    it('returns the EARLIEST qualifying date when multiple annual_ongoing exist (display copy uses "Completed Nov 5")', () => {
      const r = getAnnualDeadlineStatus({
        year: 2026,
        entries: [
          e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-11-05' }),
          e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-04-15' }),
        ],
        today: '2026-12-01',
      })
      expect(r.completionDate).toBe('2026-04-15')
    })
  })

  describe('deadline math', () => {
    it('returns the right deadlineDate for the given year', () => {
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [], today: '2026-05-14' })
      expect(r.deadlineDate).toBe('2026-12-16')
    })

    it('reports positive daysUntilDeadline when today is before Dec 16', () => {
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [], today: '2026-05-14' })
      expect(r.daysUntilDeadline).toBeGreaterThan(0)
      expect(r.isPastDeadline).toBe(false)
    })

    it('reports daysUntilDeadline = 0 and isPastDeadline = false when today IS Dec 16', () => {
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [], today: '2026-12-16' })
      expect(r.daysUntilDeadline).toBe(0)
      expect(r.isPastDeadline).toBe(false)
    })

    it('reports negative daysUntilDeadline and isPastDeadline = true when today is past Dec 16', () => {
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [], today: '2026-12-17' })
      expect(r.daysUntilDeadline).toBeLessThan(0)
      expect(r.isPastDeadline).toBe(true)
    })

    it('counts days correctly across a daylight-saving boundary (UTC math, no off-by-one)', () => {
      // US DST falls back on 2026-11-01. From 2026-10-31 to 2026-12-16 is 46 days.
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [], today: '2026-10-31' })
      expect(r.daysUntilDeadline).toBe(46)
    })

    it('accepts today defaulting to actual today when omitted', () => {
      const r = getAnnualDeadlineStatus({ year: 2026, entries: [] })
      // Sanity: deadlineDate is correct and the result matches a manual
      // computation against today() — we can't assert the exact day value
      // without freezing time, so just check the math is internally consistent.
      const expectedDays = Math.round(
        (Date.UTC(2026, 11, 16) - Date.UTC(
          new Date().getFullYear(),
          new Date().getMonth(),
          new Date().getDate()
        )) / (1000 * 60 * 60 * 24)
      )
      expect(r.daysUntilDeadline).toBe(expectedDays)
    })
  })
})

// -----------------------------------------------------------------------------
// getLoggedHoursThisYear
// -----------------------------------------------------------------------------

describe('getLoggedHoursThisYear', () => {
  it('returns 0 for empty entries', () => {
    expect(getLoggedHoursThisYear({ year: 2026, entries: [] })).toBe(0)
  })

  it('returns the hours of a single in-year entry', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [e({ completed_on: '2026-05-14', hours: 2.5 })],
    })).toBe(2.5)
  })

  it('sums hours across multiple in-year entries', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ completed_on: '2026-01-15', hours: 1.0 }),
        e({ completed_on: '2026-06-01', hours: 2.5 }),
        e({ completed_on: '2026-11-30', hours: 3.0 }),
      ],
    })).toBe(6.5)
  })

  it('counts entries from ALL source types (no source filtering)', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ source: SOURCE.LEPPT,            completed_on: '2026-02-01', hours: 8 }),
        e({ source: SOURCE.ANNUAL_ONGOING,   completed_on: '2026-04-01', hours: 2 }),
        e({ source: SOURCE.LEVEL_2_APPROVED, completed_on: '2026-06-01', hours: 3 }),
        e({ source: SOURCE.OTHER,            completed_on: '2026-08-01', hours: 1 }),
      ],
    })).toBe(14)
  })

  it('excludes entries from a previous year', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ completed_on: '2025-12-31', hours: 100 }),  // out
        e({ completed_on: '2026-01-01', hours: 1 }),    // in (Jan 1 inclusive)
      ],
    })).toBe(1)
  })

  it('excludes entries from a future year', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ completed_on: '2026-12-31', hours: 1 }),    // in (Dec 31 inclusive)
        e({ completed_on: '2027-01-01', hours: 100 }),  // out
      ],
    })).toBe(1)
  })

  it('excludes archived entries even if they are in-year', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ completed_on: '2026-05-14', hours: 1, archived_at: '2026-06-01T00:00:00Z' }),
        e({ completed_on: '2026-07-14', hours: 2 }),
      ],
    })).toBe(2)
  })

  it('coerces string-typed hours (Postgres numeric round-trips as string in some clients)', () => {
    expect(getLoggedHoursThisYear({
      year: 2026,
      entries: [
        e({ completed_on: '2026-05-14', hours: '1.5' }),
        e({ completed_on: '2026-06-14', hours: '2.0' }),
      ],
    })).toBe(3.5)
  })

  it('counts a leap-year Feb 29 entry toward that year (defensive: lexicographic + Date.UTC stay correct)', () => {
    // 2024-02-29 is a real date only in leap years. If a future
    // refactor accidentally goes through a non-UTC Date constructor or
    // a numeric month/day arithmetic path, this is the case that breaks.
    expect(getLoggedHoursThisYear({
      year: 2024,
      entries: [
        e({ completed_on: '2024-02-29', hours: 1.5 }),
      ],
    })).toBe(1.5)
  })
})

// -----------------------------------------------------------------------------
// getLeppTCompletion
// -----------------------------------------------------------------------------

describe('getLeppTCompletion', () => {
  it('reports not completed when there are no entries', () => {
    expect(getLeppTCompletion({ entries: [] })).toEqual({
      completed: false,
      completionDate: null,
    })
  })

  it('reports completed with the entry date when one leppt entry exists', () => {
    expect(getLeppTCompletion({
      entries: [e({ source: SOURCE.LEPPT, completed_on: '2026-02-01' })],
    })).toEqual({ completed: true, completionDate: '2026-02-01' })
  })

  it('returns the MOST RECENT date when multiple leppt entries exist', () => {
    expect(getLeppTCompletion({
      entries: [
        e({ source: SOURCE.LEPPT, completed_on: '2024-01-15' }),
        e({ source: SOURCE.LEPPT, completed_on: '2026-02-01' }),  // newest
        e({ source: SOURCE.LEPPT, completed_on: '2025-06-30' }),
      ],
    })).toEqual({ completed: true, completionDate: '2026-02-01' })
  })

  it('excludes archived leppt entries', () => {
    expect(getLeppTCompletion({
      entries: [
        e({
          source: SOURCE.LEPPT,
          completed_on: '2026-02-01',
          archived_at: '2026-02-02T00:00:00Z',
        }),
      ],
    })).toEqual({ completed: false, completionDate: null })
  })

  it('does not count non-leppt entries', () => {
    expect(getLeppTCompletion({
      entries: [
        e({ source: SOURCE.ANNUAL_ONGOING,   completed_on: '2026-03-01' }),
        e({ source: SOURCE.LEVEL_2_APPROVED, completed_on: '2026-04-01' }),
        e({ source: SOURCE.OTHER,            completed_on: '2026-05-01' }),
      ],
    })).toEqual({ completed: false, completionDate: null })
  })

  it('mixed: returns the leppt completion date even when other source types are present', () => {
    expect(getLeppTCompletion({
      entries: [
        e({ source: SOURCE.LEPPT,          completed_on: '2026-02-01' }),
        e({ source: SOURCE.ANNUAL_ONGOING, completed_on: '2026-11-05' }),
      ],
    })).toEqual({ completed: true, completionDate: '2026-02-01' })
  })
})

// -----------------------------------------------------------------------------
// todayYMD (sanity)
// -----------------------------------------------------------------------------

describe('todayYMD', () => {
  it('returns a YYYY-MM-DD string', () => {
    const out = todayYMD()
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('matches the current local date', () => {
    const d = new Date()
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(todayYMD()).toBe(expected)
  })
})
