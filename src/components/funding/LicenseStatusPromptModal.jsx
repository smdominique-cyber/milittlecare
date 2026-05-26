// TODO(testing): Render tests pending React Testing Library install.
// Cover: radio selection enabling Save, the save write + confirmation
// phase, save-error handling, "ask me later" closing without a write,
// and the no-dismiss behavior (no overlay click / Escape / close button).

import { useId, useState } from 'react'
import { Check } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'

// One UI moment that captures profiles.license_type (the PR #14 compliance
// source of truth, migration 022) and mirrors is_license_exempt for
// backward compatibility. Copy is reviewed in
// docs/license_status_prompt_spec.md § 6 and updated to ternary in PR #14.
//
// Fires from two places:
//   1. FundingSourceForm post-save path — see shouldFireLicenseStatusPrompt
//      in src/lib/licenseStatusPrompt.js and § 3 of the spec.
//   2. The dashboard re-prompt on mount when license_type is null OR
//      license_type_review_needed = true — see LicenseTypeReviewBanner.

const CONFIRM_LICENSE_EXEMPT =
  'Got it. Refresh your browser to see the new MiRegistry entry in your ' +
  'sidebar — that’s where you log your annual training and track the ' +
  'December 16 deadline.'

const CONFIRM_LICENSED =
  'Got it — thanks. We’ll show you the licensed-home compliance tools ' +
  '(drill log, medication log, child files, etc.) as they roll out.'

const SAVE_ERROR_GENERIC =
  'Couldn’t save your answer. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

// The three answer values — match profiles.license_type 1:1 (migration 022).
const CHOICE = Object.freeze({
  FAMILY_HOME:    'family_home',
  GROUP_HOME:     'group_home',
  LICENSE_EXEMPT: 'license_exempt',
})

export default function LicenseStatusPromptModal({ onClose, onSaved }) {
  const { user } = useAuth()
  const [choice, setChoice] = useState(null)      // CHOICE.* | null
  const [phase, setPhase] = useState('question')  // 'question' | 'confirmed'
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const titleId = useId()
  const descId = useId()
  const radioGroupId = useId()

  const handleSave = async () => {
    if (!choice || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // PR #14: write license_type (source of truth), mirror is_license_exempt
      // so the ~10 legacy readers keep working, and clear the review flag
      // since the human just confirmed.
      const isLicenseExempt = choice === CHOICE.LICENSE_EXEMPT
      const { error } = await supabase
        .from('profiles')
        .update({
          license_type: choice,
          is_license_exempt: isLicenseExempt,
          license_type_review_needed: false,
        })
        .eq('id', user.id)
      if (error) throw error
      onSaved?.({ licenseType: choice, isLicenseExempt })
      setPhase('confirmed')
    } catch (err) {
      console.error('LicenseStatusPromptModal: save failed', err)
      setSaveError(SAVE_ERROR_GENERIC)
    } finally {
      setSaving(false)
    }
  }

  // "Ask me later" leaves is_license_exempt null — the provider is
  // re-prompted on their next CDC funding source creation (spec § 4).
  const handleAskLater = () => onClose?.()

  // ── Confirmation phase ─────────────────────────────────────────────
  if (phase === 'confirmed') {
    const message =
      choice === CHOICE.LICENSE_EXEMPT ? CONFIRM_LICENSE_EXEMPT : CONFIRM_LICENSED
    return (
      <div className="modal-overlay">
        <div
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          style={{ maxWidth: 520, width: '95%' }}
        >
          <div className="modal-header">
            <span className="modal-title" id={titleId}>Thanks!</span>
          </div>
          <div className="modal-body">
            <p
              id={descId}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', margin: 0,
                fontSize: '0.9375rem', color: 'var(--clr-ink-mid)', lineHeight: 1.55,
              }}
            >
              <Check
                size={18}
                style={{ color: 'var(--clr-sage-dark)', flexShrink: 0, marginTop: 2 }}
              />
              <span>{message}</span>
            </p>
          </div>
          <div className="modal-footer">
            <button
              className="btn-save"
              onClick={() => onClose?.()}
              style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Question phase ─────────────────────────────────────────────────
  // No overlay onClick, no close button, no Escape handler — per spec § 3
  // this modal cannot be silently dismissed. The only exits are Save (with
  // a selection) or the "ask me later" link.
  return (
    <div className="modal-overlay">
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{ maxWidth: 520, width: '95%' }}
      >
        <div className="modal-header">
          <span className="modal-title" id={titleId}>
            One quick question about your child care setup
          </span>
        </div>

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <p
            id={descId}
            style={{
              margin: 0, fontSize: '0.9375rem',
              color: 'var(--clr-ink-mid)', lineHeight: 1.55,
            }}
          >
            You just added a CDC Scholarship funding source. To show you the
            right tools — including Michigan training deadlines that affect
            your CDC payments — we need to know how your child care operates.
          </p>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={visuallyHidden}>Which describes your child care?</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={radioOptionStyle(choice === CHOICE.FAMILY_HOME)}>
                <input
                  type="radio"
                  name={radioGroupId}
                  value={CHOICE.FAMILY_HOME}
                  checked={choice === CHOICE.FAMILY_HOME}
                  onChange={() => setChoice(CHOICE.FAMILY_HOME)}
                  disabled={saving}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>I hold a Michigan Family Child Care Home license</strong>{' '}
                  <span style={parentheticalStyle}>(up to 6 children)</span>
                  <span style={optionSubStyle}>
                    Licensed by the State of Michigan. Family homes care for
                    up to 6 children at a time.
                  </span>
                </span>
              </label>

              <label style={radioOptionStyle(choice === CHOICE.GROUP_HOME)}>
                <input
                  type="radio"
                  name={radioGroupId}
                  value={CHOICE.GROUP_HOME}
                  checked={choice === CHOICE.GROUP_HOME}
                  onChange={() => setChoice(CHOICE.GROUP_HOME)}
                  disabled={saving}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>I hold a Michigan Group Child Care Home license</strong>{' '}
                  <span style={parentheticalStyle}>(up to 12 children)</span>
                  <span style={optionSubStyle}>
                    Licensed by the State of Michigan. Group homes care for
                    up to 12 children at a time.
                  </span>
                </span>
              </label>

              <label style={radioOptionStyle(choice === CHOICE.LICENSE_EXEMPT)}>
                <input
                  type="radio"
                  name={radioGroupId}
                  value={CHOICE.LICENSE_EXEMPT}
                  checked={choice === CHOICE.LICENSE_EXEMPT}
                  onChange={() => setChoice(CHOICE.LICENSE_EXEMPT)}
                  disabled={saving}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  <strong>
                    I care for children I’m related to or already know,
                    registered with MDHHS
                  </strong>{' '}
                  <span style={parentheticalStyle}>(license-exempt provider)</span>
                  <span style={optionSubStyle}>
                    Not licensed by the State of Michigan. This is the most
                    common setup for in-home CDC providers.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {saveError && (
            <div
              role="alert"
              style={{ color: 'var(--clr-danger, #b00020)', fontSize: '0.875rem' }}
            >
              {saveError}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!choice || saving}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleAskLater}
            disabled={saving}
            style={linkButtonStyle}
          >
            I’m not sure — ask me later
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inline styles (mirrors UpdateLevelModal.jsx conventions) ──────────

function radioOptionStyle(selected) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 12px',
    border: `1px solid ${selected ? 'var(--clr-sage)' : 'var(--clr-warm-mid)'}`,
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

const parentheticalStyle = {
  fontWeight: 400,
  color: 'var(--clr-ink-soft)',
}

const linkButtonStyle = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--clr-ink-soft)',
  fontSize: '0.875rem',
  textDecoration: 'underline',
  cursor: 'pointer',
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
