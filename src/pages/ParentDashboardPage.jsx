import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Shield, CheckCircle, Lock, LogOut, AlertCircle, Loader, Calendar, Zap, CreditCard, X, Clock, Phone, ChevronDown, ChevronUp, Info, Settings, ChevronRight, MessageCircle, LogIn } from 'lucide-react'
import AutopayEnrollment from '@/components/parent/AutopayEnrollment'
import BusinessInfoSection from '@/components/parent/BusinessInfoSection'
import AcknowledgmentBanner from '@/components/parent/AcknowledgmentBanner'
import EnrollmentConsentsPendingBanner from '@/components/parent/EnrollmentConsentsPendingBanner'
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

function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nowHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTimeDisplay(t) {
  if (!t) return ''
  const [h, m] = t.split(':')
  const hour24 = parseInt(h)
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24
  const ampm = hour24 >= 12 ? 'PM' : 'AM'
  return `${hour12}:${m} ${ampm}`
}

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

  // Today widget state
  const [children, setChildren] = useState([])
  const [attendance, setAttendance] = useState([])
  const [working, setWorking] = useState(null)

  // Password setup state
  const [hasPassword, setHasPassword] = useState(null)
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

  // Re-fetch attendance every 30s so provider-recorded check-outs show up
  useEffect(() => {
    if (!session || families.length === 0) return
    const intervalId = setInterval(() => loadAttendanceOnly(), 30000)
    return () => clearInterval(intervalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, families])

  async function checkHasPassword(userId) {
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

    const [invoicesResp, childrenResp, attendanceResp] = await Promise.all([
      supabase
        .from('invoices')
        .select('*')
        .in('family_id', familyIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('children')
        .select('id, first_name, last_name, family_id')
        .in('family_id', familyIds)
        .is('archived_at', null),
      supabase
        .from('attendance')
        .select('*')
        .eq('date', todayYMD()),
    ])
    setInvoices(invoicesResp.data || [])
    setChildren(childrenResp.data || [])

    const childIds = new Set((childrenResp.data || []).map(c => c.id))
    setAttendance((attendanceResp.data || []).filter(a => childIds.has(a.child_id)))

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

  async function loadAttendanceOnly() {
    if (children.length === 0) return
    const childIds = children.map(c => c.id)
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('date', todayYMD())
      .in('child_id', childIds)
    if (data) setAttendance(data)
  }

  // ─── Drop-off / pickup actions ─────────────────
  const handleDropOff = async (child) => {
    if (!session) return
    setWorking(child.id)
    const today = todayYMD()
    const now = nowHHMM()
    const { data: family } = await supabase
      .from('families')
      .select('user_id')
      .eq('id', child.family_id)
      .single()

    if (!family) {
      setMessage({ type: 'error', text: 'Could not record drop-off — family not found.' })
      setWorking(null)
      return
    }

    const { error } = await supabase
      .from('attendance')
      .upsert({
        user_id: family.user_id,
        child_id: child.id,
        date: today,
        segment_index: 0,  // parent drop-off writes single-segment days; matches migration 019's unique key
        check_in: now,
        status: 'present',
        checked_in_by: 'parent',
        checked_in_by_user_id: session.user.id,
      }, { onConflict: 'child_id,date,segment_index' })
    setWorking(null)
    if (error) {
      setMessage({ type: 'error', text: `Could not record drop-off: ${error.message}` })
    } else {
      setMessage({ type: 'success', text: `✓ ${child.first_name} dropped off at ${formatTimeDisplay(now)}` })
      await loadAttendanceOnly()
    }
  }

  // ─── New: Undo a parent-recorded drop-off ─────
  // Only works if the parent themselves recorded the check-in (checked_in_by='parent').
  // If the provider recorded it, this is locked — only the provider can undo.
  const handleUndoDropOff = async (child) => {
    if (!session) return
    if (!window.confirm(`Undo ${child.first_name}'s drop-off? This will remove the check-in record.`)) return
    setWorking(child.id)
    const today = todayYMD()
    const { error } = await supabase
      .from('attendance')
      .delete()
      .eq('child_id', child.id)
      .eq('date', today)
      .eq('checked_in_by', 'parent')
    setWorking(null)
    if (error) {
      setMessage({ type: 'error', text: `Could not undo: ${error.message}` })
    } else {
      setMessage({ type: 'success', text: `✓ ${child.first_name}'s drop-off was undone` })
      await loadAttendanceOnly()
    }
  }

  const getRecord = (childId) => {
    return attendance.find(a => a.child_id === childId)
  }

  // ─── Other handlers ─────────────────
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

        {/* Acknowledgment digest banner (PR #12) */}
        {session?.user?.id && <AcknowledgmentBanner parentId={session.user.id} />}

        {/* Consents Phase A (2026-05-30) — enrollment-consent discovery banner.
            Informational only: in Phase A there is no parent-portal
            self-confirm path for these consents (P3); the banner links to
            the read-only Consents tab and the copy frames the action as
            "talk to your provider." A future Phase B with a generalized
            parent-confirm RPC can flip this to an actionable surface. */}
        {session?.user?.id && (
          <EnrollmentConsentsPendingBanner
            parentId={session.user.id}
            children={children}
          />
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

        {/* ─── Today / drop-off section ─── */}
        {children.length > 0 && (
          <section className="parent-section">
            <h3 className="parent-section-title">Today</h3>
            <div style={{
              background: 'white',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-lg)',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}>
              {children.map(child => {
                const rec = getRecord(child.id)
                const isWorking = working === child.id

                let state
                if (!rec) state = 'not_arrived'
                else if (rec.status === 'absent') state = 'absent'
                else if (rec.check_in && rec.check_out) state = 'done'
                else if (rec.check_in) state = 'here'
                else state = 'not_arrived'

                return (
                  <div
                    key={child.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 0',
                      borderTop: child === children[0] ? 'none' : '1px solid var(--clr-warm-mid)',
                      paddingTop: child === children[0] ? 0 : 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: 'var(--font-display)',
                        fontSize: '1rem',
                        color: 'var(--clr-ink)',
                        fontWeight: 500,
                      }}>
                        {child.first_name} {child.last_name}
                      </div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', marginTop: 2 }}>
                        {state === 'not_arrived' && (
                          <span style={{ color: 'var(--clr-ink-soft)' }}>Not yet at daycare</span>
                        )}
                        {state === 'here' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} style={{ color: 'var(--clr-success)' }} />
                            Dropped off at {formatTimeDisplay(rec.check_in)}
                            {rec.checked_in_by === 'parent' && (
                              <span style={{
                                fontSize: '0.625rem',
                                background: 'var(--clr-cream)',
                                color: 'var(--clr-sage-dark)',
                                padding: '1px 6px',
                                borderRadius: 'var(--radius-full)',
                                fontWeight: 600,
                                marginLeft: 4,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}>by you</span>
                            )}
                          </span>
                        )}
                        {state === 'done' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} style={{ color: 'var(--clr-success)' }} />
                            {formatTimeDisplay(rec.check_in)} – {formatTimeDisplay(rec.check_out)}
                          </span>
                        )}
                        {state === 'absent' && (
                          <span style={{ color: 'var(--clr-ink-soft)' }}>Marked absent</span>
                        )}
                      </div>
                    </div>
                    <div>
                      {state === 'not_arrived' && (
                        <button
                          className="parent-cta"
                          onClick={() => handleDropOff(child)}
                          disabled={isWorking}
                          style={{
                            width: 'auto',
                            padding: '10px 16px',
                            fontSize: '0.875rem',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <LogIn size={14} />
                          {isWorking ? 'Saving…' : 'Drop Off'}
                        </button>
                      )}
                      {state === 'here' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontSize: '0.78125rem',
                            color: 'var(--clr-success)',
                            fontWeight: 500,
                            padding: '6px 10px',
                            background: 'var(--clr-success-pale)',
                            borderRadius: 'var(--radius-full)',
                          }}>
                            At daycare
                          </span>
                          {rec.checked_in_by === 'parent' && (
                            <button
                              onClick={() => handleUndoDropOff(child)}
                              disabled={isWorking}
                              title="Undo drop-off (mistake)"
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--clr-warm-mid)',
                                color: 'var(--clr-ink-soft)',
                                padding: '6px 10px',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.78125rem',
                                cursor: 'pointer',
                                fontFamily: 'var(--font-body)',
                              }}
                            >
                              {isWorking ? '…' : 'Undo'}
                            </button>
                          )}
                        </div>
                      )}
                      {state === 'done' && (
                        <span style={{
                          fontSize: '0.78125rem',
                          color: 'var(--clr-ink-soft)',
                          fontWeight: 500,
                          padding: '6px 10px',
                          background: 'var(--clr-cream)',
                          borderRadius: 'var(--radius-full)',
                        }}>
                          Picked up ✓
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

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
            onClick={() => navigate('/parent/messages')}
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
              <MessageCircle size={16} style={{ color: 'var(--clr-sage-dark)' }} />
              <div>
                <div style={{ fontSize: '0.9375rem', fontWeight: 500, color: 'var(--clr-ink)' }}>Messages</div>
                <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>View updates and photos from {primaryProviderName}</div>
              </div>
            </div>
            <ChevronRight size={16} style={{ color: 'var(--clr-ink-soft)' }} />
          </button>

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
