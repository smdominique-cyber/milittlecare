// TODO(testing): Render tests pending React Testing Library install.
// Cover: add+edit modes, source-radio rendering, validation summary
// surfacing on failed save attempt only, soft-block one-shot override
// for pre-2020 completed_on dates, the level_2 + sub-1-hour soft
// warning, archive flow, dirty-detect cancel, and Escape-key dismiss.

import { useEffect, useId, useMemo, useState } from 'react'
import { Archive, Info, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { SOURCE, todayYMD } from '@/lib/miregistry'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SOURCE_OPTIONS = [
  {
    value: SOURCE.LEPPT,
    label: 'LEPPT (initial training)',
    help:
      'The one-time License Exempt Provider Preservice Training. ' +
      'Required to enroll as a license-exempt CDC provider. Costs ' +
      '$10. You only complete this once in your career. If you opted ' +
      'out of the CPR/first-aid portion because you had a current ' +
      'card, log only the hours you actually completed.',
  },
  {
    value: SOURCE.ANNUAL_ONGOING,
    label: 'Annual Ongoing Training',
    help:
      'The Michigan Ongoing Health & Safety Refresher. Required ' +
      'every year by December 16. Free. Up to 2 hours of this ' +
      'training count toward your 10 annual Level 2 hours.',
  },
  {
    value: SOURCE.LEVEL_2_APPROVED,
    label: 'Level 2 approved training',
    help:
      'Any other MiRegistry-approved training that counts toward ' +
      'your annual 10 hours for Level 2 pay rate. Each session must ' +
      'be at least 1 hour to count.',
  },
  {
    value: SOURCE.OTHER,
    label: 'Other',
    help:
      'Any training you want a record of that doesn’t fit the ' +
      'categories above. Doesn’t count toward Level 2 progress.',
  },
]

const SOURCE_LABEL_BY_VALUE = Object.fromEntries(
  SOURCE_OPTIONS.map(o => [o.value, o.label])
)

// -----------------------------------------------------------------------------
// Help copy (per CLAUDE.md § Documentation Conventions rule 1)
// -----------------------------------------------------------------------------

const INTRO_NOTICE =
  'Log a training from your MiRegistry transcript. Past trainings ' +
  'work too — the completion date determines which year they count ' +
  'toward.'

const FIELD_HELP = {
  source:
    'Pick which kind of training this was. Your choice determines ' +
    'which deadline or level rule it counts toward.',
  title:
    'The name MiRegistry shows for this training. Copy from your ' +
    'transcript so future-you can match it up.',
  completed_on:
    'The date you finished the training (not the date you ' +
    'registered). Use the date from your MiRegistry transcript.',
  hours:
    'How many training hours this counted for, per MiRegistry. ' +
    'Decimals OK (e.g. 1.5).',
  miregistry_event_id:
    'If your MiRegistry transcript shows a per-event ID, paste it ' +
    'here. We use this to match up trainings if we ever import ' +
    'directly from MiRegistry. Leave blank if you’re not sure — you ' +
    'can fill it in later.',
  notes:
    'Anything you want to remember about this training — what you ' +
    'learned, who taught it, etc. Visible only to you and your staff.',
}

const VALIDATION = {
  source_required:    'Pick a training type to continue.',
  title_required:     'Training title is required.',
  title_too_long:     'Title can’t be longer than 200 characters.',
  date_required:      'Completion date is required.',
  date_in_future:     'Completion date can’t be in the future.',
  date_too_old:
    'That date is more than 5 years old — please double-check. ' +
    'If it’s correct, save again to confirm.',
  hours_required:     'Hours is required.',
  hours_zero_or_less: 'Hours must be greater than 0.',
  hours_too_large:    'Hours must be less than 100.',
  event_id_too_long:  'Event ID can’t be longer than 50 characters.',
}

const WARNING_LEVEL_2_SHORT_SESSION =
  'Per the handbook (page 13), Level 2 trainings must be at least 1 ' +
  'hour to count toward your annual 10. We’ll save it anyway for ' +
  'your records, but it won’t count toward Level 2.'

const SAVE_ERROR_GENERIC =
  'Couldn’t save. Try again, or email support@milittlecare.com if ' +
  'it keeps happening.'

const ARCHIVE_CONFIRM =
  'Archive this training entry?\n\n' +
  'It stays on file in case you need it later — nothing is ' +
  'permanently deleted. You can restore it from the entries list.'

const SOFT_BLOCK_DATE_THRESHOLD = '2020-01-01'

// -----------------------------------------------------------------------------
// Validation (pure)
// -----------------------------------------------------------------------------

function validate({ form, acknowledgedOldDate }) {
  const errors = {}
  const warnings = {}
  const today = todayYMD()

  if (!form.source) {
    errors.source = VALIDATION.source_required
  }

  if (!form.title || !form.title.trim()) {
    errors.title = VALIDATION.title_required
  } else if (form.title.length > 200) {
    errors.title = VALIDATION.title_too_long
  }

  if (!form.completed_on) {
    errors.completed_on = VALIDATION.date_required
  } else if (form.completed_on > today) {
    errors.completed_on = VALIDATION.date_in_future
  } else if (
    form.completed_on < SOFT_BLOCK_DATE_THRESHOLD &&
    form.completed_on !== acknowledgedOldDate
  ) {
    errors.completed_on = VALIDATION.date_too_old
  }

  if (form.hours === '' || form.hours === null || form.hours === undefined) {
    errors.hours = VALIDATION.hours_required
  } else {
    const n = Number(form.hours)
    if (!Number.isFinite(n) || n <= 0) {
      errors.hours = VALIDATION.hours_zero_or_less
    } else if (n >= 100) {
      errors.hours = VALIDATION.hours_too_large
    } else if (form.source === SOURCE.LEVEL_2_APPROVED && n < 1) {
      // Soft warning: doesn't block save, but signals the entry won't
      // count toward Level 2 progress per handbook page 13.
      warnings.hours = WARNING_LEVEL_2_SHORT_SESSION
    }
  }

  if (form.miregistry_event_id && form.miregistry_event_id.length > 50) {
    errors.miregistry_event_id = VALIDATION.event_id_too_long
  }

  return { errors, warnings }
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

function defaultFormState(existingEntry) {
  if (existingEntry) {
    return {
      source: existingEntry.source || '',
      title: existingEntry.title || '',
      completed_on: existingEntry.completed_on || '',
      hours: existingEntry.hours ?? '',
      miregistry_event_id: existingEntry.miregistry_event_id || '',
      notes: existingEntry.notes || '',
    }
  }
  return {
    source: '',
    title: '',
    completed_on: todayYMD(),
    hours: '',
    miregistry_event_id: '',
    notes: '',
  }
}

export default function TrainingEntryForm({
  existingEntry = null,
  onClose,
  onSaved,
}) {
  const { user } = useAuth()
  const isEditing = !!existingEntry

  const [form, setForm] = useState(() => defaultFormState(existingEntry))
  const [saving, setSaving] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [acknowledgedOldDate, setAcknowledgedOldDate] = useState(null)

  // Lazy snapshot for dirty-detect cancel. Same pattern as FundingSourceForm:
  // capture initial state once at mount; never updates even if props change
  // (parent re-mounts via key on existingEntry swap).
  const [initialSnapshot] = useState(() =>
    JSON.stringify(defaultFormState(existingEntry))
  )

  // Stable IDs for accessible label/input/error association.
  const titleInputId        = useId()
  const completedOnInputId  = useId()
  const hoursInputId        = useId()
  const eventIdInputId      = useId()
  const notesInputId        = useId()
  const sourceGroupId       = useId()

  const { errors, warnings } = useMemo(
    () => validate({ form, acknowledgedOldDate }),
    [form, acknowledgedOldDate]
  )

  const updateForm = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const handleCancel = () => {
    const currentSnapshot = JSON.stringify(form)
    const dirty = currentSnapshot !== initialSnapshot
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose?.()
  }

  // Escape dismisses with the same dirty check.
  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCancel])

  const handleSave = async () => {
    setSubmitAttempted(true)

    // Soft-block one-shot override: if the only blocker is the
    // pre-2020 date warning, mark it acknowledged and let the user
    // click Save again to confirm. The acknowledgement is tied to the
    // exact date string — changing the date re-triggers the block.
    if (
      Object.keys(errors).length === 1 &&
      errors.completed_on === VALIDATION.date_too_old
    ) {
      setAcknowledgedOldDate(form.completed_on)
      return
    }

    if (Object.keys(errors).length > 0) return

    setSaving(true)
    setSaveError(null)
    try {
      const payload = {
        source: form.source,
        title: form.title.trim(),
        completed_on: form.completed_on,
        hours: Number(form.hours),
        miregistry_event_id: form.miregistry_event_id?.trim() || null,
        notes: form.notes?.trim() || null,
      }

      if (isEditing) {
        const { error } = await supabase
          .from('miregistry_training_entries')
          .update(payload)
          .eq('id', existingEntry.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('miregistry_training_entries')
          .insert({ ...payload, user_id: user?.id })
        if (error) throw error
      }

      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('TrainingEntryForm: save failed', err)
      setSaveError(SAVE_ERROR_GENERIC)
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async () => {
    if (!isEditing) return
    if (!window.confirm(ARCHIVE_CONFIRM)) return
    setSaving(true)
    setSaveError(null)
    try {
      const { error } = await supabase
        .from('miregistry_training_entries')
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user?.id || null,
        })
        .eq('id', existingEntry.id)
      if (error) throw error
      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('TrainingEntryForm: archive failed', err)
      setSaveError(SAVE_ERROR_GENERIC)
    } finally {
      setSaving(false)
    }
  }

  const headerTitle = isEditing
    ? 'Edit training entry'
    : 'Log a training'

  const visibleErrors = submitAttempted ? errors : {}
  const errorMessages = Object.values(visibleErrors)

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div
        className="modal-card"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 560, width: '95%' }}
      >
        <div className="modal-header">
          <span className="modal-title">{headerTitle}</span>
          <button className="modal-close" onClick={handleCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          {!isEditing && <Notice text={INTRO_NOTICE} />}

          {errorMessages.length > 0 && (
            <div role="alert" style={errorBannerStyle}>
              <strong>Couldn’t save. Fix the items below:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {errorMessages.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          <SourceRadioGroup
            groupId={sourceGroupId}
            value={form.source}
            onChange={v => updateForm('source', v)}
            error={visibleErrors.source}
          />

          <FieldGroup
            label="Training title *"
            help={FIELD_HELP.title}
            htmlFor={titleInputId}
            error={visibleErrors.title}
          >
            <input
              id={titleInputId}
              className="field-input"
              type="text"
              maxLength={200}
              placeholder="e.g. CPR/First Aid Certification"
              value={form.title}
              onChange={e => updateForm('title', e.target.value)}
              aria-invalid={!!visibleErrors.title}
            />
          </FieldGroup>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 'var(--space-3)',
            }}
          >
            <FieldGroup
              label="Completed on *"
              help={FIELD_HELP.completed_on}
              htmlFor={completedOnInputId}
              error={visibleErrors.completed_on}
            >
              <input
                id={completedOnInputId}
                className="field-input"
                type="date"
                max={todayYMD()}
                value={form.completed_on}
                onChange={e => updateForm('completed_on', e.target.value)}
                aria-invalid={!!visibleErrors.completed_on}
              />
            </FieldGroup>

            <FieldGroup
              label="Hours *"
              help={FIELD_HELP.hours}
              htmlFor={hoursInputId}
              error={visibleErrors.hours}
              warning={warnings.hours}
            >
              <input
                id={hoursInputId}
                className="field-input"
                type="number"
                step="0.25"
                min="0"
                placeholder="e.g. 2.0"
                value={form.hours}
                onChange={e => updateForm('hours', e.target.value)}
                aria-invalid={!!visibleErrors.hours}
              />
            </FieldGroup>
          </div>

          <FieldGroup
            label="MiRegistry event ID (optional)"
            help={FIELD_HELP.miregistry_event_id}
            htmlFor={eventIdInputId}
            error={visibleErrors.miregistry_event_id}
          >
            <input
              id={eventIdInputId}
              className="field-input"
              type="text"
              maxLength={50}
              value={form.miregistry_event_id}
              onChange={e => updateForm('miregistry_event_id', e.target.value)}
              aria-invalid={!!visibleErrors.miregistry_event_id}
            />
          </FieldGroup>

          <FieldGroup
            label="Notes"
            help={FIELD_HELP.notes}
            htmlFor={notesInputId}
          >
            <textarea
              id={notesInputId}
              className="field-input"
              rows={3}
              value={form.notes}
              onChange={e => updateForm('notes', e.target.value)}
            />
          </FieldGroup>

          {saveError && (
            <div role="alert" style={{ color: 'var(--clr-danger, #b00020)' }}>
              {saveError}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {/* Archive lives left-aligned; visually less prominent than Save. */}
          {isEditing && (
            <button
              className="btn-discard"
              onClick={handleArchive}
              disabled={saving}
              style={{
                marginRight: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Archive size={14} /> Archive
            </button>
          )}
          <button className="btn-discard" onClick={handleCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={saving}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function FieldGroup({ label, help, htmlFor, error, warning, children }) {
  return (
    <div className="form-field-group">
      <label
        htmlFor={htmlFor}
        className="field-label"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span>{label}</span>
        {help && (
          <HelpTooltip text={help} label={`Help: ${label}`}>
            <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        )}
      </label>
      {children}
      {error && <FieldError text={error} />}
      {warning && !error && <FieldWarning text={warning} />}
    </div>
  )
}

function FieldError({ text }) {
  return (
    <div
      role="alert"
      style={{
        color: 'var(--clr-danger, #b00020)',
        fontSize: '0.8125rem',
        marginTop: 4,
      }}
    >
      {text}
    </div>
  )
}

function FieldWarning({ text }) {
  // Not a role="alert" — warnings are informational, not blocking.
  return (
    <div
      style={{
        color: 'var(--clr-warn-ink, #8a6a1a)',
        background: 'var(--clr-warn-pale, #fdf3d8)',
        border: '1px solid var(--clr-warn-mid, #e8d196)',
        borderRadius: 'var(--radius-sm)',
        padding: '6px 10px',
        fontSize: '0.8125rem',
        marginTop: 6,
        lineHeight: 1.45,
      }}
    >
      {text}
    </div>
  )
}

function Notice({ text }) {
  return (
    <div
      style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        fontSize: '0.875rem',
        lineHeight: 1.5,
        color: 'var(--clr-ink-soft)',
      }}
    >
      {text}
    </div>
  )
}

function SourceRadioGroup({ groupId, value, onChange, error }) {
  return (
    <fieldset
      style={{
        border: 0,
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
      aria-describedby={error ? `${groupId}-error` : undefined}
    >
      <legend
        className="field-label"
        style={{
          padding: 0,
          marginBottom: 8,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>Training type *</span>
        <HelpTooltip text={FIELD_HELP.source} label="Help: Training type">
          <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
        </HelpTooltip>
      </legend>

      {SOURCE_OPTIONS.map(opt => (
        <label
          key={opt.value}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            border: '1px solid var(--clr-warm-mid)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            background:
              value === opt.value ? 'var(--clr-cream)' : 'transparent',
          }}
        >
          <input
            type="radio"
            name={groupId}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 500, color: 'var(--clr-ink)' }}>
              {opt.label}
            </span>
            <span
              style={{
                display: 'block',
                marginTop: 2,
                fontSize: '0.8125rem',
                color: 'var(--clr-ink-soft)',
                lineHeight: 1.45,
              }}
            >
              {opt.help}
            </span>
          </span>
        </label>
      ))}

      {error && (
        <div
          id={`${groupId}-error`}
          role="alert"
          style={{
            color: 'var(--clr-danger, #b00020)',
            fontSize: '0.8125rem',
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </fieldset>
  )
}

// -----------------------------------------------------------------------------
// Inline styles (per docs/tech_debt.md note on funding/ folder; same pattern
// applies here pending the CSS extraction PR).
// -----------------------------------------------------------------------------

const errorBannerStyle = {
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
}

// SOURCE_LABEL_BY_VALUE is exported indirectly for any caller that wants to
// render a badge for an entry's source. Not used inside this file.
export { SOURCE_LABEL_BY_VALUE }
