import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import '@/styles/auth.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn, signUp, signInWithMagicLink } = useAuth()

  const from = location.state?.from?.pathname || '/dashboard'

  // Tab: 'login' | 'signup'
  const [tab, setTab] = useState('login')
  // Mode for login: 'password' | 'magic'
  const [loginMode, setLoginMode] = useState('password')

  const [form, setForm] = useState({ email: '', password: '', fullName: '' })
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null) // { type: 'error'|'success', text }

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }))
    setMessage(null)
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const { error } = await signIn({ email: form.email, password: form.password })
    if (error) {
      setMessage({ type: 'error', text: error.message })
      setLoading(false)
    } else {
      navigate(from, { replace: true })
    }
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const { error } = await signUp({
      email: form.email,
      password: form.password,
      fullName: form.fullName,
    })

    setLoading(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      setMessage({
        type: 'success',
        text: 'Almost there! Check your email to confirm your account, then come back to sign in.',
      })
    }
  }

  const handleMagicLink = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const { error } = await signInWithMagicLink({ email: form.email })
    setLoading(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      setMessage({
        type: 'success',
        text: 'Magic link sent! Check your email and click the link to sign in.',
      })
    }
  }

  return (
    <div className="auth-layout">
      {/* Brand panel */}
      <div className="auth-brand-panel">
        <div className="auth-brand-logo">
          <div className="logo-mark">🏡</div>
          <span className="logo-text">Mi Little Care</span>
        </div>

        <div className="auth-brand-headline">
          <h1>
            Run your daycare<br />
            with <em>confidence</em>.
          </h1>
          <p>
            Smart tools designed specifically for home daycare providers —
            track deductions, manage families, and stay organized year-round.
          </p>
        </div>

        <div className="auth-brand-features">
          {[
            'AI-powered receipt scanning',
            'Tax deduction tracker built for home daycares',
            'T/S ratio calculator included',
            'Export-ready reports for your tax preparer',
          ].map((f) => (
            <div className="auth-brand-feature" key={f}>
              <div className="feature-dot" />
              <span>{f}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Form panel */}
      <div className="auth-form-panel">
        <div className="auth-form-container">
          <div className="auth-form-header">
            <h2>
              {tab === 'login' ? 'Welcome back' : 'Create your account'}
            </h2>
            <p>
              {tab === 'login'
                ? 'Sign in to your Mi Little Care account'
                : 'Start managing your home daycare with confidence'}
            </p>
          </div>

          {/* Tabs */}
          <div className="auth-tabs">
            <button
              className={`auth-tab${tab === 'login' ? ' active' : ''}`}
              onClick={() => { setTab('login'); setMessage(null) }}
            >
              Sign in
            </button>
            <button
              className={`auth-tab${tab === 'signup' ? ' active' : ''}`}
              onClick={() => { setTab('signup'); setMessage(null) }}
            >
              Create account
            </button>
          </div>

          {/* Messages */}
          {message && (
            <div className={`auth-message ${message.type}`}>
              <span>{message.type === 'error' ? '⚠' : '✓'}</span>
              <span>{message.text}</span>
            </div>
          )}

          {/* ---- LOGIN ---- */}
          {tab === 'login' && loginMode === 'password' && (
            <form onSubmit={handleLogin}>
              <div className="form-field">
                <label className="form-label" htmlFor="email">Email address</label>
                <input
                  id="email"
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={set('email')}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="password">Password</label>
                <input
                  id="password"
                  className="form-input"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="••••••••"
                  value={form.password}
                  onChange={set('password')}
                />
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}

          {tab === 'login' && loginMode === 'magic' && (
            <form onSubmit={handleMagicLink}>
              <div className="form-field">
                <label className="form-label" htmlFor="magic-email">Email address</label>
                <input
                  id="magic-email"
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={set('email')}
                />
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? 'Sending…' : '✉ Send magic link'}
              </button>
            </form>
          )}

          {tab === 'login' && (
            <>
              <div className="auth-divider">or</div>
              <button
                className="btn-secondary"
                type="button"
                onClick={() => {
                  setLoginMode(loginMode === 'password' ? 'magic' : 'password')
                  setMessage(null)
                }}
              >
                {loginMode === 'password'
                  ? '✉ Sign in with magic link'
                  : '🔑 Sign in with password'}
              </button>
            </>
          )}

          {/* ---- SIGN UP ---- */}
          {tab === 'signup' && (
            <form onSubmit={handleSignUp}>
              <div className="form-field">
                <label className="form-label" htmlFor="full-name">Your name</label>
                <input
                  id="full-name"
                  className="form-input"
                  type="text"
                  autoComplete="name"
                  required
                  placeholder="Maria Rodriguez"
                  value={form.fullName}
                  onChange={set('fullName')}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="signup-email">Email address</label>
                <input
                  id="signup-email"
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={set('email')}
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="signup-password">Password</label>
                <input
                  id="signup-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  value={form.password}
                  onChange={set('password')}
                />
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? 'Creating account…' : 'Create free account'}
              </button>
              <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-faint)', textAlign: 'center', marginTop: 'var(--space-3)' }}>
                By creating an account you agree to our Terms of Service and Privacy Policy.
              </p>
            </form>
          )}

          <div className="auth-footer-link">
            {tab === 'login' ? (
              <>
                New to Mi Little Care?{' '}
                <button onClick={() => { setTab('signup'); setMessage(null) }}>
                  Create a free account
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button onClick={() => { setTab('login'); setMessage(null) }}>
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
