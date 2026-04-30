import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, Lock, LogOut, FileText, AlertCircle, Loader, Download, Calendar } from 'lucide-react'
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
  const [providers, setProviders] = useState({})  // user_id -> {name, daycare_name}
  const [paying, setPaying] = useState(null)  // invoice_id being paid
  const [message, setMessage] = useState(null)

  useEffect(() => {
    // Check for success message from Stripe redirect
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

    // Get session
    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) {
        setLoading(false)
        return
      }
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
    // Get linked families
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

    // Get invoices for those families
    const familyIds = familiesData.map(f => f.id)
    const { data: invoicesData } = await supabase
      .from('invoices')
      .select('*')
      .in('family_id', familyIds)
      .order('created_at', { ascending: false })

    setInvoices(invoicesData || [])

    // Get provider names (one per linked family)
    const providerIds = [...new Set((links || []).map(l => l.provider_user_id))]
    const providerMap = {}
    for (const pid of providerIds) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name, daycare_name')
        .eq('id', pid)
        .maybeSingle()
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

  // ─── No linked families ────────────────
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

  // ─── Calculate balances ────────────────
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

  // For now, show data for first family (most parents have just one)
  const primaryFamily = families[0]
  const primaryProvider = providers[primaryFamily.user_id]
  const primaryProviderName = primaryProvider?.daycare_name || primaryProvider?.full_name || 'Your provider'

  return (
    <div className="parent-shell">
      <div className="parent-container">
        {/* Top nav */}
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
              : 'You\'re all caught up — nothing owed!'}
          </div>
        </div>

        {/* Unpaid invoices */}
        {unpaidInvoices.length > 0 && (
          <section className="parent-section">
            <h3 className="parent-section-title">Pay now</h3>
            {unpaidInvoices.map(inv => {
              const balance = parseFloat(inv.total) - parseFloat(inv.amount_paid || 0)
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
                  <button
                    className="parent-cta"
                    onClick={() => payInvoice(inv)}
                    disabled={paying === inv.id}
                    style={{ width: '100%', marginTop: 12 }}
                  >
                    {paying === inv.id ? (
                      <>
                        <Loader size={16} className="spin" /> Loading…
                      </>
                    ) : (
                      <>
                        💳 Pay {formatCurrency(balance)}
                      </>
                    )}
                  </button>
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

        {/* Trust footer */}
        <div className="parent-trust-row">
          <Shield size={14} />
          <span>Secured by Stripe. MI Little Care never sees your card details.</span>
        </div>
      </div>
    </div>
  )
}
