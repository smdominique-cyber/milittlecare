// Date-formatting helpers for the CDC Pay Periods UI. Kept separate
// from src/lib/cdcPayPeriods.js (which holds the pure date *logic*
// the Vitest suite covers) so the logic module stays focused on the
// four spec § 2.4 functions. Shared by CdcPayPeriodsPage,
// PayPeriodTable, and PayPeriodCard.
//
// Every catalog column is a plain YYYY-MM-DD `date` string. These
// helpers parse the string components directly — no Date timezone
// math on the values themselves — so a displayed date never shifts.

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  return { y, m, d }
}

/** "May 21" — month abbreviation + day, no year. */
export function formatShort(ymd) {
  if (!ymd) return ''
  const { y, m, d } = parts(ymd)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS_SHORT[m - 1]} ${d}`
}

/** "May 21, 2026" — month abbreviation + day + year. */
export function formatLong(ymd) {
  if (!ymd) return ''
  const { y, m, d } = parts(ymd)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`
}

/**
 * "May 21" normally, but "Jan 1, 2026" when the date's calendar year
 * differs from the period's schedule_year — so a deadline or payment
 * that spills into the next year is unambiguous (spec § 7.3).
 */
export function formatShortMaybeYear(ymd, scheduleYear) {
  if (!ymd) return ''
  const { y } = parts(ymd)
  return y === scheduleYear ? formatShort(ymd) : formatLong(ymd)
}

/** "Thu May 21, 2026" — weekday + month + day + year (hero cards). */
export function formatWeekdayLong(ymd) {
  if (!ymd) return ''
  const { y, m, d } = parts(ymd)
  if (!y || !m || !d) return String(ymd)
  const weekday = WEEKDAYS_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday} ${MONTHS_SHORT[m - 1]} ${d}, ${y}`
}

/**
 * Care-window range for the hero cards: "May 3 – May 16, 2026". When
 * the window straddles a year boundary both years are shown:
 * "Dec 28, 2025 – Jan 10, 2026".
 */
export function formatRangeLong(start, end) {
  if (!start || !end) return ''
  const sameYear = parts(start).y === parts(end).y
  return sameYear
    ? `${formatShort(start)} – ${formatLong(end)}`
    : `${formatLong(start)} – ${formatLong(end)}`
}

/** Compact care-window range for the schedule table: "May 3 – May 16". */
export function formatRangeShort(start, end) {
  if (!start || !end) return ''
  return `${formatShort(start)} – ${formatShort(end)}`
}
