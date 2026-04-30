import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { useNavigate } from 'react-router-dom'
import {
  DollarSign, AlertCircle, CheckCircle, ScanLine, Sparkles,
  Users, Send, Plus, Calculator,
} from 'lucide-react'

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatCurrency(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatCurrencyShort(n) {
  const num = parseFloat(n || 0)
  if (num === 0) return '$0'
  return '$' + Math.round(num).toLocaleString()
}

function shortDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function categoryEmoji(cat) {
  const map = {
    'Groceries': '🛒', 'Office Supplies': '📎', 'Meals': '🍽️',
    'Vehicle': '⛽', 'Utilities': '💡', 'Insurance': '🛡️',
    'Cleaning & Household': '🧽', 'Toys & Activities': '🧸',
    'Education': '📚', 'Professional Services': '💼',
    'Repairs & Maintenance': '🔧', 'Health & Safety': '🏥', 'Other': '📋',
  }
  return map[cat] || '📋'
}

function categoryClass(cat) {
  const map = {
    'Groceries': 'grocery', 'Office Supplies': 'office',
    'Meals': 'meal', 'Vehicle': 'vehicle',
  }
  return map[cat] || 'misc'
}

export default function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const firstName = user?.user_metadata?.full_name?.split(' ')[0] || 'there'
  const greeting = getGreeting()

  const [loading, setLoading] = useState(true)
  const [families, setFamilies] = useState([])
  const [invoices, setInvoices] = useState([])
  const [receipts, setReceipts] = useState([])
  const [tsRatio, setTsRatio] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    if (!user) return
    setLoading(true)
    const currentYear = new Date().getFullYear()
    const [f, i, r, t] = await Promise.all([
      supabase.from('families').select('*').eq('user_id', user.id),
      supabase.from('invoices').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('receipts').select('*').eq('user_id', user.id).order('purchase_date', { ascending: false }).limit(10),
      supabase.from('ts_ratios').select('*').eq('user_id', user.id).eq('tax_year', currentYear).maybeSingle(),
    ])
    setFamilies(f.data || [])
    setInvoices(i.data || [])
    setReceipts(r.data || [])
    setTsRatio(t.data)
    setLoading(false)
  }

  const activeInvoices = invoices.filter(inv => !['draft', 'void'].includes(inv.status))
  const totalBilled = activeInvoices.reduce((s, inv) => s + parseFloat(inv.total || 0), 0)
  const totalPaid = activeInvoices.reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)
  const totalOutstanding = totalBilled - totalPaid

  const weekStart = getMonday(new Date())
  const paidThisWeek = invoices
    .filter(inv => inv.paid_at && new Date(inv.paid_at) >= weekStart)
    .reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)

  const overdueInvoices = invoices.filter(inv => inv.status === 'overdue')
  const pendingApproval = invoices.filter(inv => inv.status === 'pending_approval')

  const familiesOwing = families
    .map(family => {
      const fInvoices = activeInvoices.filter(inv => inv.family_id === family.id)
      const billed = fInvoices.reduce((s, inv) => s + parseFloat(inv.total || 0), 0)
      const paid = fInvoices.reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)
      return { family, outstanding: billed - paid }
    })
    .filter(f => f.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 5)

  const currentYear = new Date().getFullYear()
  const yearReceipts = receipts.filter(r => {
    if (!r.purchase_date) return false
    return new Date(r.purchase_date).getFullYear() === currentYear
  })
  const totalDeductions = yearReceipts.reduce((s, r) => s + parseFloat(r.total || 0), 0)
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const receiptsThisMonth = receipts.filter(r => r.created_at && new Date(r.created_at) >= monthStart).length

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  // Empty state for brand-new users
  if (families.length === 0 && receipts.length === 0) {
    return (
      <>
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>{greeting}, <em>{firstName}</em> 👋</h2>
            <p>
              Welcome to MI Little Care. Let's get you set up — it takes about 5 minutes
              to add your first family and send their first invoice.
            </p>
          </div>
          <button className="welcome-cta" onClick={() => navigate('/families')}>
            <Plus size={16} /> Add your first family
          </button>
        </div>

        <div style={{
          background: 'var(--clr-white)',
          border: '1px solid var(--clr-warm-mid)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-8)',
          marginTop: 'var(--space-6)',
        }}>
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.125rem',
            fontWeight: 400,
            color: 'var(--clr-ink)',
            marginBottom: 'var(--space-4)',
            letterSpacing: '-0.01em',
          }}>
            Quick start
          </h3>
          <div className="quick-actions">
            <button className="quick-action-btn" onClick={() => navigate('/families')}>
              <div className="qa-icon primary"><Users /></div>
              <div>
                <div className="qa-label">Add a family</div>
                <div className="qa-desc">Start tracking enrollment and billing</div>
              </div>
            </button>
            <button className="quick-action-btn" onClick={() => navigate('/receipts')}>
              <div className="qa-icon accent"><ScanLine /></div>
              <div>
                <div className="qa-label">Scan a receipt</div>
                <div className="qa-desc">Try the AI scanner with any receipt</div>
              </div>
            </button>
            <button className="quick-action-btn" onClick={() => navigate('/ts-ratio')}>
              <div className="qa-icon neutral"><Calculator /></div>
              <div>
                <div className="qa-label">Set your T/S ratio</div>
                <div className="qa-desc">For accurate tax deductions</div>
              </div>
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="welcome-banner">
        <div className="welcome-text">
          <h2>{greeting}, <em>{firstName}</em> 👋</h2>
          <p>
            {totalOutstanding > 0 ? (
              <>You have <strong>{formatCurrency(totalOutstanding)}</strong> outstanding across {familiesOwing.length} {familiesOwing.length === 1 ? 'family' : 'families'}.
              {pendingApproval.length > 0 && <> {pendingApproval.length} {pendingApproval.length === 1 ? 'invoice needs' : 'invoices need'} your approval.</>}</>
            ) : pendingApproval.length > 0 ? (
              <>You have <strong>{pendingApproval.length} {pendingApproval.length === 1 ? 'invoice' : 'invoices'}</strong> waiting for your approval.</>
            ) : invoices.length === 0 && families.length > 0 ? (
              <>You're set up with {families.length} {families.length === 1 ? 'family' : 'families'}. Generate your first invoices to start collecting payments.</>
            ) : (
              <>All caught up — nothing owed right now. Nice work! 🎉</>
            )}
          </p>
        </div>
        <button className="welcome-cta" onClick={() => navigate(pendingApproval.length > 0 || invoices.length === 0 ? '/billing' : '/receipts')}>
          {pendingApproval.length > 0 ? (
            <><Send size={16} /> Review invoices</>
          ) : invoices.length === 0 && families.length > 0 ? (
            <><Sparkles size={16} /> Generate invoices</>
          ) : (
            <><ScanLine size={16} /> Scan a receipt</>
          )}
        </button>
      </div>

      <div className="stats-grid">
        <div className="stat-card" onClick={() => navigate('/billing')} style={{ cursor: 'pointer' }}>
          <div className="stat-header">
            <div className="stat-icon sage"><DollarSign /></div>
            {totalOutstanding > 0 && <span className="stat-change neutral">{familiesOwing.length} {familiesOwing.length === 1 ? 'family' : 'families'}</span>}
          </div>
          <div className="stat-value">{formatCurrencyShort(totalOutstanding)}</div>
          <div className="stat-label">Outstanding Balance</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <div className="stat-icon success"><CheckCircle /></div>
            <span className="stat-change up">This week</span>
          </div>
          <div className="stat-value">{formatCurrencyShort(paidThisWeek)}</div>
          <div className="stat-label">Paid This Week</div>
        </div>

        <div className="stat-card" onClick={() => navigate('/billing')} style={{ cursor: 'pointer' }}>
          <div className="stat-header">
            <div className={`stat-icon ${overdueInvoices.length > 0 ? 'warning' : 'sage'}`}>
              <AlertCircle />
            </div>
            {overdueInvoices.length > 0 && (
              <span className="stat-change" style={{ background: 'var(--clr-error-pale)', color: 'var(--clr-error)' }}>
                Action needed
              </span>
            )}
          </div>
          <div className="stat-value">{overdueInvoices.length}</div>
          <div className="stat-label">Overdue Invoices</div>
        </div>

        <div className="stat-card" onClick={() => navigate('/families')} style={{ cursor: 'pointer' }}>
          <div className="stat-header">
            <div className="stat-icon accent"><Users /></div>
            <span className="stat-change neutral">Active</span>
          </div>
          <div className="stat-value">{families.filter(f => f.enrollment_status === 'active').length}</div>
          <div className="stat-label">Active Families</div>
        </div>
      </div>

      <div className="content-grid">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Who Owes Me Money</span>
            <span className="card-action" onClick={() => navigate('/billing')}>
              View billing →
            </span>
          </div>
          <div className="card-body">
            {familiesOwing.length === 0 ? (
              <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--clr-ink-soft)' }}>
                {invoices.length === 0 ? (
                  <>
                    <div style={{ fontSize: '2rem', marginBottom: 'var(--space-2)' }}>💰</div>
                    <div style={{ marginBottom: 'var(--space-3)' }}>No invoices yet</div>
                    <button className="welcome-cta" onClick={() => navigate('/billing')} style={{ margin: '0 auto' }}>
                      <Sparkles size={14} /> Generate weekly invoices
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '2rem', marginBottom: 'var(--space-2)' }}>🎉</div>
                    <div>All families paid up — nothing owed!</div>
                  </>
                )}
              </div>
            ) : (
              <ul className="receipt-list">
                {familiesOwing.map(({ family, outstanding }) => (
                  <li key={family.id}>
                    <div className="receipt-item" onClick={() => navigate('/billing')} style={{ cursor: 'pointer' }}>
                      <div className="receipt-thumb misc">👨‍👩‍👧</div>
                      <div className="receipt-info">
                        <div className="receipt-merchant">{family.family_name}</div>
                        <div className="receipt-meta">
                          <span>{family.billing_type === 'weekly' ? 'Weekly' : 'Hourly'}</span>
                          {family.weekly_rate && <span className="receipt-category">{formatCurrency(family.weekly_rate)}/wk</span>}
                          {family.hourly_rate && <span className="receipt-category">{formatCurrency(family.hourly_rate)}/hr</span>}
                        </div>
                      </div>
                      <span className="receipt-amount" style={{ color: 'var(--clr-error)' }}>
                        {formatCurrency(outstanding)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">{currentYear} Tax Tracking</span>
              <span className="card-action" onClick={() => navigate('/deductions')}>
                View →
              </span>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 400, color: 'var(--clr-ink)', letterSpacing: '-0.02em' }}>
                      {formatCurrencyShort(totalDeductions)}
                    </div>
                    <div style={{ fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>
                      tracked deductions
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.125rem', color: 'var(--clr-sage-dark)' }}>
                      {tsRatio?.ratio_percentage ? `${parseFloat(tsRatio.ratio_percentage).toFixed(1)}%` : '—'}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--clr-ink-soft)' }}>T/S ratio</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', fontSize: '0.78125rem', color: 'var(--clr-ink-soft)' }}>
                  <span>📋 {receipts.length} receipts</span>
                  <span>·</span>
                  <span>+{receiptsThisMonth} this month</span>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Quick Actions</span>
            </div>
            <div className="card-body">
              <div className="quick-actions">
                {pendingApproval.length > 0 && (
                  <button className="quick-action-btn" onClick={() => navigate('/billing')}>
                    <div className="qa-icon accent"><Send /></div>
                    <div>
                      <div className="qa-label">Review {pendingApproval.length} pending {pendingApproval.length === 1 ? 'invoice' : 'invoices'}</div>
                      <div className="qa-desc">Approve and send to families</div>
                    </div>
                  </button>
                )}
                <button className="quick-action-btn" onClick={() => navigate('/billing')}>
                  <div className="qa-icon primary"><Sparkles /></div>
                  <div>
                    <div className="qa-label">Generate weekly invoices</div>
                    <div className="qa-desc">For last week's care</div>
                  </div>
                </button>
                <button className="quick-action-btn" onClick={() => navigate('/receipts')}>
                  <div className="qa-icon neutral"><ScanLine /></div>
                  <div>
                    <div className="qa-label">Scan a receipt</div>
                    <div className="qa-desc">AI extracts the details</div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {receipts.length > 0 && (
        <div className="card" style={{ marginTop: 'var(--space-5)' }}>
          <div className="card-header">
            <span className="card-title">Recent Receipts</span>
            <span className="card-action" onClick={() => navigate('/deductions')}>
              View all →
            </span>
          </div>
          <div className="card-body">
            <ul className="receipt-list">
              {receipts.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <div className="receipt-item">
                    <div className={`receipt-thumb ${categoryClass(r.category)}`}>
                      {categoryEmoji(r.category)}
                    </div>
                    <div className="receipt-info">
                      <div className="receipt-merchant">{r.merchant || 'Unknown merchant'}</div>
                      <div className="receipt-meta">
                        <span>{shortDate(r.purchase_date)}</span>
                        {r.category && <span className="receipt-category">{r.category}</span>}
                      </div>
                    </div>
                    <span className="receipt-amount">{formatCurrency(r.total)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
