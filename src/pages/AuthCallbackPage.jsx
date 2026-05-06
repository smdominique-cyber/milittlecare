import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

export default function AuthCallbackPage() {
  const navigate = useNavigate()

  useEffect(() => {
    let didRoute = false

    async function routeUser(session) {
      if (didRoute) return
      if (!session?.user?.id) return
      didRoute = true

      // Decide where to send the user based on their profile type.
      // - parent_profiles row exists → parent → /parent
      // - profiles row exists (provider) → provider → /dashboard
      // - neither → assume parent (safer default — providers sign up explicitly)
      try {
        const { data: parentProfile } = await supabase
          .from('parent_profiles')
          .select('id')
          .eq('id', session.user.id)
          .maybeSingle()

        if (parentProfile) {
          navigate('/parent', { replace: true })
          return
        }

        const { data: providerProfile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', session.user.id)
          .maybeSingle()

        if (providerProfile) {
          navigate('/dashboard', { replace: true })
          return
        }

        // Unknown — default to parent (safer than dropping them on a paywall)
        navigate('/parent', { replace: true })
      } catch (err) {
        console.error('AuthCallback routing error:', err)
        // Still default to parent on error
        navigate('/parent', { replace: true })
      }
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        routeUser(session)
      }
    })

    // Fallback — if already signed in, route immediately
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) routeUser(session)
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  return (
    <div className="loading-screen">
      <div className="loading-spinner" />
      <p>Signing you in…</p>
    </div>
  )
}
