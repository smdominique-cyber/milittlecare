// Renders an overdue-annual-training warning at the top of the
// per-family Funding tab. Returns null in every other state.
//
// Three-condition gate (per docs/miregistry_tracker_spec.md § 7):
//   1. profile.is_license_exempt === true
//   2. getAnnualDeadlineStatus says past the Dec 16 deadline AND not
//      completed for the current year
//   3. Caller renders this on the Funding tab (placement, not gating)
//
// On any other state — licensed provider, in-window, completed,
// no profile, or no fetch yet — this component renders nothing. Safe
// to drop in unconditionally above any FundingSourceList.

import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { getAnnualDeadlineStatus, todayYMD } from '@/lib/miregistry'

export default function MiRegistryWarningBanner() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [entries, setEntries] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!user) {
      setLoaded(false)
      return
    }
    let cancelled = false
    Promise.all([
      supabase
        .from('profiles')
        .select('is_license_exempt')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('miregistry_training_entries')
        .select('source, completed_on, archived_at')
        .eq('user_id', user.id),
    ]).then(([profResp, entriesResp]) => {
      if (cancelled) return
      if (profResp.error || entriesResp.error) {
        // Soft-fail: log and render nothing rather than blocking the
        // Funding tab on a banner-side fetch error. The MiRegistry
        // page is the primary surface; this banner is a wayfinder.
        if (profResp.error) console.error('MiRegistryWarningBanner: profile fetch failed', profResp.error)
        if (entriesResp.error) console.error('MiRegistryWarningBanner: entries fetch failed', entriesResp.error)
        setLoaded(true)
        return
      }
      setProfile(profResp.data || null)
      setEntries(entriesResp.data || [])
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [user])

  // Year derived from todayYMD() to keep the date source consistent
  // with the rest of the miregistry lib helpers.
  const year = Number(todayYMD().slice(0, 4))

  const status = useMemo(
    () => getAnnualDeadlineStatus({ year, entries, today: todayYMD() }),
    [year, entries]
  )

  if (!loaded) return null
  if (!profile?.is_license_exempt) return null
  if (!status.isPastDeadline || status.completed) return null

  return (
    <div role="alert" style={bannerStyle}>
      <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, lineHeight: 1.5 }}>
        You haven&rsquo;t logged your MiRegistry annual training for{' '}
        <strong>{year}</strong>, and the December 16 deadline has passed.
        MDHHS closes provider accounts that miss this deadline — CDC
        payments stop, and you must reapply before billing resumes. If
        you completed the training, log it on the{' '}
        <NavLink to="/miregistry" style={linkStyle}>MiRegistry tab</NavLink>.
        If you haven&rsquo;t completed it, call MDHHS Child Development and
        Care at <strong>866-990-3227</strong> to discuss reactivation.
      </div>
    </div>
  )
}

const bannerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  marginBottom: 'var(--space-3)',
}

const linkStyle = {
  color: 'inherit',
  fontWeight: 600,
  textDecoration: 'underline',
}
