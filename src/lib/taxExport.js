// MI Little Care — Tax Export Utility
// Generates a multi-tab .xlsx workbook with all tax data for a given year.
// Tabs: Summary, Receipts, Invoices, T/S Ratio, FSA Statements

import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'

// ============================================================
// Helpers
// ============================================================

const fmtMoney = (n) => {
  const num = Number(n) || 0
  return Math.round(num * 100) / 100
}

const fmtDate = (d) => {
  if (!d) return ''
  try {
    const date = new Date(d)
    if (isNaN(date.getTime())) return ''
    return date.toISOString().slice(0, 10)
  } catch { return '' }
}

const fmtPct = (n) => {
  const num = Number(n) || 0
  return `${(num * 100).toFixed(2)}%`
}

// IRS Schedule C category mapping
// Maps our internal categories → Schedule C lines
const SCHEDULE_C_MAP = {
  'Food & Meals':              { line: '8', label: 'Line 22 (Supplies) — Food provided to children' },
  'Meals & Entertainment':     { line: '8', label: 'Line 22 (Supplies) — Food provided to children' },
  'Toys & Activities':         { line: '22', label: 'Line 22 (Supplies)' },
  'Cleaning & Sanitization':   { line: '22', label: 'Line 22 (Supplies)' },
  'Office & Admin':            { line: '18', label: 'Line 18 (Office expense)' },
  'Vehicle / Mileage':         { line: '9',  label: 'Line 9 (Car and truck expenses)' },
  'Insurance':                 { line: '15', label: 'Line 15 (Insurance, other than health)' },
  'Utilities (T/S applied)':   { line: '25', label: 'Line 25 (Utilities) — T/S adjusted' },
  'Repairs & Maintenance':     { line: '21', label: 'Line 21 (Repairs and maintenance)' },
  'Professional Fees':         { line: '17', label: 'Line 17 (Legal and professional services)' },
  'Education & Training':      { line: '27a', label: 'Line 27a (Other expenses) — CDA / continuing ed' },
  'Other':                     { line: '27a', label: 'Line 27a (Other expenses)' },
}

// Categories that get T/S adjustment (vs full deduction)
const SHARED_EXPENSE_CATEGORIES = [
  'Utilities (T/S applied)',
  'Repairs & Maintenance',
  'Insurance',
]

// ============================================================
// Data fetchers
// ============================================================

async function fetchAllTaxData(licenseeId, year) {
  const startDate = `${year}-01-01`
  const endDate = `${year}-12-31`

  const [
    { data: profile },
    { data: receipts },
    { data: invoices },
    { data: families },
    { data: tsRatio },
    { data: hourLogs },
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', licenseeId).maybeSingle(),
    supabase.from('receipts').select('*').eq('user_id', licenseeId)
      .gte('date', startDate).lte('date', endDate).order('date'),
    supabase.from('invoices').select('*, families!inner(family_name)').eq('user_id', licenseeId)
      .gte('created_at', startDate).lte('created_at', endDate + 'T23:59:59').order('created_at'),
    supabase.from('families').select('*').eq('user_id', licenseeId),
    supabase.from('ts_ratios').select('*').eq('user_id', licenseeId).eq('year', year).maybeSingle(),
    supabase.from('hour_logs').select('*').eq('user_id', licenseeId)
      .gte('date', startDate).lte('date', endDate).order('date'),
  ])

  return {
    profile: profile || {},
    receipts: receipts || [],
    invoices: invoices || [],
    families: families || [],
    tsRatio: tsRatio,
    hourLogs: hourLogs || [],
  }
}

// ============================================================
// Sheet builders
// ============================================================

function buildSummarySheet(data, year) {
  const { profile, receipts, invoices, tsRatio } = data

  const tsPercent = tsRatio?.ts_percent || 0

  // Gross income
  const totalRevenue = invoices.reduce((sum, i) => sum + Number(i.amount_paid || 0), 0)

  // Group receipts by category, applying T/S where applicable
  const byCategory = {}
  for (const r of receipts) {
    const cat = r.category || 'Other'
    const amount = Number(r.total || r.amount || 0)
    const isShared = SHARED_EXPENSE_CATEGORIES.includes(cat)
    const deductible = isShared ? amount * tsPercent : amount
    if (!byCategory[cat]) byCategory[cat] = { gross: 0, deductible: 0, count: 0, isShared }
    byCategory[cat].gross += amount
    byCategory[cat].deductible += deductible
    byCategory[cat].count += 1
  }

  const totalGross = Object.values(byCategory).reduce((s, c) => s + c.gross, 0)
  const totalDeductible = Object.values(byCategory).reduce((s, c) => s + c.deductible, 0)
  const netIncome = totalRevenue - totalDeductible

  // Build rows
  const rows = [
    ['MI Little Care — Tax Year ' + year + ' Summary'],
    [],
    ['Provider:', profile.full_name || ''],
    ['Daycare Name:', profile.daycare_name || ''],
    ['Tax ID (EIN/SSN):', profile.tax_id || '(not entered)'],
    ['Generated:', new Date().toLocaleString('en-US')],
    [],
    ['INCOME (Schedule C, Line 1)'],
    ['Total Gross Receipts:', fmtMoney(totalRevenue)],
    ['# of paid invoices:', invoices.filter(i => Number(i.amount_paid) > 0).length],
    [],
    ['EXPENSES (Schedule C, Lines 8-27)'],
    ['Category', 'Receipt Count', 'Gross Total', 'T/S Applied?', 'Deductible Amount'],
  ]

  for (const [cat, info] of Object.entries(byCategory).sort((a, b) => b[1].deductible - a[1].deductible)) {
    rows.push([
      cat,
      info.count,
      fmtMoney(info.gross),
      info.isShared ? `Yes (${fmtPct(tsPercent)})` : 'No (100%)',
      fmtMoney(info.deductible),
    ])
  }
  rows.push(['', '', fmtMoney(totalGross), '', fmtMoney(totalDeductible)])
  rows.push([])

  rows.push(['NET INCOME ESTIMATE'])
  rows.push(['Total Income:', fmtMoney(totalRevenue)])
  rows.push(['Total Deductible Expenses:', fmtMoney(totalDeductible)])
  rows.push(['Estimated Net Income:', fmtMoney(netIncome)])
  rows.push([])

  rows.push(['T/S RATIO USED'])
  if (tsRatio) {
    rows.push(['Space %:', fmtPct(tsRatio.space_percent || 0)])
    rows.push(['Time %:', fmtPct(tsRatio.time_percent || 0)])
    rows.push(['T/S %:', fmtPct(tsRatio.ts_percent || 0)])
  } else {
    rows.push(['T/S Ratio:', '(not set up for this year)'])
  }
  rows.push([])

  rows.push(['DISCLAIMER'])
  rows.push(['MI Little Care provides record-keeping tools, not tax advice.'])
  rows.push(['Verify all amounts and consult a qualified tax professional before filing.'])
  rows.push(['T/S ratio and deductible calculations are estimates based on data you entered.'])

  return rows
}

function buildReceiptsSheet(data, year) {
  const { receipts, tsRatio } = data
  const tsPercent = tsRatio?.ts_percent || 0

  const rows = [[
    'Date',
    'Merchant',
    'Category',
    'Schedule C Line',
    'Gross Amount',
    'T/S Applied?',
    'Deductible Amount',
    'Notes',
    'Receipt ID',
  ]]

  for (const r of receipts) {
    const cat = r.category || 'Other'
    const amount = Number(r.total || r.amount || 0)
    const isShared = SHARED_EXPENSE_CATEGORIES.includes(cat)
    const deductible = isShared ? amount * tsPercent : amount
    const scheduleC = SCHEDULE_C_MAP[cat]?.label || 'Line 27a (Other expenses)'

    rows.push([
      fmtDate(r.date),
      r.merchant || '',
      cat,
      scheduleC,
      fmtMoney(amount),
      isShared ? `Yes (${fmtPct(tsPercent)})` : 'No',
      fmtMoney(deductible),
      r.notes || '',
      r.id,
    ])
  }

  // Total row
  if (receipts.length > 0) {
    const totalGross = receipts.reduce((s, r) => s + Number(r.total || r.amount || 0), 0)
    const totalDeductible = receipts.reduce((s, r) => {
      const cat = r.category || 'Other'
      const amount = Number(r.total || r.amount || 0)
      return s + (SHARED_EXPENSE_CATEGORIES.includes(cat) ? amount * tsPercent : amount)
    }, 0)
    rows.push([])
    rows.push(['', '', '', 'TOTALS:', fmtMoney(totalGross), '', fmtMoney(totalDeductible), '', ''])
  }

  return rows
}

function buildInvoicesSheet(data) {
  const { invoices } = data

  const rows = [[
    'Created',
    'Family',
    'Period',
    'Subtotal',
    'Late Fees',
    'Total',
    'Amount Paid',
    'Balance',
    'Status',
    'Paid Via',
    'Paid Date',
    'Invoice ID',
  ]]

  for (const i of invoices) {
    const familyName = i.families?.family_name || '(deleted family)'
    const total = Number(i.total || 0)
    const paid = Number(i.amount_paid || 0)
    const balance = total - paid

    rows.push([
      fmtDate(i.created_at),
      familyName,
      i.period_label || '',
      fmtMoney(i.subtotal || 0),
      fmtMoney(i.late_fees || 0),
      fmtMoney(total),
      fmtMoney(paid),
      fmtMoney(balance),
      i.status || '',
      i.paid_via || '',
      fmtDate(i.paid_at),
      i.id,
    ])
  }

  // Totals row
  if (invoices.length > 0) {
    const totalBilled = invoices.reduce((s, i) => s + Number(i.total || 0), 0)
    const totalPaid = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0)
    rows.push([])
    rows.push(['', '', 'TOTALS:', '', '', fmtMoney(totalBilled), fmtMoney(totalPaid), fmtMoney(totalBilled - totalPaid), '', '', '', ''])
  }

  return rows
}

function buildTSRatioSheet(data, year) {
  const { tsRatio, hourLogs } = data

  const rows = [
    [`T/S Ratio Calculation — ${year}`],
    [],
  ]

  if (!tsRatio) {
    rows.push(['(No T/S Ratio set up for this year)'])
    rows.push([])
    rows.push(['Without a T/S ratio, shared-expense receipts (utilities, repairs, insurance)'])
    rows.push(['are not adjusted. Consider setting one up via the T/S Ratio page.'])
    return rows
  }

  rows.push(['SPACE CALCULATION'])
  rows.push(['Total home square footage:', tsRatio.total_sqft || ''])
  rows.push(['Regular-use business sq ft:', tsRatio.regular_use_sqft || ''])
  rows.push(['Shared-use business sq ft:', tsRatio.shared_use_sqft || ''])
  rows.push(['Space %:', fmtPct(tsRatio.space_percent || 0)])
  rows.push([])

  rows.push(['TIME CALCULATION'])
  if (tsRatio.input_mode === 'weekly') {
    rows.push(['Hours per week:', tsRatio.hours_per_week || ''])
    rows.push(['Weeks per year:', tsRatio.weeks_per_year || ''])
    rows.push(['Total business hours:', (tsRatio.hours_per_week || 0) * (tsRatio.weeks_per_year || 0)])
  } else {
    rows.push(['Total hours logged:', hourLogs.length > 0 ? hourLogs.reduce((s, l) => s + Number(l.hours || 0), 0) : 0])
    rows.push(['Total log entries:', hourLogs.length])
  }
  rows.push(['Time %:', fmtPct(tsRatio.time_percent || 0)])
  rows.push([])

  rows.push(['T/S RATIO (Time × Space)'])
  rows.push(['Final T/S %:', fmtPct(tsRatio.ts_percent || 0)])
  rows.push([])

  rows.push(['IRS REFERENCE'])
  rows.push(['Form 8829 — Expenses for Business Use of Your Home'])
  rows.push(['Publication 587 — Business Use of Your Home (specifically for daycare)'])
  rows.push([])

  // Hour logs detail (if any)
  if (hourLogs.length > 0) {
    rows.push(['HOUR LOG DETAIL'])
    rows.push(['Date', 'Hours', 'Notes'])
    for (const log of hourLogs) {
      rows.push([fmtDate(log.date), Number(log.hours || 0), log.notes || ''])
    }
  }

  return rows
}

function buildScheduleCSheet(data, year) {
  const { invoices, receipts, tsRatio } = data
  const tsPercent = tsRatio?.ts_percent || 0

  // Group by Schedule C line
  const byLine = {}
  for (const r of receipts) {
    const cat = r.category || 'Other'
    const mapping = SCHEDULE_C_MAP[cat] || SCHEDULE_C_MAP['Other']
    const amount = Number(r.total || r.amount || 0)
    const isShared = SHARED_EXPENSE_CATEGORIES.includes(cat)
    const deductible = isShared ? amount * tsPercent : amount
    if (!byLine[mapping.label]) byLine[mapping.label] = 0
    byLine[mapping.label] += deductible
  }

  const totalRevenue = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0)
  const totalExpenses = Object.values(byLine).reduce((s, v) => s + v, 0)

  const rows = [
    [`Schedule C Summary — Tax Year ${year}`],
    [],
    ['IRS Form 1040, Schedule C — Profit or Loss from Business'],
    ['Use this as a starting point. Verify with your tax preparer.'],
    [],
    ['PART I — INCOME'],
    ['Line 1 — Gross receipts or sales:', fmtMoney(totalRevenue)],
    [],
    ['PART II — EXPENSES'],
  ]

  for (const [line, amount] of Object.entries(byLine).sort((a, b) => b[1] - a[1])) {
    rows.push([line, fmtMoney(amount)])
  }

  rows.push([])
  rows.push(['Line 28 — Total Expenses:', fmtMoney(totalExpenses)])
  rows.push([])
  rows.push(['Line 31 — Net Profit (Loss):', fmtMoney(totalRevenue - totalExpenses)])
  rows.push([])

  // Form 8829 summary if T/S ratio exists
  if (tsRatio) {
    rows.push(['FORM 8829 — Business Use of Home'])
    rows.push(['Space %:', fmtPct(tsRatio.space_percent || 0)])
    rows.push(['Time %:', fmtPct(tsRatio.time_percent || 0)])
    rows.push(['Combined T/S %:', fmtPct(tsRatio.ts_percent || 0)])
    rows.push(['(This % is applied to utilities, repairs, insurance — see Receipts tab)'])
    rows.push([])
  }

  rows.push(['IMPORTANT'])
  rows.push(['MI Little Care is not a tax advisor. This is a starting summary only.'])
  rows.push(['Mileage, depreciation, home depreciation, and other items are NOT included.'])
  rows.push(['Consult a qualified tax professional before filing.'])

  return rows
}

function buildFSAStatementsSheet(data, year) {
  const { invoices, families } = data

  // Group invoices by family
  const byFamily = {}
  for (const i of invoices) {
    if (Number(i.amount_paid || 0) <= 0) continue  // only paid
    const familyId = i.family_id
    const familyName = i.families?.family_name || '(unknown)'
    if (!byFamily[familyId]) {
      byFamily[familyId] = { name: familyName, total: 0, count: 0, payments: [] }
    }
    byFamily[familyId].total += Number(i.amount_paid || 0)
    byFamily[familyId].count += 1
    byFamily[familyId].payments.push({
      date: fmtDate(i.paid_at || i.created_at),
      amount: Number(i.amount_paid || 0),
      period: i.period_label || '',
    })
  }

  const rows = [
    [`FSA / Dependent Care Statements — ${year}`],
    [],
    ['Use this for IRS Form 2441 (Child and Dependent Care Expenses)'],
    ['Or for FSA / DCFSA reimbursement filings'],
    [],
  ]

  if (Object.keys(byFamily).length === 0) {
    rows.push(['(No paid invoices for this year)'])
    return rows
  }

  // Get provider tax ID for header
  const providerTaxId = data.profile?.tax_id || '(provide your Tax ID via Settings)'
  const providerName = data.profile?.daycare_name || data.profile?.full_name || 'MI Little Care provider'

  rows.push(['Provider Name / Daycare:', providerName])
  rows.push(['Provider Tax ID:', providerTaxId])
  rows.push([])

  // Per-family summary
  rows.push(['PER-FAMILY SUMMARY'])
  rows.push(['Family', '# Payments', 'Total Paid in ' + year])
  for (const f of Object.values(byFamily).sort((a, b) => b.total - a.total)) {
    rows.push([f.name, f.count, fmtMoney(f.total)])
  }
  rows.push([])

  // Detailed per-family
  for (const f of Object.values(byFamily).sort((a, b) => b.total - a.total)) {
    rows.push([])
    rows.push([`DETAIL — ${f.name}`])
    rows.push(['Date Paid', 'Period', 'Amount'])
    for (const p of f.payments.sort((a, b) => a.date.localeCompare(b.date))) {
      rows.push([p.date, p.period, fmtMoney(p.amount)])
    }
    rows.push(['', 'TOTAL:', fmtMoney(f.total)])
  }

  return rows
}

// ============================================================
// Set column widths intelligently
// ============================================================

function autoFitColumns(rows) {
  if (!rows || rows.length === 0) return []
  const cols = []
  const maxCol = Math.max(...rows.map(r => (r || []).length))
  for (let c = 0; c < maxCol; c++) {
    let max = 10
    for (const row of rows) {
      const val = row?.[c]
      if (val == null) continue
      const len = String(val).length
      if (len > max) max = len
    }
    cols.push({ wch: Math.min(max + 2, 50) })
  }
  return cols
}

// ============================================================
// Main export function
// ============================================================

export async function exportTaxData({ licenseeId, year, profileName }) {
  if (!licenseeId || !year) {
    throw new Error('licenseeId and year are required')
  }

  const data = await fetchAllTaxData(licenseeId, year)

  const wb = XLSX.utils.book_new()

  // Build each sheet
  const sheets = [
    { name: 'Summary',         rows: buildSummarySheet(data, year) },
    { name: 'Schedule C',      rows: buildScheduleCSheet(data, year) },
    { name: 'Receipts',        rows: buildReceiptsSheet(data, year) },
    { name: 'Invoices',        rows: buildInvoicesSheet(data) },
    { name: 'T-S Ratio',       rows: buildTSRatioSheet(data, year) },
    { name: 'FSA Statements',  rows: buildFSAStatementsSheet(data, year) },
  ]

  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows)
    ws['!cols'] = autoFitColumns(s.rows)
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }

  // Generate filename
  const safeName = (profileName || 'MI-Little-Care').replace(/[^a-z0-9]/gi, '-')
  const filename = `${safeName}_Tax_${year}.xlsx`

  XLSX.writeFile(wb, filename)

  return {
    filename,
    sheetCount: sheets.length,
    receiptCount: data.receipts.length,
    invoiceCount: data.invoices.length,
  }
}
