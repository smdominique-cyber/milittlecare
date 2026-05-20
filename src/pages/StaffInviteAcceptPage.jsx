import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Loader, AlertCircle, CheckCircle, Shield, Lock, ArrowRight, LogOut, UserPlus } from 'lucide-react'

const ROLE_LABELS = {
  adult_staff: 'Co-Provider',
  assistant: 'Daily Helper',
  view_only: 'View-only',
}

const ROLE_DESCRIPTIONS = {
  adult_staff: 'You\'ll have full access to families, billing, attendance, messages, receipts, and reports.',
  assistant: 'You\'ll have access to attendance, messages, and family info — no access to billing or financial information.',
  view_only: 'You\'ll be able to view deductions, T/S ratios, and attendance reports — but cannot edit anything.',
}

// Phases:
//   loading       — still fetching invitation preview and/or auth state
//   invalid       — invitation token is bad / expired / revoked
//   unauthed      — caller is signed out; needs to sign up or sign in
//   wrong_account — caller is signed in as a different email than the invitation
//   form          — caller is signed in with the matching email; show the join button
//   accepting     — accept request in flight
//   done          — accepted, redirecting to /dashboard
//
// Background: this page used to issue a verifyOtp call against a magic
// link returned by accept-staff-invitation.js, which silently swapped
// the browser's session to the invited identity. For staff that swap
// could expose an entire licensee's families, billing, attendance, and
// messages. The new flow REQUIRES the caller's existing session to
// match the invitation's recipient_email — no OTP swap, no session
// takeover. See incident notes for hotfix/invitation-session-validation.

export default function StaffInviteAcceptPage() {
  const { token } = useParams()
  const navigate = useNavigate()

  const [phase, setPhase] = useState('loading')
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const [sessionEmail, setSessionEmail] = useState(null)
  const [fullName, setFullName] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)

  useEffect(() => {
    if (!token) {
      setPhase('invalid')
      return
    }

    let cancelled = false

    const loadPreview = async () => {
      try {
        const resp = await fetch('/api/staff-invitation-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await resp.json()
        if (!resp.ok) {
          if (!cancelled) {
            setError(data.error || 'Failed to load invitation')
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

    Promise.all([loadPreview(), loadSession()]).then(([invData, email]) => {
      if (cancelled) return
      if (!invData) return  // already set phase=invalid above
      setInfo(invData)
      setSessionEmail(email)
      setFullName(invData.recipient_name || '')

      if (!email) {
        setPhase('unauthed')
        return
      }
      const a = String(email).toLowerCase().trim()
      const b = String(invData.recipient_email || '').toLowerCase().trim()
      if (a !== b) {
        setPhase('wrong_account')
        return
      }
      setPhase('form')
    })

    return () => { cancelled = true }
  }, [token])

  const goToSignup = () => {
    // LoginPage's `from` redirect brings the user back to
    // /staff-invite/<token> after signup + email confirmation;
    // emailRedirectTo on the signup call points the confirmation
    // email's link to the same path.
    navigate('/login', {
      state: {
        from: { pathname: `/staff-invite/${token}` },
        inviteEmail: info.recipient_email,
      },
    })
  }

  const signOutAndRetry = async () => {
    await supabase.auth.signOut()
    setSessionEmail(null)
    setPhase('unauthed')
  }

  const accept = async () => {
    setError(null)
    setPhase('accepting')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setError('Your session expired. Sign in again to accept.')
        setPhase('unauthed')
        return
      }
      const resp = await fetch('/api/accept-staff-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept')

      // Record clickwrap acceptance on the user's profiles row
      // (migration 014). Try/catch — log failures but don't block;
      // acceptance is enforced UX-side by the disabled-until-checked
      // submit gate.
      try {
        if (session.user?.id) {
          await supabase
            .from('profiles')
            .update({ terms_accepted_at: new Date().toISOString() })
            .eq('id', session.user.id)
        }
      } catch (writeErr) {
        console.error('StaffInviteAcceptPage: terms_accepted_at update failed', writeErr)
      }

      setPhase('done')
      setTimeout(() => navigate('/dashboard'), 1500)
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
          <div>Loading invitation…</div>
        </div>
      </div>
    )
  }

  if (phase === 'invalid') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>Invitation issue</h2>
          <p style={{ color: 'var(--clr-error)' }}>{error || 'This invitation is no longer valid.'}</p>
          <p style={{ marginTop: 16, fontSize: 14, color: 'var(--clr-ink-soft)' }}>
            Contact the licensee who sent the invitation to resolve this.
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'unauthed') {
    return (
      <div className="parent-shell">
        <div className="parent-card" style={{ maxWidth: 480 }}>
          <div className="parent-icon"><Shield size={28} /></div>
          <h2>Join {info?.licensee_name}</h2>
          <p>
            Create an account or sign in to accept. We'll use the email this
            invitation was sent to: <strong>{info?.recipient_email}</strong>.
          </p>
          <button className="parent-cta" onClick={goToSignup} style={{ width: '100%' }}>
            <UserPlus size={16} /> Create account or sign in
          </button>
          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--clr-ink-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Lock size={11} /> Secured by MI Little Care
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'wrong_account') {
    return (
      <div className="parent-shell">
        <div className="parent-card" style={{ maxWidth: 480 }}>
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>You're signed in with a different account</h2>
          <p>
            This invitation is for <strong>{info?.recipient_email}</strong>,
            but you're currently signed in as <strong>{sessionEmail}</strong>.
            Sign out and click the invitation link again with the right account.
          </p>
          <button className="parent-cta" onClick={signOutAndRetry} style={{ width: '100%' }}>
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
          <div className="parent-icon" style={{ background: 'var(--clr-success-pale)', color: 'var(--clr-success)' }}>
            <CheckCircle size={32} />
          </div>
          <h2>Welcome to the team! 🎉</h2>
          <p>Taking you to the dashboard…</p>
        </div>
      </div>
    )
  }

  // phase === 'form' or 'accepting'
  const accepting = phase === 'accepting'
  const roleLabel = ROLE_LABELS[info?.role] || info?.role
  const roleDesc = ROLE_DESCRIPTIONS[info?.role] || ''

  return (
    <div className="parent-shell">
      <div className="parent-card" style={{ maxWidth: 480 }}>
        <div className="parent-icon"><Shield size={28} /></div>
        <h2>Join {info?.licensee_name}</h2>
        <p>You've been invited as <strong>{roleLabel}</strong>.</p>

        {roleDesc && (
          <div style={{
            background: 'var(--clr-cream)', padding: 14, borderRadius: 8, margin: '12px 0 0',
            fontSize: '0.875rem', color: 'var(--clr-ink-mid)', textAlign: 'left',
            lineHeight: 1.5,
          }}>
            {roleDesc}
          </div>
        )}

        <div style={{
          background: 'var(--clr-cream)', padding: 16, borderRadius: 8, margin: '20px 0',
          fontSize: '0.875rem', color: 'var(--clr-ink-mid)', textAlign: 'left',
        }}>
          <strong style={{ display: 'block', marginBottom: 8 }}>What happens when you join:</strong>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>Your account <strong>{sessionEmail}</strong> gets linked to {info?.licensee_name}'s team</li>
            <li>You'll land on the dashboard with {roleLabel} access</li>
          </ul>
        </div>

        <div style={{ textAlign: 'left', marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--clr-ink-mid)', marginBottom: 6 }}>
            Your name (optional)
          </label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Jane Smith"
            style={{
              width: '100%', padding: '10px 12px', border: '1.5px solid var(--clr-warm-mid)',
              borderRadius: 8, fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>

        {error && (
          <div className="parent-error" style={{ marginBottom: 12 }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', marginBottom: 12 }}>
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
          onClick={accept}
          disabled={accepting || !agreedToTerms}
          style={{ width: '100%' }}
        >
          {accepting ? (
            <><Loader size={16} className="spin" /> Joining…</>
          ) : (
            <>Join the team <ArrowRight size={14} /></>
          )}
        </button>

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--clr-ink-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Lock size={11} /> Secured by MI Little Care
        </div>
      </div>
    </div>
  )
}
