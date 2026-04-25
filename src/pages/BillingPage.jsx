import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import {
  Plus, X, Save, Trash2, Send, Mail, MessageSquare, CreditCard,
  CheckCircle, FileText, Sparkles, ExternalLink, DollarSign,
  Copy, AlertCircle, ChevronRight,
} from 'lucide-react'
import '@/styles/billing.css'

const PAYMENT_METHODS = ['cash', 'check', 'venmo', 'zelle', 'stripe', 'other']

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

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.setDate(diff))
}

function dateStr(d) {
  return d.toISOString().split('T')[0]
}

// ════════════════════════════════════════════════════════════
export default function BillingPage() {
  const { user } = useAuth()

  const [families, setFamilies] = useState([])
  const [invoices, setInvoices] = useState([])
  const [items, setItems] = useState([])
  const [payments, setPayments] = useState([])
  const [attendance, setAttendance] = useState([])
  const [children, setChildren] = useState([])
  const [loading, setLoading] = useState(true)

  const [filter, setFilter] = useState('all')
  const [selectedInvoice, setSelectedInvoice] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [genMessage, setGenMessage] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [f, i, it, p, a, c] = await Promise.all([
      supabase.from('families').select('*').eq('user_id', user.id).order('family_name'),
      supabase.from('invoices').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('invoice_items').select('*').eq('user_id', user.id),
      supabase.from('payments').select('*').eq('user_id', user.id).order('payment_date', { ascending: false }),
      supabase.from('attendance').select('*').eq('user_id', user.id),
      supabase.from('children').select('*').eq('user_id', user.id),
    ])
    setFamilies(f.data || [])
    setInvoices(i.data || [])
    setItems(it.data || [])
    setPayments(p.data || [])
    setAttendance(a.data || [])
    setChildren(c.data || [])
    setLoading(false)
  }

  // ─── Calculations ───────────────────────────────

  const outstandingByFamily = families.map(family => {
    const familyInvoices = invoices.filter(inv =>
      inv.family_id === family.id && !['draft', 'void'].includes(inv.status)
    )
    const billed = familyInvoices.reduce((s, inv) => s + parseFloat(inv.total || 0), 0)
    const paid = familyInvoices.reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)
    return { family, billed, paid, outstanding: billed - paid, invoiceCount: familyInvoices.length }
  })

  const totalOutstanding = outstandingByFamily.reduce((s, f) => s + f.outstanding, 0)
  const totalThisWeek = invoices
    .filter(inv => {
      if (!inv.paid_at) return false
      const paidDate = new Date(inv.paid_at)
      const weekStart = getMonday(new Date())
      return paidDate >= weekStart
    })
    .reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)

  const overdueCount = invoices.filter(inv => inv.status === 'overdue').length
  const pendingApprovalCount = invoices.filter(inv => inv.status === 'pending_approval').length

  const filteredInvoices = filter === 'all'
    ? invoices
    : invoices.filter(inv => inv.status === filter)

  // ─── Generate weekly invoices ───────────────────

  const generateWeeklyInvoices = async () => {
    setGenerating(true)
    setGenMessage(null)

    // Last week's range (previous Monday → Sunday)
    const today = new Date()
    const thisMonday = getMonday(today)
    const lastMonday = new Date(thisMonday)
    lastMonday.setDate(lastMonday.getDate() - 7)
    const lastSunday = new Date(thisMonday)
    lastSunday.setDate(lastSunday.getDate() - 1)

    const periodStart = dateStr(lastMonday)
    const periodEnd = dateStr(lastSunday)

    const activeFamilies = families.filter(f => f.enrollment_status === 'active')
    let created = 0
    let skipped = 0

    for (const family of activeFamilies) {
      // Skip if invoice already exists for this period
      const existing = invoices.find(inv =>
        inv.family_id === family.id &&
        inv.period_start === periodStart &&
        inv.period_end === periodEnd
      )
      if (existing) { skipped++; continue }

      const familyChildren = children.filter(c => c.family_id === family.id)
      let subtotal = 0
      let lineItems = []
      let hoursBilled = 0

      if (family.billing_type === 'weekly' && family.weekly_rate) {
        const rate = parseFloat(family.weekly_rate)
        subtotal = rate
        lineItems.push({
          description: `Weekly tuition (${shortDate(periodStart)} – ${shortDate(periodEnd)})`,
          quantity: 1,
          unit: 'weeks',
          unit_price: rate,
          line_total: rate,
        })
      } else if (family.billing_type === 'hourly' && family.hourly_rate) {
        const rate = parseFloat(family.hourly_rate)
        // Sum up hours from attendance for each child this week
        for (const child of familyChildren) {
          const childAttendance = attendance.filter(a =>
            a.child_id === child.id &&
            a.date >= periodStart &&
            a.date <= periodEnd &&
            a.hours
          )
          const childHours = childAttendance.reduce((s, a) => s + parseFloat(a.hours || 0), 0)
          if (childHours > 0) {
            const lineTotal = childHours * rate
            subtotal += lineTotal
            hoursBilled += childHours
            lineItems.push({
              description: `${child.first_name} – ${childHours.toFixed(2)} hrs × ${formatCurrency(rate)}`,
              quantity: childHours,
              unit: 'hours',
              unit_price: rate,
              line_total: lineTotal,
              child_id: child.id,
            })
          }
        }
      }

      // Skip families with zero subtotal (no attendance for hourly families)
      if (subtotal <= 0) { skipped++; continue }

      // Calculate due date
      const dueDate = new Date(today)
      dueDate.setDate(dueDate.getDate() + (family.late_fee_after_days || 7))

      // Generate invoice number
      const invoiceNumber = `INV-${today.getFullYear()}-${String(invoices.length + created + 1).padStart(4, '0')}`

      // Insert invoice
      const { data: invoice, error: invErr } = await supabase.from('invoices').insert({
        user_id: user.id,
        family_id: family.id,
        invoice_number: invoiceNumber,
        period_start: periodStart,
        period_end: periodEnd,
        due_date: dateStr(dueDate),
        subtotal,
        total: subtotal,
        billing_type: family.billing_type,
        rate_used: family.billing_type === 'weekly' ? family.weekly_rate : family.hourly_rate,
        hours_billed: hoursBilled || null,
        weeks_billed: family.billing_type === 'weekly' ? 1 : null,
        status: 'pending_approval',
        delivery_method: family.invoice_delivery || 'email',
      }).select().single()

      if (invErr || !invoice) continue

      // Insert line items
      for (let idx = 0; idx < lineItems.length; idx++) {
        const li = lineItems[idx]
        await supabase.from('invoice_items').insert({
          ...li,
          invoice_id: invoice.id,
          user_id: user.id,
          sort_order: idx,
        })
      }
      created++
    }

    setGenerating(false)
    await loadAll()

    if (created === 0 && skipped === 0) {
      setGenMessage({ type: 'error', text: 'No active families to invoice. Add families and set their rate first.' })
    } else if (created === 0) {
      setGenMessage({ type: 'info', text: `No new invoices needed — already generated for ${shortDate(periodStart)} – ${shortDate(periodEnd)}.` })
    } else {
      setGenMessage({ type: 'success', text: `Created ${created} invoice${created === 1 ? '' : 's'} for last week. Review and approve below.` })
    }
    setTimeout(() => setGenMessage(null), 6000)
  }

  // ─── Render ─────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  if (families.length === 0) {
    return (
      <div className="invoices-empty">
        <div className="deductions-empty-icon">💰</div>
        <div className="deductions-empty-title">Add families first</div>
        <div className="deductions-empty-desc">
          Before you can generate invoices, you'll need to add families and set their billing rates in the Families page.
        </div>
      </div>
    )
  }

  return (
    <div className="billing-page">

      {/* Hero */}
      <div className="balance-hero">
        <div className="balance-hero-grid">
          <div>
            <div className="balance-main-label">Outstanding Balance</div>
            <div className="balance-main-value">{formatCurrency(totalOutstanding)}</div>
            <div className="balance-main-sub">
              {totalOutstanding > 0
                ? `Owed across ${outstandingByFamily.filter(f => f.outstanding > 0).length} families`
                : 'All caught up — nothing owed!'}
            </div>
          </div>
          <div className="balance-side">
            <div className="balance-side-label">Paid This Week</div>
            <div className="balance-side-value">{formatCurrency(totalThisWeek)}</div>
            <div className="balance-side-sub">since Monday</div>
          </div>
          <div className="balance-side">
            <div className="balance-side-label">Need Action</div>
            <div className="balance-side-value">{pendingApprovalCount + overdueCount}</div>
            <div className="balance-side-sub">
              {pendingApprovalCount} to approve · {overdueCount} overdue
            </div>
          </div>
        </div>
      </div>

      {/* Generation message */}
      {genMessage && (
        <div className={`auth-message ${genMessage.type === 'error' ? 'error' : 'success'}`} style={{ margin: 0 }}>
          <span>{genMessage.type === 'error' ? '⚠' : '✓'}</span>
          <span>{genMessage.text}</span>
        </div>
      )}

      {/* Action bar */}
      <div className="action-bar">
        <div className="action-bar-tabs">
          {[
            { v: 'all', label: 'All' },
            { v: 'pending_approval', label: 'Pending Approval' },
            { v: 'sent', label: 'Sent' },
            { v: 'paid', label: 'Paid' },
            { v: 'overdue', label: 'Overdue' },
            { v: 'draft', label: 'Drafts' },
          ].map(t => (
            <button
              key={t.v}
              className={`status-tab${filter === t.v ? ' active' : ''}`}
              onClick={() => setFilter(t.v)}
            >
              {t.label}
              {t.v !== 'all' && ` (${invoices.filter(i => i.status === t.v).length})`}
            </button>
          ))}
        </div>
        <div className="action-bar-buttons">
          <button className="btn-generate" onClick={generateWeeklyInvoices} disabled={generating}>
            <Sparkles size={15} />
            {generating ? 'Generating…' : 'Generate weekly invoices'}
          </button>
        </div>
      </div>

      {/* Outstanding by family */}
      {totalOutstanding > 0 && filter === 'all' && (
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.0625rem', fontWeight: 400, color: 'var(--clr-ink)', marginBottom: 'var(--space-3)', letterSpacing: '-0.01em' }}>
            Who owes me money
          </h3>
          <div className="balance-by-family">
            {outstandingByFamily
              .filter(f => f.outstanding > 0)
              .sort((a, b) => b.outstanding - a.outstanding)
              .map(({ family, billed, paid, outstanding, invoiceCount }) => (
                <div key={family.id} className="balance-family-row" onClick={() => setFilter('sent')}>
                  <div>
                    <div className="balance-family-name">{family.family_name}</div>
                    <div className="balance-family-detail">
                      {invoiceCount} {invoiceCount === 1 ? 'invoice' : 'invoices'} · {formatCurrency(paid)} paid
                    </div>
                  </div>
                  <div className="balance-family-amount owed">{formatCurrency(outstanding)}</div>
                  <ChevronRight size={16} style={{ color: 'var(--clr-ink-faint)' }} />
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Invoice list */}
      <div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.0625rem', fontWeight: 400, color: 'var(--clr-ink)', marginBottom: 'var(--space-3)', letterSpacing: '-0.01em' }}>
          {filter === 'all' ? 'All Invoices' : filter.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
        </h3>
        {filteredInvoices.length === 0 ? (
          <div className="empty-mini">
            {invoices.length === 0
              ? 'No invoices yet. Click "Generate weekly invoices" above to create draft invoices for last week.'
              : 'No invoices match this filter.'}
          </div>
        ) : (
          <div className="invoice-list">
            {filteredInvoices.map(inv => {
              const family = families.find(f => f.id === inv.family_id)
              return (
                <div key={inv.id} className="invoice-card" onClick={() => setSelectedInvoice(inv)}>
                  <div className="invoice-card-row">
                    <div className="invoice-info">
                      <div className="invoice-family-name">{family?.family_name || 'Unknown family'}</div>
                      <div className="invoice-meta">
                        <span>{inv.invoice_number || 'No #'}</span>
                        <span>·</span>
                        <span>{shortDate(inv.period_start)} – {shortDate(inv.period_end)}</span>
                        {inv.due_date && (
                          <>
                            <span>·</span>
                            <span>Due {shortDate(inv.due_date)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="invoice-amount">{formatCurrency(inv.total)}</div>
                      {inv.amount_paid > 0 && (
                        <div className="invoice-amount-sub">
                          {formatCurrency(inv.amount_paid)} paid
                        </div>
                      )}
                    </div>
                    <span className={`invoice-status ${inv.status}`}>
                      {inv.status.replace('_', ' ')}
                    </span>
                    <ChevronRight size={16} style={{ color: 'var(--clr-ink-faint)' }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Invoice detail modal */}
      {selectedInvoice && (
        <InvoiceDetailModal
          invoice={selectedInvoice}
          family={families.find(f => f.id === selectedInvoice.family_id)}
          items={items.filter(i => i.invoice_id === selectedInvoice.id)}
          payments={payments.filter(p => p.invoice_id === selectedInvoice.id)}
          userId={user.id}
          onClose={() => setSelectedInvoice(null)}
          onChange={loadAll}
        />
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// Invoice Detail Modal
// ════════════════════════════════════════════════════════════
function InvoiceDetailModal({ invoice, family, items: initialItems, payments: invoicePayments, userId, onClose, onChange }) {
  const [items, setItems] = useState(initialItems.sort((a, b) => a.sort_order - b.sort_order))
  const [notes, setNotes] = useState(invoice.notes || '')
  const [saving, setSaving] = useState(false)
  const [creatingLink, setCreatingLink] = useState(false)
  const [paymentLink, setPaymentLink] = useState(invoice.stripe_payment_link)
  const [linkError, setLinkError] = useState(null)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [newPayment, setNewPayment] = useState({
    amount: '', payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'cash', reference: '', notes: '',
  })

  const subtotal = items.reduce((s, i) => s + parseFloat(i.line_total || 0), 0)
  const total = subtotal + parseFloat(invoice.late_fee || 0)
  const balance = total - parseFloat(invoice.amount_paid || 0)

  // Update item field
  const updateItem = (idx, field, value) => {
    setItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      // Recalculate line_total
      if (field === 'quantity' || field === 'unit_price') {
        const q = parseFloat(field === 'quantity' ? value : next[idx].quantity) || 0
        const p = parseFloat(field === 'unit_price' ? value : next[idx].unit_price) || 0
        next[idx].line_total = q * p
      }
      return next
    })
  }

  const addItem = () => {
    setItems(prev => [...prev, {
      id: `temp-${Date.now()}`,
      description: '',
      quantity: 1,
      unit_price: 0,
      line_total: 0,
      sort_order: prev.length,
      _new: true,
    }])
  }

  const removeItem = (idx) => {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  // Save changes
  const saveChanges = async (newStatus) => {
    setSaving(true)

    // Update invoice
    await supabase.from('invoices').update({
      subtotal,
      total,
      notes,
      ...(newStatus && { status: newStatus, ...(newStatus === 'sent' && { sent_at: new Date().toISOString() }) }),
    }).eq('id', invoice.id)

    // Replace line items
    await supabase.from('invoice_items').delete().eq('invoice_id', invoice.id)
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx]
      await supabase.from('invoice_items').insert({
        invoice_id: invoice.id,
        user_id: userId,
        child_id: it.child_id || null,
        description: it.description,
        quantity: parseFloat(it.quantity) || 0,
        unit: it.unit || null,
        unit_price: parseFloat(it.unit_price) || 0,
        line_total: parseFloat(it.line_total) || 0,
        sort_order: idx,
      })
    }

    setSaving(false)
    await onChange()
  }

  // Approve & send
  const approveAndSend = async () => {
    await saveChanges('sent')
    onClose()
  }

  // Create Stripe payment link
  const createPaymentLink = async () => {
    setCreatingLink(true)
    setLinkError(null)
    try {
      const resp = await fetch('/api/create-payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: balance,
          description: `${family?.family_name || 'Invoice'} — ${shortDate(invoice.period_start)} to ${shortDate(invoice.period_end)}`,
          invoice_id: invoice.id,
          family_name: family?.family_name,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error || 'Failed to create payment link')

      await supabase.from('invoices').update({
        stripe_payment_link: data.url,
      }).eq('id', invoice.id)

      setPaymentLink(data.url)
    } catch (err) {
      setLinkError(err.message)
    }
    setCreatingLink(false)
  }

  const copyLink = () => {
    if (paymentLink) {
      navigator.clipboard.writeText(paymentLink)
    }
  }

  // Record payment
  const recordPayment = async () => {
    if (!newPayment.amount) return
    const amt = parseFloat(newPayment.amount)

    // Insert payment record
    await supabase.from('payments').insert({
      user_id: userId,
      invoice_id: invoice.id,
      family_id: invoice.family_id,
      amount: amt,
      payment_date: newPayment.payment_date,
      payment_method: newPayment.payment_method,
      reference: newPayment.reference || null,
      notes: newPayment.notes || null,
    })

    // Update invoice amount_paid + status
    const newAmountPaid = parseFloat(invoice.amount_paid || 0) + amt
    let newStatus = invoice.status
    if (newAmountPaid >= total) newStatus = 'paid'
    else if (newAmountPaid > 0) newStatus = 'partial'

    await supabase.from('invoices').update({
      amount_paid: newAmountPaid,
      status: newStatus,
      ...(newStatus === 'paid' && { paid_at: new Date().toISOString(), payment_method: newPayment.payment_method }),
    }).eq('id', invoice.id)

    setShowAddPayment(false)
    setNewPayment({
      amount: '', payment_date: new Date().toISOString().split('T')[0],
      payment_method: 'cash', reference: '', notes: '',
    })
    await onChange()
    onClose()
  }

  // Delete invoice
  const deleteInvoice = async () => {
    if (!window.confirm('Delete this invoice? This cannot be undone.')) return
    await supabase.from('invoices').delete().eq('id', invoice.id)
    await onChange()
    onClose()
  }

  // Mark void
  const markVoid = async () => {
    if (!window.confirm('Mark this invoice as void? It will no longer count toward outstanding balance.')) return
    await supabase.from('invoices').update({ status: 'void' }).eq('id', invoice.id)
    await onChange()
    onClose()
  }

  const isEditable = ['draft', 'pending_approval'].includes(invoice.status)
  const isPaid = invoice.status === 'paid'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card invoice-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{family?.family_name || 'Invoice'}</div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginTop: 2 }}>
              {invoice.invoice_number} · {shortDate(invoice.period_start)} – {shortDate(invoice.period_end)}
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body">
          {/* Status summary bar */}
          <div className="invoice-summary-bar">
            <div className="invoice-summary-item">
              <div className="invoice-summary-label">Status</div>
              <div className="invoice-summary-value">
                <span className={`invoice-status ${invoice.status}`} style={{ fontSize: '0.7rem' }}>
                  {invoice.status.replace('_', ' ')}
                </span>
              </div>
            </div>
            <div className="invoice-summary-item">
              <div className="invoice-summary-label">Total</div>
              <div className="invoice-summary-value">{formatCurrency(total)}</div>
            </div>
            <div className="invoice-summary-item">
              <div className="invoice-summary-label">Balance Due</div>
              <div className="invoice-summary-value" style={{ color: balance > 0 ? 'var(--clr-error)' : 'var(--clr-success)' }}>
                {formatCurrency(balance)}
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="line-items-table">
            <div className="line-items-header">
              <span>Description</span>
              <span style={{ textAlign: 'right' }}>Qty</span>
              <span style={{ textAlign: 'right' }}>Rate</span>
              <span style={{ textAlign: 'right' }}>Total</span>
              <span></span>
            </div>
            {items.map((it, idx) => (
              <div key={it.id || idx} className="line-item-row">
                {isEditable ? (
                  <>
                    <input value={it.description} onChange={(e) => updateItem(idx, 'description', e.target.value)} placeholder="Description" />
                    <input className="num-input" type="number" step="0.01" value={it.quantity || ''} onChange={(e) => updateItem(idx, 'quantity', e.target.value)} />
                    <input className="num-input" type="number" step="0.01" value={it.unit_price || ''} onChange={(e) => updateItem(idx, 'unit_price', e.target.value)} />
                    <span className="line-item-total">{formatCurrency(it.line_total)}</span>
                    <button className="icon-btn danger" onClick={() => removeItem(idx)}><Trash2 /></button>
                  </>
                ) : (
                  <>
                    <span>{it.description}</span>
                    <span style={{ textAlign: 'right' }}>{parseFloat(it.quantity || 0).toFixed(2)}</span>
                    <span style={{ textAlign: 'right' }}>{formatCurrency(it.unit_price)}</span>
                    <span className="line-item-total">{formatCurrency(it.line_total)}</span>
                    <span></span>
                  </>
                )}
              </div>
            ))}
            <div className="line-items-footer">
              <span>Total</span>
              <span className="total-amount">{formatCurrency(total)}</span>
            </div>
          </div>

          {isEditable && (
            <button className="btn-add-line" onClick={addItem}>
              <Plus size={14} /> Add line item
            </button>
          )}

          {/* Notes */}
          {(isEditable || notes) && (
            <div className="form-field-group" style={{ marginTop: 'var(--space-4)' }}>
              <label className="field-label">Notes (visible on invoice)</label>
              {isEditable ? (
                <textarea className="field-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes for the family…" />
              ) : (
                <div style={{ padding: 'var(--space-3)', background: 'var(--clr-cream)', borderRadius: 'var(--radius-md)', fontSize: '0.875rem', color: 'var(--clr-ink-mid)' }}>
                  {notes}
                </div>
              )}
            </div>
          )}

          {/* Payment link section */}
          {!isEditable && balance > 0 && (
            <div className="action-card" style={{ marginTop: 'var(--space-4)' }}>
              <div className="action-card-title">💳 Stripe Payment Link</div>
              <div className="action-card-desc">
                Generate a Stripe payment link to share with the family. They can pay via card, Apple Pay, or Google Pay.
              </div>
              {paymentLink ? (
                <div className="payment-link-display">
                  <ExternalLink size={14} />
                  <a href={paymentLink} target="_blank" rel="noopener noreferrer">{paymentLink}</a>
                  <button className="icon-btn" onClick={copyLink} title="Copy link"><Copy /></button>
                </div>
              ) : (
                <>
                  <button className="btn-save" onClick={createPaymentLink} disabled={creatingLink} style={{ flex: 'initial', padding: '0.625rem var(--space-4)' }}>
                    <CreditCard size={14} /> {creatingLink ? 'Creating…' : 'Create payment link'}
                  </button>
                  {linkError && (
                    <div style={{ marginTop: 'var(--space-2)', fontSize: '0.8125rem', color: 'var(--clr-error)' }}>
                      {linkError}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Payment history */}
          {invoicePayments.length > 0 && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <div className="subsection-title" style={{ marginBottom: 'var(--space-3)' }}>Payment History</div>
              {invoicePayments.map(p => (
                <div key={p.id} className="payment-row">
                  <div className="payment-method-icon"><CheckCircle size={18} /></div>
                  <div className="payment-info">
                    <div className="payment-amount-row">{formatCurrency(p.amount)}</div>
                    <div className="payment-meta-row">
                      {formatDate(p.payment_date)} · {p.payment_method}
                      {p.reference && ` · ${p.reference}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add payment */}
          {!isPaid && balance > 0 && (
            <>
              {!showAddPayment ? (
                <button className="btn-add-line" onClick={() => setShowAddPayment(true)} style={{ marginTop: 'var(--space-4)' }}>
                  <DollarSign size={14} /> Record a payment
                </button>
              ) : (
                <div className="add-payment-form" style={{ marginTop: 'var(--space-4)' }}>
                  <div className="add-payment-form-grid">
                    <div className="form-field-group">
                      <label className="field-label">Amount</label>
                      <input className="field-input" type="number" step="0.01" value={newPayment.amount} onChange={(e) => setNewPayment(p => ({ ...p, amount: e.target.value }))} placeholder={balance.toFixed(2)} />
                    </div>
                    <div className="form-field-group">
                      <label className="field-label">Date</label>
                      <input className="field-input" type="date" value={newPayment.payment_date} onChange={(e) => setNewPayment(p => ({ ...p, payment_date: e.target.value }))} />
                    </div>
                    <div className="form-field-group">
                      <label className="field-label">Method</label>
                      <select className="field-input" value={newPayment.payment_method} onChange={(e) => setNewPayment(p => ({ ...p, payment_method: e.target.value }))}>
                        {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="form-field-group">
                    <label className="field-label">Reference (optional)</label>
                    <input className="field-input" value={newPayment.reference} onChange={(e) => setNewPayment(p => ({ ...p, reference: e.target.value }))} placeholder="Check #, Venmo username, etc." />
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
                    <button className="btn-discard" onClick={() => setShowAddPayment(false)}>Cancel</button>
                    <button className="btn-save" onClick={recordPayment} disabled={!newPayment.amount} style={{ flex: 'initial', padding: '0.5rem var(--space-4)' }}>
                      Record payment
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          {isEditable ? (
            <>
              <button className="btn-danger" onClick={deleteInvoice}><Trash2 size={14} /> Delete</button>
              <button className="btn-discard" onClick={onClose}>Cancel</button>
              <button className="btn-save" onClick={() => saveChanges()} disabled={saving} style={{ flex: 'initial', padding: '0.625rem var(--space-4)', background: 'var(--clr-warm)', color: 'var(--clr-ink-mid)' }}>
                <Save size={14} /> Save draft
              </button>
              <button className="btn-save" onClick={approveAndSend} disabled={saving || items.length === 0} style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
                <Send size={14} /> Approve &amp; mark sent
              </button>
            </>
          ) : (
            <>
              {!isPaid && (
                <button className="btn-danger" onClick={markVoid}><X size={14} /> Mark void</button>
              )}
              <button className="btn-discard" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
