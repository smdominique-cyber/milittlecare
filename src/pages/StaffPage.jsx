import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import {
  Users, Plus, Send, Copy, X, Trash2, Pencil, Check, AlertCircle, Shield, Clock,
} from 'lucide-react'
import '@/styles/staff.css'

// User-facing labels and descriptions for each role.
// DB values stay the same: adult_staff / assistant / view_only.
// Internally `assistant` maps to "Daily Helper" — younger or older, financial-restricted.
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

  const pendingInvitations = invitations.filter(i => {
    const expired = new Date(i.expires_at) < new Date()
    return i.status === 'pending' && !expired
  })

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
          <div key={m.id} className="staff-card">
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
        ))}

        {memberships.length === 0 && !showForm && (
          <div className="staff-empty">
            <Users size={32} />
            <p>No staff yet. You're running solo. Invite team members above.</p>
          </div>
        )}
      </div>

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
    </>
  )
}
