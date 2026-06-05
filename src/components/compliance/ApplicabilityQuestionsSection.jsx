// Compliance Engine Phase 3 — Business Info "What applies to my program?"
// section.
//
// Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md §3.
//
// Renders one question per provider-declared registry row (rows with
// `applicability.autoDefault === APPLICABILITY_RESULT.UNKNOWN`). The
// question list is REGISTRY-DRIVEN — future registry additions with
// the same shape automatically appear here without a UI code change.
//
// §2a invariant — load-bearing for this surface:
//
//   - "Yes" → writes a `mode = 'applies'` row.
//   - "No"  → writes a `mode = 'does_not_apply'` row.
//   - "Skip — ask me later" → archives the active row (or no-op when
//                             no row exists). The engine then falls
//                             back to the registry's autoDefault,
//                             which is 'unknown' for every row this
//                             surface asks about.
//
//   "Skip" NEVER produces a 'does_not_apply' row. The §2a principle is
//   that the engine only silently resolves to N/A when it can
//   AFFIRMATIVELY determine it. A "skip" click is "I haven't answered
//   yet" — not "no, it doesn't apply." Producing a does_not_apply row
//   on Skip would manufacture the silent compliance gap §2a prevents.
//
// Surface gating: caller (BusinessInfoPage) must gate this section
// behind `license_type IN ('family_home', 'group_home')`. LEPs see
// no compliance UI per modules.js + CLAUDE.md.

import { useEffect, useId, useState } from 'react'
import { Info, Save, Check } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  listProviderDeclaredApplicabilityRequirements,
  APPLICABILITY_RESULT,
} from '@/lib/complianceState'
import {
  loadApplicabilityOverrides,
  setApplicabilityOverride,
} from '@/lib/complianceStateLoader'

/**
 * Human-readable copy per registry requirement_key. Kept in the UI
 * layer (not the registry) so the engine stays pure and free of
 * presentation strings. Future registry additions with
 * `autoDefault: UNKNOWN` should add an entry here; if missing, the
 * UI falls back to a generic "Does this apply to your home?" prompt
 * with the requirement's `rule_citation` as context.
 */
const QUESTION_COPY = Object.freeze({
  consent_transportation_routine_annual: {
    question: 'Do you routinely transport children?',
    why:
      "Routine transportation means same day, time, and destination weekly — " +
      "e.g., regular shuttle to a school. R 400.1952(1)(a) requires an annual " +
      "parent permission for each child you routinely transport.",
    no_caveat:
      'If you occasionally transport for a one-off field trip or outing, that ' +
      'still needs a per-trip permission — but it does not make "routine ' +
      'transportation" apply.',
  },
  consent_water_activities_on_premises_seasonal: {
    question: 'Do you have a pool, kiddie pool, or other water feature on your premises?',
    why:
      "R 400.1934(10)(b) requires a seasonal parent permission for water " +
      "activities on the premises. R 400.1901(1)(yy) EXCLUDES casual water — " +
      "water-tables, slip-and-slides, wading pools, and sprinklers do NOT " +
      "count. Answer 'Yes' only if you have a qualifying water feature.",
    no_caveat: null,
  },
  property_animal_notification: {
    question: 'Do you have any animals on the premises?',
    why:
      "R 400.1937 requires per-family notification when a pet or other " +
      "animal is present where children are in care. The notification record " +
      "itself is tracked in a future build (PR #21); answering here pre-" +
      "resolves the applicability so the right record type appears when the " +
      "substrate ships.",
    no_caveat: null,
  },
})

function fallbackCopy(req) {
  return {
    question: `Does this apply to your program? — ${req.label || req.key}`,
    why: req.rule_citation
      ? `${req.rule_citation} — answer to surface or hide this requirement on your Compliance checklist.`
      : 'Answer to surface or hide this requirement on your Compliance checklist.',
    no_caveat: null,
  }
}

const ANSWER = Object.freeze({
  YES:  'yes',
  NO:   'no',
  SKIP: 'skip',
})

function modeFromAnswer(answer) {
  if (answer === ANSWER.YES) return APPLICABILITY_RESULT.APPLIES
  if (answer === ANSWER.NO)  return APPLICABILITY_RESULT.DOES_NOT_APPLY
  // SKIP — null means "archive the active row, fall back to autoDefault."
  // CRITICAL: do NOT translate SKIP to 'does_not_apply' — that would
  // violate §2a.
  return null
}

function answerFromOverrideMode(mode) {
  if (mode === APPLICABILITY_RESULT.APPLIES) return ANSWER.YES
  if (mode === APPLICABILITY_RESULT.DOES_NOT_APPLY) return ANSWER.NO
  return ANSWER.SKIP   // includes "no row" case
}

export default function ApplicabilityQuestionsSection({ providerId }) {
  const headingId = useId()
  const [requirements, setRequirements] = useState([])
  const [answers, setAnswers] = useState({})   // { [requirement_key]: ANSWER.* }
  const [savedAnswers, setSavedAnswers] = useState({})  // baseline for "dirty"
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  // Phase 3 decision #8 opt-in toggle. Stored in
  // profiles.program_settings.compliance_checklist_enabled. Absent
  // key = OFF (the rollout default for existing providers). The
  // Sidebar's "Compliance Checklist" item + the per-family
  // Compliance tab both read this flag.
  const [checklistEnabled, setChecklistEnabled] = useState(false)
  const [togglesaving, setToggleSaving] = useState(false)

  useEffect(() => {
    const reqs = listProviderDeclaredApplicabilityRequirements()
    setRequirements(reqs)
  }, [])

  useEffect(() => {
    if (!providerId) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      // Parallel: applicability overrides + the opt-in flag.
      const [overrides, profileResp] = await Promise.all([
        loadApplicabilityOverrides({ providerId }),
        supabase
          .from('profiles')
          .select('program_settings')
          .eq('id', providerId)
          .maybeSingle(),
      ])
      if (cancelled) return
      const next = {}
      for (const req of listProviderDeclaredApplicabilityRequirements()) {
        next[req.key] = answerFromOverrideMode(overrides.get(req.key))
      }
      setAnswers(next)
      setSavedAnswers(next)
      const flag = profileResp?.data?.program_settings?.compliance_checklist_enabled === true
      setChecklistEnabled(flag)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [providerId])

  async function toggleChecklist(next) {
    if (!providerId) return
    setToggleSaving(true)
    setError(null)
    try {
      // Read-modify-write the JSONB blob. The blob is small (single-
      // digit keys), and the race-window risk is negligible — this is
      // a settings toggle one user clicks.
      const { data: row, error: readErr } = await supabase
        .from('profiles')
        .select('program_settings')
        .eq('id', providerId)
        .maybeSingle()
      if (readErr) throw readErr
      const settings = (row && row.program_settings) || {}
      settings.compliance_checklist_enabled = next === true
      const { error: writeErr } = await supabase
        .from('profiles')
        .update({ program_settings: settings })
        .eq('id', providerId)
      if (writeErr) throw writeErr
      setChecklistEnabled(next === true)
    } catch (err) {
      setError(err?.message || 'Save failed')
    } finally {
      setToggleSaving(false)
    }
  }

  const isDirty = Object.keys(answers).some(k => answers[k] !== savedAnswers[k])

  async function handleSave() {
    if (!providerId) return
    setSaving(true)
    setError(null)
    try {
      // Write only the answers that actually changed. Each write is
      // archive-then-insert via setApplicabilityOverride; no batch
      // mutation primitive on the table.
      for (const req of requirements) {
        if (answers[req.key] === savedAnswers[req.key]) continue
        const mode = modeFromAnswer(answers[req.key])
        const resp = await setApplicabilityOverride({
          providerId,
          requirementKey: req.key,
          mode,
        })
        if (!resp.ok) {
          throw resp.error || new Error('Save failed')
        }
      }
      setSavedAnswers({ ...answers })
      setSavedAt(new Date())
    } catch (err) {
      setError(err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="bi-section">
        <div className="bi-section-header">
          <h3 id={headingId}>What applies to my program?</h3>
          <p>Loading your answers…</p>
        </div>
      </div>
    )
  }

  if (requirements.length === 0) {
    // Defensive: the registry currently has 3 such rows. If the count
    // ever goes to zero (rare; would mean a future registry change),
    // the section just hides — no broken UI.
    return null
  }

  return (
    <div className="bi-section" role="region" aria-labelledby={headingId}>
      <div className="bi-section-header">
        <h3 id={headingId}>What applies to my program?</h3>
        <p>
          These answers shape which compliance items you see on the
          Compliance checklist. You can change them anytime.
        </p>
      </div>

      {error && (
        <div className="bi-message error" role="alert">
          {error}
        </div>
      )}

      {/* Phase 3 decision #8 — opt-in toggle. Default OFF for existing
          providers during rollout. The toggle controls the "Compliance
          Checklist" sidebar entry + the per-family Compliance tab in
          Families. Independent of the applicability answers below
          (those always save). */}
      <div
        style={{
          background: 'var(--clr-cream, #faf5e8)',
          border: '1px solid var(--clr-warm-mid, #ddc8a4)',
          borderRadius: 'var(--radius-md, 8px)',
          padding: 'var(--space-3, 12px) var(--space-4, 16px)',
          marginBottom: 'var(--space-4, 16px)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3, 12px)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 280px' }}>
          <div style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>
            Show the Compliance Checklist
          </div>
          <div style={{
            color: 'var(--clr-ink-mid)',
            fontSize: '0.8125rem',
            marginTop: 2,
            lineHeight: 1.5,
          }}>
            Adds a “Compliance Checklist” sidebar item plus a per-family
            Compliance tab. Read-only summary of what&rsquo;s on file,
            what&rsquo;s missing, and what still needs your input.
            Independent of the applicability answers below.
          </div>
        </div>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            cursor: togglesaving ? 'progress' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={checklistEnabled}
            disabled={togglesaving}
            onChange={(e) => toggleChecklist(e.target.checked)}
            aria-label="Show the Compliance Checklist"
          />
          <span style={{ fontSize: '0.9375rem' }}>
            {checklistEnabled ? 'On' : 'Off'}
            {togglesaving && '…'}
          </span>
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {requirements.map(req => {
          const copy = QUESTION_COPY[req.key] || fallbackCopy(req)
          const value = answers[req.key] || ANSWER.SKIP
          return (
            <fieldset
              key={req.key}
              style={{
                border: '1px solid var(--clr-border, #e0d7c4)',
                borderRadius: 'var(--radius-md, 8px)',
                padding: 'var(--space-3, 12px) var(--space-4, 16px)',
                margin: 0,
              }}
            >
              <legend style={{
                fontWeight: 600,
                color: 'var(--clr-ink)',
                padding: '0 var(--space-2, 8px)',
              }}>
                {copy.question}
              </legend>
              <p style={{
                color: 'var(--clr-ink-mid)',
                fontSize: '0.875rem',
                margin: 'var(--space-2, 8px) 0 var(--space-3, 12px)',
                lineHeight: 1.5,
              }}>
                <Info size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                {copy.why}
              </p>
              {copy.no_caveat && (
                <p style={{
                  color: 'var(--clr-ink-soft, #7a705a)',
                  fontSize: '0.8125rem',
                  margin: '0 0 var(--space-3, 12px)',
                  lineHeight: 1.5,
                  fontStyle: 'italic',
                }}>
                  {copy.no_caveat}
                </p>
              )}
              <div style={{ display: 'flex', gap: 'var(--space-3, 12px)', flexWrap: 'wrap' }}>
                {[
                  { value: ANSWER.YES,  label: 'Yes' },
                  { value: ANSWER.NO,   label: 'No' },
                  { value: ANSWER.SKIP, label: 'Skip — ask me later' },
                ].map(opt => (
                  <label
                    key={opt.value}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      fontSize: '0.9375rem',
                    }}
                  >
                    <input
                      type="radio"
                      name={`applicability-${req.key}`}
                      value={opt.value}
                      checked={value === opt.value}
                      onChange={() => setAnswers(a => ({ ...a, [req.key]: opt.value }))}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <p style={{
                color: 'var(--clr-ink-soft, #7a705a)',
                fontSize: '0.75rem',
                margin: 'var(--space-2, 8px) 0 0',
              }}>
                {req.rule_citation}
              </p>
            </fieldset>
          )
        })}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3, 12px)',
        marginTop: 'var(--space-4, 16px)',
      }}>
        <button
          className="bi-save-btn"
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          <Save size={14} /> {saving ? 'Saving…' : 'Save answers'}
        </button>
        {!isDirty && savedAt && (
          <span style={{ color: 'var(--clr-sage-dark)', fontSize: '0.8125rem' }}>
            <Check size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Saved {savedAt.toLocaleTimeString()}
          </span>
        )}
      </div>

      <p style={{
        color: 'var(--clr-ink-soft, #7a705a)',
        fontSize: '0.8125rem',
        marginTop: 'var(--space-4, 16px)',
        lineHeight: 1.5,
        borderTop: '1px solid var(--clr-border, #e0d7c4)',
        paddingTop: 'var(--space-3, 12px)',
      }}>
        <strong>Why "Skip" is different from "No":</strong> "Skip" leaves the
        question open — your Compliance checklist will keep showing the
        related requirement as "Tell us about this." "No" affirmatively
        marks the requirement as not applicable to your program. The
        difference matters at audit time: an auditor sees "not applicable"
        as an answer; an unanswered question is open.
      </p>
    </div>
  )
}
