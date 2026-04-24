import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { Home, Clock, Sparkles, Plus, Trash2, Save, Info, Calendar } from 'lucide-react'
import '@/styles/ts-ratio.css'

const HOURS_IN_YEAR = 8760 // 365 × 24

// Categories that typically qualify as shared household expenses
const SHARED_EXPENSE_CATEGORIES = [
  'Utilities',
  'Insurance',
  'Cleaning & Household',
  'Professional Services',
]

function getDayName(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}

export default function TSRatioPage() {
  const { user } = useAuth()
  const [year, setYear] = useState(new Date().getFullYear())

  // Space inputs
  const [totalSqft, setTotalSqft] = useState('')
  const [regularUseSqft, setRegularUseSqft] = useState('')
  const [sharedUseSqft, setSharedUseSqft] = useState('')

  // Time inputs
  const [inputMode, setInputMode] = useState('weekly')
  const [hoursPerWeek, setHoursPerWeek] = useState('')
  const [weeksPerYear, setWeeksPerYear] = useState('50')

  // Daily log
  const [hourLogs, setHourLogs] = useState([])
  const [newLogDate, setNewLogDate] = useState(new Date().toISOString().split('T')[0])
  const [newLogHours, setNewLogHours] = useState('')
  const [newLogNotes, setNewLogNotes] = useState('')

  // Receipts for auto-apply preview
  const [sharedReceipts, setSharedReceipts] = useState([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedMessage, setSavedMessage] = useState(null)

  // ─── Load data ──────────────────────────────────
  useEffect(() => {
    loadAll()
  }, [year])

  async function loadAll() {
    setLoading(true)

    // Load T/S ratio for this year
    const { data: ratio } = await supabase
      .from('ts_ratios')
      .select('*')
      .eq('user_id', user.id)
      .eq('year', year)
      .maybeSingle()

    if (ratio) {
      setTotalSqft(ratio.total_sqft?.toString() || '')
      setRegularUseSqft(ratio.regular_use_sqft?.toString() || '')
      setSharedUseSqft(ratio.shared_use_sqft?.toString() || '')
      setInputMode(ratio.input_mode || 'weekly')
      setHoursPerWeek(ratio.hours_per_week?.toString() || '')
      setWeeksPerYear(ratio.weeks_per_year?.toString() || '50')
    } else {
      setTotalSqft(''); setRegularUseSqft(''); setSharedUseSqft('')
      setInputMode('weekly'); setHoursPerWeek(''); setWeeksPerYear('50')
    }

    // Load hour logs for this year
    const { data: logs } = await supabase
      .from('hour_logs')
      .select('*')
      .eq('user_id', user.id)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
      .order('date', { ascending: false })

    setHourLogs(logs || [])

    // Load shared-expense receipts for this year
    const { data: receipts } = await supabase
      .from('receipts')
      .select('id, merchant, date, total, amount, category')
      .eq('user_id', user.id)
      .in('category', SHARED_EXPENSE_CATEGORIES)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)

    setSharedReceipts(receipts || [])

    setLoading(false)
    setDirty(false)
  }

  // ─── Calculations ───────────────────────────────

  const { spacePercent, timePercent, tsPercent, totalBusinessSqft, totalHoursLogged } = useMemo(() => {
    const total = parseFloat(totalSqft) || 0
    const regular = parseFloat(regularUseSqft) || 0
    const shared = parseFloat(sharedUseSqft) || 0
    const businessSqft = regular + shared

    const sp = total > 0 ? (businessSqft / total) * 100 : 0

    let totalHours = 0
    if (inputMode === 'weekly') {
      const hpw = parseFloat(hoursPerWeek) || 0
      const wpy = parseFloat(weeksPerYear) || 0
      totalHours = hpw * wpy
    } else {
      totalHours = hourLogs.reduce((s, l) => s + parseFloat(l.hours || 0), 0)
    }

    const tp = (totalHours / HOURS_IN_YEAR) * 100
    const ts = (sp / 100) * (tp / 100) * 100

    return {
      spacePercent: sp,
      timePercent: tp,
      tsPercent: ts,
      totalBusinessSqft: businessSqft,
      totalHoursLogged: totalHours,
    }
  }, [totalSqft, regularUseSqft, sharedUseSqft, inputMode, hoursPerWeek, weeksPerYear, hourLogs])

  // Mark form as dirty when user edits
  const markDirty = () => { setDirty(true); setSavedMessage(null) }

  // ─── Actions ─────────────────────────────────────

  const handleSave = async () => {
    setSaving(true)
    const { error } = await supabase.from('ts_ratios').upsert({
      user_id: user.id,
      year,
      total_sqft: parseFloat(totalSqft) || null,
      regular_use_sqft: parseFloat(regularUseSqft) || null,
      shared_use_sqft: parseFloat(sharedUseSqft) || null,
      input_mode: inputMode,
      hours_per_week: parseFloat(hoursPerWeek) || null,
      weeks_per_year: parseFloat(weeksPerYear) || null,
      total_hours_logged: totalHoursLogged || null,
      space_percent: parseFloat(spacePercent.toFixed(3)),
      time_percent: parseFloat(timePercent.toFixed(3)),
      ts_percent: parseFloat(tsPercent.toFixed(3)),
    }, { onConflict: 'user_id,year' })
    setSaving(false)

    if (!error) {
      setDirty(false)
      setSavedMessage('✓ Saved! Your T/S ratio will now auto-apply to shared expenses.')
      setTimeout(() => setSavedMessage(null), 4000)
    }
  }

  const handleAddLog = async () => {
    if (!newLogDate || !newLogHours) return
    const { error } = await supabase.from('hour_logs').upsert({
      user_id: user.id,
      date: newLogDate,
      hours: parseFloat(newLogHours),
      notes: newLogNotes || null,
    }, { onConflict: 'user_id,date' })

    if (!error) {
      setNewLogDate(new Date().toISOString().split('T')[0])
      setNewLogHours('')
      setNewLogNotes('')
      await loadAll()
    }
  }

  const handleDeleteLog = async (id) => {
    await supabase.from('hour_logs').delete().eq('id', id)
    await loadAll()
  }

  // ─── Derived stats ───────────────────────────────

  const sharedExpenseTotal = sharedReceipts.reduce((s, r) => s + parseFloat(r.total || r.amount || 0), 0)
  const deductibleAmount = sharedExpenseTotal * (tsPercent / 100)

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  return (
    <div className="ts-page">

      {/* Year selector */}
      <div className="view-toggle-bar">
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
          Calculate and save your T/S ratio for each tax year
        </div>
        <div className="year-selector">
          <span>Tax year</span>
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))}>
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Hero result */}
      <div className="ts-hero">
        <div className="ts-hero-inner">
          <div>
            <div className="ts-hero-label">Your T/S Percentage</div>
            <div className="ts-hero-value">
              {tsPercent.toFixed(2)}<em>%</em>
            </div>
            <div className="ts-hero-desc">
              This is the percentage of shared household expenses (utilities, insurance, cleaning supplies) you can deduct as business expenses.
            </div>
          </div>
          <div className="ts-hero-breakdown">
            <div className="ts-hero-breakdown-item">
              <div className="ts-hero-breakdown-label">Space</div>
              <div className="ts-hero-breakdown-value">{spacePercent.toFixed(1)}%</div>
            </div>
            <div className="ts-hero-breakdown-item">
              <div className="ts-hero-breakdown-label">Time</div>
              <div className="ts-hero-breakdown-value">{timePercent.toFixed(1)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Space */}
      <div className="calc-section">
        <div className="calc-section-header">
          <div className="calc-section-title-wrap">
            <div className="calc-section-icon"><Home size={18} /></div>
            <div>
              <div className="calc-section-title">Space Calculation</div>
              <div className="calc-section-sub">Square footage used for your daycare</div>
            </div>
          </div>
          <div className="calc-section-result">{spacePercent.toFixed(2)}%</div>
        </div>
        <div className="calc-section-body">
          <div className="input-row">
            <div>
              <div className="input-label">Total home square footage</div>
              <div className="input-label-sub">Include all finished space in your home</div>
            </div>
            <div className="input-with-unit">
              <input
                className="field-input"
                type="number"
                step="1"
                placeholder="0"
                value={totalSqft}
                onChange={(e) => { setTotalSqft(e.target.value); markDirty() }}
              />
              <span className="unit">sq ft</span>
            </div>
          </div>

          <div className="input-row">
            <div>
              <div className="input-label">Regular-use daycare space</div>
              <div className="input-label-sub">Rooms used exclusively for daycare</div>
            </div>
            <div className="input-with-unit">
              <input
                className="field-input"
                type="number"
                step="1"
                placeholder="0"
                value={regularUseSqft}
                onChange={(e) => { setRegularUseSqft(e.target.value); markDirty() }}
              />
              <span className="unit">sq ft</span>
            </div>
          </div>

          <div className="input-row">
            <div>
              <div className="input-label">Shared-use daycare space</div>
              <div className="input-label-sub">Kitchen, living room, etc. — used for both</div>
            </div>
            <div className="input-with-unit">
              <input
                className="field-input"
                type="number"
                step="1"
                placeholder="0"
                value={sharedUseSqft}
                onChange={(e) => { setSharedUseSqft(e.target.value); markDirty() }}
              />
              <span className="unit">sq ft</span>
            </div>
          </div>

          <div className="calc-formula">
            <span className="calc-formula-math">
              {totalBusinessSqft.toFixed(0)} ÷ {parseFloat(totalSqft || 0).toFixed(0)} =
            </span>
            <span className="calc-formula-result">{spacePercent.toFixed(2)}%</span>
          </div>
        </div>
      </div>

      {/* Time */}
      <div className="calc-section">
        <div className="calc-section-header">
          <div className="calc-section-title-wrap">
            <div className="calc-section-icon"><Clock size={18} /></div>
            <div>
              <div className="calc-section-title">Time Calculation</div>
              <div className="calc-section-sub">Hours your home is used for daycare</div>
            </div>
          </div>
          <div className="calc-section-result">{timePercent.toFixed(2)}%</div>
        </div>
        <div className="calc-section-body">

          <div className="mode-toggle">
            <button className={inputMode === 'weekly' ? 'active' : ''} onClick={() => { setInputMode('weekly'); markDirty() }}>
              Weekly estimate
            </button>
            <button className={inputMode === 'daily_log' ? 'active' : ''} onClick={() => { setInputMode('daily_log'); markDirty() }}>
              Daily log
            </button>
          </div>

          {inputMode === 'weekly' && (
            <>
              <div className="input-row">
                <div>
                  <div className="input-label">Operating hours per week</div>
                  <div className="input-label-sub">Include prep, cleanup, and recordkeeping time</div>
                </div>
                <div className="input-with-unit">
                  <input
                    className="field-input"
                    type="number"
                    step="0.5"
                    placeholder="0"
                    value={hoursPerWeek}
                    onChange={(e) => { setHoursPerWeek(e.target.value); markDirty() }}
                  />
                  <span className="unit">hrs</span>
                </div>
              </div>

              <div className="input-row">
                <div>
                  <div className="input-label">Weeks operating per year</div>
                  <div className="input-label-sub">Subtract vacation and closed weeks</div>
                </div>
                <div className="input-with-unit">
                  <input
                    className="field-input"
                    type="number"
                    step="1"
                    max="52"
                    value={weeksPerYear}
                    onChange={(e) => { setWeeksPerYear(e.target.value); markDirty() }}
                  />
                  <span className="unit">weeks</span>
                </div>
              </div>

              <div className="calc-formula">
                <span className="calc-formula-math">
                  {totalHoursLogged.toFixed(0)} hrs ÷ {HOURS_IN_YEAR} =
                </span>
                <span className="calc-formula-result">{timePercent.toFixed(2)}%</span>
              </div>
            </>
          )}

          {inputMode === 'daily_log' && (
            <>
              <div className="add-hours-form">
                <div className="form-field-group">
                  <label className="field-label">Date</label>
                  <input
                    className="field-input"
                    type="date"
                    value={newLogDate}
                    onChange={(e) => setNewLogDate(e.target.value)}
                  />
                </div>
                <div className="form-field-group">
                  <label className="field-label">Hours</label>
                  <input
                    className="field-input"
                    type="number"
                    step="0.25"
                    placeholder="0"
                    value={newLogHours}
                    onChange={(e) => setNewLogHours(e.target.value)}
                  />
                </div>
                <div className="form-field-group">
                  <label className="field-label">Notes (optional)</label>
                  <input
                    className="field-input"
                    value={newLogNotes}
                    onChange={(e) => setNewLogNotes(e.target.value)}
                    placeholder="e.g. 2 kids all day"
                  />
                </div>
                <button className="btn-save" onClick={handleAddLog} disabled={!newLogDate || !newLogHours}>
                  <Plus size={14} /> Add
                </button>
              </div>

              {hourLogs.length > 0 ? (
                <>
                  <div className="hour-log-list">
                    {hourLogs.map(log => (
                      <div key={log.id} className="hour-log-entry">
                        <div>
                          <div className="hour-log-date">
                            {new Date(log.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>
                          <div className="hour-log-day">{getDayName(log.date)}</div>
                        </div>
                        <div className="hour-log-notes">{log.notes || '—'}</div>
                        <div className="hour-log-hours">{parseFloat(log.hours).toFixed(2)}h</div>
                        <button className="icon-btn danger" onClick={() => handleDeleteLog(log.id)}>
                          <Trash2 />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="log-summary">
                    <div className="log-summary-item">
                      <div className="log-summary-label">Days Logged</div>
                      <div className="log-summary-value">{hourLogs.length}</div>
                    </div>
                    <div className="log-summary-item">
                      <div className="log-summary-label">Total Hours</div>
                      <div className="log-summary-value">{totalHoursLogged.toFixed(1)}</div>
                    </div>
                    <div className="log-summary-item">
                      <div className="log-summary-label">Avg/Day</div>
                      <div className="log-summary-value">
                        {hourLogs.length > 0 ? (totalHoursLogged / hourLogs.length).toFixed(1) : '0'}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--clr-ink-soft)', fontSize: '0.875rem' }}>
                  No hours logged yet. Add your first entry above.
                </div>
              )}

              <div className="calc-formula">
                <span className="calc-formula-math">
                  {totalHoursLogged.toFixed(1)} hrs ÷ {HOURS_IN_YEAR} =
                </span>
                <span className="calc-formula-result">{timePercent.toFixed(2)}%</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Auto-apply */}
      <div className="calc-section">
        <div className="calc-section-header">
          <div className="calc-section-title-wrap">
            <div className="calc-section-icon"><Sparkles size={18} /></div>
            <div>
              <div className="calc-section-title">Auto-applied to Shared Expenses</div>
              <div className="calc-section-sub">Your T/S ratio applied to {year} receipts</div>
            </div>
          </div>
        </div>
        <div className="calc-section-body">

          <div className="apply-info-box">
            <div className="info-icon"><Info size={16} /></div>
            <div>
              <div className="apply-info-title">How it works</div>
              <div className="apply-info-desc">
                Receipts in the categories <strong>Utilities, Insurance, Cleaning &amp; Household,</strong> and <strong>Professional Services</strong> are considered shared expenses. Your T/S percentage ({tsPercent.toFixed(2)}%) is multiplied against them to calculate your actual deductible amount.
              </div>
            </div>
          </div>

          <div className="shared-stat-grid">
            <div className="shared-stat">
              <div className="shared-stat-value">{sharedReceipts.length}</div>
              <div className="shared-stat-label">Shared receipts in {year}</div>
            </div>
            <div className="shared-stat">
              <div className="shared-stat-value">${sharedExpenseTotal.toFixed(2)}</div>
              <div className="shared-stat-label">Total shared expenses</div>
            </div>
            <div className="shared-stat">
              <div className="shared-stat-value" style={{ color: 'var(--clr-sage-dark)' }}>
                ${deductibleAmount.toFixed(2)}
              </div>
              <div className="shared-stat-label">Deductible at {tsPercent.toFixed(2)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Save bar */}
      {(dirty || savedMessage) && (
        <div className="save-bar">
          <div className="save-bar-text">
            {savedMessage || (
              <>Ready to save? Your current T/S ratio is <strong>{tsPercent.toFixed(2)}%</strong> for {year}.</>
            )}
          </div>
          {dirty && (
            <button className="btn-save" onClick={handleSave} disabled={saving} style={{ flex: 'initial' }}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save T/S ratio'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
