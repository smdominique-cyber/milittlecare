// Desktop schedule table for the CDC Pay Periods page. Renders one
// row per pay period for a single schedule year. The current period
// is highlighted; past (billing-closed) periods are muted; periods
// that have ended but are still inside their reporting window get a
// "Still billable" marker — the state a provider most needs to catch
// (spec § 3.2).
//
// The narrow-width equivalent is PayPeriodCard.jsx; CdcPayPeriodsPage
// chooses between them by viewport width (spec § 3.3).

import { Info } from 'lucide-react'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { getPeriodDisplayStatus, PERIOD_STATUS } from '@/lib/cdcPayPeriods'
import { formatRangeShort, formatShortMaybeYear } from './payPeriodFormat'

// Inline help — § 3.5 requires a tooltip on "Report by" and on
// "Est. payment". On the narrow-width card layout these are covered
// by the comprehensive page-header help (see CdcPayPeriodsPage).
export const DEADLINE_HELP =
  'The date MDHHS must receive your billing in I-Billing for this ' +
  'period. Billing has to be submitted within 90 days of the care — ' +
  'after that the period’s payment is permanently lost. A deadline ' +
  'marked * closes at 4:00 PM that day; the rest close at midnight.'

export const PAYMENT_HELP =
  'The estimated check or EFT date, assuming you bill on time. A ⚠ ' +
  'marks a payment that may be delayed by a holiday — treat that ' +
  'date as approximate.'

export default function PayPeriodTable({ periods = [], today, currentPeriodNumber }) {
  return (
    <table style={tableStyle}>
      <caption style={visuallyHidden}>
        CDC pay period schedule. The current pay period is marked.
      </caption>
      <thead>
        <tr>
          <th scope="col" style={{ ...thStyle, textAlign: 'center', width: 56 }}>#</th>
          <th scope="col" style={thStyle}>Pay period dates</th>
          <th scope="col" style={thStyle}>
            <span style={thLabelStyle}>
              Report by
              <HelpTooltip text={DEADLINE_HELP} label="What “Report by” means">
                <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
              </HelpTooltip>
            </span>
          </th>
          <th scope="col" style={thStyle}>
            <span style={thLabelStyle}>
              Est. payment
              <HelpTooltip text={PAYMENT_HELP} label="What “Est. payment” means">
                <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
              </HelpTooltip>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        {periods.map((p) => {
          const status = getPeriodDisplayStatus(p, today)
          const isCurrent = p.period_number === currentPeriodNumber
          const isClosed = status === PERIOD_STATUS.BILLING_CLOSED
          const isBillable = status === PERIOD_STATUS.OPEN_FOR_BILLING

          return (
            <tr
              key={p.id ?? p.period_number}
              style={{
                ...rowStyle,
                ...(isCurrent ? currentRowStyle : {}),
                ...(isClosed ? closedRowStyle : {}),
              }}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <td style={{ ...tdStyle, ...numCellStyle }}>
                {isCurrent && <span aria-hidden="true" style={currentDotStyle} />}
                {p.period_number}
              </td>
              <td style={tdStyle}>
                {formatRangeShort(p.start_date, p.end_date)}
                {isCurrent && <span style={inlineBadgeCurrentStyle}>Current</span>}
                {isBillable && <span style={inlineBadgeBillableStyle}>Still billable</span>}
              </td>
              <td style={tdStyle}>
                {formatShortMaybeYear(p.reporting_deadline, p.schedule_year)}
                {p.deadline_is_4pm && <span style={markerStyle} title="Deadline is 4:00 PM"> *</span>}
              </td>
              <td style={tdStyle}>
                {formatShortMaybeYear(p.expected_payment_date, p.schedule_year)}
                {p.payment_may_be_delayed && (
                  <span style={markerStyle} title="Payment may be delayed by a holiday"> ⚠</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Inline styles ─────────────────────────────────────────────────

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
}

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '2px solid var(--clr-warm-mid)',
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--clr-ink-soft)',
  fontWeight: 600,
}

const thLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
}

const rowStyle = {
  borderBottom: '1px solid var(--clr-warm-mid)',
  color: 'var(--clr-ink)',
}

const currentRowStyle = {
  background: 'var(--clr-cream)',
  fontWeight: 600,
  boxShadow: 'inset 3px 0 0 var(--clr-sage)',
}

const closedRowStyle = {
  color: 'var(--clr-ink-soft)',
}

const tdStyle = {
  padding: '8px 12px',
  verticalAlign: 'top',
}

const numCellStyle = {
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const currentDotStyle = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--clr-sage-dark)',
  marginRight: 6,
  verticalAlign: 'middle',
}

const markerStyle = {
  color: 'var(--clr-ink-soft)',
  fontWeight: 600,
}

const inlineBadgeBase = {
  display: 'inline-block',
  marginLeft: 8,
  padding: '1px 7px',
  borderRadius: 'var(--radius-full)',
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  verticalAlign: 'middle',
}

const inlineBadgeCurrentStyle = {
  ...inlineBadgeBase,
  background: 'var(--clr-sage)',
  color: 'white',
}

const inlineBadgeBillableStyle = {
  ...inlineBadgeBase,
  background: 'var(--clr-sage-pale)',
  color: 'var(--clr-sage-dark)',
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
