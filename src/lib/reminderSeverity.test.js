import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SEVERITY_THRESHOLDS,
  SEVERITIES,
  getSeverity,
  getSeverityForDueDate,
} from './reminderSeverity'

// ─── getSeverity — default ladder ─────────────────────────────────────

describe('getSeverity with default thresholds', () => {
  it('returns null when > 45 days out (no banner)', () => {
    expect(getSeverity(60)).toBeNull()
    expect(getSeverity(46)).toBeNull()
  })

  it('returns "info" at 31-45 days', () => {
    expect(getSeverity(45)).toBe('info')
    expect(getSeverity(40)).toBe('info')
    expect(getSeverity(31)).toBe('info')
  })

  it('returns "warning" at 16-30 days', () => {
    expect(getSeverity(30)).toBe('warning')
    expect(getSeverity(20)).toBe('warning')
    expect(getSeverity(16)).toBe('warning')
  })

  it('returns "urgent" at 7-15 days', () => {
    expect(getSeverity(15)).toBe('urgent')
    expect(getSeverity(10)).toBe('urgent')
    expect(getSeverity(7)).toBe('urgent')
  })

  it('returns "critical" at 0-6 days', () => {
    expect(getSeverity(6)).toBe('critical')
    expect(getSeverity(3)).toBe('critical')
    expect(getSeverity(0)).toBe('critical')
  })

  it('returns "expired" when negative', () => {
    expect(getSeverity(-1)).toBe('expired')
    expect(getSeverity(-30)).toBe('expired')
  })
})

// ─── getSeverity — custom thresholds ──────────────────────────────────

describe('getSeverity with custom thresholds', () => {
  // A tighter ladder for a category that wants urgency earlier.
  const tight = { info: 14, warning: 7, urgent: 3, critical: 0 }

  it('respects a tighter info window', () => {
    expect(getSeverity(20, tight)).toBeNull()
    expect(getSeverity(14, tight)).toBe('info')
    expect(getSeverity(8, tight)).toBe('info')
    expect(getSeverity(7, tight)).toBe('warning')
    expect(getSeverity(4, tight)).toBe('warning')
    expect(getSeverity(3, tight)).toBe('urgent')
    expect(getSeverity(1, tight)).toBe('urgent')
    expect(getSeverity(0, tight)).toBe('critical')
    expect(getSeverity(-1, tight)).toBe('expired')
  })

  it('partial override merges with defaults', () => {
    // Override only `info`; warning/urgent/critical stay at defaults.
    const partial = { info: 60 }
    expect(getSeverity(60, partial)).toBe('info')   // would be null under defaults
    expect(getSeverity(30, partial)).toBe('warning') // unchanged default behavior
  })
})

// ─── getSeverity — defensive ──────────────────────────────────────────

describe('getSeverity defensive', () => {
  it('returns null for non-finite input', () => {
    expect(getSeverity(NaN)).toBeNull()
    expect(getSeverity(Infinity)).toBeNull()
    expect(getSeverity(undefined)).toBeNull()
    expect(getSeverity(null)).toBeNull()
    expect(getSeverity('30')).toBeNull()
  })
})

// ─── getSeverityForDueDate ────────────────────────────────────────────

describe('getSeverityForDueDate', () => {
  it('computes severity from a due date and today', () => {
    // 20 days out → warning under defaults.
    expect(getSeverityForDueDate('2026-06-17', undefined, '2026-05-28'))
      .toBe('warning')
  })

  it('honors custom thresholds', () => {
    // 20 days out, but tight ladder caps info at 14 → null (no banner).
    expect(getSeverityForDueDate(
      '2026-06-17',
      { info: 14, warning: 7, urgent: 3, critical: 0 },
      '2026-05-28',
    )).toBeNull()
  })

  it('returns "expired" when due is in the past', () => {
    expect(getSeverityForDueDate('2026-05-01', undefined, '2026-05-28'))
      .toBe('expired')
  })

  it('returns null for missing dueAt', () => {
    expect(getSeverityForDueDate(null, undefined, '2026-05-28')).toBeNull()
    expect(getSeverityForDueDate('', undefined, '2026-05-28')).toBeNull()
  })
})

// ─── Exports surface ──────────────────────────────────────────────────

describe('exports', () => {
  it('DEFAULT_SEVERITY_THRESHOLDS uses the cdcProviderCompliance TRAINING_LADDER values', () => {
    expect(DEFAULT_SEVERITY_THRESHOLDS).toEqual({
      info: 45,
      warning: 30,
      urgent: 15,
      critical: 6,
    })
  })

  it('SEVERITIES enumerates the five rungs in escalation order', () => {
    expect(SEVERITIES).toEqual(['info', 'warning', 'urgent', 'critical', 'expired'])
  })
})
