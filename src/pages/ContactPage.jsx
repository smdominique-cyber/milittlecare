import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { Mail, Send, CheckCircle, AlertCircle, Loader, MessageSquare } from 'lucide-react'

const CATEGORIES = [
  { value: 'bug', label: '🐛 Bug or error' },
  { value: 'feature', label: '✨ Feature request' },
  { value: 'help', label: '❓ How do I…?' },
  { value: 'billing', label: '💳 Billing question' },
  { value: 'feedback', label: '💬 General feedback' },
  { value: 'other', label: '📋 Other' },
]

export default function ContactPage() {
  const { user } = useAuth()
  const [form, setForm] = useState({
    subject: '',
    message: '',
    category: 'help',
  })
  const [phase, setPhase] = useState('form')  // form | sending | sent | error
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.subject || !form.message) return
    setPhase('sending')
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers = { 'Content-Type': 'application/json' }
      if (session) headers['Authorization'] = `Bearer ${session.access_token}`

      const resp = await fetch('/api/send-support-message', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...form,
          page_context: window.location.pathname,
          user_agent: navigator.userAgent,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to send')
      setPhase('sent')
    } catch (err) {
      setError(err.message)
      setPhase('form')
    }
  }

  if (phase === 'sent') {
    return (
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{
          background: 'white',
          border: '1px solid var(--clr-warm-mid)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-8)',
          textAlign: 'center',
        }}>
          <div style={{
            width: 64, height: 64, margin: '0 auto 20px',
            background: 'var(--clr-success-pale)', color: 'var(--clr-success)',
            borderRadius: '50%', display: 'grid', placeItems: 'center',
          }}>
            <CheckCircle size={32} />
          </div>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.5rem',
            fontWeight: 400,
            margin: '0 0 12px',
            letterSpacing: '-0.02em',
          }}>
            Message sent! 🎉
          </h2>
          <p style={{ color: 'var(--clr-ink-mid)', lineHeight: 1.55, margin: '0 0 24px' }}>
            Thanks for reaching out. We'll get back to you within 1-2 business days at <strong>{user?.email}</strong>.
          </p>
          <button
            onClick={() => { setPhase('form'); setForm({ subject: '', message: '', category: 'help' }) }}
            className="btn-primary"
            style={{ width: 'auto', display: 'inline-flex' }}
          >
            Send another message
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <div style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <MessageSquare size={20} style={{ color: 'var(--clr-sage-dark)' }} />
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.25rem',
            fontWeight: 400,
            color: 'var(--clr-ink)',
            margin: 0,
            letterSpacing: '-0.02em',
          }}>
            Get in touch
          </h2>
        </div>
        <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.5, margin: 0 }}>
          Found a bug? Have a feature idea? Want to tell us what's working? Send a message — we read everything and respond within 1-2 business days.
        </p>
      </div>

      <div style={{
        background: 'white',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
      }}>
        <form onSubmit={submit}>
          <div className="form-field">
            <label className="form-label">What's this about?</label>
            <select
              className="form-input"
              value={form.category}
              onChange={(e) => setForm(f => ({ ...f, category: e.target.value }))}
            >
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label className="form-label">Subject *</label>
            <input
              type="text"
              className="form-input"
              value={form.subject}
              onChange={(e) => setForm(f => ({ ...f, subject: e.target.value }))}
              placeholder="Brief summary"
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label">Message *</label>
            <textarea
              className="form-input"
              value={form.message}
              onChange={(e) => setForm(f => ({ ...f, message: e.target.value }))}
              placeholder="Tell us what's going on. Include any error messages or what you were trying to do."
              required
              rows={6}
              style={{ resize: 'vertical', minHeight: 120 }}
            />
          </div>

          {user && (
            <p style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)', margin: '4px 0 16px' }}>
              We'll reply to <strong>{user.email}</strong>.
            </p>
          )}

          {error && (
            <div className="auth-message error" style={{ marginBottom: 12 }}>
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={phase === 'sending' || !form.subject || !form.message}
            style={{ width: '100%' }}
          >
            {phase === 'sending' ? (
              <><Loader size={14} className="spin" /> Sending…</>
            ) : (
              <><Send size={14} /> Send message</>
            )}
          </button>
        </form>
      </div>

      <div style={{
        textAlign: 'center',
        marginTop: 'var(--space-4)',
        fontSize: '0.8125rem',
        color: 'var(--clr-ink-soft)',
      }}>
        Or email us directly at <a href="mailto:smdominique@gmail.com" style={{ color: 'var(--clr-sage-dark)' }}>smdominique@gmail.com</a>
      </div>
    </div>
  )
}
