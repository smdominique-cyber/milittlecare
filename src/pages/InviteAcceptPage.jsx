import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, AlertCircle, Loader, Lock } from 'lucide-react'
import '@/styles/parent.css'

export default function InviteAcceptPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [phase, setPhase] = useState('loading')  // loading | invalid | form | accepting | done | error
  const [error, setError] = useState(null)
  const [invitation, setInvitation] = useState(null)
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (!token) {
      setPhase('invalid')
      return
    }
    fetchInvitationPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function fetchInvitationPreview() {
    try {
      const resp = await fetch('/api/invitation-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setError(data.error || 'Invalid invitation')
        setPhase('invalid')
        return
      }
      setInvitation(data)
      setFullName(data.recipient_name || '')
      setPhase('form')
    } catch (err) {
      setError(err.message)
      setPhase('invalid')
    }
  }

  const handleAccept = async () => {
    setError(null)

    // Password is now REQUIRED for all parent invite acceptances.
    if (!password || password.length < 8) {
      setError('Please choose a password of at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match. Please re-enter.")
      return
    }
    if (!fullName.trim()) {
      setError('Please enter your name.')
      return
    }

    setPhase('accepting')

    try {
      const resp = await fetch('/api/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept invitation')

      // Sign in via OTP verification
      let signedInViaOtp = false
      if (data.auto_signin_token && data.email) {
        const { error: otpErr } = await supabase.auth.verifyOtp({
          email: data.email,
          token_hash: data.auto_signin_token,
          type: 'email',
        })
        if (!otpErr) {
          signedInViaOtp = true
        }
      }

      // Set the password while we're signed in
      if (signedInViaOtp) {
        const { error: pwErr } = await supabase.auth.updateUser({ password })
        if (pwErr) {
          // The account is created and they're signed in, but password didn't stick.
          // They can set it from the dashboard banner. Log it but don't block them.
          console.warn('Password set failed:', pwErr.message)
        } else {
          // Mark has_password=true so login flow knows
          const { data: { user } } = await supabase.auth.getUser()
          if (user) {
            await supabase
              .from('parent_profiles')
              .update({ has_password: true })
              .eq('id', user.id)
          }
        }
      }

      // OTP failed — fall back to magic link redirect. In this path the password
      // we collected does NOT get applied because the page reloads. Parent will
      // see the "set a password" banner on dashboard.
      if (!signedInViaOtp && data.magic_link) {
        window.location.href = data.magic_link
        return
      }

      setPhase('done')
      setTimeout(() => navigate('/parent'), 1200)
    } catch (err) {
      setError(err.message)
      setPhase('form')
    }
  }

  if (phase === 'loading') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)', marginBottom: 12 }} />
          <div>Loading your invitation…</div>
        </div>
      </div>
    )
  }

  if (phase === 'invalid') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>This invitation isn't valid</h2>
          <p>{error || 'The link may have expired or already been used.'}</p>
          <p style={{ marginTop: 16, color: 'var(--clr-ink-soft)', fontSize: 14 }}>
            Please contact your child care provider to send a new invitation.
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon success"><CheckCircle size={28} /></div>
          <h2>You're all set!</h2>
          <p>Taking you to your dashboard…</p>
        </div>
      </div>
    )
  }

  const canSubmit =
    phase !== 'accepting' &&
    fullName.trim() &&
    password.length >= 8 &&
    password === confirmPassword

  return (
    <div className="parent-shell">
      <div className="parent-card">
        <div className="parent-brand">
          <div className="parent-brand-mark">🏠</div>
          <div>
            <div className="parent-brand-name">MI Little Care</div>
            <div className="parent-brand-tag">FAMILY PORTAL</div>
          </div>
        </div>

        <h2 style={{ marginTop: 12 }}>
          <strong>{invitation?.provider_name || 'Your provider'}</strong> invited you to manage <strong>{invitation?.family_name || 'your family'}</strong>
        </h2>

        <p style={{ color: 'var(--clr-ink-mid)' }}>
          Accept to view invoices, pay online, manage your contact info, and stay updated on schedule changes.
        </p>

        <div style={{ marginTop: 20 }}>
          <label className="parent-label">Your name</label>
          <input
            className="parent-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
          />
        </div>

        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--clr-ink-soft)' }}>
          Signing in as <strong>{invitation?.recipient_email}</strong>
        </div>

        {/* Password section — required */}
        <div style={{
          marginTop: 20,
          padding: 16,
          background: 'var(--clr-cream)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--clr-warm-mid)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Lock size={14} style={{ color: 'var(--clr-sage-dark)' }} />
            <span style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
              Create a password
            </span>
          </div>

          <label className="parent-label" style={{ fontSize: '0.8125rem' }}>Password</label>
          <input
            className="parent-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ marginTop: 0 }}
          />

          <label className="parent-label" style={{ fontSize: '0.8125rem', marginTop: 10 }}>Confirm password</label>
          <input
            className="parent-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            placeholder="Type it again"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            style={{ marginTop: 0 }}
          />

          <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
            You'll sign in with your email and this password from now on. Forgot it later? Use "Forgot password?" on the sign-in page to reset.
          </p>
        </div>

        {error && (
          <div className="parent-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <button
          className="parent-cta"
          onClick={handleAccept}
          disabled={!canSubmit}
        >
          {phase === 'accepting' ? 'Setting up…' : 'Accept invitation'}
        </button>

        <div className="parent-trust-row">
          <Shield size={14} />
          <span>Secured by Stripe. Your card details are never seen or stored by MI Little Care.</span>
        </div>
      </div>
    </div>
  )
}
