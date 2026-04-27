import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'

// Single source of truth for the user's subscription status.
// Returns: { loading, profile, status, daysLeft, hasAccess, isTrialing, isExpired, refresh }
export function useSubscription() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    if (!user) {
      setProfile(null)
      setLoading(false)
      return
    }
    const { data } = await supabase
      .from('profiles')
      .select('subscription_status, trial_started_at, trial_ends_at, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id')
      .eq('id', user.id)
      .maybeSingle()
    setProfile(data)
    setLoading(false)
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Calculate days left in trial
  let daysLeft = null
  if (profile?.trial_ends_at) {
    const ms = new Date(profile.trial_ends_at).getTime() - Date.now()
    daysLeft = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
  }

  const status = profile?.subscription_status || 'trialing'
  const isTrialing = status === 'trialing'
  const isActive = status === 'active'
  const isPastDue = status === 'past_due'

  // Trial expired = still 'trialing' status but no days left
  const isTrialExpired = isTrialing && daysLeft === 0
  const isExpired = status === 'expired' || status === 'canceled' || isTrialExpired

  // hasAccess: user can use the app
  const hasAccess = isActive || (isTrialing && daysLeft > 0) || isPastDue

  return {
    loading,
    profile,
    status,
    daysLeft,
    hasAccess,
    isTrialing,
    isActive,
    isPastDue,
    isExpired,
    isTrialExpired,
    refresh,
  }
}
