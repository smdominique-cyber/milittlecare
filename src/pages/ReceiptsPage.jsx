import { useState, useRef, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { ScanLine, Upload, CheckCircle, Trash2, Save, RefreshCw, Receipt } from 'lucide-react'
import '@/styles/receipts.css'

// ── Category options ────────────────────────────────────────
const CATEGORIES = [
  'Groceries & Food',
  'Office Supplies',
  'Toys & Educational',
  'Cleaning & Household',
  'Vehicle & Transportation',
  'Meals & Entertainment',
  'Utilities',
  'Insurance',
  'Professional Services',
  'Equipment & Furniture',
  'Outdoor & Playground',
  'Medical & Safety',
  'Other',
]

const PAYMENT_METHODS = ['Cash', 'Credit Card', 'Debit Card', 'Check', 'Other']

// ── Emoji for categories ─────────────────────────────────────
function categoryEmoji(cat) {
  const map = {
    'Groceries & Food': '🛒',
    'Office Supplies': '📎',
    'Toys & Educational': '🧸',
    'Cleaning & Household': '🧹',
    'Vehicle & Transportation': '🚗',
    'Meals & Entertainment': '🍽️',
    'Utilities': '💡',
    'Insurance': '🛡️',
    'Professional Services': '💼',
    'Equipment & Furniture': '🪑',
    'Outdoor & Playground': '🌳',
    'Medical & Safety': '🩺',
    'Other': '📄',
  }
  return map[cat] || '📄'
}

// ── Convert file to base64 ───────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ── Scan receipt with Claude AI ──────────────────────────────
async function scanReceiptWithAI(base64Image, mimeType) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Image },
          },
          {
            type: 'text',
            text: `You are a receipt scanning assistant for a home daycare provider. 
Analyze this receipt image and extract ALL available information.
Respond ONLY with a valid JSON object, no markdown, no explanation.

Return this exact structure:
{
  "merchant": "store or vendor name",
  "amount": 0.00,
  "tax": 0.00,
  "tip": 0.00,
  "total": 0.00,
  "date": "YYYY-MM-DD",
  "category": "best matching category from: Groceries & Food, Office Supplies, Toys & Educational, Cleaning & Household, Vehicle & Transportation, Meals & Entertainment, Utilities, Insurance, Professional Services, Equipment & Furniture, Outdoor & Playground, Medical & Safety, Other",
  "subcategory": "more specific description",
  "description": "brief description of what was purchased",
  "payment_method": "Cash or Credit Card or Debit Card or Check or Other",
  "notes": "any other relevant details from the receipt",
  "confidence": "high or medium or low"
}

If a field is not visible or unclear, use null. For amounts use numbers only, no $ signs.`,
          },
        ],
      }],
    }),
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(err.error?.message || 'AI scanning failed')
  }

  const data = await response.json()
  const text = data.content.find(b => b.type === 'text')?.text || '{}'
  
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    throw new Error('Could not read AI response. Please try again.')
  }
}

// ════════════════════════════════════════════════════════════
// Main component
// ════════════════════════════════════════════════════════════
export default function ReceiptsPage() {
  const { user } = useAuth()
  const fileInputRef = useRef(null)

  // UI state
  const [stage, setStage] = useState('upload') // upload | scanning | review | saving | success
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('All')

  // Receipt data
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [receipts, setReceipts] = useState([])
  const [loadingReceipts, setLoadingReceipts] = useState(true)

  // Form fields (populated by AI, editable by user)
  const [form, setForm] = useState({
    merchant: '', amount: '', tax: '', tip: '', total: '',
    date: '', category: '', subcategory: '', description: '',
    payment_method: '', notes: '', ai_confidence: '',
  })

  // Load existing receipts
  useState(() => {
    loadReceipts()
  })

  async function loadReceipts() {
    setLoadingReceipts(true)
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (!error) setReceipts(data || [])
    setLoadingReceipts(false)
  }

  // ── Handle file selection ─────────────────────────────────
  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Please upload an image file (JPG, PNG, HEIC, etc.)')
      return
    }

    setError(null)
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setStage('scanning')

    try {
      const base64 = await fileToBase64(file)
      const result = await scanReceiptWithAI(base64, file.type)

      setForm({
        merchant: result.merchant || '',
        amount: result.amount?.toString() || '',
        tax: result.tax?.toString() || '',
        tip: result.tip?.toString() || '',
        total: result.total?.toString() || '',
        date: result.date || new Date().toISOString().split('T')[0],
        category: result.category || '',
        subcategory: result.subcategory || '',
        description: result.description || '',
        payment_method: result.payment_method || '',
        notes: result.notes || '',
        ai_confidence: result.confidence || 'medium',
      })

      setStage('review')
    } catch (err) {
      setError(err.message)
      setStage('upload')
    }
  }, [])

  const handleDrop = (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleInputChange = (field) => (e) => {
    setForm(f => ({ ...f, [field]: e.target.value }))
  }

  // ── Save receipt ──────────────────────────────────────────
  const handleSave = async () => {
    setStage('saving')
    setError(null)

    try {
      let image_url = null
      let image_path = null

      // Upload image to Supabase Storage
      if (imageFile) {
        const ext = imageFile.name.split('.').pop()
        const path = `${user.id}/${Date.now()}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('receipts')
          .upload(path, imageFile)

        if (!uploadError) {
          image_path = path
          const { data: urlData } = supabase.storage
            .from('receipts')
            .getPublicUrl(path)
          image_url = urlData?.publicUrl
        }
      }

      // Save receipt record
      const { error: insertError } = await supabase.from('receipts').insert({
        user_id: user.id,
        merchant: form.merchant || null,
        amount: form.amount ? parseFloat(form.amount) : null,
        tax: form.tax ? parseFloat(form.tax) : null,
        tip: form.tip ? parseFloat(form.tip) : null,
        total: form.total ? parseFloat(form.total) : null,
        date: form.date || null,
        category: form.category || null,
        subcategory: form.subcategory || null,
        description: form.description || null,
        payment_method: form.payment_method || null,
        notes: form.notes || null,
        ai_confidence: form.ai_confidence || null,
        image_url,
        image_path,
        status: 'reviewed',
      })

      if (insertError) throw insertError

      setStage('success')
      await loadReceipts()

      // Reset after 2 seconds
      setTimeout(() => {
        setStage('upload')
        setImageFile(null)
        setImagePreview(null)
        setForm({
          merchant: '', amount: '', tax: '', tip: '', total: '',
          date: '', category: '', subcategory: '', description: '',
          payment_method: '', notes: '', ai_confidence: '',
        })
      }, 2000)

    } catch (err) {
      setError(err.message || 'Failed to save receipt. Please try again.')
      setStage('review')
    }
  }

  const handleDiscard = () => {
    setStage('upload')
    setImageFile(null)
    setImagePreview(null)
    setError(null)
  }

  // ── Filter receipts ───────────────────────────────────────
  const filteredReceipts = filter === 'All'
    ? receipts
    : receipts.filter(r => r.category === filter)

  const allCategories = ['All', ...new Set(receipts.map(r => r.category).filter(Boolean))]

  // ════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════
  return (
    <div className="receipts-page">

      {/* ── Error banner ── */}
      {error && (
        <div className="scan-error">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {/* ── UPLOAD STAGE ── */}
      {stage === 'upload' && (
        <div
          className="upload-zone"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => handleFile(e.target.files[0])}
            style={{ display: 'none' }}
          />
          <div className="upload-icon">
            <ScanLine size={28} />
          </div>
          <div className="upload-title">Scan a receipt</div>
          <div className="upload-subtitle">
            Take a photo or upload an image — AI will extract all the details automatically
          </div>
          <div className="upload-formats">
            {['📷 Camera', 'JPG', 'PNG', 'HEIC', 'PDF'].map(f => (
              <span className="format-pill" key={f}>{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* ── SCANNING STAGE ── */}
      {stage === 'scanning' && (
        <div className="scanning-card">
          <div className="scanning-preview">
            {imagePreview && <img src={imagePreview} alt="Receipt" />}
            <div className="scan-overlay">
              <div className="scan-line" />
              <div className="scan-status">🤖 Analyzing receipt…</div>
              <div className="scan-substatus">Extracting merchant, amounts, and details</div>
            </div>
          </div>
        </div>
      )}

      {/* ── SUCCESS STAGE ── */}
      {stage === 'success' && (
        <div className="scanning-card" style={{ padding: 'var(--space-10)', textAlign: 'center' }}>
          <div style={{ fontSize: '3rem', marginBottom: 'var(--space-3)' }}>✅</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', color: 'var(--clr-ink)', marginBottom: 'var(--space-2)' }}>
            Receipt saved!
          </div>
          <div style={{ color: 'var(--clr-ink-soft)', fontSize: '0.9rem' }}>
            Added to your deductions tracker
          </div>
        </div>
      )}

      {/* ── SAVING STAGE ── */}
      {stage === 'saving' && (
        <div className="scanning-card" style={{ padding: 'var(--space-10)', textAlign: 'center' }}>
          <div className="loading-spinner" style={{ margin: '0 auto var(--space-4)' }} />
          <div style={{ color: 'var(--clr-ink-soft)' }}>Saving receipt…</div>
        </div>
      )}

      {/* ── REVIEW STAGE ── */}
      {stage === 'review' && (
        <div className="results-card">
          <div className="results-header">
            <span className="results-title">Review & confirm</span>
            <span className={`confidence-badge ${form.ai_confidence}`}>
              {form.ai_confidence === 'high' ? '✓' : form.ai_confidence === 'medium' ? '~' : '!'} {form.ai_confidence} confidence
            </span>
          </div>

          {imagePreview && (
            <img src={imagePreview} alt="Receipt" className="results-preview-thumb" />
          )}

          <div className="results-form">
            <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginBottom: 'var(--space-2)' }}>
              ✨ AI filled in the fields below — review and edit anything that looks wrong.
            </p>

            {/* Merchant & Date */}
            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Merchant <span className="ai-tag">✨ AI</span></label>
                <input className="field-input ai-filled" value={form.merchant} onChange={handleInputChange('merchant')} placeholder="Store name" />
              </div>
              <div className="form-field-group">
                <label className="field-label">Date <span className="ai-tag">✨ AI</span></label>
                <input className="field-input ai-filled" type="date" value={form.date} onChange={handleInputChange('date')} />
              </div>
            </div>

            {/* Amounts */}
            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Subtotal ($) <span className="ai-tag">✨ AI</span></label>
                <input className="field-input ai-filled" type="number" step="0.01" value={form.amount} onChange={handleInputChange('amount')} placeholder="0.00" />
              </div>
              <div className="form-field-group">
                <label className="field-label">Tax ($) <span className="ai-tag">✨ AI</span></label>
                <input className="field-input ai-filled" type="number" step="0.01" value={form.tax} onChange={handleInputChange('tax')} placeholder="0.00" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Tip ($)</label>
                <input className="field-input ai-filled" type="number" step="0.01" value={form.tip} onChange={handleInputChange('tip')} placeholder="0.00" />
              </div>
              <div className="form-field-group">
                <label className="field-label">Total ($) <span className="ai-tag">✨ AI</span></label>
                <input className="field-input ai-filled" type="number" step="0.01" value={form.total} onChange={handleInputChange('total')} placeholder="0.00" />
              </div>
            </div>

            {/* Category */}
            <div className="form-row">
              <div className="form-field-group">
                <label className="field-label">Category <span className="ai-tag">✨ AI</span></label>
                <select className="field-input ai-filled" value={form.category} onChange={handleInputChange('category')}>
                  <option value="">Select category…</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-field-group">
                <label className="field-label">Payment method <span className="ai-tag">✨ AI</span></label>
                <select className="field-input ai-filled" value={form.payment_method} onChange={handleInputChange('payment_method')}>
                  <option value="">Select…</option>
                  {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {/* Description */}
            <div className="form-field-group">
              <label className="field-label">What was purchased? <span className="ai-tag">✨ AI</span></label>
              <input className="field-input ai-filled" value={form.description} onChange={handleInputChange('description')} placeholder="e.g. Art supplies for kids" />
            </div>

            {/* Notes */}
            <div className="form-field-group">
              <label className="field-label">Notes</label>
              <textarea className="field-input" value={form.notes} onChange={handleInputChange('notes')} placeholder="Any additional notes about this expense…" />
            </div>
          </div>

          <div className="results-actions">
            <button className="btn-save" onClick={handleSave}>
              <Save size={16} />
              Save receipt
            </button>
            <button className="btn-discard" onClick={handleDiscard}>
              <Trash2 size={15} />
              Discard
            </button>
          </div>
        </div>
      )}

      {/* ── RECEIPTS LIST ── */}
      <div className="receipts-list-section">
        <div className="section-header">
          <span className="section-title">Your receipts</span>
          <button
            onClick={loadReceipts}
            style={{ color: 'var(--clr-ink-soft)', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem' }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {/* Filters */}
        {allCategories.length > 1 && (
          <div className="receipts-filter-bar">
            {allCategories.map(cat => (
              <button
                key={cat}
                className={`filter-chip${filter === cat ? ' active' : ''}`}
                onClick={() => setFilter(cat)}
              >
                {cat === 'All' ? 'All' : `${categoryEmoji(cat)} ${cat}`}
              </button>
            ))}
          </div>
        )}

        <div className="receipts-table-card">
          {loadingReceipts ? (
            <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
              <div className="loading-spinner" style={{ margin: '0 auto' }} />
            </div>
          ) : filteredReceipts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🧾</div>
              <div className="empty-title">No receipts yet</div>
              <div className="empty-desc">
                Scan your first receipt above and it will appear here
              </div>
            </div>
          ) : (
            filteredReceipts.map(r => (
              <div key={r.id} className="receipt-row">
                <div className="receipt-row-thumb">
                  {r.image_url
                    ? <img src={r.image_url} alt={r.merchant} />
                    : categoryEmoji(r.category)
                  }
                </div>
                <div className="receipt-row-info">
                  <div className="receipt-row-merchant">{r.merchant || 'Unknown merchant'}</div>
                  <div className="receipt-row-meta">
                    <span className="receipt-row-date">
                      {r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                    </span>
                    {r.category && (
                      <span className="receipt-row-category">{r.category}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <span className="receipt-row-amount">
                    ${parseFloat(r.total || r.amount || 0).toFixed(2)}
                  </span>
                  <div className={`receipt-status-dot ${r.status}`} title={r.status} />
                </div>
              </div>
            ))
          )}
        </div>

        {filteredReceipts.length > 0 && (
          <div style={{
            marginTop: 'var(--space-3)',
            textAlign: 'right',
            fontSize: '0.875rem',
            color: 'var(--clr-ink-soft)',
            fontFamily: 'var(--font-display)',
          }}>
            Total: <strong style={{ color: 'var(--clr-ink)' }}>
              ${filteredReceipts.reduce((sum, r) => sum + parseFloat(r.total || r.amount || 0), 0).toFixed(2)}
            </strong>
          </div>
        )}
      </div>
    </div>
  )
}
