import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import {
  Clock, Calendar, DollarSign, Phone, AlertTriangle,
  Plus, X, Save, Trash2, ChevronDown, ChevronRight, Check,
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

const COMMON_HOLIDAYS = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: 'Memorial Day', month: 5, day: 26, note: '(last Mon of May)' },
  { name: 'Independence Day', month: 7, day: 4 },
  { name: 'Labor Day', month: 9, day: 1, note: '(first Mon of Sept)' },
  { name: 'Thanksgiving', month: 11, day: 27, note: '(4th Thu of Nov)' },
  { name: 'Christmas Eve', month: 12, day: 24 },
  { name: 'Christmas Day', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
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
  const [hours, setHours] = useState({})  // {0: {is_open, open_time, close_time}}
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

    // Build hours map (default closed for missing days)
    const hoursMap = {}
    DAYS.forEach(d => {
      const existing = (hoursResp.data || []).find(h => h.day_of_week === d.value)
      hoursMap[d.value] = existing || {
        day_of_week: d.value,
        is_open: d.value >= 1 && d.value <= 5,  // Default Mon-Fri open
        open_time: '07:00',
        close_time: '18:00',
        notes: '',
      }
    })
    setHours(hoursMap)
    setClosures(closuresResp.data || [])
    setPolicies(policyResp.data || { user_id: user.id })
    setLoading(false)
  }

  // ─── Hours ─────────────────
  const updateHour = (day, field, value) => {
    setHours(h => ({
      ...h,
      [day]: { ...h[day], [field]: value },
    }))
  }

  const saveHours = async () => {
    setSaving(true)
    setMessage(null)
    try {
      // Upsert each day
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
      // Mark hours as set
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        hours_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Business hours saved' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  // ─── Closures ──────────────
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

  // ─── Policies ──────────────
  const updatePolicy = (field, value) => {
    setPolicies(p => ({ ...p, [field]: value }))
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
  ]

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

      {/* Section tabs */}
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

      {/* Hours section */}
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

      {/* Closures section */}
      {activeSection === 'closures' && (
        <ClosuresSection
          closures={closures}
          onAdd={addClosure}
          onDelete={deleteClosure}
          saving={saving}
        />
      )}

      {/* Policies section */}
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

            <div className="bi-field">
              <label>Payment methods accepted</label>
              <div className="bi-checkbox-row">
                {['Stripe (online)', 'Venmo', 'Cash', 'Check'].map(method => {
                  const value = method.toLowerCase().split(' ')[0]
                  const checked = (policies.payment_methods_accepted || []).includes(value)
                  return (
                    <label key={value} className="bi-checkbox">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const current = policies.payment_methods_accepted || []
                          updatePolicy('payment_methods_accepted',
                            e.target.checked
                              ? [...current, value]
                              : current.filter(v => v !== value)
                          )
                        }}
                      />
                      <span>{method}</span>
                    </label>
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

      {/* Emergency section */}
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
    await onAdd({
      ...form,
      end_date: form.end_date || form.start_date,
    })
    setForm({ closure_type: 'holiday', is_recurring: true, start_date: '', end_date: '', reason: '' })
    setShowForm(false)
  }

  const addCommonHoliday = async (h) => {
    const year = new Date().getFullYear()
    const month = String(h.month).padStart(2, '0')
    const day = String(h.day).padStart(2, '0')
    const dateStr = `${year}-${month}-${day}`
    await onAdd({
      closure_type: 'holiday',
      is_recurring: true,
      start_date: dateStr,
      end_date: dateStr,
      reason: h.name,
      notify_parents: true,
    })
  }

  // Group closures: upcoming vs recurring vs past
  const today = new Date().toISOString().split('T')[0]
  const upcoming = closures.filter(c => c.end_date >= today && !c.is_recurring)
  const recurring = closures.filter(c => c.is_recurring)
  const past = closures.filter(c => c.end_date < today && !c.is_recurring)

  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>Holidays & Closures</h3>
        <p>Recurring holidays auto-renew every year. One-off closures (vacation, sick days) are added as you need them.</p>
      </div>

      {/* Quick add common holidays */}
      <div className="bi-quick-add">
        <div className="bi-quick-add-label">Common holidays — tap to add as recurring:</div>
        <div className="bi-quick-add-row">
          {COMMON_HOLIDAYS.map(h => {
            const month = String(h.month).padStart(2, '0')
            const day = String(h.day).padStart(2, '0')
            const exists = closures.some(c =>
              c.is_recurring &&
              c.start_date.endsWith(`-${month}-${day}`)
            )
            return (
              <button
                key={h.name}
                className={`bi-quick-chip ${exists ? 'added' : ''}`}
                onClick={() => !exists && addCommonHoliday(h)}
                disabled={exists || saving}
              >
                {exists && <Check size={11} />}
                {h.name}
              </button>
            )
          })}
        </div>
      </div>

      <button
        className="bi-add-btn"
        onClick={() => setShowForm(!showForm)}
      >
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
          {recurring.map(c => (
            <ClosureItem key={c.id} closure={c} onDelete={onDelete} recurring />
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📅 Upcoming closures ({upcoming.length})</div>
          {upcoming.map(c => (
            <ClosureItem key={c.id} closure={c} onDelete={onDelete} />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📜 Past closures ({past.length})</div>
          {past.slice(0, 5).map(c => (
            <ClosureItem key={c.id} closure={c} onDelete={onDelete} muted />
          ))}
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
