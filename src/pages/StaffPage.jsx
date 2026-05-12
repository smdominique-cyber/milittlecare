import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import {
  Users, Plus, Send, Copy, X, Trash2, Pencil, Check, AlertCircle, Shield, Clock,
  MapPin, ChevronLeft, ChevronRight, DollarSign,
} from 'lucide-react'
import '@/styles/staff.css'

const ROLES = [
  {
    value: 'adult_staff',
    label: 'Co-Provider',
    desc: 'Full trust — handles families, billing, receipts, attendance, messages. Cannot change subscription. Use for a spouse, business partner, or full assistant.',
  },
  {
    value: 'assistant',
    label: 'Daily Helper',
    desc: 'Day-to-day caregiver — attendance, messages, family info. Cannot see or touch billing, invoices, receipts, or any financial information.',
  },
  {
    value: 'view_only',
    label: 'View-only',
    desc: 'Reads deductions, T/S ratio, and attendance reports. Cannot edit anything. Good for an accountant or bookkeeper.',
  },
]

// ─── Date helpers for timesheet ─────────────
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d, n) {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

function startOfWeek(d) {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return addDays(d, diff)
}

function formatWeekRange(start) {
  const end = addDays(start, 6)
  const sameMonth = start.getMonth() === end.getMonth()
  if (sameMonth) {
    return `${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`
  }
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`
}

function formatDateTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function durationMs(entry) {
  if (!entry.clock_in || !entry.clock_out) return 0
  return new Date(entry.clock_out).getTime() - new Date(entry.clock_in).getTime()
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—'
  const totalMins = Math.floor(ms / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  return `${hours}h ${String(mins).padStart(2, '0')}m`
}

function hoursDecimal(ms) {
  if (!ms || ms <= 0) return 0
  return Math.round((ms / 3600000) * 100) / 100
}

// Convert ISO string to local datetime-local input value (YYYY-MM-DDTHH:MM)
function isoToLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

function localInputToISO(local) {
  if (!local) return null
  return new Date(local).toISOString()
}

export default function StaffPage() {
  const { user } = useAuth()
  const [memberships, setMemberships] = useState([])
  const [invitations, setInvitations] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    recipient_name: '',
    recipient_email: '',
    intended_role: 'adult_staff',
    is_18_or_older: true,
  })
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState(null)

  // Timesheet state
  const [timesheetStaffId, setTimesheetStaffId] = useState(null)
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [entries, setEntries] = useState([])
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [editingEntry, setEditingEntry] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [m, i] = await Promise.all([
      supabase.from('staff_memberships').select('*').eq('licensee_id', user.id).eq('status', 'active'),
      supabase.from('staff_invitations').select('*').eq('licensee_id', user.id).order('created_at', { ascending: false }),
    ])

    const memberships = m.data || []
    for (const m of memberships) {
      const { data: p } = await supabase.from('profiles').select('full_name, email').eq('id', m.staff_user_id).maybeSingle()
      m._profile = p
    }
    setMemberships(memberships)
    setInvitations(i.data || [])
    setLoading(false)
  }

  // ─── Timesheet loading ─────────────────────
  useEffect(() => {
    if (!timesheetStaffId) {
      setEntries([])
      return
    }
    loadTimesheet()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timesheetStaffId, weekStart])

  async function loadTimesheet() {
    setEntriesLoading(true)
    const startISO = weekStart.toISOString()
    const endISO = addDays(weekStart, 7).toISOString()
    const { data } = await supabase
      .from('staff_time_entries')
      .select('*')
      .eq('staff_user_id', timesheetStaffId)
      .gte('clock_in', startISO)
      .lt('clock_in', endISO)
      .order('clock_in', { ascending: false })
    setEntries(data || [])
    setEntriesLoading(false)
  }

  // ─── Invite/role/staff handlers (unchanged) ─────
  const sendInvitation = async () => {
    if (!form.recipient_email) return
    setSending(true)
    setMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/send-staff-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(form),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to send')
      const sentMsg = data.email_sent
        ? `Invitation sent to ${form.recipient_email}`
        : `Invitation created. Email could not be sent — share the link directly: ${data.invitation.url}`
      setMessage({ type: data.email_sent ? 'success' : 'info', text: sentMsg })
      setForm({ recipient_name: '', recipient_email: '', intended_role: 'adult_staff', is_18_or_older: true })
      setShowForm(false)
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSending(false)
  }

  const resendInvitation = async (invitation) => {
    setSending(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch('/api/send-staff-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          recipient_name: invitation.recipient_name,
          recipient_email: invitation.recipient_email,
          intended_role: invitation.intended_role,
          is_18_or_older: invitation.is_18_or_older ?? true,
        }),
      })
      setMessage({ type: 'success', text: `Resent to ${invitation.recipient_email}` })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSending(false)
  }

  const revokeInvitation = async (id) => {
    if (!window.confirm('Revoke this invitation?')) return
    await supabase.from('staff_invitations').update({
      status: 'revoked', revoked_at: new Date().toISOString(),
    }).eq('id', id)
    await loadAll()
  }

  const updateRole = async (membershipId, newRole) => {
    await supabase.from('staff_memberships').update({ role: newRole }).eq('id', membershipId)
    setMessage({ type: 'success', text: 'Role updated' })
    await loadAll()
  }

  const updateAgeFlag = async (membershipId, is18) => {
    await supabase.from('staff_memberships').update({ is_18_or_older: is18 }).eq('id', membershipId)
    setMessage({ type: 'success', text: is18 ? 'Marked 18 or older — medication logging enabled' : 'Marked under 18 — medication logging disabled (Michigan R 400.1918)' })
    await loadAll()
  }

  const updateLocationRequired = async (membershipId, required) => {
    await supabase.from('staff_memberships').update({ location_required: required }).eq('id', membershipId)
    setMessage({ type: 'success', text: required ? 'Location capture turned on for this staff member' : 'Location capture turned off' })
    await loadAll()
  }

  const updateHourlyRate = async (membershipId, rate) => {
    const cleanRate = rate === '' || rate == null ? null : parseFloat(rate)
    if (cleanRate != null && (isNaN(cleanRate) || cleanRate < 0)) {
      setMessage({ type: 'error', text: 'Hourly rate must be a positive number' })
      return
    }
    await supabase.from('staff_memberships').update({ hourly_rate: cleanRate }).eq('id', membershipId)
    setMessage({ type: 'success', text: cleanRate == null ? 'Hourly rate cleared' : `Hourly rate set to $${cleanRate.toFixed(2)}/hr` })
    await loadAll()
  }

  const removeStaff = async (m) => {
    if (!window.confirm(`Remove ${m._profile?.full_name || m._profile?.email || 'this staff member'} from your team? They will lose access immediately.`)) return
    await supabase.from('staff_memberships').update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
    }).eq('id', m.id)
    await loadAll()
  }

  const copyLink = async (token) => {
    const link = `${window.location.origin}/staff-invite/${token}`
    try {
      await navigator.clipboard.writeText(link)
      setMessage({ type: 'success', text: 'Link copied' })
    } catch {
      setMessage({ type: 'info', text: link })
    }
  }

  // ─── Provider override: edit time entry ────
  const saveEntryEdit = async () => {
    if (!editingEntry) return
    const original = entries.find(e => e.id === editingEntry.id)
    if (!original) return

    const changes = []
    if (editingEntry.clock_in !== original.clock_in) {
      changes.push({ field: 'clock_in', old: original.clock_in, new: editingEntry.clock_in })
    }
    if (editingEntry.clock_out !== original.clock_out) {
      changes.push({ field: 'clock_out', old: original.clock_out, new: editingEntry.clock_out })
    }
    if ((editingEntry.notes || '') !== (original.notes || '')) {
      changes.push({ field: 'notes', old: original.notes, new: editingEntry.notes })
    }

    if (changes.length === 0) {
      setEditingEntry(null)
      return
    }

    // Update entry
    const { error: updErr } = await supabase
      .from('staff_time_entries')
      .update({
        clock_in: editingEntry.clock_in,
        clock_out: editingEntry.clock_out,
        notes: editingEntry.notes || null,
        edited_by_provider: true,
      })
      .eq('id', editingEntry.id)

    if (updErr) {
      setMessage({ type: 'error', text: updErr.message })
      return
    }

    // Insert audit log rows
    const auditRows = changes.map(c => ({
      time_entry_id: editingEntry.id,
      edited_by_user_id: user.id,
      field_changed: c.field,
      old_value: c.old ? String(c.old) : null,
      new_value: c.new ? String(c.new) : null,
    }))
    await supabase.from('staff_time_audit_log').insert(auditRows)

    setEditingEntry(null)
    setMessage({ type: 'success', text: 'Time entry updated' })
    await loadTimesheet()
  }

  const deleteEntry = async (entry) => {
    if (!window.confirm('Delete this time entry? This cannot be undone (but it will be recorded in the audit log).')) return
    await supabase.from('staff_time_audit_log').insert({
      time_entry_id: entry.id,
      edited_by_user_id: user.id,
      field_changed: 'deleted',
      old_value: JSON.stringify({ clock_in: entry.clock_in, clock_out: entry.clock_out }),
      new_value: null,
    })
    await supabase.from('staff_time_entries').delete().eq('id', entry.id)
    setMessage({ type: 'success', text: 'Entry deleted' })
    await loadTimesheet()
  }

  const pendingInvitations = invitations.filter(i => {
    const expired = new Date(i.expires_at) < new Date()
    return i.status === 'pending' && !expired
  })

  // ─── Timesheet totals ──────────────────────
  const activeMembership = memberships.find(m => m.staff_user_id === timesheetStaffId)
  const weekTotalMs = entries.reduce((s, e) => s + durationMs(e), 0)
  const weekTotalHours = hoursDecimal(weekTotalMs)
  const weekTotalWages = activeMembership?.hourly_rate
    ? Math.round(weekTotalHours * parseFloat(activeMembership.hourly_rate) * 100) / 100
    : null

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  return (
    <>
      <div className="staff-intro">
        <h2>Your Team</h2>
        <p>Invite staff members to help with daily operations. Roles control what each person can do — and Michigan R 400.1918 requires medication be logged only by adult caregivers (18+).</p>
      </div>

      {message && (
        <div className={`staff-message ${message.type}`}>
          {message.text}
        </div>
      )}

      {/* Active team */}
      <div className="staff-section">
        <div className="staff-section-header">
          <h3>Active team ({memberships.length + 1})</h3>
          {!showForm && (
            <button className="staff-add-btn" onClick={() => setShowForm(true)}>
              <Plus size={14} /> Invite team member
            </button>
          )}
        </div>

        {/* You — Licensee */}
        <div className="staff-card licensee">
          <div className="staff-avatar"><Shield size={18} /></div>
          <div className="staff-info">
            <div className="staff-name">
              {user.user_metadata?.full_name || user.email}
              <span className="staff-role-badge licensee">Licensee (you)</span>
            </div>
            <div className="staff-meta">{user.email}</div>
          </div>
        </div>

        {/* Other members */}
        {memberships.map(m => (
          <div key={m.id}>
            <div className="staff-card">
              <div className="staff-avatar">
                {m._profile?.full_name ? m._profile.full_name.charAt(0).toUpperCase() : '?'}
              </div>
              <div className="staff-info">
                <div className="staff-name">
                  {m._profile?.full_name || m._profile?.email || 'Staff member'}
                  <span className={`staff-role-badge ${m.role}`}>
                    {ROLES.find(r => r.value === m.role)?.label || m.role}
                  </span>
                  {!m.is_18_or_older && (
                    <span style={{
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--clr-warm)',
                      color: 'var(--clr-ink-soft)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>
                      Under 18
                    </span>
                  )}
                </div>
                <div className="staff-meta">
                  {m._profile?.email}
                  {m.joined_at && <span> · Joined {new Date(m.joined_at).toLocaleDateString()}</span>}
                </div>
              </div>
              <div className="staff-actions">
                <select
                  value={m.role}
                  onChange={(e) => updateRole(m.id, e.target.value)}
                  className="staff-role-select"
                  title="Change role"
                >
                  {ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: '0.75rem',
                    color: 'var(--clr-ink-mid)',
                    cursor: 'pointer',
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--clr-cream)',
                    border: '1px solid var(--clr-warm-mid)',
                  }}
                  title="If checked, this person can log medication (Michigan R 400.1918)"
                >
                  <input
                    type="checkbox"
                    checked={m.is_18_or_older ?? true}
                    onChange={(e) => updateAgeFlag(m.id, e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  18+
                </label>
                <button className="staff-icon-btn danger" onClick={() => removeStaff(m)} title="Remove">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Per-staff clock-in settings, expanded below card */}
            <div style={{
              marginTop: -4,
              marginBottom: 8,
              marginLeft: 12,
              padding: '10px 14px',
              background: '#fdfcf7',
              border: '1px solid var(--clr-warm-mid)',
              borderTop: 'none',
              borderRadius: '0 0 var(--radius-md) var(--radius-md)',
              fontSize: '0.78125rem',
              color: 'var(--clr-ink-mid)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
            }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={m.location_required ?? false}
                  onChange={(e) => updateLocationRequired(m.id, e.target.checked)}
                  style={{ accentColor: 'var(--clr-sage-dark)', cursor: 'pointer' }}
                />
                <MapPin size={12} /> Capture location on clock in/out
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <DollarSign size={12} /> Hourly rate:
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={m.hourly_rate ?? ''}
                  onBlur={(e) => {
                    if (e.target.value !== String(m.hourly_rate ?? '')) {
                      updateHourlyRate(m.id, e.target.value)
                    }
                  }}
                  placeholder="—"
                  style={{
                    width: 80,
                    padding: '4px 8px',
                    border: '1px solid var(--clr-warm-mid)',
                    borderRadius: 'var(--radius-sm)',
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.8125rem',
                  }}
                />
              </label>
              <button
                onClick={() => setTimesheetStaffId(timesheetStaffId === m.staff_user_id ? null : m.staff_user_id)}
                style={{
                  background: timesheetStaffId === m.staff_user_id ? 'var(--clr-sage-dark)' : 'white',
                  color: timesheetStaffId === m.staff_user_id ? 'white' : 'var(--clr-sage-dark)',
                  border: '1px solid var(--clr-sage-dark)',
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.78125rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginLeft: 'auto',
                }}
              >
                <Clock size={12} /> {timesheetStaffId === m.staff_user_id ? 'Hide timesheet' : 'View timesheet'}
              </button>
            </div>
          </div>
        ))}

        {memberships.length === 0 && !showForm && (
          <div className="staff-empty">
            <Users size={32} />
            <p>No staff yet. You're running solo. Invite team members above.</p>
          </div>
        )}
      </div>

      {/* Timesheet view */}
      {timesheetStaffId && activeMembership && (
        <div className="staff-section">
          <div className="staff-section-header">
            <h3>Timesheet — {activeMembership._profile?.full_name || activeMembership._profile?.email}</h3>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            marginBottom: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setWeekStart(addDays(weekStart, -7))}
                style={{
                  background: 'white',
                  border: '1px solid var(--clr-warm-mid)',
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontSize: '0.8125rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
                {formatWeekRange(weekStart)}
              </span>
              <button
                onClick={() => setWeekStart(addDays(weekStart, 7))}
                style={{
                  background: 'white',
                  border: '1px solid var(--clr-warm-mid)',
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontSize: '0.8125rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
            <div style={{
              padding: '8px 14px',
              background: 'var(--clr-sage-pale)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.875rem',
              color: 'var(--clr-sage-dark)',
              fontWeight: 500,
            }}>
              Week total: {weekTotalHours}h
              {weekTotalWages != null && (
                <span style={{ marginLeft: 10, color: 'var(--clr-ink)' }}>
                  · ${weekTotalWages.toFixed(2)} wages
                </span>
              )}
            </div>
          </div>

          {entriesLoading ? (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--clr-ink-soft)' }}>
              Loading entries…
            </div>
          ) : entries.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: 32,
              background: '#fdfcf7',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.875rem',
              color: 'var(--clr-ink-soft)',
            }}>
              No time entries this week.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entries.map(entry => {
                const ms = durationMs(entry)
                const isOpen = !entry.clock_out
                return (
                  <div
                    key={entry.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 90px auto',
                      gap: 12,
                      alignItems: 'center',
                      padding: '12px 14px',
                      background: isOpen ? 'var(--clr-sage-pale)' : 'white',
                      border: '1px solid var(--clr-warm-mid)',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginBottom: 2 }}>In</div>
                      <div style={{ fontSize: '0.9375rem', color: 'var(--clr-ink)' }}>{formatDateTime(entry.clock_in)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginBottom: 2 }}>Out</div>
                      <div style={{ fontSize: '0.9375rem', color: 'var(--clr-ink)' }}>
                        {isOpen ? <em style={{ color: 'var(--clr-sage-dark)' }}>On the clock</em> : formatDateTime(entry.clock_out)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginBottom: 2 }}>Hours</div>
                      <div style={{ fontSize: '0.9375rem', color: 'var(--clr-ink)', fontWeight: 500 }}>{formatDuration(ms)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {entry.edited_by_provider && (
                        <span style={{
                          fontSize: '0.625rem',
                          padding: '2px 6px',
                          background: 'var(--clr-warm)',
                          color: 'var(--clr-ink-soft)',
                          borderRadius: 'var(--radius-full)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          fontWeight: 600,
                        }} title="This entry was edited by you">
                          Edited
                        </span>
                      )}
                      <button
                        className="staff-icon-btn"
                        onClick={() => setEditingEntry({
                          id: entry.id,
                          clock_in: entry.clock_in,
                          clock_out: entry.clock_out,
                          notes: entry.notes || '',
                        })}
                        title="Edit entry"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="staff-icon-btn danger"
                        onClick={() => deleteEntry(entry)}
                        title="Delete entry"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {entry.notes && (
                      <div style={{
                        gridColumn: '1 / -1',
                        fontSize: '0.8125rem',
                        color: 'var(--clr-ink-mid)',
                        fontStyle: 'italic',
                        paddingTop: 6,
                        borderTop: '1px dashed var(--clr-warm-mid)',
                      }}>
                        {entry.notes}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Pending invitations */}
      {pendingInvitations.length > 0 && (
        <div className="staff-section">
          <div className="staff-section-header">
            <h3>Pending invitations ({pendingInvitations.length})</h3>
          </div>
          {pendingInvitations.map(inv => (
            <div key={inv.id} className="staff-card pending">
              <div className="staff-avatar pending"><Clock size={16} /></div>
              <div className="staff-info">
                <div className="staff-name">
                  {inv.recipient_name || inv.recipient_email}
                  <span className="staff-status-badge pending">Pending</span>
                </div>
                <div className="staff-meta">
                  {inv.recipient_email}
                  <span> · {ROLES.find(r => r.value === inv.intended_role)?.label}</span>
                  <span> · Expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="staff-actions">
                <button className="staff-icon-btn" onClick={() => copyLink(inv.token)} title="Copy link">
                  <Copy size={13} />
                </button>
                <button className="staff-icon-btn" onClick={() => resendInvitation(inv)} title="Resend">
                  <Send size={13} />
                </button>
                <button className="staff-icon-btn danger" onClick={() => revokeInvitation(inv.id)} title="Revoke">
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Invite form */}
      {showForm && (
        <div className="staff-section">
          <div className="staff-form-card">
            <h3 style={{ marginTop: 0 }}>Invite a team member</h3>

            <div className="staff-field">
              <label>Email *</label>
              <input
                className="staff-input"
                type="email"
                value={form.recipient_email}
                onChange={(e) => setForm(f => ({ ...f, recipient_email: e.target.value }))}
                placeholder="staff@example.com"
              />
            </div>

            <div className="staff-field">
              <label>Name (optional)</label>
              <input
                className="staff-input"
                value={form.recipient_name}
                onChange={(e) => setForm(f => ({ ...f, recipient_name: e.target.value }))}
                placeholder="Jane Smith"
              />
            </div>

            <div className="staff-field">
              <label>Role</label>
              <div className="staff-role-options">
                {ROLES.map(r => (
                  <label key={r.value} className={`staff-role-option ${form.intended_role === r.value ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="role"
                      value={r.value}
                      checked={form.intended_role === r.value}
                      onChange={(e) => setForm(f => ({ ...f, intended_role: e.target.value }))}
                    />
                    <div>
                      <div className="staff-role-option-name">{r.label}</div>
                      <div className="staff-role-option-desc">{r.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="staff-field">
              <label style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: 12,
                background: 'var(--clr-cream)',
                border: '1.5px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                fontWeight: 400,
                color: 'var(--clr-ink)',
              }}>
                <input
                  type="checkbox"
                  checked={form.is_18_or_older}
                  onChange={(e) => setForm(f => ({ ...f, is_18_or_older: e.target.checked }))}
                  style={{ marginTop: 3, cursor: 'pointer', flexShrink: 0, accentColor: 'var(--clr-sage-dark)' }}
                />
                <div>
                  <div style={{ fontSize: '0.9375rem', fontWeight: 500, marginBottom: 2 }}>
                    This person is 18 or older
                  </div>
                  <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.4 }}>
                    Required to log medication. Michigan R 400.1918 prohibits caregivers under 18 from administering medication. Uncheck if this is a teen helper.
                  </div>
                </div>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}>
              <button className="staff-cancel-btn" onClick={() => { setShowForm(false); setForm({ recipient_name: '', recipient_email: '', intended_role: 'adult_staff', is_18_or_older: true }) }}>
                Cancel
              </button>
              <button
                className="staff-save-btn"
                onClick={sendInvitation}
                disabled={sending || !form.recipient_email}
              >
                <Send size={14} /> {sending ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pricing notice */}
      <div className="staff-pricing-notice">
        <strong>Pricing:</strong> Your subscription includes you + unlimited staff members during the alpha period. Additional pricing for staff seats may be introduced later — early users will be grandfathered.
      </div>

      {/* Edit entry modal */}
      {editingEntry && (
        <div
          onClick={() => setEditingEntry(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 20, 17, 0.55)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              width: '100%',
              maxWidth: 440,
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            }}
          >
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.125rem', margin: 0, marginBottom: 16, color: 'var(--clr-ink)' }}>
              Edit time entry
            </h3>
            <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', marginTop: 0, marginBottom: 16 }}>
              Changes are logged in the audit trail.
            </p>

            <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 4 }}>
              Clock in
            </label>
            <input
              type="datetime-local"
              value={isoToLocalInput(editingEntry.clock_in)}
              onChange={(e) => setEditingEntry({ ...editingEntry, clock_in: localInputToISO(e.target.value) })}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 12,
                fontFamily: 'var(--font-body)',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />

            <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 4 }}>
              Clock out
            </label>
            <input
              type="datetime-local"
              value={isoToLocalInput(editingEntry.clock_out)}
              onChange={(e) => setEditingEntry({ ...editingEntry, clock_out: localInputToISO(e.target.value) })}
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 12,
                fontFamily: 'var(--font-body)',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />

            <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 4 }}>
              Notes (optional)
            </label>
            <textarea
              value={editingEntry.notes}
              onChange={(e) => setEditingEntry({ ...editingEntry, notes: e.target.value })}
              placeholder="Reason for edit, missed clock-out, etc."
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                minHeight: 60,
                resize: 'vertical',
                fontFamily: 'var(--font-body)',
                fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setEditingEntry(null)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--clr-warm-mid)',
                  color: 'var(--clr-ink-mid)',
                  padding: '10px 16px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.875rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={saveEntryEdit}
                style={{
                  background: 'var(--clr-sage-dark)',
                  color: 'white',
                  border: 'none',
                  padding: '10px 20px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Check size={14} /> Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
