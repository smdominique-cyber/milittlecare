// One caregiver's full training log (docs/staff_training_tracking_spec.md
// § 3.3). Used two ways: the licensee drilling into a roster member, and
// a staff member viewing their own page. Pure presentation + local
// show-archived toggle.

import { useMemo, useState } from 'react'
import { ArrowLeft, Plus, UserCog } from 'lucide-react'
import {
  CATEGORY_META,
  REGULATORY_ROLE_META,
  MIREGISTRY_STATUS_META,
  BACKGROUND_CHECK_STATUS_META,
  formatShortDate,
} from '@/lib/staffTraining'

function recordMeta(record) {
  const parts = [`Completed ${formatShortDate(record.completed_on)}`]
  if (record.expires_on) parts.push(`expires ${formatShortDate(record.expires_on)}`)
  if (record.hours != null) parts.push(`${Number(record.hours)} hrs`)
  if (record.miregistry_status) {
    parts.push(MIREGISTRY_STATUS_META[record.miregistry_status]?.label || record.miregistry_status)
  }
  if (record.background_check_status) {
    parts.push(BACKGROUND_CHECK_STATUS_META[record.background_check_status]?.label || record.background_check_status)
  }
  if (record.issuer) parts.push(record.issuer)
  return parts.join(' · ')
}

export default function CaregiverTrainingLog({
  caregiver,
  records,
  onAddRecord,
  onEditRecord,
  onAssignRoles,
  onBack,
}) {
  const [showArchived, setShowArchived] = useState(false)

  const mine = useMemo(
    () => (records || []).filter(r => r.caregiver_id === caregiver?.id),
    [records, caregiver]
  )
  const active = useMemo(
    () =>
      mine
        .filter(r => r.archived_at == null)
        .sort((a, b) => String(b.completed_on).localeCompare(String(a.completed_on))),
    [mine]
  )
  const archived = useMemo(
    () =>
      mine
        .filter(r => r.archived_at != null)
        .sort((a, b) => String(b.completed_on).localeCompare(String(a.completed_on))),
    [mine]
  )

  const roles = caregiver?.regulatory_roles || []

  return (
    <div className="st-card">
      {onBack && (
        <button type="button" className="st-link-btn" onClick={onBack}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 'var(--space-3)' }}>
          <ArrowLeft size={14} /> Back to roster
        </button>
      )}

      <div className="st-log-head">
        <h3 className="st-log-name">{caregiver?.full_name}</h3>
        {roles.map(r => (
          <span key={r.id || r.regulatory_role} className="st-role-chip">
            {REGULATORY_ROLE_META[r.regulatory_role]?.label || r.regulatory_role}
          </span>
        ))}
      </div>
      {caregiver?.date_of_hire && (
        <p className="st-record-meta" style={{ margin: 0 }}>
          Hire date: {formatShortDate(caregiver.date_of_hire)}
        </p>
      )}

      <div className="st-actions" style={{ marginTop: 'var(--space-3)' }}>
        <button className="btn-save st-btn-row" onClick={() => onAddRecord?.(caregiver)}>
          <Plus size={14} /> Add a training record
        </button>
        {onAssignRoles && (
          <button className="btn-discard st-btn-row" onClick={() => onAssignRoles(caregiver)}>
            <UserCog size={14} /> Assign regulatory roles
          </button>
        )}
        {archived.length > 0 && (
          <button className="btn-discard st-btn-row" onClick={() => setShowArchived(v => !v)}>
            {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
          </button>
        )}
      </div>

      {active.length === 0 ? (
        <p className="st-empty-note" style={{ marginTop: 'var(--space-3)' }}>
          No training recorded yet. Start with the most recent training —
          older entries can be added afterward.
        </p>
      ) : (
        <div className="st-record-list">
          {active.map(record => (
            <RecordRow key={record.id} record={record} onEdit={() => onEditRecord?.(record)} />
          ))}
        </div>
      )}

      {showArchived && archived.length > 0 && (
        <div className="st-record-list">
          {archived.map(record => (
            <RecordRow key={record.id} record={record} archived />
          ))}
        </div>
      )}
    </div>
  )
}

function RecordRow({ record, onEdit, archived = false }) {
  return (
    <div className={`st-record${archived ? ' archived' : ''}`}>
      <div className="st-record-main">
        <span className="st-record-cat">
          {CATEGORY_META[record.category]?.label || record.category}
        </span>
        <span className="st-record-title">{record.title}</span>
        <span className="st-record-meta">{recordMeta(record)}</span>
        {record.notes && <span className="st-record-meta">{record.notes}</span>}
      </div>
      {!archived && onEdit && (
        <button type="button" className="st-link-btn" onClick={onEdit}>Edit</button>
      )}
      {archived && <span className="st-record-cat">Archived</span>}
    </div>
  )
}
