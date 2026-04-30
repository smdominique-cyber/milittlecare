import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import '@/styles/parent.css'

export default function InviteAcceptPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [phase, setPhase] = useState('loading')  // loading | invalid | form | accepting | done | error
  const [error, setError] = useState(null)
  const [invitation, setInvitation] = useState(null)
  const [fullName, setFullName] = useState('')

  useEffect(() => {
    if (!token) {
      setPhase('invalid')
      return
    }
    // Look up basic info about the invitation (public read)
    fetchInvitationPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function fetchInvitationPreview() {
    // Use service role lookup via API
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
    try {
      const resp = await fetch('/api/accept-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept invitation')

      // If we got a magic link, sign in via OTP verification
      if (data.auto_signin_token && data.email) {
        const { error: otpErr } = await supabase.auth.verifyOtp({
          email: data.email,
          token_hash: data.auto_signin_token,
          type: 'email',
        })
        if (otpErr) {
          // Fall back to navigating to magic link URL
          if (data.magic_link) {
            window.location.href = data.magic_link
            return
          }
          throw otpErr
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
