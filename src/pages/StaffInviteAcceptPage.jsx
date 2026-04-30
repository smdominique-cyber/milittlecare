import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Loader, AlertCircle, CheckCircle, Shield, Lock, ArrowRight } from 'lucide-react'

const ROLE_LABELS = {
  adult_staff: 'Adult Staff',
  assistant: 'Assistant',
  view_only: 'View-only',
}

export default function StaffInviteAcceptPage() {
  const { token } = useParams()
  const navigate = useNavigate()
  const [phase, setPhase] = useState('loading')  // loading | preview | accepting | success | error
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const [fullName, setFullName] = useState('')

  useEffect(() => { loadPreview() }, [token])

  async function loadPreview() {
    try {
      const resp = await fetch('/api/staff-invitation-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to load invitation')
      setInfo(data)
      setFullName(data.recipient_name || '')
      setPhase('preview')
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

  const accept = async () => {
    setPhase('accepting')
    setError(null)
    try {
      const resp = await fetch('/api/accept-staff-invitation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to accept')

      // Sign in via magic link
      if (data.magic_link) {
        // Extract the token_hash and type from the magic link URL
        const url = new URL(data.magic_link)
        const hashedToken = url.searchParams.get('token') || data.auto_signin_token
        if (hashedToken) {
          const { error: verifyErr } = await supabase.auth.verifyOtp({
            token_hash: hashedToken,
            type: 'magiclink',
          })
          if (!verifyErr) {
            setPhase('success')
            setTimeout(() => navigate('/dashboard'), 2000)
            return
          }
        }
      }
      setPhase('success')
      setTimeout(() => navigate('/dashboard'), 2000)
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

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

  if (phase === 'error') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>Invitation issue</h2>
          <p style={{ color: 'var(--clr-error)' }}>{error}</p>
          <p style={{ marginTop: 16, fontSize: 14, color: 'var(--clr-ink-soft)' }}>
            Contact the licensee who sent the invitation to resolve this.
          </p>
        </div>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon" style={{ background: 'var(--clr-success-pale)', color: 'var(--clr-success)' }}>
            <CheckCircle size={32} />
          </div>
          <h2>Welcome to the team! 🎉</h2>
          <p>You're being signed in…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="parent-shell">
      <div className="parent-card" style={{ maxWidth: 480 }}>
        <div className="parent-icon"><Shield size={28} /></div>
        <h2>Join {info?.licensee_name}</h2>
        <p>You've been invited as <strong>{ROLE_LABELS[info?.role] || info?.role}</strong>.</p>

        <div style={{
          background: 'var(--clr-cream)', padding: 16, borderRadius: 8, margin: '20px 0',
          fontSize: '0.875rem', color: 'var(--clr-ink-mid)', textAlign: 'left',
        }}>
          <strong style={{ display: 'block', marginBottom: 8 }}>What happens next:</strong>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>An account is created using <strong>{info?.recipient_email}</strong></li>
            <li>You'll be auto-signed in</li>
            <li>You'll get access to {info?.licensee_name}'s daily operations</li>
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

        <button
          className="parent-cta"
          onClick={accept}
          disabled={phase === 'accepting'}
          style={{ width: '100%' }}
        >
          {phase === 'accepting' ? (
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
