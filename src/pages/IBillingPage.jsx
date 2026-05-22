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
import IssueResolutionModal, { buildOverrideIndex, issueMatchKey } from '@/components/iBilling/IssueResolutionModal'
import ExportPanel from '@/components/iBilling/ExportPanel'
import ReconcilePanel from '@/components/iBilling/ReconcilePanel'
import { todayYMD } from '@/lib/cdcPayPeriods'
import { runValidation } from '@/lib/iBilling'
import { computeAttendanceHash } from '@/lib/parentAcknowledgment'

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
  const [overrides, setOverrides] = useState([])
  const [existingSubmission, setExistingSubmission] = useState(null)
  const [periodLoading, setPeriodLoading] = useState(false)
  const [periodError, setPeriodError] = useState(null)

  // Screen 3 modal state.
  const [issueModalOpen, setIssueModalOpen] = useState(false)
  const [initialIssue, setInitialIssue] = useState(null)
  const [filterChildId, setFilterChildId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

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
      supabase
        .from('attendance_validation_overrides')
        .select('*')
        .eq('provider_id', user.id)
        .eq('pay_period_number', String(selectedPeriod.period_number)),
      supabase
        .from('cdc_billing_submissions')
        .select('*')
        .eq('provider_id', user.id)
        .eq('pay_period_number', String(selectedPeriod.period_number))
        .maybeSingle(),
    ]).then(([attRes, fyRes, ackRes, ovRes, subRes]) => {
      if (cancelled) return
      const firstErr = attRes.error || fyRes.error || ovRes?.error || subRes?.error
      if (firstErr) {
        console.error('IBillingPage period load', firstErr)
        setPeriodError('Failed to load attendance for this period.')
      } else {
        setAttendance(attRes.data || [])
        setFiscalYearAttendance(fyRes.data || [])
        setAcknowledgments(ackRes?.data || [])
        setOverrides(ovRes?.data || [])
        setExistingSubmission(subRes?.data || null)
      }
    }).finally(() => {
      if (!cancelled) setPeriodLoading(false)
    })

    return () => { cancelled = true }
  }, [user, selectedPeriod, refreshKey])

  // -- Derived: validation issues -------------------------------------
  const allIssues = useMemo(() => {
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

  // Filter out issues that the provider has explicitly overridden for
  // this period; the audit row stays for compliance, the cell stops
  // blocking the export.
  const overrideIndex = useMemo(() => buildOverrideIndex(overrides), [overrides])
  const issues = useMemo(
    () => allIssues.filter(i => !overrideIndex.has(matchKeyForIssue(i))),
    [allIssues, overrideIndex]
  )
  const overriddenIssues = useMemo(
    () => allIssues.filter(i => overrideIndex.has(matchKeyForIssue(i))),
    [allIssues, overrideIndex]
  )

  // Sanity-check summary at the top of the export panel.
  const { totalBillableHours, totalBilledDays } = useMemo(() => {
    let h = 0
    const days = new Set()
    for (const r of attendance) {
      if (!r || r.status !== 'present') continue
      const inH = parseTimeToHoursLocal(r.check_in)
      const outH = parseTimeToHoursLocal(r.check_out)
      if (inH == null || outH == null) continue
      const diff = outH - inH
      if (diff > 0) {
        h += diff
        days.add(r.date)
      }
    }
    return { totalBillableHours: h, totalBilledDays: days.size }
  }, [attendance])

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

  function handleOpenIssue(issue) {
    setFilterChildId(null)      // cell click shows all issues (highlights this one)
    setInitialIssue(issue || null)
    setIssueModalOpen(true)
  }

  function handleOpenChildIssues(childId) {
    setFilterChildId(childId || null)
    setInitialIssue(null)
    setIssueModalOpen(true)
  }

  function handleCloseIssueModal() {
    setIssueModalOpen(false)
    setInitialIssue(null)
    setFilterChildId(null)
  }

  // -- Issue resolution mutations -------------------------------------

  async function handleApplyFix(issue) {
    const action = issue?.proposedFix?.action
    if (!action || !user) return
    if (action.kind === 'remove_segment') {
      const { error } = await supabase
        .from('attendance').delete().eq('id', action.attendanceId)
      if (error) throw error
    } else if (action.kind === 'split_at_midnight') {
      const original = attendance.find(a => a.id === action.attendanceId)
      if (!original) throw new Error('Segment not found.')
      // Original day: check_in → 23:59 (segment_index stays).
      // Next day:   00:00 → original check_out (new segment_index 0).
      const nextDate = nextDayYMD(original.date)
      const { error: e1 } = await supabase
        .from('attendance').update({ check_out: '23:59' })
        .eq('id', action.attendanceId)
      if (e1) throw e1
      // Determine the next-day's max segment_index (multi-segment safe).
      const { data: existing } = await supabase
        .from('attendance').select('segment_index')
        .eq('child_id', original.child_id).eq('date', nextDate)
      const nextSeg = existing && existing.length
        ? Math.max(...existing.map(r => r.segment_index ?? 0)) + 1
        : 0
      const { error: e2 } = await supabase
        .from('attendance').insert({
          user_id: original.user_id,
          child_id: original.child_id,
          date: nextDate,
          segment_index: nextSeg,
          status: 'present',
          check_in: '00:00',
          check_out: original.check_out,
        })
      if (e2) throw e2
    } else if (action.kind === 'trim_school_hours') {
      const original = attendance.find(a => a.id === action.attendanceId)
      if (!original) throw new Error('Segment not found.')
      // Three possibilities (handled minimally for V1):
      //   - segment fully inside school hours → delete it
      //   - starts before school, ends during  → trim end to schoolStart
      //   - starts during, ends after school   → trim start to schoolEnd
      //   - brackets school entirely           → V1: split into two
      //     segments (before + after). Same multi-segment helper.
      const segStart = original.check_in
      const segEnd   = original.check_out
      const sStart   = action.schoolStart
      const sEnd     = action.schoolEnd
      if (segStart >= sStart && segEnd <= sEnd) {
        const { error } = await supabase
          .from('attendance').delete().eq('id', action.attendanceId)
        if (error) throw error
      } else if (segStart < sStart && segEnd <= sEnd) {
        const { error } = await supabase
          .from('attendance').update({ check_out: sStart })
          .eq('id', action.attendanceId)
        if (error) throw error
      } else if (segStart >= sStart && segEnd > sEnd) {
        const { error } = await supabase
          .from('attendance').update({ check_in: sEnd })
          .eq('id', action.attendanceId)
        if (error) throw error
      } else {
        // brackets — trim original to before-school, insert after-school.
        const { error: e1 } = await supabase
          .from('attendance').update({ check_out: sStart })
          .eq('id', action.attendanceId)
        if (e1) throw e1
        const { data: existing } = await supabase
          .from('attendance').select('segment_index')
          .eq('child_id', original.child_id).eq('date', original.date)
        const nextSeg = existing && existing.length
          ? Math.max(...existing.map(r => r.segment_index ?? 0)) + 1
          : 0
        const { error: e2 } = await supabase
          .from('attendance').insert({
            user_id: original.user_id,
            child_id: original.child_id,
            date: original.date,
            segment_index: nextSeg,
            status: 'present',
            check_in: sEnd,
            check_out: segEnd,
          })
        if (e2) throw e2
      }
    } else if (action.kind === 'provider_override_acknowledgment') {
      // Write an acknowledgment row with acknowledged_via=provider_override.
      // The table only exists post-PR #12; until that branch merges, the
      // mutation will 42P01 — we surface that as a friendlier message.
      const rec = attendance.find(a => a.id === action.attendanceId)
      if (!rec) throw new Error('Segment not found.')
      const payload = {
        child_id: rec.child_id,
        date:     rec.date,
        segment_index: rec.segment_index ?? 0,
        acknowledged_at: new Date().toISOString(),
        acknowledged_via: 'provider_override',
        attendance_snapshot_hash: computeAttendanceHash(rec),
      }
      const { error } = await supabase
        .from('attendance_acknowledgments').insert(payload)
      if (error) {
        if (/42P01|does not exist/.test(error.message || '')) {
          throw new Error('Parent acknowledgment table is not yet live. Merge PR #12 first.')
        }
        throw error
      }
    } else {
      throw new Error(`Unknown fix action: ${action.kind}`)
    }
    setRefreshKey(k => k + 1)
  }

  async function handleSubmitReconcile(payload) {
    if (!user || !selectedPeriod) return
    const { data, error } = await supabase
      .from('cdc_billing_submissions').insert({
        provider_id:      user.id,
        pay_period_number: String(selectedPeriod.period_number),
        confirmation_number: payload.confirmation_number,
        submitted_at:     payload.submitted_at,
        total_billed_hours: payload.total_billed_hours,
        total_billed_amount_estimate: payload.total_billed_amount_estimate,
        attendance_snapshot_jsonb: {
          attendance,
          issues,
          overrides,
          generated_at: new Date().toISOString(),
        },
      }).select('*').single()
    if (error) throw error
    setExistingSubmission(data)
    // Roll the picker's "Already submitted" badge forward.
    setSubmittedNumbers(prev => new Set([...prev, String(selectedPeriod.period_number)]))
    return data
  }

  async function handleOverride(issue, reason) {
    if (!user || !selectedPeriod) return
    const { error } = await supabase
      .from('attendance_validation_overrides').insert({
        provider_id:      user.id,
        attendance_id:    issue?.proposedFix?.action?.attendanceId || null,
        child_id:         issue.childId || null,
        pay_period_number: String(selectedPeriod.period_number),
        rule_id:          issue.ruleId,
        rule_description: issue.message,
        override_reason:  reason,
      })
    if (error) throw error
    setRefreshKey(k => k + 1)
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
            <>
              <ReviewGrid
                payPeriod={selectedPeriod}
                attendance={attendance}
                children={allChildren}
                fundingSources={fundingSources}
                issues={issues}
                onAdvance={handleAdvanceFromReview}
                onBack={handleBackToPicker}
                onOpenIssue={handleOpenIssue}
                onOpenChildIssues={handleOpenChildIssues}
              />
              {issues.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <button type="button"
                          onClick={() => { setFilterChildId(null); setInitialIssue(null); setIssueModalOpen(true) }}
                          style={ghostButtonStyle}>
                    Resolve {issues.length} issue{issues.length === 1 ? '' : 's'} →
                  </button>
                </div>
              )}
              {issueModalOpen && (
                <IssueResolutionModal
                  issues={filterChildId ? issues.filter(i => i.childId === filterChildId) : issues}
                  children={allChildren}
                  filterChildName={filterChildId ? childDisplayName(allChildren, filterChildId) : null}
                  overridden={overriddenIssues.map(i => ({
                    rule_id: i.ruleId,
                    override_reason: overrideReasonFor(i, overrides),
                  }))}
                  initialIssue={initialIssue}
                  onApplyFix={handleApplyFix}
                  onOverride={handleOverride}
                  onClose={handleCloseIssueModal}
                />
              )}
            </>
          )}
        </>
      )}

      {stage === STAGE.EXPORT && (
        <ExportPanel
          payPeriod={selectedPeriod}
          attendance={attendance}
          children={allChildren}
          fundingSources={fundingSources}
          profile={profile}
          issues={issues}
          acknowledgments={acknowledgments}
          totalBillableHours={totalBillableHours}
          totalBilledDays={totalBilledDays}
          onBack={() => setStage(STAGE.REVIEW)}
          onAdvance={() => setStage(STAGE.RECONCILE)}
        />
      )}

      {stage === STAGE.RECONCILE && (
        <ReconcilePanel
          payPeriod={selectedPeriod}
          existingSubmission={existingSubmission}
          totalBillableHours={totalBillableHours}
          onSubmit={handleSubmitReconcile}
          onBack={() => setStage(STAGE.EXPORT)}
          onDone={handleBackToPicker}
        />
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

function nextDayYMD(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

function matchKeyForIssue(iss) {
  // Mirror IssueResolutionModal.issueMatchKey, but at the page level
  // we strip date+segment from the key so a rule-level override
  // (e.g. "Missing provider name") covers all derived issues.
  return [iss.ruleId || '', iss.childId || '', '', ''].join('|')
}

function parseTimeToHoursLocal(hms) {
  if (!hms) return null
  const parts = String(hms).split(':').map(Number)
  if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null
  const [h, m, s = 0] = parts
  return h + m / 60 + s / 3600
}

function childDisplayName(children, childId) {
  const c = (Array.isArray(children) ? children : []).find(x => x && x.id === childId)
  if (!c) return ''
  return `${c.first_name || ''} ${c.last_name || ''}`.trim() || childId
}

function overrideReasonFor(issue, overrides) {
  for (const o of overrides) {
    if (o.rule_id === issue.ruleId
        && (o.child_id || '') === (issue.childId || '')) {
      return o.override_reason
    }
  }
  return ''
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
