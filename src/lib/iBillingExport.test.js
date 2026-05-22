import { describe, it, expect } from 'vitest'
import { buildCsv, CSV_COLUMNS } from './iBillingExport'
import { RULE } from './iBilling'

const TODAY = '2026-05-20'
const GENERATED = '2026-05-20T12:34:56.000Z'

const payPeriod = (overrides = {}) => ({
  period_number: 611,
  start_date: '2026-05-03',
  end_date: '2026-05-16',
  ...overrides,
})

const child = (overrides = {}) => ({
  id: 'child-1',
  first_name: 'Mia',
  last_name: 'Reeves',
  school_enrolled: false,
  ...overrides,
})

const cdc = (overrides = {}) => ({
  id: 'fs-1',
  type: 'cdc_scholarship',
  status: 'active',
  child_id: 'child-1',
  archived_at: null,
  authorization_start: '2026-04-01',
  authorization_end: '2026-09-30',
  case_number: '4471902',
  details: {},
  ...overrides,
})

const row = (overrides = {}) => ({
  id: `att-${Math.random().toString(36).slice(2)}`,
  child_id: 'child-1',
  date: '2026-05-04',
  segment_index: 0,
  status: 'present',
  check_in: '07:30',
  check_out: '17:30',
  ...overrides,
})

// -----------------------------------------------------------------------------

describe('CSV_COLUMNS', () => {
  it('matches the 15-column order from spec § Screen 4 Format 3', () => {
    expect(CSV_COLUMNS).toEqual([
      'child_id',
      'child_full_name',
      'case_number',
      'pay_period_number',
      'date',
      'day_of_week',
      'segment_in_time',
      'segment_out_time',
      'segment_duration_hours',
      'absent_flag',
      'would_have_been_in',
      'would_have_been_out',
      'would_have_been_duration',
      'validation_flags',
      'generated_at',
    ])
  })
})

describe('buildCsv — header row', () => {
  it('starts with the column header', () => {
    const out = buildCsv({ payPeriod: payPeriod(), attendance: [], children: [], fundingSources: [], generatedAt: GENERATED })
    expect(out.split('\n')[0]).toBe(CSV_COLUMNS.join(','))
  })
})

describe('buildCsv — present-segment row shape', () => {
  it('renders a normal segment with name, case number, duration, false absent_flag', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const [, dataRow] = out.split('\n')
    const cells = dataRow.split(',')
    expect(cells[0]).toBe('child-1')
    expect(cells[1]).toBe('Mia Reeves')
    expect(cells[2]).toBe('4471902')
    expect(cells[3]).toBe('611')
    expect(cells[4]).toBe('2026-05-04')
    expect(cells[5]).toBe('Monday')
    expect(cells[6]).toBe('07:30')
    expect(cells[7]).toBe('17:30')
    expect(cells[8]).toBe('10.00')
    expect(cells[9]).toBe('false')
    expect(cells[10]).toBe('')   // would_have_been_in
    expect(cells[11]).toBe('')
    expect(cells[12]).toBe('')
    expect(cells[14]).toBe(GENERATED)
  })

  it('reads case_number from the typed column', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child()],
      fundingSources: [cdc({ case_number: 'TYPED-1' })],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1].split(',')[2]).toBe('TYPED-1')
  })

  it('falls back to details.case_number when the typed column is null', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child()],
      fundingSources: [cdc({ case_number: null, details: { case_number: 'LEGACY-2' } })],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1].split(',')[2]).toBe('LEGACY-2')
  })
})

describe('buildCsv — absent rows', () => {
  it('renders absent_flag = true and blanks for times / duration', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row({ status: 'absent', check_in: null, check_out: null })],
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const cells = out.split('\n')[1].split(',')
    expect(cells[6]).toBe('')         // segment_in_time
    expect(cells[7]).toBe('')         // segment_out_time
    expect(cells[8]).toBe('')         // segment_duration_hours
    expect(cells[9]).toBe('true')     // absent_flag
  })
})

describe('buildCsv — multi-segment days', () => {
  it('emits one row per segment, sorted by segment_index ascending', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [
        row({ id: 'pm', segment_index: 1, check_in: '14:30', check_out: '17:30' }),
        row({ id: 'am', segment_index: 0, check_in: '07:00', check_out: '08:15' }),
      ],
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)  // header + 2 segments
    expect(lines[1].split(',')[6]).toBe('07:00')  // AM segment first
    expect(lines[2].split(',')[6]).toBe('14:30')
  })
})

describe('buildCsv — sorting', () => {
  it('sorts rows by child name then date then segment_index', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [
        row({ id: 'r1', child_id: 'cid-b', date: '2026-05-05' }),
        row({ id: 'r2', child_id: 'cid-a', date: '2026-05-06' }),
        row({ id: 'r3', child_id: 'cid-a', date: '2026-05-05' }),
      ],
      children: [
        { id: 'cid-a', first_name: 'Alma', last_name: 'Ng' },
        { id: 'cid-b', first_name: 'Bryce', last_name: 'Ng' },
      ],
      fundingSources: [
        cdc({ id: 'fs-a', child_id: 'cid-a' }),
        cdc({ id: 'fs-b', child_id: 'cid-b' }),
      ],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const dataRows = out.split('\n').slice(1)
    expect(dataRows[0].split(',')[1]).toBe('Alma Ng')
    expect(dataRows[0].split(',')[4]).toBe('2026-05-05')
    expect(dataRows[1].split(',')[1]).toBe('Alma Ng')
    expect(dataRows[1].split(',')[4]).toBe('2026-05-06')
    expect(dataRows[2].split(',')[1]).toBe('Bryce Ng')
  })
})

describe('buildCsv — validation_flags', () => {
  it('joins segment-level rule IDs with semicolons', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row({ id: 'r1', check_in: '21:00', check_out: '05:00' })],  // Rule 7 fires
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const cells = out.split('\n')[1].split(',')
    // Flags cell may be wrapped in quotes if it contains a semicolon-
    // separated list — RFC-4180 only requires escaping for commas/quotes/
    // newlines. csvEscape here leaves semicolons bare.
    expect(cells[13]).toContain(RULE.OVERNIGHT_NOT_SPLIT_AT_MIDNIGHT)
  })

  it('accepts a pre-computed issues array instead of running validation', () => {
    const issues = [{
      ruleId: 'rule_custom_flag',
      severity: 'warning',
      childId: 'child-1',
      date: '2026-05-04',
      segmentIndex: 0,
    }]
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child()],
      fundingSources: [cdc()],
      issues,
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1].split(',')[13]).toBe('rule_custom_flag')
  })

  it('attaches child-level (date-null) issues to every row for that child', () => {
    const issues = [{
      ruleId: RULE.BILLING_WITHOUT_ACTIVE_CDC,
      severity: 'blocking',
      childId: 'child-1',
      date: null,
      segmentIndex: null,
    }]
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [
        row({ id: 'r1', date: '2026-05-04' }),
        row({ id: 'r2', date: '2026-05-05' }),
      ],
      children: [child()],
      fundingSources: [],
      issues,
      generatedAt: GENERATED,
    })
    const dataRows = out.split('\n').slice(1)
    expect(dataRows[0].split(',')[13]).toContain(RULE.BILLING_WITHOUT_ACTIVE_CDC)
    expect(dataRows[1].split(',')[13]).toContain(RULE.BILLING_WITHOUT_ACTIVE_CDC)
  })
})

describe('buildCsv — CSV escaping', () => {
  it('wraps cells containing commas in quotes', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child({ last_name: 'Reeves, Jr.' })],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    const cells = out.split('\n')[1]
    expect(cells).toContain('"Mia Reeves, Jr."')
  })

  it('escapes embedded quotes by doubling them', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row()],
      children: [child({ last_name: 'Reeves "Mimi"' })],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1]).toContain('"Mia Reeves ""Mimi"""')
  })
})

describe('buildCsv — empty attendance', () => {
  it('returns header-only when there are no attendance rows', () => {
    const out = buildCsv({ payPeriod: payPeriod(), attendance: [], children: [], fundingSources: [], generatedAt: GENERATED })
    expect(out).toBe(CSV_COLUMNS.join(','))
  })
})

describe('buildCsv — day_of_week', () => {
  it('renders Sunday correctly (avoids UTC/local timezone surprises)', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row({ date: '2026-05-03' })],  // Sunday
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1].split(',')[5]).toBe('Sunday')
  })

  it('renders Saturday correctly', () => {
    const out = buildCsv({
      payPeriod: payPeriod(),
      attendance: [row({ date: '2026-05-09' })],  // Saturday
      children: [child()],
      fundingSources: [cdc()],
      profile: { full_name: 'Venessa' },
      generatedAt: GENERATED,
    })
    expect(out.split('\n')[1].split(',')[5]).toBe('Saturday')
  })
})
