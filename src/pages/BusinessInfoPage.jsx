import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { notifyStateChange } from '@/lib/notifications'
import {
  Clock, Calendar, DollarSign, Phone, AlertTriangle,
  Plus, X, Save, Trash2, ChevronDown, ChevronRight, Check,
  MessageCircle, Info,
} from 'lucide-react'
import '@/styles/business-info.css'

const DAYS = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
]

// ─── Floating holiday calculation ──────────────────────────
function nthWeekdayOfMonth(year, month, weekday, n) {
  const firstOfMonth = new Date(year, month - 1, 1)
  const firstWeekday = firstOfMonth.getDay()
  const offset = (weekday - firstWeekday + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return new Date(year, month - 1, day)
}

function lastWeekdayOfMonth(year, month, weekday) {
  const lastOfMonth = new Date(year, month, 0)
  const lastWeekday = lastOfMonth.getDay()
  const offset = (lastWeekday - weekday + 7) % 7
  return new Date(year, month - 1, lastOfMonth.getDate() - offset)
}

function getHolidayDate(holiday, year) {
  if (holiday.type === 'fixed') return new Date(year, holiday.month - 1, holiday.day)
  if (holiday.type === 'nth-weekday') return nthWeekdayOfMonth(year, holiday.month, holiday.weekday, holiday.n)
  if (holiday.type === 'last-weekday') return lastWeekdayOfMonth(year, holiday.month, holiday.weekday)
  return null
}

function getNextHolidayDate(holiday) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const thisYear = today.getFullYear()
  const thisYearDate = getHolidayDate(holiday, thisYear)
  if (thisYearDate >= today) return thisYearDate
  return getHolidayDate(holiday, thisYear + 1)
}

function dateToYMD(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const COMMON_HOLIDAYS = [
  { name: "New Year's Day",   type: 'fixed',         month: 1,  day: 1 },
  { name: 'Memorial Day',     type: 'last-weekday',  month: 5,  weekday: 1 },
  { name: 'Independence Day', type: 'fixed',         month: 7,  day: 4 },
  { name: 'Labor Day',        type: 'nth-weekday',   month: 9,  weekday: 1, n: 1 },
  { name: 'Thanksgiving',     type: 'nth-weekday',   month: 11, weekday: 4, n: 4 },
  { name: 'Christmas Eve',    type: 'fixed',         month: 12, day: 24 },
  { name: 'Christmas Day',    type: 'fixed',         month: 12, day: 25 },
  { name: "New Year's Eve",   type: 'fixed',         month: 12, day: 31 },
]

// ─── Payment method definitions ─────────────────────────────
const PAYMENT_METHODS_CONFIG = [
  {
    key: 'stripe',
    label: 'Stripe (online card)',
    emoji: '💳',
    tracked: true,
    needsDetails: false,
    helpText: 'Parents pay invoices through this app. Charges are automatic for autopay families. Counts toward FSA tax statements automatically.',
  },
  {
    key: 'venmo',
    label: 'Venmo',
    emoji: '💚',
    tracked: false,
    needsDetails: true,
    placeholder: '@your-venmo-handle',
    helpText: 'Parents see your Venmo handle and pay you outside this app.',
  },
  {
    key: 'zelle',
    label: 'Zelle',
    emoji: '🏦',
    tracked: false,
    needsDetails: true,
    placeholder: 'Email or phone number',
    helpText: 'Parents see your Zelle contact and send through their bank.',
  },
  {
    key: 'cash',
    label: 'Cash',
    emoji: '💵',
    tracked: false,
    needsDetails: true,
    placeholder: 'e.g., Drop off at pickup',
    helpText: 'Parents see your instructions for cash payments.',
  },
  {
    key: 'check',
    label: 'Check',
    emoji: '✉️',
    tracked: false,
    needsDetails: true,
    placeholder: 'e.g., Make out to "Your Name", give at pickup',
    helpText: 'Parents see who to make the check out to and how to deliver it.',
  },
]

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

export default function BusinessInfoPage() {
  const { user } = useAuth()
  const [activeSection, setActiveSection] = useState('hours')
  const [hours, setHours] = useState({})
  const [closures, setClosures] = useState([])
  const [policies, setPolicies] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    if (!user) return
    setLoading(true)
    const [hoursResp, closuresResp, policyResp] = await Promise.all([
      supabase.from('business_hours').select('*').eq('user_id', user.id),
      supabase.from('closures').select('*').eq('user_id', user.id).order('start_date'),
      supabase.from('business_policies').select('*').eq('user_id', user.id).maybeSingle(),
    ])

    const hoursMap = {}
    DAYS.forEach(d => {
      const existing = (hoursResp.data || []).find(h => h.day_of_week === d.value)
      hoursMap[d.value] = existing || {
        day_of_week: d.value,
        is_open: d.value >= 1 && d.value <= 5,
        open_time: '07:00',
        close_time: '18:00',
        notes: '',
      }
    })
    setHours(hoursMap)
    setClosures(closuresResp.data || [])
    setPolicies(policyResp.data || { user_id: user.id, payment_methods: {} })
    setLoading(false)
  }

  const updateHour = (day, field, value) => {
    setHours(h => ({ ...h, [day]: { ...h[day], [field]: value } }))
  }

  const saveHours = async () => {
    setSaving(true)
    setMessage(null)
    try {
      for (const day of DAYS) {
        const h = hours[day.value]
        await supabase.from('business_hours').upsert({
          user_id: user.id,
          day_of_week: day.value,
          is_open: h.is_open,
          open_time: h.is_open ? h.open_time : null,
          close_time: h.is_open ? h.close_time : null,
          notes: h.notes || null,
        }, { onConflict: 'user_id,day_of_week' })
      }
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        hours_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Business hours saved' })

      const { data: families } = await supabase.from('families').select('id, family_name').eq('user_id', user.id)
      const provider = user.user_metadata?.full_name || user.email
      const summary = DAYS
        .map(d => {
          const h = hours[d.value]
          return h.is_open ? `${d.short}: ${h.open_time}-${h.close_time}` : `${d.short}: Closed`
        })
        .join(' · ')
      for (const f of families || []) {
        notifyStateChange('hours_changed', f.id, { providerName: provider, summary })
      }

      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const addClosure = async (closure) => {
    setSaving(true)
    setMessage(null)
    try {
      await supabase.from('closures').insert({
        user_id: user.id,
        ...closure,
        created_by_user_id: user.id,
      })
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        closures_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Closure added' })

      if (closure.notify_parents !== false) {
        const { data: families } = await supabase.from('families').select('id').eq('user_id', user.id)
        const provider = user.user_metadata?.full_name || user.email
        const formatD = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        const dateRange = closure.start_date === closure.end_date
          ? formatD(closure.start_date)
          : `${formatD(closure.start_date)} – ${formatD(closure.end_date)}`
        for (const f of families || []) {
          notifyStateChange('closure_added', f.id, { providerName: provider, dateRange, reason: closure.reason || '' })
        }
      }

      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const deleteClosure = async (id) => {
    if (!window.confirm('Delete this closure?')) return
    await supabase.from('closures').delete().eq('id', id)
    await loadAll()
  }

  const updatePolicy = (field, value) => {
    setPolicies(p => ({ ...p, [field]: value }))
  }

  const updatePaymentMethod = (key, patch) => {
    setPolicies(p => ({
      ...p,
      payment_methods: {
        ...(p.payment_methods || {}),
        [key]: { ...((p.payment_methods || {})[key] || {}), ...patch },
      },
    }))
  }

  const savePolicies = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        policies_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Policies saved' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const saveEmergency = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        emergency_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Emergency info saved' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const toggleMessaging = async (enabled) => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        messaging_enabled: enabled,
      }, { onConflict: 'user_id' })
      setMessage({
        type: 'success',
        text: enabled
          ? '✓ Parent messaging enabled — refresh the page to see the Messages tab in your sidebar'
          : '✓ Parent messaging disabled',
      })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  const sections = [
    { id: 'hours', label: 'Hours', icon: Clock, done: policies.hours_set },
    { id: 'closures', label: 'Holidays & Closures', icon: Calendar, done: policies.closures_set },
    { id: 'policies', label: 'Payment & Fees', icon: DollarSign, done: policies.policies_set },
    { id: 'emergency', label: 'Emergency Info', icon: AlertTriangle, done: policies.emergency_set },
    { id: 'messaging', label: 'Parent Messages', icon: MessageCircle, done: !!policies.messaging_enabled },
  ]

  const paymentMethods = policies.payment_methods || {}

  return (
    <>
      <div style={{
        marginBottom: 'var(--space-5)',
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
      }}>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.25rem',
          fontWeight: 400,
          color: 'var(--clr-ink)',
          letterSpacing: '-0.02em',
          marginBottom: 'var(--space-2)',
        }}>
          Set this once. Stop answering it forever.
        </h2>
        <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.5, margin: 0 }}>
          Information you enter here shows up automatically on every parent's portal. No more "what time do you open?" texts.
        </p>
      </div>

      <div className="bi-tabs">
        {sections.map(s => (
          <button
            key={s.id}
            className={`bi-tab ${activeSection === s.id ? 'active' : ''}`}
            onClick={() => setActiveSection(s.id)}
          >
            <s.icon size={15} />
            <span>{s.label}</span>
            {s.done && <span className="bi-check"><Check size={11} /></span>}
          </button>
        ))}
      </div>

      {message && (
        <div className={`bi-message ${message.type}`}>
          {message.text}
        </div>
      )}

      {activeSection === 'hours' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Operating Hours</h3>
            <p>Set your hours for each day. Days marked closed will show as closed on the parent portal.</p>
          </div>

          <div className="bi-hours-list">
            {DAYS.map(day => {
              const h = hours[day.value] || {}
              return (
                <div key={day.value} className={`bi-hour-row ${!h.is_open ? 'closed' : ''}`}>
                  <div className="bi-day-toggle">
                    <label className="bi-switch">
                      <input
                        type="checkbox"
                        checked={h.is_open}
                        onChange={(e) => updateHour(day.value, 'is_open', e.target.checked)}
                      />
                      <span className="bi-switch-slider"></span>
                    </label>
                    <span className="bi-day-label">{day.label}</span>
                  </div>
                  {h.is_open ? (
                    <div className="bi-time-row">
                      <input
                        type="time"
                        value={h.open_time || '07:00'}
                        onChange={(e) => updateHour(day.value, 'open_time', e.target.value)}
                        className="bi-time-input"
                      />
                      <span style={{ color: 'var(--clr-ink-soft)' }}>–</span>
                      <input
                        type="time"
                        value={h.close_time || '18:00'}
                        onChange={(e) => updateHour(day.value, 'close_time', e.target.value)}
                        className="bi-time-input"
                      />
                    </div>
                  ) : (
                    <span className="bi-closed-tag">Closed</span>
                  )}
                </div>
              )
            })}
          </div>

          <button className="bi-save-btn" onClick={saveHours} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save hours'}
          </button>
        </div>
      )}

      {activeSection === 'closures' && (
        <ClosuresSection
          closures={closures}
          onAdd={addClosure}
          onDelete={deleteClosure}
          saving={saving}
        />
      )}

      {activeSection === 'policies' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Payment Policies</h3>
            <p>Set how and when families pay. Parents will see this info in their portal.</p>
          </div>

          <div className="bi-form">
            <div className="bi-field">
              <label>Payment due day</label>
              <select
                value={policies.payment_due_day || 'monday'}
                onChange={(e) => updatePolicy('payment_due_day', e.target.value)}
                className="bi-input"
              >
                <option value="monday">Monday (recommended for autopay)</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
                <option value="sunday">Sunday</option>
              </select>
            </div>

            <div className="bi-fieldset">
              <label style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 8 }}>
                Payment methods you accept
              </label>

              <div style={{
                background: 'var(--clr-cream)',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3) var(--space-4)',
                marginBottom: 'var(--space-4)',
                fontSize: '0.8125rem',
                color: 'var(--clr-ink-mid)',
                lineHeight: 1.55,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <Info size={14} style={{ color: 'var(--clr-sage-dark)', marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <strong style={{ color: 'var(--clr-ink)' }}>About off-app payments (Venmo, Zelle, Cash, Check):</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem' }}>
                      <li>You'll need to <strong>manually mark invoices as paid</strong> when you receive these payments.</li>
                      <li>They <strong>won't appear on parents' year-end FSA statements automatically</strong> — only Stripe payments do.</li>
                      <li>Autopay only works with Stripe — parents will need to remember to send payment each week.</li>
                    </ul>
                    <p style={{ margin: '8px 0 0' }}>
                      Stripe handles all of this automatically and gives parents downloadable receipts for FSA, taxes, and reimbursement.
                    </p>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {PAYMENT_METHODS_CONFIG.map(method => {
                  const config = paymentMethods[method.key] || { enabled: false, details: '' }
                  const enabled = !!config.enabled
                  return (
                    <div
                      key={method.key}
                      style={{
                        border: enabled ? '1px solid var(--clr-sage)' : '1px solid var(--clr-warm-mid)',
                        background: enabled ? 'white' : 'var(--clr-cream)',
                        borderRadius: 'var(--radius-md)',
                        padding: 'var(--space-3) var(--space-4)',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => updatePaymentMethod(method.key, { enabled: e.target.checked })}
                        />
                        <span style={{ fontSize: '1.125rem' }}>{method.emoji}</span>
                        <span style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>{method.label}</span>
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
                      </label>

                      {enabled && method.needsDetails && (
                        <div style={{ marginTop: 10, marginLeft: 26 }}>
                          <input
                            type="text"
                            value={config.details || ''}
                            onChange={(e) => updatePaymentMethod(method.key, { details: e.target.value })}
                            placeholder={method.placeholder}
                            className="bi-input"
                            style={{ marginBottom: 4 }}
                          />
                          <p style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', margin: 0, lineHeight: 1.45 }}>
                            {method.helpText}
                          </p>
                        </div>
                      )}

                      {enabled && !method.needsDetails && (
                        <p style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', margin: '8px 0 0 26px', lineHeight: 1.45 }}>
                          {method.helpText}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bi-fieldset">
              <label className="bi-toggle">
                <input
                  type="checkbox"
                  checked={!!policies.late_fee_enabled}
                  onChange={(e) => updatePolicy('late_fee_enabled', e.target.checked)}
                />
                <strong>Charge late fees on overdue invoices</strong>
              </label>
              {policies.late_fee_enabled && (
                <div className="bi-form-row">
                  <div className="bi-field">
                    <label>Fee amount</label>
                    <div className="bi-input-prefix">
                      <span>$</span>
                      <input
                        type="number"
                        step="0.01"
                        value={policies.late_fee_amount || ''}
                        onChange={(e) => updatePolicy('late_fee_amount', parseFloat(e.target.value) || null)}
                        className="bi-input"
                        placeholder="25.00"
                      />
                    </div>
                  </div>
                  <div className="bi-field">
                    <label>After how many days late?</label>
                    <input
                      type="number"
                      value={policies.late_fee_after_days || 7}
                      onChange={(e) => updatePolicy('late_fee_after_days', parseInt(e.target.value) || 7)}
                      className="bi-input"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="bi-fieldset">
              <label className="bi-toggle">
                <input
                  type="checkbox"
                  checked={!!policies.late_pickup_fee_enabled}
                  onChange={(e) => updatePolicy('late_pickup_fee_enabled', e.target.checked)}
                />
                <strong>Charge late pickup fees</strong>
              </label>
              {policies.late_pickup_fee_enabled && (
                <div className="bi-form-row">
                  <div className="bi-field">
                    <label>Fee per minute late</label>
                    <div className="bi-input-prefix">
                      <span>$</span>
                      <input
                        type="number"
                        step="0.25"
                        value={policies.late_pickup_fee_per_minute || ''}
                        onChange={(e) => updatePolicy('late_pickup_fee_per_minute', parseFloat(e.target.value) || null)}
                        className="bi-input"
                        placeholder="1.00"
                      />
                    </div>
                  </div>
                  <div className="bi-field">
                    <label>Grace period (minutes)</label>
                    <input
                      type="number"
                      value={policies.late_pickup_grace_minutes || 5}
                      onChange={(e) => updatePolicy('late_pickup_grace_minutes', parseInt(e.target.value) || 5)}
                      className="bi-input"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="bi-field">
              <label>Drop-off notes (optional)</label>
              <textarea
                value={policies.drop_off_notes || ''}
                onChange={(e) => updatePolicy('drop_off_notes', e.target.value)}
                className="bi-textarea"
                placeholder="e.g., Please ring the doorbell. Children must be signed in by an authorized adult."
                rows={2}
              />
            </div>

            <div className="bi-field">
              <label>Pickup notes (optional)</label>
              <textarea
                value={policies.pickup_notes || ''}
                onChange={(e) => updatePolicy('pickup_notes', e.target.value)}
                className="bi-textarea"
                placeholder="e.g., Please notify me by 4 PM if someone other than the usual person will pick up."
                rows={2}
              />
            </div>
          </div>

          <button className="bi-save-btn" onClick={savePolicies} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save policies'}
          </button>
        </div>
      )}

      {activeSection === 'emergency' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Emergency Procedures</h3>
            <p>What should parents do or know in an emergency? This will appear prominently on their portal.</p>
          </div>

          <div className="bi-field">
            <label>Emergency procedures</label>
            <textarea
              value={policies.emergency_procedures || ''}
              onChange={(e) => updatePolicy('emergency_procedures', e.target.value)}
              className="bi-textarea"
              placeholder="e.g., In case of fire or other emergency, we evacuate to [location] and contact parents immediately. The home address is XXX. Our emergency contact is XXX. Local emergency: 911."
              rows={6}
            />
            <p className="bi-helper">
              Include: evacuation location, your address (for emergency services), your emergency contact, and any specific procedures for your home.
            </p>
          </div>

          <button className="bi-save-btn" onClick={saveEmergency} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save emergency info'}
          </button>
        </div>
      )}

      {activeSection === 'messaging' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Parent Messages</h3>
            <p>Two-way messaging with parents, including photo sharing. Optional and easy to turn off.</p>
          </div>

          <div className="bi-fieldset">
            <label className="bi-toggle">
              <input
                type="checkbox"
                checked={!!policies.messaging_enabled}
                onChange={(e) => toggleMessaging(e.target.checked)}
                disabled={saving}
              />
              <strong>Enable parent messaging</strong>
            </label>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.875rem', lineHeight: 1.55, marginTop: 'var(--space-2)', marginBottom: 0 }}>
              When enabled, you'll see a <strong>Messages</strong> tab in your sidebar where you can post text and photos
              for each child. Parents can post and reply too. Some providers love this — others prefer keeping
              communication off-app. Turn it on or off anytime, and your existing messages are preserved either way.
            </p>
          </div>

          {policies.messaging_enabled && (
            <div style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-4)',
              background: 'var(--clr-cream)',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.875rem',
              color: 'var(--clr-ink-mid)',
              lineHeight: 1.55,
            }}>
              <strong style={{ color: 'var(--clr-ink)' }}>A few things to know:</strong>
              <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.25rem' }}>
                <li>Each child gets their own thread, so updates stay organized.</li>
                <li>Photos are compressed automatically and stored privately — only you and the linked parents can see them.</li>
                <li>Parents are emailed when you post, with a 10-minute throttle so they don't get flooded.</li>
                <li>If you turn this off later, the Messages tab disappears but nothing is deleted.</li>
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function ClosuresSection({ closures, onAdd, onDelete, saving }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    closure_type: 'holiday',
    is_recurring: true,
    start_date: '',
    end_date: '',
    reason: '',
  })

  const submit = async () => {
    if (!form.start_date) return
    await onAdd({ ...form, end_date: form.end_date || form.start_date })
    setForm({ closure_type: 'holiday', is_recurring: true, start_date: '', end_date: '', reason: '' })
    setShowForm(false)
  }

  const addCommonHoliday = async (h) => {
    const nextDate = getNextHolidayDate(h)
    const dateStr = dateToYMD(nextDate)
    await onAdd({
      closure_type: 'holiday',
      is_recurring: true,
      start_date: dateStr,
      end_date: dateStr,
      reason: h.name,
      notify_parents: true,
    })
  }

  const today = new Date().toISOString().split('T')[0]
  const upcoming = closures.filter(c => c.end_date >= today && !c.is_recurring)
  const recurring = closures.filter(c => c.is_recurring)
  const past = closures.filter(c => c.end_date < today && !c.is_recurring)

  const isHolidayAdded = (holiday) => {
    return closures.some(c => c.is_recurring && c.reason === holiday.name)
  }

  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>Holidays & Closures</h3>
        <p>Recurring holidays auto-renew every year. One-off closures (vacation, sick days) are added as you need them.</p>
      </div>

      <div className="bi-quick-add">
        <div className="bi-quick-add-label">Common holidays — tap to add as recurring:</div>
        <div className="bi-quick-add-row">
          {COMMON_HOLIDAYS.map(h => {
            const exists = isHolidayAdded(h)
            const nextDate = getNextHolidayDate(h)
            const tooltip = `Next: ${nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
            return (
              <button
                key={h.name}
                className={`bi-quick-chip ${exists ? 'added' : ''}`}
                onClick={() => !exists && addCommonHoliday(h)}
                disabled={exists || saving}
                title={tooltip}
              >
                {exists && <Check size={11} />}
                {h.name}
              </button>
            )
          })}
        </div>
      </div>

      <button className="bi-add-btn" onClick={() => setShowForm(!showForm)}>
        <Plus size={14} /> Add custom closure
      </button>

      {showForm && (
        <div className="bi-form-card">
          <div className="bi-form-row">
            <div className="bi-field">
              <label>Type</label>
              <select
                value={form.closure_type}
                onChange={(e) => setForm(f => ({ ...f, closure_type: e.target.value, is_recurring: e.target.value === 'holiday' }))}
                className="bi-input"
              >
                <option value="holiday">Holiday (recurring annually)</option>
                <option value="vacation">Vacation</option>
                <option value="sick">Sick day</option>
                <option value="personal">Personal day</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="bi-field">
              <label>Reason / name</label>
              <input
                type="text"
                value={form.reason}
                onChange={(e) => setForm(f => ({ ...f, reason: e.target.value }))}
                className="bi-input"
                placeholder="e.g., Provider vacation"
              />
            </div>
          </div>
          <div className="bi-form-row">
            <div className="bi-field">
              <label>Start date</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="bi-input"
              />
            </div>
            <div className="bi-field">
              <label>End date (optional)</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="bi-input"
                placeholder="Same as start for single day"
              />
            </div>
          </div>
          {form.closure_type !== 'holiday' && (
            <label className="bi-toggle">
              <input
                type="checkbox"
                checked={form.is_recurring}
                onChange={(e) => setForm(f => ({ ...f, is_recurring: e.target.checked }))}
              />
              Repeat every year
            </label>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
            <button className="bi-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="bi-save-btn" onClick={submit} disabled={saving || !form.start_date} style={{ padding: '0.5rem var(--space-4)' }}>
              <Save size={14} /> Add closure
            </button>
          </div>
        </div>
      )}

      {recurring.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">🔁 Recurring annually ({recurring.length})</div>
          {recurring.map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} recurring />)}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📅 Upcoming closures ({upcoming.length})</div>
          {upcoming.map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} />)}
        </div>
      )}

      {past.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📜 Past closures ({past.length})</div>
          {past.slice(0, 5).map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} muted />)}
        </div>
      )}

      {closures.length === 0 && (
        <div className="bi-empty">
          <Calendar size={32} style={{ color: 'var(--clr-warm-mid)' }} />
          <p>No closures yet. Add common holidays above or create a custom closure.</p>
        </div>
      )}
    </div>
  )
}

function ClosureItem({ closure, onDelete, recurring, muted }) {
  const isRange = closure.start_date !== closure.end_date

  return (
    <div className={`bi-closure-item ${muted ? 'muted' : ''}`}>
      <div className="bi-closure-info">
        <div className="bi-closure-name">{closure.reason || 'Closed'}</div>
        <div className="bi-closure-meta">
          {recurring && <span>Annually · </span>}
          {isRange ? (
            <>{shortDate(closure.start_date)} – {shortDate(closure.end_date)}</>
          ) : (
            <>{formatDate(closure.start_date)}</>
          )}
        </div>
      </div>
      <button onClick={() => onDelete(closure.id)} className="bi-delete-btn" title="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  )
}
