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
  const [usePassword, setUsePassword] = useState(true)

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
    setPhase('accepting')
    setError(null)

    // Validate password if they chose to set one
    if (usePassword && password.length > 0 && password.length < 8) {
      setError('Password must be at least 8 characters.')
      setPhase('form')
      return
    }

    try {
      const resp = await fetch('/api/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept invitation')

      // Sign in via OTP verification
      if (data.auto_signin_token && data.email) {
        const { error: otpErr } = await supabase.auth.verifyOtp({
          email: data.email,
          token_hash: data.auto_signin_token,
          type: 'email',
        })
        if (otpErr) {
          if (data.magic_link) {
            window.location.href = data.magic_link
            return
          }
          throw otpErr
        }
      }

      // Now that we're signed in, set the password if they chose to
      if (usePassword && password.length >= 8) {
        const { error: pwErr } = await supabase.auth.updateUser({ password })
        if (pwErr) {
          // Don't fail the whole flow — they're signed in, just couldn't set the password
          console.warn('Password set failed:', pwErr.message)
        }
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

        {/* Password section */}
        <div style={{
          marginTop: 20,
          padding: 16,
          background: 'var(--clr-cream)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--clr-warm-mid)',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: usePassword ? 12 : 0 }}>
            <input
              type="checkbox"
              checked={usePassword}
              onChange={(e) => setUsePassword(e.target.checked)}
            />
            <span style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
              <Lock size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} />
              Set a password (recommended)
            </span>
          </label>

          {usePassword ? (
            <>
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
              <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', marginTop: 8, marginBottom: 0, lineHeight: 1.5 }}>
                You'll be able to sign in with this password going forward. You can also still use a magic link sent to your email anytime.
              </p>
            </>
          ) : (
            <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', margin: 0, lineHeight: 1.5 }}>
              You can skip this and sign in via email magic link each time. You can set a password later from your dashboard.
            </p>
          )}
        </div>

        {error && (
          <div className="parent-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <button
          className="parent-cta"
          onClick={handleAccept}
          disabled={phase === 'accepting' || !fullName.trim() || (usePassword && password.length > 0 && password.length < 8)}
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
