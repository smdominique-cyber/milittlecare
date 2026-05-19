// Pure helpers for staff training tracking (licensed providers).
// No Supabase imports, no React. Callers fetch the licensee's roster,
// training records, the requirement catalog, and any health & safety
// update notices, then pass them in; these functions compute the
// derived compliance state.
//
// See docs/staff_training_tracking_spec.md § 2.5 for the design, and
// § 6 / § 7 for the verified MiLEAP rule basis (Michigan Administrative
// Code R 400.1901–1963, effective 2026-04-27). The requirement values
// themselves are reference data — the training_requirements catalog
// (migration 013) — and are passed in, not hard-coded here.
//
// Shapes (one row each from the migration-012 / 013 tables):
//   caregiver               public.caregivers
//   roster item             a caregiver row + a `regulatory_roles` array
//                           of public.caregiver_regulatory_roles rows
//   record                  public.staff_training_records
//   requirement             public.training_requirements
//   update                  public.health_safety_updates

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// R 400.1922(3), 1923(4), 1924(7) and 1924(10) all pivot on "2 years
// after the effective date of this rule." The rules took effect
// 2026-04-27, so the on-file → MiRegistry cutover is 2028-04-27 (spec
// § 7.2). Informational only — the app does not gate any UI on it.
export const ON_FILE_TO_MIREGISTRY_CUTOVER = '2028-04-27'

// A dated certification within this many days of its expiry renders as
// "expiring soon" (spec § 3.2 legend: "expiring ≤ 60 days").
export const EXPIRING_SOON_WINDOW_DAYS = 60

// staff_training_category enum (migration 012).
export const CATEGORY = Object.freeze({
  NEW_HIRE_TRAINING: 'new_hire_training',
  CPR_FIRST_AID: 'cpr_first_aid',
  PROFESSIONAL_DEVELOPMENT: 'professional_development',
  HEALTH_SAFETY_UPDATE_ACK: 'health_safety_update_acknowledgement',
  MIREGISTRY_ACCOUNT: 'miregistry_account',
  BACKGROUND_CHECK: 'background_check_eligibility',
  OTHER: 'other',
})

// regulatory_role enum (migration 012).
export const REGULATORY_ROLE = Object.freeze({
  LICENSEE: 'licensee',
  CHILD_CARE_STAFF_MEMBER: 'child_care_staff_member',
  CHILD_CARE_ASSISTANT: 'child_care_assistant',
  UNSUPERVISED_VOLUNTEER: 'unsupervised_volunteer',
  SUPERVISED_VOLUNTEER: 'supervised_volunteer',
  DRIVER: 'driver',
})

// Per-category UI metadata. Centralised so the matrix, the log, and the
// entry form render consistent labels and inline help (CLAUDE.md
// § Documentation Conventions rule 1).
export const CATEGORY_META = Object.freeze({
  [CATEGORY.NEW_HIRE_TRAINING]: {
    label: 'New hire training',
    short: 'New hire',
    help:
      'The home’s own new-hire curriculum — 14 mandated topics, ' +
      'completed within 90 days of being present and before any ' +
      'unsupervised care (R 400.1923). This is not the CDC LEPPT.',
    expires: false,
  },
  [CATEGORY.CPR_FIRST_AID]: {
    label: 'CPR / pediatric first aid',
    short: 'CPR / first aid',
    help:
      'A CPR and pediatric first aid certification. It expires on the ' +
      'date printed on the certification card; log that date so the ' +
      'dashboard can warn you before it lapses (R 400.1924(8)).',
    expires: true,
  },
  [CATEGORY.PROFESSIONAL_DEVELOPMENT]: {
    label: 'Professional development',
    short: 'Prof. dev.',
    help:
      'Clock-hour training counted per calendar year. The required ' +
      'number of hours varies by role (R 400.1924). Distinct from ' +
      'MiRegistry’s December 16 CDC deadline.',
    expires: false,
  },
  [CATEGORY.HEALTH_SAFETY_UPDATE_ACK]: {
    label: 'Health & safety update',
    short: 'H&S update',
    help:
      'When MiLEAP publishes a health & safety update notice, ' +
      'applicable staff must read and complete it within the ' +
      'timeframe stated on the notice (R 400.1924(11)).',
    expires: false,
  },
  [CATEGORY.MIREGISTRY_ACCOUNT]: {
    label: 'MiRegistry account & membership',
    short: 'MiRegistry',
    help:
      'A MiRegistry account with non-expired membership and a ' +
      'verified employment entry, within 30 days of employment ' +
      '(R 400.1922). Record the membership status and expiry date.',
    expires: true,
  },
  [CATEGORY.BACKGROUND_CHECK]: {
    label: 'Background-check eligibility',
    short: 'Background check',
    help:
      'An eligibility determination before any unsupervised contact ' +
      'with children (R 400.1919, R 400.1903(1)(r)).',
    expires: false,
  },
  [CATEGORY.OTHER]: {
    label: 'Other training',
    short: 'Other',
    help: 'Any other training the provider wants on record.',
    expires: false,
  },
})

export const REGULATORY_ROLE_META = Object.freeze({
  [REGULATORY_ROLE.LICENSEE]: { label: 'Licensee' },
  [REGULATORY_ROLE.CHILD_CARE_STAFF_MEMBER]: { label: 'Child care staff member' },
  [REGULATORY_ROLE.CHILD_CARE_ASSISTANT]: { label: 'Child care assistant' },
  [REGULATORY_ROLE.UNSUPERVISED_VOLUNTEER]: { label: 'Unsupervised volunteer' },
  [REGULATORY_ROLE.SUPERVISED_VOLUNTEER]: { label: 'Supervised volunteer' },
  [REGULATORY_ROLE.DRIVER]: { label: 'Driver' },
})

// miregistry_status enum — the first four count as "non-expired"
// membership per R 400.1922(1); 'expired' does not.
export const MIREGISTRY_STATUS_META = Object.freeze({
  submitted: { label: 'Submitted', ok: true },
  materials_received: { label: 'Materials received', ok: true },
  awaiting_print: { label: 'Awaiting print', ok: true },
  current: { label: 'Current', ok: true },
  expired: { label: 'Expired', ok: false },
})

// background_check_status enum (R 400.1919).
export const BACKGROUND_CHECK_STATUS_META = Object.freeze({
  pending: { label: 'Pending', ok: false },
  eligible: { label: 'Eligible', ok: true },
  ineligible: { label: 'Ineligible', ok: false },
})

// Status of a single dated certification (spec § 2.5 getRecordStatus).
export const RECORD_STATUS = Object.freeze({
  VALID: 'valid',
  EXPIRING_SOON: 'expiring_soon',
  EXPIRED: 'expired',
  NONE: 'none',
})

// Status of one (caregiver, category) cell in the compliance matrix.
export const CELL_STATUS = Object.freeze({
  OK: 'ok',                     // ✓ on record / satisfied
  EXPIRING_SOON: 'expiring_soon',// ⚠ a cert expiring within the window
  EXPIRED: 'expired',           // ✗ a dated cert past its expiry
  OVERDUE: 'overdue',           // ✗ a required item past its deadline
  MISSING: 'missing',           // — not on record, deadline not yet passed
  PENDING: 'pending',           // not on record, still inside the grace window
  NOT_REQUIRED: 'not_required', // n/a — the adopted rules do not address it
})

// Worst-wins ordering for the per-person rollup (higher = worse).
const CELL_SEVERITY = Object.freeze({
  [CELL_STATUS.NOT_REQUIRED]: 0,
  [CELL_STATUS.OK]: 1,
  [CELL_STATUS.PENDING]: 2,
  [CELL_STATUS.MISSING]: 3,
  [CELL_STATUS.EXPIRING_SOON]: 4,
  [CELL_STATUS.OVERDUE]: 5,
  [CELL_STATUS.EXPIRED]: 5,
})

// Cell statuses that belong on the licensee's "needs attention" list.
const ATTENTION_STATUSES = Object.freeze([
  CELL_STATUS.EXPIRED,
  CELL_STATUS.OVERDUE,
  CELL_STATUS.EXPIRING_SOON,
  CELL_STATUS.MISSING,
])

// Cadence strictness — lower = earlier deadline = wins the rollup.
const CADENCE_STRICTNESS = Object.freeze({
  before_care: 0,
  within_30_days: 1,
  within_90_days: 2,
  per_card_expiry: 3,
  per_calendar_year: 4,
  per_notice: 5,
  conditional: 9,
})

// -----------------------------------------------------------------------------
// Internal date helpers
//
// Duplicated from miregistry.js / cdcPayPeriods.js — see docs/tech_debt.md
// § "Deferred work introduced by PR #6" for the standing note to lift
// these into a shared src/lib/dates.js.
// -----------------------------------------------------------------------------

/** Today's local date as 'YYYY-MM-DD'. */
export function todayYMD() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Whole days from aYmd to bYmd (b - a); signed. Date.UTC dodges DST. */
function daysBetweenYMD(aYmd, bYmd) {
  const [ay, am, ad] = String(aYmd).split('-').map(Number)
  const [by, bm, bd] = String(bYmd).split('-').map(Number)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000
  )
}

/** aYmd shifted by `days` calendar days, as 'YYYY-MM-DD'. */
function addDaysYMD(aYmd, days) {
  const [y, m, d] = String(aYmd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** 'YYYY-MM-DD' → 'Mar 2, 2026'. Returns '' for falsy input. */
export function formatShortDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

function isActive(row) {
  return row && row.archived_at == null
}

// -----------------------------------------------------------------------------
// Record-level helpers
// -----------------------------------------------------------------------------

/**
 * Status of a single dated certification record, purely from its
 * `completed_on` + `expires_on` (spec § 2.5).
 *
 * @param {object} record                One staff_training_records row.
 * @param {string} [today]               YYYY-MM-DD; defaults to today.
 * @param {number} [windowDays]          "expiring soon" threshold.
 * @returns {'valid'|'expiring_soon'|'expired'|'none'}
 */
export function getRecordStatus(record, today, windowDays = EXPIRING_SOON_WINDOW_DAYS) {
  if (!record || !record.completed_on) return RECORD_STATUS.NONE
  if (!record.expires_on) return RECORD_STATUS.VALID  // does not expire
  const todayStr = today || todayYMD()
  const daysLeft = daysBetweenYMD(todayStr, record.expires_on)
  if (daysLeft < 0) return RECORD_STATUS.EXPIRED
  if (daysLeft <= windowDays) return RECORD_STATUS.EXPIRING_SOON
  return RECORD_STATUS.VALID
}

/**
 * Deadline status for an obligation anchored to a hire date — the
 * 30-day MiRegistry deadline (R 400.1922) and the 90-day new-hire /
 * assistant-CPR deadlines (R 400.1923(1), R 400.1921(3)).
 *
 * @param {string|null} dateOfHire   YYYY-MM-DD, or null if unknown.
 * @param {number}      offsetDays   Days after hire the obligation is due.
 * @param {string}      [today]      YYYY-MM-DD; defaults to today.
 * @returns {{
 *   hasDeadline: boolean,            // false when dateOfHire is unknown
 *   dueDate: string|null,
 *   daysRemaining: number|null,      // signed; negative once past due
 *   isOverdue: boolean,
 * }}
 */
export function getHireDeadlineStatus(dateOfHire, offsetDays, today) {
  if (!dateOfHire) {
    return { hasDeadline: false, dueDate: null, daysRemaining: null, isOverdue: false }
  }
  const todayStr = today || todayYMD()
  const dueDate = addDaysYMD(dateOfHire, offsetDays)
  const daysRemaining = daysBetweenYMD(todayStr, dueDate)
  return { hasDeadline: true, dueDate, daysRemaining, isOverdue: daysRemaining < 0 }
}

/**
 * Professional-development progress for one caregiver in a calendar
 * year — a per-calendar-year clock-hour total (R 400.1924(1)–(4)).
 *
 * @param {object}   args
 * @param {object[]} args.records        The caregiver's training records.
 * @param {number}   args.year           Four-digit calendar year.
 * @param {number}   args.requiredHours  Hours required for the year.
 * @returns {{ loggedHours: number, requiredHours: number, satisfied: boolean }}
 */
export function getProfessionalDevelopmentStatus({ records, year, requiredHours } = {}) {
  const req = Number(requiredHours) || 0
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const safe = Array.isArray(records) ? records : []
  const loggedHours = safe
    .filter(isActive)
    .filter(r => r && r.category === CATEGORY.PROFESSIONAL_DEVELOPMENT)
    .filter(r => r.completed_on >= yearStart && r.completed_on <= yearEnd)
    .reduce((sum, r) => sum + (Number(r.hours) || 0), 0)
  return { loggedHours, requiredHours: req, satisfied: loggedHours >= req }
}

/**
 * Acknowledgement status of one health & safety update notice for one
 * caregiver (R 400.1924(11)). A notice is acknowledged by a training
 * record of category `health_safety_update_acknowledgement` whose
 * `reference_code` is the notice's id (migration 012 comment, the
 * § 7.1 seam).
 *
 * @param {object}   args
 * @param {object}   args.update       One health_safety_updates row.
 * @param {object[]} args.records      The caregiver's training records.
 * @param {string}   [args.today]      YYYY-MM-DD; defaults to today.
 * @returns {{
 *   acknowledged: boolean,
 *   isOverdue: boolean,               // unacknowledged and past acknowledge_by
 *   daysRemaining: number|null,       // signed; null when no acknowledge_by
 * }}
 */
export function getUpdateAckStatus({ update, records, today } = {}) {
  const todayStr = today || todayYMD()
  const safe = Array.isArray(records) ? records : []
  const acknowledged = safe
    .filter(isActive)
    .some(r =>
      r &&
      r.category === CATEGORY.HEALTH_SAFETY_UPDATE_ACK &&
      r.reference_code === update?.id
    )
  const ackBy = update?.acknowledge_by || null
  const daysRemaining = ackBy ? daysBetweenYMD(todayStr, ackBy) : null
  return {
    acknowledged,
    isOverdue: !acknowledged && daysRemaining != null && daysRemaining < 0,
    daysRemaining,
  }
}

// -----------------------------------------------------------------------------
// Requirement rollup
// -----------------------------------------------------------------------------

/**
 * Whether a `conditional`-cadence requirement applies to a caregiver,
 * given the driver attributes on their `driver` regulatory-role row
 * (R 400.1951(4), R 400.1951(10)).
 */
function conditionMet(condition, driverRoleRow) {
  if (!driverRoleRow) return false
  const ratio = driverRoleRow.driver_ratio_counted === true
  const unsup = driverRoleRow.driver_has_unsupervised_access === true
  if (condition === 'ratio_counted') return ratio
  if (condition === 'unsupervised_access_or_ratio_counted') return ratio || unsup
  return false
}

/**
 * Rolls a caregiver's regulatory roles up against the requirement
 * catalog into one effective requirement per category — strictest-wins
 * (spec § 6.3): a category is required if any of the person's roles
 * requires it; `requiredHours` is the largest threshold among them.
 *
 * @param {object}   args
 * @param {object[]} args.regulatoryRoles  caregiver_regulatory_roles rows.
 * @param {object[]} args.requirements     training_requirements catalog.
 * @returns {Map<string, {
 *   category: string,
 *   requiredHours: number|null,
 *   cadence: string,
 *   citations: string[],
 * }>}
 */
export function getEffectiveRequirements({ regulatoryRoles, requirements } = {}) {
  const roles = Array.isArray(regulatoryRoles) ? regulatoryRoles : []
  const catalog = Array.isArray(requirements) ? requirements : []
  const roleNames = new Set(roles.map(r => r.regulatory_role))
  const driverRow = roles.find(r => r.regulatory_role === REGULATORY_ROLE.DRIVER) || null

  const byCategory = new Map()
  for (const req of catalog) {
    if (!req || !roleNames.has(req.regulatory_role)) continue
    if (req.is_required === false) continue
    if (req.cadence === 'conditional' && !conditionMet(req.condition, driverRow)) {
      continue
    }
    const existing = byCategory.get(req.category)
    const hours = req.required_hours == null ? null : Number(req.required_hours)
    if (!existing) {
      byCategory.set(req.category, {
        category: req.category,
        requiredHours: hours,
        cadence: req.cadence,
        citations: req.citation ? [req.citation] : [],
      })
    } else {
      if (hours != null) {
        existing.requiredHours =
          existing.requiredHours == null ? hours : Math.max(existing.requiredHours, hours)
      }
      if (
        (CADENCE_STRICTNESS[req.cadence] ?? 9) <
        (CADENCE_STRICTNESS[existing.cadence] ?? 9)
      ) {
        existing.cadence = req.cadence
      }
      if (req.citation && !existing.citations.includes(req.citation)) {
        existing.citations.push(req.citation)
      }
    }
  }
  return byCategory
}

// -----------------------------------------------------------------------------
// Per-category cell status
// -----------------------------------------------------------------------------

function latestRecord(records, category) {
  return [...records]
    .filter(isActive)
    .filter(r => r && r.category === category)
    .sort((a, b) => String(b.completed_on).localeCompare(String(a.completed_on)))[0] || null
}

function cell(status, detail, record = null) {
  return { status, detail, record }
}

// Status of a not-on-record obligation, from its deadline.
function missingByDeadline(deadline) {
  if (!deadline.hasDeadline) return CELL_STATUS.MISSING       // hire date unknown
  return deadline.isOverdue ? CELL_STATUS.OVERDUE : CELL_STATUS.PENDING
}

/**
 * Compliance status of one (caregiver, category) cell.
 *
 * @param {object} args
 * @param {string} args.category       The training category.
 * @param {object} args.requirement    The rolled-up effective requirement.
 * @param {object[]} args.records      The caregiver's training records.
 * @param {object} args.caregiver      The caregiver row (for date_of_hire).
 * @param {object[]} args.updates      The licensee's health_safety_updates.
 * @param {string} args.today          YYYY-MM-DD.
 * @returns {{ status: string, detail: string, record: object|null }}
 */
export function getCategoryStatus({ category, requirement, records, caregiver, updates, today }) {
  const recs = Array.isArray(records) ? records : []
  const hire = caregiver?.date_of_hire || null
  const todayStr = today || todayYMD()

  if (category === CATEGORY.CPR_FIRST_AID) {
    const rec = latestRecord(recs, category)
    if (!rec) {
      const offset = requirement.cadence === 'within_90_days' ? 90 : 0
      const deadline = requirement.cadence === 'within_90_days'
        ? getHireDeadlineStatus(hire, offset, todayStr)
        : { hasDeadline: !!hire, isOverdue: !!hire && hire <= todayStr }
      return cell(missingByDeadline(deadline), 'Not on record')
    }
    const rs = getRecordStatus(rec, todayStr)
    const detail = rec.expires_on
      ? `Expires ${formatShortDate(rec.expires_on)}`
      : 'No expiry on record'
    if (rs === RECORD_STATUS.EXPIRED) return cell(CELL_STATUS.EXPIRED, detail, rec)
    if (rs === RECORD_STATUS.EXPIRING_SOON) return cell(CELL_STATUS.EXPIRING_SOON, detail, rec)
    return cell(CELL_STATUS.OK, detail, rec)
  }

  if (category === CATEGORY.NEW_HIRE_TRAINING) {
    const rec = latestRecord(recs, category)
    if (rec) return cell(CELL_STATUS.OK, `Completed ${formatShortDate(rec.completed_on)}`, rec)
    const deadline = getHireDeadlineStatus(hire, 90, todayStr)
    const detail = deadline.hasDeadline
      ? `Due ${formatShortDate(deadline.dueDate)}`
      : 'Not on record'
    return cell(missingByDeadline(deadline), detail)
  }

  if (category === CATEGORY.MIREGISTRY_ACCOUNT) {
    const rec = latestRecord(recs, category)
    if (!rec) {
      const deadline = getHireDeadlineStatus(hire, 30, todayStr)
      const detail = deadline.hasDeadline
        ? `Due ${formatShortDate(deadline.dueDate)}`
        : 'Not on record'
      return cell(missingByDeadline(deadline), detail)
    }
    const meta = MIREGISTRY_STATUS_META[rec.miregistry_status]
    const label = meta?.label || rec.miregistry_status || 'Unknown'
    if (!meta?.ok) return cell(CELL_STATUS.OVERDUE, label, rec)
    const rs = getRecordStatus(rec, todayStr)
    const detail = rec.expires_on
      ? `${label}, expires ${formatShortDate(rec.expires_on)}`
      : label
    if (rs === RECORD_STATUS.EXPIRED) return cell(CELL_STATUS.EXPIRED, detail, rec)
    if (rs === RECORD_STATUS.EXPIRING_SOON) return cell(CELL_STATUS.EXPIRING_SOON, detail, rec)
    return cell(CELL_STATUS.OK, detail, rec)
  }

  if (category === CATEGORY.BACKGROUND_CHECK) {
    const rec = latestRecord(recs, category)
    if (!rec) {
      const overdue = !!hire && hire <= todayStr
      return cell(overdue ? CELL_STATUS.OVERDUE : CELL_STATUS.MISSING, 'Not on record')
    }
    const meta = BACKGROUND_CHECK_STATUS_META[rec.background_check_status]
    const label = meta?.label || rec.background_check_status || 'Unknown'
    if (meta?.ok) return cell(CELL_STATUS.OK, label, rec)
    if (rec.background_check_status === 'ineligible') return cell(CELL_STATUS.OVERDUE, label, rec)
    return cell(CELL_STATUS.MISSING, label, rec)  // pending
  }

  if (category === CATEGORY.PROFESSIONAL_DEVELOPMENT) {
    const year = Number(todayStr.slice(0, 4))
    const pd = getProfessionalDevelopmentStatus({
      records: recs,
      year,
      requiredHours: requirement.requiredHours,
    })
    const detail = `${pd.loggedHours} / ${pd.requiredHours} hrs (${year})`
    return cell(pd.satisfied ? CELL_STATUS.OK : CELL_STATUS.MISSING, detail)
  }

  if (category === CATEGORY.HEALTH_SAFETY_UPDATE_ACK) {
    const notices = (Array.isArray(updates) ? updates : []).filter(isActive)
    if (notices.length === 0) return cell(CELL_STATUS.OK, 'No notices outstanding')
    let overdue = 0
    let pending = 0
    for (const notice of notices) {
      const ack = getUpdateAckStatus({ update: notice, records: recs, today: todayStr })
      if (ack.acknowledged) continue
      if (ack.isOverdue) overdue += 1
      else pending += 1
    }
    if (overdue > 0) return cell(CELL_STATUS.OVERDUE, `${overdue} notice(s) overdue`)
    if (pending > 0) return cell(CELL_STATUS.PENDING, `${pending} notice(s) to acknowledge`)
    return cell(CELL_STATUS.OK, 'All notices acknowledged')
  }

  // Unknown / 'other' — never a catalog requirement, so never reached
  // through the matrix; treated defensively.
  return cell(CELL_STATUS.NOT_REQUIRED, '')
}

// -----------------------------------------------------------------------------
// Matrix + attention list
// -----------------------------------------------------------------------------

/**
 * Picks the worst cell status across a row's required cells.
 */
function rollupStatus(cells) {
  let worst = CELL_STATUS.OK
  for (const c of cells) {
    if (c.status === CELL_STATUS.NOT_REQUIRED) continue
    if ((CELL_SEVERITY[c.status] ?? 0) > (CELL_SEVERITY[worst] ?? 0)) worst = c.status
  }
  return worst
}

/**
 * The licensee roster compliance matrix (spec § 2.5, § 3.2): one row
 * per caregiver, one cell per training category, plus a flattened
 * "needs attention" list.
 *
 * @param {object} args
 * @param {object[]} args.roster        Caregiver rows, each with a
 *                                      `regulatory_roles` array attached.
 * @param {object[]} args.records       All staff_training_records rows.
 * @param {object[]} args.requirements  The training_requirements catalog.
 * @param {object[]} [args.updates]     The licensee's health_safety_updates.
 * @param {string}   [args.today]       YYYY-MM-DD; defaults to today.
 * @returns {{
 *   categories: string[],              // category columns that appear
 *   rows: object[],                    // per-caregiver { caregiver, roles,
 *                                      //   cells, rollup }
 *   attentionItems: object[],          // flattened non-ok cells
 * }}
 */
export function getStaffComplianceMatrix({ roster, records, requirements, updates, today } = {}) {
  const todayStr = today || todayYMD()
  const safeRoster = Array.isArray(roster) ? roster : []
  const safeRecords = Array.isArray(records) ? records : []

  const categoryColumns = new Set()
  const rows = safeRoster.map(caregiver => {
    const regulatoryRoles = Array.isArray(caregiver.regulatory_roles)
      ? caregiver.regulatory_roles
      : []
    const effective = getEffectiveRequirements({ regulatoryRoles, requirements })
    const myRecords = safeRecords.filter(r => r && r.caregiver_id === caregiver.id)

    const cells = {}
    for (const [category, requirement] of effective) {
      categoryColumns.add(category)
      cells[category] = {
        ...getCategoryStatus({
          category,
          requirement,
          records: myRecords,
          caregiver,
          updates,
          today: todayStr,
        }),
        category,
        requirement,
      }
    }
    return {
      caregiver,
      roles: regulatoryRoles.map(r => r.regulatory_role),
      cells,
      rollup: rollupStatus(Object.values(cells)),
    }
  })

  // Stable column order, matching the category enum declaration order.
  const categories = Object.values(CATEGORY).filter(c => categoryColumns.has(c))

  const attentionItems = []
  for (const row of rows) {
    for (const category of categories) {
      const c = row.cells[category]
      if (c && ATTENTION_STATUSES.includes(c.status)) {
        attentionItems.push({
          caregiverId: row.caregiver.id,
          caregiverName: row.caregiver.full_name,
          category,
          status: c.status,
          detail: c.detail,
        })
      }
    }
  }
  attentionItems.sort(
    (a, b) => (CELL_SEVERITY[b.status] ?? 0) - (CELL_SEVERITY[a.status] ?? 0)
  )

  return { categories, rows, attentionItems }
}

/**
 * The licensee's "expiring soon" list — every dated certification
 * (CPR / first aid, MiRegistry membership) that is already expired or
 * within `windowDays` of expiring. Independent of the requirement
 * catalog: an `expires_on` date is self-contained (spec § 2.4).
 *
 * @param {object}   args
 * @param {object[]} args.records      staff_training_records rows.
 * @param {object[]} [args.roster]     Caregiver rows — used to attach names.
 * @param {string}   [args.today]      YYYY-MM-DD; defaults to today.
 * @param {number}   [args.windowDays] "expiring soon" threshold.
 * @returns {object[]} Sorted soonest-expiry-first; each item carries
 *   `{ record, caregiverId, caregiverName, status, expiresOn }`.
 */
export function getExpiringSoon({ records, roster, today, windowDays = EXPIRING_SOON_WINDOW_DAYS } = {}) {
  const todayStr = today || todayYMD()
  const safeRecords = Array.isArray(records) ? records : []
  const nameById = new Map(
    (Array.isArray(roster) ? roster : []).map(c => [c.id, c.full_name])
  )

  return safeRecords
    .filter(isActive)
    .filter(r => r && r.expires_on)
    .map(r => ({
      record: r,
      caregiverId: r.caregiver_id,
      caregiverName: nameById.get(r.caregiver_id) || null,
      status: getRecordStatus(r, todayStr, windowDays),
      expiresOn: r.expires_on,
    }))
    .filter(item =>
      item.status === RECORD_STATUS.EXPIRED ||
      item.status === RECORD_STATUS.EXPIRING_SOON
    )
    .sort((a, b) => String(a.expiresOn).localeCompare(String(b.expiresOn)))
}
