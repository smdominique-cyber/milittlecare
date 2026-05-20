import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, AlertCircle, Loader, LogOut, UserPlus, LogIn } from 'lucide-react'
import '@/styles/parent.css'

// Phases:
//   loading       — still fetching invitation preview and/or auth state
//   invalid       — invitation token is bad / expired / revoked
//   unauthed      — caller is signed out; needs to sign up or sign in
//   wrong_account — caller is signed in as a different email than the invitation
//   form          — caller is signed in with the matching email; show the accept button
//   accepting     — accept request in flight
//   done          — accepted, redirecting to /parent
//
// Background: this page used to issue a verifyOtp call against a magic
// link returned by accept-invitation.js, which silently swapped the
// browser's session to the invited identity. That swap exposed
// cross-tenant data when the wrong logged-in user clicked an invitation
// link. The new flow REQUIRES the caller's existing session to match
// the invitation's recipient_email — no OTP swap, no session takeover.
// See incident notes for hotfix/invitation-session-validation.

export default function InviteAcceptPage() {
  const { token } = useParams()
  const navigate = useNavigate()

  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState(null)
  const [invitation, setInvitation] = useState(null)
  const [sessionEmail, setSessionEmail] = useState(null)
  const [fullName, setFullName] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  // Fetch invitation preview AND current auth state in parallel.
  useEffect(() => {
    if (!token) {
      setPhase('invalid')
      return
    }

    let cancelled = false
    let inv = null
    let sess = null

    const loadInvitation = async () => {
      try {
        const resp = await fetch('/api/invitation-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await resp.json()
        if (!resp.ok) {
          if (!cancelled) {
            setError(data.error || 'Invalid invitation')
            setPhase('invalid')
          }
          return null
        }
        return data
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
          setPhase('invalid')
        }
        return null
      }
    }

    const loadSession = async () => {
      const { data } = await supabase.auth.getSession()
      return data?.session?.user?.email || null
    }

    Promise.all([loadInvitation(), loadSession()]).then(([invData, email]) => {
      if (cancelled) return
      inv = invData
      sess = email
      if (!inv) return  // already set phase=invalid above
      setInvitation(inv)
      setSessionEmail(sess)
      setFullName(inv.recipient_name || '')

      if (!sess) {
        setPhase('unauthed')
        return
      }
      const a = String(sess).toLowerCase().trim()
      const b = String(inv.recipient_email || '').toLowerCase().trim()
      if (a !== b) {
        setPhase('wrong_account')
        return
      }
      setPhase('form')
    })

    return () => { cancelled = true }
  }, [token])

  const goToSignup = () => {
    // Hand off to LoginPage with the invite context. LoginPage's
    // existing `from` redirect brings them back here after signup +
    // email confirmation; emailRedirectTo on the signup call points
    // the confirmation email's link back at the same /invite/<token>.
    navigate('/login', {
      state: {
        from: { pathname: `/invite/${token}` },
        inviteEmail: invitation.recipient_email,
      },
    })
  }

  const signOutAndRetry = async () => {
    await supabase.auth.signOut()
    // Stay on the same page; useEffect re-runs on token change is not
    // triggered, so we manually reset state to re-render as unauthed.
    setSessionEmail(null)
    setPhase('unauthed')
  }

  const handleAccept = async () => {
    setError(null)
    if (!fullName.trim()) {
      setError('Please enter your name.')
      return
    }
    setPhase('accepting')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('Your session expired. Sign in again to accept.')
        setPhase('unauthed')
        return
      }
      const resp = await fetch('/api/accept-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept invitation')

      // Record clickwrap acceptance on the user's parent_profiles row
      // (migration 014 adds terms_accepted_at to both profiles and
      // parent_profiles; this is the parent-invite flow, so the row
      // lives in parent_profiles). Try/catch — log failures but don't
      // block; acceptance is enforced UX-side by the disabled-until-
      // checked submit gate.
      try {
        if (session.user?.id) {
          await supabase
            .from('parent_profiles')
            .update({ terms_accepted_at: new Date().toISOString() })
            .eq('id', session.user.id)
        }
      } catch (writeErr) {
        console.error('InviteAcceptPage: terms_accepted_at update failed', writeErr)
      }

      setPhase('done')
      setTimeout(() => navigate('/parent'), 1200)
    } catch (err) {
      setError(err.message)
      setPhase('form')
    }
  }

  // ── Render ────────────────────────────────────────────────────────

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

  if (phase === 'unauthed') {
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
            <strong>{invitation?.provider_name || 'Your provider'}</strong> invited you
            to manage <strong>{invitation?.family_name || 'your family'}</strong>
          </h2>
          <p style={{ color: 'var(--clr-ink-mid)' }}>
            Create an account or sign in to accept. We'll use the email this
            invitation was sent to: <strong>{invitation?.recipient_email}</strong>.
          </p>
          <button className="parent-cta" onClick={goToSignup}>
            <UserPlus size={16} /> Create account or sign in
          </button>
          <div className="parent-trust-row">
            <Shield size={14} />
            <span>Secured by Stripe. Your card details are never seen or stored by MI Little Care.</span>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'wrong_account') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>You're signed in with a different account</h2>
          <p>
            This invitation is for <strong>{invitation?.recipient_email}</strong>,
            but you're currently signed in as <strong>{sessionEmail}</strong>.
            Sign out and click the invitation link again with the right account.
          </p>
          <button className="parent-cta" onClick={signOutAndRetry}>
            <LogOut size={16} /> Sign out
          </button>
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

  // phase === 'form' or 'accepting'
  const accepting = phase === 'accepting'
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
          <strong>{invitation?.provider_name || 'Your provider'}</strong> invited you
          to manage <strong>{invitation?.family_name || 'your family'}</strong>
        </h2>

        <p style={{ color: 'var(--clr-ink-mid)' }}>
          Accept to view invoices, pay online, manage your contact info, and
          stay updated on schedule changes.
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
          Signed in as <strong>{sessionEmail}</strong>
        </div>

        {error && (
          <div className="parent-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
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

        <button
          className="parent-cta"
          onClick={handleAccept}
          disabled={accepting || !fullName.trim() || !agreedToTerms}
        >
          {accepting ? 'Accepting…' : (
            <><LogIn size={14} /> Accept invitation</>
          )}
        </button>

        <div className="parent-trust-row">
          <Shield size={14} />
          <span>Secured by Stripe. Your card details are never seen or stored by MI Little Care.</span>
        </div>
      </div>
    </div>
  )
}
