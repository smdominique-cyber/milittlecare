// CDC Pay Periods page. Implements docs/cdc_pay_periods_spec.md § 3 —
// a read-only display of the MDHHS-published CDC Payment Schedule:
// two hero cards (current + next period) and the full 26-row schedule
// for the selected year.
//
// Read-only by design (spec § 4): no "mark submitted" / "mark paid".
// All state is derived from the statewide cdc_pay_period_catalog by
// the pure helpers in src/lib/cdcPayPeriods.js.
//
// Module gate (spec § 5): the page is for providers with the CDC
// module active. A provider without it who reaches the route directly
// is redirected to the dashboard — the sidebar entry never shows it
// to them in the first place.

import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { CalendarClock, Info, AlertCircle, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useActiveModules } from '@/hooks/useActiveModules'
import { MODULE_KEYS } from '@/lib/modules'
import HelpTooltip from '@/components/ui/HelpTooltip'
import {
  getCurrentPeriod,
  getNextPeriod,
  getDeadlineCountdown,
  todayYMD,
} from '@/lib/cdcPayPeriods'
import PayPeriodTable from '@/components/cdc/PayPeriodTable'
import PayPeriodCard from '@/components/cdc/PayPeriodCard'
import { formatRangeLong, formatWeekdayLong, formatLong } from '@/components/cdc/payPeriodFormat'

// -----------------------------------------------------------------------------
// Constants — copy
// -----------------------------------------------------------------------------

const MICHIGAN_CDC_URL =
  'https://www.michigan.gov/mileap/early-childhood-education/early-learners-and-care/cdc/providers'

const HEADER_HELP =
  'A CDC pay period is the 14-day window of care you bill to MDHHS ' +
  'through I-Billing — there are 26 a year. MILittleCare shows the ' +
  'schedule and counts down your deadlines for reference; you still ' +
  'submit your billing in I-Billing. Billing must be submitted within ' +
  '90 days of care, or that period’s payment is permanently lost.'

const FOOTER_NOTE =
  'This schedule is published by MDHHS. MILittleCare shows it for ' +
  'reference — you still submit your billing in I-Billing.'

const PAGE_FETCH_ERROR =
  'Couldn’t load the CDC pay period schedule. Refresh the page, or ' +
  'email support@milittlecare.com if it keeps happening.'

// -----------------------------------------------------------------------------
// Narrow-width detection (spec § 3.3 — table → card list below ~640px)
// -----------------------------------------------------------------------------

const NARROW_QUERY = '(max-width: 640px)'

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(NARROW_QUERY).matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mq = window.matchMedia(NARROW_QUERY)
    const handler = (e) => setNarrow(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return narrow
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Human-readable countdown to a reporting deadline.
function formatCountdown(days) {
  if (days == null) return ''
  if (days > 1) return `${days} days left`
  if (days === 1) return '1 day left'
  if (days === 0) return 'due today'
  if (days === -1) return '1 day ago'
  return `${Math.abs(days)} days ago`
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function CdcPayPeriodsPage() {
  const { user } = useAuth()
  const { modules, loading: modulesLoading } = useActiveModules()
  const isNarrow = useIsNarrow()

  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedYear, setSelectedYear] = useState(null)

  // "Today" is the device's local calendar date (spec § 7.6). Fixed
  // per page mount — providers don't leave this screen open overnight.
  const today = useMemo(() => todayYMD(), [])

  // -- Fetch the statewide catalog -----------------------------------------
  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data, error: e } = await supabase
          .from('cdc_pay_period_catalog')
          .select('*')
          .order('start_date', { ascending: true })
        if (e) throw e
        if (!cancelled) setCatalog(data || [])
      } catch (err) {
        console.error('CdcPayPeriodsPage: catalog fetch failed', err)
        if (!cancelled) setError(PAGE_FETCH_ERROR)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [user])

  // -- Derived state --------------------------------------------------------
  const currentPeriod = useMemo(() => getCurrentPeriod(today, catalog), [today, catalog])
  const nextPeriod = useMemo(() => getNextPeriod(today, catalog), [today, catalog])

  const years = useMemo(() => {
    const set = new Set(catalog.map((p) => p.schedule_year))
    return [...set].sort((a, b) => a - b)
  }, [catalog])

  // The last period MDHHS has published — used by the
  // schedule-not-published copy (spec § 3.4).
  const lastPeriod = useMemo(() => {
    if (catalog.length === 0) return null
    return catalog.reduce((a, b) => (a.start_date >= b.start_date ? a : b))
  }, [catalog])

  // Default year: the current period's schedule year, else this
  // calendar year if seeded, else the latest seeded year.
  const defaultYear = useMemo(() => {
    if (currentPeriod) return currentPeriod.schedule_year
    const calYear = new Date().getFullYear()
    if (years.includes(calYear)) return calYear
    return years.length ? years[years.length - 1] : calYear
  }, [currentPeriod, years])

  const resolvedYear = selectedYear ?? defaultYear

  const periodsForYear = useMemo(
    () =>
      catalog
        .filter((p) => p.schedule_year === resolvedYear)
        .sort((a, b) => a.period_number - b.period_number),
    [catalog, resolvedYear]
  )

  // -- Gates ----------------------------------------------------------------
  if (modulesLoading) {
    return (
      <div style={pageShellStyle}>
        <p style={mutedTextStyle}>Loading…</p>
      </div>
    )
  }

  // Not a CDC provider — the sidebar never showed this entry; a direct
  // navigation lands here and is bounced to the dashboard (spec § 5).
  //
  // Diverges from MiRegistryPage's render-anyway pattern: a non-CDC provider
  // landing here has no actionable empty state to view (the activation gate
  // is "have an active CDC funding source," not editable on this page), so
  // we redirect to the dashboard where they can navigate to something useful.
  if (!modules.has(MODULE_KEYS.CDC)) {
    return <Navigate to="/dashboard" replace />
  }

  if (error) {
    return (
      <div style={pageShellStyle}>
        <div role="alert" style={errorBannerStyle}>
          <AlertCircle size={14} style={{ marginRight: 6, flexShrink: 0 }} />
          {error}
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={pageShellStyle}>
        <p style={mutedTextStyle}>Loading the CDC pay period schedule…</p>
      </div>
    )
  }

  // -- Render ---------------------------------------------------------------
  return (
    <div style={pageShellStyle}>
      <div style={headerRowStyle}>
        <div style={titleGroupStyle}>
          <CalendarClock size={22} style={{ color: 'var(--clr-sage-dark)' }} />
          <h2 style={pageTitleStyle}>CDC Pay Periods</h2>
          <HelpTooltip text={HEADER_HELP} label="What the CDC Pay Periods page shows">
            <Info size={14} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        </div>
        {years.length > 0 && (
          <label style={yearSelectLabelStyle}>
            Year:
            <select
              value={resolvedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              style={yearSelectStyle}
            >
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Hero cards — current + next, derived across all schedule years */}
      <div style={heroRowStyle}>
        <CurrentPeriodCard period={currentPeriod} today={today} lastPeriod={lastPeriod} />
        <NextPeriodCard period={nextPeriod} />
      </div>

      {/* Full schedule for the selected year */}
      <section>
        <h3 style={sectionTitleStyle}>
          {resolvedYear} schedule
          {periodsForYear.length > 0 && ` — ${periodsForYear.length} pay periods`}
        </h3>

        {periodsForYear.length === 0 ? (
          <ScheduleNotPublishedCard year={resolvedYear} lastPeriod={lastPeriod} />
        ) : (
          <>
            {isNarrow ? (
              <div style={cardListStyle}>
                {periodsForYear.map((p) => (
                  <PayPeriodCard
                    key={p.id ?? p.period_number}
                    period={p}
                    today={today}
                    isCurrent={p.period_number === currentPeriod?.period_number}
                  />
                ))}
              </div>
            ) : (
              <div style={tableWrapStyle}>
                <PayPeriodTable
                  periods={periodsForYear}
                  today={today}
                  currentPeriodNumber={currentPeriod?.period_number}
                />
              </div>
            )}

            <p style={legendStyle}>
              <span><strong>⚠</strong> payment may be delayed by a holiday</span>
              <span><strong>*</strong> reporting deadline closes at 4:00 PM</span>
            </p>
          </>
        )}
      </section>

      <p style={footerNoteStyle}>
        <Info size={13} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-ink-soft)' }} />
        <span>{FOOTER_NOTE}</span>
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Hero cards
// -----------------------------------------------------------------------------

function CurrentPeriodCard({ period, today, lastPeriod }) {
  // No period contains today — between the last seeded period and the
  // next year's schedule being published (spec § 3.4 / § 7.4).
  if (!period) {
    return (
      <div style={heroCardStyle}>
        <div style={heroCardLabelStyle}>Current pay period</div>
        <div style={heroBigStyle}>No active pay period</div>
        <p style={heroEmptyTextStyle}>
          No pay period covers today’s date.{' '}
          {lastPeriod
            ? `The ${lastPeriod.schedule_year} schedule ended with period ` +
              `${lastPeriod.period_number} on ${formatLong(lastPeriod.end_date)}. `
            : ''}
          Check{' '}
          <a href={MICHIGAN_CDC_URL} target="_blank" rel="noopener noreferrer">
            Michigan.gov CDC Payment Schedule
          </a>{' '}
          for the latest.
        </p>
      </div>
    )
  }

  const countdown = getDeadlineCountdown(period, today)

  return (
    <div style={{ ...heroCardStyle, ...heroCardCurrentStyle }}>
      <div style={heroCardLabelStyle}>Current pay period</div>
      <div style={heroTopLineStyle}>
        <span style={heroBigStyle}>Period {period.period_number}</span>
        <span style={heroRangeStyle}>{formatRangeLong(period.start_date, period.end_date)}</span>
      </div>
      <div style={heroStatusStyle}>
        <span aria-hidden="true" style={heroDotStyle} />
        Open — care days in progress
      </div>
      <dl style={heroDlStyle}>
        <HeroDateRow
          label="Report by"
          value={formatWeekdayLong(period.reporting_deadline)}
          suffix={period.deadline_is_4pm ? ' (4:00 PM)' : ''}
          countdown={countdown}
        />
        <HeroDateRow
          label="Est. payment"
          value={formatWeekdayLong(period.expected_payment_date)}
          delayed={period.payment_may_be_delayed}
        />
      </dl>
    </div>
  )
}

function NextPeriodCard({ period }) {
  if (!period) {
    return (
      <div style={heroCardStyle}>
        <div style={heroCardLabelStyle}>Next pay period</div>
        <div style={heroBigStyle}>—</div>
        <p style={heroEmptyTextStyle}>
          No later pay period has been published yet.
        </p>
      </div>
    )
  }

  return (
    <div style={heroCardStyle}>
      <div style={heroCardLabelStyle}>Next pay period</div>
      <div style={heroTopLineStyle}>
        <span style={heroBigStyle}>Period {period.period_number}</span>
        <span style={heroRangeStyle}>{formatRangeLong(period.start_date, period.end_date)}</span>
      </div>
      <dl style={heroDlStyle}>
        <HeroDateRow
          label="Report by"
          value={formatWeekdayLong(period.reporting_deadline)}
          suffix={period.deadline_is_4pm ? ' (4:00 PM)' : ''}
        />
        <HeroDateRow
          label="Est. payment"
          value={formatWeekdayLong(period.expected_payment_date)}
          delayed={period.payment_may_be_delayed}
        />
      </dl>
    </div>
  )
}

function HeroDateRow({ label, value, suffix = '', countdown = null, delayed = false }) {
  return (
    <div style={heroRowItemStyle}>
      <dt style={heroDtStyle}>{label}</dt>
      <dd style={heroDdStyle}>
        {value}{suffix}
        {countdown != null && (
          <span style={heroCountdownStyle}>({formatCountdown(countdown)})</span>
        )}
        {delayed && (
          <span style={heroDelayStyle}>
            <AlertTriangle size={12} /> may be delayed by a holiday
          </span>
        )}
      </dd>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Schedule-not-published empty state (spec § 3.4, OQ8 copy)
// -----------------------------------------------------------------------------

function ScheduleNotPublishedCard({ year, lastPeriod }) {
  return (
    <div style={emptyCardStyle}>
      <AlertCircle size={18} style={{ color: 'var(--clr-ink-soft)', flexShrink: 0, marginTop: 2 }} />
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        MDHHS hasn’t published the {year} CDC pay period schedule yet.
        {lastPeriod
          ? ` The ${lastPeriod.schedule_year} schedule ended with period ` +
            `${lastPeriod.period_number} on ${formatLong(lastPeriod.end_date)}.`
          : ''}{' '}
        Check{' '}
        <a href={MICHIGAN_CDC_URL} target="_blank" rel="noopener noreferrer">
          Michigan.gov CDC Payment Schedule
        </a>{' '}
        for the latest. We add each new year’s schedule once MDHHS posts it.
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Inline styles (mirrors MiRegistryPage.jsx conventions)
// -----------------------------------------------------------------------------

const pageShellStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5)',
  padding: 'var(--space-5)',
  maxWidth: 960,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
}

const headerRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
}

const titleGroupStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const pageTitleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.5rem',
  color: 'var(--clr-ink)',
  margin: 0,
}

const yearSelectLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const yearSelectStyle = {
  padding: '0.375rem 0.625rem',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--clr-warm-mid)',
  background: 'white',
  fontSize: '0.875rem',
  color: 'var(--clr-ink)',
}

const heroRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 'var(--space-4)',
}

const heroCardStyle = {
  background: 'white',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const heroCardCurrentStyle = {
  borderColor: 'var(--clr-sage)',
  background: 'var(--clr-cream)',
}

const heroCardLabelStyle = {
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--clr-ink-soft)',
  fontWeight: 600,
}

const heroTopLineStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  flexWrap: 'wrap',
}

const heroBigStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.25rem',
  color: 'var(--clr-ink)',
}

const heroRangeStyle = {
  fontSize: '0.9375rem',
  color: 'var(--clr-ink-mid)',
}

const heroStatusStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.875rem',
  color: 'var(--clr-sage-dark)',
  fontWeight: 600,
}

const heroDotStyle = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--clr-sage-dark)',
}

const heroDlStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  margin: 0,
  marginTop: 2,
}

const heroRowItemStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 8,
}

const heroDtStyle = {
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
  minWidth: 96,
}

const heroDdStyle = {
  margin: 0,
  fontSize: '0.9375rem',
  color: 'var(--clr-ink)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const heroCountdownStyle = {
  color: 'var(--clr-ink-soft)',
  fontSize: '0.875rem',
}

const heroDelayStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--clr-warn-dark)',
  fontSize: '0.8125rem',
}

const heroEmptyTextStyle = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.55,
}

const sectionTitleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.0625rem',
  color: 'var(--clr-ink)',
  margin: '0 0 var(--space-3)',
}

const tableWrapStyle = {
  background: 'white',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-2)',
  overflow: 'hidden',
}

const cardListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const legendStyle = {
  display: 'flex',
  gap: 'var(--space-4)',
  flexWrap: 'wrap',
  margin: 'var(--space-3) 0 0',
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
}

const footerNoteStyle = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-start',
  margin: 0,
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.55,
}

const emptyCardStyle = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  background: 'white',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-4)',
  fontSize: '0.9375rem',
  color: 'var(--clr-ink-mid)',
}

const mutedTextStyle = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const errorBannerStyle = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
}
