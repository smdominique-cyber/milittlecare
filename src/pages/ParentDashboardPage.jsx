import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, Lock, LogOut, AlertCircle, Loader, Calendar, Zap, CreditCard, X } from 'lucide-react'
import AutopayEnrollment from '@/components/parent/AutopayEnrollment'
import '@/styles/parent.css'

function formatCurrency(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function shortDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function ParentDashboardPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [families, setFamilies] = useState([])
  const [invoices, setInvoices] = useState([])
  const [providers, setProviders] = useState({})
  const [paying, setPaying] = useState(null)
  const [message, setMessage] = useState(null)
  const [enrollingFamily, setEnrollingFamily] = useState(null)  // family object when modal open
  const [disabling, setDisabling] = useState(false)

  useEffect(() => {
    if (params.get('paid') === '1') {
      setMessage({ type: 'success', text: '🎉 Payment received! Thank you. Your provider has been notified.' })
      setTimeout(() => {
        const next = new URLSearchParams(params)
        next.delete('paid')
        next.delete('invoice_id')
        setParams(next, { replace: true })
      }, 100)
    } else if (params.get('canceled') === '1') {
      setMessage({ type: 'info', text: 'Payment was canceled. You can try again anytime.' })
    }

    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) { setLoading(false); return }
      await loadData(session.user.id)
    }
    getSession()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadData(session.user.id)
    })
    return () => authListener?.subscription?.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadData(parentId) {
    setLoading(true)
    const { data: links } = await supabase
      .from('parent_family_links')
      .select('*, families(*)')
      .eq('parent_id', parentId)
      .eq('status', 'active')

    const familiesData = (links || []).map(l => l.families).filter(Boolean)
    setFamilies(familiesData)

    if (familiesData.length === 0) {
      setLoading(false)
      return
    }

    const familyIds = familiesData.map(f => f.id)
    const { data: invoicesData } = await supabase
      .from('invoices')
      .select('*')
      .in('family_id', familyIds)
      .order('created_at', { ascending: false })
    setInvoices(invoicesData || [])

    const providerIds = [...new Set((links || []).map(l => l.provider_user_id))]
    const providerMap = {}
    for (const pid of providerIds) {
      const { data: prof } = await supabase
        .from('profiles').select('full_name, daycare_name').eq('id', pid).maybeSingle()
      if (prof) providerMap[pid] = prof
    }
    setProviders(providerMap)

    setLoading(false)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    navigate('/')
  }

  const payInvoice = async (invoice) => {
    setPaying(invoice.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/parent-pay-invoice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ invoice_id: invoice.id }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to start payment')
      window.location.href = data.url
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
      setPaying(null)
    }
  }

  const handleAutopayEnrolled = async () => {
    setEnrollingFamily(null)
    setMessage({ type: 'success', text: '🎉 Autopay enabled! You\'ll be charged automatically every Monday.' })
    if (session) await loadData(session.user.id)
  }

  const disableAutopay = async (family) => {
    if (!window.confirm(`Disable autopay for ${family.family_name}? You\'ll go back to paying invoices manually.`)) return
    setDisabling(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const resp = await fetch('/api/disable-autopay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ family_id: family.id }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to disable autopay')
      setMessage({ type: 'info', text: 'Autopay disabled. You can re-enable it anytime.' })
      if (session) await loadData(session.user.id)
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setDisabling(false)
  }

  // ─── Not authenticated ─────────────────
  if (!session && !loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><Lock size={28} /></div>
          <h2>Sign in required</h2>
          <p>Please use the magic link from your provider's invitation email to access your family portal.</p>
          <p style={{ marginTop: 16, fontSize: 14, color: 'var(--clr-ink-soft)' }}>
            Lost your invitation? Contact your child care provider to send a new one.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)', marginBottom: 12 }} />
          <div>Loading…</div>
        </div>
      </div>
    )
  }

  if (families.length === 0) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><AlertCircle size={28} /></div>
          <h2>No families linked yet</h2>
          <p>Your provider hasn't linked you to a family yet, or your invitation may not have been processed correctly.</p>
          <button className="parent-secondary" onClick={signOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>
    )
  }

  const activeInvoices = invoices.filter(inv => !['draft', 'void'].includes(inv.status))
  const totalOwed = activeInvoices.reduce((s, inv) =>
    s + (parseFloat(inv.total) - parseFloat(inv.amount_paid || 0)), 0
  )
  const unpaidInvoices = activeInvoices.filter(inv =>
    parseFloat(inv.total) > parseFloat(inv.amount_paid || 0)
  )
  const paidInvoices = activeInvoices.filter(inv =>
    parseFloat(inv.amount_paid || 0) >= parseFloat(inv.total)
  )

  const primaryFamily = families[0]
  const primaryProvider = providers[primaryFamily.user_id]
  const primaryProviderName = primaryProvider?.daycare_name || primaryProvider?.full_name || 'Your provider'

  return (
    <div className="parent-shell">
      <div className="parent-container">
        <header className="parent-topbar">
          <div className="parent-brand">
            <div className="parent-brand-mark">🏠</div>
            <div>
              <div className="parent-brand-name">MI Little Care</div>
              <div className="parent-brand-tag">FAMILY PORTAL</div>
            </div>
          </div>
          <button className="parent-signout-btn" onClick={signOut} title="Sign out">
            <LogOut size={16} />
          </button>
        </header>

        {message && (
          <div className={`parent-message ${message.type}`}>
            <span>{message.text}</span>
          </div>
        )}

        {/* Hero balance */}
        <div className="parent-hero">
          <div className="parent-hero-label">{primaryFamily.family_name} · with {primaryProviderName}</div>
          <div className="parent-hero-value">{formatCurrency(totalOwed)}</div>
          <div className="parent-hero-sub">
            {totalOwed > 0
              ? `Currently owed across ${unpaidInvoices.length} ${unpaidInvoices.length === 1 ? 'invoice' : 'invoices'}`
              : primaryFamily.autopay_enabled
                ? 'You\'re all caught up — autopay handles the rest.'
                : 'You\'re all caught up — nothing owed!'}
          </div>
        </div>

        {/* Autopay status / enrollment */}
        {primaryFamily.autopay_enabled ? (
          <div className="parent-autopay-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Zap size={16} style={{ color: 'var(--clr-accent)' }} />
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
                    Autopay is on
                  </span>
                  <span className="parent-autopay-badge"><CheckCircle size={11} /> Active</span>
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)' }}>
                  We'll automatically charge your saved card every Monday at 9 AM.
                </div>
              </div>
              <button
                onClick={() => disableAutopay(primaryFamily)}
                disabled={disabling}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--clr-ink-soft)',
                  fontSize: '0.78125rem',
                  cursor: 'pointer',
                  padding: 4,
                  textDecoration: 'underline',
                }}
                title="Disable autopay"
              >
                Disable
              </button>
            </div>
          </div>
        ) : (
          <div className="parent-autopay-cta-card">
            <div className="parent-autopay-cta-card-title">⚡ Set up Autopay</div>
            <div className="parent-autopay-cta-card-text">
              Save your card so {primaryProviderName} gets paid automatically every Monday. No more invoice reminders.
            </div>
            <button
              className="parent-cta"
              onClick={() => setEnrollingFamily(primaryFamily)}
              style={{ width: 'auto', display: 'inline-flex' }}
            >
              <CreditCard size={16} /> Set up Autopay
            </button>
          </div>
        )}

        {/* Unpaid invoices */}
        {unpaidInvoices.length > 0 && (
          <section className="parent-section">
            <h3 className="parent-section-title">
              {primaryFamily.autopay_enabled ? 'Coming up' : 'Pay now'}
            </h3>
            {unpaidInvoices.map(inv => {
              const balance = parseFloat(inv.total) - parseFloat(inv.amount_paid || 0)
              const isAutopay = primaryFamily.autopay_enabled && inv.status === 'sent'
              return (
                <div key={inv.id} className="parent-invoice-card">
                  <div className="parent-invoice-row">
                    <div className="parent-invoice-info">
                      <div className="parent-invoice-num">
                        {inv.invoice_number || `Invoice ${inv.id.slice(0, 8)}`}
                      </div>
                      <div className="parent-invoice-meta">
                        <Calendar size={12} />
                        {shortDate(inv.period_start)} – {shortDate(inv.period_end)}
                        {inv.due_date && <span> · Due {formatDate(inv.due_date)}</span>}
                      </div>
                    </div>
                    <div className="parent-invoice-amount">{formatCurrency(balance)}</div>
                  </div>
                  {isAutopay ? (
                    <div style={{
                      marginTop: 10, padding: '8px 12px',
                      background: 'var(--clr-warm)', borderRadius: 'var(--radius-md)',
                      fontSize: '0.78125rem', color: 'var(--clr-ink-mid)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <Zap size={12} style={{ color: 'var(--clr-accent)' }} />
                      Will be charged Monday via Autopay
                    </div>
                  ) : (
                    <button
                      className="parent-cta"
                      onClick={() => payInvoice(inv)}
                      disabled={paying === inv.id}
                      style={{ width: '100%', marginTop: 12 }}
                    >
                      {paying === inv.id ? (
                        <><Loader size={16} className="spin" /> Loading…</>
                      ) : (
                        <>💳 Pay {formatCurrency(balance)}</>
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {/* Payment history */}
        {paidInvoices.length > 0 && (
          <section className="parent-section">
            <h3 className="parent-section-title">Payment history</h3>
            <div className="parent-history">
              {paidInvoices.slice(0, 10).map(inv => (
                <div key={inv.id} className="parent-history-row">
                  <div className="parent-history-icon"><CheckCircle size={16} /></div>
                  <div className="parent-history-info">
                    <div className="parent-history-amount">{formatCurrency(inv.total)}</div>
                    <div className="parent-history-date">
                      Paid {inv.paid_at ? formatDate(inv.paid_at.split('T')[0]) : 'recently'}
                      <span> · {shortDate(inv.period_start)} – {shortDate(inv.period_end)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="parent-trust-row">
          <Shield size={14} />
          <span>Secured by Stripe. MI Little Care never sees your card details.</span>
        </div>
      </div>

      {/* Autopay enrollment modal */}
      {enrollingFamily && (
        <AutopayEnrollment
          family={enrollingFamily}
          providerName={primaryProviderName}
          onClose={() => setEnrollingFamily(null)}
          onEnrolled={handleAutopayEnrolled}
        />
      )}
    </div>
  )
}
