import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import {
  Plus, X, Users, Phone, Mail, AlertCircle, Save, Trash2,
  ChevronLeft, ChevronRight, Pencil, UserPlus, Shield, Baby,
  Send, Copy, ExternalLink,
} from 'lucide-react'
import '@/styles/families.css'

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ended', label: 'Ended' },
]

const ATTENDANCE_STATUSES = [
  { value: 'present',  label: 'Present',  emoji: '✓' },
  { value: 'absent',   label: 'Absent',   emoji: '×' },
  { value: 'sick',     label: 'Sick',     emoji: '🤒' },
  { value: 'vacation', label: 'Vacation', emoji: '🏖️' },
  { value: 'holiday',  label: 'Holiday',  emoji: '🎉' },
]

function getInitials(name) {
  if (!name) return '?'
  return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

function calcAge(dob) {
  if (!dob) return null
  const birth = new Date(dob)
  const now = new Date()
  let years = now.getFullYear() - birth.getFullYear()
  let months = now.getMonth() - birth.getMonth()
  if (months < 0) { years--; months += 12 }
  if (years < 2) return `${years * 12 + months} mo`
  return `${years}y`
}

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.setDate(diff))
}

function formatDate(d) {
  return d.toISOString().split('T')[0]
}

function calcHours(inTime, outTime) {
  if (!inTime || !outTime) return null
  const [ih, im] = inTime.split(':').map(Number)
  const [oh, om] = outTime.split(':').map(Number)
  const mins = (oh * 60 + om) - (ih * 60 + im)
  return mins > 0 ? (mins / 60).toFixed(2) : null
}

// ════════════════════════════════════════════════════════════
export default function FamiliesPage() {
  const { user } = useAuth()

  const [families, setFamilies] = useState([])
  const [children, setChildren] = useState([])
  const [guardians, setGuardians] = useState([])
  const [emergency, setEmergency] = useState([])
  const [loading, setLoading] = useState(true)

  const [statusFilter, setStatusFilter] = useState('active')
  const [selectedFamily, setSelectedFamily] = useState(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [f, c, g, e] = await Promise.all([
      supabase.from('families').select('*').eq('user_id', user.id).order('family_name'),
      supabase.from('children').select('*').eq('user_id', user.id),
      supabase.from('guardians').select('*').eq('user_id', user.id),
      supabase.from('emergency_contacts').select('*').eq('user_id', user.id),
    ])
    setFamilies(f.data || [])
    setChildren(c.data || [])
    setGuardians(g.data || [])
    setEmergency(e.data || [])
    setLoading(false)
  }

  const filteredFamilies = families.filter(f =>
    statusFilter === 'all' || f.enrollment_status === statusFilter
  )

  // Stats
  const activeFamilies = families.filter(f => f.enrollment_status === 'active')
  const activeChildren = children.filter(c =>
    activeFamilies.some(f => f.id === c.family_id)
  )
  const weeklyRevenue = activeFamilies.reduce((sum, f) => {
    if (f.billing_type === 'weekly') return sum + parseFloat(f.weekly_rate || 0)
    return sum // hourly families calculated separately
  }, 0)

  // ─── Render ─────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  return (
    <div className="families-page">
      {/* Summary */}
      <div className="families-summary">
        <div className="summary-card">
          <div className="summary-label">Active Families</div>
          <div className="summary-value">{activeFamilies.length}</div>
          <div className="summary-sub">{families.length} total tracked</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Active Children</div>
          <div className="summary-value">{activeChildren.length}</div>
          <div className="summary-sub">
            {activeChildren.length === 1 ? 'child enrolled' : 'children enrolled'}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Weekly Revenue</div>
          <div className="summary-value">
            ${weeklyRevenue.toFixed(0)}
          </div>
          <div className="summary-sub">from flat-rate families</div>
        </div>
      </div>

      {/* Header */}
      <div className="families-header">
        <h2>Families</h2>
        <button className="btn-add-family" onClick={() => setCreating(true)}>
          <Plus size={16} /> Add family
        </button>
      </div>

      {/* Status tabs */}
      <div className="status-tabs">
        {['all', 'active', 'paused', 'ended'].map(s => (
          <button
            key={s}
            className={`status-tab${statusFilter === s ? ' active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
            {s !== 'all' && ` (${families.filter(f => f.enrollment_status === s).length})`}
          </button>
        ))}
      </div>

      {/* Grid */}
      {filteredFamilies.length === 0 ? (
        <div className="deductions-empty">
          <div className="deductions-empty-icon">👨‍👩‍👧</div>
          <div className="deductions-empty-title">
            {families.length === 0 ? 'No families yet' : 'No families match this filter'}
          </div>
          <div className="deductions-empty-desc">
            {families.length === 0
              ? 'Add your first family to start tracking enrollment, billing, and attendance.'
              : 'Try switching to a different status tab.'}
          </div>
          {families.length === 0 && (
            <button className="btn-go-scan" onClick={() => setCreating(true)}>
              <UserPlus size={16} /> Add your first family
            </button>
          )}
        </div>
      ) : (
        <div className="families-grid">
          {filteredFamilies.map(family => {
            const fChildren = children.filter(c => c.family_id === family.id)
            const fGuardians = guardians.filter(g => g.family_id === family.id)
            const primary = fGuardians.find(g => g.is_primary) || fGuardians[0]

            return (
              <div key={family.id} className="family-card" onClick={() => setSelectedFamily(family)}>
                <div className="family-card-header">
                  <div className="family-name-row">
                    <div className="family-name">{family.family_name}</div>
                    <span className={`family-status-badge ${family.enrollment_status}`}>
                      {family.enrollment_status}
                    </span>
                  </div>
                  <div className="family-billing">
                    {family.billing_type === 'weekly' && family.weekly_rate && (
                      <><span className="family-billing-rate">${parseFloat(family.weekly_rate).toFixed(0)}</span> / week</>
                    )}
                    {family.billing_type === 'hourly' && family.hourly_rate && (
                      <><span className="family-billing-rate">${parseFloat(family.hourly_rate).toFixed(2)}</span> / hour</>
                    )}
                    {!family.weekly_rate && !family.hourly_rate && (
                      <span style={{ color: 'var(--clr-ink-soft)' }}>No rate set</span>
                    )}
                  </div>
                </div>

                <div className="family-card-body">
                  <div className="family-section-title">
                    {fChildren.length} {fChildren.length === 1 ? 'Child' : 'Children'}
                  </div>
                  {fChildren.length > 0 ? (
                    <div className="children-chips">
                      {fChildren.map(c => (
                        <span key={c.id} className="child-chip">
                          <Baby size={13} />
                          {c.first_name}
                          {c.date_of_birth && <span className="child-chip-age">· {calcAge(c.date_of_birth)}</span>}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--clr-ink-soft)', fontSize: '0.8125rem', marginBottom: 'var(--space-3)' }}>
                      No children added yet
                    </div>
                  )}

                  {primary && (
                    <>
                      <div className="family-section-title">Primary Contact</div>
                      <div className="guardian-line guardian-line-primary">
                        {primary.first_name} {primary.last_name}
                      </div>
                      {primary.phone && (
                        <div className="guardian-line">
                          <Phone size={12} />
                          {primary.phone}
                        </div>
                      )}
                      {primary.email && (
                        <div className="guardian-line">
                          <Mail size={12} />
                          {primary.email}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create / Edit modal */}
      {(creating || selectedFamily) && (
        <FamilyDetailModal
          userId={user.id}
          family={selectedFamily}
          children={children.filter(c => c.family_id === selectedFamily?.id)}
          guardians={guardians.filter(g => g.family_id === selectedFamily?.id)}
          emergencyContacts={emergency.filter(e => e.family_id === selectedFamily?.id)}
          onClose={() => { setSelectedFamily(null); setCreating(false) }}
          onChange={loadAll}
        />
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// Family Detail Modal
// ════════════════════════════════════════════════════════════
function FamilyDetailModal({ userId, family, children: initialChildren, guardians: initialGuardians, emergencyContacts: initialEC, onClose, onChange }) {
  const isNew = !family
  const [tab, setTab] = useState('overview')
  const [form, setForm] = useState({
    family_name:       family?.family_name || '',
    billing_type:      family?.billing_type || 'weekly',
    weekly_rate:       family?.weekly_rate || '',
    hourly_rate:       family?.hourly_rate || '',
    enrollment_status: family?.enrollment_status || 'active',
    start_date:        family?.start_date || '',
    end_date:          family?.end_date || '',
    notes:             family?.notes || '',
  })
  const [saving, setSaving] = useState(false)

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

  const handleSaveFamily = async () => {
    setSaving(true)
    if (isNew) {
      const { data } = await supabase.from('families').insert({
        user_id: userId,
        ...form,
        weekly_rate: form.weekly_rate ? parseFloat(form.weekly_rate) : null,
        hourly_rate: form.hourly_rate ? parseFloat(form.hourly_rate) : null,
        start_date: form.start_date || null,
        end_date:   form.end_date || null,
      }).select().single()
      setSaving(false)
      if (data) {
        await onChange()
        onClose()
      }
    } else {
      await supabase.from('families').update({
        ...form,
        weekly_rate: form.weekly_rate ? parseFloat(form.weekly_rate) : null,
        hourly_rate: form.hourly_rate ? parseFloat(form.hourly_rate) : null,
        start_date: form.start_date || null,
        end_date:   form.end_date || null,
      }).eq('id', family.id)
      setSaving(false)
      await onChange()
    }
  }

  const handleDeleteFamily = async () => {
    if (!window.confirm('Delete this family and all associated data? This cannot be undone.')) return
    await supabase.from('families').delete().eq('id', family.id)
    await onChange()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card family-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {isNew ? 'Add new family' : family.family_name}
          </span>
          <button className="modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {!isNew && (
          <div className="detail-tabs">
            <button className={`detail-tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>
              Overview
            </button>
            <button className={`detail-tab${tab === 'invitations' ? ' active' : ''}`} onClick={() => setTab('invitations')}>
              Access
            </button>
            <button className={`detail-tab${tab === 'children' ? ' active' : ''}`} onClick={() => setTab('children')}>
              Children ({initialChildren.length})
            </button>
            <button className={`detail-tab${tab === 'guardians' ? ' active' : ''}`} onClick={() => setTab('guardians')}>
              Guardians ({initialGuardians.length})
            </button>
            <button className={`detail-tab${tab === 'emergency' ? ' active' : ''}`} onClick={() => setTab('emergency')}>
              Emergency
            </button>
            <button className={`detail-tab${tab === 'attendance' ? ' active' : ''}`} onClick={() => setTab('attendance')}>
              Attendance
            </button>
          </div>
        )}

        <div className="detail-tab-content">
          {(isNew || tab === 'overview') && (
            <OverviewTab form={form} update={update} />
          )}
          {!isNew && tab === 'invitations' && (
            <InvitationsTab userId={userId} family={family} guardians={initialGuardians} onChange={onChange} />
          )}
          {!isNew && tab === 'children' && (
            <ChildrenTab userId={userId} familyId={family.id} children={initialChildren} onChange={onChange} />
          )}
          {!isNew && tab === 'guardians' && (
            <GuardiansTab userId={userId} familyId={family.id} guardians={initialGuardians} onChange={onChange} />
          )}
          {!isNew && tab === 'emergency' && (
            <EmergencyTab userId={userId} familyId={family.id} contacts={initialEC} onChange={onChange} />
          )}
          {!isNew && tab === 'attendance' && (
            <AttendanceTab userId={userId} children={initialChildren} />
          )}
        </div>

        {(isNew || tab === 'overview') && (
          <div className="modal-footer">
            {!isNew && (
              <button className="btn-danger" onClick={handleDeleteFamily}>
                <Trash2 size={14} /> Delete family
              </button>
            )}
            <button className="btn-discard" onClick={onClose}>Cancel</button>
            <button className="btn-save" onClick={handleSaveFamily} disabled={saving || !form.family_name} style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
              <Save size={14} /> {saving ? 'Saving…' : isNew ? 'Create family' : 'Save changes'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Overview tab ──────────────────────────────────────
function OverviewTab({ form, update }) {
  return (
    <>
      <div className="form-field-group">
        <label className="field-label">Family name *</label>
        <input className="field-input" value={form.family_name} onChange={update('family_name')} placeholder="e.g. The Smith Family" />
      </div>

      <div className="form-row">
        <div className="form-field-group">
          <label className="field-label">Billing type</label>
          <select className="field-input" value={form.billing_type} onChange={update('billing_type')}>
            <option value="weekly">Weekly flat rate</option>
            <option value="hourly">Hourly rate</option>
          </select>
        </div>
        <div className="form-field-group">
          <label className="field-label">Enrollment status</label>
          <select className="field-input" value={form.enrollment_status} onChange={update('enrollment_status')}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="form-row">
        {form.billing_type === 'weekly' && (
          <div className="form-field-group">
            <label className="field-label">Weekly rate ($)</label>
            <input className="field-input" type="number" step="0.01" value={form.weekly_rate} onChange={update('weekly_rate')} placeholder="0.00" />
          </div>
        )}
        {form.billing_type === 'hourly' && (
          <div className="form-field-group">
            <label className="field-label">Hourly rate ($)</label>
            <input className="field-input" type="number" step="0.01" value={form.hourly_rate} onChange={update('hourly_rate')} placeholder="0.00" />
          </div>
        )}
      </div>

      <div className="form-row">
        <div className="form-field-group">
          <label className="field-label">Start date</label>
          <input className="field-input" type="date" value={form.start_date} onChange={update('start_date')} />
        </div>
        <div className="form-field-group">
          <label className="field-label">End date (if applicable)</label>
          <input className="field-input" type="date" value={form.end_date} onChange={update('end_date')} />
        </div>
      </div>

      <div className="form-field-group">
        <label className="field-label">Notes</label>
        <textarea className="field-input" value={form.notes} onChange={update('notes')} placeholder="Anything else you want to remember about this family…" />
      </div>
    </>
  )
}

// ─── Children tab ──────────────────────────────────────
function ChildrenTab({ userId, familyId, children, onChange }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)

  return (
    <div className="subsection">
      <div className="subsection-header">
        <span className="subsection-title">Enrolled Children</span>
        <button className="btn-add-inline" onClick={() => { setAdding(true); setEditing(null) }}>
          <Plus size={13} /> Add child
        </button>
      </div>

      {adding && (
        <ChildForm
          userId={userId}
          familyId={familyId}
          onClose={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await onChange() }}
        />
      )}

      {children.length === 0 && !adding && (
        <div className="empty-mini">No children yet. Click "Add child" above.</div>
      )}

      {children.map(child =>
        editing === child.id ? (
          <ChildForm
            key={child.id}
            userId={userId}
            familyId={familyId}
            child={child}
            onClose={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await onChange() }}
          />
        ) : (
          <div key={child.id} className="person-card">
            <div className="person-avatar">{getInitials(child.first_name + ' ' + (child.last_name || ''))}</div>
            <div className="person-info">
              <div className="person-name">{child.first_name} {child.last_name}</div>
              <div className="person-meta">
                {child.date_of_birth && <span>Age: {calcAge(child.date_of_birth)}</span>}
                {child.allergies && <span>⚠ Allergies: {child.allergies}</span>}
              </div>
            </div>
            <div className="person-actions">
              <button className="icon-btn" onClick={() => setEditing(child.id)}><Pencil /></button>
              <button className="icon-btn danger" onClick={async () => {
                if (!window.confirm('Remove this child?')) return
                await supabase.from('children').delete().eq('id', child.id)
                await onChange()
              }}><Trash2 /></button>
            </div>
          </div>
        )
      )}
    </div>
  )
}

function ChildForm({ userId, familyId, child, onClose, onSaved }) {
  const [form, setForm] = useState({
    first_name:    child?.first_name || '',
    last_name:     child?.last_name || '',
    date_of_birth: child?.date_of_birth || '',
    allergies:     child?.allergies || '',
    medical_notes: child?.medical_notes || '',
    notes:         child?.notes || '',
  })

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))

  const handleSave = async () => {
    if (child) {
      await supabase.from('children').update({
        ...form,
        date_of_birth: form.date_of_birth || null,
      }).eq('id', child.id)
    } else {
      await supabase.from('children').insert({
        user_id: userId,
        family_id: familyId,
        ...form,
        date_of_birth: form.date_of_birth || null,
      })
    }
    await onSaved()
  }

  return (
    <div className="person-card" style={{ flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div className="form-row">
          <div className="form-field-group">
            <label className="field-label">First name *</label>
            <input className="field-input" value={form.first_name} onChange={update('first_name')} />
          </div>
          <div className="form-field-group">
            <label className="field-label">Last name</label>
            <input className="field-input" value={form.last_name} onChange={update('last_name')} />
          </div>
        </div>
        <div className="form-field-group">
          <label className="field-label">Date of birth</label>
          <input className="field-input" type="date" value={form.date_of_birth} onChange={update('date_of_birth')} />
        </div>
        <div className="form-field-group">
          <label className="field-label">Allergies</label>
          <input className="field-input" value={form.allergies} onChange={update('allergies')} placeholder="e.g. Peanuts, Dairy" />
        </div>
        <div className="form-field-group">
          <label className="field-label">Medical notes</label>
          <textarea className="field-input" value={form.medical_notes} onChange={update('medical_notes')} placeholder="Medications, conditions, etc." />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <button className="btn-discard" onClick={onClose}>Cancel</button>
          <button className="btn-save" onClick={handleSave} disabled={!form.first_name} style={{ flex: 'initial', padding: '0.5rem var(--space-4)' }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Guardians tab ──────────────────────────────────────
function GuardiansTab({ userId, familyId, guardians, onChange }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)

  return (
    <div className="subsection">
      <div className="subsection-header">
        <span className="subsection-title">Parents & Guardians</span>
        <button className="btn-add-inline" onClick={() => { setAdding(true); setEditing(null) }}>
          <Plus size={13} /> Add guardian
        </button>
      </div>

      {adding && (
        <GuardianForm
          userId={userId}
          familyId={familyId}
          onClose={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await onChange() }}
        />
      )}

      {guardians.length === 0 && !adding && (
        <div className="empty-mini">No guardians yet. Add at least one primary contact.</div>
      )}

      {guardians.map(g =>
        editing === g.id ? (
          <GuardianForm
            key={g.id}
            userId={userId}
            familyId={familyId}
            guardian={g}
            onClose={() => setEditing(null)}
            onSaved={async () => { setEditing(null); await onChange() }}
          />
        ) : (
          <div key={g.id} className="person-card">
            <div className="person-avatar guardian">{getInitials(g.first_name + ' ' + (g.last_name || ''))}</div>
            <div className="person-info">
              <div className="person-name">
                {g.first_name} {g.last_name}
                {g.is_primary && <span className="primary-tag">Primary</span>}
                {g.relationship && <span style={{ color: 'var(--clr-ink-soft)', fontWeight: 400, fontSize: '0.8125rem' }}>· {g.relationship}</span>}
              </div>
              <div className="person-meta">
                {g.phone && <span>📞 {g.phone}</span>}
                {g.email && <span>✉ {g.email}</span>}
              </div>
            </div>
            <div className="person-actions">
              <button className="icon-btn" onClick={() => setEditing(g.id)}><Pencil /></button>
              <button className="icon-btn danger" onClick={async () => {
                if (!window.confirm('Remove this guardian?')) return
                await supabase.from('guardians').delete().eq('id', g.id)
                await onChange()
              }}><Trash2 /></button>
            </div>
          </div>
        )
      )}
    </div>
  )
}

function GuardianForm({ userId, familyId, guardian, onClose, onSaved }) {
  const [form, setForm] = useState({
    first_name:   guardian?.first_name || '',
    last_name:    guardian?.last_name || '',
    relationship: guardian?.relationship || '',
    phone:        guardian?.phone || '',
    email:        guardian?.email || '',
    address:      guardian?.address || '',
    is_primary:   guardian?.is_primary || false,
    can_pickup:   guardian?.can_pickup ?? true,
  })

  const update = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }))
  const toggle = (field) => () => setForm(f => ({ ...f, [field]: !f[field] }))

  const handleSave = async () => {
    if (guardian) {
      await supabase.from('guardians').update(form).eq('id', guardian.id)
    } else {
      await supabase.from('guardians').insert({ user_id: userId, family_id: familyId, ...form })
    }
    await onSaved()
  }

  return (
    <div className="person-card" style={{ flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div className="form-row">
          <div className="form-field-group">
            <label className="field-label">First name *</label>
            <input className="field-input" value={form.first_name} onChange={update('first_name')} />
          </div>
          <div className="form-field-group">
            <label className="field-label">Last name</label>
            <input className="field-input" value={form.last_name} onChange={update('last_name')} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-field-group">
            <label className="field-label">Relationship</label>
            <input className="field-input" value={form.relationship} onChange={update('relationship')} placeholder="Mother, Father, Grandparent…" />
          </div>
          <div className="form-field-group">
            <label className="field-label">Phone</label>
            <input className="field-input" type="tel" value={form.phone} onChange={update('phone')} />
          </div>
        </div>
        <div className="form-field-group">
          <label className="field-label">Email</label>
          <input className="field-input" type="email" value={form.email} onChange={update('email')} />
        </div>
        <div className="form-field-group">
          <label className="field-label">Address</label>
          <input className="field-input" value={form.address} onChange={update('address')} />
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: '0.875rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.is_primary} onChange={toggle('is_primary')} />
            Primary contact
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.can_pickup} onChange={toggle('can_pickup')} />
            Authorized for pickup
          </label>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <button className="btn-discard" onClick={onClose}>Cancel</button>
          <button className="btn-save" onClick={handleSave} disabled={!form.first_name} style={{ flex: 'initial', padding: '0.5rem var(--space-4)' }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Emergency contacts tab ──────────────────────────────────────
function EmergencyTab({ userId, familyId, contacts, onChange }) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', relationship: '', phone: '', notes: '' })

  const handleAdd = async () => {
    await supabase.from('emergency_contacts').insert({
      user_id: userId,
      family_id: familyId,
      ...form,
    })
    setForm({ name: '', relationship: '', phone: '', notes: '' })
    setAdding(false)
    await onChange()
  }

  return (
    <div className="subsection">
      <div className="subsection-header">
        <span className="subsection-title">Emergency Contacts</span>
        {!adding && (
          <button className="btn-add-inline" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add contact
          </button>
        )}
      </div>

      {adding && (
        <div className="person-card" style={{ flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Name *</label>
                <input className="field-input" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-field-group">
                <label className="field-label">Relationship</label>
                <input className="field-input" value={form.relationship} onChange={(e) => setForm(f => ({ ...f, relationship: e.target.value }))} placeholder="Grandparent, Aunt, Friend…" />
              </div>
            </div>
            <div className="form-field-group">
              <label className="field-label">Phone</label>
              <input className="field-input" type="tel" value={form.phone} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="form-field-group">
              <label className="field-label">Notes</label>
              <input className="field-input" value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button className="btn-discard" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn-save" onClick={handleAdd} disabled={!form.name} style={{ flex: 'initial', padding: '0.5rem var(--space-4)' }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {contacts.length === 0 && !adding && (
        <div className="empty-mini">No emergency contacts yet. These are critical for when a parent can't be reached.</div>
      )}

      {contacts.map(c => (
        <div key={c.id} className="person-card">
          <div className="person-avatar emergency"><Shield size={18} /></div>
          <div className="person-info">
            <div className="person-name">
              {c.name}
              {c.relationship && <span style={{ color: 'var(--clr-ink-soft)', fontWeight: 400, fontSize: '0.8125rem' }}>· {c.relationship}</span>}
            </div>
            <div className="person-meta">
              {c.phone && <span>📞 {c.phone}</span>}
              {c.notes && <span>{c.notes}</span>}
            </div>
          </div>
          <div className="person-actions">
            <button className="icon-btn danger" onClick={async () => {
              if (!window.confirm('Remove this emergency contact?')) return
              await supabase.from('emergency_contacts').delete().eq('id', c.id)
              await onChange()
            }}><Trash2 /></button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Attendance tab ──────────────────────────────────────
function AttendanceTab({ userId, children }) {
  const [weekStart, setWeekStart] = useState(getMonday(new Date()))
  const [attendance, setAttendance] = useState([])
  const [loading, setLoading] = useState(false)

  const weekDays = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(weekStart.getDate() + i)
    return d
  })

  useEffect(() => { loadAttendance() }, [weekStart, children])

  async function loadAttendance() {
    if (children.length === 0) return
    setLoading(true)
    const childIds = children.map(c => c.id)
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .in('child_id', childIds)
      .gte('date', formatDate(weekStart))
      .lte('date', formatDate(weekDays[4]))
    setAttendance(data || [])
    setLoading(false)
  }

  const getRecord = (childId, date) => {
    return attendance.find(a => a.child_id === childId && a.date === formatDate(date))
  }

  const saveRecord = async (childId, date, updates) => {
    const dateStr = formatDate(date)
    const existing = getRecord(childId, date)
    const hours = calcHours(updates.check_in ?? existing?.check_in, updates.check_out ?? existing?.check_out)
    const payload = {
      user_id: userId,
      child_id: childId,
      date: dateStr,
      check_in:  updates.check_in  ?? existing?.check_in  ?? null,
      check_out: updates.check_out ?? existing?.check_out ?? null,
      hours: hours ? parseFloat(hours) : null,
      status: updates.status ?? existing?.status ?? 'present',
    }
    await supabase.from('attendance').upsert(payload, { onConflict: 'child_id,date' })
    await loadAttendance()
  }

  if (children.length === 0) {
    return <div className="empty-mini">Add children to this family first to track attendance.</div>
  }

  return (
    <>
      <div className="attendance-header">
        <div className="subsection-title">Weekly Attendance</div>
        <div className="attendance-week-nav">
          <button className="attendance-week-btn" onClick={() => {
            const d = new Date(weekStart)
            d.setDate(d.getDate() - 7)
            setWeekStart(d)
          }}><ChevronLeft size={16} /></button>
          <span className="attendance-week-label">
            {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {weekDays[4].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
          <button className="attendance-week-btn" onClick={() => {
            const d = new Date(weekStart)
            d.setDate(d.getDate() + 7)
            setWeekStart(d)
          }}><ChevronRight size={16} /></button>
        </div>
      </div>

      {children.map(child => {
        const total = weekDays.reduce((sum, d) => sum + (parseFloat(getRecord(child.id, d)?.hours) || 0), 0)
        return (
          <div key={child.id} className="subsection">
            <div className="subsection-header">
              <span className="subsection-title">{child.first_name}</span>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem', color: 'var(--clr-sage-dark)' }}>
                {total.toFixed(2)} hrs this week
              </span>
            </div>
            {weekDays.map(d => {
              const rec = getRecord(child.id, d)
              return (
                <div key={d.toISOString()} className="attendance-row">
                  <div className="attendance-date-col">
                    <div className="attendance-date-day">
                      {d.toLocaleDateString('en-US', { weekday: 'short' })}
                    </div>
                    <div className="attendance-date-sub">
                      {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <input
                    className="attendance-time-input"
                    type="time"
                    value={rec?.check_in || ''}
                    onChange={(e) => saveRecord(child.id, d, { check_in: e.target.value || null })}
                  />
                  <input
                    className="attendance-time-input"
                    type="time"
                    value={rec?.check_out || ''}
                    onChange={(e) => saveRecord(child.id, d, { check_out: e.target.value || null })}
                  />
                  <span className="attendance-hours">
                    {rec?.hours ? `${parseFloat(rec.hours).toFixed(2)}h` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </>
  )
}

// ─── Invitations tab ──────────────────────────────────────
function InvitationsTab({ userId, family, guardians, onChange }) {
  const familyId = family.id
  const familyName = family.family_name
  const [invitations, setInvitations] = useState([])
  const [parentLinks, setParentLinks] = useState([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ recipient_name: '', recipient_email: '' })
  const [message, setMessage] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [disablingAutopay, setDisablingAutopay] = useState(false)

  useEffect(() => { loadAll() }, [familyId])

  async function loadAll() {
    setLoading(true)
    const [invsResp, linksResp] = await Promise.all([
      supabase.from('family_invitations').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
      supabase.from('parent_family_links').select('*, parent_profiles(email, full_name)').eq('family_id', familyId).eq('status', 'active'),
    ])
    setInvitations(invsResp.data || [])
    setParentLinks(linksResp.data || [])
    setLoading(false)
  }

  const disableAutopayProvider = async () => {
    if (!window.confirm(`Disable autopay for ${familyName}? The parent's saved card will be removed and they'll need to pay manually until they re-enroll.`)) return
    setDisablingAutopay(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/disable-autopay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ family_id: familyId }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to disable')
      setMessage({ type: 'success', text: 'Autopay disabled for this family' })
      if (onChange) await onChange()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setDisablingAutopay(false)
  }

  const sendInvitation = async () => {
    if (!form.recipient_email) return
    setSending(true)
    setMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/send-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          family_id: familyId,
          recipient_name: form.recipient_name || null,
          recipient_email: form.recipient_email,
          delivery_method: 'email',
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to send invitation')
      const sentMsg = data.email_sent
        ? `Invitation sent to ${form.recipient_email}`
        : `Invitation created. Email could not be sent automatically — share the link directly: ${data.invitation.url}`
      setMessage({ type: data.email_sent ? 'success' : 'info', text: sentMsg })
      setForm({ recipient_name: '', recipient_email: '' })
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
      const resp = await fetch('/api/send-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          family_id: familyId,
          recipient_name: invitation.recipient_name,
          recipient_email: invitation.recipient_email,
          delivery_method: 'email',
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to resend')
      setMessage({ type: 'success', text: `Resent to ${invitation.recipient_email}` })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSending(false)
  }

  const revokeInvitation = async (id) => {
    if (!window.confirm('Revoke this invitation? The link will stop working immediately.')) return
    await supabase.from('family_invitations').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('id', id)
    await loadAll()
  }

  const copyLink = async (token) => {
    const link = `${window.location.origin}/invite/${token}`
    try {
      await navigator.clipboard.writeText(link)
      setMessage({ type: 'success', text: 'Link copied to clipboard' })
    } catch {
      setMessage({ type: 'info', text: link })
    }
  }

  const previewAsParent = () => {
    setPreviewing(true)
    // Open a preview by signing in as anonymous parent OR using a preview parameter
    // For now: open the parent dashboard route in a new tab so provider can see what parents see
    window.open('/parent', '_blank', 'noopener')
    setTimeout(() => setPreviewing(false), 500)
  }

  return (
    <div className="subsection">
      {message && (
        <div className={`auth-message ${message.type === 'error' ? 'error' : 'success'}`} style={{ marginBottom: 'var(--space-3)', wordBreak: 'break-all' }}>
          <span>{message.type === 'error' ? '⚠' : '✓'}</span>
          <span>{message.text}</span>
        </div>
      )}

      {/* Autopay status */}
      {family.autopay_enabled && (
        <div style={{
          background: 'linear-gradient(135deg, #faf6ec 0%, #f4eee2 100%)',
          border: '1px solid #d4763b',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{ fontSize: '1.125rem' }}>⚡</span>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
                Autopay enabled
              </span>
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', lineHeight: 1.5 }}>
              Charged automatically every Monday at 9 AM.
              {family.autopay_last_charged_at && (
                <> Last charged {new Date(family.autopay_last_charged_at).toLocaleDateString()}.</>
              )}
              {family.autopay_failure_count > 0 && (
                <> <span style={{ color: 'var(--clr-error)' }}>⚠ {family.autopay_failure_count} recent failure(s).</span></>
              )}
            </div>
          </div>
          <button
            onClick={disableAutopayProvider}
            disabled={disablingAutopay}
            style={{
              background: 'transparent',
              border: '1px solid var(--clr-warm-mid)',
              color: 'var(--clr-ink-mid)',
              padding: '6px 12px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.78125rem',
              cursor: 'pointer',
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            {disablingAutopay ? 'Disabling…' : 'Disable autopay'}
          </button>
        </div>
      )}

      <div className="subsection-header">
        <span className="subsection-title">Family Access</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn-add-inline" onClick={previewAsParent} title="Open the parent view in a new tab">
            <ExternalLink size={13} /> Preview as Parent
          </button>
          {!showForm && (
            <button className="btn-add-inline" onClick={() => setShowForm(true)}>
              <Plus size={13} /> Send invitation
            </button>
          )}
        </div>
      </div>

      <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginBottom: 'var(--space-4)', lineHeight: 1.5 }}>
        Invite a parent or guardian to view invoices, pay online, and manage their family info.
        Each guardian can be invited separately. Invitations expire after 7 days.
      </div>

      {showForm && (
        <div className="person-card" style={{ flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Parent name (optional)</label>
                <input className="field-input" value={form.recipient_name} onChange={(e) => setForm(f => ({ ...f, recipient_name: e.target.value }))} placeholder="e.g. Mike Smith" />
              </div>
              <div className="form-field-group">
                <label className="field-label">Parent email *</label>
                <input className="field-input" type="email" value={form.recipient_email} onChange={(e) => setForm(f => ({ ...f, recipient_email: e.target.value }))} placeholder="parent@example.com" />
              </div>
            </div>
            {guardians.length > 0 && (
              <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>
                Quick fill from guardians:&nbsp;
                {guardians.filter(g => g.email).map(g => (
                  <button
                    key={g.id}
                    onClick={() => setForm({ recipient_name: `${g.first_name} ${g.last_name || ''}`.trim(), recipient_email: g.email })}
                    style={{ background: 'none', border: 'none', color: 'var(--clr-sage-dark)', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: '0.78125rem', marginRight: 'var(--space-2)' }}
                  >
                    {g.first_name} {g.last_name}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
              <button className="btn-discard" onClick={() => { setShowForm(false); setForm({ recipient_name: '', recipient_email: '' }) }}>Cancel</button>
              <button className="btn-save" onClick={sendInvitation} disabled={sending || !form.recipient_email} style={{ flex: 'initial', padding: '0.5rem var(--space-4)' }}>
                <Send size={14} /> {sending ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-mini">Loading…</div>
      ) : invitations.length === 0 ? (
        <div className="empty-mini">No invitations sent yet. Click "Send invitation" above.</div>
      ) : (
        invitations.map(inv => {
          const expired = new Date(inv.expires_at) < new Date()
          const status = expired && inv.status === 'pending' ? 'expired' : inv.status
          return (
            <div key={inv.id} className="person-card">
              <div className={`person-avatar ${status === 'accepted' ? '' : 'emergency'}`}>
                {status === 'accepted' ? '✓' : status === 'pending' ? '⏳' : status === 'revoked' ? '✕' : '⌛'}
              </div>
              <div className="person-info">
                <div className="person-name">
                  {inv.recipient_name || inv.recipient_email}
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 600, padding: '2px 7px',
                    background: status === 'accepted' ? 'var(--clr-success-pale)' : status === 'pending' ? 'var(--clr-warning-pale)' : 'var(--clr-warm-mid)',
                    color: status === 'accepted' ? 'var(--clr-success)' : status === 'pending' ? 'var(--clr-warning)' : 'var(--clr-ink-soft)',
                    borderRadius: 'var(--radius-full)', textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>
                    {status}
                  </span>
                </div>
                <div className="person-meta">
                  <span>{inv.recipient_email}</span>
                  {status === 'pending' && <span>· Expires {new Date(inv.expires_at).toLocaleDateString()}</span>}
                  {inv.accepted_at && <span>· Accepted {new Date(inv.accepted_at).toLocaleDateString()}</span>}
                </div>
              </div>
              <div className="person-actions">
                {status === 'pending' && (
                  <>
                    <button className="icon-btn" title="Copy link" onClick={() => copyLink(inv.token)}><Copy /></button>
                    <button className="icon-btn" title="Resend" onClick={() => resendInvitation(inv)}><Send /></button>
                    <button className="icon-btn danger" title="Revoke" onClick={() => revokeInvitation(inv.id)}><X /></button>
                  </>
                )}
                {status === 'expired' && (
                  <button className="icon-btn" title="Resend" onClick={() => resendInvitation(inv)}><Send /></button>
                )}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}
