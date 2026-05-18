// Narrow-width (≤ 640px) equivalent of one PayPeriodTable row. The
// CdcPayPeriodsPage renders a vertical list of these instead of the
// 4-column table on phones — no horizontal scrolling of a data table
// (spec § 3.3). The desktop table is PayPeriodTable.jsx.

import { getPeriodDisplayStatus, PERIOD_STATUS } from '@/lib/cdcPayPeriods'
import { formatRangeShort, formatShortMaybeYear } from './payPeriodFormat'

export default function PayPeriodCard({ period, today, isCurrent = false }) {
  if (!period) return null

  const status = getPeriodDisplayStatus(period, today)
  const isClosed = status === PERIOD_STATUS.BILLING_CLOSED
  const isBillable = status === PERIOD_STATUS.OPEN_FOR_BILLING

  return (
    <div
      style={{
        ...cardStyle,
        ...(isCurrent ? currentCardStyle : {}),
        ...(isClosed ? closedCardStyle : {}),
      }}
      aria-current={isCurrent ? 'true' : undefined}
    >
      <div style={topRowStyle}>
        <span style={numStyle}>
          Period {period.period_number}
        </span>
        <span style={rangeStyle}>
          {formatRangeShort(period.start_date, period.end_date)}
        </span>
      </div>

      {(isCurrent || isBillable) && (
        <div>
          <span style={isCurrent ? badgeCurrentStyle : badgeBillableStyle}>
            {isCurrent ? 'Current' : 'Still billable'}
          </span>
        </div>
      )}

      <dl style={detailListStyle}>
        <div style={detailRowStyle}>
          <dt style={dtStyle}>Report by</dt>
          <dd style={ddStyle}>
            {formatShortMaybeYear(period.reporting_deadline, period.schedule_year)}
            {period.deadline_is_4pm && <span style={markerStyle}> *</span>}
          </dd>
        </div>
        <div style={detailRowStyle}>
          <dt style={dtStyle}>Est. payment</dt>
          <dd style={ddStyle}>
            {formatShortMaybeYear(period.expected_payment_date, period.schedule_year)}
            {period.payment_may_be_delayed && <span style={markerStyle}> ⚠</span>}
          </dd>
        </div>
      </dl>
    </div>
  )
}

// ─── Inline styles ─────────────────────────────────────────────────

const cardStyle = {
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-md)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: 'white',
  color: 'var(--clr-ink)',
}

const currentCardStyle = {
  background: 'var(--clr-cream)',
  borderColor: 'var(--clr-sage)',
  boxShadow: 'inset 3px 0 0 var(--clr-sage)',
}

const closedCardStyle = {
  color: 'var(--clr-ink-soft)',
}

const topRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 8,
  flexWrap: 'wrap',
}

const numStyle = {
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
}

const rangeStyle = {
  fontSize: '0.9375rem',
}

const detailListStyle = {
  display: 'flex',
  gap: 24,
  margin: 0,
}

const detailRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
}

const dtStyle = {
  fontSize: '0.6875rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--clr-ink-soft)',
  fontWeight: 600,
}

const ddStyle = {
  margin: 0,
  fontSize: '0.875rem',
  fontVariantNumeric: 'tabular-nums',
}

const markerStyle = {
  color: 'var(--clr-ink-soft)',
  fontWeight: 600,
}

const badgeBase = {
  display: 'inline-block',
  padding: '1px 7px',
  borderRadius: 'var(--radius-full)',
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const badgeCurrentStyle = {
  ...badgeBase,
  background: 'var(--clr-sage)',
  color: 'white',
}

const badgeBillableStyle = {
  ...badgeBase,
  background: 'var(--clr-sage-pale)',
  color: 'var(--clr-sage-dark)',
}
