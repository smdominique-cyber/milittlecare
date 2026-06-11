// Staff Training page (docs/staff_training_tracking_spec.md § 3).
// Route /staff-training, sidebar Compliance section, gated to licensed
// providers by MODULE_KEYS.STAFF_TRAINING.
//
// Role-aware (spec § 3.1):
//   - licensee → roster compliance dashboard + drill-in to one log
//   - staff    → their own training log only
//
// Derivation is done by the pure helpers in src/lib/staffTraining.js;
// data loading by useStaffTraining. This file orchestrates the surfaces
// and owns the modal state.

import { useEffect, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertCircle, Info, Plus, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useStaffTraining } from '@/hooks/useStaffTraining'
import {
  getStaffComplianceMatrix,
  todayYMD,
  ON_FILE_TO_MIREGISTRY_CUTOVER,
  formatShortDate,
} from '@/lib/staffTraining'
import StaffComplianceMatrix from '@/components/staffTraining/StaffComplianceMatrix'
import ExpiringSoonList from '@/components/staffTraining/ExpiringSoonList'
import CaregiverTrainingLog from '@/components/staffTraining/CaregiverTrainingLog'
import TrainingEntryForm from '@/components/staffTraining/TrainingEntryForm'
import RegulatoryRoleAssignment from '@/components/staffTraining/RegulatoryRoleAssignment'
import '@/styles/staff-training.css'

const CUTOVER_NOTICE =
  `Until ${formatShortDate(ON_FILE_TO_MIREGISTRY_CUTOVER)}, training ` +
  'verification is maintained on file at the child care home. On and ' +
  'after that date, MiLEAP rules require qualifications and professional ' +
  'development to be reflected as verified in MiRegistry (R 400.1922(3), ' +
  'R 400.1924(10)). Keep logging records here either way.'

export default function StaffTrainingPage() {
  const { user } = useAuth()
  const { loading, error, isLicensee, roster, records, requirements, updates, refresh } =
    useStaffTraining()

  const [params, setParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState(null)
  const [entryForm, setEntryForm] = useState(null)   // { caregiver, record }
  const [roleModal, setRoleModal] = useState(null)   // caregiver
  const [addingCaregiver, setAddingCaregiver] = useState(false)

  const rosterById = useMemo(
    () => new Map(roster.map(c => [c.id, c])),
    [roster]
  )

  // 3.1b-2 — ?caregiver=<id> deep-link from the compliance checklist.
  // Validated against the loaded roster (the FamiliesPage ?family=
  // precedent): an unknown or absent id leaves the default roster
  // view, never errors. Licensee-only — the staff self-view ignores
  // selectedId entirely.
  useEffect(() => {
    if (loading || !isLicensee) return
    const requested = params.get('caregiver')
    if (!requested) return
    if (rosterById.has(requested)) setSelectedId(requested)
  }, [loading, isLicensee, params, rosterById])

  function clearDeepLinkParams() {
    // Tidy the URL when the drill-in closes so refreshing doesn't
    // re-trigger the deep-link, and forward/back navigation behaves.
    if (!params.get('caregiver')) return
    const next = new URLSearchParams(params)
    next.delete('caregiver')
    setParams(next, { replace: true })
  }

  // Active roster, self first, then alphabetical (spec § 3.2 mock).
  const activeRoster = useMemo(() => {
    return roster
      .filter(c => c.archived_at == null)
      .sort((a, b) => {
        const aSelf = a.app_user_id === user?.id
        const bSelf = b.app_user_id === user?.id
        if (aSelf !== bSelf) return aSelf ? -1 : 1
        return String(a.full_name).localeCompare(String(b.full_name))
      })
  }, [roster, user])

  const archivedRoster = useMemo(
    () => roster.filter(c => c.archived_at != null),
    [roster]
  )

  const matrix = useMemo(
    () => getStaffComplianceMatrix({
      roster: activeRoster,
      records,
      requirements,
      updates,
      today: todayYMD(),
    }),
    [activeRoster, records, requirements, updates]
  )

  const selectedCaregiver = selectedId ? rosterById.get(selectedId) : null

  // -- handlers -------------------------------------------------------------
  const openAdd = caregiver => setEntryForm({ caregiver, record: null })
  const openEdit = record => {
    setEntryForm({ caregiver: rosterById.get(record.caregiver_id), record })
  }
  const closeModals = () => {
    setEntryForm(null)
    setRoleModal(null)
    setAddingCaregiver(false)
  }
  const handleSaved = () => {
    closeModals()
    refresh()
  }

  // -- render ---------------------------------------------------------------
  if (loading) {
    return (
      <div className="st-page">
        <p className="st-loading">Loading staff training records…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="st-page">
        <div role="alert" className="st-error-banner">
          <AlertCircle size={14} />
          Couldn’t load staff training data. Refresh the page, or email
          support@milittlecare.com if it keeps happening.
        </div>
      </div>
    )
  }

  // ---- Staff self-view ----
  if (!isLicensee) {
    const myCaregiver = roster[0] || null
    return (
      <div className="st-page">
        <header>
          <h2 className="st-title">My Training</h2>
          <p className="st-subtitle">
            Your training records for the licensed home you work in.
          </p>
        </header>
        <CutoverBanner />
        {myCaregiver ? (
          <CaregiverTrainingLog
            caregiver={myCaregiver}
            records={records}
            onAddRecord={openAdd}
            onEditRecord={openEdit}
          />
        ) : (
          <div className="st-card">
            <p className="st-empty-note">
              No training records are linked to your account yet. Your
              licensee adds you to the roster — once they do, your training
              log appears here.
            </p>
          </div>
        )}
        {entryForm && (
          <TrainingEntryForm
            caregiver={entryForm.caregiver}
            existingRecord={entryForm.record}
            onClose={closeModals}
            onSaved={handleSaved}
          />
        )}
      </div>
    )
  }

  // ---- Licensee view ----
  return (
    <div className="st-page">
      <header>
        <h2 className="st-title">Staff Training</h2>
        <p className="st-subtitle">
          Training compliance for every caregiver working under your license —
          you, co-providers, assistants, volunteers, and drivers.
        </p>
      </header>

      <CutoverBanner />

      {selectedCaregiver ? (
        <CaregiverTrainingLog
          caregiver={selectedCaregiver}
          records={records}
          onAddRecord={openAdd}
          onEditRecord={openEdit}
          onAssignRoles={c => setRoleModal(c)}
          onBack={() => {
            setSelectedId(null)
            clearDeepLinkParams()
          }}
        />
      ) : (
        <>
          <ExpiringSoonList attentionItems={matrix.attentionItems} />
          <StaffComplianceMatrix
            matrix={matrix}
            onSelectCaregiver={c => setSelectedId(c.id)}
          />
          <div className="st-actions">
            <button className="btn-save st-btn-row" onClick={() => setAddingCaregiver(true)}>
              <Plus size={14} /> Add a caregiver
            </button>
          </div>

          {activeRoster.length <= 1 && (
            <p className="st-empty-note">
              No staff added yet. Your own training is tracked here too —
              add co-providers, assistants, volunteers, or drivers as you
              bring them on, and assign each person their regulatory roles.
            </p>
          )}

          {archivedRoster.length > 0 && (
            <div className="st-card">
              <h3 className="st-section-title">Archived caregivers</h3>
              <p className="st-empty-note" style={{ marginBottom: 'var(--space-2)' }}>
                Records for former staff are retained for at least 2 years
                after they leave (R&nbsp;400.1906(2)).
              </p>
              {archivedRoster.map(c => (
                <button
                  key={c.id}
                  type="button"
                  className="st-caregiver-link"
                  style={{ display: 'block', marginTop: 4 }}
                  onClick={() => setSelectedId(c.id)}
                >
                  {c.full_name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {entryForm && (
        <TrainingEntryForm
          caregiver={entryForm.caregiver}
          existingRecord={entryForm.record}
          onClose={closeModals}
          onSaved={handleSaved}
        />
      )}
      {roleModal && (
        <RegulatoryRoleAssignment
          caregiver={roleModal}
          onClose={closeModals}
          onSaved={handleSaved}
        />
      )}
      {addingCaregiver && (
        <AddCaregiverModal
          licenseeId={user?.id}
          onClose={closeModals}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

function CutoverBanner() {
  return (
    <div className="st-info-banner">
      <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{CUTOVER_NOTICE}</span>
    </div>
  )
}

// Page-local: a minimal modal to add a caregiver to the roster. Kept
// inline (the MiRegistryPage IDPromptCard pattern) — it is a small,
// page-specific surface with no reuse expected.
function AddCaregiverModal({ licenseeId, onClose, onSaved }) {
  const nameId = useId()
  const emailId = useId()
  const hireId = useId()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [dateOfHire, setDateOfHire] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const save = async () => {
    if (!fullName.trim()) {
      setError('A name is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await supabase.from('caregivers').insert({
        licensee_id: licenseeId,
        full_name: fullName.trim(),
        email: email.trim() || null,
        date_of_hire: dateOfHire || null,
      })
      if (e) throw e
      onSaved?.()
    } catch (err) {
      console.error('AddCaregiverModal: insert failed', err)
      setError('Couldn’t add the caregiver. Try again, or email support@milittlecare.com.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 460, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">Add a caregiver</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-soft)', lineHeight: 1.5 }}>
            Add anyone who provides care under your license — a co-provider,
            assistant, volunteer, or driver. They do not need a MILittleCare
            login. After adding them, assign their regulatory roles.
          </p>
          <div className="form-field-group">
            <label htmlFor={nameId} className="field-label">Full name *</label>
            <input id={nameId} className="field-input" type="text" maxLength={120}
              value={fullName} onChange={e => setFullName(e.target.value)} />
          </div>
          <div className="form-field-group">
            <label htmlFor={emailId} className="field-label">Email (optional)</label>
            <input id={emailId} className="field-input" type="email" maxLength={160}
              value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="form-field-group">
            <label htmlFor={hireId} className="field-label">Date of hire (optional)</label>
            <input id={hireId} className="field-input" type="date" max={todayYMD()}
              value={dateOfHire} onChange={e => setDateOfHire(e.target.value)} />
            <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
              Used to track the 30-day MiRegistry and 90-day new-hire
              training deadlines.
            </p>
          </div>
          {error && <div role="alert" style={{ color: 'var(--clr-danger, #b00020)', fontSize: '0.875rem' }}>{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn-discard" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-save" onClick={save} disabled={saving}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
            {saving ? 'Saving…' : 'Add caregiver'}
          </button>
        </div>
      </div>
    </div>
  )
}
