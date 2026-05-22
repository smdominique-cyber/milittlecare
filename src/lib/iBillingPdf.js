// PDF builders for the I-Billing transfer & reconciliation flow
// (PR #9, Screen 4 § Format 1 and Format 2). CSV (Format 3) is in
// src/lib/iBillingExport.js — separately tested.
//
// Two builders:
//   - buildTransferSheetPdf       — one page per child; layout
//     mirrors the I-Billing entry screen so providers can transcribe
//     row-by-row.
//   - buildOfficialTimeAndAttendancePdf — one page per child; layout
//     follows the MiLEAP T&A Record Rev. 11.2024 form, pre-filled
//     with everything the system knows.
//
// Both are best-effort first-pass layouts (boxes, headers, totals,
// stamps) — they do **not** pixel-match the MiLEAP printed form.
// Generation stamp on every page reads "Draft layout — verify against
// MiLEAP form before audit use." Pixel-match polish is a follow-up PR.
//
// Both builders return the jsPDF instance. The caller picks
// `.output('blob')` (browser download), `.save('filename.pdf')`
// (autodownload), or `.output('arraybuffer')` (programmatic) — same
// pattern as the docs for jspdf.

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

import { runValidation } from './iBilling'
import { computeAttendanceHash } from './parentAcknowledgment'

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const DAY_OF_WEEK_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

function formatShortDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS_SHORT[m - 1]} ${d}`
}

function formatLongDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`
}

function dayOfWeekFromYMD(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return ''
  return DAY_OF_WEEK_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** 24h time string ('HH:MM' or 'HH:MM:SS') → 'HH:MM AM/PM' for I-Billing.
 *  Returns '' for null / malformed input. */
function formatTime12h(hms) {
  if (!hms) return ''
  const [hStr, mStr = '00'] = String(hms).split(':')
  const h = Number(hStr)
  const m = Number(mStr)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return ''
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${hour12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

function segmentDurationHours(check_in, check_out) {
  if (!check_in || !check_out) return null
  const parse = hms => {
    const parts = String(hms).split(':').map(Number)
    if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null
    const [h, m, s = 0] = parts
    return h + m / 60 + s / 3600
  }
  const a = parse(check_in)
  const b = parse(check_out)
  if (a == null || b == null) return null
  const diff = b - a
  return diff > 0 ? Math.round(diff * 100) / 100 : null
}

function fullChildName(child) {
  if (!child) return ''
  return [child.first_name, child.last_name].filter(s => s && String(s).trim()).join(' ').trim()
}

function childInitials(child) {
  if (!child) return ''
  const first = (child.first_name || '').trim()[0] || ''
  const last = (child.last_name || '').trim()[0] || ''
  return (first + last).toUpperCase()
}

function readCdcSource(child, fundingSources) {
  if (!child) return null
  const safe = Array.isArray(fundingSources) ? fundingSources : []
  return safe.find(fs =>
    fs && fs.type === 'cdc_scholarship' && fs.child_id === child.id && !fs.archived_at
  ) || null
}

function readCaseNumber(fs) {
  if (!fs) return ''
  return fs.case_number || (fs.details && fs.details.case_number) || ''
}

function readApprovedHours(fs) {
  if (!fs) return null
  return fs.approved_hours_per_period
    ?? (fs.details && fs.details.approved_hours_per_period)
    ?? null
}

function readFamilyContribution(fs) {
  if (!fs) return null
  return fs.family_contribution_amount
    ?? (fs.details && fs.details.family_contribution_amount)
    ?? null
}

function fmtMoney(n) {
  if (n == null || n === '') return ''
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return `$${v.toFixed(2)}`
}

function fmtHours(n) {
  if (n == null || n === '') return ''
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return `${v.toFixed(2)} h`
}

function dateArrayForPeriod(payPeriod) {
  if (!payPeriod || !payPeriod.start_date || !payPeriod.end_date) return []
  const dates = []
  let cur = payPeriod.start_date
  for (let i = 0; i < 14; i++) {
    if (cur > payPeriod.end_date) break
    dates.push(cur)
    cur = addDaysYMD(cur, 1)
  }
  return dates
}

/** Group attendance rows by child_id then by date. Returns
 *  { [childId]: { [date]: [segmentRow, …] } }. Sorted segments by
 *  segment_index ascending. Archived rows dropped. */
function indexAttendance(attendance) {
  const out = {}
  for (const r of Array.isArray(attendance) ? attendance : []) {
    if (!r || r.archived_at) continue
    if (!out[r.child_id]) out[r.child_id] = {}
    if (!out[r.child_id][r.date]) out[r.child_id][r.date] = []
    out[r.child_id][r.date].push(r)
  }
  for (const c of Object.keys(out)) {
    for (const d of Object.keys(out[c])) {
      out[c][d].sort((a, b) => (a.segment_index ?? 0) - (b.segment_index ?? 0))
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Shared chrome: header stamp, footer, page setup
// -----------------------------------------------------------------------------

const DRAFT_STAMP =
  'Draft layout — verify against MiLEAP form before audit use. ' +
  'Read-only. Do not edit by hand; return to MI Little Care to make changes.'

function drawHeaderStamp(doc, generatedAt) {
  const ts = generatedAt || new Date().toISOString()
  const tsHuman = (() => {
    try {
      const d = new Date(ts)
      return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    } catch {
      return ts
    }
  })()
  const w = doc.internal.pageSize.getWidth()
  doc.setFontSize(8)
  doc.setTextColor(140)
  doc.text(`Generated ${tsHuman}.`, w - 36, 24, { align: 'right' })
  doc.setFontSize(7)
  doc.text(DRAFT_STAMP, 36, 24, { maxWidth: w - 36 * 2 - 200 })
  doc.setTextColor(0)
}

function drawFooter(doc, label) {
  const w = doc.internal.pageSize.getWidth()
  const h = doc.internal.pageSize.getHeight()
  doc.setFontSize(8)
  doc.setTextColor(140)
  doc.text(label || 'MI Little Care · I-Billing transfer aid', 36, h - 24)
  doc.setTextColor(0)
}

// -----------------------------------------------------------------------------
// Format 1 — Transfer Sheet (mirrors I-Billing entry screen)
// -----------------------------------------------------------------------------

/**
 * Builds a Transfer Sheet PDF: one page per child with a 14-day grid
 * laid out the way a provider transcribes into the MiLEAP I-Billing
 * entry screen. IN1/OUT1/IN2/OUT2 rows, absent flag, daily total.
 *
 * @param {object} args
 * @param {object} args.payPeriod        CDC pay period row.
 * @param {object[]} args.attendance     Attendance rows (multi-segment).
 * @param {object[]} args.children       Children roster.
 * @param {object[]} args.fundingSources Funding sources (for case # / auth hours).
 * @param {object} [args.profile]        Provider's profile row.
 * @param {string} [args.generatedAt]    ISO timestamp; defaults to now.
 * @returns {jsPDF}                       The jsPDF instance.
 */
export function buildTransferSheetPdf({
  payPeriod,
  attendance,
  children,
  fundingSources,
  profile,
  generatedAt,
} = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const safeChildren = Array.isArray(children) ? children : []
  const dates = dateArrayForPeriod(payPeriod)
  const attByChild = indexAttendance(attendance)
  const generated = generatedAt || new Date().toISOString()

  // One page per child. Skip children with no attendance in the period
  // *and* no CDC funding source — those aren't being billed at all.
  const billableChildren = safeChildren.filter(c => {
    const hasAttendance = attByChild[c.id] && Object.keys(attByChild[c.id]).length > 0
    const hasCdc = !!readCdcSource(c, fundingSources)
    return hasAttendance || hasCdc
  })

  if (billableChildren.length === 0) {
    drawHeaderStamp(doc, generated)
    doc.setFontSize(14)
    doc.text('No children billable in this pay period.', 36, 100)
    drawFooter(doc, 'MI Little Care · Transfer Sheet (empty)')
    return doc
  }

  billableChildren.forEach((child, idx) => {
    if (idx > 0) doc.addPage()
    drawHeaderStamp(doc, generated)
    drawTransferSheetPage(doc, { child, payPeriod, dates, attByChild, fundingSources, profile })
    drawFooter(doc, 'MI Little Care · I-Billing Transfer Sheet')
  })

  return doc
}

function drawTransferSheetPage(doc, { child, payPeriod, dates, attByChild, fundingSources, profile }) {
  const fs = readCdcSource(child, fundingSources)
  const childAtt = attByChild[child.id] || {}

  // Title bar
  doc.setFontSize(14)
  doc.setFont(undefined, 'bold')
  doc.text(`Transfer Sheet — ${fullChildName(child)}`, 36, 56)
  doc.setFont(undefined, 'normal')
  doc.setFontSize(10)
  doc.text(
    `Pay period ${payPeriod?.period_number ?? ''}: ${formatLongDate(payPeriod?.start_date)} – ${formatLongDate(payPeriod?.end_date)}`,
    36, 74
  )

  // Header info block (case #, auth hours, family contrib, provider info)
  const headerRows = [
    ['Child', fullChildName(child)],
    ['Child ID', child.id || ''],
    ['Case number', readCaseNumber(fs) || '—'],
    ['Authorized hours / period', fmtHours(readApprovedHours(fs)) || '—'],
    ['Family contribution', fmtMoney(readFamilyContribution(fs)) || '—'],
    ['Provider', profile?.daycare_name || profile?.full_name || ''],
  ]
  autoTable(doc, {
    startY: 90,
    head: [],
    body: headerRows,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 130 } },
    margin: { left: 36, right: 36 },
  })

  // 14-day grid: dates across the top, IN1/OUT1/IN2/OUT2/Absent/Total rows down the left.
  // Two weeks side by side fit awkwardly in portrait letter; lay out as
  // two stacked 7-column tables (week 1, week 2) for legibility.
  const startY = doc.lastAutoTable.finalY + 16
  const w1 = dates.slice(0, 7)
  const w2 = dates.slice(7, 14)
  drawTransferWeek(doc, { startY, dates: w1, childAtt, label: 'Week 1' })
  drawTransferWeek(doc, {
    startY: doc.lastAutoTable.finalY + 16,
    dates: w2, childAtt, label: 'Week 2',
  })

  // Totals row at the bottom.
  let totalHours = 0
  let absenceDays = 0
  for (const d of dates) {
    const segs = childAtt[d] || []
    let dayHours = 0
    let isAbsent = false
    for (const s of segs) {
      if (s.status === 'absent') isAbsent = true
      else if (s.status === 'present') {
        dayHours += segmentDurationHours(s.check_in, s.check_out) || 0
      }
    }
    totalHours += dayHours
    if (isAbsent && dayHours === 0) absenceDays += 1
  }
  const totalsY = doc.lastAutoTable.finalY + 16
  autoTable(doc, {
    startY: totalsY,
    head: [['Pay period total', 'Absence days this period']],
    body: [[`${totalHours.toFixed(2)} h`, String(absenceDays)]],
    theme: 'grid',
    styles: { fontSize: 9, halign: 'center', cellPadding: 4 },
    headStyles: { fillColor: [240, 240, 240], textColor: 60 },
    margin: { left: 36, right: 36 },
  })
}

function drawTransferWeek(doc, { startY, dates, childAtt, label }) {
  // Header row: blank corner cell + 7 date cells
  const head = [[
    { content: label, styles: { fontStyle: 'bold', fillColor: [230, 230, 230] } },
    ...dates.map(d => ({
      content: `${dayOfWeekFromYMD(d)}\n${formatShortDate(d)}`,
      styles: { fontStyle: 'bold', halign: 'center' },
    })),
  ]]

  // Row builder: take a per-day function that returns the cell text
  const rowFor = (label, getter) => [
    { content: label, styles: { fontStyle: 'bold' } },
    ...dates.map(d => ({ content: getter(childAtt[d] || []), styles: { halign: 'center' } })),
  ]

  const body = [
    rowFor('IN 1', segs => formatTime12h(segs[0]?.check_in)),
    rowFor('OUT 1', segs => formatTime12h(segs[0]?.check_out)),
    rowFor('IN 2', segs => formatTime12h(segs[1]?.check_in)),
    rowFor('OUT 2', segs => formatTime12h(segs[1]?.check_out)),
    rowFor('Absent', segs => segs.some(s => s.status === 'absent') ? 'ABS' : ''),
    rowFor('Daily total', segs => {
      let h = 0
      for (const s of segs) {
        if (s.status === 'present') h += segmentDurationHours(s.check_in, s.check_out) || 0
      }
      return h > 0 ? `${h.toFixed(2)} h` : ''
    }),
  ]

  autoTable(doc, {
    startY,
    head, body,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [248, 248, 248], textColor: 40 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 60 } },
    margin: { left: 36, right: 36 },
  })
}

// -----------------------------------------------------------------------------
// Format 2 — Official MiLEAP Time & Attendance Record (Rev. 11.2024)
// -----------------------------------------------------------------------------

/**
 * Builds the official T&A Record PDF, pre-filled with everything the
 * system knows. Parent initials column is pre-filled from
 * attendance_acknowledgments (PR #12): the child's initials appear when
 * the row matches the segment's current canonical hash, "(override)"
 * for provider attestations, "(re-ack needed)" if the hash mismatches
 * (i.e. the row was edited after the parent acknowledged), and
 * "(awaiting)" otherwise. A per-page footnote legend explains each
 * state. CACFP meals column is left blank in V1 (CACFP integration is
 * a future PR).
 *
 * @param {object} args  Same shape as buildTransferSheetPdf plus:
 * @param {object[]} [args.acknowledgments]   Acknowledgment rows for the
 *                                            period. Defaults to [].
 * @returns {jsPDF}
 */
export function buildOfficialTimeAndAttendancePdf({
  payPeriod,
  attendance,
  children,
  fundingSources,
  profile,
  acknowledgments,
  generatedAt,
} = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' })
  const safeChildren = Array.isArray(children) ? children : []
  const dates = dateArrayForPeriod(payPeriod)
  const attByChild = indexAttendance(attendance)
  const ackIdx = indexAcknowledgments(acknowledgments)
  const generated = generatedAt || new Date().toISOString()

  const billableChildren = safeChildren.filter(c => {
    const hasAttendance = attByChild[c.id] && Object.keys(attByChild[c.id]).length > 0
    const hasCdc = !!readCdcSource(c, fundingSources)
    return hasAttendance || hasCdc
  })

  if (billableChildren.length === 0) {
    drawHeaderStamp(doc, generated)
    doc.setFontSize(14)
    doc.text('No children billable in this pay period.', 36, 100)
    drawFooter(doc, 'MI Little Care · Official T&A Record (empty)')
    return doc
  }

  billableChildren.forEach((child, idx) => {
    if (idx > 0) doc.addPage('letter', 'landscape')
    drawHeaderStamp(doc, generated)
    drawOfficialTaPage(doc, { child, payPeriod, dates, attByChild, ackIdx, fundingSources, profile })
    drawFooter(doc, 'MI Little Care · MiLEAP Time & Attendance Record (draft layout)')
  })

  return doc
}

function drawOfficialTaPage(doc, { child, payPeriod, dates, attByChild, ackIdx, fundingSources, profile }) {
  const fs = readCdcSource(child, fundingSources)
  const childAtt = attByChild[child.id] || {}
  const initials = childInitials(child)

  // Title row
  doc.setFontSize(13)
  doc.setFont(undefined, 'bold')
  doc.text('Michigan Child Care Time and Attendance Record', 36, 56)
  doc.setFont(undefined, 'normal')
  doc.setFontSize(9)
  doc.text('Rev. 11.2024 — pre-fill via MI Little Care', 36, 70)

  // Provider / child header — two columns
  const provider = profile?.daycare_name || profile?.full_name || ''
  const providerId =
    profile?.bridges_provider_id || profile?.michigan_provider_id ||
    profile?.miregistry_id || ''
  autoTable(doc, {
    startY: 86,
    head: [],
    body: [
      [
        { content: 'Provider', styles: { fontStyle: 'bold' } },
        provider,
        { content: 'Provider ID', styles: { fontStyle: 'bold' } },
        providerId,
      ],
      [
        { content: 'Child name', styles: { fontStyle: 'bold' } },
        fullChildName(child),
        { content: 'Case number', styles: { fontStyle: 'bold' } },
        readCaseNumber(fs) || '',
      ],
      [
        { content: 'Pay period', styles: { fontStyle: 'bold' } },
        `${payPeriod?.period_number ?? ''}  (${formatLongDate(payPeriod?.start_date)} – ${formatLongDate(payPeriod?.end_date)})`,
        { content: 'Authorized hours', styles: { fontStyle: 'bold' } },
        fmtHours(readApprovedHours(fs)) || '',
      ],
    ],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 4 },
    columnStyles: {
      0: { cellWidth: 95 },
      1: { cellWidth: 220 },
      2: { cellWidth: 95 },
      3: { cellWidth: 220 },
    },
    margin: { left: 36, right: 36 },
  })

  // 14-day per-day grid: 10 columns matching the form's layout.
  //   Date | Day | IN 1 | OUT 1 | IN 2 | OUT 2 | Total hrs | Absent | Parent init. | CACFP meals
  const head = [[
    'Date', 'Day', 'IN 1', 'OUT 1', 'IN 2', 'OUT 2',
    'Total hrs', 'Absent', 'Parent init.', 'CACFP meals',
  ]]
  const body = dates.map(d => {
    const segs = childAtt[d] || []
    let dayHours = 0
    let isAbsent = false
    for (const s of segs) {
      if (s.status === 'absent') isAbsent = true
      else if (s.status === 'present') {
        dayHours += segmentDurationHours(s.check_in, s.check_out) || 0
      }
    }
    return [
      formatShortDate(d),
      dayOfWeekFromYMD(d),
      formatTime12h(segs[0]?.check_in),
      formatTime12h(segs[0]?.check_out),
      formatTime12h(segs[1]?.check_in),
      formatTime12h(segs[1]?.check_out),
      dayHours > 0 ? dayHours.toFixed(2) : '',
      isAbsent ? 'X' : '',
      // Parent-initial cell: aggregated across the segments of this day.
      dayHours > 0 ? parentInitialCell({ segs, ackIdx, child, initials }) : '',
      '',   // CACFP meals — out of scope this PR
    ]
  })
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 10,
    head, body,
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 3, halign: 'center' },
    headStyles: { fillColor: [240, 240, 240], textColor: 40, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { cellWidth: 40 },
      2: { cellWidth: 60 },
      3: { cellWidth: 60 },
      4: { cellWidth: 60 },
      5: { cellWidth: 60 },
      6: { cellWidth: 55 },
      7: { cellWidth: 45 },
      8: { cellWidth: 70 },
      9: { cellWidth: 75 },
    },
    margin: { left: 36, right: 36 },
  })

  // Footnote / signature block
  const sigY = doc.lastAutoTable.finalY + 18
  doc.setFontSize(9)
  doc.text(
    'Comments:',
    36, sigY
  )
  doc.line(80, sigY + 1, 760, sigY + 1)
  doc.text(
    'Provider signature: ____________________________________________________   Date: ________________',
    36, sigY + 24
  )
  doc.setFontSize(8)
  doc.setTextColor(140)
  doc.text(
    'Parent-initial column legend:  ' +
    'initials (e.g. "MR") = parent acknowledged electronically;  ' +
    '"(override)" = provider attested per audit override;  ' +
    '"(re-ack needed)" = attendance was edited after parent acknowledged;  ' +
    '"(awaiting)" = no parent acknowledgment yet — parent should initial by hand.',
    36, sigY + 44, { maxWidth: 760 }
  )
  doc.setTextColor(0)
}

// -----------------------------------------------------------------------------
// Parent-initial cell resolver (PR #12 wiring)
// -----------------------------------------------------------------------------

/**
 * Index acknowledgments by (child_id|date|segment_index). Archived rows
 * are dropped. Returns a Map.
 */
function indexAcknowledgments(acknowledgments) {
  const idx = new Map()
  const safe = Array.isArray(acknowledgments) ? acknowledgments : []
  for (const a of safe) {
    if (!a || a.archived_at) continue
    if (!a.child_id || !a.date) continue
    const key = `${a.child_id}|${a.date}|${a.segment_index ?? 0}`
    idx.set(key, a)
  }
  return idx
}

/**
 * Day-level parent-initial cell text. Aggregates across the day's
 * present segments (multi-segment days are common when there's a
 * before-school + after-school split). Resolution:
 *
 *   - Every billed segment matches a parent acknowledgment whose
 *     attendance_snapshot_hash equals the current canonical hash →
 *     child's initials (e.g. "MR").
 *   - At least one segment was acknowledged via provider override →
 *     "(override)" (only if no plain-parent acks remain to make the
 *     "initials" wording correct; a mix of override + parent collapses
 *     to "(override)" since the override is the authoritative one).
 *   - Any segment's hash mismatches its acknowledgment → "(re-ack
 *     needed)".
 *   - Any segment has no acknowledgment on file → "(awaiting)".
 */
function parentInitialCell({ segs, ackIdx, child, initials }) {
  const billed = segs.filter(s => s && s.status === 'present'
    && (segmentDurationHours(s.check_in, s.check_out) || 0) > 0)
  if (billed.length === 0) return ''

  let allClean = true
  let anyOverride = false
  let anyTampered = false
  let anyUnack = false
  for (const s of billed) {
    const key = `${child.id}|${s.date}|${s.segment_index ?? 0}`
    const ack = ackIdx.get(key)
    if (!ack) { anyUnack = true; allClean = false; continue }
    const currentHash = computeAttendanceHash(s)
    if (currentHash !== ack.attendance_snapshot_hash) {
      anyTampered = true; allClean = false; continue
    }
    if (ack.acknowledged_via === 'provider_override') {
      anyOverride = true
    }
  }
  if (anyUnack)    return '(awaiting)'
  if (anyTampered) return '(re-ack needed)'
  if (anyOverride) return '(override)'
  if (allClean)    return initials || '✓'
  return '(awaiting)'
}

// -----------------------------------------------------------------------------
// Optional sanity helper — counts what the builders will emit without
// committing to one output format. Useful for the UI's "Will produce N
// pages" affordance and for the smoke test.
// -----------------------------------------------------------------------------

export function describePdfOutput({ payPeriod, attendance, children, fundingSources } = {}) {
  const safeChildren = Array.isArray(children) ? children : []
  const dates = dateArrayForPeriod(payPeriod)
  const attByChild = indexAttendance(attendance)
  const billableChildren = safeChildren.filter(c => {
    const hasAttendance = attByChild[c.id] && Object.keys(attByChild[c.id]).length > 0
    const hasCdc = !!readCdcSource(c, fundingSources)
    return hasAttendance || hasCdc
  })
  return {
    pageCount: Math.max(1, billableChildren.length),
    childCount: billableChildren.length,
    periodDayCount: dates.length,
  }
}

// Re-export for the consumer who wants a unified "build everything" call.
export { runValidation }
