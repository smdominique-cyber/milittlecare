// I-Billing Transfer page (PR #9 orchestrator).
//
// The CDC I-Billing flow is a four-stage wizard:
//
//   1. PayPeriodPicker      — choose the period to transfer
//   2. ReviewGrid           — children × days; running totals;
//                             validation cells. Issue Resolution
//                             (Screen 3) opens as a modal from here.
//   3. ExportPanel          — download CSV + PDFs (Screen 4)
//   4. ReconcilePanel       — enter MDHHS confirmation #; lock the
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
import ReviewGrid from '@/components/iBilling/ReviewGrid'
import { todayYMD } from '@/lib/cdcPayPeriods'
import { runValidation } from '@/lib/iBilling'

// -----------------------------------------------------------------------------
// Stage IDs
// -----------------------------------------------------------------------------

export const STAGE = Object.freeze({
  PICK:      'pick',       // Screen 1
  REVIEW:    'review',     // Screen 2 (Screen 3 opens modally on top)
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

  // Initial (provider-scoped) data.
  const [catalog, setCatalog] = useState([])
  const [fundingSources, setFundingSources] = useState([])
  const [submittedNumbers, setSubmittedNumbers] = useState(new Set())
  const [profile, setProfile] = useState(null)
  const [allChildren, setAllChildren] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Period-scoped data (refetched when selectedPeriod changes).
  const [attendance, setAttendance] = useState([])
  const [fiscalYearAttendance, setFiscalYearAttendance] = useState([])
  const [acknowledgments, setAcknowledgments] = useState([])
  const [periodLoading, setPeriodLoading] = useState(false)
  const [periodError, setPeriodError] = useState(null)

  const today = useMemo(() => todayYMD(), [])

  // -- Initial load ----------------------------------------------------
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
      supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase.from('children').select('*').eq('user_id', user.id),
    ]).then(([catRes, fsRes, subRes, profRes, kidRes]) => {
      if (cancelled) return
      const firstErr = catRes.error || fsRes.error || subRes.error || profRes.error || kidRes.error
      if (firstErr) {
        console.error('IBillingPage initial load', firstErr)
        setError('Failed to load I-Billing data. Refresh and try again.')
      } else {
        setCatalog(catRes.data || [])
        setFundingSources(fsRes.data || [])
        setSubmittedNumbers(new Set((subRes.data || []).map(r => String(r.pay_period_number))))
        setProfile(profRes.data || null)
        setAllChildren(kidRes.data || [])
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [user])

  // -- Period-scoped load: attendance, FY attendance, acknowledgments -
  useEffect(() => {
    if (!user || !selectedPeriod) {
      setAttendance([])
      setFiscalYearAttendance([])
      setAcknowledgments([])
      return
    }
    let cancelled = false
    setPeriodLoading(true)
    setPeriodError(null)

    // Fiscal year starts Oct 1 of the year that contains the period.
    const fyStart = fiscalYearStart(selectedPeriod.start_date)

    Promise.all([
      supabase
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .gte('date', selectedPeriod.start_date)
        .lte('date', selectedPeriod.end_date),
      supabase
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .gte('date', fyStart)
        .lte('date', selectedPeriod.end_date),
      // Acknowledgments only exist after PR #12 merges in production —
      // the table will exist (migration 020 is live), but the row set
      // may be empty until parents start using the portal. Tolerate
      // failure quietly.
      tolerateMissingTable(
        supabase
          .from('attendance_acknowledgments')
          .select('*')
          .gte('date', selectedPeriod.start_date)
          .lte('date', selectedPeriod.end_date)
      ),
    ]).then(([attRes, fyRes, ackRes]) => {
      if (cancelled) return
      const firstErr = attRes.error || fyRes.error
      if (firstErr) {
        console.error('IBillingPage period load', firstErr)
        setPeriodError('Failed to load attendance for this period.')
      } else {
        setAttendance(attRes.data || [])
        setFiscalYearAttendance(fyRes.data || [])
        setAcknowledgments(ackRes?.data || [])
      }
    }).finally(() => {
      if (!cancelled) setPeriodLoading(false)
    })

    return () => { cancelled = true }
  }, [user, selectedPeriod])

  // -- Derived: validation issues -------------------------------------
  const issues = useMemo(() => {
    if (!selectedPeriod) return []
    return runValidation({
      payPeriod: selectedPeriod,
      attendance,
      children: allChildren,
      fundingSources,
      profile,
      acknowledgments,
      fiscalYearAttendance,
      today,
    })
  }, [selectedPeriod, attendance, allChildren, fundingSources, profile,
      acknowledgments, fiscalYearAttendance, today])

  // ---- Gates ---------------------------------------------------------
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

  function handleBackToPicker() {
    setStage(STAGE.PICK)
    setSelectedPeriod(null)
  }

  function handleAdvanceFromReview() {
    setStage(STAGE.EXPORT)
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

      {stage === STAGE.REVIEW && (
        <>
          {periodLoading && <p style={{ color: '#6b7280' }}>Loading attendance for this period…</p>}
          {periodError && <p role="alert" style={{ color: '#b91c1c' }}>{periodError}</p>}
          {!periodLoading && !periodError && (
            <ReviewGrid
              payPeriod={selectedPeriod}
              attendance={attendance}
              children={allChildren}
              fundingSources={fundingSources}
              issues={issues}
              onAdvance={handleAdvanceFromReview}
              onBack={handleBackToPicker}
              onOpenIssue={() => { /* Screen 3 wires this in the next commit */ }}
            />
          )}
        </>
      )}

      {(stage === STAGE.EXPORT || stage === STAGE.RECONCILE) && (
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
            The Export / Reconcile stages ship in the next commits on
            this branch.
          </p>
          <button type="button" onClick={() => setStage(STAGE.REVIEW)}
                  style={ghostButtonStyle}>
            Back to review
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
// Helpers
// -----------------------------------------------------------------------------

function fiscalYearStart(yyyymmdd) {
  // CDC fiscal year starts Oct 1.
  const [y, m] = String(yyyymmdd).split('-').map(Number)
  const fy = (m >= 10) ? y : y - 1
  return `${fy}-10-01`
}

/**
 * Wrap a Supabase query so a "relation does not exist" error resolves
 * to an empty data result rather than failing the page. Used for the
 * acknowledgments table when this branch is checked out independently
 * of PR #12 — PR #12 ships migration 020 that creates the table.
 */
async function tolerateMissingTable(queryPromise) {
  try {
    const res = await queryPromise
    if (res.error && /relation .* does not exist|42P01/.test(res.error.message || '')) {
      return { data: [], error: null }
    }
    return res
  } catch (e) {
    return { data: [], error: null }
  }
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
