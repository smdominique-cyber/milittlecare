import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, Lock, LogOut, AlertCircle, Loader, Calendar, Zap, CreditCard, X, Clock, Phone, ChevronDown, ChevronUp, Info, Settings, ChevronRight } from 'lucide-react'
import AutopayEnrollment from '@/components/parent/AutopayEnrollment'
import BusinessInfoSection from '@/components/parent/BusinessInfoSection'
import InstallBanner from '@/components/ui/InstallBanner'
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

// Local storage key for the password banner dismissal
const PWBANNER_DISMISSED_KEY = 'mlc_pw_banner_dismissed_v1'

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
  const [enrollingFamily, setEnrollingFamily] = useState(null)
  const [disabling, setDisabling] = useState(false)

  // Password setup state
  const [hasPassword, setHasPassword] = useState(null)  // null = unknown
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [pwFields, setPwFields] = useState({ password: '', confirm: '' })
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMessage, setPwMessage] = useState(null)

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

    setBannerDismissed(localStorage.getItem(PWBANNER_DISMISSED_KEY) === '1')

    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) { setLoading(false); return }
      await loadData(session.user.id)
      await checkHasPassword(session.user.id)
    }
    getSession()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) {
        loadData(session.user.id)
        checkHasPassword(session.user.id)
      }
    })
    return () => authListener?.subscription?.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function checkHasPassword(userId) {
    // Check identities — if there's an identity with provider='email' and the
    // user has a password, identity_data.email_verified will exist. Simpler:
    // we use a stored flag on parent_profiles. If you don't have one, we
    // fall back to: the user can always SET a password; we just won't show the
    // banner if they've explicitly dismissed it OR the profile flag is true.
    const { data } = await supabase
      .from('parent_profiles')
      .select('has_password')
      .eq('id', userId)
      .maybeSingle()
    setHasPassword(!!data?.has_password)
  }

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

  // ─── Password handling ─────────────────
  const dismissBanner = () => {
    localStorage.setItem(PWBANNER_DISMISSED_KEY, '1')
    setBannerDismissed(true)
  }

  const openPasswordModal = () => {
    setPwFields({ password: '', confirm: '' })
    setPwMessage(null)
    setShowPasswordModal(true)
  }

  const savePassword = async () => {
    setPwMessage(null)
    if (pwFields.password.length < 8) {
      setPwMessage({ type: 'error', text: 'Password must be at least 8 characters.' })
      return
    }
    if (pwFields.password !== pwFields.confirm) {
      setPwMessage({ type: 'error', text: "Passwords don't match." })
      return
    }
    setPwSaving(true)
    const { error } = await supabase.auth.updateUser({ password: pwFields.password })
    if (error) {
      setPwMessage({ type: 'error', text: error.message })
      setPwSaving(false)
      return
    }
    // Mark password as set on profile (best-effort; fails silently if column missing)
    if (session?.user?.id) {
      await supabase
        .from('parent_profiles')
        .update({ has_password: true })
        .eq('id', session.user.id)
    }
    setHasPassword(true)
    setPwSaving(false)
    setShowPasswordModal(false)
    setMessage({ type: 'success', text: '✓ Password saved. You can now sign in with email + password.' })
  }

  // ─── Not authenticated ─────────────────
  if (!session && !loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><Lock size={28} /></div>
          <h2>Sign in required</h2>
          <p>Please sign in with your password or use a magic link from your provider's invitation email.</p>
          <button
            className="parent-cta"
            onClick={() => navigate('/login')}
            style={{ marginTop: 16 }}
          >
            Go to sign in
          </button>
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

  // Show password banner if: we know they don't have one AND they haven't dismissed it
  const showPasswordBanner = hasPassword === false && !bannerDismissed

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

        {/* Password setup banner */}
        {showPasswordBanner && (
          <div style={{
            background: 'linear-gradient(135deg, #faf6ec 0%, #f4eee2 100%)',
            border: '1px solid var(--clr-warm-mid)',
            borderRadius: 'var(--radius-lg)',
            padding: 14,
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <Lock size={20} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem', color: 'var(--clr-ink)', marginBottom: 2 }}>
                Skip the email — set a password
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', lineHeight: 1.4 }}>
                Sign in faster next time without waiting for a magic link.
              </div>
            </div>
            <button
              onClick={openPasswordModal}
              style={{
                background: 'var(--clr-sage-dark)',
                border: 'none',
                color: 'white',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.8125rem',
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              Set password
            </button>
            <button
              onClick={dismissBanner}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--clr-ink-soft)',
                padding: 4,
                cursor: 'pointer',
                flexShrink: 0,
              }}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <InstallBanner />

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

        {/* Business info from provider */}
        <BusinessInfoSection providerId={primaryFamily.user_id} providerName={primaryProviderName} />

        {/* Account & security */}
        <section className="parent-section">
          <h3 className="parent-section-title">Account</h3>
          <button
            onClick={openPasswordModal}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '14px 16px',
              background: 'white',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-lg)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-body)',
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Lock size={16} style={{ color: 'var(--clr-sage-dark)' }} />
              <div>
                <div style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--clr-ink)' }}>
                  {hasPassword ? 'Change password' : 'Set a password'}
                </div>
                <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>
                  {hasPassword
                    ? 'Update your sign-in password'
                    : 'Sign in faster without waiting for a magic link'}
                </div>
              </div>
            </div>
            <ChevronRight size={16} style={{ color: 'var(--clr-ink-soft)' }} />
          </button>

          {/* My Family quick link */}
          <button
            onClick={() => navigate('/parent/family')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              padding: '14px 16px',
              background: 'white',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-lg)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-body)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Settings size={16} style={{ color: 'var(--clr-sage-dark)' }} />
              <div>
                <div style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--clr-ink)' }}>My Family</div>
                <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>Update contact info, allergies, emergency contacts</div>
              </div>
            </div>
            <ChevronRight size={16} style={{ color: 'var(--clr-ink-soft)' }} />
          </button>
        </section>

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

      {/* Password modal */}
      {showPasswordModal && (
        <div
          onClick={() => !pwSaving && setShowPasswordModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 20, 17, 0.55)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 'var(--radius-lg)',
              padding: 24,
              width: '100%',
              maxWidth: 420,
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.125rem', margin: 0, color: 'var(--clr-ink)' }}>
                {hasPassword ? 'Change password' : 'Set a password'}
              </h3>
              <button
                onClick={() => !pwSaving && setShowPasswordModal(false)}
                style={{ background: 'none', border: 'none', color: 'var(--clr-ink-soft)', cursor: 'pointer', padding: 4 }}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--clr-ink-mid)', marginTop: 0, marginBottom: 16, lineHeight: 1.5 }}>
              {hasPassword
                ? 'Enter a new password. You can still use a magic link anytime.'
                : 'Set a password so you can sign in without waiting for a magic link. You can still use a magic link if you forget it.'}
            </p>
            <label className="parent-label">New password</label>
            <input
              className="parent-input"
              type="password"
              autoComplete="new-password"
              value={pwFields.password}
              onChange={(e) => setPwFields(f => ({ ...f, password: e.target.value }))}
              placeholder="At least 8 characters"
              disabled={pwSaving}
            />
            <label className="parent-label" style={{ marginTop: 12 }}>Confirm password</label>
            <input
              className="parent-input"
              type="password"
              autoComplete="new-password"
              value={pwFields.confirm}
              onChange={(e) => setPwFields(f => ({ ...f, confirm: e.target.value }))}
              placeholder="Type it again"
              disabled={pwSaving}
            />
            {pwMessage && (
              <div className={pwMessage.type === 'error' ? 'parent-error' : 'parent-message'} style={{ marginTop: 12 }}>
                <AlertCircle size={14} /> {pwMessage.text}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                onClick={() => setShowPasswordModal(false)}
                disabled={pwSaving}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--clr-warm-mid)',
                  color: 'var(--clr-ink-mid)',
                  padding: '10px 16px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={savePassword}
                disabled={pwSaving || !pwFields.password || !pwFields.confirm}
                className="parent-cta"
                style={{ flex: '0 0 auto', width: 'auto', padding: '10px 20px' }}
              >
                {pwSaving ? 'Saving…' : 'Save password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
