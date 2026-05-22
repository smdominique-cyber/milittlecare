// Provider-dashboard banner for the annual Dec 16 training deadline
// (PR #8.5c § Step 5). Self-loading: pass the user_id; the component
// gates on `profiles.is_license_exempt`, queries the source-of-truth
// `miregistry_training_entries` table (PR #4) for the current-year
// `annual_ongoing` completion, and renders the severity-tinted banner
// returned by `getAnnualTrainingDeadlineState`.
//
// Why the entries table, not `profiles.annual_training_completion_date`:
// the column was deprecated by PR #4 in favour of the entries
// transaction log — see docs/pr-8-5c-review.md § "Annual training
// completion source-of-truth (PR #4 deprecation honoured)." The
// compliance helper is parameter-named generically, so the caller
// computes `completedDate` directly from entries here. No change to
// src/lib/cdcProviderCompliance.js or its tests.

import { useEffect, useState } from 'react'
import { AlertCircle, CalendarCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { getAnnualTrainingDeadlineState } from '@/lib/cdcProviderCompliance'

const SEVERITY_STYLES = Object.freeze({
  info: {
    background: 'linear-gradient(135deg, #f0f4f8 0%, #e6ecf2 100%)',
    border: '1px solid var(--clr-warm-mid)',
    color: 'var(--clr-ink)',
    iconColor: 'var(--clr-sage-dark)',
  },
  warning: {
    background: 'var(--clr-warn-pale, #fdf3d8)',
    border: '1px solid var(--clr-warn-mid, #e8d196)',
    color: 'var(--clr-warn-ink, #8a6a1a)',
    iconColor: 'var(--clr-warn-ink, #8a6a1a)',
  },
  urgent: {
    background: '#fdebd0',
    border: '1px solid #d4831f',
    color: '#7a4500',
    iconColor: '#7a4500',
  },
  critical: {
    background: 'var(--clr-danger-pale, #fbe9eb)',
    border: '1px solid var(--clr-danger, #b00020)',
    color: 'var(--clr-danger, #b00020)',
    iconColor: 'var(--clr-danger, #b00020)',
  },
  expired: {
    background: 'var(--clr-danger-pale, #fbe9eb)',
    border: '1px solid var(--clr-danger, #b00020)',
    color: 'var(--clr-danger, #b00020)',
    iconColor: 'var(--clr-danger, #b00020)',
  },
})

export default function AnnualTrainingBanner({ userId }) {
  const [state, setState] = useState(null)

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    const run = async () => {
      try {
        // Gate: only license-exempt CDC providers are subject to the
        // Dec 16 annual training rule (Scholarship Handbook for LEP).
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_license_exempt')
          .eq('id', userId)
          .maybeSingle()
        if (cancelled) return
        if (!profile || profile.is_license_exempt !== true) {
          setState(null)
          return
        }

        // Source-of-truth: PR #4's miregistry_training_entries with
        // source='annual_ongoing' for the current calendar year. Read
        // MAX(completed_on); helper handles null cleanly when there's
        // no entry yet.
        const year = new Date().getFullYear()
        const yearStart = `${year}-01-01`
        const yearEnd   = `${year}-12-31`
        const { data: entries } = await supabase
          .from('miregistry_training_entries')
          .select('completed_on')
          .eq('user_id', userId)
          .eq('source', 'annual_ongoing')
          .is('archived_at', null)
          .gte('completed_on', yearStart)
          .lte('completed_on', yearEnd)
          .order('completed_on', { ascending: false })
          .limit(1)
        if (cancelled) return

        const completedDate =
          (entries && entries.length > 0 && entries[0].completed_on) || null
        setState(getAnnualTrainingDeadlineState(completedDate))
      } catch (err) {
        // Defensive: a missing table or RLS failure silently hides
        // the banner rather than crashing the dashboard.
        console.warn('AnnualTrainingBanner: load skipped', err?.message || err)
      }
    }
    run()
    return () => { cancelled = true }
  }, [userId])

  if (!state) return null
  const style = SEVERITY_STYLES[state.severity] || SEVERITY_STYLES.info

  return (
    <div style={{
      background: style.background,
      border: style.border,
      borderRadius: 'var(--radius-lg)',
      padding: 14,
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      {state.severity === 'expired' || state.severity === 'critical'
        ? <AlertCircle size={20} style={{ color: style.iconColor, flexShrink: 0 }} />
        : <CalendarCheck size={20} style={{ color: style.iconColor, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.9375rem',
          color: style.color,
          marginBottom: state.severity === 'info' ? 0 : 2,
        }}>
          {state.label}
        </div>
        {state.severity !== 'info' && state.severity !== 'expired' && (
          <div style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-mid)',
            lineHeight: 1.4,
          }}>
            Log the completion in MiRegistry, then record it on your
            MiRegistry training page so this banner clears.
          </div>
        )}
        {state.severity === 'expired' && (
          <div style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-mid)',
            lineHeight: 1.4,
          }}>
            Per MDHHS, your provider account may be closed and you'll
            need to reapply before resuming CDC billing. Call MDHHS
            Child Development and Care at 866-990-3227 for next steps.
          </div>
        )}
      </div>
    </div>
  )
}
