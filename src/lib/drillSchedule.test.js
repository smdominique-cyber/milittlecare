// 2026-06-17 — PR #19 drill-schedule tests.
//
// Three test surfaces:
//
//   1. Per-summary unit tests covering the canonical drill states:
//      never logged / recent / overdue, plus the tornado seasonal-
//      window edge cases (before window, in window-short, in window-
//      satisfied, after window-missed).
//
//   2. THE LOAD-BEARING CONSISTENCY TESTS. The compliance row
//      resolvers and the (planned) reminder scheduler must produce
//      identical due-dates for the same drill history. Since both
//      sides call the same `nextOccurrence` via the same rule
//      shapes, these tests assert that "same rule literal → same
//      date" — a regression-net against future drift where a copy of
//      the rule shape diverges by a typo (intervalMonths: 4 instead
//      of 3, requiredCount: 1 instead of 2, etc.).
//
//   3. Sort-on-archived-aware tests: archived rows must not
//      contribute to `lastPerformedOn`, and the sort must pick the
//      latest performed_on among active rows even when rows arrive
//      in arbitrary order.

import { describe, it, expect } from 'vitest'
import {
  DRILL_TYPES,
  OTHER_EMERGENCY_DRILL_TYPES,
  FIRE_DRILL_INTERVAL_MONTHS,
  TORNADO_WINDOW_START_MONTH,
  TORNADO_WINDOW_END_MONTH,
  TORNADO_REQUIRED_COUNT,
  buildFireDrillRule,
  buildTornadoDrillRule,
  buildOtherEmergencyDrillRule,
  getFireDrillSummary,
  getTornadoDrillSummary,
  getOtherEmergencyDrillSummary,
} from './drillSchedule'
import { nextOccurrence, addMonthsYMD } from './reminderSchedule'

// Fixture builder. The shape mirrors what the loader will pull from
// the drill_logs table (per migration 044).
const log = (overrides = {}) => ({
  id: `dl-${Math.random().toString(36).slice(2)}`,
  user_id: 'u-1',
  drill_type: 'fire',
  performed_on: '2026-05-01',
  duration_minutes: null,
  notes: null,
  archived_at: null,
  ...overrides,
})

// ─── constants ───────────────────────────────────────────────────────

describe('constants pin the regulation', () => {
  it('drill types match the SQL CHECK whitelist in migration 044', () => {
    expect(DRILL_TYPES).toEqual([
      'fire',
      'tornado',
      'lockdown',
      'shelter_in_place',
      'reunification',
      'other',
    ])
  })

  it('other-emergency drill types EXCLUDE fire and tornado', () => {
    expect(OTHER_EMERGENCY_DRILL_TYPES).toEqual([
      'lockdown',
      'shelter_in_place',
      'reunification',
      'other',
    ])
    expect(OTHER_EMERGENCY_DRILL_TYPES).not.toContain('fire')
    expect(OTHER_EMERGENCY_DRILL_TYPES).not.toContain('tornado')
  })

  it('fire drill interval is 3 months (R 400.1939 quarterly cadence)', () => {
    expect(FIRE_DRILL_INTERVAL_MONTHS).toBe(3)
  })

  it('tornado window is March-November (months 3-11 inclusive)', () => {
    expect(TORNADO_WINDOW_START_MONTH).toBe(3)
    expect(TORNADO_WINDOW_END_MONTH).toBe(11)
  })

  it('tornado required count is 2 per year', () => {
    expect(TORNADO_REQUIRED_COUNT).toBe(2)
  })
})

// ─── Fire drill summary ──────────────────────────────────────────────

describe('getFireDrillSummary', () => {
  it('returns hasAny=false / nextDueOn=today when no fire drills are logged', () => {
    const s = getFireDrillSummary({ drillLogs: [], today: '2026-06-17' })
    expect(s.hasAny).toBe(false)
    expect(s.lastPerformedOn).toBeNull()
    expect(s.nextDueOn).toBe('2026-06-17')
  })

  it('reads only fire-type logs (ignores tornado/lockdown/etc.)', () => {
    const drillLogs = [
      log({ drill_type: 'fire',    performed_on: '2026-05-01' }),
      log({ drill_type: 'tornado', performed_on: '2026-06-01' }),
      log({ drill_type: 'lockdown',performed_on: '2026-06-15' }),
    ]
    const s = getFireDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.lastPerformedOn).toBe('2026-05-01')   // fire log only
    expect(s.nextDueOn).toBe('2026-08-01')         // +3 months
  })

  it('picks the LATEST fire log when multiple exist (order-independent)', () => {
    const drillLogs = [
      log({ drill_type: 'fire', performed_on: '2026-01-15' }),
      log({ drill_type: 'fire', performed_on: '2026-05-01' }),
      log({ drill_type: 'fire', performed_on: '2026-03-10' }),
    ]
    const s = getFireDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.lastPerformedOn).toBe('2026-05-01')
  })

  it('ignores archived fire logs (correctness — soft-deleted records do not satisfy)', () => {
    const drillLogs = [
      log({ drill_type: 'fire', performed_on: '2026-05-01', archived_at: '2026-05-02T00:00:00Z' }),
      log({ drill_type: 'fire', performed_on: '2026-04-01' }),
    ]
    const s = getFireDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.lastPerformedOn).toBe('2026-04-01')
  })

  it('next due date = last performed + 3 months (clamping the day on short months)', () => {
    // Jan 31 + 3 months should clamp to Apr 30 (not roll into May).
    const drillLogs = [log({ drill_type: 'fire', performed_on: '2026-01-31' })]
    const s = getFireDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.nextDueOn).toBe('2026-04-30')
  })
})

// ─── Tornado drill summary ───────────────────────────────────────────

describe('getTornadoDrillSummary', () => {
  it('no logs ever → 0/2; window-status is open if today is in Mar-Nov', () => {
    const s = getTornadoDrillSummary({ drillLogs: [], today: '2026-06-17' })
    expect(s.drillsInCurrentWindow).toBe(0)
    expect(s.requiredInWindow).toBe(2)
    expect(s.satisfiedForCurrentYear).toBe(false)
    expect(s.windowOpenNow).toBe(true)
    // Window active + short = nextDueOn is today (the dispatcher would
    // surface "do another now").
    expect(s.nextDueOn).toBe('2026-06-17')
  })

  it('1 tornado drill done in current window → 1/2, not satisfied, next due today', () => {
    const drillLogs = [log({ drill_type: 'tornado', performed_on: '2026-04-15' })]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.drillsInCurrentWindow).toBe(1)
    expect(s.satisfiedForCurrentYear).toBe(false)
    expect(s.nextDueOn).toBe('2026-06-17')
  })

  it('2 tornado drills in current window → satisfied; next due null (year done)', () => {
    const drillLogs = [
      log({ drill_type: 'tornado', performed_on: '2026-04-15' }),
      log({ drill_type: 'tornado', performed_on: '2026-09-15' }),
    ]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-10-01' })
    expect(s.drillsInCurrentWindow).toBe(2)
    expect(s.satisfiedForCurrentYear).toBe(true)
    expect(s.nextDueOn).toBeNull()
  })

  it('drills from a PRIOR year do not count toward the current year', () => {
    const drillLogs = [
      log({ drill_type: 'tornado', performed_on: '2025-04-15' }),
      log({ drill_type: 'tornado', performed_on: '2025-09-15' }),
    ]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.drillsInCurrentWindow).toBe(0)
    expect(s.satisfiedForCurrentYear).toBe(false)
  })

  it('today before the window (Jan-Feb) → windowOpenNow=false; next due is March 1', () => {
    const s = getTornadoDrillSummary({ drillLogs: [], today: '2026-02-15' })
    expect(s.windowOpenNow).toBe(false)
    expect(s.nextDueOn).toBe('2026-03-01')
  })

  it('today after the window with year unmet (Dec) → next due null (year missed)', () => {
    const drillLogs = [
      log({ drill_type: 'tornado', performed_on: '2026-04-15' }),
    ]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-12-15' })
    expect(s.windowOpenNow).toBe(false)
    expect(s.drillsInCurrentWindow).toBe(1)
    expect(s.satisfiedForCurrentYear).toBe(false)
    expect(s.nextDueOn).toBeNull()
  })

  it('drills logged OUTSIDE the Mar-Nov months (Jan/Dec) of the current year do not count', () => {
    const drillLogs = [
      log({ drill_type: 'tornado', performed_on: '2026-01-15' }),  // before window
      log({ drill_type: 'tornado', performed_on: '2026-12-15' }),  // after window
    ]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.drillsInCurrentWindow).toBe(0)
  })

  it('archived tornado logs are ignored', () => {
    const drillLogs = [
      log({ drill_type: 'tornado', performed_on: '2026-04-15', archived_at: '2026-04-16T00:00:00Z' }),
      log({ drill_type: 'tornado', performed_on: '2026-09-15' }),
    ]
    const s = getTornadoDrillSummary({ drillLogs, today: '2026-10-01' })
    expect(s.drillsInCurrentWindow).toBe(1)
  })
})

// ─── Other-emergency annual drill summary ────────────────────────────

describe('getOtherEmergencyDrillSummary', () => {
  it('no logs ever → next due = today', () => {
    const s = getOtherEmergencyDrillSummary({ drillLogs: [], today: '2026-06-17' })
    expect(s.hasAny).toBe(false)
    expect(s.nextDueOn).toBe('2026-06-17')
  })

  it('accepts any of lockdown / shelter_in_place / reunification / other', () => {
    for (const subtype of OTHER_EMERGENCY_DRILL_TYPES) {
      const drillLogs = [log({ drill_type: subtype, performed_on: '2026-03-01' })]
      const s = getOtherEmergencyDrillSummary({ drillLogs, today: '2026-06-17' })
      expect(s.hasAny, `subtype ${subtype} should satisfy`).toBe(true)
      expect(s.lastPerformedOn).toBe('2026-03-01')
      expect(s.nextDueOn).toBe('2027-03-01')           // +1 year
    }
  })

  it('does NOT accept fire or tornado as satisfying the annual rule', () => {
    const drillLogs = [
      log({ drill_type: 'fire',    performed_on: '2026-03-01' }),
      log({ drill_type: 'tornado', performed_on: '2026-04-01' }),
    ]
    const s = getOtherEmergencyDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.hasAny).toBe(false)
    expect(s.lastPerformedOn).toBeNull()
  })

  it('picks the latest among multiple other-emergency subtypes', () => {
    const drillLogs = [
      log({ drill_type: 'lockdown',         performed_on: '2026-02-01' }),
      log({ drill_type: 'shelter_in_place', performed_on: '2026-05-15' }),
      log({ drill_type: 'reunification',    performed_on: '2026-03-20' }),
    ]
    const s = getOtherEmergencyDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.lastPerformedOn).toBe('2026-05-15')
  })

  it('archived other-emergency rows are ignored', () => {
    const drillLogs = [
      log({ drill_type: 'lockdown', performed_on: '2026-05-15', archived_at: '2026-05-16T00:00:00Z' }),
      log({ drill_type: 'lockdown', performed_on: '2026-03-01' }),
    ]
    const s = getOtherEmergencyDrillSummary({ drillLogs, today: '2026-06-17' })
    expect(s.lastPerformedOn).toBe('2026-03-01')
  })
})

// ─── THE CONSISTENCY TESTS — load-bearing regression net ─────────────
//
// The compliance row resolvers and the (planned) reminder scheduler
// both compute drill due-dates via `nextOccurrence(rule, today)`. The
// rule shapes are produced by buildFireDrillRule /
// buildTornadoDrillRule / buildOtherEmergencyDrillRule above.
//
// These tests verify that calling `nextOccurrence` with the SHARED
// rule builder produces the same date as calling it with a parallel
// "reminder-side" rule literal expressed inline. If someone later
// duplicates the math on the reminder side and tweaks the
// intervalMonths (e.g. from 3 to 4 by typo), the inline literal here
// stays at 3 and the test fails — catching the drift before it ships.

describe('CONSISTENCY — compliance and reminder paths produce IDENTICAL dates', () => {
  const TODAY = '2026-06-17'

  describe('Fire drill — every 3 months', () => {
    const SAMPLES = [
      { label: 'never performed',                  lastPerformedOn: null },
      { label: 'just performed today',             lastPerformedOn: '2026-06-17' },
      { label: 'performed 2 months ago',           lastPerformedOn: '2026-04-17' },
      { label: 'performed exactly 3 months ago',   lastPerformedOn: '2026-03-17' },
      { label: 'performed 5 months ago (overdue)', lastPerformedOn: '2026-01-17' },
      { label: 'performed on Jan 31 (day-clamp)',  lastPerformedOn: '2026-01-31' },
      { label: 'performed on Feb 29 of a prior leap year', lastPerformedOn: '2024-02-29' },
    ]
    for (const { label, lastPerformedOn } of SAMPLES) {
      it(`compliance + reminder agree on next-due — ${label}`, () => {
        // Compliance path — via the shared builder used by the
        // complianceState resolver.
        const compliance = nextOccurrence(buildFireDrillRule(lastPerformedOn), TODAY)
        // Reminder path — the rule shape a future reminder scheduler
        // would assemble. INLINE LITERAL so a regression caused by
        // copy-pasted-then-edited shape on the reminder side is loud
        // here.
        const reminder = nextOccurrence(
          { kind: 'every_n_months', intervalMonths: 3, lastPerformedOn },
          TODAY
        )
        expect(compliance).toBe(reminder)
      })
    }
  })

  describe('Tornado drill — seasonal_window Mar-Nov, 2 per year', () => {
    const SAMPLES = [
      { label: 'no history',                     historyInWindow: [] },
      { label: '1 in window this year',          historyInWindow: ['2026-04-15'] },
      { label: '2 in window this year (done)',   historyInWindow: ['2026-04-15', '2026-09-15'] },
      { label: 'prior year only',                historyInWindow: ['2025-04-15', '2025-09-15'] },
    ]
    for (const { label, historyInWindow } of SAMPLES) {
      it(`compliance + reminder agree on next-due — ${label}`, () => {
        const compliance = nextOccurrence(buildTornadoDrillRule(historyInWindow), TODAY)
        const reminder = nextOccurrence(
          {
            kind: 'seasonal_window',
            windowStartMonth: 3,
            windowEndMonth: 11,
            requiredCount: 2,
            historyInWindow,
          },
          TODAY
        )
        expect(compliance).toBe(reminder)
      })
    }
  })

  describe('Other-emergency drill — annual', () => {
    const SAMPLES = [
      { label: 'never performed',           lastPerformedOn: null },
      { label: 'performed 1 month ago',     lastPerformedOn: '2026-05-17' },
      { label: 'performed exactly 1y ago',  lastPerformedOn: '2025-06-17' },
      { label: 'performed 18 months ago',   lastPerformedOn: '2024-12-17' },
    ]
    for (const { label, lastPerformedOn } of SAMPLES) {
      it(`compliance + reminder agree on next-due — ${label}`, () => {
        const compliance = nextOccurrence(buildOtherEmergencyDrillRule(lastPerformedOn), TODAY)
        const reminder = nextOccurrence(
          { kind: 'annual', lastPerformedOn },
          TODAY
        )
        expect(compliance).toBe(reminder)
      })
    }
  })

  // Belt-and-suspenders: addMonthsYMD inside reminderSchedule and the
  // direct API match. If a future refactor splits the module, this
  // boundary test catches the seam.
  describe('boundary: fire+3 calc agrees between nextOccurrence and addMonthsYMD', () => {
    const SAMPLES = [
      '2026-01-15',
      '2026-01-31',  // day-clamp into Feb
      '2024-02-29',  // leap-year edge
      '2025-12-15',
    ]
    for (const last of SAMPLES) {
      it(`addMonthsYMD(${last}, 3) === nextOccurrence(fire-rule, today >> last)`, () => {
        const viaAddMonths = addMonthsYMD(last, 3)
        // Make today < lastPerformedOn so nextOccurrence returns the
        // computed +3 rather than `today` (its never-performed branch).
        const viaNextOccurrence = nextOccurrence(buildFireDrillRule(last), last)
        expect(viaNextOccurrence).toBe(viaAddMonths)
      })
    }
  })
})
