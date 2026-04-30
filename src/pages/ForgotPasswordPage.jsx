import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Mail, ArrowLeft, CheckCircle, Loader, AlertCircle } from 'lucide-react'
import '@/styles/auth.css'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState('form')  // form | sending | sent | error
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (!email) return
    setPhase('sending')
    setError(null)
    try {
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (err) throw err
      setPhase('sent')
    } catch (err) {
      setError(err.message || 'Failed to send reset email')
      setPhase('form')
    }
  }

  return (
    <div className="auth-layout">
      {/* Brand panel */}
      <div className="auth-brand-panel">
        <div className="auth-brand-logo">
          <div className="logo-mark">🏡</div>
          <span className="logo-text">MI Little Care</span>
        </div>

        <div className="auth-brand-headline">
          <h1>
            Trouble<br />
            <em>signing in?</em>
          </h1>
          <p>
            We'll email you a secure link to reset your password.
          </p>
        </div>
      </div>

      {/* Form panel */}
      <div className="auth-form-panel">
        <div className="auth-form-container">
          {phase === 'sent' ? (
            <>
              <div className="auth-form-header" style={{ textAlign: 'center' }}>
                <div style={{
                  width: 64, height: 64, margin: '0 auto 16px',
                  background: 'rgba(74,155,111,0.12)', color: 'var(--clr-success, #4a9b6f)',
                  borderRadius: '50%', display: 'grid', placeItems: 'center',
                }}>
                  <CheckCircle size={32} />
                </div>
                <h2>Check your email</h2>
                <p>
                  We sent a password reset link to <strong>{email}</strong>. Click the link in the email to set a new password.
                </p>
              </div>

              <div style={{
                background: 'var(--clr-cream, #faf6ec)',
                border: '1px solid var(--clr-warm-mid, #e5d9c4)',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: '0.8125rem',
                color: 'var(--clr-ink-soft, #8a9281)',
                margin: '20px 0',
                lineHeight: 1.5,
              }}>
                <strong>Didn't get it?</strong> Check your spam folder. If still nothing, the email may not be associated with an MI Little Care account.
              </div>

              <Link to="/login" className="btn-primary" style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                textDecoration: 'none',
              }}>
                <ArrowLeft size={14} /> Back to sign in
              </Link>
            </>
          ) : (
            <>
              <div className="auth-form-header">
                <h2>Reset your password</h2>
                <p>
                  Enter your email and we'll send you a link to set a new password.
                </p>
              </div>

              <form onSubmit={submit}>
                <div className="form-field">
                  <label className="form-label" htmlFor="reset-email">Email address</label>
                  <input
                    id="reset-email"
                    type="email"
                    className="form-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoFocus
                  />
                </div>

                {error && (
                  <div className="auth-message error" style={{ marginBottom: 12 }}>
                    <span>⚠</span>
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={phase === 'sending' || !email}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  {phase === 'sending' ? (
                    <><Loader size={14} className="spin" /> Sending…</>
                  ) : (
                    <><Mail size={14} /> Send reset link</>
                  )}
                </button>
              </form>

              <div className="auth-footer-link" style={{ marginTop: 20 }}>
                Remember your password?{' '}
                <Link to="/login" style={{ color: 'var(--clr-sage-dark, #3e5849)', textDecoration: 'none' }}>
                  Sign in
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
