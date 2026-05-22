// I-Billing Screen 2 — Review Grid (PR #9).
//
// Children × days table for the selected pay period. Each cell shows
// the day's billed hours with absent indicator, and is colour-coded by
// the worst-severity validation issue affecting it. The right column
// is the per-child total; the bottom row is the per-day total.
//
// Clicking a cell with issues opens the IssueResolutionModal (Screen 3,
// next commit). Until that ships, the prop `onSelectIssue` is optional
// and the click is a no-op.

import { useMemo } from 'react'
import { AlertTriangle, Ban, Info } from 'lucide-react'
import { SEVERITY } from '@/lib/iBilling'
import { buildReviewGrid, RULE_LABEL } from '@/lib/iBillingGrid'
import HelpTooltip from '@/components/ui/HelpTooltip'

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Props:
 *   payPeriod        — selected catalog row.
 *   attendance       — attendance rows for the period.
 *   children         — children roster.
 *   fundingSources   — funding sources.
 *   issues           — runValidation() output.
 *   onAdvance        — () => void, invoked when "Continue to export" is
 *                       clicked. Disabled when any BLOCKING issue exists.
 *   onBack           — () => void
 *   onOpenIssue      — (issue) => void, invoked when a cell is clicked.
 *                       Screen 3 listens for this and opens the modal.
 */
export default function ReviewGrid({
  payPeriod,
  attendance,
  children,
  fundingSources,
  issues,
  onAdvance,
  onBack,
  onOpenIssue,
  onOpenChildIssues,
}) {
  const grid = useMemo(
    () => buildReviewGrid({ payPeriod, attendance, children, fundingSources, issues }),
    [payPeriod, attendance, children, fundingSources, issues]
  )

  const blockingCount = (issues || []).filter(i => i.severity === SEVERITY.BLOCKING).length
  const warningCount  = (issues || []).filter(i => i.severity === SEVERITY.WARNING).length
  const infoCount     = (issues || []).filter(i => i.severity === SEVERITY.INFO).length

  return (
    <section aria-label="Pay period review grid">
      <header style={summaryStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            Period {payPeriod?.period_number}{' '}
            <span style={{ color: '#6b7280', fontWeight: 400 }}>
              ({payPeriod?.start_date} → {payPeriod?.end_date})
            </span>
          </h2>
          <p style={{ margin: '4px 0 0 0', color: '#4b5563' }}>
            {grid.rows.length} children · {grid.totals.grand.toFixed(2)} total billable hours
          </p>
        </div>
        <ul style={countersStyle} aria-label="Validation summary">
          <CounterPill icon={<Ban size={14} />}            count={blockingCount} tone="bad"     label="blocking" />
          <CounterPill icon={<AlertTriangle size={14} />}  count={warningCount}  tone="warn"    label="warnings" />
          <CounterPill icon={<Info size={14} />}           count={infoCount}     tone="info"    label="info" />
        </ul>
      </header>

      {grid.providerIssues.length > 0 && (
        <div role="region" aria-label="Provider-level validation issues" style={providerBoxStyle}>
          <strong>Provider-level issues:</strong>
          <ul style={{ margin: '4px 0 0 20px' }}>
            {grid.providerIssues.map((iss, i) => (
              <li key={i} style={{ color: toneFor(iss.severity).fg }}>
                {RULE_LABEL[iss.ruleId] || iss.ruleId}: {iss.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={tableScrollStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle} aria-label="Child">Child</th>
              {grid.days.map(d => (
                <th key={d} style={thDateStyle} title={d}>{shortDate(d)}</th>
              ))}
              <th style={thStyle}>Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.length === 0 ? (
              <tr>
                <td colSpan={grid.days.length + 2} style={emptyStyle}>
                  No children with attendance or CDC funding in this period.
                </td>
              </tr>
            ) : grid.rows.map(row => (
              <tr key={row.child.id}>
                <th scope="row" style={rowHeaderStyle}>
                  <div style={{ fontWeight: 600 }}>
                    {row.child.first_name} {row.child.last_name}
                  </div>
                  {childIssueCount(row) > 0 && (
                    <HelpTooltip
                      label={`${childIssueCount(row)} issue(s) for ${row.child.first_name || 'this child'} — click to resolve`}
                      text={childIssueRuleList(row).map(id => RULE_LABEL[id] || id).join(', ')}
                    >
                      <button
                        type="button"
                        onClick={() => onOpenChildIssues?.(row.child.id)}
                        style={badgePillButton(worstOf(allChildIssues(row)))}
                      >
                        {childIssueCount(row)} issue{childIssueCount(row) === 1 ? '' : 's'}
                      </button>
                    </HelpTooltip>
                  )}
                </th>
                {grid.days.map(date => {
                  const cell = row.cells[date]
                  const tone = cell.worstSeverity ? toneFor(cell.worstSeverity) : null
                  const clickable = cell.issues.length > 0
                  return (
                    <td
                      key={date}
                      style={{
                        ...cellStyle,
                        background: tone ? tone.bg : (cell.hours > 0 ? '#f0fdf4' : 'transparent'),
                        cursor: clickable ? 'pointer' : 'default',
                      }}
                      onClick={() => clickable && onOpenIssue?.(cell.issues[0])}
                      title={cellTitle(cell, date)}
                    >
                      {cell.isAbsent
                        ? <span style={{ color: '#92400e' }}>abs</span>
                        : cell.hours > 0
                          ? cell.hours.toFixed(1)
                          : <span style={{ color: '#d1d5db' }}>–</span>}
                      {cell.issues.length > 0 && (
                        <span style={cellBadge(tone)} aria-hidden>!</span>
                      )}
                    </td>
                  )
                })}
                <td style={{ ...cellStyle, fontWeight: 600 }}>
                  {row.totalHours.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" style={rowHeaderStyle}>Daily total</th>
              {grid.days.map(d => (
                <td key={d} style={{ ...cellStyle, fontWeight: 600 }}>
                  {(grid.totals.perDay[d] || 0).toFixed(1)}
                </td>
              ))}
              <td style={{ ...cellStyle, fontWeight: 700, background: '#f0f9ff' }}>
                {grid.totals.grand.toFixed(2)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={actionsRowStyle}>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← Back to picker
        </button>
        <div style={{ flex: 1 }} />
        {blockingCount > 0 ? (
          <span role="alert" style={{ color: '#b91c1c', marginRight: 12 }}>
            {blockingCount} blocking issue{blockingCount === 1 ? '' : 's'} must be resolved before export.
          </span>
        ) : null}
        <button
          type="button"
          onClick={onAdvance}
          disabled={blockingCount > 0}
          style={primaryBtn(blockingCount > 0)}
        >
          Continue to export →
        </button>
      </div>
    </section>
  )
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function CounterPill({ icon, count, tone, label }) {
  const t = TONE_PALETTE[tone]
  return (
    <li style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 12,
      background: t.bg, color: t.fg, fontSize: 13, fontWeight: 600,
    }}>
      {icon} {count} {label}
    </li>
  )
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function shortDate(ymd) {
  if (!ymd) return ''
  const [, m, d] = ymd.split('-').map(Number)
  return `${m}/${d}`
}

function worstOf(issues) {
  for (const i of issues) if (i.severity === SEVERITY.BLOCKING) return SEVERITY.BLOCKING
  for (const i of issues) if (i.severity === SEVERITY.WARNING)  return SEVERITY.WARNING
  return SEVERITY.INFO
}

// Every issue belonging to a child: the child-level ones (no date) plus
// the per-cell ones across the row. The badge counts these and the
// click opens the modal filtered to the same set, so Audrey's cell-level
// "Outside CDC authorization" issue is reachable from the name badge,
// not only by clicking the day cell.
function allChildIssues(row) {
  const cellIssues = []
  for (const date of Object.keys(row.cells || {})) {
    for (const iss of row.cells[date].issues || []) cellIssues.push(iss)
  }
  return [...(row.childIssues || []), ...cellIssues]
}

function childIssueCount(row) {
  return allChildIssues(row).length
}

function childIssueRuleList(row) {
  return [...new Set(allChildIssues(row).map(i => i.ruleId))]
}

function toneFor(severity) {
  if (severity === SEVERITY.BLOCKING) return TONE_PALETTE.bad
  if (severity === SEVERITY.WARNING)  return TONE_PALETTE.warn
  return TONE_PALETTE.info
}

function cellTitle(cell, date) {
  const lines = [date]
  if (cell.isAbsent) lines.push('Absent')
  if (cell.hours > 0) lines.push(`${cell.hours.toFixed(2)} billable hours`)
  for (const iss of cell.issues) lines.push(`• ${RULE_LABEL[iss.ruleId] || iss.ruleId}: ${iss.message || ''}`)
  return lines.join('\n')
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const TONE_PALETTE = {
  bad:  { bg: '#fef2f2', fg: '#b91c1c' },
  warn: { bg: '#fffbeb', fg: '#b45309' },
  info: { bg: '#f0f9ff', fg: '#075985' },
}

const summaryStyle = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  gap: 16, flexWrap: 'wrap', marginBottom: 16,
}

const countersStyle = {
  listStyle: 'none', padding: 0, margin: 0,
  display: 'inline-flex', gap: 8,
}

const providerBoxStyle = {
  background: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: 8,
  padding: 12,
  marginBottom: 16,
  color: '#92400e',
}

const tableScrollStyle = {
  overflowX: 'auto',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  background: '#fff',
}

const tableStyle = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13,
}

const thStyle = {
  background: '#f9fafb', padding: '8px 10px', textAlign: 'left',
  borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0,
  fontWeight: 600, color: '#374151',
}

const thDateStyle = {
  ...thStyle, textAlign: 'center', minWidth: 48,
}

const rowHeaderStyle = {
  padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #f3f4f6',
  background: '#fff', position: 'sticky', left: 0, zIndex: 1,
  minWidth: 140,
}

const cellStyle = {
  padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #f3f4f6',
  position: 'relative',
}

const emptyStyle = {
  padding: 24, textAlign: 'center', color: '#6b7280',
}

const badgePill = (severity) => ({
  display: 'inline-block',
  marginTop: 4,
  padding: '1px 8px',
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  background: toneFor(severity).bg,
  color:      toneFor(severity).fg,
})

// Same look as badgePill, but an actual <button>: clickable, keyboard-
// focusable, opens the issue modal filtered to this child (Bug 4).
const badgePillButton = (severity) => ({
  ...badgePill(severity),
  border: `1px solid ${toneFor(severity).fg}33`,
  cursor: 'pointer',
})

const cellBadge = (tone) => ({
  position: 'absolute', top: 2, right: 4,
  fontSize: 10, fontWeight: 700,
  color: tone ? tone.fg : '#6b7280',
})

const actionsRowStyle = {
  display: 'flex', alignItems: 'center',
  marginTop: 16, gap: 8, flexWrap: 'wrap',
}

const ghostBtn = {
  background: 'transparent', border: '1px solid #d1d5db',
  borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 14,
}

const primaryBtn = (disabled) => ({
  background: disabled ? '#9ca3af' : '#0f766e',
  color: '#fff', border: 'none',
  borderRadius: 6, padding: '8px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 14, fontWeight: 600,
})
