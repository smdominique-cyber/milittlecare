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
  const [skipPassword, setSkipPassword] = useState(false)

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

    // Validate password if they're setting one
    if (!skipPassword) {
      if (!password || password.length < 8) {
        setError('Password must be at least 8 characters. Or click "I\'ll set a password later" below.')
        return
      }
      if (password !== confirmPassword) {
        setError("Passwords don't match. Please re-enter.")
        return
      }
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

      // If we successfully signed in via OTP, set the password while we're signed in
      if (signedInViaOtp && !skipPassword && password.length >= 8) {
        const { error: pwErr } = await supabase.auth.updateUser({ password })
        if (pwErr) {
          console.warn('Password set failed:', pwErr.message)
        } else {
          // Mark has_password=true on parent_profiles so login flow knows
          const { data: { user } } = await supabase.auth.getUser()
          if (user) {
            await supabase
              .from('parent_profiles')
              .update({ has_password: true })
              .eq('id', user.id)
          }
        }
      }

      // If OTP sign-in failed and we have a magic_link fallback, redirect to it.
      // NOTE: in this path the password we collected does NOT get applied,
      // because the magic link reloads the page. The parent will need to set
      // a password from their dashboard after signing in. This is acceptable
      // because the dashboard prompts for password setup if has_password=false.
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

        {/* Password section — default ON */}
        {!skipPassword && (
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
                Set a password
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
              You'll be able to sign in with this password going forward. You can also use a magic link sent to your email anytime.
            </p>

            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--clr-warm-mid)' }}>
              <button
                type="button"
                onClick={() => {
                  setSkipPassword(true)
                  setPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--clr-ink-soft)',
                  fontSize: '0.78125rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontFamily: 'var(--font-body)',
                }}
              >
                I'll set a password later
              </button>
            </div>
          </div>
        )}

        {skipPassword && (
          <div style={{
            marginTop: 20,
            padding: 14,
            background: 'var(--clr-warm)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--clr-warm-mid)',
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-mid)',
            lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--clr-ink)' }}>Heads up:</strong> without a password, you'll need to request a magic link by email every time you sign in. You can set a password anytime from your dashboard.
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => { setSkipPassword(false); setError(null) }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--clr-sage-dark)',
                  fontSize: '0.78125rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontFamily: 'var(--font-body)',
                  fontWeight: 500,
                }}
              >
                ← Set a password now
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="parent-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <button
          className="parent-cta"
          onClick={handleAccept}
          disabled={phase === 'accepting' || !fullName.trim()}
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
