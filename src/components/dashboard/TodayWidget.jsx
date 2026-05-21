import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Clock, Check, AlertCircle, Pencil, Loader, Undo2 } from 'lucide-react'
import AttendanceExportButton from '@/components/ui/AttendanceExportButton'

const STATUS_OPTIONS = [
  { value: 'present',  label: 'Present',  emoji: '✓' },
  { value: 'absent',   label: 'Absent',   emoji: '×' },
  { value: 'sick',     label: 'Sick',     emoji: '🤒' },
  { value: 'vacation', label: 'Vacation', emoji: '🏖️' },
  { value: 'holiday',  label: 'Holiday',  emoji: '🎉' },
]

function todayYMD() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTimeDisplay(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour24 = parseInt(h)
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24
  const ampm = hour24 >= 12 ? 'PM' : 'AM'
  return `${hour12}:${m} ${ampm}`
}

function calcDuration(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null
  const [ih, im] = checkIn.split(':').map(Number)
  const [oh, om] = checkOut.split(':').map(Number)
  const mins = (oh * 60 + om) - (ih * 60 + im)
  if (mins <= 0) return null
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}h ${String(remainingMins).padStart(2, '0')}m`
}

export default function TodayWidget({ licenseeId, userId, businessName, providerName }) {
  const [loading, setLoading] = useState(true)
  const [children, setChildren] = useState([])
  const [families, setFamilies] = useState([])
  const [attendance, setAttendance] = useState([])
  const [working, setWorking] = useState(null)
  const [editing, setEditing] = useState(null)
  const [editTime, setEditTime] = useState('')

  useEffect(() => {
    if (licenseeId) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseeId])

  useEffect(() => {
    if (!licenseeId) return
    const intervalId = setInterval(() => {
      loadAttendanceOnly()
    }, 30000)
    return () => clearInterval(intervalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseeId])

  async function loadAll() {
    setLoading(true)
    const today = todayYMD()
    const [familiesResp, childrenResp, attendanceResp] = await Promise.all([
      supabase.from('families')
        .select('id, family_name, enrollment_status')
        .eq('user_id', licenseeId)
        .eq('enrollment_status', 'active'),
      supabase.from('children')
        .select('id, first_name, last_name, family_id, date_of_birth')
        .eq('user_id', licenseeId),
      supabase.from('attendance')
        .select('*')
        .eq('user_id', licenseeId)
        .eq('date', today),
    ])

    const activeFamilies = familiesResp.data || []
    const activeFamilyIds = new Set(activeFamilies.map(f => f.id))
    const activeChildren = (childrenResp.data || []).filter(c => activeFamilyIds.has(c.family_id))

    setFamilies(activeFamilies)
    setChildren(activeChildren)
    setAttendance(attendanceResp.data || [])
    setLoading(false)
  }

  async function loadAttendanceOnly() {
    const today = todayYMD()
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', licenseeId)
      .eq('date', today)
    if (data) setAttendance(data)
  }

  const getRecord = (childId) => {
    return attendance.find(a => a.child_id === childId)
  }

  const handleCheckIn = async (child) => {
    setWorking(child.id)
    const now = nowHHMM()
    const today = todayYMD()
    const { error } = await supabase
      .from('attendance')
      .upsert({
        user_id: licenseeId,
        child_id: child.id,
        date: today,
        segment_index: 0,  // widget only writes single-segment days; matches migration 019's (child_id, date, segment_index) unique
        check_in: now,
        status: 'present',
        checked_in_by: 'provider',
        checked_in_by_user_id: userId,
      }, { onConflict: 'child_id,date,segment_index' })
    setWorking(null)
    if (!error) await loadAttendanceOnly()
  }

  const handleCheckOut = async (child) => {
    const existing = getRecord(child.id)
    if (!existing) return
    setWorking(child.id)
    const now = nowHHMM()
    const today = todayYMD()
    const { error } = await supabase
      .from('attendance')
      .update({
        check_out: now,
        checked_out_by: 'provider',
        checked_out_by_user_id: userId,
      })
      .eq('child_id', child.id)
      .eq('date', today)
    setWorking(null)
    if (!error) await loadAttendanceOnly()
  }

  // ─── New: Undo a check-in ──────────────────────
  // Removes the entire attendance record for today, returning child to "not arrived"
  const handleUndoCheckIn = async (child) => {
    if (!window.confirm(`Undo ${child.first_name}'s check-in? This will remove the record entirely.`)) return
    setWorking(child.id)
    const today = todayYMD()
    const { error } = await supabase
      .from('attendance')
      .delete()
      .eq('child_id', child.id)
      .eq('date', today)
    setWorking(null)
    if (!error) await loadAttendanceOnly()
  }

  // ─── New: Undo a release (check-out) ──────────
  // Clears only check_out, leaving check_in intact — child returns to "here" state
  const handleUndoCheckOut = async (child) => {
    if (!window.confirm(`Undo ${child.first_name}'s release? They'll go back to "at daycare" status.`)) return
    setWorking(child.id)
    const today = todayYMD()
    const { error } = await supabase
      .from('attendance')
      .update({
        check_out: null,
        checked_out_by: null,
        checked_out_by_user_id: null,
      })
      .eq('child_id', child.id)
      .eq('date', today)
    setWorking(null)
    if (!error) await loadAttendanceOnly()
  }

  const handleMarkAbsent = async (child) => {
    if (!window.confirm(`Mark ${child.first_name} absent today?`)) return
    setWorking(child.id)
    const today = todayYMD()
    await supabase
      .from('attendance')
      .upsert({
        user_id: licenseeId,
        child_id: child.id,
        date: today,
        segment_index: 0,  // single-segment widget; matches migration 019's unique key
        status: 'absent',
        checked_in_by: 'provider',
        checked_in_by_user_id: userId,
      }, { onConflict: 'child_id,date,segment_index' })
    setWorking(null)
    await loadAttendanceOnly()
  }

  const handleClearAbsent = async (child) => {
    setWorking(child.id)
    const today = todayYMD()
    await supabase
      .from('attendance')
      .delete()
      .eq('child_id', child.id)
      .eq('date', today)
    setWorking(null)
    await loadAttendanceOnly()
  }

  const startEdit = (childId, field) => {
    const rec = getRecord(childId)
    setEditing({ childId, field })
    setEditTime(rec?.[field] || nowHHMM())
  }

  const saveEdit = async () => {
    if (!editing) return
    const today = todayYMD()
    setWorking(editing.childId)
    await supabase
      .from('attendance')
      .update({ [editing.field]: editTime })
      .eq('child_id', editing.childId)
      .eq('date', today)
    setWorking(null)
    setEditing(null)
    await loadAttendanceOnly()
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditTime('')
  }

  const states = children.map(c => {
    const rec = getRecord(c.id)
    if (!rec) return { child: c, state: 'not_arrived' }
    if (rec.status === 'absent') return { child: c, state: 'absent', record: rec }
    if (rec.status && rec.status !== 'present') return { child: c, state: 'special', record: rec }
    if (rec.check_in && !rec.check_out) return { child: c, state: 'here', record: rec }
    if (rec.check_in && rec.check_out) return { child: c, state: 'done', record: rec }
    return { child: c, state: 'not_arrived', record: rec }
  })

  const counts = {
    here: states.filter(s => s.state === 'here').length,
    notArrived: states.filter(s => s.state === 'not_arrived').length,
    absent: states.filter(s => s.state === 'absent').length,
    done: states.filter(s => s.state === 'done').length,
  }

  return (
    <div className="today-widget">
      <div className="today-widget-header">
        <div>
          <h3 className="today-widget-title">Today</h3>
          <div className="today-widget-date">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
        <div className="today-widget-summary">
          {children.length === 0 ? (
            <span className="tw-summary-pill muted">No active families yet</span>
          ) : (
            <>
              {counts.here > 0 && <span className="tw-summary-pill here">{counts.here} here</span>}
              {counts.notArrived > 0 && <span className="tw-summary-pill waiting">{counts.notArrived} not arrived</span>}
              {counts.done > 0 && <span className="tw-summary-pill done">{counts.done} done</span>}
              {counts.absent > 0 && <span className="tw-summary-pill absent">{counts.absent} absent</span>}
            </>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 'var(--space-3)',
        }}>
          <AttendanceExportButton
            licenseeId={licenseeId}
            businessName={businessName}
            providerName={providerName}
          />
        </div>
      )}

      {loading ? (
        <div className="today-widget-loading">
          <Loader size={18} className="spin" />
          <span>Loading today…</span>
        </div>
      ) : children.length === 0 ? (
        <div className="today-widget-empty">
          <div className="tw-empty-icon">👋</div>
          <div className="tw-empty-title">No children to check in yet</div>
          <div className="tw-empty-desc">
            Add an active family with at least one child, and they'll show up here.
          </div>
        </div>
      ) : (
        <div className="today-widget-list">
          {states.map(({ child, state, record }) => {
            const familyName = families.find(f => f.id === child.family_id)?.family_name || ''
            const isWorking = working === child.id
            const editingThis = editing?.childId === child.id

            return (
              <div key={child.id} className={`tw-row tw-row-${state}`}>
                <div className="tw-child-info">
                  <div className="tw-child-name">
                    {child.first_name} {child.last_name}
                  </div>
                  <div className="tw-family-name">{familyName}</div>
                </div>

                <div className="tw-state">
                  {state === 'not_arrived' && (
                    <span className="tw-state-text">Not arrived yet</span>
                  )}
                  {state === 'here' && record && (
                    <div className="tw-time-row">
                      {editingThis && editing.field === 'check_in' ? (
                        <div className="tw-time-edit">
                          <input
                            type="time"
                            value={editTime}
                            onChange={(e) => setEditTime(e.target.value)}
                            className="tw-time-input"
                            autoFocus
                          />
                          <button className="tw-mini-btn save" onClick={saveEdit}><Check size={12} /></button>
                          <button className="tw-mini-btn cancel" onClick={cancelEdit}>×</button>
                        </div>
                      ) : (
                        <>
                          <span className="tw-state-text">
                            <Clock size={12} /> In at {formatTimeDisplay(record.check_in)}
                          </span>
                          {record.checked_in_by === 'parent' && (
                            <span className="tw-by-tag">parent</span>
                          )}
                          <button className="tw-mini-btn" onClick={() => startEdit(child.id, 'check_in')} title="Edit time">
                            <Pencil size={10} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {state === 'done' && record && (
                    <div className="tw-time-row">
                      <span className="tw-state-text">
                        {formatTimeDisplay(record.check_in)} – {formatTimeDisplay(record.check_out)}
                        <span className="tw-duration">· {calcDuration(record.check_in, record.check_out)}</span>
                      </span>
                    </div>
                  )}
                  {state === 'absent' && (
                    <span className="tw-state-text">Marked absent</span>
                  )}
                  {state === 'special' && record && (
                    <span className="tw-state-text">
                      {STATUS_OPTIONS.find(s => s.value === record.status)?.emoji}{' '}
                      {STATUS_OPTIONS.find(s => s.value === record.status)?.label}
                    </span>
                  )}
                </div>

                <div className="tw-actions">
                  {state === 'not_arrived' && (
                    <>
                      <button className="tw-action primary" onClick={() => handleCheckIn(child)} disabled={isWorking}>
                        {isWorking ? '…' : 'Drop Off'}
                      </button>
                      <button className="tw-action ghost" onClick={() => handleMarkAbsent(child)} disabled={isWorking} title="Mark absent">
                        Absent
                      </button>
                    </>
                  )}
                  {state === 'here' && (
                    <>
                      <button className="tw-action accent" onClick={() => handleCheckOut(child)} disabled={isWorking}>
                        {isWorking ? '…' : 'Release'}
                      </button>
                      <button
                        className="tw-action ghost"
                        onClick={() => handleUndoCheckIn(child)}
                        disabled={isWorking}
                        title="Undo check-in (mistake)"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Undo2 size={12} /> Undo
                      </button>
                    </>
                  )}
                  {state === 'done' && (
                    <>
                      <span className="tw-done-check"><Check size={16} /></span>
                      <button
                        className="tw-action ghost"
                        onClick={() => handleUndoCheckOut(child)}
                        disabled={isWorking}
                        title="Undo release — back to 'at daycare'"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <Undo2 size={12} /> Undo release
                      </button>
                    </>
                  )}
                  {state === 'absent' && (
                    <button className="tw-action ghost" onClick={() => handleClearAbsent(child)} disabled={isWorking}>
                      Undo
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="today-widget-footer">
        <span style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)' }}>
          Tap to record. Times can be edited if needed.
        </span>
      </div>
    </div>
  )
}
