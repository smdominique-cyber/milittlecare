import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'
import { Download, FileSpreadsheet, Calendar, Loader, AlertCircle, CheckCircle, FileText } from 'lucide-react'
import { exportTaxData } from '@/lib/taxExport'

export default function ReportsPage() {
  const { user } = useAuth()
  const { licenseeId } = useRole()
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [years, setYears] = useState([currentYear])
  const [exporting, setExporting] = useState(false)
  const [lastExport, setLastExport] = useState(null)
  const [error, setError] = useState(null)
  const [stats, setStats] = useState({ receipts: 0, invoices: 0, totalRevenue: 0, totalExpenses: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (licenseeId) loadAvailableYears()
  }, [licenseeId])

  useEffect(() => {
    if (licenseeId && year) loadStats()
  }, [licenseeId, year])

  async function loadAvailableYears() {
    // Find years with any data
    const [r, i] = await Promise.all([
      supabase.from('receipts').select('date').eq('user_id', licenseeId),
      supabase.from('invoices').select('created_at').eq('user_id', licenseeId),
    ])
    const yearsSet = new Set([currentYear])
    ;(r.data || []).forEach(rec => {
      if (rec.date) yearsSet.add(new Date(rec.date).getFullYear())
    })
    ;(i.data || []).forEach(inv => {
      if (inv.created_at) yearsSet.add(new Date(inv.created_at).getFullYear())
    })
    const arr = [...yearsSet].sort((a, b) => b - a)
    setYears(arr)
  }

  async function loadStats() {
    setLoading(true)
    const [r, i] = await Promise.all([
      supabase.from('receipts').select('total, amount, category')
        .eq('user_id', licenseeId)
        .gte('date', `${year}-01-01`).lte('date', `${year}-12-31`),
      supabase.from('invoices').select('total, amount_paid')
        .eq('user_id', licenseeId)
        .gte('created_at', `${year}-01-01`).lte('created_at', `${year}-12-31T23:59:59`),
    ])
    const receipts = r.data || []
    const invoices = i.data || []
    const totalExpenses = receipts.reduce((s, rec) => s + Number(rec.total || rec.amount || 0), 0)
    const totalRevenue = invoices.reduce((s, inv) => s + Number(inv.amount_paid || 0), 0)
    setStats({
      receipts: receipts.length,
      invoices: invoices.length,
      totalRevenue,
      totalExpenses,
    })
    setLoading(false)
  }

  const handleExport = async () => {
    setExporting(true)
    setError(null)
    setLastExport(null)
    try {
      const profileName = user?.user_metadata?.daycare_name
        || user?.user_metadata?.full_name
        || user?.email?.split('@')[0]
        || 'MI-Little-Care'
      const result = await exportTaxData({ licenseeId, year, profileName })
      setLastExport(result.filename)
    } catch (err) {
      setError(err?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={{
        background: 'linear-gradient(135deg, #3e5849 0%, #5d7a6c 100%)',
        color: 'white',
        padding: 'var(--space-6)',
        borderRadius: 'var(--radius-lg)',
        marginBottom: 'var(--space-5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <FileSpreadsheet size={24} />
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.5rem',
            fontWeight: 400,
            margin: 0,
            letterSpacing: '-0.02em',
          }}>
            Tax & Income Reports
          </h2>
        </div>
        <p style={{ margin: 0, opacity: 0.9, fontSize: '0.9375rem', lineHeight: 1.5 }}>
          Export your full tax year as an Excel workbook. Includes receipts, invoices, T/S ratio calculation, Schedule C summary, and FSA statements for parents.
        </p>
      </div>

      {/* Year picker */}
      <div style={{
        background: 'white',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'var(--space-4)' }}>
          <Calendar size={18} style={{ color: 'var(--clr-sage-dark)' }} />
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.0625rem',
            fontWeight: 500,
            margin: 0,
            color: 'var(--clr-ink)',
          }}>
            Choose tax year
          </h3>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
          {years.map(y => (
            <button
              key={y}
              onClick={() => setYear(y)}
              style={{
                padding: '10px 18px',
                background: y === year ? 'var(--clr-sage-dark)' : 'var(--clr-cream)',
                color: y === year ? 'white' : 'var(--clr-ink)',
                border: y === year ? '1px solid var(--clr-sage-dark)' : '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.9375rem',
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              {y}
            </button>
          ))}
        </div>

        {/* Stats for selected year */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-4)', color: 'var(--clr-ink-soft)' }}>
            <Loader size={18} className="spin" />
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 12,
            marginBottom: 'var(--space-4)',
          }}>
            <StatCard label="Revenue collected" value={`$${stats.totalRevenue.toFixed(2)}`} />
            <StatCard label="Expenses tracked" value={`$${stats.totalExpenses.toFixed(2)}`} />
            <StatCard label="Receipts" value={stats.receipts} />
            <StatCard label="Invoices" value={stats.invoices} />
          </div>
        )}

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={exporting || (stats.receipts === 0 && stats.invoices === 0)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '14px 20px',
            background: stats.receipts === 0 && stats.invoices === 0 ? 'var(--clr-warm-mid)' : 'var(--clr-sage-dark)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.9375rem',
            fontWeight: 500,
            cursor: stats.receipts === 0 && stats.invoices === 0 ? 'not-allowed' : 'pointer',
            opacity: exporting ? 0.7 : 1,
            fontFamily: 'inherit',
          }}
        >
          {exporting ? (
            <><Loader size={16} className="spin" /> Building Excel workbook…</>
          ) : (stats.receipts === 0 && stats.invoices === 0) ? (
            <>No data for {year} yet</>
          ) : (
            <><Download size={16} /> Download {year} tax data (Excel)</>
          )}
        </button>

        {error && (
          <div style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'var(--clr-error-pale, rgba(192,57,43,0.1))',
            color: 'var(--clr-error, #c0392b)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {lastExport && !error && (
          <div style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'var(--clr-success-pale, rgba(74,155,111,0.1))',
            color: 'var(--clr-success, #4a9b6f)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <CheckCircle size={14} /> Downloaded: {lastExport}
          </div>
        )}
      </div>

      {/* What's included */}
      <div style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-4)',
      }}>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.0625rem',
          fontWeight: 500,
          margin: '0 0 var(--space-3)',
          color: 'var(--clr-ink)',
        }}>
          What's in the workbook
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Tab num="1" name="Summary" desc="One-pager: revenue, expenses, T/S ratio, net deductible" />
          <Tab num="2" name="Receipts" desc="Every receipt with category, Schedule C line, and T/S adjustment" />
          <Tab num="3" name="Invoices" desc="Every invoice with amount billed, paid, outstanding" />
          <Tab num="4" name="T/S Ratio" desc="Your time/space calculation (Form 8829 reference)" />
          <Tab num="5" name="Schedule C Summary" desc="IRS-ready expense breakdown by Schedule C line" />
          <Tab num="6" name="FSA Statements" desc="Per-family, what each parent paid (for Form 2441)" />
        </div>
      </div>

      <div style={{
        padding: '12px 14px',
        background: 'var(--clr-cream)',
        borderLeft: '3px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '0.78125rem',
        color: 'var(--clr-ink-soft)',
        lineHeight: 1.5,
      }}>
        <strong>Tax note:</strong> MI Little Care provides record-keeping tools, not tax advice. The Schedule C mappings and T/S calculations are aids to organize your data — consult a qualified tax professional before filing.
      </div>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div style={{
      background: 'var(--clr-cream)',
      padding: '10px 14px',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--clr-ink)' }}>{value}</div>
    </div>
  )
}

function Tab({ num, name, desc }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        flexShrink: 0,
        width: 28,
        height: 28,
        background: 'var(--clr-sage-pale)',
        color: 'var(--clr-sage-dark)',
        borderRadius: 'var(--radius-sm)',
        display: 'grid',
        placeItems: 'center',
        fontSize: '0.8125rem',
        fontWeight: 600,
      }}>
        {num}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: 'var(--clr-ink)', fontSize: '0.9375rem', marginBottom: 2 }}>{name}</div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.4 }}>{desc}</div>
      </div>
    </div>
  )
}
