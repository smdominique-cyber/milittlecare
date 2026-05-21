// Parent acknowledgment review page (PR #12 § 10.2). Reachable from
// the dashboard banner or the weekly Resend digest. Mobile-first.
//
// Lifecycle:
//   1. Resolve session. Unauthenticated → /login (router catches).
//   2. Load parent's families via parent_family_links (active), the
//      children in those families, attendance for the last 30 days,
//      and existing acknowledgments + flags for those segments.
//   3. Render one card per (child × date × segment) for billed
//      segments that aren't cleanly acknowledged or already flagged.
//   4. Confirm → write attendance_acknowledgments row immediately
//      (no batch submit; per spec § 10.2).
//   5. Flag → modal with required reason → write acknowledgment_flags.
//
// State derivation goes through src/lib/parentAcknowledgment.js so the
// page renders the same view the validation engine sees.

import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { AlertCircle, CheckCircle, Loader, X, Flag, ChevronDown } from 'lucide-react'
import {
  computeAttendanceHash,
  getAcknowledgmentState,
  ACK_STATE,
  PARENT_BANNER_LOOKBACK_DAYS,
} from '@/lib/parentAcknowledgment'
import '@/styles/parent.css'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

function formatWeekday(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

function formatTime(hms) {
  if (!hms) return ''
  const [h, m] = String(hms).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hms
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${hour12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

function segmentHours(rec) {
  if (!rec || !rec.check_in || !rec.check_out) return 0
  const parse = hms => {
    const [h, m, s = 0] = String(hms).split(':').map(Number)
    return h + m / 60 + s / 3600
  }
  const a = parse(rec.check_in)
  const b = parse(rec.check_out)
  return b > a ? Math.round((b - a) * 100) / 100 : 0
}

export default function ParentAcknowledgePage() {
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)

  const [showOlder, setShowOlder] = useState(false)
  const [childrenById, setChildrenById] = useState({})
  const [attendance, setAttendance] = useState([])
  const [acknowledgments, setAcknowledgments] = useState([])
  const [flags, setFlags] = useState([])

  const [flagging, setFlagging] = useState(null)   // { record } currently being flagged
  const [working, setWorking] = useState(null)     // record id being saved

  // --- session + data load --------------------------------------------------

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      if (!data.session) {
        navigate('/login', { state: { from: { pathname: '/parent/acknowledge' } } })
        return
      }
      setSession(data.session)
      await loadAll(data.session.user.id, showOlder)
    }
    run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- data loader (re-invoked on showOlder toggle) -------------------------

  const loadAll = async (parentId, includeOlder) => {
    setLoading(true)
    setError(null)
    try {
      const lookbackDays = includeOlder ? 90 : PARENT_BANNER_LOOKBACK_DAYS
      const startDate = addDaysYMD(todayYMD(), -lookbackDays)
      const endDate = todayYMD()

      const { data: links } = await supabase
        .from('parent_family_links')
        .select('family_id')
        .eq('parent_id', parentId)
        .eq('status', 'active')
      const familyIds = (links || []).map(l => l.family_id)
      if (familyIds.length === 0) {
        setChildrenById({}); setAttendance([]); setAcknowledgments([]); setFlags([])
        setLoading(false)
        return
      }

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
        setAttendance([]); setAcknowledgments([]); setFlags([])
        setLoading(false)
        return
      }

      const [att, acks, fl] = await Promise.all([
        supabase
          .from('attendance')
          .select('id, child_id, date, segment_index, status, check_in, check_out, notes')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .eq('status', 'present'),
        supabase
          .from('attendance_acknowledgments')
          .select('id, attendance_id, child_id, date, segment_index, acknowledged_via, acknowledged_at, attendance_snapshot_hash, archived_at')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .is('archived_at', null),
        supabase
          .from('acknowledgment_flags')
          .select('id, child_id, date, segment_index, reason, flagged_at, resolved_at, archived_at')
          .in('child_id', childIds)
          .gte('date', startDate)
          .lte('date', endDate)
          .is('archived_at', null),
      ])

      setAttendance(att.data || [])
      setAcknowledgments(acks.data || [])
      setFlags(fl.data || [])
    } catch (err) {
      console.error('ParentAcknowledgePage: load failed', err)
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  const reload = () => session && loadAll(session.user.id, showOlder)

  // --- derived view: list of action-needed segments grouped by date --------

  const visibleSegments = useMemo(() => {
    const list = []
    for (const rec of attendance) {
      if (segmentHours(rec) <= 0) continue
      const state = getAcknowledgmentState(rec, acknowledgments, flags)
      // Show: UNACKNOWLEDGED + TAMPERED (need parent action). Also show
      // ACKNOWLEDGED_CLEAN and FLAGGED briefly for visual feedback so
      // the parent sees their click landed; the optimistic-update path
      // adds new acks/flags to local state, so these will mostly be
      // recent actions.
      list.push({ record: rec, state })
    }
    // Sort by date desc (newest first), then by child name, then segment.
    list.sort((a, b) => {
      if (a.record.date !== b.record.date) return a.record.date < b.record.date ? 1 : -1
      const an = (childrenById[a.record.child_id]?.first_name || '')
      const bn = (childrenById[b.record.child_id]?.first_name || '')
      if (an !== bn) return an.localeCompare(bn)
      return (a.record.segment_index ?? 0) - (b.record.segment_index ?? 0)
    })
    return list
  }, [attendance, acknowledgments, flags, childrenById])

  const groupedByDate = useMemo(() => {
    const groups = {}
    for (const item of visibleSegments) {
      const key = item.record.date
      groups[key] = groups[key] || []
      groups[key].push(item)
    }
    return groups
  }, [visibleSegments])

  const dateKeysSorted = useMemo(
    () => Object.keys(groupedByDate).sort((a, b) => (a < b ? 1 : -1)),
    [groupedByDate]
  )

  const awaitingCount = visibleSegments.filter(
    v => v.state === ACK_STATE.UNACKNOWLEDGED || v.state === ACK_STATE.TAMPERED
  ).length

  // --- write actions -------------------------------------------------------

  const handleConfirm = async (record) => {
    if (!session?.user?.id) return
    setWorking(record.id)
    setMessage(null)
    try {
      const payload = {
        attendance_id: record.id,
        child_id: record.child_id,
        date: record.date,
        segment_index: record.segment_index ?? 0,
        acknowledged_by_user_id: session.user.id,
        acknowledged_via: 'parent_portal',
        attendance_snapshot_hash: computeAttendanceHash(record),
      }
      const { data, error: insErr } = await supabase
        .from('attendance_acknowledgments')
        .insert(payload)
        .select()
        .single()
      if (insErr) throw insErr
      setAcknowledgments(prev => [...prev, data])
      setMessage({ type: 'success', text: '✓ Confirmed' })
    } catch (err) {
      console.error('ParentAcknowledgePage: confirm failed', err)
      setMessage({ type: 'error', text: err.message || 'Couldn’t confirm. Try again.' })
    } finally {
      setWorking(null)
    }
  }

  const handleFlagSubmit = async (record, reason) => {
    if (!session?.user?.id) return
    const trimmed = (reason || '').trim()
    if (trimmed.length < 5) {
      setMessage({ type: 'error', text: 'Please add a brief reason so your provider knows what to look at.' })
      return
    }
    setWorking(record.id)
    setMessage(null)
    try {
      const payload = {
        child_id: record.child_id,
        date: record.date,
        segment_index: record.segment_index ?? 0,
        attendance_id: record.id,
        flagged_by_user_id: session.user.id,
        reason: trimmed,
      }
      const { data, error: insErr } = await supabase
        .from('acknowledgment_flags')
        .insert(payload)
        .select()
        .single()
      if (insErr) throw insErr
      setFlags(prev => [...prev, data])
      setFlagging(null)
      setMessage({ type: 'success', text: '⚑ Flagged for provider review' })
    } catch (err) {
      console.error('ParentAcknowledgePage: flag failed', err)
      setMessage({ type: 'error', text: err.message || 'Couldn’t flag. Try again.' })
    } finally {
      setWorking(null)
    }
  }

  // --- render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)', marginBottom: 12 }} />
          <div>Loading hours to review…</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>Couldn’t load this page</h2>
          <p style={{ color: 'var(--clr-error)' }}>{error}</p>
          <button className="parent-cta" onClick={reload}>Try again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="parent-shell">
      <div className="parent-card" style={{ maxWidth: 560 }}>
        <header style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Review hours</h2>
          <p style={{ color: 'var(--clr-ink-mid)', margin: '4px 0 0' }}>
            {awaitingCount > 0
              ? `${awaitingCount} ${awaitingCount === 1 ? 'segment' : 'segments'} waiting for your review.`
              : 'All caught up — thanks for confirming.'}
          </p>
        </header>

        {message && (
          <div role="alert" className={`parent-message ${message.type}`}
               style={{ marginBottom: 12 }}>
            <span>{message.text}</span>
          </div>
        )}

        {dateKeysSorted.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--clr-ink-soft)' }}>
            <CheckCircle size={28} style={{ color: 'var(--clr-success)' }} />
            <p style={{ marginTop: 8 }}>
              Nothing to review right now. Your provider will let you know when there's more.
            </p>
          </div>
        ) : (
          dateKeysSorted.map(date => (
            <DayCard
              key={date}
              date={date}
              items={groupedByDate[date]}
              childrenById={childrenById}
              working={working}
              onConfirm={handleConfirm}
              onFlag={(rec) => setFlagging({ record: rec })}
            />
          ))
        )}

        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <button
            onClick={() => { setShowOlder(v => !v); session && loadAll(session.user.id, !showOlder) }}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--clr-sage-dark)', cursor: 'pointer',
              fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <ChevronDown size={14} />
            {showOlder ? 'Show only recent days' : 'Show older periods (90-day backlog)'}
          </button>
        </div>
      </div>

      {flagging && (
        <FlagModal
          record={flagging.record}
          childrenById={childrenById}
          working={working === flagging.record.id}
          onClose={() => setFlagging(null)}
          onSubmit={(reason) => handleFlagSubmit(flagging.record, reason)}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function DayCard({ date, items, childrenById, working, onConfirm, onFlag }) {
  return (
    <div style={{
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-lg)',
      padding: 14,
      marginBottom: 12,
      background: 'white',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8,
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', color: 'var(--clr-ink)' }}>
          {formatWeekday(date)}, {formatDate(date)}
        </div>
      </div>

      {items.map(({ record, state }) => {
        const child = childrenById[record.child_id]
        const hours = segmentHours(record)
        return (
          <SegmentRow
            key={`${record.id}-${record.segment_index ?? 0}`}
            child={child}
            record={record}
            hours={hours}
            state={state}
            saving={working === record.id}
            onConfirm={() => onConfirm(record)}
            onFlag={() => onFlag(record)}
          />
        )
      })}
    </div>
  )
}

function SegmentRow({ child, record, hours, state, saving, onConfirm, onFlag }) {
  const isClean = state === ACK_STATE.ACKNOWLEDGED_CLEAN
  const isFlagged = state === ACK_STATE.FLAGGED
  const isOverride = state === ACK_STATE.ACKNOWLEDGED_OVERRIDE
  const needsAction = state === ACK_STATE.UNACKNOWLEDGED || state === ACK_STATE.TAMPERED

  return (
    <div style={{
      borderTop: '1px solid var(--clr-warm-mid)',
      paddingTop: 10, marginTop: 10,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6,
      }}>
        <div>
          <strong style={{ color: 'var(--clr-ink)' }}>
            {child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}
          </strong>
          {(record.segment_index ?? 0) > 0 && (
            <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--clr-ink-soft)' }}>
              segment {(record.segment_index ?? 0) + 1}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, color: 'var(--clr-ink-mid)' }}>
          {hours.toFixed(2)} h
        </div>
      </div>

      <div style={{ fontSize: 14, color: 'var(--clr-ink-mid)', marginBottom: 8 }}>
        {formatTime(record.check_in)} — {formatTime(record.check_out)}
      </div>

      {isClean && (
        <StatusBadge color="var(--clr-success)" icon={<CheckCircle size={14} />} label="Confirmed" />
      )}
      {isOverride && (
        <StatusBadge color="var(--clr-ink-mid)" icon={<CheckCircle size={14} />} label="Acknowledged by provider" />
      )}
      {isFlagged && (
        <StatusBadge color="var(--clr-warn-ink, #8a6a1a)" icon={<Flag size={14} />} label="Flagged — awaiting provider" />
      )}
      {state === ACK_STATE.TAMPERED && (
        <StatusBadge color="var(--clr-warn-ink, #8a6a1a)" icon={<AlertCircle size={14} />} label="Updated — please confirm again" />
      )}

      {needsAction && (
        <div style={{
          display: 'flex', gap: 8, marginTop: 10,
        }}>
          <button
            className="parent-cta"
            onClick={onConfirm}
            disabled={saving}
            style={{ flex: 1 }}
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <button
            onClick={onFlag}
            disabled={saving}
            style={{
              flex: 1, background: 'transparent',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 12px', fontSize: 14,
              color: 'var(--clr-ink-mid)', cursor: 'pointer',
            }}
          >
            Flag
          </button>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ color, icon, label }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color, fontSize: 13, fontWeight: 500,
    }}>
      {icon}{label}
    </div>
  )
}

function FlagModal({ record, childrenById, working, onClose, onSubmit }) {
  const child = childrenById[record.child_id]
  const reasonId = useId()
  const [reason, setReason] = useState('')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">Flag this segment for your provider</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, color: 'var(--clr-ink-mid)' }}>
            <strong>{child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Child'}</strong>
            {' · '}
            {formatDate(record.date)}
            {' · '}
            {formatTime(record.check_in)}–{formatTime(record.check_out)}
          </p>
          <label htmlFor={reasonId} className="field-label">
            What should your provider look at?
          </label>
          <textarea
            id={reasonId}
            className="field-input"
            rows={3}
            placeholder="e.g. We picked up at 3 PM, not 5 PM"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn-discard" onClick={onClose} disabled={working}>Cancel</button>
          <button
            className="btn-save"
            onClick={() => onSubmit(reason)}
            disabled={working || reason.trim().length < 5}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
          >
            {working ? 'Saving…' : 'Submit flag'}
          </button>
        </div>
      </div>
    </div>
  )
}
