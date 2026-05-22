// Pure helpers for the parent-acknowledgment email digest cron
// (PR #12 step 3). All the timing logic and email-template assembly
// lives here; the cron handler in `api/cron-send-acknowledgment-digest.js`
// is a thin orchestrator that imports these.
//
// Two reasons this is split out:
//   - shouldSendDigestNow + getLocalDateTimePartsInTZ are tricky enough
//     (TZ + DST + day-of-week + the en-US "hour=24 at midnight" quirk)
//     that they're worth unit-testing independently of any cron infra.
//   - Email templates (subject, plain text, HTML) get reviewed for
//     copy independently of network code.
//
// No Supabase, no Resend, no React. The cron handler does I/O; this
// file does math + strings.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const DEFAULT_SEND_HOUR = 17       // 5 PM
export const DEFAULT_SEND_DAY = 5         // Friday (0=Sun)
export const DEFAULT_TIMEZONE = 'America/Detroit'

// Sun=0 .. Sat=6 — matches JS Date#getDay() / Postgres EXTRACT(dow).
const WEEKDAY_TO_NUM = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
})

// -----------------------------------------------------------------------------
// Timezone-aware "what's the local time right now?"
// -----------------------------------------------------------------------------

/**
 * Returns the local day-of-week (0–6) and hour (0–23) at `nowUtc` in
 * the supplied IANA timezone. Used by the cron to decide whether a
 * given provider's preferred send-window is happening right now.
 *
 * Uses `Intl.DateTimeFormat#formatToParts` — supports the full IANA
 * database including DST transitions. The en-US `hour12: false`
 * formatter has a well-known quirk where midnight surfaces as `24`
 * instead of `00` on some Node versions; we normalise to 0.
 *
 * @param {Date}   nowUtc    The current moment as a JS Date.
 * @param {string} timezone  IANA TZ identifier (e.g. 'America/Detroit').
 * @returns {{ dayOfWeek: number, hour: number, minute: number }}
 */
export function getLocalDateTimePartsInTZ(nowUtc, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(nowUtc)
  const get = type => parts.find(p => p.type === type)?.value

  const weekdayShort = get('weekday')                  // 'Sun' .. 'Sat'
  const dayOfWeek = WEEKDAY_TO_NUM[weekdayShort] ?? 0
  let hour = Number(get('hour') ?? '0')
  if (hour === 24) hour = 0                            // en-US midnight quirk
  const minute = Number(get('minute') ?? '0')

  return { dayOfWeek, hour, minute }
}

/**
 * Should this provider receive a digest send right now?
 *
 * Decision logic:
 *   - email disabled at provider level             → no
 *   - current local hour ≠ preferred send hour     → no
 *   - cadence = 'daily'                            → yes
 *   - cadence = 'weekly' AND current local DOW
 *     matches preferred send day                   → yes
 *   - otherwise                                    → no
 *
 * The hour-precision behaviour depends on the cron's actual schedule.
 * If the Vercel cron runs daily at a fixed UTC moment, the only
 * providers whose preferred `send_hour` matches the cron's
 * local-time-in-their-TZ will fire. Providers in other TZs see their
 * preferred hour effectively floated. Documented in pr-12-review.md.
 *
 * @param {object} args
 * @param {object} args.provider  A `profiles` row with acknowledgment_* columns.
 * @param {Date}   args.nowUtc    The cron's invocation moment.
 * @returns {boolean}
 */
export function shouldSendDigestNow({ provider, nowUtc } = {}) {
  if (!provider) return false
  if (provider.acknowledgment_email_enabled === false) return false

  const tz = provider.acknowledgment_email_timezone || DEFAULT_TIMEZONE
  const hourPref = provider.acknowledgment_email_send_hour ?? DEFAULT_SEND_HOUR
  const dayPref = provider.acknowledgment_email_send_day ?? DEFAULT_SEND_DAY
  const cadence = provider.acknowledgment_cadence || 'weekly'

  const { dayOfWeek, hour } = getLocalDateTimePartsInTZ(nowUtc, tz)
  if (hour !== hourPref) return false
  if (cadence === 'daily') return true
  return dayOfWeek === dayPref
}

// -----------------------------------------------------------------------------
// Digest window — what date range does this send cover?
// -----------------------------------------------------------------------------

/**
 * Inclusive date range the digest summarises, in the provider's local
 * TZ. For weekly cadence: the seven days ending today. For daily: just
 * yesterday (today's attendance is usually still being entered).
 *
 * Returns ISO date strings 'YYYY-MM-DD' so the cron, the email
 * template, and the unacked-segment lookup all agree on the window.
 */
export function digestDateRange({ cadence, nowUtc, timezone } = {}) {
  const tz = timezone || DEFAULT_TIMEZONE
  // We need today's YYYY-MM-DD in the provider's local TZ — formatToParts
  // again but stripped to date components.
  const fmt = new Intl.DateTimeFormat('en-CA', {  // en-CA renders YYYY-MM-DD natively
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const todayLocal = fmt.format(nowUtc)            // '2026-05-20' shape

  if (cadence === 'daily') {
    return { start: addDaysYMD(todayLocal, -1), end: addDaysYMD(todayLocal, -1) }
  }
  // Weekly: 7 days ending today (inclusive).
  return { start: addDaysYMD(todayLocal, -6), end: todayLocal }
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Email template
// -----------------------------------------------------------------------------

/**
 * Compose the per-parent digest email — subject, plain text body, HTML
 * body. The email is intentionally short and points to the portal; per
 * the locked decisions in PR #12 § 3, there's no in-email
 * acknowledgment surface and no token in the URL.
 *
 * @param {object} args
 * @param {string} args.providerName      e.g. "Venessa's Daycare".
 * @param {string} args.parentFirstName   For the greeting.
 * @param {string[]} args.childFirstNames Children covered by this digest.
 * @param {string} args.weekStart         'YYYY-MM-DD'.
 * @param {string} args.weekEnd           'YYYY-MM-DD'.
 * @param {string} args.portalUrl         Absolute URL to /parent/acknowledge.
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildDigestEmail({
  providerName,
  parentFirstName,
  childFirstNames,
  weekStart,
  weekEnd,
  portalUrl,
}) {
  const kidsList = formatList(childFirstNames || [])
  const dateRange =
    weekStart === weekEnd
      ? formatLongDate(weekStart)
      : `${formatLongDate(weekStart)} through ${formatLongDate(weekEnd)}`
  const greeting = parentFirstName ? `Hi ${parentFirstName},` : 'Hello,'

  const subject = `Time to review hours for ${kidsList || 'your child'}`

  const text =
    `${greeting}\n\n` +
    `${providerName || 'Your child care provider'} has logged care hours for ${kidsList || 'your child'} from ${dateRange}. ` +
    `Take a minute to review and confirm — it helps keep everyone on the same page and is required for CDC billing.\n\n` +
    `Open MI Little Care: ${portalUrl}\n\n` +
    `Questions about the hours? When you log in, you can flag any day you'd like ${providerName || 'your provider'} to review.\n\n` +
    `— MI Little Care`

  const html = renderHtmlBody({
    greeting, providerName: providerName || 'Your child care provider',
    kidsList: kidsList || 'your child', dateRange, portalUrl,
  })

  return { subject, text, html }
}

function renderHtmlBody({ greeting, providerName, kidsList, dateRange, portalUrl }) {
  // Plain, accessible HTML — no external CSS, inline styles only.
  // Tested in Gmail / Apple Mail / Outlook web; minimal layout that
  // renders consistently across clients.
  return `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#2c2a26;max-width:560px;margin:0 auto;padding:24px;">
  <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">${escapeHtml(greeting)}</p>
  <p style="font-size:16px;line-height:1.5;margin:0 0 16px;">
    <strong>${escapeHtml(providerName)}</strong> has logged care hours for
    <strong>${escapeHtml(kidsList)}</strong> from ${escapeHtml(dateRange)}.
    Take a minute to review and confirm — it helps keep everyone on the
    same page and is required for CDC billing.
  </p>
  <p style="margin:24px 0;">
    <a href="${escapeAttr(portalUrl)}"
       style="display:inline-block;padding:12px 24px;background:#7a9e8a;color:white;text-decoration:none;border-radius:8px;font-weight:600;">
      Open MI Little Care
    </a>
  </p>
  <p style="font-size:14px;line-height:1.5;color:#5c5a56;margin:0 0 8px;">
    Questions about the hours? When you log in, you can flag any day
    you'd like ${escapeHtml(providerName)} to review.
  </p>
  <p style="font-size:12px;color:#8a8780;margin-top:32px;">— MI Little Care</p>
</body></html>`
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 'YYYY-MM-DD' → 'May 18, 2026'. */
export function formatLongDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

/** ['Mia'] → 'Mia'; ['Mia','Leo'] → 'Mia and Leo'; ['Mia','Leo','Sam'] → 'Mia, Leo, and Sam'. */
export function formatList(arr) {
  const list = (arr || []).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}

/** Minimal HTML-escape for text interpolated into the template. */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ))
}

/** Same set as escapeHtml plus single-quote, for attribute contexts. */
function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
