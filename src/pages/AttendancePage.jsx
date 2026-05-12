import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useRole } from '@/hooks/useRole'
import { useAuth } from '@/hooks/useAuth'
import { ChevronLeft, ChevronRight, StickyNote, X, Check, Trash2, Plus } from 'lucide-react'
import AttendanceExportButton from '@/components/ui/AttendanceExportButton'
import '@/styles/attendance.css'

const STATUS_OPTIONS = [
  { value: 'present',  label: 'Present' },
  { value: 'absent',   label: 'Absent' },
  { value: 'sick',     label: 'Sick' },
  { value: 'vacation', label: 'Vacation' },
  { value: 'holiday',  label: 'Holiday' },
]

// ─── Date helpers ─────────────────────────────
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseYMD(s) {
  return new Date(s + 'T12:00:00')
}

function addDays(d, n) {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

function startOfWeek(d) {
  // Monday as start of week
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return addDays(d, diff)
}

function formatDayHeading(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function formatWeekRange(start) {
  const end = addDays(start, 6)
  const sameMonth = start.getMonth() === end.getMonth()
  if (sameMonth) {
    return `${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`
  }
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`
}

function formatTimeDisplay(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour24 = parseInt(h)
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24
  const ampm = hour24 >= 12 ? 'PM' : 'AM'
  return `${hour12}:${m} ${ampm}`
}

function isSameDay(a, b) {
  return ymd(a) === ymd(b)
}

// ─── Component ────────────────────────────────
export default function AttendancePage() {
  const { user } = useAuth()
  const { licenseeId } = useRole()

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [hideEmpty, setHideEmpty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [children, setChildren] = useState([])
  const [families, setFamilies] = useState([])
  const [records, setRecords] = useState([])
  const [editingNoteFor, setEditingNoteFor] = useState(null) // { childId, date }
  const [noteDraft, setNoteDraft] = useState('')
  const [working, setWorking] = useState(null) // recordKey while saving

  const today = new Date()
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const weekStartYMD = ymd(weekStart)
  const weekEndYMD = ymd(addDays(weekStart, 6))

  useEffect(() => {
    if (licenseeId) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseeId, weekStartYMD])

  async function loadAll() {
    setLoading(true)
    const [familiesResp, childrenResp, recordsResp] = await Promise.all([
      supabase.from('families')
        .select('id, family_name, enrollment_status')
        .eq('user_id', licenseeId)
        .eq('enrollment_status', 'active'),
      supabase.from('children')
        .select('id, first_name, last_name, family_id')
        .eq('user_id', licenseeId),
      supabase.from('attendance')
        .select('*')
        .eq('user_id', licenseeId)
        .gte('date', weekStartYMD)
        .lte('date', weekEndYMD),
    ])

    const activeFamilies = familiesResp.data || []
    const activeFamilyIds = new Set(activeFamilies.map(f => f.id))
    const activeChildren = (childrenResp.data || []).filter(c => activeFamilyIds.has(c.family_id))

    setFamilies(activeFamilies)
    setChildren(activeChildren)
    setRecords(recordsResp.data || [])
    setLoading(false)
  }

  function getRecord(childId, dateStr) {
    return records.find(r => r.child_id === childId && r.date === dateStr)
  }

  function familyNameFor(childId) {
    const c = children.find(x => x.id === childId)
    if (!c) return ''
    return families.find(f => f.id === c.family_id)?.family_name || ''
  }

  // ─── Mutations ─────────────────────────────
  async function upsertField(child, dateStr, field, value) {
    const existing = getRecord(child.id, dateStr)
    const key = `${child.id}-${dateStr}`
    setWorking(key)

    if (existing) {
      const { error } = await supabase
        .from('attendance')
        .update({ [field]: value || null })
        .eq('id', existing.id)
      if (!error) {
        setRecords(rs => rs.map(r => r.id === existing.id ? { ...r, [field]: value || null } : r))
      }
    } else {
      // Creating a new record. Default status = present if check_in or check_out is set.
      const payload = {
        user_id: licenseeId,
        child_id: child.id,
        date: dateStr,
        status: field === 'status' ? value : 'present',
        [field]: value || null,
      }
      // If creating via time, mark provider-recorded
      if (field === 'check_in' || field === 'check_out') {
        payload[field === 'check_in' ? 'checked_in_by' : 'checked_out_by'] = 'provider'
        payload[field === 'check_in' ? 'checked_in_by_user_id' : 'checked_out_by_user_id'] = user?.id
      }
      const { data, error } = await supabase
        .from('attendance')
        .insert(payload)
        .select()
        .single()
      if (!error && data) {
        setRecords(rs => [...rs, data])
      }
    }
    setWorking(null)
  }

  async function setStatus(child, dateStr, newStatus) {
    await upsertField(child, dateStr, 'status', newStatus)
  }

  async function setTime(child, dateStr, field, newTime) {
    const cleanTime = newTime || null
    await upsertField(child, dateStr, field, cleanTime)
  }

  async function saveNote(child, dateStr, noteText) {
    await upsertField(child, dateStr, 'notes', noteText.trim() || null)
    setEditingNoteFor(null)
    setNoteDraft('')
  }

  async function deleteRecord(child, dateStr) {
    const existing = getRecord(child.id, dateStr)
    if (!existing) return
    if (!window.confirm(`Delete ${child.first_name}'s attendance for this day?`)) return
    const key = `${child.id}-${dateStr}`
    setWorking(key)
    const { error } = await supabase.from('attendance').delete().eq('id', existing.id)
    if (!error) {
      setRecords(rs => rs.filter(r => r.id !== existing.id))
    }
    setWorking(null)
  }

  async function addEmptyRecord(child, dateStr) {
    await upsertField(child, dateStr, 'status', 'present')
  }

  function openNoteEditor(child, dateStr) {
    const existing = getRecord(child.id, dateStr)
    setEditingNoteFor({ childId: child.id, date: dateStr })
    setNoteDraft(existing?.notes || '')
  }

  // ─── Render helpers ────────────────────────
  function renderKidRow(child, dateStr, dayDate) {
    const rec = getRecord(child.id, dateStr)
    const key = `${child.id}-${dateStr}`
    const isWorking = working === key
    const isEditingNote = editingNoteFor?.childId === child.id && editingNoteFor?.date === dateStr

    const status = rec?.status || 'present'
    const isAbsent = status === 'absent'
    const hasNonPresentStatus = rec && status !== 'present'

    return (
      <div key={key}>
        <div className={`att-kid-row ${rec ? 'has-record' : 'no-record'} ${isAbsent ? 'absent' : ''}`}>
          <div className="att-kid-info">
            <div className="att-kid-name">{child.first_name} {child.last_name}</div>
            <div className="att-kid-family">{familyNameFor(child.id)}</div>
          </div>

          {/* Check-in */}
          <div className="att-time-cell" data-label="In">
            {isAbsent ? (
              <span className="att-status-pill absent">Absent</span>
            ) : (
              <input
                type="time"
                className={`att-time-input ${!rec?.check_in ? 'empty' : ''}`}
                value={rec?.check_in || ''}
                onChange={(e) => {
                  // Update locally for snappy UI; will be saved on blur
                  setRecords(rs => {
                    if (rec) return rs.map(r => r.id === rec.id ? { ...r, check_in: e.target.value || null } : r)
                    return rs
                  })
                }}
                onBlur={(e) => setTime(child, dateStr, 'check_in', e.target.value)}
                disabled={isWorking}
              />
            )}
          </div>

          {/* Check-out */}
          <div className="att-time-cell" data-label="Out">
            {isAbsent ? (
              <span style={{ color: 'var(--clr-ink-soft)', fontSize: '0.8125rem' }}>—</span>
            ) : (
              <input
                type="time"
                className={`att-time-input ${!rec?.check_out ? 'empty' : ''}`}
                value={rec?.check_out || ''}
                onChange={(e) => {
                  setRecords(rs => {
                    if (rec) return rs.map(r => r.id === rec.id ? { ...r, check_out: e.target.value || null } : r)
                    return rs
                  })
                }}
                onBlur={(e) => setTime(child, dateStr, 'check_out', e.target.value)}
                disabled={isWorking}
              />
            )}
          </div>

          {/* Status */}
          <div className="att-status-cell" data-label="Status">
            {rec ? (
              <select
                className="att-status-select"
                value={status}
                onChange={(e) => setStatus(child, dateStr, e.target.value)}
                disabled={isWorking}
              >
                {STATUS_OPTIONS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            ) : (
              <button
                className="att-add-btn"
                onClick={() => addEmptyRecord(child, dateStr)}
                disabled={isWorking}
              >
                <Plus size={12} style={{ verticalAlign: '-1px' }} /> Add
              </button>
            )}
          </div>

          {/* Actions */}
          <div className="att-actions">
            {rec && (
              <button
                className={`att-icon-btn ${rec.notes ? 'has-note' : ''}`}
                onClick={() => openNoteEditor(child, dateStr)}
                title={rec.notes ? 'Edit note' : 'Add note'}
              >
                <StickyNote size={13} />
              </button>
            )}
            {rec && (
              <button
                className="att-icon-btn danger"
                onClick={() => deleteRecord(child, dateStr)}
                title="Delete record"
                disabled={isWorking}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Note editor (expanded under the row) */}
        {isEditingNote && (
          <div className="att-note-row">
            <textarea
              className="att-note-input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add a note (sick, late, parent comment, etc.)"
              autoFocus
            />
            <div className="att-note-actions">
              <button
                className="att-nav-btn"
                onClick={() => { setEditingNoteFor(null); setNoteDraft('') }}
              >
                <X size={13} /> Cancel
              </button>
              <button
                className="att-add-btn"
                onClick={() => saveNote(child, dateStr, noteDraft)}
              >
                <Check size={13} style={{ verticalAlign: '-1px' }} /> Save note
              </button>
            </div>
          </div>
        )}

        {/* Inline note display when present and not editing */}
        {!isEditingNote && rec?.notes && (
          <div style={{
            padding: '4px 18px 12px 18px',
            background: rec.status === 'absent' ? '#fdf9f2' : 'white',
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-mid)',
            lineHeight: 1.5,
            borderBottom: '1px solid var(--clr-warm-mid)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
          }}>
            <StickyNote size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-sage-dark)' }} />
            <span style={{ fontStyle: 'italic' }}>{rec.notes}</span>
          </div>
        )}
      </div>
    )
  }

  // ─── Top-level render ────────────────────────
  return (
    <div className="att-page">
      <div className="att-header">
        <h2>Attendance</h2>
        <p className="att-header-sub">
          Track attendance across the week. Click any time to edit, or use notes to record context (sick, late, etc).
        </p>

        <div className="att-week-nav">
          <div className="att-week-nav-buttons">
            <button
              className="att-nav-btn"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              title="Previous week"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <span className="att-week-label">{formatWeekRange(weekStart)}</span>
            <button
              className="att-nav-btn"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              title="Next week"
            >
              Next <ChevronRight size={14} />
            </button>
            {!isSameDay(weekStart, startOfWeek(today)) && (
              <button
                className="att-nav-btn today"
                onClick={() => setWeekStart(startOfWeek(today))}
              >
                This week
              </button>
            )}
          </div>
          <AttendanceExportButton
            licenseeId={licenseeId}
            businessName={null}
            providerName={user?.user_metadata?.full_name}
          />
        </div>

        <div className="att-controls-row">
          <label className="att-toggle">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => setHideEmpty(e.target.checked)}
            />
            Hide kids with no records this week
          </label>
          <span className="att-summary">
            {children.length} {children.length === 1 ? 'child' : 'children'} in {families.length} {families.length === 1 ? 'family' : 'families'}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="att-empty">
          <div className="loading-spinner" style={{ margin: '0 auto' }} />
          <div style={{ marginTop: 12 }}>Loading attendance…</div>
        </div>
      ) : children.length === 0 ? (
        <div className="att-empty">
          <div className="att-empty-icon">📋</div>
          <div className="att-empty-title">No children to track yet</div>
          <div>Add an active family with at least one child, and they'll show up here.</div>
        </div>
      ) : (
        weekDays.map(day => {
          const dateStr = ymd(day)
          const isFuture = day > today && !isSameDay(day, today)
          const isToday = isSameDay(day, today)

          // Filter kids if "hide empty" is on
          const kidsToShow = hideEmpty
            ? children.filter(c => {
                const rec = getRecord(c.id, dateStr)
                return !!rec
              })
            : children

          return (
            <div
              key={dateStr}
              className={`att-day-card ${isToday ? 'is-today' : ''} ${isFuture ? 'is-future' : ''}`}
            >
              <div className="att-day-header">
                <div>
                  <span className="att-day-title">{formatDayHeading(day)}</span>
                  <span className="att-day-title-meta">
                    {kidsToShow.length} of {children.length} shown
                  </span>
                </div>
                {isToday && <span className="att-day-pill">Today</span>}
                {isFuture && <span className="att-day-pill future">Upcoming</span>}
              </div>
              {kidsToShow.length === 0 ? (
                <div style={{
                  padding: '20px 18px',
                  textAlign: 'center',
                  fontSize: '0.875rem',
                  color: 'var(--clr-ink-soft)',
                }}>
                  No records on this day{hideEmpty ? '' : ' — click "Add" next to any child to start'}
                </div>
              ) : (
                kidsToShow.map(child => renderKidRow(child, dateStr, day))
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
