// I-Billing Screen 5 — Reconcile (PR #9).
//
// Captures the MDHHS confirmation number after the provider submits in
// the I-Billing portal, writes one row to cdc_billing_submissions, and
// presents the locked submission record. The submission row is
// immutable per migration 019 (no DELETE policy, no archived_at) — the
// UI mirrors that by locking out fields once the row is on file.

import { useState } from 'react'
import { Lock, CheckCircle2 } from 'lucide-react'

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Props:
 *   payPeriod              — selected catalog row.
 *   existingSubmission     — cdc_billing_submissions row if already on
 *                            file (locked-state); null otherwise.
 *   totalBillableHours     — sanity-check pre-fill.
 *   onSubmit               — async (payload) => returns submission row
 *                            or throws. payload shape:
 *                            { confirmation_number, submitted_at,
 *                              total_billed_hours, total_billed_amount_estimate }
 *   onBack                 — () => void
 *   onDone                 — () => void  (close the flow)
 */
export default function ReconcilePanel({
  payPeriod,
  existingSubmission,
  totalBillableHours,
  onSubmit,
  onBack,
  onDone,
}) {
  const [confirmationNumber, setConfirmationNumber] = useState('')
  const [submittedAt, setSubmittedAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [amountEstimate, setAmountEstimate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)

  // Locked state.
  if (existingSubmission) {
    return (
      <section aria-label="Reconciled submission">
        <div style={lockedBoxStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#15803d' }}>
            <CheckCircle2 size={20} aria-hidden />
            <strong style={{ fontSize: 16 }}>This pay period is reconciled.</strong>
          </div>
          <dl style={dlStyle}>
            <dt>Period</dt>
            <dd>{payPeriod?.period_number} ({payPeriod?.start_date} → {payPeriod?.end_date})</dd>
            <dt>MDHHS confirmation #</dt>
            <dd style={{ fontFamily: 'monospace' }}>{existingSubmission.confirmation_number}</dd>
            <dt>Submitted at</dt>
            <dd>{new Date(existingSubmission.submitted_at).toLocaleString()}</dd>
            <dt>Total billed hours</dt>
            <dd>{Number(existingSubmission.total_billed_hours || 0).toFixed(2)}</dd>
            {existingSubmission.total_billed_amount_estimate != null && (
              <>
                <dt>Estimated amount</dt>
                <dd>${Number(existingSubmission.total_billed_amount_estimate).toFixed(2)}</dd>
              </>
            )}
          </dl>
          <p style={{ marginTop: 12, color: '#374151', fontSize: 13 }}>
            <Lock size={14} aria-hidden style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            Submission records are immutable per audit policy.{' '}
            When MDHHS pays this period you can record the EFT/check
            amount and arrival date from the period's history view
            (future PR).
          </p>
        </div>
        <div style={actionsRowStyle}>
          <button type="button" onClick={onBack} style={ghostBtn}>← Back to export</button>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onDone} style={primaryBtn(false)}>Done</button>
        </div>
      </section>
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!confirmationNumber.trim()) return
    setSubmitting(true); setErr(null)
    try {
      await onSubmit({
        confirmation_number: confirmationNumber.trim(),
        submitted_at: new Date(submittedAt).toISOString(),
        total_billed_hours: Number(totalBillableHours || 0),
        total_billed_amount_estimate: amountEstimate ? Number(amountEstimate) : null,
      })
    } catch (e2) {
      setErr(e2?.message || 'Could not save the submission.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-label="Reconcile pay period">
      <h2 style={{ margin: '0 0 4px 0', fontSize: 18 }}>
        Period {payPeriod?.period_number}{' '}
        <span style={{ color: '#6b7280', fontWeight: 400 }}>
          ({payPeriod?.start_date} → {payPeriod?.end_date})
        </span>
      </h2>
      <p style={{ margin: '0 0 16px 0', color: '#4b5563' }}>
        Enter the confirmation number MDHHS gave you when you saved this
        period in I-Billing. Once you save it here, this period is
        locked and immutable — that's by design for audit retention.
      </p>

      {err && <div role="alert" style={errBoxStyle}>{err}</div>}

      <form onSubmit={handleSubmit} style={formStyle}>
        <label style={fieldLabelStyle}>
          MDHHS confirmation number <span style={requiredMark}>*</span>
          <input
            type="text"
            value={confirmationNumber}
            onChange={e => setConfirmationNumber(e.target.value)}
            required
            autoFocus
            placeholder="e.g. CDC-2026-00012345"
            style={inputStyle}
          />
        </label>

        <label style={fieldLabelStyle}>
          Submitted at
          <input
            type="datetime-local"
            value={submittedAt}
            onChange={e => setSubmittedAt(e.target.value)}
            style={inputStyle}
          />
          <span style={hintStyle}>
            Defaults to right now. Adjust if you submitted earlier.
          </span>
        </label>

        <label style={fieldLabelStyle}>
          Total billed hours (auto-filled)
          <input
            type="number"
            value={(totalBillableHours || 0).toFixed(2)}
            readOnly
            style={{ ...inputStyle, background: '#f9fafb' }}
          />
        </label>

        <label style={fieldLabelStyle}>
          Estimated payment amount (optional)
          <input
            type="number" step="0.01"
            value={amountEstimate}
            onChange={e => setAmountEstimate(e.target.value)}
            placeholder="Computed by I-Billing"
            style={inputStyle}
          />
          <span style={hintStyle}>
            What MDHHS estimated when you saved in I-Billing. Helps
            spot discrepancies when the EFT lands.
          </span>
        </label>

        <div style={actionsRowStyle}>
          <button type="button" onClick={onBack} style={ghostBtn}>← Back to export</button>
          <div style={{ flex: 1 }} />
          <button
            type="submit"
            disabled={submitting || !confirmationNumber.trim()}
            style={primaryBtn(submitting || !confirmationNumber.trim())}
          >
            {submitting ? 'Saving…' : 'Save and lock this period'}
          </button>
        </div>
      </form>
    </section>
  )
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const lockedBoxStyle = {
  background: '#f0fdf4', border: '1px solid #bbf7d0',
  borderRadius: 8, padding: 16,
}

const dlStyle = {
  marginTop: 12, display: 'grid',
  gridTemplateColumns: '180px 1fr', gap: '6px 12px',
  fontSize: 13,
}

const formStyle = {
  display: 'flex', flexDirection: 'column', gap: 14,
  background: '#fff', border: '1px solid #e5e7eb',
  borderRadius: 8, padding: 16,
}

const fieldLabelStyle = {
  display: 'flex', flexDirection: 'column', gap: 4,
  fontSize: 13, color: '#374151', fontWeight: 500,
}

const inputStyle = {
  padding: 8, fontSize: 14, border: '1px solid #d1d5db',
  borderRadius: 6,
}

const hintStyle = {
  fontSize: 11, color: '#6b7280', marginTop: 2,
}

const requiredMark = { color: '#b91c1c' }

const errBoxStyle = {
  background: '#fef2f2', border: '1px solid #fecaca',
  color: '#7f1d1d', padding: 10, borderRadius: 6, marginBottom: 12,
}

const actionsRowStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  marginTop: 8, flexWrap: 'wrap',
}

const ghostBtn = {
  background: 'transparent', border: '1px solid #d1d5db', color: '#374151',
  borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontSize: 14,
}

const primaryBtn = (disabled) => ({
  background: disabled ? '#9ca3af' : '#0f766e', color: '#fff',
  border: 'none', borderRadius: 6, padding: '8px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 14, fontWeight: 600,
})
