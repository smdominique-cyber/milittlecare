// I-Billing Transfer page (PR #9 orchestrator).
//
// The CDC I-Billing flow is a five-stage wizard:
//
//   1. PayPeriodPicker      — choose the period to transfer
//   2. ReviewGrid           — children × days; running totals;
//                             validation cells (Screen 2)
//   3. IssueResolutionModal — modal opened from Screen 2 (Screen 3)
//   4. ExportPanel          — download CSV + PDFs (Screen 4)
//   5. ReconcilePanel       — enter MDHHS confirmation #; lock the
//                             period (Screen 5)
//
// Each stage is its own component under src/components/iBilling/. This
// page is the state machine: it owns the loaded data, the currently
// active stage, and the per-stage callbacks.
//
// Module gate (spec § 5): only providers with the CDC module active see
// this route. A provider without it lands on /dashboard via the same
// pattern used by CdcPayPeriodsPage.

import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useActiveModules } from '@/hooks/useActiveModules'
import { MODULE_KEYS } from '@/lib/modules'
import PayPeriodPicker from '@/components/iBilling/PayPeriodPicker'
import { todayYMD } from '@/lib/cdcPayPeriods'

// -----------------------------------------------------------------------------
// Stage IDs
// -----------------------------------------------------------------------------

export const STAGE = Object.freeze({
  PICK:      'pick',       // Screen 1
  REVIEW:    'review',     // Screen 2 (Screen 3 is a modal inside it)
  EXPORT:    'export',     // Screen 4
  RECONCILE: 'reconcile',  // Screen 5
})

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function IBillingPage() {
  const { user } = useAuth()
  const { modules, loading: modulesLoading } = useActiveModules()

  // Stage machine.
  const [stage, setStage] = useState(STAGE.PICK)
  const [selectedPeriod, setSelectedPeriod] = useState(null)

  // Loaded data — populated on mount; refreshed when selectedPeriod
  // changes (the screens use the same slice; the orchestrator owns it).
  const [catalog, setCatalog] = useState([])
  const [fundingSources, setFundingSources] = useState([])
  const [submittedNumbers, setSubmittedNumbers] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const today = useMemo(() => todayYMD(), [])

  // Initial load: catalog + funding sources + prior submissions.
  // Hook runs unconditionally; user check happens inside.
  useEffect(() => {
    if (!user) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      supabase.from('cdc_pay_period_catalog').select('*'),
      supabase.from('funding_sources').select('*').eq('user_id', user.id),
      supabase
        .from('cdc_billing_submissions')
        .select('pay_period_number')
        .eq('provider_id', user.id),
    ]).then(([catRes, fsRes, subRes]) => {
      if (cancelled) return
      const firstErr = catRes.error || fsRes.error || subRes.error
      if (firstErr) {
        console.error('IBillingPage initial load', firstErr)
        setError('Failed to load I-Billing data. Refresh and try again.')
      } else {
        setCatalog(catRes.data || [])
        setFundingSources(fsRes.data || [])
        setSubmittedNumbers(new Set((subRes.data || []).map(r => String(r.pay_period_number))))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [user])

  // ---- Gates (hooks must run above this line) --------------------------
  if (modulesLoading) {
    return (
      <div style={pageStyle}>
        <p style={{ color: '#6b7280' }}>Loading…</p>
      </div>
    )
  }
  if (!modules.has(MODULE_KEYS.CDC)) {
    return <Navigate to="/dashboard" replace />
  }

  // ---- Handlers ------------------------------------------------------
  function handlePickPeriod(period) {
    setSelectedPeriod(period)
    setStage(STAGE.REVIEW)
  }

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={{ fontSize: 24, margin: 0 }}>CDC I-Billing Transfer</h1>
        <StageIndicator stage={stage} />
      </header>

      {stage === STAGE.PICK && (
        <PayPeriodPicker
          catalog={catalog}
          fundingSources={fundingSources}
          today={today}
          loading={loading}
          error={error}
          alreadySubmittedNumbers={submittedNumbers}
          onSelectPeriod={handlePickPeriod}
        />
      )}

      {stage !== STAGE.PICK && (
        <div style={{ marginTop: 24, padding: 24, background: '#f9fafb',
                      border: '1px dashed #d1d5db', borderRadius: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            Next stage: {stage}
          </h2>
          <p style={{ margin: '8px 0 16px 0', color: '#4b5563' }}>
            Selected period: <strong>
              Period {selectedPeriod?.period_number}
              {' '}({selectedPeriod?.start_date} → {selectedPeriod?.end_date})
            </strong>.
            The Review / Export / Reconcile stages ship in the next
            commits on this branch.
          </p>
          <button type="button" onClick={() => setStage(STAGE.PICK)}
                  style={ghostButtonStyle}>
            Back to picker
          </button>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Stage indicator
// -----------------------------------------------------------------------------

function StageIndicator({ stage }) {
  const stages = [
    { id: STAGE.PICK,      label: '1 · Pick' },
    { id: STAGE.REVIEW,    label: '2 · Review' },
    { id: STAGE.EXPORT,    label: '3 · Export' },
    { id: STAGE.RECONCILE, label: '4 · Reconcile' },
  ]
  return (
    <ol aria-label="I-Billing stage progress" style={stageIndicatorStyle}>
      {stages.map(s => (
        <li key={s.id} style={{
          ...stageItemStyle,
          fontWeight: s.id === stage ? 700 : 500,
          color:      s.id === stage ? '#0f172a' : '#9ca3af',
        }}>
          {s.label}
        </li>
      ))}
    </ol>
  )
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle = {
  padding: 24,
  maxWidth: 1100,
  margin: '0 auto',
}

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 16,
  marginBottom: 24,
}

const stageIndicatorStyle = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  gap: 16,
  fontSize: 14,
}

const stageItemStyle = {
  padding: '4px 10px',
  background: '#f3f4f6',
  borderRadius: 12,
}

const ghostButtonStyle = {
  background: 'transparent',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 14,
}
