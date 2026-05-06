import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Clock, Calendar, DollarSign, AlertTriangle, ChevronDown, Info, CreditCard } from 'lucide-react'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Display config for payment methods (mirrors PAYMENT_METHODS_CONFIG in BusinessInfoPage)
const PAYMENT_METHOD_DISPLAY = {
  stripe: { label: 'Stripe (online card)', emoji: '💳', tracked: true,
            description: 'Pay invoices directly in this app — counts toward FSA & tax statements.' },
  venmo:  { label: 'Venmo',                emoji: '💚', tracked: false },
  zelle:  { label: 'Zelle',                emoji: '🏦', tracked: false },
  cash:   { label: 'Cash',                 emoji: '💵', tracked: false },
  check:  { label: 'Check',                emoji: '✉️', tracked: false },
}

function formatTime(t) {
  if (!t) return ''
  const [hh, mm] = t.split(':')
  const hour = parseInt(hh)
  const period = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return mm === '00' ? `${displayHour} ${period}` : `${displayHour}:${mm} ${period}`
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function shortDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function BusinessInfoSection({ providerId, providerName }) {
  const [hours, setHours] = useState([])
  const [closures, setClosures] = useState([])
  const [policies, setPolicies] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!providerId) return
    loadAll()
  }, [providerId])

  async function loadAll() {
    setLoading(true)
    const [h, c, p] = await Promise.all([
      supabase.from('business_hours').select('*').eq('user_id', providerId).order('day_of_week'),
      supabase.from('closures').select('*').eq('user_id', providerId),
      supabase.from('business_policies').select('*').eq('user_id', providerId).maybeSingle(),
    ])
    setHours(h.data || [])
    setClosures(c.data || [])
    setPolicies(p.data)
    setLoading(false)
  }

  // Normalize payment methods from new JSONB or fall back to legacy text[] array
  const paymentMethods = (() => {
    if (!policies) return []
    const result = []

    // New format: payment_methods JSONB { stripe: { enabled, details }, ... }
    if (policies.payment_methods && typeof policies.payment_methods === 'object' && Object.keys(policies.payment_methods).length > 0) {
      Object.entries(policies.payment_methods).forEach(([key, config]) => {
        if (config?.enabled && PAYMENT_METHOD_DISPLAY[key]) {
          result.push({
            key,
            ...PAYMENT_METHOD_DISPLAY[key],
            details: config.details || '',
          })
        }
      })
      return result
    }

    // Legacy fallback: payment_methods_accepted text[]
    if (Array.isArray(policies.payment_methods_accepted)) {
      policies.payment_methods_accepted.forEach(key => {
        if (PAYMENT_METHOD_DISPLAY[key]) {
          result.push({
            key,
            ...PAYMENT_METHOD_DISPLAY[key],
            details: '',
          })
        }
      })
    }
    return result
  })()

  // Don't show anything if provider hasn't set up any info
  const hasAnyInfo = hours.length > 0 || closures.length > 0 || policies?.emergency_procedures || policies?.payment_due_day || paymentMethods.length > 0

  if (loading || !hasAnyInfo) return null

  // Today's hours
  const today = new Date().getDay()
  const todayHours = hours.find(h => h.day_of_week === today)
  const todayLabel = todayHours
    ? todayHours.is_open
      ? `Open today ${formatTime(todayHours.open_time)}–${formatTime(todayHours.close_time)}`
      : 'Closed today'
    : null

  // Upcoming closures (next 60 days)
  const todayStr = new Date().toISOString().split('T')[0]
  const futureDate = new Date()
  futureDate.setDate(futureDate.getDate() + 60)
  const futureStr = futureDate.toISOString().split('T')[0]

  const upcomingClosures = closures
    .filter(c => {
      if (c.is_recurring) {
        const month = c.start_date.split('-')[1]
        const day = c.start_date.split('-')[2]
        const thisYear = new Date().getFullYear()
        const thisYearStart = `${thisYear}-${month}-${day}`
        const thisYearEnd = c.end_date.split('-')[0] === c.start_date.split('-')[0]
          ? `${thisYear}-${c.end_date.split('-')[1]}-${c.end_date.split('-')[2]}`
          : `${thisYear + 1}-${c.end_date.split('-')[1]}-${c.end_date.split('-')[2]}`
        return thisYearEnd >= todayStr && thisYearStart <= futureStr
      }
      return c.end_date >= todayStr && c.start_date <= futureStr
    })
    .map(c => {
      if (c.is_recurring) {
        const month = c.start_date.split('-')[1]
        const day = c.start_date.split('-')[2]
        const thisYear = new Date().getFullYear()
        return { ...c, _displayStart: `${thisYear}-${month}-${day}`, _displayEnd: `${thisYear}-${c.end_date.split('-')[1]}-${c.end_date.split('-')[2]}` }
      }
      return { ...c, _displayStart: c.start_date, _displayEnd: c.end_date }
    })
    .sort((a, b) => a._displayStart.localeCompare(b._displayStart))
    .slice(0, 5)

  return (
    <section className="parent-section parent-info-section">
      <button
        className="parent-info-toggle"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="parent-info-toggle-left">
          <Info size={14} style={{ color: 'var(--clr-sage-dark)' }} />
          <span>About {providerName}</span>
          {todayLabel && <span className="parent-info-today-badge">{todayLabel}</span>}
        </div>
        <ChevronDown
          size={16}
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        />
      </button>

      {expanded && (
        <div className="parent-info-body">
          {/* Hours */}
          {hours.length > 0 && (
            <div className="parent-info-block">
              <div className="parent-info-block-title">
                <Clock size={14} /> Hours
              </div>
              <div className="parent-info-hours">
                {hours.map(h => (
                  <div
                    key={h.day_of_week}
                    className={`parent-info-day ${h.day_of_week === today ? 'today' : ''} ${!h.is_open ? 'closed' : ''}`}
                  >
                    <span className="parent-info-day-name">{FULL_DAY_NAMES[h.day_of_week]}</span>
                    <span className="parent-info-day-hours">
                      {h.is_open
                        ? `${formatTime(h.open_time)} – ${formatTime(h.close_time)}`
                        : 'Closed'
                      }
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upcoming closures */}
          {upcomingClosures.length > 0 && (
            <div className="parent-info-block">
              <div className="parent-info-block-title">
                <Calendar size={14} /> Upcoming closures
              </div>
              <div className="parent-info-closures">
                {upcomingClosures.map((c, idx) => {
                  const isRange = c._displayStart !== c._displayEnd
                  return (
                    <div key={c.id || idx} className="parent-info-closure">
                      <span className="parent-info-closure-date">
                        {isRange
                          ? `${shortDate(c._displayStart)} – ${shortDate(c._displayEnd)}`
                          : formatDate(c._displayStart)
                        }
                      </span>
                      <span className="parent-info-closure-reason">
                        {c.reason || 'Closed'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Payment methods (NEW) */}
          {paymentMethods.length > 0 && (
            <div className="parent-info-block">
              <div className="parent-info-block-title">
                <CreditCard size={14} /> How to pay {providerName}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                {paymentMethods.map(method => (
                  <div
                    key={method.key}
                    style={{
                      background: 'white',
                      border: '1px solid var(--clr-warm-mid)',
                      borderRadius: 'var(--radius-md)',
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '1.0625rem' }}>{method.emoji}</span>
                      <span style={{ fontWeight: 500, color: 'var(--clr-ink)', fontSize: '0.9375rem' }}>
                        {method.label}
                      </span>
                      {method.tracked && (
                        <span style={{
                          fontSize: '0.6875rem',
                          background: 'var(--clr-sage-pale)',
                          color: 'var(--clr-sage-dark)',
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                        }}>
                          Auto-tracked
                        </span>
                      )}
                    </div>
                    {method.details && (
                      <div style={{
                        marginTop: 6,
                        marginLeft: 26,
                        fontSize: '0.875rem',
                        color: 'var(--clr-ink-mid)',
                        wordBreak: 'break-word',
                      }}>
                        {method.details}
                      </div>
                    )}
                    {method.key === 'stripe' && method.description && (
                      <div style={{
                        marginTop: 6,
                        marginLeft: 26,
                        fontSize: '0.78125rem',
                        color: 'var(--clr-ink-soft)',
                        lineHeight: 1.5,
                      }}>
                        {method.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* Educational footnote — only show if any non-Stripe methods are enabled */}
              {paymentMethods.some(m => !m.tracked) && (
                <div style={{
                  marginTop: 10,
                  padding: '10px 12px',
                  background: 'var(--clr-cream)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.78125rem',
                  color: 'var(--clr-ink-mid)',
                  lineHeight: 1.55,
                }}>
                  <strong style={{ color: 'var(--clr-ink)' }}>Note:</strong> Payments made via Venmo, Zelle, cash, or check are tracked manually by your provider. They <strong>won't appear automatically on your year-end FSA statement</strong> — only Stripe payments do. Ask your provider for a written receipt if you need one for FSA reimbursement.
                </div>
              )}
            </div>
          )}

          {/* Payment policies (existing) */}
          {(policies?.payment_due_day || policies?.late_fee_enabled || policies?.late_pickup_fee_enabled) && (
            <div className="parent-info-block">
              <div className="parent-info-block-title">
                <DollarSign size={14} /> Payment policies
              </div>
              <div className="parent-info-policies">
                {policies.payment_due_day && (
                  <div className="parent-info-policy">
                    <span className="parent-info-policy-label">Payment due:</span>
                    <span>{policies.payment_due_day.charAt(0).toUpperCase() + policies.payment_due_day.slice(1)}s</span>
                  </div>
                )}
                {policies.late_fee_enabled && policies.late_fee_amount && (
                  <div className="parent-info-policy">
                    <span className="parent-info-policy-label">Late fee:</span>
                    <span>${parseFloat(policies.late_fee_amount).toFixed(2)} after {policies.late_fee_after_days || 7} days</span>
                  </div>
                )}
                {policies.late_pickup_fee_enabled && policies.late_pickup_fee_per_minute && (
                  <div className="parent-info-policy">
                    <span className="parent-info-policy-label">Late pickup:</span>
                    <span>${parseFloat(policies.late_pickup_fee_per_minute).toFixed(2)}/min after {policies.late_pickup_grace_minutes || 5} min grace</span>
                  </div>
                )}
              </div>
              {policies.drop_off_notes && (
                <div className="parent-info-note">
                  <strong>Drop-off:</strong> {policies.drop_off_notes}
                </div>
              )}
              {policies.pickup_notes && (
                <div className="parent-info-note">
                  <strong>Pickup:</strong> {policies.pickup_notes}
                </div>
              )}
            </div>
          )}

          {/* Emergency procedures */}
          {policies?.emergency_procedures && (
            <div className="parent-info-block emergency">
              <div className="parent-info-block-title" style={{ color: 'var(--clr-error)' }}>
                <AlertTriangle size={14} /> Emergency procedures
              </div>
              <div className="parent-info-emergency">
                {policies.emergency_procedures}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
