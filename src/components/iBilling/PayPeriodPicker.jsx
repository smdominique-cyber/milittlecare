// I-Billing Screen 1 — Pay Period Picker (PR #9).
//
// Lists the candidate pay periods a provider can transfer right now and
// surfaces the one MDHHS is currently inviting them to submit (status
// = 'open_for_billing'). The picker only shows periods that overlap any
// CDC funding source the provider has — no point picking a period with
// nothing billable.
//
// Inputs are fetched by the IBillingPage orchestrator and passed in,
// keeping this component pure-render and easy to test alongside
// src/lib/cdcPayPeriods.js.

import { useMemo } from 'react'
import { Calendar, AlertCircle, ChevronRight } from 'lucide-react'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { PERIOD_STATUS } from '@/lib/cdcPayPeriods'
import { buildPickerCandidates } from '@/lib/iBillingPicker'

// -----------------------------------------------------------------------------
// Status badge copy
// -----------------------------------------------------------------------------

const STATUS_LABEL = {
  [PERIOD_STATUS.UPCOMING]:         'Upcoming',
  [PERIOD_STATUS.CURRENT]:          'Currently providing care',
  [PERIOD_STATUS.OPEN_FOR_BILLING]: 'Open for billing',
  [PERIOD_STATUS.BILLING_CLOSED]:   'Past 90-day window',
}

const STATUS_TONE = {
  [PERIOD_STATUS.UPCOMING]:         'neutral',
  [PERIOD_STATUS.CURRENT]:          'info',
  [PERIOD_STATUS.OPEN_FOR_BILLING]: 'good',
  [PERIOD_STATUS.BILLING_CLOSED]:   'bad',
}

const TONE_COLOR = {
  neutral: '#6b7280',
  info:    '#0f766e',
  good:    '#15803d',
  bad:     '#b91c1c',
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatPeriodLabel(p) {
  if (!p) return ''
  return `Period ${p.period_number} • ${p.start_date} → ${p.end_date}`
}

function formatCountdown(days) {
  if (days == null) return ''
  if (days > 1) return `${days} days until deadline`
  if (days === 1) return '1 day until deadline'
  if (days === 0) return 'deadline today'
  if (days === -1) return '1 day past deadline'
  return `${Math.abs(days)} days past deadline`
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Props:
 *   catalog          — pay period catalog rows (statewide, all years).
 *   fundingSources   — this provider's funding_sources rows.
 *   today            — 'YYYY-MM-DD' (test-injectable).
 *   onSelectPeriod   — (periodCatalogRow) => void
 *   loading          — boolean; show skeleton while parents load.
 *   error            — string | null
 *   alreadySubmittedNumbers — Set<string> of period_number values
 *                             already reconciled (Screen 5 wrote them).
 *                             Rendered as a "submitted" badge.
 */
export default function PayPeriodPicker({
  catalog,
  fundingSources,
  today,
  onSelectPeriod,
  loading,
  error,
  alreadySubmittedNumbers,
}) {
  const submittedSet = alreadySubmittedNumbers || new Set()

  // Candidate set: see src/lib/iBillingPicker.js for the logic.
  const candidates = useMemo(
    () => buildPickerCandidates({ catalog, fundingSources, today }),
    [catalog, fundingSources, today]
  )

  if (loading) {
    return (
      <div role="status" aria-live="polite" style={skeletonStyle}>
        Loading pay period catalog…
      </div>
    )
  }
  if (error) {
    return (
      <div role="alert" style={errorStyle}>
        <AlertCircle size={18} aria-hidden /> {error}
      </div>
    )
  }
  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        <p style={{ margin: 0 }}>
          <strong>No pay periods are currently billable.</strong>
        </p>
        <p style={{ margin: '8px 0 0 0', color: '#4b5563' }}>
          A pay period appears here when at least one child on your
          roster has an active CDC scholarship covering that period AND
          the period is current or within the 90-day submission window.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ fontSize: 20, margin: '0 0 4px 0' }}>
        Pick a pay period to transfer{' '}
        <HelpTooltip
          label="What is I-Billing transfer?"
          text="MDHHS pays CDC scholarships in 14-day pay periods (26 per year). After each period closes you have 90 days to submit your hours through I-Billing. This tool prepares the export and reconciles the confirmation number once you've keyed it into the MDHHS portal."
        >
          <span aria-hidden style={{
            display: 'inline-block', width: 18, height: 18, borderRadius: 9,
            background: '#e5e7eb', color: '#374151', textAlign: 'center',
            lineHeight: '18px', fontSize: 12, marginLeft: 4, cursor: 'help',
          }}>?</span>
        </HelpTooltip>
      </h2>
      <p style={{ margin: '0 0 16px 0', color: '#4b5563' }}>
        Choose the period whose attendance you want to review and
        submit. Periods marked <em>Open for billing</em> are inside
        their 90-day window.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {candidates.map(({ period, status, countdown }) => {
          const isSubmitted = submittedSet.has(String(period.period_number))
          const isClosed = status === PERIOD_STATUS.BILLING_CLOSED
          const disabled = isClosed
          return (
            <li key={period.id || period.period_number} style={cardStyle(disabled)}>
              <button
                type="button"
                onClick={() => !disabled && onSelectPeriod?.(period)}
                disabled={disabled}
                aria-label={`Select ${formatPeriodLabel(period)}`}
                style={cardButtonStyle(disabled)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
                  <Calendar size={20} aria-hidden style={{ color: '#6b7280' }} />
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600, color: '#111' }}>
                      {formatPeriodLabel(period)}
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 4 }}>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: TONE_COLOR[STATUS_TONE[status]],
                        }}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>
                        Reporting deadline {period.reporting_deadline}
                        {' · '}{formatCountdown(countdown)}
                      </span>
                      {isSubmitted && (
                        <span style={submittedBadgeStyle}>Already submitted</span>
                      )}
                    </div>
                  </div>
                </div>
                {!disabled && <ChevronRight size={20} aria-hidden style={{ color: '#6b7280' }} />}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Inline styles — kept here rather than CSS so the picker is a self-
// contained component that's easy to drop on a page during V1.
// -----------------------------------------------------------------------------

const skeletonStyle = {
  padding: 24,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  color: '#4b5563',
}

const errorStyle = {
  padding: 16,
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: 8,
  color: '#7f1d1d',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const emptyStyle = {
  padding: 24,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
}

const cardStyle = (disabled) => ({
  marginBottom: 8,
  background: disabled ? '#f9fafb' : '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  overflow: 'hidden',
})

const cardButtonStyle = (disabled) => ({
  width: '100%',
  padding: 16,
  background: 'transparent',
  border: 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  opacity: disabled ? 0.6 : 1,
})

const submittedBadgeStyle = {
  background: '#dcfce7',
  color: '#166534',
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 8px',
  borderRadius: 12,
}
