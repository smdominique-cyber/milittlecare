// Provider parent-acknowledgment dashboard (PR #12 § 10.4).
//
// Three surfaces on one page:
//   1. State counts across the last 30 days (acknowledged, flagged,
//      override, tampered, unacknowledged).
//   2. Active flags list — every unresolved parent flag, with three
//      resolution actions (edit attendance, provider explained, parent
//      withdrew flag).
//   3. Override modal — provider attests for a segment the parent
//      didn't acknowledge, with required reason.
//
// Loads everything once on mount; refetches after each write. Same
// shape-tolerant helpers as the parent-side page; state derived via
// `countAcknowledgmentStates` and `getAcknowledgmentState` so the view
// matches what the validation engine sees.

import { useEffect, useMemo, useState } from 'react'
import { Loader, AlertCircle, Flag, CheckCircle, X, ClipboardCheck, Edit2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import {
  ACK_STATE,
  computeAttendanceHash,
  countAcknowledgmentStates,
  getAcknowledgmentState,
} from '@/lib/parentAcknowledgment'

const LOOKBACK_DAYS = 30

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

function formatDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

function formatTime(hms) {
  if (!hms) return ''
  const [h, m] = String(hms).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hms
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${hour12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

export default function ProviderAcknowledgmentsPage() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)

  const [childrenById, setChildrenById] = useState({})
  const [attendanceById, setAttendanceById] = useState({})  // segment lookup by id
  const [attendance, setAttendance] = useState([])
  const [acknowledgments, setAcknowledgments] = useState([])
  const [flags, setFlags] = useState([])

  const [resolving, setResolving] = useState(null)        // { flag } modal state
  const [overriding, setOverriding] = useState(null)      // { record } modal state
  const [working, setWorking] = useState(null)            // id currently saving
  const [settings, setSettings] = useState(null)          // profiles ack-settings row
  const [savingSettings, setSavingSettings] = useState(false)

  // --- data load -----------------------------------------------------------

  useEffect(() => {
    if (!user?.id) return
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const loadAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const startDate = addDaysYMD(todayYMD(), -LOOKBACK_DAYS)
      const endDate = todayYMD()

      // Provider ack-settings (the six columns added in migration 020).
      const { data: settingsRow } = await supabase
        .from('profiles')
        .select('acknowledgment_cadence, acknowledgment_strictness, acknowledgment_email_enabled, acknowledgment_email_send_day, acknowledgment_email_send_hour, acknowledgment_email_timezone')
        .eq('id', user.id)
        .maybeSingle()
      setSettings(settingsRow || {})

      // Families this provider owns → children → attendance + acks + flags.
      const { data: families } = await supabase
        .from('families')
        .select('id')
        .eq('user_id', user.id)
      const familyIds = (families || []).map(f => f.id)
      if (familyIds.length === 0) {
        setChildrenById({}); setAttendance([]); setAttendanceById({})
        setAcknowledgments([]); setFlags([])
        setLoading(false); return
      }

      // Includes archived children (PR #13): a recently-archived child may
      // still have pending acknowledgment flags/segments to resolve.
      const { data: kids } = await supabase
        .from('children')
        .select('id, first_name, last_name, family_id')
        .in('family_id', familyIds)
      const kidsList = kids || []
      const kidsMap = {}
      for (const k of kidsList) kidsMap[k.id] = k
      setChildrenById(kidsMap)
      const childIds = kidsList.map(k => k.id)
      if (childIds.length === 0) {
        setAttendance([]); setAttendanceById({}); setAcknowledgments([]); setFlags([])
        setLoading(false); return
      }

      const [att, acks, fl] = await Promise.all([
        supabase
          .from('attendance')
          .select('id, child_id, date, segment_index, status, check_in, check_out')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .eq('status', 'present'),
        supabase
          .from('attendance_acknowledgments')
          .select('id, attendance_id, child_id, date, segment_index, acknowledged_via, acknowledged_by_user_id, attendance_snapshot_hash, provider_override_reason, archived_at')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .is('archived_at', null),
        supabase
          .from('acknowledgment_flags')
          .select('id, child_id, date, segment_index, attendance_id, reason, flagged_at, flagged_by_user_id, resolved_at, resolution_action, resolution_note, archived_at')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .is('archived_at', null),
      ])

      const attList = att.data || []
      const attMap = {}
      for (const a of attList) attMap[a.id] = a
      setAttendanceById(attMap)
      setAttendance(attList)
      setAcknowledgments(acks.data || [])
      setFlags(fl.data || [])
    } catch (err) {
      console.error('ProviderAcknowledgmentsPage: load failed', err)
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  // --- derived counts and active-flag list ---------------------------------

  const stateCounts = useMemo(
    () => countAcknowledgmentStates({ attendance, acknowledgments, flags }),
    [attendance, acknowledgments, flags]
  )

  const unresolvedFlags = useMemo(
    () => (flags || []).filter(f => !f.resolved_at && !f.archived_at),
    [flags]
  )

  // --- unacknowledged-billed segments for the override flow ---------------

  const unacknowledgedSegments = useMemo(() => {
    const list = []
    for (const rec of attendance) {
      if (rec.status !== 'present') continue
      const state = getAcknowledgmentState(rec, acknowledgments, flags)
      if (state === ACK_STATE.UNACKNOWLEDGED || state === ACK_STATE.TAMPERED) {
        list.push(rec)
      }
    }
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return list
  }, [attendance, acknowledgments, flags])

  // --- writes -------------------------------------------------------------

  const handleResolveFlag = async ({ flag, action, note }) => {
    if (!user?.id) return
    const trimmed = (note || '').trim()
    if (trimmed.length < 5) {
      setMessage({ type: 'error', text: 'Please add a brief resolution note (at least 5 characters).' })
      return
    }
    setWorking(flag.id)
    setMessage(null)
    try {
      const { error: e } = await supabase
        .from('acknowledgment_flags')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by_user_id: user.id,
          resolution_action: action,
          resolution_note: trimmed,
        })
        .eq('id', flag.id)
      if (e) throw e
      setResolving(null)
      setMessage({ type: 'success', text: '✓ Flag resolved' })
      await loadAll()
    } catch (err) {
      console.error('Resolve failed', err)
      setMessage({ type: 'error', text: err.message || 'Couldn’t resolve. Try again.' })
    } finally {
      setWorking(null)
    }
  }

  const handleOverride = async ({ record, reason }) => {
    if (!user?.id) return
    const trimmed = (reason || '').trim()
    if (trimmed.length < 10) {
      setMessage({ type: 'error', text: 'Reason must be at least 10 characters (e.g., "Parent confirmed verbally at pickup 5/16").' })
      return
    }
    setWorking(record.id)
    setMessage(null)
    try {
      const payload = {
        attendance_id: record.id,
        child_id: record.child_id,
        date: record.date,
        segment_index: record.segment_index ?? 0,
        acknowledged_by_user_id: user.id,
        acknowledged_via: 'provider_override',
        attendance_snapshot_hash: computeAttendanceHash(record),
        provider_override_reason: trimmed,
      }
      const { error: e } = await supabase
        .from('attendance_acknowledgments')
        .insert(payload)
      if (e) throw e
      setOverriding(null)
      setMessage({ type: 'success', text: '✓ Override recorded' })
      await loadAll()
    } catch (err) {
      console.error('Override failed', err)
      setMessage({ type: 'error', text: err.message || 'Couldn’t record override. Try again.' })
    } finally {
      setWorking(null)
    }
  }

  // --- render -------------------------------------------------------------

  if (loading) {
    return (
      <div style={pageShellStyle}>
        <p style={loadingStyle}>Loading parent acknowledgments…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={pageShellStyle}>
        <div role="alert" style={errorBannerStyle}>
          <AlertCircle size={14} />
          Couldn’t load acknowledgment data: {error}
        </div>
      </div>
    )
  }

  return (
    <div style={pageShellStyle}>
      <header>
        <h2 style={pageTitleStyle}>Parent Acknowledgments</h2>
        <p style={subtitleStyle}>
          Last 30 days. Parents review and confirm billed hours from the parent portal;
          you can override or resolve disputes here.
        </p>
      </header>

      {message && (
        <div role="alert" style={messageStyle(message.type)}>
          {message.text}
        </div>
      )}

      <SettingsCard
        settings={settings}
        saving={savingSettings}
        onSave={async (next) => {
          setSavingSettings(true)
          setMessage(null)
          try {
            const { error: e } = await supabase
              .from('profiles')
              .update(next)
              .eq('id', user.id)
            if (e) throw e
            setSettings(next)
            setMessage({ type: 'success', text: '✓ Settings saved' })
          } catch (err) {
            setMessage({ type: 'error', text: err.message || 'Couldn’t save settings' })
          } finally {
            setSavingSettings(false)
          }
        }}
      />

      {/* Counts strip */}
      <section style={cardStyle}>
        <h3 style={sectionTitleStyle}>This 30-day window</h3>
        <div style={statsGridStyle}>
          <Stat label="Confirmed by parent" value={stateCounts[ACK_STATE.ACKNOWLEDGED_CLEAN]} color="var(--clr-success, #4a6957)" />
          <Stat label="Provider override" value={stateCounts[ACK_STATE.ACKNOWLEDGED_OVERRIDE]} color="var(--clr-ink-mid)" />
          <Stat label="Flagged by parent" value={stateCounts[ACK_STATE.FLAGGED]} color="var(--clr-warn-ink, #8a6a1a)" />
          <Stat label="Needs re-confirm (edited)" value={stateCounts[ACK_STATE.TAMPERED]} color="var(--clr-warn-ink, #8a6a1a)" />
          <Stat label="Unacknowledged" value={stateCounts[ACK_STATE.UNACKNOWLEDGED]} color="var(--clr-danger, #b00020)" />
        </div>
      </section>

      {/* Active flags */}
      <section style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          Active flags
          {unresolvedFlags.length > 0 && (
            <span style={{ marginLeft: 8, fontSize: '0.875rem', color: 'var(--clr-warn-ink, #8a6a1a)' }}>
              ({unresolvedFlags.length} awaiting your review)
            </span>
          )}
        </h3>
        {unresolvedFlags.length === 0 ? (
          <p style={emptyStyle}>
            <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: 4, color: 'var(--clr-success, #4a6957)' }} />
            No active flags. Disputes from parents will appear here.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {unresolvedFlags.map(flag => {
              const att = attendanceById[flag.attendance_id]
              const child = childrenById[flag.child_id]
              return (
                <FlagRow
                  key={flag.id}
                  flag={flag}
                  attendance={att}
                  child={child}
                  onResolve={() => setResolving({ flag })}
                />
              )
            })}
          </div>
        )}
      </section>

      {/* Unacknowledged segments — override list */}
      <section style={cardStyle}>
        <h3 style={sectionTitleStyle}>
          Unacknowledged billed segments
          {unacknowledgedSegments.length > 0 && (
            <span style={{ marginLeft: 8, fontSize: '0.875rem', color: 'var(--clr-ink-soft)' }}>
              ({unacknowledgedSegments.length} in window)
            </span>
          )}
        </h3>
        {unacknowledgedSegments.length === 0 ? (
          <p style={emptyStyle}>Every billed segment in this window has been acknowledged.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {unacknowledgedSegments.slice(0, 20).map(rec => (
              <UnackedRow
                key={rec.id}
                record={rec}
                child={childrenById[rec.child_id]}
                onOverride={() => setOverriding({ record: rec })}
              />
            ))}
            {unacknowledgedSegments.length > 20 && (
              <p style={emptyStyle}>
                Showing 20 of {unacknowledgedSegments.length}. Use the I-Billing review grid (PR #9) for full-period work.
              </p>
            )}
          </div>
        )}
      </section>

      {resolving && (
        <ResolveFlagModal
          flag={resolving.flag}
          attendance={attendanceById[resolving.flag.attendance_id]}
          child={childrenById[resolving.flag.child_id]}
          working={working === resolving.flag.id}
          onClose={() => setResolving(null)}
          onSubmit={(action, note) => handleResolveFlag({ flag: resolving.flag, action, note })}
        />
      )}

      {overriding && (
        <OverrideModal
          record={overriding.record}
          child={childrenById[overriding.record.child_id]}
          working={working === overriding.record.id}
          onClose={() => setOverriding(null)}
          onSubmit={(reason) => handleOverride({ record: overriding.record, reason })}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const HOURS = Array.from({ length: 24 }, (_, i) => {
  const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i
  const ampm = i >= 12 ? 'PM' : 'AM'
  return { value: i, label: `${hour12}:00 ${ampm}` }
})

function SettingsCard({ settings, saving, onSave }) {
  const [form, setForm] = useState(null)
  useEffect(() => {
    if (!settings) return
    setForm({
      acknowledgment_cadence:           settings.acknowledgment_cadence || 'weekly',
      acknowledgment_strictness:        settings.acknowledgment_strictness || 'warning',
      acknowledgment_email_enabled:     settings.acknowledgment_email_enabled !== false,
      acknowledgment_email_send_day:    settings.acknowledgment_email_send_day ?? 5,
      acknowledgment_email_send_hour:   settings.acknowledgment_email_send_hour ?? 17,
      acknowledgment_email_timezone:    settings.acknowledgment_email_timezone || 'America/Detroit',
    })
  }, [settings])

  if (!form) return null

  const update = (key) => (value) => setForm(f => ({ ...f, [key]: value }))

  return (
    <section style={cardStyle}>
      <h3 style={sectionTitleStyle}>Settings</h3>
      <p style={emptyStyle}>
        Controls when and how parents are reminded to review billed hours.
        Strict mode blocks I-Billing export when any billed day is unacknowledged.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <div className="form-field-group">
          <label className="field-label">Email reminders</label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.acknowledgment_email_enabled}
              onChange={(e) => update('acknowledgment_email_enabled')(e.target.checked)} />
            <span>Send weekly/daily digest emails to parents</span>
          </label>
        </div>

        <div className="form-field-group">
          <label className="field-label">Cadence</label>
          <select className="field-input"
            value={form.acknowledgment_cadence}
            onChange={(e) => update('acknowledgment_cadence')(e.target.value)}>
            <option value="weekly">Weekly</option>
            <option value="daily">Daily</option>
          </select>
        </div>

        <div className="form-field-group">
          <label className="field-label">Strictness</label>
          <select className="field-input"
            value={form.acknowledgment_strictness}
            onChange={(e) => update('acknowledgment_strictness')(e.target.value)}>
            <option value="warning">Warning — surface unacknowledged days but allow billing</option>
            <option value="strict">Strict — block I-Billing export until every day is acknowledged</option>
          </select>
        </div>

        {form.acknowledgment_cadence === 'weekly' && (
          <div className="form-field-group">
            <label className="field-label">Send day</label>
            <select className="field-input"
              value={form.acknowledgment_email_send_day}
              onChange={(e) => update('acknowledgment_email_send_day')(Number(e.target.value))}>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}

        <div className="form-field-group">
          <label className="field-label">Send hour (provider local time)</label>
          <select className="field-input"
            value={form.acknowledgment_email_send_hour}
            onChange={(e) => update('acknowledgment_email_send_hour')(Number(e.target.value))}>
            {HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
          </select>
        </div>

        <div className="form-field-group">
          <label className="field-label">Timezone (IANA)</label>
          <input className="field-input" type="text"
            value={form.acknowledgment_email_timezone}
            onChange={(e) => update('acknowledgment_email_timezone')(e.target.value)}
            placeholder="America/Detroit" />
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        <button className="btn-save" disabled={saving} onClick={() => onSave(form)}
          style={{ flex: 'initial', padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </section>
  )
}

function Stat({ label, value, color }) {
  return (
    <div style={statStyle}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', color }}>{value}</div>
      <div style={statLabelStyle}>{label}</div>
    </div>
  )
}

function FlagRow({ flag, attendance, child, onResolve }) {
  return (
    <div style={flagRowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <Flag size={14} style={{ color: 'var(--clr-warn-ink, #8a6a1a)' }} />
          <strong>{child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}</strong>
          <span style={{ color: 'var(--clr-ink-soft)' }}>· {formatDate(flag.date)}</span>
          {attendance && (
            <span style={{ color: 'var(--clr-ink-soft)' }}>
              · {formatTime(attendance.check_in)}–{formatTime(attendance.check_out)}
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.875rem', color: 'var(--clr-ink-mid)' }}>
          "{flag.reason}"
        </div>
      </div>
      <button onClick={onResolve} style={buttonPrimaryStyle}>
        Resolve
      </button>
    </div>
  )
}

function UnackedRow({ record, child, onOverride }) {
  return (
    <div style={flagRowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <strong>{child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}</strong>
          <span style={{ color: 'var(--clr-ink-soft)' }}>· {formatDate(record.date)}</span>
          <span style={{ color: 'var(--clr-ink-soft)' }}>
            · {formatTime(record.check_in)}–{formatTime(record.check_out)}
          </span>
        </div>
      </div>
      <button onClick={onOverride} style={buttonSecondaryStyle}>
        <Edit2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
        Override
      </button>
    </div>
  )
}

function ResolveFlagModal({ flag, attendance, child, working, onClose, onSubmit }) {
  const [action, setAction] = useState('provider_explained')
  const [note, setNote] = useState('')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">Resolve flag</span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, color: 'var(--clr-ink-mid)', fontSize: '0.875rem' }}>
            <strong>{child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}</strong>
            {' · '}{formatDate(flag.date)}
            {attendance && (<>{' · '}{formatTime(attendance.check_in)}–{formatTime(attendance.check_out)}</>)}
          </p>
          <div style={{
            background: 'var(--clr-warn-pale, #fdf3d8)',
            padding: 'var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--clr-warm-mid)',
            fontSize: '0.875rem',
            color: 'var(--clr-ink)',
          }}>
            <strong>Parent's reason:</strong> {flag.reason}
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <legend className="field-label" style={{ marginBottom: 6 }}>Resolution action</legend>
            <RadioOption
              value="attendance_corrected"
              checked={action === 'attendance_corrected'}
              onChange={setAction}
              label="I corrected the attendance entry"
              hint="Edit the attendance row separately; this records you fixed it."
            />
            <RadioOption
              value="provider_explained"
              checked={action === 'provider_explained'}
              onChange={setAction}
              label="I talked to the parent and explained"
              hint="No attendance change needed; conversation resolved it."
            />
            <RadioOption
              value="parent_withdrew_flag"
              checked={action === 'parent_withdrew_flag'}
              onChange={setAction}
              label="The parent withdrew the flag"
              hint="They contacted you to say nevermind."
            />
          </fieldset>

          <div className="form-field-group">
            <label className="field-label">Resolution note (required)</label>
            <textarea
              className="field-input"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Brief explanation for the audit trail"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-discard" onClick={onClose} disabled={working}>Cancel</button>
          <button
            className="btn-save"
            onClick={() => onSubmit(action, note)}
            disabled={working || note.trim().length < 5}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
          >
            {working ? 'Saving…' : 'Resolve flag'}
          </button>
        </div>
      </div>
    </div>
  )
}

function OverrideModal({ record, child, working, onClose, onSubmit }) {
  const [reason, setReason] = useState('')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">Mark as acknowledged (override)</span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, color: 'var(--clr-ink-mid)', fontSize: '0.875rem' }}>
            <strong>{child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}</strong>
            {' · '}{formatDate(record.date)}
            {' · '}{formatTime(record.check_in)}–{formatTime(record.check_out)}
          </p>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-mid)' }}>
            Use this when a parent confirmed verbally and isn't going to use the portal.
            The override is logged separately from parent confirmations in the audit trail.
          </p>
          <div className="form-field-group">
            <label className="field-label">Reason (required, at least 10 characters)</label>
            <textarea
              className="field-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Parent confirmed verbally at pickup on 5/16"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-discard" onClick={onClose} disabled={working}>Cancel</button>
          <button
            className="btn-save"
            onClick={() => onSubmit(reason)}
            disabled={working || reason.trim().length < 10}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
          >
            {working ? 'Saving…' : 'Record override'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RadioOption({ value, checked, onChange, label, hint }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: 10, border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-md)', cursor: 'pointer',
      background: checked ? 'var(--clr-cream)' : 'transparent',
    }}>
      <input type="radio" name="resolve-action" value={value} checked={checked}
        onChange={() => onChange(value)} style={{ marginTop: 3, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 500, color: 'var(--clr-ink)' }}>{label}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
          {hint}
        </span>
      </span>
    </label>
  )
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageShellStyle = {
  display: 'flex', flexDirection: 'column', gap: 'var(--space-5)',
  padding: 'var(--space-5)', maxWidth: 960, margin: '0 auto', width: '100%', boxSizing: 'border-box',
}
const pageTitleStyle = {
  fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--clr-ink)', margin: 0,
}
const subtitleStyle = { fontSize: '0.875rem', color: 'var(--clr-ink-soft)', margin: '4px 0 0' }
const sectionTitleStyle = {
  fontFamily: 'var(--font-display)', fontSize: '1.0625rem', color: 'var(--clr-ink)',
  margin: '0 0 var(--space-3)',
}
const cardStyle = {
  background: 'white', border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)',
}
const statsGridStyle = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)',
}
const statStyle = { textAlign: 'center', padding: 'var(--space-3)' }
const statLabelStyle = { fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--clr-ink-soft)' }
const emptyStyle = { fontSize: '0.875rem', color: 'var(--clr-ink-soft)', margin: 0 }
const flagRowStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: 'var(--space-3)',
  border: '1px solid var(--clr-warm-mid)', borderRadius: 'var(--radius-md)',
}
const buttonPrimaryStyle = {
  background: 'var(--clr-sage-dark)', border: 'none', color: 'white',
  padding: '8px 14px', borderRadius: 'var(--radius-md)',
  fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', flexShrink: 0,
}
const buttonSecondaryStyle = {
  background: 'transparent', border: '1px solid var(--clr-warm-mid)',
  padding: '8px 12px', borderRadius: 'var(--radius-md)',
  fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', cursor: 'pointer', flexShrink: 0,
}
const errorBannerStyle = {
  display: 'flex', alignItems: 'center', gap: 6,
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)', fontSize: '0.875rem',
}
const loadingStyle = { margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-soft)' }
function messageStyle(type) {
  if (type === 'error') return errorBannerStyle
  return {
    background: '#e3efe7', border: '1px solid var(--clr-success, #4a6957)',
    color: 'var(--clr-success-dark, #3c5c48)',
    borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)',
    fontSize: '0.875rem',
  }
}
