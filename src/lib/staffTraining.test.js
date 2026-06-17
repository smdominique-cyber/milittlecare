import { describe, it, expect } from 'vitest'
import {
  getRecordStatus,
  getHireDeadlineStatus,
  getProfessionalDevelopmentStatus,
  getUpdateAckStatus,
  getEffectiveRequirements,
  getCategoryStatus,
  getStaffComplianceMatrix,
  getExpiringSoon,
  RECORD_STATUS,
  CELL_STATUS,
  CATEGORY,
  REGULATORY_ROLE,
  ON_FILE_TO_MIREGISTRY_CUTOVER,
  EXPIRING_SOON_WINDOW_DAYS,
} from './staffTraining'

// A fixed "today" so every time-based assertion is deterministic.
const TODAY = '2026-05-19'

// -- Fixture builders ---------------------------------------------------------

const rec = (overrides = {}) => ({
  id: `r-${Math.random().toString(36).slice(2)}`,
  caregiver_id: 'cg-1',
  category: CATEGORY.CPR_FIRST_AID,
  title: 'Test record',
  completed_on: '2025-01-01',
  expires_on: null,
  hours: null,
  miregistry_status: null,
  background_check_status: null,
  archived_at: null,
  ...overrides,
})

const requirement = (category, regulatory_role, overrides = {}) => ({
  id: `req-${category}-${regulatory_role}`,
  category,
  regulatory_role,
  is_required: true,
  cadence: 'before_care',
  required_hours: null,
  condition: null,
  citation: 'R 400.1900',
  ...overrides,
})

// -----------------------------------------------------------------------------

describe('constants', () => {
  it('the on-file → MiRegistry cutover is 2028-04-27 (spec § 7.2)', () => {
    expect(ON_FILE_TO_MIREGISTRY_CUTOVER).toBe('2028-04-27')
  })
  it('the expiring-soon window is 60 days (spec § 3.2)', () => {
    expect(EXPIRING_SOON_WINDOW_DAYS).toBe(60)
  })
})

describe('getRecordStatus — certification expiry', () => {
  it('returns none when there is no record', () => {
    expect(getRecordStatus(null, TODAY)).toBe(RECORD_STATUS.NONE)
  })

  it('returns none when completed_on is missing', () => {
    expect(getRecordStatus(rec({ completed_on: null }), TODAY)).toBe(RECORD_STATUS.NONE)
  })

  it('returns valid when the record has no expiry date', () => {
    expect(getRecordStatus(rec({ expires_on: null }), TODAY)).toBe(RECORD_STATUS.VALID)
  })

  it('returns valid when expiry is far in the future', () => {
    expect(getRecordStatus(rec({ expires_on: '2027-08-01' }), TODAY)).toBe(RECORD_STATUS.VALID)
  })

  it('returns expiring_soon inside the 60-day window', () => {
    // 2026-05-19 + 30 days
    expect(getRecordStatus(rec({ expires_on: '2026-06-18' }), TODAY)).toBe(RECORD_STATUS.EXPIRING_SOON)
  })

  it('treats exactly windowDays out as expiring_soon (boundary)', () => {
    expect(getRecordStatus(rec({ expires_on: '2026-07-18' }), TODAY)).toBe(RECORD_STATUS.EXPIRING_SOON)
  })

  it('treats one day past the window as still valid (boundary)', () => {
    expect(getRecordStatus(rec({ expires_on: '2026-07-19' }), TODAY)).toBe(RECORD_STATUS.VALID)
  })

  it('returns expired when the expiry date has passed', () => {
    expect(getRecordStatus(rec({ expires_on: '2026-03-02' }), TODAY)).toBe(RECORD_STATUS.EXPIRED)
  })

  it('treats the expiry day itself as not yet expired', () => {
    expect(getRecordStatus(rec({ expires_on: TODAY }), TODAY)).toBe(RECORD_STATUS.EXPIRING_SOON)
  })
})

describe('getHireDeadlineStatus — 30-day and 90-day deadlines', () => {
  it('has no deadline when the hire date is unknown', () => {
    const d = getHireDeadlineStatus(null, 90, TODAY)
    expect(d.hasDeadline).toBe(false)
    expect(d.dueDate).toBeNull()
  })

  it('computes the 30-day MiRegistry deadline (R 400.1922)', () => {
    const d = getHireDeadlineStatus('2026-05-01', 30, TODAY)
    expect(d.dueDate).toBe('2026-05-31')
    expect(d.daysRemaining).toBe(12)
    expect(d.isOverdue).toBe(false)
  })

  it('flags the 30-day deadline overdue once it has passed', () => {
    const d = getHireDeadlineStatus('2026-03-01', 30, TODAY)
    expect(d.dueDate).toBe('2026-03-31')
    expect(d.isOverdue).toBe(true)
    expect(d.daysRemaining).toBeLessThan(0)
  })

  it('computes the 90-day new-hire deadline (R 400.1923(1))', () => {
    const d = getHireDeadlineStatus('2026-03-01', 90, TODAY)
    expect(d.dueDate).toBe('2026-05-30')
    expect(d.daysRemaining).toBe(11)
    expect(d.isOverdue).toBe(false)
  })

  it('flags the 90-day deadline overdue when hire was long ago', () => {
    const d = getHireDeadlineStatus('2025-01-01', 90, TODAY)
    expect(d.isOverdue).toBe(true)
  })
})

describe('getProfessionalDevelopmentStatus — annual PD hours', () => {
  it('sums only PD records inside the calendar year', () => {
    const records = [
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-02-01', hours: 2 }),
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-09-15', hours: 1.5 }),
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2025-12-31', hours: 9 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(3.5)
    expect(pd.requiredHours).toBe(5)
    expect(pd.satisfied).toBe(false)
  })

  it('is satisfied once logged hours reach the requirement', () => {
    const records = [
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-03-01', hours: 6 }),
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-06-01', hours: 4 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 10 })
    expect(pd.loggedHours).toBe(10)
    expect(pd.satisfied).toBe(true)
  })

  it('ignores archived PD records and ignores non-PD-contributing categories', () => {
    // 2026-06-16 — CPR_FIRST_AID was REMOVED from the "ignored" set
    // per R 400.1924(5) (it now contributes to PD). The remaining
    // non-PD-contributing categories include HEALTH_SAFETY_UPDATE_ACK,
    // NEW_HIRE_TRAINING, MIREGISTRY_ACCOUNT, BACKGROUND_CHECK, OTHER.
    const records = [
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-03-01', hours: 5, archived_at: '2026-04-01T00:00:00Z' }),
      rec({ category: CATEGORY.HEALTH_SAFETY_UPDATE_ACK, completed_on: '2026-03-01', hours: 8 }),
      rec({ category: CATEGORY.NEW_HIRE_TRAINING, completed_on: '2026-03-01', hours: 14 }),
      rec({ category: CATEGORY.OTHER, completed_on: '2026-03-01', hours: 3 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(0)
    expect(pd.satisfied).toBe(false)
  })

  // 2026-06-16 — R 400.1924(5): CPR / pediatric first aid hours count
  // toward the annual PD total. Pre-fix the aggregator only summed
  // PROFESSIONAL_DEVELOPMENT rows; licensed homes were undercounting
  // their real PD progress against the 10/yr (licensee) / 5/yr
  // (staff) thresholds.

  it('R 400.1924(5): CPR / first aid hours count toward the annual PD total', () => {
    const records = [
      rec({ category: CATEGORY.CPR_FIRST_AID, completed_on: '2026-03-15', hours: 6.5 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(6.5)
    expect(pd.satisfied).toBe(true)
  })

  it('R 400.1924(5): CPR + PD hours sum together to the annual total', () => {
    const records = [
      rec({ category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-02-01', hours: 4 }),
      rec({ category: CATEGORY.CPR_FIRST_AID, completed_on: '2026-04-15', hours: 6 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 10 })
    expect(pd.loggedHours).toBe(10)
    expect(pd.satisfied).toBe(true)
  })

  it('R 400.1924(5): an archived CPR record does NOT count toward PD', () => {
    const records = [
      rec({ category: CATEGORY.CPR_FIRST_AID, completed_on: '2026-03-15', hours: 6.5, archived_at: '2026-04-01T00:00:00Z' }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(0)
    expect(pd.satisfied).toBe(false)
  })

  it('R 400.1924(5): a CPR record outside the calendar year does NOT count', () => {
    const records = [
      rec({ category: CATEGORY.CPR_FIRST_AID, completed_on: '2025-12-31', hours: 6 }),
      rec({ category: CATEGORY.CPR_FIRST_AID, completed_on: '2027-01-01', hours: 6 }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(0)
  })

  it('R 400.1924(5): the per-card expiry on a CPR record does NOT affect its PD-hour contribution (a current-year CPR with an expired-in-future card still counts for the year it was completed)', () => {
    const records = [
      rec({
        category: CATEGORY.CPR_FIRST_AID,
        completed_on: '2026-06-01',
        hours: 5,
        expires_on: '2028-06-01',
      }),
    ]
    const pd = getProfessionalDevelopmentStatus({ records, year: 2026, requiredHours: 5 })
    expect(pd.loggedHours).toBe(5)
    expect(pd.satisfied).toBe(true)
  })
})

describe('getUpdateAckStatus — health & safety update deadlines', () => {
  const update = { id: 'hsu-1', acknowledge_by: '2026-05-10' }

  it('is acknowledged when an ack record references the notice', () => {
    const records = [
      rec({
        category: CATEGORY.HEALTH_SAFETY_UPDATE_ACK,
        reference_code: 'hsu-1',
        completed_on: '2026-05-05',
      }),
    ]
    const s = getUpdateAckStatus({ update, records, today: TODAY })
    expect(s.acknowledged).toBe(true)
    expect(s.isOverdue).toBe(false)
  })

  it('is overdue when unacknowledged past the acknowledge_by date', () => {
    const s = getUpdateAckStatus({ update, records: [], today: TODAY })
    expect(s.acknowledged).toBe(false)
    expect(s.isOverdue).toBe(true)
    expect(s.daysRemaining).toBeLessThan(0)
  })

  it('is pending (not overdue) when the deadline is still in the future', () => {
    const s = getUpdateAckStatus({
      update: { id: 'hsu-2', acknowledge_by: '2026-06-30' },
      records: [],
      today: TODAY,
    })
    expect(s.acknowledged).toBe(false)
    expect(s.isOverdue).toBe(false)
    expect(s.daysRemaining).toBeGreaterThan(0)
  })

  it('is never overdue when the notice carries no acknowledge_by date', () => {
    const s = getUpdateAckStatus({
      update: { id: 'hsu-3', acknowledge_by: null },
      records: [],
      today: TODAY,
    })
    expect(s.isOverdue).toBe(false)
    expect(s.daysRemaining).toBeNull()
  })

  it('an ack record for a different notice does not count', () => {
    const records = [
      rec({ category: CATEGORY.HEALTH_SAFETY_UPDATE_ACK, reference_code: 'hsu-OTHER' }),
    ]
    const s = getUpdateAckStatus({ update, records, today: TODAY })
    expect(s.acknowledged).toBe(false)
  })
})

describe('getEffectiveRequirements — multi-role strictest-wins rollup', () => {
  const catalog = [
    requirement(CATEGORY.PROFESSIONAL_DEVELOPMENT, REGULATORY_ROLE.CHILD_CARE_STAFF_MEMBER, {
      cadence: 'per_calendar_year', required_hours: 5,
    }),
    requirement(CATEGORY.PROFESSIONAL_DEVELOPMENT, REGULATORY_ROLE.DRIVER, {
      cadence: 'per_calendar_year', required_hours: 1,
    }),
    requirement(CATEGORY.NEW_HIRE_TRAINING, REGULATORY_ROLE.DRIVER, {
      cadence: 'conditional', condition: 'ratio_counted',
    }),
  ]

  it('takes the largest required_hours across a person’s roles', () => {
    const roles = [
      { regulatory_role: REGULATORY_ROLE.CHILD_CARE_STAFF_MEMBER },
      { regulatory_role: REGULATORY_ROLE.DRIVER, driver_ratio_counted: false, driver_has_unsupervised_access: false },
    ]
    const eff = getEffectiveRequirements({ regulatoryRoles: roles, requirements: catalog })
    expect(eff.get(CATEGORY.PROFESSIONAL_DEVELOPMENT).requiredHours).toBe(5)
  })

  it('excludes a conditional driver requirement when the condition is not met', () => {
    const roles = [
      { regulatory_role: REGULATORY_ROLE.DRIVER, driver_ratio_counted: false, driver_has_unsupervised_access: false },
    ]
    const eff = getEffectiveRequirements({ regulatoryRoles: roles, requirements: catalog })
    expect(eff.has(CATEGORY.NEW_HIRE_TRAINING)).toBe(false)
  })

  it('includes a conditional driver requirement when ratio-counted', () => {
    const roles = [
      { regulatory_role: REGULATORY_ROLE.DRIVER, driver_ratio_counted: true, driver_has_unsupervised_access: false },
    ]
    const eff = getEffectiveRequirements({ regulatoryRoles: roles, requirements: catalog })
    expect(eff.has(CATEGORY.NEW_HIRE_TRAINING)).toBe(true)
  })
})

describe('getCategoryStatus — cell statuses', () => {
  it('marks CPR not on record, past the assistant 90-day deadline, as overdue', () => {
    const c = getCategoryStatus({
      category: CATEGORY.CPR_FIRST_AID,
      requirement: { category: CATEGORY.CPR_FIRST_AID, cadence: 'within_90_days', requiredHours: null },
      records: [],
      caregiver: { date_of_hire: '2025-01-01' },
      today: TODAY,
    })
    expect(c.status).toBe(CELL_STATUS.OVERDUE)
  })

  it('marks an expired CPR record as expired', () => {
    const c = getCategoryStatus({
      category: CATEGORY.CPR_FIRST_AID,
      requirement: { category: CATEGORY.CPR_FIRST_AID, cadence: 'before_care', requiredHours: null },
      records: [rec({ category: CATEGORY.CPR_FIRST_AID, expires_on: '2026-03-02' })],
      caregiver: { date_of_hire: '2025-01-01' },
      today: TODAY,
    })
    expect(c.status).toBe(CELL_STATUS.EXPIRED)
  })

  it('treats an expired MiRegistry membership status as overdue', () => {
    const c = getCategoryStatus({
      category: CATEGORY.MIREGISTRY_ACCOUNT,
      requirement: { category: CATEGORY.MIREGISTRY_ACCOUNT, cadence: 'within_30_days', requiredHours: null },
      records: [rec({ category: CATEGORY.MIREGISTRY_ACCOUNT, miregistry_status: 'expired' })],
      caregiver: { date_of_hire: '2026-01-01' },
      today: TODAY,
    })
    expect(c.status).toBe(CELL_STATUS.OVERDUE)
  })

  it('treats an eligible background check as ok', () => {
    const c = getCategoryStatus({
      category: CATEGORY.BACKGROUND_CHECK,
      requirement: { category: CATEGORY.BACKGROUND_CHECK, cadence: 'before_care', requiredHours: null },
      records: [rec({ category: CATEGORY.BACKGROUND_CHECK, background_check_status: 'eligible' })],
      caregiver: { date_of_hire: '2026-01-01' },
      today: TODAY,
    })
    expect(c.status).toBe(CELL_STATUS.OK)
  })
})

describe('getStaffComplianceMatrix', () => {
  const catalog = [
    requirement(CATEGORY.CPR_FIRST_AID, REGULATORY_ROLE.LICENSEE, { cadence: 'before_care' }),
    requirement(CATEGORY.PROFESSIONAL_DEVELOPMENT, REGULATORY_ROLE.LICENSEE, {
      cadence: 'per_calendar_year', required_hours: 10,
    }),
  ]
  const roster = [
    {
      id: 'cg-1',
      full_name: 'Venessa L.',
      date_of_hire: '2024-06-01',
      regulatory_roles: [{ regulatory_role: REGULATORY_ROLE.LICENSEE }],
    },
  ]

  it('builds one row per caregiver with a cell per required category', () => {
    const m = getStaffComplianceMatrix({ roster, records: [], requirements: catalog, today: TODAY })
    expect(m.rows).toHaveLength(1)
    expect(m.categories).toContain(CATEGORY.CPR_FIRST_AID)
    expect(m.categories).toContain(CATEGORY.PROFESSIONAL_DEVELOPMENT)
  })

  it('surfaces missing/overdue cells on the attention list', () => {
    const m = getStaffComplianceMatrix({ roster, records: [], requirements: catalog, today: TODAY })
    expect(m.attentionItems.length).toBeGreaterThan(0)
    expect(m.rows[0].rollup).not.toBe(CELL_STATUS.OK)
  })

  it('rolls a fully-satisfied caregiver up to ok', () => {
    const records = [
      rec({ caregiver_id: 'cg-1', category: CATEGORY.CPR_FIRST_AID, expires_on: '2027-12-01' }),
      rec({ caregiver_id: 'cg-1', category: CATEGORY.PROFESSIONAL_DEVELOPMENT, completed_on: '2026-02-01', hours: 10 }),
    ]
    const m = getStaffComplianceMatrix({ roster, records, requirements: catalog, today: TODAY })
    expect(m.rows[0].rollup).toBe(CELL_STATUS.OK)
    expect(m.attentionItems).toHaveLength(0)
  })
})

describe('getExpiringSoon', () => {
  const roster = [{ id: 'cg-1', full_name: 'Maria R.' }]

  it('lists expired and expiring-soon dated records, soonest first', () => {
    const records = [
      rec({ caregiver_id: 'cg-1', expires_on: '2026-06-18' }),  // expiring soon
      rec({ caregiver_id: 'cg-1', expires_on: '2026-03-02' }),  // expired
      rec({ caregiver_id: 'cg-1', expires_on: '2027-12-01' }),  // valid — excluded
      rec({ caregiver_id: 'cg-1', expires_on: null }),          // no expiry — excluded
    ]
    const list = getExpiringSoon({ records, roster, today: TODAY })
    expect(list).toHaveLength(2)
    expect(list[0].expiresOn).toBe('2026-03-02')
    expect(list[0].caregiverName).toBe('Maria R.')
  })

  it('excludes archived records', () => {
    const records = [
      rec({ caregiver_id: 'cg-1', expires_on: '2026-03-02', archived_at: '2026-04-01T00:00:00Z' }),
    ]
    expect(getExpiringSoon({ records, roster, today: TODAY })).toHaveLength(0)
  })
})
