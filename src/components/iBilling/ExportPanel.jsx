// I-Billing Screen 4 — Export panel (PR #9).
//
// Downloads the three export formats and offers the "two-window" mode
// the spec describes (§ Screen 4): the MDHHS I-Billing portal opens in
// a separate window so the provider can key values from the CSV/PDFs
// without leaving either context. The CSV + PDFs all use the pure
// builders in src/lib/iBillingExport.js and src/lib/iBillingPdf.js.
//
// Two summary stats land in the export header — total billable hours
// and total days with any segment — so the provider can sanity-check
// the period before keying the I-Billing portal.

import { useState } from 'react'
import { FileSpreadsheet, FileText, ExternalLink, ChevronRight } from 'lucide-react'
import { buildCsv } from '@/lib/iBillingExport'
import {
  buildTransferSheetPdf,
  buildOfficialTimeAndAttendancePdf,
} from '@/lib/iBillingPdf'

const MDHHS_IBILLING_URL = 'https://www.michigan.gov/mileap/early-childhood-education/early-learners-and-care/cdc/providers'

// -----------------------------------------------------------------------------
// File-download helpers
// -----------------------------------------------------------------------------

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeFilenamePart(s) {
  return String(s || '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

/**
 * Props:
 *   payPeriod, attendance, children, fundingSources, profile, issues,
 *   acknowledgments  — passed through to the builders.
 *   totalBillableHours, totalBilledDays — sanity-check summary at the top.
 *   onBack           — () => void
 *   onAdvance        — () => void  (advance to Reconcile)
 */
export default function ExportPanel({
  payPeriod,
  attendance,
  children,
  fundingSources,
  profile,
  issues,
  acknowledgments,
  totalBillableHours,
  totalBilledDays,
  onBack,
  onAdvance,
}) {
  const [downloading, setDownloading] = useState(null)
  const [err, setErr] = useState(null)
  const [opened, setOpened] = useState(false)

  function fileBase() {
    return `i-billing-${safeFilenamePart(profile?.daycare_name || profile?.full_name || 'provider')}-period-${payPeriod?.period_number || 'na'}`
  }

  async function handleCsv() {
    setErr(null); setDownloading('csv')
    try {
      const csv = buildCsv({
        payPeriod, attendance, children, fundingSources,
        issues, profile,
      })
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      downloadBlob(blob, `${fileBase()}.csv`)
    } catch (e) {
      setErr(e?.message || 'CSV export failed.')
    } finally {
      setDownloading(null)
    }
  }

  async function handleTransferPdf() {
    setErr(null); setDownloading('transfer')
    try {
      const doc = buildTransferSheetPdf({
        payPeriod, attendance, children, fundingSources, profile,
      })
      doc.save(`${fileBase()}-transfer-sheet.pdf`)
    } catch (e) {
      setErr(e?.message || 'Transfer Sheet PDF export failed.')
    } finally {
      setDownloading(null)
    }
  }

  async function handleOfficialPdf() {
    setErr(null); setDownloading('official')
    try {
      const doc = buildOfficialTimeAndAttendancePdf({
        payPeriod, attendance, children, fundingSources, profile,
        acknowledgments,
      })
      doc.save(`${fileBase()}-time-and-attendance.pdf`)
    } catch (e) {
      setErr(e?.message || 'Official T&A PDF export failed.')
    } finally {
      setDownloading(null)
    }
  }

  function handleOpenPortal() {
    // noopener stops the I-Billing window from being able to navigate
    // ours via window.opener (we render an audit-sensitive page).
    const w = window.open(MDHHS_IBILLING_URL, '_blank', 'noopener')
    if (w) setOpened(true)
  }

  return (
    <section aria-label="I-Billing export">
      <h2 style={{ margin: '0 0 4px 0', fontSize: 18 }}>
        Period {payPeriod?.period_number}{' '}
        <span style={{ color: '#6b7280', fontWeight: 400 }}>
          ({payPeriod?.start_date} → {payPeriod?.end_date})
        </span>
      </h2>
      <p style={{ margin: '0 0 16px 0', color: '#4b5563' }}>
        {totalBillableHours?.toFixed(2)} billable hours across{' '}
        {totalBilledDays} day{totalBilledDays === 1 ? '' : 's'}. Reporting
        deadline <strong>{payPeriod?.reporting_deadline}</strong>.
      </p>

      {err && (
        <div role="alert" style={errBoxStyle}>{err}</div>
      )}

      <div style={twoWindowExplainStyle}>
        <strong>How to use this screen:</strong>
        <ol style={{ margin: '4px 0 0 20px' }}>
          <li>Click <em>Open I-Billing in a new window</em>.</li>
          <li>Download the export below; keep it open beside the portal.</li>
          <li>Key the values into I-Billing one row at a time.</li>
          <li>Save the MDHHS confirmation number from the portal.</li>
          <li>Come back here and click <em>Continue to reconcile</em>.</li>
        </ol>
      </div>

      <div style={actionsGridStyle}>
        <ExportCard
          icon={<FileSpreadsheet size={20} aria-hidden />}
          title="CSV (one row per child-day-segment)"
          description="Spreadsheet-friendly. Includes validation flags column for audit."
          onDownload={handleCsv}
          busy={downloading === 'csv'}
        />
        <ExportCard
          icon={<FileText size={20} aria-hidden />}
          title="Transfer Sheet (Format 1, portrait)"
          description="One page per child with the IN1/OUT1/IN2/OUT2 grid the I-Billing portal expects."
          onDownload={handleTransferPdf}
          busy={downloading === 'transfer'}
        />
        <ExportCard
          icon={<FileText size={20} aria-hidden />}
          title="Official T&A Record (Format 2, landscape)"
          description="The MiLEAP-format Time & Attendance Record with the daily grid and parent initials column."
          onDownload={handleOfficialPdf}
          busy={downloading === 'official'}
        />
      </div>

      <div style={portalRowStyle}>
        <button type="button" onClick={handleOpenPortal} style={ghostBtn}>
          <ExternalLink size={16} aria-hidden /> Open I-Billing in a new window
        </button>
        {opened && (
          <span style={{ fontSize: 12, color: '#15803d' }}>
            Portal opened. Switch to that window to key your values.
          </span>
        )}
      </div>

      <div style={actionsRowStyle}>
        <button type="button" onClick={onBack} style={ghostBtn}>← Back to review</button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onAdvance} style={primaryBtn(false)}>
          Continue to reconcile <ChevronRight size={16} aria-hidden />
        </button>
      </div>
    </section>
  )
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function ExportCard({ icon, title, description, onDownload, busy }) {
  return (
    <div style={exportCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: '#0f766e' }}>
        {icon}
        <strong style={{ fontSize: 14, color: '#111' }}>{title}</strong>
      </div>
      <p style={{ margin: '0 0 12px 0', fontSize: 13, color: '#4b5563' }}>
        {description}
      </p>
      <button type="button" onClick={onDownload} disabled={busy} style={primaryBtn(busy)}>
        {busy ? 'Generating…' : 'Download'}
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const errBoxStyle = {
  background: '#fef2f2', border: '1px solid #fecaca',
  color: '#7f1d1d', padding: 10, borderRadius: 6, marginBottom: 12,
}

const twoWindowExplainStyle = {
  background: '#f0f9ff', border: '1px solid #bae6fd',
  borderRadius: 8, padding: 12, marginBottom: 16, color: '#075985',
  fontSize: 13,
}

const actionsGridStyle = {
  display: 'grid', gap: 12,
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
}

const exportCardStyle = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
  padding: 16,
}

const portalRowStyle = {
  marginTop: 16, padding: 12, background: '#f9fafb',
  border: '1px solid #e5e7eb', borderRadius: 8,
  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
}

const actionsRowStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  marginTop: 16, flexWrap: 'wrap',
}

const ghostBtn = {
  background: 'transparent', border: '1px solid #d1d5db', color: '#374151',
  borderRadius: 6, padding: '8px 12px', cursor: 'pointer', fontSize: 14,
  display: 'inline-flex', alignItems: 'center', gap: 6,
}

const primaryBtn = (disabled) => ({
  background: disabled ? '#9ca3af' : '#0f766e', color: '#fff',
  border: 'none', borderRadius: 6, padding: '8px 14px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: 14, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 6,
})
