import { describe, it, expect } from 'vitest'
import {
  getLocalDateTimePartsInTZ,
  shouldSendDigestNow,
  digestDateRange,
  buildDigestEmail,
  formatList,
  formatLongDate,
  DEFAULT_SEND_HOUR,
  DEFAULT_SEND_DAY,
  DEFAULT_TIMEZONE,
} from './acknowledgmentDigest'

// Fixed Date instances — UTC moments we use to assert TZ math.
// 2026-05-22 (Fri) 21:00 UTC = 17:00 EDT (UTC-4) in America/Detroit
const FRI_5PM_EDT = new Date(Date.UTC(2026, 4, 22, 21, 0, 0))

// 2026-01-09 (Fri) 22:00 UTC = 17:00 EST (UTC-5) in America/Detroit
const FRI_5PM_EST = new Date(Date.UTC(2026, 0, 9, 22, 0, 0))

// 2026-05-22 16:30 UTC = 12:30 EDT — wrong hour
const FRI_NOON_EDT = new Date(Date.UTC(2026, 4, 22, 16, 30, 0))

// 2026-05-23 (Sat) 21:00 UTC = 17:00 EDT — wrong day for weekly-Friday
const SAT_5PM_EDT = new Date(Date.UTC(2026, 4, 23, 21, 0, 0))

// -----------------------------------------------------------------------------

describe('constants', () => {
  it('default send hour is 5 PM', () => {
    expect(DEFAULT_SEND_HOUR).toBe(17)
  })
  it('default send day is Friday (5)', () => {
    expect(DEFAULT_SEND_DAY).toBe(5)
  })
  it('default timezone is America/Detroit', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Detroit')
  })
})

describe('getLocalDateTimePartsInTZ', () => {
  it('handles EDT (UTC-4) correctly in May', () => {
    const parts = getLocalDateTimePartsInTZ(FRI_5PM_EDT, 'America/Detroit')
    expect(parts.hour).toBe(17)
    expect(parts.dayOfWeek).toBe(5)  // Friday
  })

  it('handles EST (UTC-5) correctly in January', () => {
    const parts = getLocalDateTimePartsInTZ(FRI_5PM_EST, 'America/Detroit')
    expect(parts.hour).toBe(17)
    expect(parts.dayOfWeek).toBe(5)  // Friday
  })

  it('returns 0 for midnight even if Intl reports 24 (en-US quirk normalisation)', () => {
    // 2026-05-23 04:00 UTC = 00:00 EDT (midnight)
    const midnightEdt = new Date(Date.UTC(2026, 4, 23, 4, 0, 0))
    const parts = getLocalDateTimePartsInTZ(midnightEdt, 'America/Detroit')
    expect(parts.hour).toBe(0)
  })

  it('handles non-default timezones (UTC)', () => {
    const parts = getLocalDateTimePartsInTZ(FRI_5PM_EDT, 'UTC')
    expect(parts.hour).toBe(21)
    expect(parts.dayOfWeek).toBe(5)
  })

  it('handles Pacific time', () => {
    // FRI_5PM_EDT = 21:00 UTC = 14:00 PDT
    const parts = getLocalDateTimePartsInTZ(FRI_5PM_EDT, 'America/Los_Angeles')
    expect(parts.hour).toBe(14)
    expect(parts.dayOfWeek).toBe(5)
  })

  it('crosses a day boundary in negative TZs correctly', () => {
    // 2026-05-23 02:00 UTC = 2026-05-22 22:00 EDT — still Friday locally
    const lateFridayEdt = new Date(Date.UTC(2026, 4, 23, 2, 0, 0))
    const parts = getLocalDateTimePartsInTZ(lateFridayEdt, 'America/Detroit')
    expect(parts.dayOfWeek).toBe(5)
    expect(parts.hour).toBe(22)
  })
})

describe('shouldSendDigestNow', () => {
  const provider = (overrides = {}) => ({
    id: 'prov-1',
    acknowledgment_email_enabled: true,
    acknowledgment_cadence: 'weekly',
    acknowledgment_email_send_day: 5,    // Friday
    acknowledgment_email_send_hour: 17,  // 5 PM
    acknowledgment_email_timezone: 'America/Detroit',
    ...overrides,
  })

  it('fires for a weekly-Friday-5PM provider at exactly Fri 5PM local (EDT)', () => {
    expect(shouldSendDigestNow({ provider: provider(), nowUtc: FRI_5PM_EDT })).toBe(true)
  })

  it('fires across DST boundaries — same provider works in EST too', () => {
    expect(shouldSendDigestNow({ provider: provider(), nowUtc: FRI_5PM_EST })).toBe(true)
  })

  it('does NOT fire when the hour is wrong', () => {
    expect(shouldSendDigestNow({ provider: provider(), nowUtc: FRI_NOON_EDT })).toBe(false)
  })

  it('does NOT fire on the wrong day for weekly cadence', () => {
    expect(shouldSendDigestNow({ provider: provider(), nowUtc: SAT_5PM_EDT })).toBe(false)
  })

  it('fires on Saturday for daily cadence as long as the hour matches', () => {
    const p = provider({ acknowledgment_cadence: 'daily' })
    expect(shouldSendDigestNow({ provider: p, nowUtc: SAT_5PM_EDT })).toBe(true)
  })

  it('respects a non-default timezone', () => {
    // Provider in LA wants 17:00 local on Fridays. FRI_5PM_EDT = 14:00 PDT — wrong hour.
    const laProvider = provider({ acknowledgment_email_timezone: 'America/Los_Angeles' })
    expect(shouldSendDigestNow({ provider: laProvider, nowUtc: FRI_5PM_EDT })).toBe(false)
    // 2026-05-23 00:00 UTC = 17:00 PDT Fri
    const friday5pmPDT = new Date(Date.UTC(2026, 4, 23, 0, 0, 0))
    expect(shouldSendDigestNow({ provider: laProvider, nowUtc: friday5pmPDT })).toBe(true)
  })

  it('returns false when email is explicitly disabled', () => {
    expect(shouldSendDigestNow({
      provider: provider({ acknowledgment_email_enabled: false }),
      nowUtc: FRI_5PM_EDT,
    })).toBe(false)
  })

  it('returns false when provider is null/undefined', () => {
    expect(shouldSendDigestNow({ provider: null, nowUtc: FRI_5PM_EDT })).toBe(false)
    expect(shouldSendDigestNow({})).toBe(false)
  })

  it('falls back to defaults when settings are missing', () => {
    // Missing cadence/day/hour/tz → defaults (weekly, Friday, 17, Detroit)
    const bareMin = { acknowledgment_email_enabled: true }
    expect(shouldSendDigestNow({ provider: bareMin, nowUtc: FRI_5PM_EDT })).toBe(true)
  })
})

describe('digestDateRange', () => {
  it('returns a 7-day inclusive window for weekly cadence', () => {
    const r = digestDateRange({ cadence: 'weekly', nowUtc: FRI_5PM_EDT, timezone: 'America/Detroit' })
    expect(r.end).toBe('2026-05-22')    // Friday
    expect(r.start).toBe('2026-05-16')  // 6 days back
  })

  it('returns yesterday for daily cadence (not today — entry usually still in progress)', () => {
    const r = digestDateRange({ cadence: 'daily', nowUtc: FRI_5PM_EDT, timezone: 'America/Detroit' })
    expect(r.start).toBe('2026-05-21')
    expect(r.end).toBe('2026-05-21')
  })

  it('uses the provider local-date, not UTC, for the window endpoints', () => {
    // 23:00 EDT on a Friday = 03:00 UTC Saturday. The window must end
    // on Friday (local), not Saturday (UTC).
    const lateFridayEdt = new Date(Date.UTC(2026, 4, 23, 3, 0, 0))
    const r = digestDateRange({ cadence: 'weekly', nowUtc: lateFridayEdt, timezone: 'America/Detroit' })
    expect(r.end).toBe('2026-05-22')  // Friday, not Saturday
  })
})

describe('buildDigestEmail', () => {
  const baseArgs = {
    providerName: "Venessa's Daycare",
    parentFirstName: 'Casey',
    childFirstNames: ['Mia', 'Leo'],
    weekStart: '2026-05-16',
    weekEnd: '2026-05-22',
    portalUrl: 'https://milittlecare.com/parent/acknowledge',
  }

  it('uses the parent first name in the greeting when present', () => {
    const { text, html } = buildDigestEmail(baseArgs)
    expect(text).toMatch(/^Hi Casey,/)
    expect(html).toContain('Hi Casey,')
  })

  it('falls back to "Hello," when no parent name is supplied', () => {
    const { text } = buildDigestEmail({ ...baseArgs, parentFirstName: '' })
    expect(text).toMatch(/^Hello,/)
  })

  it('lists multiple children with "and"', () => {
    const { text } = buildDigestEmail(baseArgs)
    expect(text).toContain('Mia and Leo')
  })

  it('uses Oxford-comma for three or more children', () => {
    const { text } = buildDigestEmail({ ...baseArgs, childFirstNames: ['Mia', 'Leo', 'Sam'] })
    expect(text).toContain('Mia, Leo, and Sam')
  })

  it('formats the date range as long-form dates', () => {
    const { text } = buildDigestEmail(baseArgs)
    expect(text).toContain('May 16, 2026 through May 22, 2026')
  })

  it('collapses to a single date when start === end (daily cadence)', () => {
    const { text } = buildDigestEmail({ ...baseArgs, weekStart: '2026-05-21', weekEnd: '2026-05-21' })
    expect(text).toContain('May 21, 2026')
    expect(text).not.toContain('through')
  })

  it('puts the portal URL in the text body for non-HTML clients', () => {
    const { text } = buildDigestEmail(baseArgs)
    expect(text).toContain('https://milittlecare.com/parent/acknowledge')
  })

  it('escapes provider names containing HTML-significant chars in the HTML body', () => {
    const { html } = buildDigestEmail({ ...baseArgs, providerName: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('subject line names the children', () => {
    const { subject } = buildDigestEmail(baseArgs)
    expect(subject).toContain('Mia and Leo')
  })
})

describe('formatList', () => {
  it('handles 0 items', () => { expect(formatList([])).toBe('') })
  it('handles null / undefined defensively', () => { expect(formatList(null)).toBe('') })
  it('handles 1 item', () => { expect(formatList(['Mia'])).toBe('Mia') })
  it('handles 2 items with "and"', () => { expect(formatList(['Mia', 'Leo'])).toBe('Mia and Leo') })
  it('uses Oxford comma for 3+', () => { expect(formatList(['Mia', 'Leo', 'Sam'])).toBe('Mia, Leo, and Sam') })
  it('drops empty strings', () => { expect(formatList(['Mia', '', 'Sam'])).toBe('Mia and Sam') })
})

describe('formatLongDate', () => {
  it('renders YYYY-MM-DD as "Month D, YYYY"', () => {
    expect(formatLongDate('2026-05-22')).toBe('May 22, 2026')
  })
  it('returns empty string for falsy input', () => {
    expect(formatLongDate(null)).toBe('')
    expect(formatLongDate(undefined)).toBe('')
    expect(formatLongDate('')).toBe('')
  })
})
