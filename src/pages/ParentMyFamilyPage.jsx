import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { notifyStateChange } from '@/lib/notifications'
import {
  ArrowLeft, User, Users, Phone, AlertTriangle, Baby,
  Plus, X, Save, Trash2, Pencil, Mail, Shield, Edit3, Check,
  AlertCircle, Loader, Download,
} from 'lucide-react'
import '@/styles/parent.css'
import '@/styles/parent-myfamily.css'

export default function ParentMyFamilyPage() {
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [families, setFamilies] = useState([])
  const [selectedFamily, setSelectedFamily] = useState(null)
  const [activeTab, setActiveTab] = useState('contact')
  const [parentProfile, setParentProfile] = useState(null)
  const [children, setChildren] = useState([])
  const [guardians, setGuardians] = useState([])
  const [emergency, setEmergency] = useState([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) { setLoading(false); return }
      await loadFamilies(session.user.id)
    }
    getSession()
  }, [])

  async function loadFamilies(parentId) {
    setLoading(true)
    const { data: links } = await supabase
      .from('parent_family_links')
      .select('*, families(*)')
      .eq('parent_id', parentId)
      .eq('status', 'active')
    const fams = (links || []).map(l => l.families).filter(Boolean)
    setFamilies(fams)
    if (fams.length > 0) {
      setSelectedFamily(fams[0])
      await loadFamilyData(fams[0].id, parentId)
    }
    setLoading(false)
  }

  async function loadFamilyData(familyId, parentId) {
    const [c, g, e, p] = await Promise.all([
      supabase.from('children').select('*').eq('family_id', familyId).order('birth_date', { ascending: false }),
      supabase.from('guardians').select('*').eq('family_id', familyId),
      supabase.from('emergency_contacts').select('*').eq('family_id', familyId),
      supabase.from('parent_profiles').select('*').eq('id', parentId).maybeSingle(),
    ])
    setChildren(c.data || [])
    setGuardians(g.data || [])
    setEmergency(e.data || [])
    setParentProfile(p.data || { id: parentId })
  }

  if (loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)', marginBottom: 12 }} />
          <div>Loading…</div>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <h2>Sign in required</h2>
          <p>Please use the link from your provider to access your family portal.</p>
        </div>
      </div>
    )
  }

  if (!selectedFamily) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <h2>No family found</h2>
          <p>Your provider hasn't linked you to a family yet.</p>
          <button className="parent-secondary" onClick={() => navigate('/parent')}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'contact', label: 'My Info', icon: User },
    { id: 'children', label: 'Children', icon: Baby, count: children.length },
    { id: 'guardians', label: 'Guardians', icon: Users, count: guardians.length },
    { id: 'emergency', label: 'Emergency', icon: AlertTriangle, count: emergency.length },
    { id: 'fsa', label: 'Tax / FSA', icon: Download },
  ]

  return (
    <div className="parent-shell">
      <div className="parent-container">
        <header className="parent-topbar">
          <button className="parent-back-btn" onClick={() => navigate('/parent')}>
            <ArrowLeft size={16} />
            <span>Back</span>
          </button>
          <div className="parent-brand-name" style={{ fontSize: '1rem' }}>
            My Family
          </div>
          <div style={{ width: 60 }} />
        </header>

        {message && (
          <div className={`parent-message ${message.type}`}>
            <span>{message.text}</span>
          </div>
        )}

        {/* Family selector if multiple */}
        {families.length > 1 && (
          <div className="myfamily-selector">
            {families.map(f => (
              <button
                key={f.id}
                className={`myfamily-selector-btn ${selectedFamily.id === f.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedFamily(f)
                  loadFamilyData(f.id, session.user.id)
                }}
              >
                {f.family_name}
              </button>
            ))}
          </div>
        )}

        <div className="myfamily-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`myfamily-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <t.icon size={14} />
              <span>{t.label}</span>
              {t.count > 0 && <span className="myfamily-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        {activeTab === 'contact' && (
          <ContactTab
            profile={parentProfile}
            family={selectedFamily}
            session={session}
            onSaved={(msg) => { setMessage(msg); loadFamilyData(selectedFamily.id, session.user.id) }}
          />
        )}
        {activeTab === 'children' && (
          <ChildrenTab
            children={children}
            family={selectedFamily}
            onSaved={(msg) => { setMessage(msg); loadFamilyData(selectedFamily.id, session.user.id) }}
          />
        )}
        {activeTab === 'guardians' && (
          <GuardiansTab
            guardians={guardians}
            family={selectedFamily}
            session={session}
            onSaved={(msg) => { setMessage(msg); loadFamilyData(selectedFamily.id, session.user.id) }}
          />
        )}
        {activeTab === 'emergency' && (
          <EmergencyTab
            emergency={emergency}
            family={selectedFamily}
            session={session}
            onSaved={(msg) => { setMessage(msg); loadFamilyData(selectedFamily.id, session.user.id) }}
          />
        )}
        {activeTab === 'fsa' && (
          <FSATab
            family={selectedFamily}
            session={session}
          />
        )}
      </div>
    </div>
  )
}

// ─── Contact Tab ─────────────────────────────────
function ContactTab({ profile, family, session, onSaved }) {
  const [form, setForm] = useState({
    full_name: profile?.full_name || '',
    phone: profile?.phone || '',
  })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await supabase.from('parent_profiles').update({
        full_name: form.full_name,
        phone: form.phone,
      }).eq('id', session.user.id)

      // Fire notification to provider
      const changes = []
      if (form.full_name !== profile?.full_name) changes.push('name')
      if (form.phone !== profile?.phone) changes.push('phone')
      if (changes.length > 0) {
        notifyStateChange('contact_updated', family.id, {
          changedBy: form.full_name,
          summary: `Updated ${changes.join(', ')}`,
        })
      }

      onSaved({ type: 'success', text: '✓ Your contact info has been updated' })
    } catch (err) {
      onSaved({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  return (
    <div className="myfamily-section">
      <div className="myfamily-section-header">
        <h3>Your Contact Information</h3>
        <p>This is what your provider sees. Email is set during invitation and can't be changed here.</p>
      </div>

      <div className="myfamily-field">
        <label>Email <span style={{ color: 'var(--clr-ink-soft)', fontWeight: 'normal' }}>(read-only)</span></label>
        <input className="myfamily-input" value={session.user.email} disabled />
      </div>

      <div className="myfamily-field">
        <label>Full name</label>
        <input
          className="myfamily-input"
          value={form.full_name}
          onChange={(e) => setForm(f => ({ ...f, full_name: e.target.value }))}
          placeholder="Mike Smith"
        />
      </div>

      <div className="myfamily-field">
        <label>Phone</label>
        <input
          className="myfamily-input"
          value={form.phone}
          onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
          placeholder="(555) 123-4567"
          type="tel"
        />
      </div>

      <button className="parent-cta" onClick={save} disabled={saving} style={{ width: 'auto' }}>
        <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}

// ─── Children Tab ─────────────────────────────────
function ChildrenTab({ children, family, onSaved }) {
  const [editingId, setEditingId] = useState(null)

  return (
    <div className="myfamily-section">
      <div className="myfamily-section-header">
        <h3>Children in {family.family_name}</h3>
        <p>Update allergies, medical notes, and other important info. Your provider is notified instantly when you save.</p>
      </div>

      {children.length === 0 ? (
        <div className="myfamily-empty">
          <Baby size={32} />
          <p>No children listed yet. Your provider will add them.</p>
        </div>
      ) : (
        children.map(child => (
          <ChildCard
            key={child.id}
            child={child}
            family={family}
            isEditing={editingId === child.id}
            onEdit={() => setEditingId(child.id)}
            onCancel={() => setEditingId(null)}
            onSaved={(msg) => { setEditingId(null); onSaved(msg) }}
          />
        ))
      )}
    </div>
  )
}

function ChildCard({ child, family, isEditing, onEdit, onCancel, onSaved }) {
  const [form, setForm] = useState({
    allergies: child.allergies || '',
    medical_notes: child.medical_notes || '',
    medications: child.medications || '',
    dietary_restrictions: child.dietary_restrictions || '',
  })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await supabase.from('children').update(form).eq('id', child.id)

      // Fire notification if allergies changed (LOUD)
      if (form.allergies !== (child.allergies || '')) {
        notifyStateChange('allergy_updated', family.id, {
          childName: `${child.first_name} ${child.last_name || ''}`.trim(),
          allergies: form.allergies || 'None listed',
        }, child.id)
      }

      onSaved({ type: 'success', text: `✓ Updated info for ${child.first_name}` })
    } catch (err) {
      onSaved({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  if (!isEditing) {
    return (
      <div className="myfamily-card">
        <div className="myfamily-card-header">
          <div>
            <div className="myfamily-card-title">{child.first_name} {child.last_name}</div>
            {child.birth_date && (
              <div className="myfamily-card-meta">
                Born {new Date(child.birth_date + 'T12:00:00').toLocaleDateString()}
              </div>
            )}
          </div>
          <button className="myfamily-edit-btn" onClick={onEdit}>
            <Pencil size={13} /> Edit
          </button>
        </div>

        <div className="myfamily-card-body">
          <Field label="Allergies" value={child.allergies} highlight={!!child.allergies} />
          <Field label="Medical notes" value={child.medical_notes} />
          <Field label="Medications" value={child.medications} />
          <Field label="Dietary restrictions" value={child.dietary_restrictions} />
        </div>
      </div>
    )
  }

  return (
    <div className="myfamily-card editing">
      <div className="myfamily-card-header">
        <div className="myfamily-card-title">{child.first_name} {child.last_name}</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--clr-accent)', fontWeight: 600 }}>EDITING</div>
      </div>

      <div className="myfamily-field">
        <label>Allergies <span style={{ color: 'var(--clr-error)' }}>★</span></label>
        <textarea
          className="myfamily-textarea"
          value={form.allergies}
          onChange={(e) => setForm(f => ({ ...f, allergies: e.target.value }))}
          placeholder="e.g., Peanuts (severe), shellfish, dairy intolerance"
          rows={2}
        />
        <p className="myfamily-helper">Your provider will be notified immediately of allergy changes.</p>
      </div>

      <div className="myfamily-field">
        <label>Medical notes</label>
        <textarea
          className="myfamily-textarea"
          value={form.medical_notes}
          onChange={(e) => setForm(f => ({ ...f, medical_notes: e.target.value }))}
          placeholder="Asthma, conditions, doctor info, etc."
          rows={2}
        />
      </div>

      <div className="myfamily-field">
        <label>Medications</label>
        <textarea
          className="myfamily-textarea"
          value={form.medications}
          onChange={(e) => setForm(f => ({ ...f, medications: e.target.value }))}
          placeholder="Current medications and dosages"
          rows={2}
        />
      </div>

      <div className="myfamily-field">
        <label>Dietary restrictions</label>
        <input
          className="myfamily-input"
          value={form.dietary_restrictions}
          onChange={(e) => setForm(f => ({ ...f, dietary_restrictions: e.target.value }))}
          placeholder="e.g., Vegetarian, no pork"
        />
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <button className="parent-secondary" onClick={onCancel} style={{ marginTop: 0 }}>Cancel</button>
        <button className="parent-cta" onClick={save} disabled={saving} style={{ width: 'auto', marginTop: 0 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Field({ label, value, highlight }) {
  return (
    <div className="myfamily-readfield">
      <div className="myfamily-readfield-label">{label}</div>
      <div className={`myfamily-readfield-value ${highlight ? 'highlight' : ''}`}>
        {value || <span style={{ color: 'var(--clr-ink-soft)' }}>None listed</span>}
      </div>
    </div>
  )
}

// ─── Guardians Tab ─────────────────────────────────
function GuardiansTab({ guardians, family, session, onSaved }) {
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  const startAdd = () => {
    setForm({ first_name: '', last_name: '', relationship: '', phone: '', email: '', authorized_pickup: true })
    setEditingId(null)
    setShowForm(true)
  }

  const startEdit = (g) => {
    setForm({ ...g })
    setEditingId(g.id)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.first_name) return
    setSaving(true)
    try {
      let savedGuardian
      if (editingId) {
        const { data } = await supabase.from('guardians').update({
          first_name: form.first_name,
          last_name: form.last_name,
          relationship: form.relationship,
          phone: form.phone,
          email: form.email,
          authorized_pickup: form.authorized_pickup,
        }).eq('id', editingId).select().maybeSingle()
        savedGuardian = data
      } else {
        const { data } = await supabase.from('guardians').insert({
          family_id: family.id,
          user_id: family.user_id,
          first_name: form.first_name,
          last_name: form.last_name,
          relationship: form.relationship,
          phone: form.phone,
          email: form.email,
          authorized_pickup: form.authorized_pickup,
        }).select().maybeSingle()
        savedGuardian = data

        notifyStateChange('guardian_added', family.id, {
          guardianName: `${form.first_name} ${form.last_name || ''}`.trim(),
          changedBy: session.user.user_metadata?.full_name || session.user.email,
        })
      }

      setShowForm(false)
      setEditingId(null)
      onSaved({ type: 'success', text: editingId ? '✓ Guardian updated' : '✓ Guardian added' })
    } catch (err) {
      onSaved({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const remove = async (g) => {
    if (!window.confirm(`Remove ${g.first_name} as a guardian?`)) return
    await supabase.from('guardians').delete().eq('id', g.id)
    notifyStateChange('guardian_removed', family.id, {
      guardianName: `${g.first_name} ${g.last_name || ''}`.trim(),
      changedBy: session.user.user_metadata?.full_name || session.user.email,
    })
    onSaved({ type: 'success', text: '✓ Guardian removed' })
  }

  return (
    <div className="myfamily-section">
      <div className="myfamily-section-header">
        <h3>Guardians & Authorized Pickup</h3>
        <p>People your provider should know about. Mark "authorized for pickup" to allow them to pick up your child.</p>
      </div>

      {!showForm && (
        <button className="myfamily-add-btn" onClick={startAdd}>
          <Plus size={14} /> Add guardian
        </button>
      )}

      {showForm && (
        <GuardianForm
          form={form}
          setForm={setForm}
          onSave={save}
          onCancel={() => { setShowForm(false); setEditingId(null) }}
          saving={saving}
          isEdit={!!editingId}
        />
      )}

      {guardians.length === 0 && !showForm ? (
        <div className="myfamily-empty">
          <Users size={32} />
          <p>No guardians listed yet.</p>
        </div>
      ) : (
        guardians.map(g => (
          <div key={g.id} className="myfamily-card">
            <div className="myfamily-card-header">
              <div>
                <div className="myfamily-card-title">
                  {g.first_name} {g.last_name}
                  {g.authorized_pickup && (
                    <span className="myfamily-pickup-badge">Pickup OK</span>
                  )}
                </div>
                <div className="myfamily-card-meta">{g.relationship}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="myfamily-edit-btn" onClick={() => startEdit(g)}>
                  <Pencil size={13} />
                </button>
                <button className="myfamily-del-btn" onClick={() => remove(g)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div className="myfamily-card-body">
              {g.phone && <div className="myfamily-readfield-value"><Phone size={12} style={{ display: 'inline', marginRight: 6 }} />{g.phone}</div>}
              {g.email && <div className="myfamily-readfield-value"><Mail size={12} style={{ display: 'inline', marginRight: 6 }} />{g.email}</div>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function GuardianForm({ form, setForm, onSave, onCancel, saving, isEdit }) {
  return (
    <div className="myfamily-card editing">
      <div className="myfamily-card-title" style={{ marginBottom: 12 }}>
        {isEdit ? 'Edit guardian' : 'Add guardian'}
      </div>
      <div className="myfamily-form-grid">
        <div className="myfamily-field">
          <label>First name *</label>
          <input className="myfamily-input" value={form.first_name || ''} onChange={(e) => setForm(f => ({ ...f, first_name: e.target.value }))} />
        </div>
        <div className="myfamily-field">
          <label>Last name</label>
          <input className="myfamily-input" value={form.last_name || ''} onChange={(e) => setForm(f => ({ ...f, last_name: e.target.value }))} />
        </div>
      </div>
      <div className="myfamily-field">
        <label>Relationship</label>
        <input className="myfamily-input" value={form.relationship || ''} onChange={(e) => setForm(f => ({ ...f, relationship: e.target.value }))} placeholder="Mother, Father, Grandmother, etc." />
      </div>
      <div className="myfamily-form-grid">
        <div className="myfamily-field">
          <label>Phone</label>
          <input className="myfamily-input" type="tel" value={form.phone || ''} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} />
        </div>
        <div className="myfamily-field">
          <label>Email</label>
          <input className="myfamily-input" type="email" value={form.email || ''} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))} />
        </div>
      </div>
      <label className="myfamily-toggle">
        <input
          type="checkbox"
          checked={!!form.authorized_pickup}
          onChange={(e) => setForm(f => ({ ...f, authorized_pickup: e.target.checked }))}
        />
        <span>Authorized to pick up children</span>
      </label>
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="parent-secondary" onClick={onCancel} style={{ marginTop: 0 }}>Cancel</button>
        <button className="parent-cta" onClick={onSave} disabled={saving || !form.first_name} style={{ width: 'auto', marginTop: 0 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ─── Emergency Tab ─────────────────────────────────
function EmergencyTab({ emergency, family, session, onSaved }) {
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)

  const startAdd = () => {
    setForm({ first_name: '', last_name: '', relationship: '', phone: '' })
    setEditingId(null)
    setShowForm(true)
  }

  const startEdit = (c) => {
    setForm({ ...c })
    setEditingId(c.id)
    setShowForm(true)
  }

  const save = async () => {
    if (!form.first_name || !form.phone) return
    setSaving(true)
    try {
      if (editingId) {
        await supabase.from('emergency_contacts').update({
          first_name: form.first_name,
          last_name: form.last_name,
          relationship: form.relationship,
          phone: form.phone,
        }).eq('id', editingId)
      } else {
        await supabase.from('emergency_contacts').insert({
          family_id: family.id,
          user_id: family.user_id,
          first_name: form.first_name,
          last_name: form.last_name,
          relationship: form.relationship,
          phone: form.phone,
        })
      }

      notifyStateChange('emergency_contact_updated', family.id, {
        changedBy: session.user.user_metadata?.full_name || session.user.email,
      })

      setShowForm(false)
      setEditingId(null)
      onSaved({ type: 'success', text: editingId ? '✓ Emergency contact updated' : '✓ Emergency contact added' })
    } catch (err) {
      onSaved({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const remove = async (c) => {
    if (!window.confirm(`Remove ${c.first_name} as an emergency contact?`)) return
    await supabase.from('emergency_contacts').delete().eq('id', c.id)
    notifyStateChange('emergency_contact_updated', family.id, {
      changedBy: session.user.user_metadata?.full_name || session.user.email,
    })
    onSaved({ type: 'success', text: '✓ Emergency contact removed' })
  }

  return (
    <div className="myfamily-section">
      <div className="myfamily-section-header">
        <h3>Emergency Contacts</h3>
        <p>People your provider should call in an emergency if you cannot be reached.</p>
      </div>

      {!showForm && (
        <button className="myfamily-add-btn" onClick={startAdd}>
          <Plus size={14} /> Add emergency contact
        </button>
      )}

      {showForm && (
        <div className="myfamily-card editing">
          <div className="myfamily-card-title" style={{ marginBottom: 12 }}>
            {editingId ? 'Edit emergency contact' : 'Add emergency contact'}
          </div>
          <div className="myfamily-form-grid">
            <div className="myfamily-field">
              <label>First name *</label>
              <input className="myfamily-input" value={form.first_name || ''} onChange={(e) => setForm(f => ({ ...f, first_name: e.target.value }))} />
            </div>
            <div className="myfamily-field">
              <label>Last name</label>
              <input className="myfamily-input" value={form.last_name || ''} onChange={(e) => setForm(f => ({ ...f, last_name: e.target.value }))} />
            </div>
          </div>
          <div className="myfamily-field">
            <label>Relationship</label>
            <input className="myfamily-input" value={form.relationship || ''} onChange={(e) => setForm(f => ({ ...f, relationship: e.target.value }))} placeholder="Aunt, Family friend, etc." />
          </div>
          <div className="myfamily-field">
            <label>Phone *</label>
            <input className="myfamily-input" type="tel" value={form.phone || ''} onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <button className="parent-secondary" onClick={() => { setShowForm(false); setEditingId(null) }} style={{ marginTop: 0 }}>Cancel</button>
            <button className="parent-cta" onClick={save} disabled={saving || !form.first_name || !form.phone} style={{ width: 'auto', marginTop: 0 }}>
              <Save size={14} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {emergency.length === 0 && !showForm ? (
        <div className="myfamily-empty">
          <AlertTriangle size={32} />
          <p>No emergency contacts listed yet.</p>
        </div>
      ) : (
        emergency.map(c => (
          <div key={c.id} className="myfamily-card">
            <div className="myfamily-card-header">
              <div>
                <div className="myfamily-card-title">{c.first_name} {c.last_name}</div>
                <div className="myfamily-card-meta">{c.relationship}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="myfamily-edit-btn" onClick={() => startEdit(c)}>
                  <Pencil size={13} />
                </button>
                <button className="myfamily-del-btn" onClick={() => remove(c)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div className="myfamily-card-body">
              <div className="myfamily-readfield-value"><Phone size={12} style={{ display: 'inline', marginRight: 6 }} />{c.phone}</div>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// ─── FSA Tab ─────────────────────────────────
function FSATab({ family, session }) {
  const [year, setYear] = useState(new Date().getFullYear() - 1)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const currentYear = new Date().getFullYear()

  const downloadStatement = async () => {
    setGenerating(true)
    setError(null)
    try {
      const { data: { session: sess } } = await supabase.auth.getSession()
      const resp = await fetch(`/api/parent-fsa-statement?family_id=${family.id}&year=${year}`, {
        headers: { 'Authorization': `Bearer ${sess.access_token}` },
      })
      if (!resp.ok) {
        const err = await resp.json()
        throw new Error(err.error || 'Failed to generate statement')
      }
      const blob = await resp.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `MI-Little-Care-FSA-${year}-${family.family_name.replace(/\s+/g, '_')}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      a.remove()
    } catch (err) {
      setError(err.message)
    }
    setGenerating(false)
  }

  return (
    <div className="myfamily-section">
      <div className="myfamily-section-header">
        <h3>Tax & FSA Statement</h3>
        <p>Download a year-end statement of all payments for your FSA reimbursement or tax filing.</p>
      </div>

      <div className="myfamily-field">
        <label>Tax year</label>
        <select className="myfamily-input" value={year} onChange={(e) => setYear(parseInt(e.target.value))}>
          {[currentYear, currentYear - 1, currentYear - 2, currentYear - 3].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      <div style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--clr-ink-mid)', lineHeight: 1.55 }}>
          The statement includes:
          <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
            <li>Provider name and address</li>
            <li>Provider tax ID (if entered)</li>
            <li>Total paid for the year</li>
            <li>Monthly breakdown</li>
            <li>Children in care</li>
          </ul>
        </div>
      </div>

      {error && <div className="parent-error"><AlertCircle size={14} /> {error}</div>}

      <button className="parent-cta" onClick={downloadStatement} disabled={generating} style={{ width: 'auto' }}>
        {generating ? (
          <><Loader size={14} className="spin" /> Generating…</>
        ) : (
          <><Download size={14} /> Download {year} statement</>
        )}
      </button>
    </div>
  )
}
