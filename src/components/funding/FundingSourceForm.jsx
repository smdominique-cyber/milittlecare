// TODO(testing): Render tests pending React Testing Library install. Cover:
// add+edit modes, type-specific field branches, validation summary
// surfacing on failed save attempt only, dual-write save path for
// private_pay, and the stub-type "Coming soon" path.

import { useEffect, useMemo, useState } from 'react'
import { Info, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const STUB_TYPES = new Set(['tri_share', 'gsrp', 'head_start', 'agency_other'])
const FAMILY_LEVEL_TYPES = new Set(['private_pay'])

const TYPE_LABELS = {
  private_pay: 'Private Pay',
  cdc_scholarship: 'CDC Scholarship',
  tri_share: 'MI Tri-Share',
  gsrp: 'GSRP',
  head_start: 'Head Start',
  agency_other: 'Other Agency',
}

const TYPE_OPTIONS = [
  { value: 'private_pay', label: 'Private Pay' },
  { value: 'cdc_scholarship', label: 'CDC Scholarship' },
  { value: 'tri_share', label: 'MI Tri-Share' },
  { value: 'gsrp', label: 'GSRP' },
  { value: 'head_start', label: 'Head Start' },
  { value: 'agency_other', label: 'Other Agency' },
]

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ended', label: 'Ended' },
]

const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]

// -----------------------------------------------------------------------------
// Help copy (per CLAUDE.md § Documentation Conventions rule 1)
// -----------------------------------------------------------------------------

const TYPE_HELP =
  'What pays for this child’s care. Pick the program, partnership, or family ' +
  'payment that funds the hours you’re tracking. You can add more than one ' +
  'source per family or child if multiple programs cover the same care.'

const CHILD_HELP =
  'Which child of this family does this funding source cover? State programs ' +
  '(CDC Scholarship, MI Tri-Share, GSRP, Head Start) issue authorizations per child.'

const NOTICES = {
  private_pay:
    'Private Pay rates apply to the whole family. Editing them here updates ' +
    'the same fields that show on the family’s Overview tab — they stay in ' +
    'sync automatically.',
  cdc_scholarship:
    'CDC Scholarship details come directly from the DHS-198 letter — grab ' +
    'yours before you fill this out. The Approved Hours and Family ' +
    'Contribution amounts here will be the basis for every I-Billing entry, ' +
    'so we want to match exactly what MDHHS approved.',
}

const FIELD_HELP = {
  start_date:
    'First day this source covers care. For state programs, use the ' +
    'authorization start date from the official letter.',
  end_date: 'Last day this source covers care. Leave blank for open-ended.',
  status:
    'Active counts toward billing and feature gating. Paused is dormant. ' +
    'Ended preserves history without affecting anything.',
  notes: 'Visible only to you and your staff.',

  billing_type: 'Pick how you charge: a flat weekly amount or per attended hour.',
  weekly_rate:
    'What the family owes per week. Leave 0 only if you’re still figuring ' +
    'it out — invoices will be $0 until you set a real rate.',
  hourly_rate:
    'What the family owes per attended hour. Combines with attendance ' +
    'records to compute each invoice.',
  billing_frequency:
    'How often you generate invoices. Bi-weekly batches two weeks of weekly ' +
    'rate; monthly batches a calendar month or 4-week cycle.',
  billing_frequency_weeks: 'Number of weeks per billing cycle.',
  billing_cycle_start_day: 'The day of the week each cycle begins.',
  billing_monthly_mode:
    'Calendar month varies in length; 4-week cycle is exactly 28 days.',
  billing_cycle_anchor_date:
    'Pick a date their first cycle should start. Future invoices count from ' +
    'there. Useful when a family joins mid-cycle.',
  billing_partial_week_mode:
    'What happens when a billing week only has some attended days. “Paying ' +
    'for the spot” charges full rate; “prorate” splits the weekly rate per day.',
  late_fee_amount:
    'Amount added if the invoice isn’t paid by the grace period. $0 ' +
    'disables late fees entirely.',
  late_fee_after_days:
    'How many days after the due date before the late fee applies. Common ' +
    'values: 7 or 14.',

  case_number:
    'The MDHHS case number printed on the DHS-198. Used to identify this ' +
    'case in I-Billing.',
  dhs_198_received_date:
    'When you received the DHS-198 authorization letter from MDHHS. This ' +
    'starts the clock on the authorization.',
  authorization_start:
    'First date CDC Scholarship covers care. Copy from the DHS-198.',
  authorization_end:
    'Last date CDC Scholarship covers care. Copy from the DHS-198.',
  approved_hours_per_period:
    'The bi-weekly hour cap from the DHS-198. CDC pay periods are two weeks.',
  family_contribution_amount:
    'What the family pays per pay period (their copay). Copy from the DHS-198.',
  billing_basis:
    'Licensed providers bill on enrollment (set hours regardless of ' +
    'attendance). License-exempt providers bill on attendance (actual hours). ' +
    'The DHS-198 tells you which applies.',
  shared_with_other_provider:
    'Check if another provider also bills CDC for this child (e.g., they ' +
    'attend school AM, daycare PM). You’ll need to coordinate hours with the ' +
    'other provider — if you both bill the same time, MDHHS will reject one of you.',
  shared_provider_notes: 'Provider name, location, hours they cover…',
  provider_pin_required:
    'Check this if you’ve never billed CDC before. MDHHS will send you a ' +
    'separate Provider PIN letter — you’ll need it to log into I-Billing. ' +
    'If you’ve already received your PIN, leave this unchecked.',
  enrollment_agreement_doc:
    'Coming soon — store the signed Enrollment Agreement here.',
  dhs_198_doc: 'Coming soon — store the signed DHS-198 here.',
}

const SAVE_ERROR_GENERIC =
  'Couldn’t save. Try again, or email support@milittlecare.com if it keeps happening.'

// -----------------------------------------------------------------------------
// Form-state helpers
// -----------------------------------------------------------------------------

function todayYMD() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function defaultFormState({ existingSource, family, type }) {
  if (existingSource) {
    return {
      start_date: existingSource.start_date || '',
      end_date: existingSource.end_date || '',
      status: existingSource.status || 'active',
      notes: existingSource.notes || '',
      details: { ...(existingSource.details || {}) },
    }
  }
  if (type === 'private_pay' && family) {
    return {
      start_date: family.start_date || todayYMD(),
      end_date: '',
      status: 'active',
      notes: '',
      details: {
        billing_type: family.billing_type || 'weekly',
        weekly_rate: family.weekly_rate ?? '',
        hourly_rate: family.hourly_rate ?? '',
        billing_frequency: family.billing_frequency || 'weekly',
        billing_frequency_weeks: family.billing_frequency_weeks ?? '',
        billing_cycle_start_day: family.billing_cycle_start_day ?? 1,
        billing_cycle_anchor_date: family.billing_cycle_anchor_date || '',
        billing_monthly_mode: family.billing_monthly_mode || 'calendar',
        billing_partial_week_mode: family.billing_partial_week_mode || 'full_rate',
        late_fee_amount: family.late_fee_amount ?? 0,
        late_fee_after_days: family.late_fee_after_days ?? 7,
      },
    }
  }
  if (type === 'cdc_scholarship') {
    return {
      start_date: todayYMD(),
      end_date: '',
      status: 'active',
      notes: '',
      details: {
        case_number: '',
        dhs_198_received_date: '',
        authorization_start: '',
        authorization_end: '',
        approved_hours_per_period: '',
        family_contribution_amount: '',
        billing_basis: '',
        shared_with_other_provider: false,
        shared_provider_notes: '',
        provider_pin_required: false,
      },
    }
  }
  return {
    start_date: todayYMD(),
    end_date: '',
    status: 'active',
    notes: '',
    details: {},
  }
}

// -----------------------------------------------------------------------------
// Validation (pure)
// -----------------------------------------------------------------------------

function validate({ type, childId, form, isLicenseExempt }) {
  const errors = {}
  const d = form.details || {}

  if (!type) {
    errors.type = 'Pick a funding type to continue.'
  }

  if (!form.start_date) {
    errors.start_date = 'Start date is required.'
  }
  if (form.end_date && form.start_date && form.end_date < form.start_date) {
    errors.end_date = 'End date can’t be earlier than the start date.'
  }

  if (type && !FAMILY_LEVEL_TYPES.has(type) && !STUB_TYPES.has(type) && !childId) {
    errors.child_id = 'Pick which child this source covers.'
  }

  if (type === 'private_pay') {
    if (!d.billing_type) {
      errors.billing_type = 'Pick weekly or hourly billing.'
    }
    if (isNegativeNumber(d.weekly_rate)) {
      errors.weekly_rate = 'Weekly rate can’t be negative.'
    }
    if (isNegativeNumber(d.hourly_rate)) {
      errors.hourly_rate = 'Hourly rate can’t be negative.'
    }
    if (isNegativeNumber(d.late_fee_amount)) {
      errors.late_fee_amount = 'Late fee can’t be negative.'
    }
    if (isNegativeNumber(d.late_fee_after_days)) {
      errors.late_fee_after_days = 'Late fee grace period can’t be negative.'
    }
    if (
      d.billing_frequency === 'custom' &&
      (d.billing_frequency_weeks === '' ||
        d.billing_frequency_weeks === null ||
        Number(d.billing_frequency_weeks) < 1)
    ) {
      errors.billing_frequency_weeks = 'Custom cycle needs at least 1 week.'
    }
  }

  if (type === 'cdc_scholarship') {
    if (!d.authorization_start) {
      errors.authorization_start =
        'Authorization start date is required (from the DHS-198).'
    }
    if (!d.authorization_end) {
      errors.authorization_end =
        'Authorization end date is required (from the DHS-198).'
    }
    if (
      d.authorization_start &&
      d.authorization_end &&
      d.authorization_end <= d.authorization_start
    ) {
      errors.authorization_end = 'Authorization end must be after the start date.'
    }
    if (!d.dhs_198_received_date) {
      errors.dhs_198_received_date =
        'DHS-198 received date is required. Use the date on the letter, or the date you received it if no letter date is printed.'
    }
    if (d.dhs_198_received_date && d.dhs_198_received_date > todayYMD()) {
      errors.dhs_198_received_date = 'DHS-198 received date can’t be in the future.'
    }
    if (
      d.approved_hours_per_period === '' ||
      d.approved_hours_per_period === null ||
      Number(d.approved_hours_per_period) <= 0
    ) {
      errors.approved_hours_per_period =
        'Approved hours per pay period must be greater than 0.'
    } else if (
      isLicenseExempt === true &&
      Number(d.approved_hours_per_period) > 2016
    ) {
      errors.approved_hours_per_period =
        'Approved hours can’t exceed 2,016 per pay period for license-exempt providers — this is the MiLEAP cap. Double-check the DHS-198.'
    }
    if (isNegativeNumber(d.family_contribution_amount)) {
      errors.family_contribution_amount = 'Family contribution can’t be negative.'
    }
    if (!d.billing_basis) {
      errors.billing_basis = 'Pick enrollment or attendance billing.'
    }
  }

  return errors
}

function isNegativeNumber(value) {
  if (value === '' || value === null || value === undefined) return false
  return Number(value) < 0
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export default function FundingSourceForm({
  familyId,
  family,
  childrenList = [],
  existingSource = null,
  onClose,
  onSaved,
}) {
  const { user } = useAuth()
  const isEditing = !!existingSource

  const [type, setType] = useState(existingSource?.type || '')
  const [childId, setChildId] = useState(
    existingSource?.child_id ||
      (childrenList.length === 1 ? childrenList[0].id : '')
  )
  const [form, setForm] = useState(() =>
    defaultFormState({
      existingSource,
      family,
      type: existingSource?.type,
    })
  )
  const [isLicenseExempt, setIsLicenseExempt] = useState(null)
  const [saving, setSaving] = useState(false)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [saveError, setSaveError] = useState(null)

  // Snapshot the initial form state at mount so we can detect dirty
  // changes on cancel without re-prompting users who just viewed and closed.
  // useState lazy initializer runs exactly once — the snapshot never updates
  // even if props change; the parent re-mounts the form via React key on
  // existingSource swap.
  const [initialSnapshot] = useState(() => {
    const initialForm = defaultFormState({
      existingSource,
      family,
      type: existingSource?.type,
    })
    const initialType = existingSource?.type || ''
    const initialChildId =
      existingSource?.child_id ||
      (childrenList.length === 1 ? childrenList[0].id : '')
    return JSON.stringify({
      ...initialForm,
      _type: initialType,
      _childId: initialChildId,
    })
  })

  // When adding and the type changes, reset to that type's default state.
  useEffect(() => {
    if (!isEditing && type) {
      setForm(defaultFormState({ existingSource: null, family, type }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  // One-shot fetch of is_license_exempt for the CDC 2016-hour cap rule.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    supabase
      .from('profiles')
      .select('is_license_exempt')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsLicenseExempt(data?.is_license_exempt ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [user])

  const errors = useMemo(
    () => validate({ type, childId, form, isLicenseExempt }),
    [type, childId, form, isLicenseExempt]
  )

  const isStub = STUB_TYPES.has(type)
  const showSaveButton = type && !isStub

  const setDetail = (key, value) =>
    setForm(f => ({ ...f, details: { ...(f.details || {}), [key]: value } }))

  const updateForm = (key, value) =>
    setForm(f => ({ ...f, [key]: value }))

  const handleCancel = () => {
    const currentSnapshot = JSON.stringify({
      ...form,
      _type: type,
      _childId: childId,
    })
    const dirty = currentSnapshot !== initialSnapshot
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    onClose?.()
  }

  // Escape key dismisses the form (with the same dirty-check as Cancel).
  // Listener is re-bound when handleCancel changes so the dirty check
  // sees current form state. Pattern reusable for any modal.
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
      const payload = buildPayload({
        type,
        childId,
        familyId,
        form,
        userId: user?.id,
        existingSource,
      })

      if (isEditing) {
        const { error } = await supabase
          .from('funding_sources')
          .update(payload)
          .eq('id', existingSource.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('funding_sources')
          .insert(payload)
        if (error) throw error
      }

      // Dual-write: mirror billing fields back to families for private_pay
      // so the existing billing engine keeps invoicing correctly. Tracked
      // in docs/tech_debt.md — to be removed when billing reads from
      // funding_sources directly.
      if (type === 'private_pay') {
        const d = form.details || {}
        const familyPayload = {
          billing_type: d.billing_type || 'weekly',
          weekly_rate: numOrNull(d.weekly_rate),
          hourly_rate: numOrNull(d.hourly_rate),
          billing_frequency: d.billing_frequency || 'weekly',
          billing_frequency_weeks: numOrNull(d.billing_frequency_weeks),
          billing_cycle_start_day: d.billing_cycle_start_day ?? 1,
          billing_cycle_anchor_date: d.billing_cycle_anchor_date || null,
          billing_monthly_mode: d.billing_monthly_mode || 'calendar',
          billing_partial_week_mode: d.billing_partial_week_mode || 'full_rate',
          late_fee_amount: numOrNull(d.late_fee_amount) ?? 0,
          late_fee_after_days: numOrNull(d.late_fee_after_days) ?? 7,
        }
        const { error: famErr } = await supabase
          .from('families')
          .update(familyPayload)
          .eq('id', familyId)
        if (famErr) throw famErr
      }

      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('FundingSourceForm: save failed', err)
      setSaveError(SAVE_ERROR_GENERIC)
    } finally {
      setSaving(false)
    }
  }

  const headerTitle = isEditing
    ? `Edit ${TYPE_LABELS[existingSource.type] || existingSource.type} funding source`
    : 'Add funding source'

  const showChildSelector =
    !isEditing && type && !FAMILY_LEVEL_TYPES.has(type) && !isStub

  const visibleErrors = submitAttempted ? errors : {}
  const errorMessages = Object.values(visibleErrors)

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div
        className="modal-card"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 640, width: '95%' }}
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
          {errorMessages.length > 0 && (
            <div
              role="alert"
              style={{
                background: 'var(--clr-danger-pale, #fbe9eb)',
                border: '1px solid var(--clr-danger, #b00020)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3) var(--space-4)',
                color: 'var(--clr-danger, #b00020)',
                fontSize: '0.875rem',
                lineHeight: 1.45,
              }}
            >
              <strong>Couldn’t save. Fix the items below:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {errorMessages.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          {!isEditing && (
            <FieldGroup
              label="Funding type *"
              helpText={TYPE_HELP}
              error={visibleErrors.type}
            >
              <select
                className="field-input"
                value={type}
                onChange={e => setType(e.target.value)}
              >
                <option value="">Choose a type…</option>
                {TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </FieldGroup>
          )}

          {showChildSelector && (
            <FieldGroup
              label="For child *"
              helpText={CHILD_HELP}
              error={visibleErrors.child_id}
            >
              <select
                className="field-input"
                value={childId}
                onChange={e => setChildId(e.target.value)}
              >
                {childrenList.length !== 1 && <option value="">Choose a child…</option>}
                {childrenList.map(c => (
                  <option key={c.id} value={c.id}>
                    {`${c.first_name} ${c.last_name || ''}`.trim()}
                  </option>
                ))}
              </select>
            </FieldGroup>
          )}

          {NOTICES[type] && <Notice text={NOTICES[type]} />}

          {type === 'private_pay' && (
            <PrivatePayFields
              form={form}
              setDetail={setDetail}
              visibleErrors={visibleErrors}
            />
          )}

          {type === 'cdc_scholarship' && (
            <CDCScholarshipFields
              form={form}
              setDetail={setDetail}
              visibleErrors={visibleErrors}
            />
          )}

          {isStub && <ComingSoonNotice typeLabel={TYPE_LABELS[type]} />}

          {type && !isStub && (
            <CommonFields
              form={form}
              updateForm={updateForm}
              showStatus={isEditing}
              visibleErrors={visibleErrors}
            />
          )}

          {saveError && (
            <div role="alert" style={{ color: 'var(--clr-danger, #b00020)' }}>
              {saveError}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-discard" onClick={handleCancel}>
            Cancel
          </button>
          {showSaveButton && (
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={saving}
              style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Save payload builder
// -----------------------------------------------------------------------------

function buildPayload({ type, childId, familyId, form, userId, existingSource }) {
  const base = {
    type,
    status: form.status || 'active',
    start_date: form.start_date,
    end_date: form.end_date || null,
    notes: form.notes || null,
    details: { ...(form.details || {}) },
  }

  // Clear the rate-review flag once private_pay save has a positive active rate.
  if (type === 'private_pay') {
    const activeRate =
      base.details.billing_type === 'hourly'
        ? Number(base.details.hourly_rate)
        : Number(base.details.weekly_rate)
    if (Number.isFinite(activeRate) && activeRate > 0) {
      base.details.needs_rate_review = false
    }
  }

  if (existingSource) return base

  const payload = { ...base, user_id: userId }
  if (FAMILY_LEVEL_TYPES.has(type)) {
    payload.family_id = familyId
  } else {
    payload.child_id = childId
  }
  return payload
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// -----------------------------------------------------------------------------
// Field group + small layout helpers
// -----------------------------------------------------------------------------

function FieldGroup({ label, helpText, error, children }) {
  return (
    <div className="form-field-group">
      <label
        className="field-label"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span>{label}</span>
        {helpText && (
          <HelpTooltip text={helpText} label={`Help: ${label}`}>
            <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        )}
      </label>
      {children}
      {error && <FieldError text={error} />}
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

function ComingSoonNotice({ typeLabel }) {
  return (
    <div
      style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        lineHeight: 1.55,
      }}
    >
      <p style={{ margin: 0, fontWeight: 500, color: 'var(--clr-ink)' }}>
        {typeLabel} support is coming.
      </p>
      <p style={{ margin: '8px 0 0', color: 'var(--clr-ink-soft)' }}>
        The data model is ready, but the form is still being built.
      </p>
      <p style={{ margin: '8px 0 0', color: 'var(--clr-ink-soft)' }}>
        We’ll set this up for you when you’re ready — message us through your
        provider profile or email{' '}
        <a href="mailto:support@milittlecare.com">support@milittlecare.com</a>.
      </p>
    </div>
  )
}

function SectionHeader({ children }) {
  return (
    <div
      style={{
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--clr-ink-soft)',
        borderBottom: '1px solid var(--clr-warm-mid)',
        paddingBottom: 4,
        marginTop: 'var(--space-2)',
      }}
    >
      {children}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Private Pay fields
// -----------------------------------------------------------------------------

function PrivatePayFields({ form, setDetail, visibleErrors }) {
  const d = form.details || {}
  const billingType = d.billing_type || ''
  const frequency = d.billing_frequency || 'weekly'

  return (
    <>
      <FieldGroup
        label="Bill by *"
        helpText={FIELD_HELP.billing_type}
        error={visibleErrors.billing_type}
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <label style={radioLabelStyle}>
            <input
              type="radio"
              name="billing_type"
              checked={billingType === 'weekly'}
              onChange={() => setDetail('billing_type', 'weekly')}
            />
            Weekly flat rate
          </label>
          <label style={radioLabelStyle}>
            <input
              type="radio"
              name="billing_type"
              checked={billingType === 'hourly'}
              onChange={() => setDetail('billing_type', 'hourly')}
            />
            Hourly rate
          </label>
        </div>
      </FieldGroup>

      {billingType === 'weekly' && (
        <FieldGroup
          label="Weekly rate ($)"
          helpText={FIELD_HELP.weekly_rate}
          error={visibleErrors.weekly_rate}
        >
          <input
            className="field-input"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={d.weekly_rate ?? ''}
            onChange={e => setDetail('weekly_rate', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
      )}

      {billingType === 'hourly' && (
        <FieldGroup
          label="Hourly rate ($)"
          helpText={FIELD_HELP.hourly_rate}
          error={visibleErrors.hourly_rate}
        >
          <input
            className="field-input"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={d.hourly_rate ?? ''}
            onChange={e => setDetail('hourly_rate', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
      )}

      <FieldGroup label="Bill every" helpText={FIELD_HELP.billing_frequency}>
        <select
          className="field-input"
          value={frequency}
          onChange={e => setDetail('billing_frequency', e.target.value)}
        >
          <option value="weekly">Weekly</option>
          <option value="biweekly">Every two weeks</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom</option>
        </select>
      </FieldGroup>

      {frequency === 'custom' && (
        <FieldGroup
          label="Custom cycle length (weeks)"
          helpText={FIELD_HELP.billing_frequency_weeks}
          error={visibleErrors.billing_frequency_weeks}
        >
          <input
            className="field-input"
            type="number"
            min="1"
            placeholder="e.g. 3"
            value={d.billing_frequency_weeks ?? ''}
            onChange={e => setDetail('billing_frequency_weeks', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
      )}

      {(frequency === 'weekly' ||
        frequency === 'biweekly' ||
        frequency === 'custom') && (
        <FieldGroup label="Cycle starts on" helpText={FIELD_HELP.billing_cycle_start_day}>
          <select
            className="field-input"
            value={d.billing_cycle_start_day ?? 1}
            onChange={e => setDetail('billing_cycle_start_day', Number(e.target.value))}
          >
            {WEEKDAYS.map(w => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </FieldGroup>
      )}

      {frequency === 'monthly' && (
        <FieldGroup label="Monthly mode" helpText={FIELD_HELP.billing_monthly_mode}>
          <select
            className="field-input"
            value={d.billing_monthly_mode || 'calendar'}
            onChange={e => setDetail('billing_monthly_mode', e.target.value)}
          >
            <option value="calendar">Calendar month (1st – last day)</option>
            <option value="four_weeks">Every 4 weeks (28-day cycle)</option>
          </select>
        </FieldGroup>
      )}

      <FieldGroup label="Anchor date" helpText={FIELD_HELP.billing_cycle_anchor_date}>
        <input
          className="field-input"
          type="date"
          value={d.billing_cycle_anchor_date || ''}
          onChange={e => setDetail('billing_cycle_anchor_date', e.target.value)}
        />
      </FieldGroup>

      <FieldGroup label="Partial weeks" helpText={FIELD_HELP.billing_partial_week_mode}>
        <select
          className="field-input"
          value={d.billing_partial_week_mode || 'full_rate'}
          onChange={e => setDetail('billing_partial_week_mode', e.target.value)}
        >
          <option value="full_rate">Charge full rate (paying for the spot)</option>
          <option value="prorate">Prorate by day</option>
        </select>
      </FieldGroup>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-3)',
        }}
      >
        <FieldGroup
          label="Late fee ($)"
          helpText={FIELD_HELP.late_fee_amount}
          error={visibleErrors.late_fee_amount}
        >
          <input
            className="field-input"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={d.late_fee_amount ?? ''}
            onChange={e => setDetail('late_fee_amount', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
        <FieldGroup
          label="Late fee kicks in after (days)"
          helpText={FIELD_HELP.late_fee_after_days}
          error={visibleErrors.late_fee_after_days}
        >
          <input
            className="field-input"
            type="number"
            min="0"
            placeholder="7"
            value={d.late_fee_after_days ?? ''}
            onChange={e => setDetail('late_fee_after_days', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
      </div>
    </>
  )
}

// -----------------------------------------------------------------------------
// CDC Scholarship fields
// -----------------------------------------------------------------------------

function CDCScholarshipFields({ form, setDetail, visibleErrors }) {
  const d = form.details || {}

  return (
    <>
      <SectionHeader>Authorization</SectionHeader>

      <FieldGroup label="MDHHS case number" helpText={FIELD_HELP.case_number}>
        <input
          className="field-input"
          type="text"
          placeholder="e.g. 1234567"
          value={d.case_number || ''}
          onChange={e => setDetail('case_number', e.target.value)}
        />
      </FieldGroup>

      <FieldGroup
        label="DHS-198 received *"
        helpText={FIELD_HELP.dhs_198_received_date}
        error={visibleErrors.dhs_198_received_date}
      >
        <input
          className="field-input"
          type="date"
          value={d.dhs_198_received_date || ''}
          onChange={e => setDetail('dhs_198_received_date', e.target.value)}
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
          label="Authorization start *"
          helpText={FIELD_HELP.authorization_start}
          error={visibleErrors.authorization_start}
        >
          <input
            className="field-input"
            type="date"
            value={d.authorization_start || ''}
            onChange={e => setDetail('authorization_start', e.target.value)}
          />
        </FieldGroup>
        <FieldGroup
          label="Authorization end *"
          helpText={FIELD_HELP.authorization_end}
          error={visibleErrors.authorization_end}
        >
          <input
            className="field-input"
            type="date"
            value={d.authorization_end || ''}
            onChange={e => setDetail('authorization_end', e.target.value)}
          />
        </FieldGroup>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-3)',
        }}
      >
        <FieldGroup
          label="Approved hours per pay period *"
          helpText={FIELD_HELP.approved_hours_per_period}
          error={visibleErrors.approved_hours_per_period}
        >
          <input
            className="field-input"
            type="number"
            min="0"
            placeholder="e.g. 120"
            value={d.approved_hours_per_period ?? ''}
            onChange={e => setDetail('approved_hours_per_period', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
        <FieldGroup
          label="Family contribution per period ($)"
          helpText={FIELD_HELP.family_contribution_amount}
          error={visibleErrors.family_contribution_amount}
        >
          <input
            className="field-input"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={d.family_contribution_amount ?? ''}
            onChange={e => setDetail('family_contribution_amount', e.target.value === '' ? '' : Number(e.target.value))}
          />
        </FieldGroup>
      </div>

      <FieldGroup
        label="Billing basis *"
        helpText={FIELD_HELP.billing_basis}
        error={visibleErrors.billing_basis}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={radioLabelStyle}>
            <input
              type="radio"
              name="billing_basis"
              checked={d.billing_basis === 'enrollment'}
              onChange={() => setDetail('billing_basis', 'enrollment')}
            />
            Enrollment (licensed providers)
          </label>
          <label style={radioLabelStyle}>
            <input
              type="radio"
              name="billing_basis"
              checked={d.billing_basis === 'attendance'}
              onChange={() => setDetail('billing_basis', 'attendance')}
            />
            Attendance (license-exempt providers)
          </label>
        </div>
      </FieldGroup>

      <SectionHeader>Coordination</SectionHeader>

      <FieldGroup
        label="Shared with another provider"
        helpText={FIELD_HELP.shared_with_other_provider}
      >
        <label style={radioLabelStyle}>
          <input
            type="checkbox"
            checked={!!d.shared_with_other_provider}
            onChange={e => setDetail('shared_with_other_provider', e.target.checked)}
          />
          Yes — another provider also bills CDC for this child
        </label>
      </FieldGroup>

      {d.shared_with_other_provider && (
        <FieldGroup label="Other provider notes">
          <textarea
            className="field-input"
            rows={2}
            placeholder={FIELD_HELP.shared_provider_notes}
            value={d.shared_provider_notes || ''}
            onChange={e => setDetail('shared_provider_notes', e.target.value)}
          />
        </FieldGroup>
      )}

      <FieldGroup
        label="This is my first CDC Scholarship case"
        helpText={FIELD_HELP.provider_pin_required}
      >
        <label style={radioLabelStyle}>
          <input
            type="checkbox"
            checked={!!d.provider_pin_required}
            onChange={e => setDetail('provider_pin_required', e.target.checked)}
          />
          Yes — I’ll need a Provider PIN from MDHHS
        </label>
      </FieldGroup>

      <SectionHeader>Documents</SectionHeader>

      <FieldGroup
        label="Enrollment Agreement document"
        helpText={FIELD_HELP.enrollment_agreement_doc}
      >
        <input className="field-input" type="text" disabled placeholder="Coming soon" />
      </FieldGroup>
      <FieldGroup label="DHS-198 document" helpText={FIELD_HELP.dhs_198_doc}>
        <input className="field-input" type="text" disabled placeholder="Coming soon" />
      </FieldGroup>
    </>
  )
}

// -----------------------------------------------------------------------------
// Common fields (start/end/status/notes)
// -----------------------------------------------------------------------------

function CommonFields({ form, updateForm, showStatus, visibleErrors }) {
  return (
    <>
      <SectionHeader>Coverage period</SectionHeader>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-3)',
        }}
      >
        <FieldGroup
          label="Start date *"
          helpText={FIELD_HELP.start_date}
          error={visibleErrors.start_date}
        >
          <input
            className="field-input"
            type="date"
            value={form.start_date || ''}
            onChange={e => updateForm('start_date', e.target.value)}
          />
        </FieldGroup>
        <FieldGroup
          label="End date"
          helpText={FIELD_HELP.end_date}
          error={visibleErrors.end_date}
        >
          <input
            className="field-input"
            type="date"
            value={form.end_date || ''}
            onChange={e => updateForm('end_date', e.target.value)}
          />
        </FieldGroup>
      </div>
      {showStatus && (
        <FieldGroup label="Status" helpText={FIELD_HELP.status}>
          <select
            className="field-input"
            value={form.status || 'active'}
            onChange={e => updateForm('status', e.target.value)}
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FieldGroup>
      )}
      <FieldGroup label="Notes" helpText={FIELD_HELP.notes}>
        <textarea
          className="field-input"
          rows={2}
          placeholder="Anything you want to remember about this source…"
          value={form.notes || ''}
          onChange={e => updateForm('notes', e.target.value)}
        />
      </FieldGroup>
    </>
  )
}

const radioLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.875rem',
  cursor: 'pointer',
}
