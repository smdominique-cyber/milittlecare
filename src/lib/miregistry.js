// Pure helpers for the MiRegistry deadline tracker. No Supabase
// imports, no React. Callers fetch the provider's training entries
// (via supabase or RPC) and pass them in; these functions compute
// derived state.
//
// See docs/miregistry_tracker_spec.md § 2.5 for the design.
//
// Authoritative source for the rules cited below is
// `docs/reference/Scholarship Handbook for License Exempt Provider.pdf`
// (revised 2026-04-01), pages 11–13 (LEP Training Levels and Annual
// Ongoing Training).
//
// Entry shape (one row from public.miregistry_training_entries):
//   {
//     id:             uuid,
//     user_id:        uuid,
//     completed_on:   'YYYY-MM-DD',
//     hours:          number  (numeric in DB, comes back as string|number;
//                              we coerce to Number where it matters),
//     title:          string,
//     source:         'leppt' | 'annual_ongoing' | 'level_2_approved' | 'other',
//     archived_at:    timestamptz | null,
//     ...
//   }

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Per Scholarship Handbook for License Exempt Provider (rev 2026-04,
// page 12): "Annual Ongoing Training is required to be completed each
// year by December 16." This is the calendar cycle anchor.
export const ANNUAL_DEADLINE_MONTH = 12  // December (1-indexed)
export const ANNUAL_DEADLINE_DAY = 16

export const SOURCE = Object.freeze({
  LEPPT:            'leppt',
  ANNUAL_ONGOING:   'annual_ongoing',
  LEVEL_2_APPROVED: 'level_2_approved',
  OTHER:            'other',
})

// Per-source UI metadata. Centralized here so TrainingEntryForm,
// TrainingEntryList, and any future surface render consistent labels
// and help text. `label` = full form-radio name, `badgeLabel` = short
// list-pill text, `help` = tooltip / per-option description.
export const SOURCE_OPTIONS = Object.freeze([
  {
    value: SOURCE.LEPPT,
    label: 'LEPPT (initial training)',
    badgeLabel: 'Initial',
    help:
      'The one-time License Exempt Provider Preservice Training. ' +
      'Required to enroll as a license-exempt CDC provider. Costs ' +
      '$10. You only complete this once in your career. If you opted ' +
      'out of the CPR/first-aid portion because you had a current ' +
      'card, log only the hours you actually completed.',
  },
  {
    value: SOURCE.ANNUAL_ONGOING,
    label: 'Annual Ongoing Training',
    badgeLabel: 'Annual',
    help:
      'The Michigan Ongoing Health & Safety Refresher. Required ' +
      'every year by December 16. Free. Up to 2 hours of this ' +
      'training count toward your 10 annual Level 2 hours.',
  },
  {
    value: SOURCE.LEVEL_2_APPROVED,
    label: 'Level 2 approved training',
    badgeLabel: 'Level 2',
    help:
      'Any other MiRegistry-approved training that counts toward ' +
      'your annual 10 hours for Level 2 pay rate. Each session must ' +
      'be at least 1 hour to count.',
  },
  {
    value: SOURCE.OTHER,
    label: 'Other',
    badgeLabel: 'Other',
    help:
      'Any training you want a record of that doesn’t fit the ' +
      'categories above. Doesn’t count toward Level 2 progress.',
  },
])

export const SOURCE_LABEL_BY_VALUE = Object.fromEntries(
  SOURCE_OPTIONS.map(o => [o.value, o.label])
)
export const SOURCE_BADGE_LABEL_BY_VALUE = Object.fromEntries(
  SOURCE_OPTIONS.map(o => [o.value, o.badgeLabel])
)

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Returns today's date in local time as 'YYYY-MM-DD'. Mirrors the
 * helper inlined in funding components (see docs/tech_debt.md note
 * about extracting a shared util when this multiplies further).
 *
 * @returns {string}
 */
export function todayYMD() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Format a (year, month, day) tuple as YYYY-MM-DD. month is 1-indexed.
 * Used to build deadline dates without going through Date arithmetic
 * that would import timezone surprises.
 */
function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Whole days between two YYYY-MM-DD strings (b - a). Computed via
 * Date.UTC to avoid daylight-saving boundary off-by-ones. Returns a
 * signed integer.
 */
function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = aYmd.split('-').map(Number)
  const [by, bm, bd] = bYmd.split('-').map(Number)
  const aUtc = Date.UTC(ay, am - 1, ad)
  const bUtc = Date.UTC(by, bm - 1, bd)
  return Math.round((bUtc - aUtc) / (1000 * 60 * 60 * 24))
}

/**
 * String comparison on YYYY-MM-DD is reliable because the format is
 * lexicographically ordered. Wrap it in a named helper so call sites
 * read clearly.
 */
function ymdInRange(value, startInclusive, endInclusive) {
  return value >= startInclusive && value <= endInclusive
}

function isActive(entry) {
  return entry && entry.archived_at == null
}

// -----------------------------------------------------------------------------
// Public helpers
// -----------------------------------------------------------------------------

/**
 * Annual Ongoing Training status for a given calendar year.
 *
 * Per handbook page 12: every license-exempt provider must complete
 * the Michigan Ongoing Health & Safety Training Refresher each year
 * by December 16. Per spec § 5.2 (resolution of the calendar-year
 * cycle question): "An entry with source = 'annual_ongoing' and
 * completed_on between Jan 1 and Dec 16 of year Y satisfies the
 * deadline for year Y." We implement that strict window — entries on
 * Dec 17–31 do not satisfy year Y under this function.
 *
 * @param {object}   args
 * @param {number}   args.year     Four-digit calendar year to evaluate.
 * @param {object[]} args.entries  Caller-supplied training entries.
 * @param {string}   [args.today]  YYYY-MM-DD; defaults to today (local).
 * @returns {{
 *   completed:          boolean,
 *   completionDate:     string | null,    // YYYY-MM-DD of the earliest
 *                                         // qualifying entry (most useful
 *                                         // for "Completed Nov 5, 2026" copy)
 *   deadlineDate:       string,           // 'YYYY-12-16'
 *   daysUntilDeadline:  number,           // signed; negative when past
 *   isPastDeadline:     boolean,          // strictly today > Dec 16 Y
 * }}
 */
export function getAnnualDeadlineStatus({ year, entries, today } = {}) {
  const todayStr = today || todayYMD()
  const deadlineDate = ymd(year, ANNUAL_DEADLINE_MONTH, ANNUAL_DEADLINE_DAY)
  const yearStart   = ymd(year, 1, 1)

  const safeEntries = Array.isArray(entries) ? entries : []
  const qualifying = safeEntries
    .filter(isActive)
    .filter(e => e && e.source === SOURCE.ANNUAL_ONGOING)
    .filter(e => e.completed_on && ymdInRange(e.completed_on, yearStart, deadlineDate))
    .map(e => e.completed_on)
    .sort()  // ascending YYYY-MM-DD strings sort chronologically

  const completed = qualifying.length > 0
  const completionDate = completed ? qualifying[0] : null

  // daysUntilDeadline is positive when today is before the deadline,
  // 0 when today is the deadline, negative when past. Reading: "you
  // have N days left."
  const daysUntilDeadline = daysBetweenYMD(todayStr, deadlineDate)
  const isPastDeadline = daysUntilDeadline < 0

  return {
    completed,
    completionDate,
    deadlineDate,
    daysUntilDeadline,
    isPastDeadline,
  }
}

/**
 * Total training hours logged in a given calendar year, summed across
 * ALL non-archived entries regardless of source.
 *
 * Per spec § 5.3: this is the "Hours logged this calendar year"
 * figure on the Training Hours card. It is intentionally NOT a
 * measure of Level 2 progress — pretending we can compute Level 2
 * hours without matching MiRegistry's accounting (≥1 hour/session,
 * 2-hour annual_ongoing cap, rolling expiration window) would create
 * wrong-number bugs. The Training Hours card directs the provider to
 * their MiRegistry transcript for the authoritative Level 2 number.
 *
 * @param {object}   args
 * @param {number}   args.year     Four-digit calendar year.
 * @param {object[]} args.entries
 * @returns {number} Total hours. 0 if no qualifying entries.
 */
export function getLoggedHoursThisYear({ year, entries } = {}) {
  const yearStart = ymd(year, 1, 1)
  const yearEnd   = ymd(year, 12, 31)

  const safeEntries = Array.isArray(entries) ? entries : []
  return safeEntries
    .filter(isActive)
    .filter(e => e && e.completed_on && ymdInRange(e.completed_on, yearStart, yearEnd))
    .reduce((sum, e) => sum + (Number(e.hours) || 0), 0)
}

/**
 * LEPPT (License Exempt Provider Preservice Training) completion
 * status. Per handbook page 11, LEPPT is the one-time initial
 * training every license-exempt provider must complete to enroll.
 * Multiple LEPPT entries are technically possible (re-credentialing
 * after a long lapse, etc.); we report the most recent.
 *
 * @param {object}   args
 * @param {object[]} args.entries
 * @returns {{ completed: boolean, completionDate: string | null }}
 */
export function getLeppTCompletion({ entries } = {}) {
  const safeEntries = Array.isArray(entries) ? entries : []
  const dates = safeEntries
    .filter(isActive)
    .filter(e => e && e.source === SOURCE.LEPPT)
    .map(e => e.completed_on)
    .filter(Boolean)
    .sort()  // ascending; we want most recent → take last

  if (dates.length === 0) {
    return { completed: false, completionDate: null }
  }
  return { completed: true, completionDate: dates[dates.length - 1] }
}
