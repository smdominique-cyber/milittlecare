import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { Shield, CreditCard, CheckCircle, AlertCircle, Loader, Lock, X, Info } from 'lucide-react'

const STRIPE_JS_URL = 'https://js.stripe.com/v3/'
let stripeJsLoaded = false
let stripeJsPromise = null

function loadStripeJs() {
  if (stripeJsLoaded) return Promise.resolve(window.Stripe)
  if (stripeJsPromise) return stripeJsPromise
  stripeJsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${STRIPE_JS_URL}"]`)
    if (existing) {
      existing.addEventListener('load', () => { stripeJsLoaded = true; resolve(window.Stripe) })
      return
    }
    const script = document.createElement('script')
    script.src = STRIPE_JS_URL
    script.onload = () => { stripeJsLoaded = true; resolve(window.Stripe) }
    script.onerror = () => reject(new Error('Failed to load Stripe.js'))
    document.head.appendChild(script)
  })
  return stripeJsPromise
}

export default function AutopayEnrollment({ family, providerName, onClose, onEnrolled }) {
  const [phase, setPhase] = useState('intro')  // intro | card | submitting | success | error
  const [error, setError] = useState(null)
  const [stripe, setStripe] = useState(null)
  const [elements, setElements] = useState(null)
  const [clientSecret, setClientSecret] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const cardContainerRef = useRef(null)
  const cardElementRef = useRef(null)

  // Public Stripe key from environment (set this in Vercel as VITE_STRIPE_PUBLISHABLE_KEY)
  const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY

  const startEnrollment = async () => {
    if (!stripePublishableKey) {
      setError('Stripe is not configured. Please contact your provider.')
      setPhase('error')
      return
    }
    setPhase('card')
    setError(null)
    try {
      const Stripe = await loadStripeJs()
      const stripeInstance = Stripe(stripePublishableKey)

      // Create setup intent
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/create-setup-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ family_id: family.id }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to start enrollment')

      const elementsInstance = stripeInstance.elements({
        clientSecret: data.client_secret,
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#3e5849',
            colorBackground: '#ffffff',
            colorText: '#1e2620',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            borderRadius: '8px',
          },
        },
      })

      const paymentElement = elementsInstance.create('payment', {
        wallets: { applePay: 'auto', googlePay: 'auto' },
      })

      // Mount when container is ready
      const tryMount = () => {
        if (cardContainerRef.current) {
          paymentElement.mount(cardContainerRef.current)
        } else {
          setTimeout(tryMount, 50)
        }
      }
      tryMount()

      setStripe(stripeInstance)
      setElements(elementsInstance)
      setClientSecret(data.client_secret)
      cardElementRef.current = paymentElement
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

  const submitCard = async () => {
    if (!stripe || !elements) return
    setSubmitting(true)
    setError(null)
    try {
      const { error: confirmErr, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: {
          return_url: window.location.href,
        },
      })
      if (confirmErr) throw new Error(confirmErr.message)
      if (!setupIntent || setupIntent.status !== 'succeeded') {
        throw new Error('Card setup did not complete')
      }

      // Confirm enrollment in our database
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/confirm-autopay-enrollment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          family_id: family.id,
          payment_method_id: setupIntent.payment_method,
          setup_intent_id: setupIntent.id,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to enable autopay')

      setPhase('success')
      setTimeout(() => {
        if (onEnrolled) onEnrolled(data)
      }, 1500)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="autopay-modal-overlay" onClick={onClose}>
      <div className="autopay-modal" onClick={e => e.stopPropagation()}>
        <button className="autopay-close" onClick={onClose}><X size={18} /></button>

        {phase === 'intro' && (
          <>
            <div className="autopay-hero">
              <div className="autopay-hero-icon"><CreditCard size={28} /></div>
              <h2>Set up Autopay</h2>
              <p>Save your card so {providerName} gets paid automatically every Monday for {family.family_name}. No more invoice reminders.</p>
            </div>

            <div className="autopay-benefits">
              <div className="autopay-benefit">
                <div className="autopay-benefit-icon">⚡</div>
                <div>
                  <strong>One-time setup</strong>
                  <span>Add your card now, never think about it again</span>
                </div>
              </div>
              <div className="autopay-benefit">
                <div className="autopay-benefit-icon">📅</div>
                <div>
                  <strong>Charged every Monday at 9 AM</strong>
                  <span>For the previous week of care</span>
                </div>
              </div>
              <div className="autopay-benefit">
                <div className="autopay-benefit-icon">✕</div>
                <div>
                  <strong>Cancel anytime</strong>
                  <span>Two taps to remove your card</span>
                </div>
              </div>
            </div>

            <div className="autopay-trust-section">
              <div className="autopay-trust-title">
                <Lock size={14} /> How your card information stays safe
              </div>
              <ul>
                <li>Your card details go directly to Stripe (PCI Level 1 certified)</li>
                <li>MI Little Care never sees or stores your card number</li>
                <li>{providerName} only sees "Card ending in 4242"</li>
                <li>You'll get an email receipt for every charge</li>
              </ul>
            </div>

            <div className="autopay-trust-section subtle">
              <div className="autopay-trust-title">
                <Info size={14} /> What you're authorizing
              </div>
              <p>By saving your card and enabling autopay, you authorize {providerName} to charge this card automatically each Monday for the previous week's child care services. The amount may vary based on actual care provided. You can cancel autopay at any time.</p>
            </div>

            {error && (
              <div className="autopay-error">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <button className="autopay-cta" onClick={startEnrollment}>
              Add card and enable autopay
            </button>

            <div className="autopay-stripe-row">
              <Shield size={12} /> Secured by Stripe
            </div>
          </>
        )}

        {phase === 'card' && (
          <>
            <h2 style={{ marginBottom: 8 }}>Add your card</h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: 14, marginBottom: 20 }}>
              Your card information is sent directly to Stripe — we never see or store it.
            </p>

            <div ref={cardContainerRef} className="autopay-card-element">
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--clr-ink-soft)' }}>
                <Loader size={20} className="spin" /> Loading secure card form…
              </div>
            </div>

            {error && (
              <div className="autopay-error">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <button
              className="autopay-cta"
              onClick={submitCard}
              disabled={submitting || !elements}
            >
              {submitting ? (
                <><Loader size={16} className="spin" /> Saving card…</>
              ) : (
                <><Lock size={16} /> Save card & enable autopay</>
              )}
            </button>

            <div className="autopay-stripe-row">
              <Shield size={12} /> Card details processed and stored securely by Stripe
            </div>
          </>
        )}

        {phase === 'success' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div className="autopay-icon-success"><CheckCircle size={36} /></div>
            <h2 style={{ marginTop: 16 }}>Autopay enabled! 🎉</h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: 15 }}>
              You'll be charged automatically every Monday at 9 AM. We'll email you a receipt for every charge.
            </p>
            <p style={{ color: 'var(--clr-ink-soft)', fontSize: 13, marginTop: 12 }}>
              Closing this window…
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div className="autopay-icon-error"><AlertCircle size={36} /></div>
            <h2 style={{ marginTop: 16 }}>Something went wrong</h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: 15 }}>{error}</p>
            <button className="parent-secondary" onClick={() => { setError(null); setPhase('intro') }}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
