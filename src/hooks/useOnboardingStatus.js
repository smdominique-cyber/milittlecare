// useOnboardingStatus — read-only onboarding summary for the dashboard
// (PR #7, Phase 3). Fetches the signed-in provider's profile once and
// derives the progress summary that drives the completion card, the
// next-step prompt, and the auto-open trigger.
//
// Distinct from useOnboarding: that hook runs the wizard and writes;
// this one only reads. The derivation itself is the pure, Vitest-tested
// getOnboardingProgress in src/lib/onboarding.js.

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { getOnboardingProgress } from '@/lib/onboarding'

const PROFILE_COLUMNS =
  'is_license_exempt, miregistry_id, michigan_license_number, '
  + 'michigan_provider_id, program_settings, onboarding_state'

export function useOnboardingStatus() {
  const { user } = useAuth()
  const [state, setState] = useState({ loading: true, progress: null })

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!user) {
        setState({ loading: false, progress: null })
        return
      }
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', user.id)
        .maybeSingle()
      if (cancelled) return
      // On a fetch error, surface "no progress" rather than blocking the
      // dashboard — the card/prompt simply do not render.
      setState({
        loading: false,
        progress: error || !data ? null : getOnboardingProgress(data),
      })
    }

    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  return state
}
