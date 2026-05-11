import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import '@/styles/auth.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn, signUp, signInWithMagicLink } = useAuth()

  const from = location.state?.from?.pathname || null

  const [tab, setTab] = useState('login')
  const [loginMode, setLoginMode] = useState('password')

  const [form, setForm] = useState({ email: '', password: '', fullName: '' })
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }))
    setMessage(null)
  }

  // After login, route parents to /parent and providers to /dashboard
  async function routeAfterLogin() {
    if (from) {
      navigate(from, { replace: true })
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      navigate('/dashboard', { replace: true })
      return
    }
    // Check if this user is a parent (has a parent_profiles row)
    const { data: parentProfile } = await supabase
      .from('parent_profiles')
      .select('id')
      .eq('id', user.id)
      .maybeSingle()
    if (parentProfile) {
      navigate('/parent', { replace: true })
    } else {
      navigate('/dashboard', { replace: true })
    }
  }

  // ──────────────────────────────────────────────────────────────
  // When password sign-in fails with "Invalid login credentials",
  // figure out WHY and give a useful error.
  //
  // The common case we're fixing: parent accepted invitation without
  // setting a password. They later try to sign in with a password
  // they never set. Supabase returns the generic "Invalid login
  // credentials" — we detect this and tell them to use magic link.
  // ──────────────────────────────────────────────────────────────
  async function diagnoseLoginFailure(email) {
    if (!email) return null
    const { data: parentProfile } = await supabase
      .from('parent_profiles')
      .select('id, has_password')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle()

    if (parentProfile && !parentProfile.has_password) {
      return 'parent_no_password'
    }
    if (parentProfile && parentProfile.has_password) {
      return 'parent_wrong_password'
    }
    return null  // either a provider or no account at all — fall through to generic
  }

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const { error } = await signIn({ email: form.email, password: form.password })

    if (!error) {
      await routeAfterLogin()
      return
    }

    // Sign-in failed — try to diagnose for a better error message
    const diagnosis = await diagnoseLoginFailure(form.email)
    setLoading(false)

    if (diagnosis === 'parent_no_password') {
      setMessage({
        type: 'info',
        text: "We don't see a password on this account yet. Use 'Sign in with magic link' below — once you're in, you can set a password from your dashboard.",
      })
      // Helpfully auto-switch to magic link mode
      setLoginMode('magic')
      setForm((f) => ({ ...f, password: '' }))
      return
    }

    if (diagnosis === 'parent_wrong_password') {
      setMessage({
        type: 'error',
        text: "That password doesn't match. Try again, or use 'Sign in with magic link' below if you've forgotten it.",
      })
      return
    }

    // Generic case — provider with wrong password, or no account at all
    setMessage({ type: 'error', text: error.message })
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

          {message && (
            <div className={`auth-message ${message.type}`}>
              <span>{message.type === 'error' ? '⚠' : message.type === 'info' ? 'ℹ' : '✓'}</span>
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
              <div style={{ textAlign: 'right', marginTop: -8, marginBottom: 8 }}>
                <a href="/forgot-password" style={{ fontSize: '0.8125rem', color: 'var(--clr-sage-dark)', textDecoration: 'none' }}>
                  Forgot password?
                </a>
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', textAlign: 'center', marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>
                Invited by a daycare provider? Try <strong>magic link</strong> below — your password may not be set yet.
              </p>
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
                New to MI Little Care?{' '}
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

          <div style={{
            textAlign: 'center',
            marginTop: 16,
            fontSize: '0.75rem',
            color: 'var(--clr-ink-soft)',
          }}>
            <a href="/privacy" style={{ color: 'var(--clr-ink-soft)', textDecoration: 'none' }}>Privacy Policy</a>
            <span style={{ margin: '0 8px' }}>·</span>
            <a href="/terms" style={{ color: 'var(--clr-ink-soft)', textDecoration: 'none' }}>Terms of Service</a>
          </div>
        </div>
      </div>
    </div>
  )
}
