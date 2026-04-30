import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Lock, CheckCircle, Loader, AlertCircle } from 'lucide-react'

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [phase, setPhase] = useState('form')  // form | submitting | success | error
  const [error, setError] = useState(null)
  const [hasSession, setHasSession] = useState(null)

  useEffect(() => {
    // When user clicks email link, Supabase auto-establishes a session via the URL hash
    supabase.auth.getSession().then(({ data: { session } }) => {
      setHasSession(!!session)
      if (!session) {
        setError('This link is invalid or has expired. Please request a new password reset.')
      }
    })
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setPhase('submitting')
    setError(null)
    try {
      const { error: err } = await supabase.auth.updateUser({ password })
      if (err) throw err
      setPhase('success')
      setTimeout(() => navigate('/dashboard'), 2000)
    } catch (err) {
      setError(err.message || 'Failed to reset password')
      setPhase('form')
    }
  }

  if (hasSession === null) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-brand">
          <span className="auth-brand-mark">🏡</span>
          <span className="auth-brand-name">MI Little Care</span>
        </div>

        {phase === 'success' ? (
          <>
            <div className="parent-icon" style={{ background: 'var(--clr-success-pale)', color: 'var(--clr-success)' }}>
              <CheckCircle size={32} />
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, marginTop: 16, marginBottom: 8 }}>
              Password reset!
            </h2>
            <p style={{ color: 'var(--clr-ink-mid)', textAlign: 'center' }}>
              Signing you in…
            </p>
          </>
        ) : !hasSession ? (
          <>
            <div className="parent-icon error"><AlertCircle size={28} /></div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, marginTop: 16, marginBottom: 8 }}>
              Link expired
            </h2>
            <p style={{ color: 'var(--clr-error)', textAlign: 'center', marginBottom: 16 }}>{error}</p>
            <button onClick={() => navigate('/forgot-password')} className="auth-cta" style={{ width: '100%' }}>
              Request a new link
            </button>
          </>
        ) : (
          <>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 400, marginBottom: 6 }}>
              Set a new password
            </h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', marginBottom: 20, textAlign: 'center' }}>
              Choose a strong password (at least 8 characters).
            </p>

            <form onSubmit={submit} style={{ width: '100%' }}>
              <div className="form-field">
                <label className="form-label">New password</label>
                <input
                  type="password"
                  className="form-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
              </div>

              <div className="form-field">
                <label className="form-label">Confirm password</label>
                <input
                  type="password"
                  className="form-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
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
                disabled={phase === 'submitting'}
                style={{ width: '100%', marginTop: 16 }}
              >
                {phase === 'submitting' ? (
                  <><Loader size={14} className="spin" /> Resetting…</>
                ) : (
                  <><Lock size={14} /> Reset password</>
                )}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
