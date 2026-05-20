import { useState, useEffect } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import '@/styles/auth.css'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn, signUp } = useAuth()

  const from = location.state?.from?.pathname || null

  // When the user arrives here from a parent or staff invite-accept
  // page, the location state carries the invitation's recipient_email.
  // We pre-fill + lock the email field, default to the signup tab, and
  // pass emailRedirectTo on the signup so the confirmation email lands
  // them back on the originating /invite/<token> or /staff-invite/<token>.
  // (The from.pathname above is the single source of truth for where
  // to return — same string works for both flows.)
  const inviteEmail = location.state?.inviteEmail || null

  const [tab, setTab] = useState(inviteEmail ? 'signup' : 'login')

  const [form, setForm] = useState({
    email: inviteEmail || '',
    password: '',
    fullName: '',
  })
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [agreedToTerms, setAgreedToTerms] = useState(false)

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

  // When password sign-in fails, see whether this is a parent who never
  // set a password (existing legacy account from the old invite flow).
  // If so, point them at /forgot-password to reset.
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
    return null
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

    const diagnosis = await diagnoseLoginFailure(form.email)
    setLoading(false)

    if (diagnosis === 'parent_no_password') {
      setMessage({
        type: 'info',
        text: "Your account doesn't have a password set yet. Click 'Forgot password?' below to set one — we'll email you a secure link.",
      })
      return
    }

    if (diagnosis === 'parent_wrong_password') {
      setMessage({
        type: 'error',
        text: "That password doesn't match. Try again, or click 'Forgot password?' to reset it.",
      })
      return
    }

    setMessage({ type: 'error', text: error.message })
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setLoading(true)
    setMessage(null)

    const signUpOptions = {
      email: form.email,
      password: form.password,
      options: { data: { full_name: form.fullName } },
    }
    if (from) {
      // Send the email-confirmation click back to wherever the user
      // started — for invitation flows that's /invite/<token> or
      // /staff-invite/<token>; the user lands authenticated and can
      // complete acceptance under their own session.
      signUpOptions.options.emailRedirectTo =
        `${window.location.origin}${from}`
    }
    const { data, error } = await supabase.auth.signUp(signUpOptions)

    setLoading(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      // Record clickwrap acceptance on the user's profiles row
      // (migration 014). With email confirmation enabled, the signUp
      // response carries `user` but no `session`, so this RLS-gated
      // write may not land until the user signs in for the first time
      // — that's acceptable: signup itself succeeded, and the gate is
      // primarily a UX/legal affordance enforced before this point.
      try {
        if (data?.user?.id) {
          await supabase
            .from('profiles')
            .update({ terms_accepted_at: new Date().toISOString() })
            .eq('id', data.user.id)
        }
      } catch (writeErr) {
        console.error('LoginPage: terms_accepted_at update failed', writeErr)
      }
      setMessage({
        type: 'success',
        text: inviteEmail
          ? 'Almost there! Check your email to confirm. The confirmation link will bring you back to your invitation.'
          : 'Almost there! Check your email to confirm your account, then come back to sign in.',
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
          {tab === 'login' && (
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
                  disabled={!!inviteEmail}
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
                Invited by a daycare provider and don't have a password yet? Click <a href="/forgot-password" style={{ color: 'var(--clr-sage-dark)', fontWeight: 500 }}>Forgot password?</a> above to set one.
              </p>
            </form>
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
                  disabled={!!inviteEmail}
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
              <div className="form-field" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input
                  id="agree-terms"
                  type="checkbox"
                  required
                  checked={agreedToTerms}
                  onChange={(e) => setAgreedToTerms(e.target.checked)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <label htmlFor="agree-terms" style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.5 }}>
                  I agree to the{' '}
                  <Link to="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--clr-sage-dark)' }}>
                    Terms of Service
                  </Link>{' '}
                  and{' '}
                  <Link to="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--clr-sage-dark)' }}>
                    Privacy Policy
                  </Link>
                </label>
              </div>
              <button className="btn-primary" type="submit" disabled={loading || !agreedToTerms}>
                {loading ? 'Creating account…' : 'Create free account'}
              </button>
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
