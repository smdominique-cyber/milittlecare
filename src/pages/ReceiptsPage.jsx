import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Lock, CheckCircle, Loader, AlertCircle } from 'lucide-react'
import '@/styles/auth.css'

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
      <div className="auth-layout">
        <div className="auth-form-panel" style={{ width: '100%' }}>
          <div className="auth-form-container" style={{ textAlign: 'center' }}>
            <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark, #3e5849)', margin: '40px auto' }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-layout">
      <div className="auth-brand-panel">
        <div className="auth-brand-logo">
          <div className="logo-mark">🏡</div>
          <span className="logo-text">MI Little Care</span>
        </div>

        <div className="auth-brand-headline">
          <h1>
            Almost<br />
            <em>back in.</em>
          </h1>
          <p>
            Choose a new password and we'll sign you right in.
          </p>
        </div>
      </div>

      <div className="auth-form-panel">
        <div className="auth-form-container">
          {phase === 'success' ? (
            <div className="auth-form-header" style={{ textAlign: 'center' }}>
              <div style={{
                width: 64, height: 64, margin: '0 auto 16px',
                background: 'rgba(74,155,111,0.12)', color: 'var(--clr-success, #4a9b6f)',
                borderRadius: '50%', display: 'grid', placeItems: 'center',
              }}>
                <CheckCircle size={32} />
              </div>
              <h2>Password reset!</h2>
              <p>Signing you in…</p>
            </div>
          ) : !hasSession ? (
            <>
              <div className="auth-form-header" style={{ textAlign: 'center' }}>
                <div style={{
                  width: 64, height: 64, margin: '0 auto 16px',
                  background: 'rgba(192,57,43,0.12)', color: 'var(--clr-error, #c0392b)',
                  borderRadius: '50%', display: 'grid', placeItems: 'center',
                }}>
                  <AlertCircle size={32} />
                </div>
                <h2>Link expired</h2>
                <p style={{ color: 'var(--clr-error, #c0392b)' }}>{error}</p>
              </div>
              <button
                onClick={() => navigate('/forgot-password')}
                className="btn-primary"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                Request a new link
              </button>
            </>
          ) : (
            <>
              <div className="auth-form-header">
                <h2>Set a new password</h2>
                <p>Choose a strong password (at least 8 characters).</p>
              </div>

              <form onSubmit={submit}>
                <div className="form-field">
                  <label className="form-label" htmlFor="new-password">New password</label>
                  <input
                    id="new-password"
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
                  <label className="form-label" htmlFor="confirm-password">Confirm password</label>
                  <input
                    id="confirm-password"
                    type="password"
                    className="form-input"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
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
                  disabled={phase === 'submitting'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
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
    </div>
  )
}
