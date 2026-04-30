import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Mail, ArrowLeft, CheckCircle, Loader, AlertCircle } from 'lucide-react'

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
      setPhase('error')
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-brand">
          <span className="auth-brand-mark">🏡</span>
          <span className="auth-brand-name">MI Little Care</span>
        </div>

        {phase === 'sent' ? (
          <>
            <div className="parent-icon" style={{ background: 'var(--clr-success-pale)', color: 'var(--clr-success)' }}>
              <CheckCircle size={32} />
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, marginTop: 16, marginBottom: 8 }}>
              Check your email
            </h2>
            <p style={{ color: 'var(--clr-ink-mid)', textAlign: 'center', lineHeight: 1.55 }}>
              We sent a password reset link to <strong>{email}</strong>. Click the link in the email to set a new password.
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginTop: 16, textAlign: 'center' }}>
              Didn't get it? Check your spam folder. If still nothing, the email may not be associated with an MI Little Care account.
            </p>
            <Link to="/login" className="auth-secondary" style={{ marginTop: 20 }}>
              <ArrowLeft size={14} /> Back to sign in
            </Link>
          </>
        ) : (
          <>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, marginBottom: 6 }}>
              Reset your password
            </h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.5, marginBottom: 24, textAlign: 'center' }}>
              Enter your email and we'll send you a link to set a new password.
            </p>

            <form onSubmit={submit} style={{ width: '100%' }}>
              <div className="form-field">
                <label className="form-label" htmlFor="reset-email">Email</label>
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
                <div className="auth-message error" style={{ marginTop: 12 }}>
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <button
                type="submit"
                className="auth-cta"
                disabled={phase === 'sending' || !email}
                style={{ width: '100%', marginTop: 16 }}
              >
                {phase === 'sending' ? (
                  <><Loader size={14} className="spin" /> Sending…</>
                ) : (
                  <><Mail size={14} /> Send reset link</>
                )}
              </button>
            </form>

            <Link to="/login" className="auth-secondary" style={{ marginTop: 20 }}>
              <ArrowLeft size={14} /> Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
