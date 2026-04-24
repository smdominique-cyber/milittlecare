import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { ChevronRight, Pencil, Trash2, X, Save, LayoutGrid, Calendar, ScanLine } from 'lucide-react'
import '@/styles/deductions.css'

const CATEGORIES = [
  'Groceries & Food', 'Office Supplies', 'Toys & Educational',
  'Cleaning & Household', 'Vehicle & Transportation', 'Meals & Entertainment',
  'Utilities', 'Insurance', 'Professional Services', 'Equipment & Furniture',
  'Outdoor & Playground', 'Medical & Safety', 'Other',
]

const PAYMENT_METHODS = ['Cash', 'Credit Card', 'Debit Card', 'Check', 'Other']

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function categoryEmoji(cat) {
  const map = {
    'Groceries & Food': '🛒', 'Office Supplies': '📎', 'Toys & Educational': '🧸',
    'Cleaning & Household': '🧹', 'Vehicle & Transportation': '🚗',
    'Meals & Entertainment': '🍽️', 'Utilities': '💡', 'Insurance': '🛡️',
    'Professional Services': '💼', 'Equipment & Furniture': '🪑',
    'Outdoor & Playground': '🌳', 'Medical & Safety': '🩺', 'Other': '📄',
  }
  return map[cat] || '📄'
}

function formatCurrency(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default function DeductionsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [receipts, setReceipts] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('category') // 'category' | 'month'
  const [year, setYear] = useState(new Date().getFullYear())
  const [expanded, setExpanded] = useState(new Set())
  const [editing, setEditing] = useState(null) // receipt being edited
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadReceipts() }, [])

  async function loadReceipts() {
    setLoading(true)
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
    if (!error) setReceipts(data || [])
    setLoading(false)
  }

  // Filter by year
  const yearReceipts = receipts.filter(r => {
    if (!r.date) return false
    return new Date(r.date).getFullYear() === year
  })

  // Available years
  const years = [...new Set(receipts.map(r => r.date ? new Date(r.date).getFullYear() : null).filter(Boolean))]
  if (!years.includes(new Date().getFullYear())) years.unshift(new Date().getFullYear())

  // Totals
  const total = yearReceipts.reduce((s, r) => s + parseFloat(r.total || r.amount || 0), 0)
  const count = yearReceipts.length
  const avgPerMonth = total / 12
  const largestReceipt = yearReceipts.reduce((max, r) => {
    const amt = parseFloat(r.total || r.amount || 0)
    return amt > max ? amt : max
  }, 0)

  // Group by category or month
  const groups = {}
  if (view === 'category') {
    yearReceipts.forEach(r => {
      const cat = r.category || 'Other'
      if (!groups[cat]) groups[cat] = { items: [], total: 0, label: cat, emoji: categoryEmoji(cat) }
      groups[cat].items.push(r)
      groups[cat].total += parseFloat(r.total || r.amount || 0)
    })
  } else {
    yearReceipts.forEach(r => {
      const m = new Date(r.date).getMonth()
      const key = `${m}`
      if (!groups[key]) groups[key] = { items: [], total: 0, label: MONTHS[m], emoji: '📅', month: m }
      groups[key].items.push(r)
      groups[key].total += parseFloat(r.total || r.amount || 0)
    })
  }

  // Sort groups: category by total desc, month by month order
  const groupEntries = Object.entries(groups).sort((a, b) => {
    if (view === 'month') return a[1].month - b[1].month
    return b[1].total - a[1].total
  })

  const toggleGroup = (key) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleEditSave = async () => {
    if (!editing) return
    setSaving(true)
    const { error } = await supabase
      .from('receipts')
      .update({
        merchant: editing.merchant || null,
        amount: editing.amount ? parseFloat(editing.amount) : null,
        tax: editing.tax ? parseFloat(editing.tax) : null,
        tip: editing.tip ? parseFloat(editing.tip) : null,
        total: editing.total ? parseFloat(editing.total) : null,
        date: editing.date || null,
        category: editing.category || null,
        description: editing.description || null,
        payment_method: editing.payment_method || null,
        notes: editing.notes || null,
      })
      .eq('id', editing.id)

    setSaving(false)
    if (!error) {
      await loadReceipts()
      setEditing(null)
    }
  }

  const handleDelete = async (id, imagePath) => {
    if (!window.confirm('Delete this receipt? This cannot be undone.')) return

    // Remove from storage
    if (imagePath) {
      await supabase.storage.from('receipts').remove([imagePath])
    }
    // Remove from db
    await supabase.from('receipts').delete().eq('id', id)
    await loadReceipts()
    setEditing(null)
  }

  const updateEditing = (field) => (e) => {
    setEditing(prev => ({ ...prev, [field]: e.target.value }))
  }

  // ─── Render ─────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  if (receipts.length === 0) {
    return (
      <div className="deductions-empty">
        <div className="deductions-empty-icon">📊</div>
        <div className="deductions-empty-title">No deductions yet</div>
        <div className="deductions-empty-desc">
          Start by scanning a receipt and your deductions will be tracked here automatically.
        </div>
        <button className="btn-go-scan" onClick={() => navigate('/receipts')}>
          <ScanLine size={16} /> Scan your first receipt
        </button>
      </div>
    )
  }

  const maxTotal = Math.max(...groupEntries.map(([, g]) => g.total))

  return (
    <div className="deductions-page">

      {/* Summary */}
      <div className="summary-row">
        <div className="summary-card">
          <div className="summary-label">Total Deductions</div>
          <div className="summary-value">{formatCurrency(total)}</div>
          <div className="summary-sub">for tax year {year}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Receipts</div>
          <div className="summary-value">{count}</div>
          <div className="summary-sub">{count === 1 ? 'tracked' : 'total tracked'}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Avg / Month</div>
          <div className="summary-value">{formatCurrency(avgPerMonth)}</div>
          <div className="summary-sub">spread over 12 months</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Largest Receipt</div>
          <div className="summary-value">{formatCurrency(largestReceipt)}</div>
          <div className="summary-sub">single transaction</div>
        </div>
      </div>

      {/* Controls */}
      <div className="view-toggle-bar">
        <div className="view-toggle">
          <button className={view === 'category' ? 'active' : ''} onClick={() => setView('category')}>
            <LayoutGrid size={14} /> By Category
          </button>
          <button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
            <Calendar size={14} /> By Month
          </button>
        </div>
        <div className="year-selector">
          <span>Tax year</span>
          <select value={year} onChange={(e) => setYear(parseInt(e.target.value))}>
            {years.sort((a, b) => b - a).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Groups */}
      <div>
        {groupEntries.map(([key, group]) => {
          const isOpen = expanded.has(key)
          const percent = maxTotal ? (group.total / maxTotal) * 100 : 0
          return (
            <div key={key} className={`group-card${isOpen ? ' expanded' : ''}`}>
              <div className="group-header" onClick={() => toggleGroup(key)}>
                <div className="group-title-wrap">
                  <div className="group-emoji">{group.emoji}</div>
                  <div>
                    <div className="group-title">{group.label}</div>
                    <div className="group-count">{group.items.length} {group.items.length === 1 ? 'receipt' : 'receipts'}</div>
                  </div>
                </div>
                <div className="group-total-wrap">
                  <div className="group-percent-bar">
                    <div className="group-percent-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="group-total">{formatCurrency(group.total)}</div>
                  <ChevronRight size={18} className="group-chevron" />
                </div>
              </div>

              <div className="group-items">
                {group.items.map(r => (
                  <div key={r.id} className="deduction-row" onClick={() => setEditing(r)}>
                    <div className="deduction-thumb">
                      {r.image_url ? <img src={r.image_url} alt={r.merchant} /> : categoryEmoji(r.category)}
                    </div>
                    <div className="deduction-info">
                      <div className="deduction-merchant">{r.merchant || 'Unknown merchant'}</div>
                      <div className="deduction-meta">
                        <span>{r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</span>
                        {view === 'month' && r.category && <span>· {r.category}</span>}
                        {r.description && <span>· {r.description.slice(0, 30)}{r.description.length > 30 ? '…' : ''}</span>}
                      </div>
                    </div>
                    <div className="deduction-amount">{formatCurrency(r.total || r.amount)}</div>
                    <div className="deduction-actions">
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setEditing(r) }} title="Edit">
                        <Pencil />
                      </button>
                      <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); handleDelete(r.id, r.image_path) }} title="Delete">
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Edit receipt</span>
              <button className="modal-close" onClick={() => setEditing(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              {editing.image_url && (
                <img src={editing.image_url} alt="Receipt" className="modal-image-preview" />
              )}

              <div className="form-row">
                <div className="form-field-group">
                  <label className="field-label">Merchant</label>
                  <input className="field-input" value={editing.merchant || ''} onChange={updateEditing('merchant')} />
                </div>
                <div className="form-field-group">
                  <label className="field-label">Date</label>
                  <input className="field-input" type="date" value={editing.date || ''} onChange={updateEditing('date')} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-field-group">
                  <label className="field-label">Subtotal ($)</label>
                  <input className="field-input" type="number" step="0.01" value={editing.amount || ''} onChange={updateEditing('amount')} />
                </div>
                <div className="form-field-group">
                  <label className="field-label">Tax ($)</label>
                  <input className="field-input" type="number" step="0.01" value={editing.tax || ''} onChange={updateEditing('tax')} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-field-group">
                  <label className="field-label">Tip ($)</label>
                  <input className="field-input" type="number" step="0.01" value={editing.tip || ''} onChange={updateEditing('tip')} />
                </div>
                <div className="form-field-group">
                  <label className="field-label">Total ($)</label>
                  <input className="field-input" type="number" step="0.01" value={editing.total || ''} onChange={updateEditing('total')} />
                </div>
              </div>

              <div className="form-row">
                <div className="form-field-group">
                  <label className="field-label">Category</label>
                  <select className="field-input" value={editing.category || ''} onChange={updateEditing('category')}>
                    <option value="">Select…</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-field-group">
                  <label className="field-label">Payment</label>
                  <select className="field-input" value={editing.payment_method || ''} onChange={updateEditing('payment_method')}>
                    <option value="">Select…</option>
                    {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div className="form-field-group">
                <label className="field-label">Description</label>
                <input className="field-input" value={editing.description || ''} onChange={updateEditing('description')} />
              </div>

              <div className="form-field-group">
                <label className="field-label">Notes</label>
                <textarea className="field-input" value={editing.notes || ''} onChange={updateEditing('notes')} />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn-danger" onClick={() => handleDelete(editing.id, editing.image_path)}>
                <Trash2 size={14} /> Delete
              </button>
              <button className="btn-discard" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-save" onClick={handleEditSave} disabled={saving} style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
                <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
