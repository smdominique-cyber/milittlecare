import { useNavigate, useLocation } from 'react-router-dom'
import { useSubscription } from '@/hooks/useSubscription'
import { useAuth } from '@/hooks/useAuth'
import { Lock, LogOut } from 'lucide-react'

// Wraps the app — if trial expired or subscription canceled, show the paywall
export default function PaywallGate({ children }) {
  const sub = useSubscription()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Always allow access to the subscription page itself
  const onSubscriptionPage = location.pathname === '/subscription'

  if (sub.loading) return children
  if (sub.hasAccess) return children
  if (onSubscriptionPage) return children

  // Trial expired or canceled — block
  return (
    <>
      {children}
      <div className="paywall-overlay">
        <div className="paywall-card">
          <div className="paywall-icon">
            <Lock size={28} />
          </div>
          <h2>
            {sub.isTrialExpired ? 'Your free trial has ended' : 'Subscription required'}
          </h2>
          <p>
            {sub.isTrialExpired
              ? 'Subscribe for $10/month to keep using MI Little Care. Your data is safe and waiting for you.'
              : 'Re-subscribe to access your account and pick up right where you left off.'}
          </p>
          <button className="plan-cta" onClick={() => navigate('/subscription')} style={{ marginBottom: 'var(--space-3)' }}>
            Continue to subscription
          </button>
          <button
            onClick={async () => { await signOut(); navigate('/login') }}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--clr-ink-soft)',
              fontSize: '0.8125rem',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </div>
    </>
  )
}
