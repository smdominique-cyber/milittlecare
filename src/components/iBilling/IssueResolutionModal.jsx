// I-Billing Screen 3 — Issue Resolution modal (PR #9).
//
// Opens from the ReviewGrid when a cell with issues is clicked, OR
// when the provider hits "Resolve issues" from the validation summary.
// Lists every active issue for the selected pay period, sorted
// blocking → warning → info, with two action paths per issue:
//
//   1. Apply proposed fix (one click)
//      The fix shape comes from the validation rule itself
//      (src/lib/iBilling.js). The modal hands the action payload to the
//      orchestrator's `onApplyFix` callback which performs the supabase
//      mutation and refetches the period.
//
//   2. Override with note
//      Required free-text reason; writes one row to
//      attendance_validation_overrides (audit trail). The orchestrator
//      tracks active overrides and filters them out of the displayed
//      issue list — the override appears in the "Overridden" section
//      below the active list for visibility.
//
// All I/O is the orchestrator's job. This component is pure-render.

import { useMemo, useState } from 'react'
import { X, AlertTriangle, Ban, Info, FileCheck } from 'lucide-react'
import { SEVERITY } from '@/lib/iBilling'
import { RULE_LABEL } from '@/lib/iBillingGrid'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const FIX_LABEL = {
  remove_segment:                  'Remove this segment',
  split_at_midnight:               'Auto-split at midnight',
  trim_school_hours:               'Trim the school-hours portion',
  provider_override_acknowledgment: 'Attest on behalf of the parent',
}

function severityIcon(s) {
  if (s === SEVERITY.BLOCKING) return <Ban size={14} />
  if (s === SEVERITY.WARNING)  return <AlertTriangle size={14} />
  return <Info size={14} />
}

function severityTone(s) {
  if (s === SEVERITY.BLOCKING) return { bg: '#fef2f2', fg: '#b91c1c', label: 'Blocking' }
  if (s === SEVERITY.WARNING)  return { bg: '#fffbeb', fg: '#b45309', label: 'Warning' }
  return { bg: '#f0f9ff', fg: '#075985', label: 'Info' }
}

/**
 * Stable key for matching issues to overrides. Pay-period-level rules
 * (no childId, no date) overlap on rule_id alone; child-level overlap
 * on (rule_id, child_id); cell-level on (rule_id, child_id, date,
 * segment_index).
 */
export function issueMatchKey(iss) {
  if (!iss) return ''
  return [
    iss.ruleId || '',
    iss.childId || '',
    iss.date || '',
    iss.segmentIndex ?? '',
  ].join('|')
}

export function buildOverrideIndex(overrides) {
  const safe = Array.isArray(overrides) ? overrides : []
  const idx = new Set()
  for (const o of safe) {
    if (!o || !o.rule_id) continue
    // Build the same key shape the issue produces. attendance_id maps
    // to (child_id, date, segment_index) only indirectly; we record
    // the broader (rule_id, child_id) match so an override applies to
    // the whole child unless the orchestrator passes attendance_id-
    // resolved data.
    const key = [o.rule_id, o.child_id || '', '', ''].join('|')
    idx.add(key)
    // Also add cell-level if the orchestrator provided date/segment
    // (the audit row doesn't carry them, so this is a no-op today,
    // but future-proofs the matcher).
    if (o.date) {
      idx.add([o.rule_id, o.child_id || '', o.date, o.segment_index ?? ''].join('|'))
    }
  }
  return idx
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Props:
 *   issues       — current validation issues (already filtered for
 *                  active overrides by the orchestrator).
 *   overridden   — issues that match an active override row.
 *   onApplyFix   — async (issue) => void, supabase mutation in caller.
 *   onOverride   — async (issue, reason) => void
 *   onClose      — () => void
 *   initialIssue — optional; scrolls to and highlights this issue.
 */
export default function IssueResolutionModal({
  issues,
  overridden,
  onApplyFix,
  onOverride,
  onClose,
  initialIssue,
}) {
  const [overrideTarget, setOverrideTarget] = useState(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [err, setErr] = useState(null)

  // Sort blocking → warning → info; preserve insertion order within
  // each tier so consecutive renders don't reshuffle.
  const sorted = useMemo(() => {
    const rank = { [SEVERITY.BLOCKING]: 3, [SEVERITY.WARNING]: 2, [SEVERITY.INFO]: 1 }
    return [...(issues || [])].sort(
      (a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0)
    )
  }, [issues])

  async function handleApplyFix(iss) {
    if (!onApplyFix) return
    setBusyKey(issueMatchKey(iss))
    setErr(null)
    try { await onApplyFix(iss) }
    catch (e) { setErr(e?.message || 'Could not apply the proposed fix.') }
    finally { setBusyKey(null) }
  }

  async function handleSubmitOverride(e) {
    e.preventDefault()
    if (!overrideTarget || !overrideReason.trim()) return
    setBusyKey(issueMatchKey(overrideTarget))
    setErr(null)
    try {
      await onOverride?.(overrideTarget, overrideReason.trim())
      setOverrideTarget(null)
      setOverrideReason('')
    } catch (e2) {
      setErr(e2?.message || 'Could not save the override.')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="iss-modal-title" style={backdropStyle}>
      <div style={modalStyle}>
        <header style={modalHeaderStyle}>
          <h2 id="iss-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Resolve validation issues
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={iconBtnStyle}>
            <X size={18} />
          </button>
        </header>

        {err && (
          <div role="alert" style={errBoxStyle}>{err}</div>
        )}

        <div style={modalBodyStyle}>
          {sorted.length === 0 ? (
            <p style={{ color: '#15803d', margin: 0 }}>
              <FileCheck size={16} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} aria-hidden />
              No active issues. You can advance to the export step.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sorted.map(iss => {
                const tone = severityTone(iss.severity)
                const key = issueMatchKey(iss)
                const highlight = initialIssue && issueMatchKey(initialIssue) === key
                const isOverriding = overrideTarget && issueMatchKey(overrideTarget) === key
                return (
                  <li key={key + Math.random()} style={{
                    ...issueRowStyle,
                    background: highlight ? '#eff6ff' : '#fff',
                  }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                        background: tone.bg, color: tone.fg,
                      }}>
                        {severityIcon(iss.severity)} {tone.label}
                      </span>
                      <strong style={{ fontSize: 14 }}>
                        {RULE_LABEL[iss.ruleId] || iss.ruleId}
                      </strong>
                      {iss.date && (
                        <span style={{ fontSize: 12, color: '#6b7280' }}>· {iss.date}</span>
                      )}
                    </div>
                    <p style={{ margin: '6px 0 8px 0', fontSize: 13, color: '#374151' }}>
                      {iss.message}
                    </p>
                    {iss.auditCitation && (
                      <p style={{ margin: '0 0 8px 0', fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>
                        {iss.auditCitation}
                      </p>
                    )}

                    {!isOverriding ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {iss.proposedFix?.action?.kind && (
                          <button
                            type="button"
                            onClick={() => handleApplyFix(iss)}
                            disabled={busyKey === key}
                            style={primaryBtn(busyKey === key)}
                          >
                            {busyKey === key ? 'Working…' : (FIX_LABEL[iss.proposedFix.action.kind] || iss.proposedFix.description || 'Apply fix')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { setOverrideTarget(iss); setOverrideReason('') }}
                          style={ghostBtn}
                        >
                          Override with note
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={handleSubmitOverride} style={{ marginTop: 4 }}>
                        <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>
                          Reason (required — recorded in the audit trail):
                        </label>
                        <textarea
                          value={overrideReason}
                          onChange={e => setOverrideReason(e.target.value)}
                          required
                          rows={3}
                          style={textareaStyle}
                          placeholder="E.g. School was closed for snow day; child attended care during normal school hours."
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <button
                            type="submit"
                            disabled={busyKey === key || !overrideReason.trim()}
                            style={primaryBtn(busyKey === key || !overrideReason.trim())}
                          >
                            {busyKey === key ? 'Saving…' : 'Save override'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setOverrideTarget(null); setOverrideReason('') }}
                            style={ghostBtn}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {Array.isArray(overridden) && overridden.length > 0 && (
            <div style={overriddenSectionStyle}>
              <h3 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#6b7280' }}>
                Overridden (still recorded for audit):
              </h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {overridden.map((o, i) => (
                  <li key={i} style={{ fontSize: 12, color: '#6b7280', padding: '4px 0' }}>
                    • {RULE_LABEL[o.rule_id] || o.rule_id} — {o.override_reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer style={modalFooterStyle}>
          <button type="button" onClick={onClose} style={primaryBtn(false)}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const backdropStyle = {
  position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 50, padding: 16,
}

const modalStyle = {
  background: '#fff', borderRadius: 12, width: '100%', maxWidth: 720,
  maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
}

const modalHeaderStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: 16, borderBottom: '1px solid #e5e7eb',
}

const modalBodyStyle = {
  padding: 16, overflow: 'auto', flex: 1,
}

const modalFooterStyle = {
  padding: 16, borderTop: '1px solid #e5e7eb',
  display: 'flex', justifyContent: 'flex-end',
}

const issueRowStyle = {
  border: '1px solid #e5e7eb', borderRadius: 8, padding: 12,
  marginBottom: 8,
}

const errBoxStyle = {
  background: '#fef2f2', border: '1px solid #fecaca',
  color: '#7f1d1d', borderRadius: 6, padding: 10, margin: '0 16px',
}

const textareaStyle = {
  width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db',
  fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
}

const iconBtnStyle = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  padding: 4, color: '#6b7280',
}

const primaryBtn = (disabled) => ({
  background: disabled ? '#9ca3af' : '#0f766e', color: '#fff',
  border: 'none', borderRadius: 6, padding: '6px 12px',
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600,
})

const ghostBtn = {
  background: 'transparent', border: '1px solid #d1d5db', color: '#374151',
  borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
}

const overriddenSectionStyle = {
  marginTop: 16, paddingTop: 12, borderTop: '1px dashed #e5e7eb',
}
