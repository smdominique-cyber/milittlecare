import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useSubscription } from '@/hooks/useSubscription'
import { Check, CreditCard, Settings, Sparkles, AlertCircle } from 'lucide-react'
import '@/styles/subscription.css'

const FEATURES = [
  'AI-powered receipt scanning with auto-categorization',
  'Tax deduction tracker with category & monthly views',
  'Time-Space (T/S) ratio calculator',
  'Family management with billing rates',
  'Daily attendance tracking with check-in/out',
  'Auto-generated weekly invoices from attendance',
  'Stripe payment links for parents',
  'Outstanding balance dashboard',
  'Year-end tax-ready reports',
  'All future features included',
]

export default function SubscriptionPage() {
  const { user } = useAuth()
  const sub = useSubscription()
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  // Handle return from Stripe
  useEffect(() => {
    const status = params.get('status')
    if (status === 'success') {
      setSuccessMsg('🎉 Subscription activated! Welcome to MI Little Care.')
      // Refresh status — webhook may take a few seconds
      setTimeout(() => sub.refresh(), 2000)
      setTimeout(() => sub.refresh(), 6000)
      // Clean URL
      const next = new URLSearchParams(params)
      next.delete('status')
      next.delete('session_id')
      setParams(next, { replace: true })
    } else if (status === 'canceled') {
      setError('Checkout was canceled. You can try again anytime.')
      const next = new URLSearchParams(params)
      next.delete('status')
      setParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startCheckout = async () => {
    setBusy(true)
    setError(null)
    try {
      const resp = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.id,
          email: user.email,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to start checkout')
      window.location.href = data.url
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const openPortal = async () => {
    if (!sub.profile?.stripe_customer_id) {
      setError('No Stripe customer found yet. Try refreshing the page.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const resp = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: sub.profile.stripe_customer_id }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to open portal')
      window.location.href = data.url
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (sub.loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  return (
    <div className="subscription-page">

      {successMsg && (
        <div className="auth-message success" style={{ margin: 0 }}>
          <span>✓</span><span>{successMsg}</span>
        </div>
      )}

      {error && (
        <div className="auth-message error" style={{ margin: 0 }}>
          <span>⚠</span><span>{error}</span>
        </div>
      )}

      {/* Status hero */}
      <div className="sub-hero">
        <div className="sub-hero-inner">
          <div className={`sub-status-badge ${sub.status} ${sub.isTrialExpired ? 'expired' : ''}`}>
            <span className="dot" />
            {sub.isActive && 'Active subscription'}
            {sub.isTrialing && !sub.isTrialExpired && `Free trial · ${sub.daysLeft} days left`}
            {sub.isTrialExpired && 'Trial ended'}
            {sub.isPastDue && 'Payment past due'}
            {sub.status === 'canceled' && 'Subscription canceled'}
          </div>

          {sub.isActive && (
            <>
              <h2>You're all set, <em>thank you!</em></h2>
              <p className="sub-hero-desc">
                Your subscription is active. You have full access to every feature in MI Little Care.
                {sub.profile?.current_period_end && (
                  <> Next billing date: <strong>{new Date(sub.profile.current_period_end).toLocaleDateString()}</strong>.</>
                )}
                {sub.profile?.cancel_at_period_end && (
                  <> Your subscription will end on this date — you can resume anytime before then.</>
                )}
              </p>
              <button className="sub-hero-button" onClick={openPortal} disabled={busy}>
                <Settings size={16} /> Manage subscription
              </button>
            </>
          )}

          {sub.isTrialing && !sub.isTrialExpired && (
            <>
              <h2>You're on a <em>free trial</em></h2>
              <p className="sub-hero-desc">
                Enjoy full access to MI Little Care for {sub.daysLeft} more {sub.daysLeft === 1 ? 'day' : 'days'}.
                Add a card to keep going after your trial ends — you won't be charged until then.
              </p>
              <button className="sub-hero-button" onClick={startCheckout} disabled={busy}>
                <CreditCard size={16} /> {busy ? 'Loading…' : 'Add payment method'}
              </button>
            </>
          )}

          {sub.isTrialExpired && (
            <>
              <h2>Your trial has <em>ended</em></h2>
              <p className="sub-hero-desc">
                Subscribe for $10/month to keep using MI Little Care and never lose your data.
                Cancel anytime.
              </p>
              <button className="sub-hero-button" onClick={startCheckout} disabled={busy}>
                <CreditCard size={16} /> {busy ? 'Loading…' : 'Subscribe now'}
              </button>
            </>
          )}

          {sub.isPastDue && (
            <>
              <h2>Payment <em>needs attention</em></h2>
              <p className="sub-hero-desc">
                Your most recent payment didn't go through. Update your payment method to keep your subscription active.
              </p>
              <button className="sub-hero-button" onClick={openPortal} disabled={busy}>
                <CreditCard size={16} /> Update payment
              </button>
            </>
          )}

          {sub.status === 'canceled' && (
            <>
              <h2>Welcome back!</h2>
              <p className="sub-hero-desc">
                Your subscription is canceled. Re-subscribe anytime to pick up right where you left off — your data is still here.
              </p>
              <button className="sub-hero-button" onClick={startCheckout} disabled={busy}>
                <CreditCard size={16} /> Re-subscribe
              </button>
            </>
          )}
        </div>
      </div>

      {/* Plan card — only show when not active */}
      {!sub.isActive && (
        <div className="plan-card">
          <div className="plan-recommended-tag">All-inclusive</div>
          <div className="plan-name">MI Little Care · Provider Plan</div>

          <div className="plan-price-row">
            <span className="plan-price">$10</span>
            <span className="plan-price-unit">/ month</span>
          </div>

          {sub.isTrialing && !sub.isTrialExpired && (
            <div className="plan-trial-note">
              ✨ {sub.daysLeft} days remaining on your free trial
            </div>
          )}

          <ul className="plan-features">
            {FEATURES.map(f => (
              <li key={f}>
                <Check size={18} />
                <span>{f}</span>
              </li>
            ))}
          </ul>

          <button className="plan-cta" onClick={startCheckout} disabled={busy}>
            <Sparkles size={16} />
            {busy
              ? 'Loading…'
              : sub.isTrialing && !sub.isTrialExpired
                ? 'Add payment method'
                : 'Subscribe now'}
          </button>

          <p className="plan-fine-print">
            No long-term contracts. Cancel anytime from your account.<br />
            Secure payment powered by Stripe.
          </p>
        </div>
      )}
    </div>
  )
}
