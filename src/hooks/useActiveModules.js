import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { getActiveModules } from '@/lib/modules'

// Loads the current provider's profile + active funding sources and
// memoizes the activated module set. Re-fetches when the auth user
// changes. Callers mutate funding sources elsewhere and call refresh()
// to pick up the new state.
//
// Returns: { loading, modules, profile, fundingSources, error, refresh }
//
// During the initial load (and any signed-out state) modules defaults
// to {core}, so the UI safely renders a private-pay-only shell rather
// than briefly flashing program-specific nav.
//
// Errors are noisy on purpose: a silent failure here would make a CDC
// provider's account look like a private-pay account — a customer
// support incident, not a soft signal. On error we console.error and
// expose an Error via the `error` field so future UI work can surface
// a retry banner without re-architecting the hook. Profile and funding
// source state are intentionally NOT cleared on error so a transient
// network blip doesn't visibly downgrade the UI.
export function useActiveModules() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [fundingSources, setFundingSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = async () => {
    if (!user) {
      setProfile(null)
      setFundingSources([])
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [profileResp, sourcesResp] = await Promise.all([
        supabase
          .from('profiles')
          .select('program_settings, miregistry_id, michigan_license_number, is_license_exempt')
          .eq('id', user.id)
          .maybeSingle(),
        // Server-side filter mirrors getActiveModules's own filter; keeping
        // both layers means getActiveModules stays pure-testable without a DB.
        supabase
          .from('funding_sources')
          .select('id, type, status, archived_at')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .is('archived_at', null),
      ])

      if (profileResp.error) throw profileResp.error
      if (sourcesResp.error) throw sourcesResp.error

      setProfile(profileResp.data || null)
      setFundingSources(sourcesResp.data || [])
    } catch (err) {
      console.error('useActiveModules: failed to load funding sources or profile', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const modules = useMemo(
    () => getActiveModules({ profile, fundingSources }),
    [profile, fundingSources]
  )

  return { loading, modules, profile, fundingSources, error, refresh }
}
