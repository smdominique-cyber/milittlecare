// TODO(testing): Render tests pending React Testing Library install.
// Cover: required-level validation, expiration-required-when-level-2,
// dirty-detect cancel, Escape dismissal, save flow, save error, and
// the level_last_updated_at stamp on save.

import { useEffect, useId, useMemo, useState } from 'react'
import { Info, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'

// Provider transcribes their level + expiration from their MiRegistry
// LEP Training Record. Per docs/miregistry_tracker_spec.md § 2.2 and
// § 3.2: MiRegistry is authoritative, we hold what they typed plus a
// "last updated by you on" stamp so they can gauge freshness.

const LEVEL_HELP =
  'Your current Level per the MiRegistry LEP Training Record. ' +
  'Level 1 is the default after LEPPT. Level 2 unlocks the higher ' +
  'pay rate and requires 10 approved hours per renewal cycle.'

const EXPIRATION_HELP =
  'Your Level 2 expiration date as printed on the MiRegistry LEP ' +
  'Training Record. MiRegistry computes this — we record what you ' +
  'see there. Each new 10-hour cycle resets it.'

const SAVE_ERROR_GENERIC =
  'Couldn’t save. Try again, or email support@milittlecare.com if ' +
  'it keeps happening.'

const VALIDATION = {
  level_required: 'Pick your current training level.',
  expiration_required:
    'Level 2 requires an expiration date. Copy it from your ' +
    'MiRegistry LEP Training Record.',
}

function defaultFormState(profile) {
  return {
    miregistry_current_level: profile?.miregistry_current_level || '',
    miregistry_level_2_expires_on:
      profile?.miregistry_level_2_expires_on || '',
  }
}

function validate(form) {
  const errors = {}
  if (!form.miregistry_current_level) {
    errors.miregistry_current_level = VALIDATION.level_required
  }
  if (
    form.miregistry_current_level === 'level_2' &&
    !form.miregistry_level_2_expires_on
  ) {
    errors.miregistry_level_2_expires_on = VALIDATION.expiration_required
  }
  return errors
}

export default function UpdateLevelModal({ profile, onClose, onSaved }) {
  const { user } = useAuth()
  const [form, setForm] = useState(() => defaultFormState(profile))
  const [saving, setSaving] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [initialSnapshot] = useState(() =>
    JSON.stringify(defaultFormState(profile))
  )

  const levelGroupId = useId()
  const expiresInputId = useId()

  const errors = useMemo(() => validate(form), [form])
  const visibleErrors = submitAttempted ? errors : {}

  const updateForm = (key, value) => setForm(f => ({ ...f, [key]: value }))

  const handleCancel = () => {
    const dirty = JSON.stringify(form) !== initialSnapshot
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose?.()
  }

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCancel])

  const handleSave = async () => {
    setSubmitAttempted(true)
    if (Object.keys(errors).length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      // Clear expiration when level reverts to level_1 — stale
      // expiration on a Level 1 row would be misleading.
      const expiresOn =
        form.miregistry_current_level === 'level_2'
          ? form.miregistry_level_2_expires_on
          : null

      const { error } = await supabase
        .from('profiles')
        .update({
          miregistry_current_level: form.miregistry_current_level,
          miregistry_level_2_expires_on: expiresOn,
          miregistry_level_last_updated_at: new Date().toISOString(),
        })
        .eq('id', user.id)
      if (error) throw error
      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('UpdateLevelModal: save failed', err)
      setSaveError(SAVE_ERROR_GENERIC)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div
        className="modal-card"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 480, width: '95%' }}
      >
        <div className="modal-header">
          <span className="modal-title">Update from MiRegistry</span>
          <button className="modal-close" onClick={handleCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-soft)', lineHeight: 1.5 }}>
            Open your MiRegistry LEP Training Record and copy your current
            level and (if applicable) Level 2 expiration date. We don’t pull
            this automatically — keeping it accurate is up to you.
          </p>

          <fieldset
            style={{ border: 0, padding: 0, margin: 0 }}
            aria-describedby={visibleErrors.miregistry_current_level ? `${levelGroupId}-error` : undefined}
          >
            <legend
              className="field-label"
              style={{ padding: 0, marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <span>Current level *</span>
              <HelpTooltip text={LEVEL_HELP} label="Help: Current level">
                <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
              </HelpTooltip>
            </legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={radioOptionStyle(form.miregistry_current_level === 'level_1')}>
                <input
                  type="radio"
                  name={levelGroupId}
                  checked={form.miregistry_current_level === 'level_1'}
                  onChange={() => updateForm('miregistry_current_level', 'level_1')}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>Level 1</strong>
                  <span style={optionSubStyle}>
                    Default after LEPPT. Pay rate $2.95/hour for all child age bands.
                  </span>
                </span>
              </label>
              <label style={radioOptionStyle(form.miregistry_current_level === 'level_2')}>
                <input
                  type="radio"
                  name={levelGroupId}
                  checked={form.miregistry_current_level === 'level_2'}
                  onChange={() => updateForm('miregistry_current_level', 'level_2')}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>Level 2</strong>
                  <span style={optionSubStyle}>
                    10+ approved training hours completed. Pay rate $4.95
                    (infant/toddler) or $4.40 (preschool / school-age) per hour.
                  </span>
                </span>
              </label>
            </div>
            {visibleErrors.miregistry_current_level && (
              <div
                id={`${levelGroupId}-error`}
                role="alert"
                style={fieldErrorStyle}
              >
                {visibleErrors.miregistry_current_level}
              </div>
            )}
          </fieldset>

          {form.miregistry_current_level === 'level_2' && (
            <div className="form-field-group">
              <label
                htmlFor={expiresInputId}
                className="field-label"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span>Level 2 expires on *</span>
                <HelpTooltip text={EXPIRATION_HELP} label="Help: Level 2 expiration">
                  <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
                </HelpTooltip>
              </label>
              <input
                id={expiresInputId}
                className="field-input"
                type="date"
                value={form.miregistry_level_2_expires_on}
                onChange={e => updateForm('miregistry_level_2_expires_on', e.target.value)}
                aria-invalid={!!visibleErrors.miregistry_level_2_expires_on}
              />
              {visibleErrors.miregistry_level_2_expires_on && (
                <div role="alert" style={fieldErrorStyle}>
                  {visibleErrors.miregistry_level_2_expires_on}
                </div>
              )}
            </div>
          )}

          {saveError && (
            <div role="alert" style={{ color: 'var(--clr-danger, #b00020)' }}>
              {saveError}
            </div>
          )}
        </div>

        <div className="modal-footer">
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
// Inline styles
// -----------------------------------------------------------------------------

function radioOptionStyle(selected) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 12px',
    border: '1px solid var(--clr-warm-mid)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    background: selected ? 'var(--clr-cream)' : 'transparent',
  }
}

const optionSubStyle = {
  display: 'block',
  marginTop: 2,
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.45,
  fontWeight: 400,
}

const fieldErrorStyle = {
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.8125rem',
  marginTop: 6,
}
