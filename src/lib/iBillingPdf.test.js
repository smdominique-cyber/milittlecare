// Smoke tests for the PDF builders (PR #9, Screen 4 Formats 1 & 2).
//
// PDF output is binary — we can't pixel-test rendering in Vitest. The
// tests below confirm:
//   - The builders don't throw on the common input shapes.
//   - They return a jsPDF instance whose output buffer is non-empty.
//   - Page counts match expected (one per billable child + empty
//     state).
//   - Empty / partial inputs don't crash the builders.

import { describe, it, expect } from 'vitest'
import {
  buildTransferSheetPdf,
  buildOfficialTimeAndAttendancePdf,
  describePdfOutput,
} from './iBillingPdf'

const payPeriod = (overrides = {}) => ({
  period_number: 611,
  start_date: '2026-05-03',
  end_date: '2026-05-16',
  reporting_deadline: '2026-05-21',
  ...overrides,
})

const child = (overrides = {}) => ({
  id: 'child-1',
  first_name: 'Mia',
  last_name: 'Reeves',
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
  case_number: '866753452546',
  approved_hours_per_period: 30,
  family_contribution_amount: 10,
  details: {},
  ...overrides,
})

const seg = (overrides = {}) => ({
  id: `att-${Math.random().toString(36).slice(2)}`,
  child_id: 'child-1',
  date: '2026-05-05',
  segment_index: 0,
  status: 'present',
  check_in: '07:30',
  check_out: '17:30',
  ...overrides,
})

const profile = {
  id: 'provider-1',
  full_name: 'Venessa Smith',
  daycare_name: 'Venessa\'s Daycare',
  bridges_provider_id: '1234567',
}

const GENERATED = '2026-05-21T12:34:56.000Z'

// -----------------------------------------------------------------------------

describe('describePdfOutput', () => {
  it('reports one page per billable child', () => {
    const r = describePdfOutput({
      payPeriod: payPeriod(),
      attendance: [seg()],
      children: [child(), child({ id: 'child-2', first_name: 'Leo' })],
      fundingSources: [cdc(), cdc({ id: 'fs-2', child_id: 'child-2' })],
    })
    expect(r.childCount).toBe(2)
    expect(r.pageCount).toBe(2)
    expect(r.periodDayCount).toBe(14)
  })

  it('returns at least 1 page in the empty case for the placeholder', () => {
    const r = describePdfOutput({ payPeriod: payPeriod(), attendance: [], children: [], fundingSources: [] })
    expect(r.pageCount).toBe(1)
    expect(r.childCount).toBe(0)
  })

  it('excludes children with neither attendance nor a CDC funding source', () => {
    const r = describePdfOutput({
      payPeriod: payPeriod(),
      attendance: [],
      children: [child({ id: 'c-billable' }), child({ id: 'c-not-billable' })],
      fundingSources: [cdc({ id: 'fs-x', child_id: 'c-billable' })],
    })
    expect(r.childCount).toBe(1)
  })
})

describe('buildTransferSheetPdf', () => {
  it('produces a non-empty PDF for a child with attendance + CDC funding', () => {
    const doc = buildTransferSheetPdf({
      payPeriod: payPeriod(),
      attendance: [seg()],
      children: [child()],
      fundingSources: [cdc()],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc).toBeTruthy()
    const buf = doc.output('arraybuffer')
    expect(buf).toBeInstanceOf(ArrayBuffer)
    expect(buf.byteLength).toBeGreaterThan(1000)  // any real PDF
  })

  it('produces one page per billable child', () => {
    const doc = buildTransferSheetPdf({
      payPeriod: payPeriod(),
      attendance: [
        seg({ child_id: 'kid-a' }),
        seg({ child_id: 'kid-b', date: '2026-05-06' }),
      ],
      children: [
        { id: 'kid-a', first_name: 'A', last_name: 'A' },
        { id: 'kid-b', first_name: 'B', last_name: 'B' },
      ],
      fundingSources: [
        cdc({ id: 'fs-a', child_id: 'kid-a' }),
        cdc({ id: 'fs-b', child_id: 'kid-b' }),
      ],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(2)
  })

  it('produces an empty-state PDF when no children are billable', () => {
    const doc = buildTransferSheetPdf({
      payPeriod: payPeriod(),
      attendance: [],
      children: [],
      fundingSources: [],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('handles multi-segment days without throwing', () => {
    const doc = buildTransferSheetPdf({
      payPeriod: payPeriod(),
      attendance: [
        seg({ id: 'am', segment_index: 0, date: '2026-05-04', check_in: '07:00', check_out: '08:15' }),
        seg({ id: 'pm', segment_index: 1, date: '2026-05-04', check_in: '14:30', check_out: '17:30' }),
      ],
      children: [child()],
      fundingSources: [cdc()],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('handles absent records (no times) without throwing', () => {
    const doc = buildTransferSheetPdf({
      payPeriod: payPeriod(),
      attendance: [seg({ status: 'absent', check_in: null, check_out: null })],
      children: [child()],
      fundingSources: [cdc()],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('does not throw with no arguments (defensive)', () => {
    expect(() => buildTransferSheetPdf()).not.toThrow()
  })
})

describe('buildOfficialTimeAndAttendancePdf', () => {
  it('produces a non-empty landscape PDF for a child with attendance', () => {
    const doc = buildOfficialTimeAndAttendancePdf({
      payPeriod: payPeriod(),
      attendance: [seg()],
      children: [child()],
      fundingSources: [cdc()],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc).toBeTruthy()
    const buf = doc.output('arraybuffer')
    expect(buf.byteLength).toBeGreaterThan(1000)
    // Landscape orientation: width > height
    const w = doc.internal.pageSize.getWidth()
    const h = doc.internal.pageSize.getHeight()
    expect(w).toBeGreaterThan(h)
  })

  it('produces one page per billable child', () => {
    const doc = buildOfficialTimeAndAttendancePdf({
      payPeriod: payPeriod(),
      attendance: [
        seg({ child_id: 'kid-a' }),
        seg({ child_id: 'kid-b' }),
      ],
      children: [
        { id: 'kid-a', first_name: 'A', last_name: 'A' },
        { id: 'kid-b', first_name: 'B', last_name: 'B' },
      ],
      fundingSources: [
        cdc({ id: 'fs-a', child_id: 'kid-a' }),
        cdc({ id: 'fs-b', child_id: 'kid-b' }),
      ],
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(2)
  })

  it('handles a child with no CDC funding (still billable if attendance present)', () => {
    const doc = buildOfficialTimeAndAttendancePdf({
      payPeriod: payPeriod(),
      attendance: [seg()],
      children: [child()],
      fundingSources: [],   // no CDC row
      profile,
      generatedAt: GENERATED,
    })
    expect(doc.getNumberOfPages()).toBe(1)
  })

  it('does not throw with no arguments (defensive)', () => {
    expect(() => buildOfficialTimeAndAttendancePdf()).not.toThrow()
  })
})
