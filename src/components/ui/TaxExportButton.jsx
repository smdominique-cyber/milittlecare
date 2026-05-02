import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { Download, Loader, AlertCircle, CheckCircle } from 'lucide-react'
import { exportTaxData } from '@/lib/taxExport'

export default function TaxExportButton({ year, label, fullWidth = false, className }) {
  const { user } = useAuth()
  const { licenseeId } = useRole()
  const [phase, setPhase] = useState('idle')  // idle | exporting | done | error
  const [error, setError] = useState(null)
  const [stats, setStats] = useState(null)

  const exportYear = year || new Date().getFullYear()

  const handleExport = async () => {
    if (!licenseeId) {
      setError('Not ready yet — try again in a second')
      setPhase('error')
      return
    }
    setPhase('exporting')
    setError(null)
    try {
      const profileName = user?.user_metadata?.daycare_name
        || user?.user_metadata?.full_name
        || user?.email?.split('@')[0]
        || 'MI-Little-Care'
      const result = await exportTaxData({
        licenseeId,
        year: exportYear,
        profileName,
      })
      setStats(result)
      setPhase('done')
      // Auto-reset after 4 seconds
      setTimeout(() => { setPhase('idle'); setStats(null) }, 4000)
    } catch (err) {
      console.error('Tax export failed:', err)
      setError(err.message || 'Export failed')
      setPhase('error')
      setTimeout(() => { setPhase('idle'); setError(null) }, 5000)
    }
  }

  const baseStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    background: phase === 'done' ? 'var(--clr-success, #4a9b6f)'
              : phase === 'error' ? 'var(--clr-error, #c0392b)'
              : 'var(--clr-sage-dark, #3e5849)',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--radius-md, 12px)',
    fontSize: '0.875rem',
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: phase === 'exporting' ? 'wait' : 'pointer',
    transition: 'all 0.2s',
    width: fullWidth ? '100%' : 'auto',
    justifyContent: 'center',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: fullWidth ? 'stretch' : 'flex-start' }}>
      <button
        type="button"
        onClick={handleExport}
        disabled={phase === 'exporting'}
        style={baseStyle}
        className={className}
      >
        {phase === 'exporting' && <><Loader size={14} className="spin" /> Building workbook…</>}
        {phase === 'done' && <><CheckCircle size={14} /> Downloaded</>}
        {phase === 'error' && <><AlertCircle size={14} /> {error}</>}
        {phase === 'idle' && <><Download size={14} /> {label || `Export ${exportYear} tax data`}</>}
      </button>

      {phase === 'done' && stats && (
        <div style={{
          fontSize: '0.75rem',
          color: 'var(--clr-ink-soft, #8a9281)',
          padding: '4px 8px',
        }}>
          {stats.filename} · {stats.receiptCount} receipts · {stats.invoiceCount} invoices · 6 tabs
        </div>
      )}
    </div>
  )
}
