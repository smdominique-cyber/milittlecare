// 2026-06-17 — PR #19 drill-schedule helper.
//
// Drill compliance rows resolve from drill_logs row history. This
// module is a THIN DOMAIN WRAPPER around the pure recurrence helper
// already shipping at src/lib/reminderSchedule.js — specifically
// `nextOccurrence`, which the existing reminder catalog feeds with
// the same rule shapes this module assembles.
//
// THE CONSISTENCY GUARANTEE (load-bearing per the PR brief):
//
//   The reminder system already computes drill due-dates via
//   `nextOccurrence(rule, today)` shaped as 'every_n_months' for
//   fire (intervalMonths: 3), 'seasonal_window' for tornado
//   (Mar-Nov, requiredCount: 2), and 'annual' for the
//   lockdown/shelter/reunification catch-all. The compliance rows
//   in src/lib/complianceState.js must produce IDENTICAL due-dates
//   for the same drill history. Rather than duplicate the recurrence
//   math, both sides call the same `nextOccurrence` via the same
//   rule shapes. The consistency tests in drillSchedule.test.js
//   assert that "same drill history → same date" by sharing the
//   rule literals between the compliance call and a parallel
//   reminder-style call.
//
// This module is INTENTIONALLY PURE:
//   - No DB access; callers supply drill_logs rows already loaded.
//   - No `Date.now()` reads; every public helper takes `today` as a
//     YMD string parameter (defaults to `todayYMD()` for the
//     production call site).
//   - `nextOccurrence` is the only logic boundary; this module just
//     builds rule shapes and reads back the result.
//
// DRILL TYPE MAPPING (registry row ↔ drill_logs.drill_type):
//
//   drill_fire_quarterly           ← drill_type = 'fire'
//   drill_tornado_seasonal         ← drill_type = 'tornado'
//   drill_other_emergencies_annual ← drill_type IN ('lockdown',
//                                                   'shelter_in_place',
//                                                   'reunification',
//                                                   'other')

import { todayYMD, yearOfYMD } from './dates'
import { nextOccurrence } from './reminderSchedule'

// Drill types stored in drill_logs.drill_type (mirrors the SQL
// CHECK whitelist in migration 044). The catch-all "other" subtype
// satisfies drill_other_emergencies_annual when its `notes` describe
// what kind of drill it was (the SQL CHECK allows 'other' as a
// member of the whitelist; the registry row treats all four annual
// subtypes equivalently).
export const DRILL_TYPES = Object.freeze([
  'fire',
  'tornado',
  'lockdown',
  'shelter_in_place',
  'reunification',
  'other',
])

// drill_other_emergencies_annual is satisfied by any log of these
// subtypes (the rule says "lockdown / shelter-in-place /
// reunification, etc." — the 'other' catch-all is part of the
// annual bucket too per the reminder catalog).
export const OTHER_EMERGENCY_DRILL_TYPES = Object.freeze([
  'lockdown',
  'shelter_in_place',
  'reunification',
  'other',
])

// Rule constants — referenced by both this module's helpers and the
// consistency tests, so a typo in one place is loud at test time.
export const FIRE_DRILL_INTERVAL_MONTHS = 3
export const TORNADO_WINDOW_START_MONTH = 3   // March
export const TORNADO_WINDOW_END_MONTH   = 11  // November (inclusive)
export const TORNADO_REQUIRED_COUNT     = 2

// ─── Internal helpers ────────────────────────────────────────────────

function isActive(row) {
  return row && !row.archived_at
}

function performedOnOf(row) {
  return row && row.performed_on
}

/**
 * Sort an array of active drill_logs rows in descending order of
 * `performed_on`. Returns a new array; does not mutate the input.
 */
function sortByPerformedDesc(rows) {
  return rows
    .filter(isActive)
    .filter(performedOnOf)
    .slice()
    .sort((a, b) => (a.performed_on < b.performed_on ? 1 : a.performed_on > b.performed_on ? -1 : 0))
}

// ─── Rule shape builders ─────────────────────────────────────────────
//
// Exported so the consistency tests can call the EXACT same shape
// the compliance resolver and the (future) reminder scheduler call.
// A rule literal that differs between the two sides would let the
// dates drift; this is the regression net.

export function buildFireDrillRule(lastPerformedOn) {
  return {
    kind: 'every_n_months',
    intervalMonths: FIRE_DRILL_INTERVAL_MONTHS,
    lastPerformedOn: lastPerformedOn || null,
  }
}

export function buildTornadoDrillRule(historyInWindow) {
  return {
    kind: 'seasonal_window',
    windowStartMonth: TORNADO_WINDOW_START_MONTH,
    windowEndMonth:   TORNADO_WINDOW_END_MONTH,
    requiredCount:    TORNADO_REQUIRED_COUNT,
    historyInWindow:  Array.isArray(historyInWindow) ? historyInWindow : [],
  }
}

export function buildOtherEmergencyDrillRule(lastPerformedOn) {
  return {
    kind: 'annual',
    lastPerformedOn: lastPerformedOn || null,
  }
}

// ─── Public summaries (consumed by complianceState resolvers) ────────

/**
 * Summary of fire-drill compliance state for one provider.
 *
 * @param {object}   args
 * @param {object[]} args.drillLogs  All of the provider's drill_logs rows.
 * @param {string}   [args.today]    YMD; defaults to todayYMD().
 * @returns {{
 *   lastPerformedOn: string | null,
 *   nextDueOn:       string | null,
 *   hasAny:          boolean,
 * }}
 */
export function getFireDrillSummary({ drillLogs, today } = {}) {
  const t = today || todayYMD()
  const fireLogs = sortByPerformedDesc(
    (drillLogs || []).filter(r => r && r.drill_type === 'fire')
  )
  const lastPerformedOn = fireLogs.length > 0 ? fireLogs[0].performed_on : null
  const rule = buildFireDrillRule(lastPerformedOn)
  const nextDueOn = nextOccurrence(rule, t)
  return {
    lastPerformedOn,
    nextDueOn,
    hasAny: fireLogs.length > 0,
  }
}

/**
 * Summary of tornado-drill compliance state for one provider.
 *
 * The seasonal_window rule is per-calendar-year: 2 drills inside
 * Mar-Nov satisfy the year. The summary additionally exposes the
 * count of drills logged inside the CURRENT year's window so the
 * UI can render "1 of 2 done" progress.
 *
 * @param {object}   args
 * @param {object[]} args.drillLogs
 * @param {string}   [args.today]
 * @returns {{
 *   nextDueOn:               string | null,
 *   drillsInCurrentWindow:   number,
 *   requiredInWindow:        number,
 *   satisfiedForCurrentYear: boolean,
 *   windowOpenNow:           boolean,
 * }}
 */
export function getTornadoDrillSummary({ drillLogs, today } = {}) {
  const t = today || todayYMD()
  const tornadoLogs = (drillLogs || [])
    .filter(isActive)
    .filter(r => r && r.drill_type === 'tornado')
    .map(performedOnOf)
    .filter(Boolean)

  const currentYear = yearOfYMD(t)
  const inWindowThisYear = tornadoLogs.filter(d => {
    if (yearOfYMD(d) !== currentYear) return false
    const m = Number(d.slice(5, 7))
    return m >= TORNADO_WINDOW_START_MONTH && m <= TORNADO_WINDOW_END_MONTH
  })

  const rule = buildTornadoDrillRule(tornadoLogs)
  const nextDueOn = nextOccurrence(rule, t)

  const todayMonth = Number(t.slice(5, 7))
  const windowOpenNow =
    todayMonth >= TORNADO_WINDOW_START_MONTH &&
    todayMonth <= TORNADO_WINDOW_END_MONTH

  return {
    nextDueOn,
    drillsInCurrentWindow: inWindowThisYear.length,
    requiredInWindow:      TORNADO_REQUIRED_COUNT,
    satisfiedForCurrentYear: inWindowThisYear.length >= TORNADO_REQUIRED_COUNT,
    windowOpenNow,
  }
}

/**
 * Summary of the catch-all annual drill (lockdown / shelter /
 * reunification / other). One log of any of those subtypes within
 * the trailing year satisfies the rule.
 *
 * @param {object}   args
 * @param {object[]} args.drillLogs
 * @param {string}   [args.today]
 * @returns {{
 *   lastPerformedOn: string | null,
 *   nextDueOn:       string | null,
 *   hasAny:          boolean,
 * }}
 */
export function getOtherEmergencyDrillSummary({ drillLogs, today } = {}) {
  const t = today || todayYMD()
  const otherLogs = sortByPerformedDesc(
    (drillLogs || []).filter(r => r && OTHER_EMERGENCY_DRILL_TYPES.includes(r.drill_type))
  )
  const lastPerformedOn = otherLogs.length > 0 ? otherLogs[0].performed_on : null
  const rule = buildOtherEmergencyDrillRule(lastPerformedOn)
  const nextDueOn = nextOccurrence(rule, t)
  return {
    lastPerformedOn,
    nextDueOn,
    hasAny: otherLogs.length > 0,
  }
}
