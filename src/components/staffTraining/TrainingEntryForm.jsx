// Add / edit one staff training record (docs/staff_training_tracking_spec.md
// § 3.4). Modal, modelled on the MiRegistry TrainingEntryForm. Writes to
// public.staff_training_records (migration 012).
//
// TODO(testing): render tests pending React Testing Library install —
// consistent with the other feature folders. See docs/tech_debt.md.

import { useEffect, useId, useMemo, useState } from 'react'
import { Archive, Info, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import {
  CATEGORY,
  CATEGORY_META,
  MIREGISTRY_STATUS_META,
  BACKGROUND_CHECK_STATUS_META,
  todayYMD,
} from '@/lib/staffTraining'

const CATEGORY_ORDER = [
  CATEGORY.NEW_HIRE_TRAINING,
  CATEGORY.CPR_FIRST_AID,
  CATEGORY.PROFESSIONAL_DEVELOPMENT,
  CATEGORY.HEALTH_SAFETY_UPDATE_ACK,
  CATEGORY.MIREGISTRY_ACCOUNT,
  CATEGORY.BACKGROUND_CHECK,
  CATEGORY.OTHER,
]

const SAVE_ERROR =
  'Couldn’t save this training record. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

const ARCHIVE_CONFIRM =
  'Archive this training record?\n\n' +
  'It stays on file — staff and driver records must be retained for ' +
  '2 years after the person leaves (R 400.1906(2)), so nothing is ' +
  'permanently deleted. You can restore it from the log.'

function defaultForm(record) {
  if (record) {
    return {
      category: record.category || '',
      title: record.title || '',
      completed_on: record.completed_on || '',
      expires_on: record.expires_on || '',
      hours: record.hours ?? '',
      issuer: record.issuer || '',
      reference_code: record.reference_code || '',
      miregistry_status: record.miregistry_status || '',
      background_check_status: record.background_check_status || '',
      notes: record.notes || '',
    }
  }
  return {
    category: '',
    title: '',
    completed_on: todayYMD(),
    expires_on: '',
    hours: '',
    issuer: '',
    reference_code: '',
    miregistry_status: '',
    background_check_status: '',
    notes: '',
  }
}

function validate(form) {
  const errors = {}
  const today = todayYMD()
  if (!form.category) errors.category = 'Pick a training category.'
  if (!form.title || !form.title.trim()) errors.title = 'A title is required.'
  else if (form.title.length > 200) errors.title = 'Title can’t exceed 200 characters.'
  if (!form.completed_on) errors.completed_on = 'A completion date is required.'
  else if (form.completed_on > today) errors.completed_on = 'The completion date can’t be in the future.'
  if (form.expires_on && form.completed_on && form.expires_on < form.completed_on) {
    errors.expires_on = 'The expiry date can’t be before the completion date.'
  }
  if (form.hours !== '' && form.hours != null) {
    const n = Number(form.hours)
    if (!Number.isFinite(n) || n < 0) errors.hours = 'Hours must be a positive number.'
    else if (n >= 1000) errors.hours = 'Hours looks too large — double-check it.'
  }
  if (form.category === CATEGORY.MIREGISTRY_ACCOUNT && !form.miregistry_status) {
    errors.miregistry_status = 'Pick the MiRegistry membership status.'
  }
  if (form.category === CATEGORY.BACKGROUND_CHECK && !form.background_check_status) {
    errors.background_check_status = 'Pick the background-check status.'
  }
  return errors
}

export default function TrainingEntryForm({
  caregiver,
  existingRecord = null,
  onClose,
  onSaved,
}) {
  const { user } = useAuth()
  const isEditing = !!existingRecord

  const [form, setForm] = useState(() => defaultForm(existingRecord))
  const [saving, setSaving] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [initialSnapshot] = useState(() => JSON.stringify(defaultForm(existingRecord)))

  const titleId = useId()
  const completedId = useId()
  const expiresId = useId()
  const hoursId = useId()
  const issuerId = useId()
  const refId = useId()
  const miregistryId = useId()
  const bgId = useId()
  const notesId = useId()

  const errors = useMemo(() => validate(form), [form])
  const update = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const handleCancel = () => {
    if (JSON.stringify(form) !== initialSnapshot && !window.confirm('Discard unsaved changes?')) {
      return
    }
    onClose?.()
  }

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') handleCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const handleSave = async () => {
    setSubmitAttempted(true)
    if (Object.keys(errors).length > 0) return

    setSaving(true)
    setSaveError(null)
    try {
      const isMiregistry = form.category === CATEGORY.MIREGISTRY_ACCOUNT
      const isBackground = form.category === CATEGORY.BACKGROUND_CHECK
      // The migration-012 CHECK requires exactly the status column
      // matching the row's category to be populated.
      const payload = {
        category: form.category,
        title: form.title.trim(),
        completed_on: form.completed_on,
        expires_on: form.expires_on || null,
        hours: form.hours === '' || form.hours == null ? null : Number(form.hours),
        issuer: form.issuer.trim() || null,
        reference_code: form.reference_code.trim() || null,
        miregistry_status: isMiregistry ? form.miregistry_status : null,
        background_check_status: isBackground ? form.background_check_status : null,
        notes: form.notes.trim() || null,
      }

      if (isEditing) {
        const { error } = await supabase
          .from('staff_training_records')
          .update(payload)
          .eq('id', existingRecord.id)
        if (error) throw error
      } else {
        // RLS requires entered_by = auth.uid() on insert (spec § 9 d.4).
        const { error } = await supabase
          .from('staff_training_records')
          .insert({ ...payload, caregiver_id: caregiver.id, entered_by: user?.id })
        if (error) throw error
      }
      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('TrainingEntryForm: save failed', err)
      setSaveError(SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async () => {
    if (!isEditing || !window.confirm(ARCHIVE_CONFIRM)) return
    setSaving(true)
    setSaveError(null)
    try {
      const { error } = await supabase
        .from('staff_training_records')
        .update({ archived_at: new Date().toISOString(), archived_by: user?.id || null })
        .eq('id', existingRecord.id)
      if (error) throw error
      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('TrainingEntryForm: archive failed', err)
      setSaveError(SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  const visibleErrors = submitAttempted ? errors : {}
  const errorMessages = Object.values(visibleErrors)
  const meta = CATEGORY_META[form.category]

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">
            {isEditing ? 'Edit training record' : `Add a training record — ${caregiver?.full_name || ''}`}
          </span>
          <button className="modal-close" onClick={handleCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {errorMessages.length > 0 && (
            <div role="alert" style={errorBanner}>
              <strong>Couldn’t save. Fix the items below:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {errorMessages.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}

          <Field label="Training category *" htmlFor="" error={visibleErrors.category}>
            <select
              className="field-input"
              value={form.category}
              onChange={e => update('category', e.target.value)}
              aria-invalid={!!visibleErrors.category}
            >
              <option value="">Select a category…</option>
              {CATEGORY_ORDER.map(c => (
                <option key={c} value={c}>{CATEGORY_META[c].label}</option>
              ))}
            </select>
          </Field>
          {meta && <p style={categoryHelp}>{meta.help}</p>}

          <Field label="Title *" help="The name of the training, course, or certification." htmlFor={titleId} error={visibleErrors.title}>
            <input id={titleId} className="field-input" type="text" maxLength={200}
              placeholder="e.g. CPR & Pediatric First Aid (Red Cross)"
              value={form.title} onChange={e => update('title', e.target.value)}
              aria-invalid={!!visibleErrors.title} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Field label="Completed on *" help="The date the training was finished or the determination was made." htmlFor={completedId} error={visibleErrors.completed_on}>
              <input id={completedId} className="field-input" type="date" max={todayYMD()}
                value={form.completed_on} onChange={e => update('completed_on', e.target.value)}
                aria-invalid={!!visibleErrors.completed_on} />
            </Field>
            <Field
              label="Expires on"
              help="For CPR / first aid, copy the date from the certification card. For MiRegistry, the membership expiry date. Leave blank if it does not expire."
              htmlFor={expiresId}
              error={visibleErrors.expires_on}
            >
              <input id={expiresId} className="field-input" type="date"
                value={form.expires_on} onChange={e => update('expires_on', e.target.value)}
                aria-invalid={!!visibleErrors.expires_on} />
            </Field>
          </div>

          {form.category === CATEGORY.MIREGISTRY_ACCOUNT && (
            <Field label="MiRegistry membership status *" help="From the staff member's MiRegistry profile. Submitted, materials received, awaiting print, and current all count as non-expired (R 400.1922(1))." htmlFor={miregistryId} error={visibleErrors.miregistry_status}>
              <select id={miregistryId} className="field-input"
                value={form.miregistry_status} onChange={e => update('miregistry_status', e.target.value)}
                aria-invalid={!!visibleErrors.miregistry_status}>
                <option value="">Select a status…</option>
                {Object.entries(MIREGISTRY_STATUS_META).map(([v, m]) => (
                  <option key={v} value={v}>{m.label}</option>
                ))}
              </select>
            </Field>
          )}

          {form.category === CATEGORY.BACKGROUND_CHECK && (
            <Field label="Background-check status *" help="The eligibility determination result (R 400.1919)." htmlFor={bgId} error={visibleErrors.background_check_status}>
              <select id={bgId} className="field-input"
                value={form.background_check_status} onChange={e => update('background_check_status', e.target.value)}
                aria-invalid={!!visibleErrors.background_check_status}>
                <option value="">Select a status…</option>
                {Object.entries(BACKGROUND_CHECK_STATUS_META).map(([v, m]) => (
                  <option key={v} value={v}>{m.label}</option>
                ))}
              </select>
            </Field>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Field label="Hours" help="Clock hours, for professional-development training. Decimals OK." htmlFor={hoursId} error={visibleErrors.hours}>
              <input id={hoursId} className="field-input" type="number" step="0.25" min="0"
                placeholder="e.g. 2.0"
                value={form.hours} onChange={e => update('hours', e.target.value)}
                aria-invalid={!!visibleErrors.hours} />
            </Field>
            <Field label="Issuer" help="Who provided the training, e.g. American Red Cross." htmlFor={issuerId}>
              <input id={issuerId} className="field-input" type="text" maxLength={120}
                value={form.issuer} onChange={e => update('issuer', e.target.value)} />
            </Field>
          </div>

          <Field
            label="Reference / certificate ID"
            help="A certificate number, MiRegistry event ID, or — for a health & safety update — the notice this acknowledges. Optional."
            htmlFor={refId}
          >
            <input id={refId} className="field-input" type="text" maxLength={120}
              value={form.reference_code} onChange={e => update('reference_code', e.target.value)} />
          </Field>

          <Field label="Notes" htmlFor={notesId}>
            <textarea id={notesId} className="field-input" rows={3}
              value={form.notes} onChange={e => update('notes', e.target.value)} />
          </Field>

          {saveError && <div role="alert" style={{ color: 'var(--clr-danger, #b00020)' }}>{saveError}</div>}
        </div>

        <div className="modal-footer">
          {isEditing && (
            <button className="btn-discard" onClick={handleArchive} disabled={saving}
              style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Archive size={14} /> Archive
            </button>
          )}
          <button className="btn-discard" onClick={handleCancel} disabled={saving}>Cancel</button>
          <button className="btn-save" onClick={handleSave} disabled={saving}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, help, htmlFor, error, children }) {
  return (
    <div className="form-field-group">
      <label htmlFor={htmlFor || undefined} className="field-label"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span>{label}</span>
        {help && (
          <HelpTooltip text={help} label={`Help: ${label}`}>
            <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        )}
      </label>
      {children}
      {error && <div role="alert" className="st-field-error">{error}</div>}
    </div>
  )
}

const errorBanner = {
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
}

const categoryHelp = {
  margin: '-8px 0 0',
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.45,
}
