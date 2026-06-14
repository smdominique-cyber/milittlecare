// Generalized document slot — the reusable backbone behind G4
// (fingerprint reprint, 2026-06-14) and the eventual PR #21 property
// records / PR #18 staff file gaps. Modeled on
// `src/components/funding/FundingDocumentSlot.jsx` (the PR #2
// precedent); the funding slot stays in place because its data model
// — keyed on a funding_source_id parent FK + a funding-specific enum
// — predates this generalization. This component takes the same
// shape but parameterizes the table + bucket + path/url helpers, so
// the consent-attachments and the compliance-documents substrates
// can both drive it (and the funding slot can adopt it later when
// the layout diverges enough to be worth the refactor).
//
// Required props:
//
//   table       — Postgres table name. e.g. 'compliance_documents'
//   bucket      — Storage bucket name. e.g. 'compliance-documents'
//   documentType — discriminator. e.g. 'fingerprint_reprint'
//   config      — { title, badge, help, multi } (see ComplianceDocumentSlot)
//   buildStoragePath — fn({ userId, documentType, file }) -> path string
//   getSignedUrl     — async fn(storagePath) -> string|null
//   parentScope      — optional { columnName, value } for tables that
//                       carry a parent FK (funding_documents). Omit for
//                       provider-level tables like compliance_documents.
//   onChanged        — optional callback after any successful write.
//
// NOTE: this component intentionally mirrors FundingDocumentSlot's
// structure rather than refactoring the original. The funding
// component has funding-specific behavior (license-exempt badge
// swap, partial-unique-index constraint awareness, dynamic
// help-text) that doesn't generalize cleanly. Keep both until the
// next consumer joins (#21 or #18); revisit then.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, FileText, Info, RotateCw, Trash2, Upload } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { validateFile, defaultRetentionUntil } from '@/lib/storage'

const FORMAT_HINT = 'PDF, JPG, PNG, or HEIC. Up to 10 MB.'
const WORD_DOC_HINT =
  'For Word documents, export or print to PDF before uploading.'
const DROP_PROMPT = 'Drop a file here, or click to choose'
const ADD_ANOTHER_PROMPT = 'Add another file'

const RETENTION_TOOLTIP =
  'Audit retention defaults to 4 years per the MILittleCare ' +
  'document-retention convention. This date tracks when retention ' +
  'requirements end for this document. Contact support if you need ' +
  'a longer window for a special case.'

const REMOVE_CONFIRM =
  'Remove this document?\n\n' +
  'It stays on file for audit retention — nothing is permanently deleted. ' +
  'You can ask support to restore it if needed.'

const ERRORS = {
  upload:
    'Couldn’t finish uploading. Check your connection and try again. ' +
    'If it keeps happening, email support@milittlecare.com.',
  insert:
    'Upload finished but we couldn’t save the record. Try again, or ' +
    'email support@milittlecare.com.',
  view:
    'Couldn’t open this file. Refresh and try again, or email ' +
    'support@milittlecare.com.',
  replace:
    'Upload finished but couldn’t save the new version. Your previous ' +
    'file is hidden — try the replace again to restore it. If it keeps ' +
    'failing, email support@milittlecare.com.',
  remove:
    'Couldn’t archive this file. Try again, or email ' +
    'support@milittlecare.com.',
  fetch:
    'Couldn’t load attached documents. Refresh the page, or email ' +
    'support@milittlecare.com.',
}

const ACCEPT_ATTR =
  '.pdf,.jpg,.jpeg,.png,.heic,.heif,' +
  'application/pdf,image/jpeg,image/png,image/heic,image/heif'

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export default function DocumentSlot({
  table,
  bucket,
  documentType,
  config,
  buildStoragePath,
  getSignedUrl,
  parentScope,
  onChanged,
}) {
  if (!table || !bucket || !documentType || !config) {
    if (typeof console !== 'undefined') {
      console.warn(
        'DocumentSlot: missing required props ' +
        `{ table, bucket, documentType, config } (got ${table} / ${bucket} / ${documentType})`
      )
    }
    return null
  }

  const { user } = useAuth()
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Compose the WHERE clause once. `parentScope` is opt-in: when
  // present, the slot is keyed on (parent_column, type); when absent,
  // the slot is keyed on (user_id, type) — the provider-level case
  // compliance_documents implements.
  const buildSelectFilter = (q) => {
    let next = q.eq('document_type', documentType).is('archived_at', null)
    if (parentScope?.columnName) {
      next = next.eq(parentScope.columnName, parentScope.value)
    } else {
      next = next.eq('user_id', user?.id)
    }
    return next
  }

  // Initial fetch + refetch on key change.
  useEffect(() => {
    if (!user) {
      setLoading(false)
      return undefined
    }
    if (parentScope?.columnName && !parentScope.value) {
      // Caller hasn't supplied the parent id yet (e.g. funding source
      // not picked) — keep the slot in loading until they do.
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    buildSelectFilter(supabase.from(table).select('*'))
      .order('uploaded_at', { ascending: false })
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          console.error('DocumentSlot: fetch failed', err)
          setError(ERRORS.fetch)
          setLoading(false)
          return
        }
        setDocuments(data || [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, documentType, user?.id, parentScope?.columnName, parentScope?.value])

  const refetch = async () => {
    const { data, error: err } = await buildSelectFilter(
      supabase.from(table).select('*')
    ).order('uploaded_at', { ascending: false })
    if (!err) setDocuments(data || [])
  }

  // Build the INSERT payload. parentScope inserts the column on
  // funding_documents; without it, the row is provider-level.
  const buildInsertPayload = (file, path) => {
    const base = {
      user_id: user.id,
      document_type: documentType,
      storage_path: path,
      original_filename: file.name,
      content_type: file.type || 'application/octet-stream',
      file_size_bytes: file.size,
      uploaded_by_user_id: user.id,
      retention_until: defaultRetentionUntil(),
    }
    if (parentScope?.columnName && parentScope.value) {
      base[parentScope.columnName] = parentScope.value
    }
    return base
  }

  const handleUpload = async (file) => {
    setError(null)
    const validation = validateFile(file)
    if (!validation.ok) {
      setError(validation.reason)
      return
    }
    if (!user) {
      setError(ERRORS.upload)
      return
    }
    setBusy(true)
    let uploadedPath = null
    try {
      const path = buildStoragePath({ userId: user.id, documentType, file })
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(path, file, {
          contentType: file.type || 'application/octet-stream',
        })
      if (upErr) throw new SlotError('upload', upErr)
      uploadedPath = path

      const { error: insErr } = await supabase
        .from(table)
        .insert(buildInsertPayload(file, path))
      if (insErr) throw new SlotError('insert', insErr)

      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('DocumentSlot: upload failed', e)
      if (uploadedPath && e.kind === 'insert') {
        await supabase.storage
          .from(bucket)
          .remove([uploadedPath])
          .catch(() => {})
      }
      setError(ERRORS[e.kind] || ERRORS.upload)
    } finally {
      setBusy(false)
    }
  }

  // Replace: archive the old metadata row, then insert a new one
  // pointing at the new storage object. Matches the funding slot's
  // ordering — the funding table has a partial unique index that
  // forbids two active rows of the same non-other type per source,
  // so archive must precede insert. compliance_documents has no such
  // index today, but we keep the same ordering so behaviour stays
  // identical when (if) one is added later.
  const handleReplace = async (oldDoc, file) => {
    setError(null)
    const validation = validateFile(file)
    if (!validation.ok) {
      setError(validation.reason)
      return
    }
    if (!user) {
      setError(ERRORS.upload)
      return
    }
    setBusy(true)
    let uploadedPath = null
    let oldArchived = false
    try {
      const path = buildStoragePath({ userId: user.id, documentType, file })
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(path, file, {
          contentType: file.type || 'application/octet-stream',
        })
      if (upErr) throw new SlotError('upload', upErr)
      uploadedPath = path

      const { error: arcErr } = await supabase
        .from(table)
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user.id,
        })
        .eq('id', oldDoc.id)
      if (arcErr) throw new SlotError('replace', arcErr)
      oldArchived = true

      const { error: insErr } = await supabase
        .from(table)
        .insert(buildInsertPayload(file, path))
      if (insErr) throw new SlotError('replace', insErr)

      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('DocumentSlot: replace failed', e)
      if (oldArchived) {
        await supabase
          .from(table)
          .update({ archived_at: null, archived_by: null })
          .eq('id', oldDoc.id)
          .then(() => {}, () => {})
      }
      if (uploadedPath) {
        await supabase.storage
          .from(bucket)
          .remove([uploadedPath])
          .catch(() => {})
      }
      setError(ERRORS[e.kind] || ERRORS.upload)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (doc) => {
    if (typeof window !== 'undefined' && !window.confirm(REMOVE_CONFIRM)) return
    setError(null)
    setBusy(true)
    try {
      const { error: arcErr } = await supabase
        .from(table)
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user.id,
        })
        .eq('id', doc.id)
      if (arcErr) throw arcErr
      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('DocumentSlot: remove failed', e)
      setError(ERRORS.remove)
    } finally {
      setBusy(false)
    }
  }

  const handleView = async (doc) => {
    setError(null)
    const url = await getSignedUrl(doc.storage_path)
    if (!url) {
      setError(ERRORS.view)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div style={slotStyle}>
      <SlotHeader title={config.title} badge={config.badge} help={config.help} />

      {error && <ErrorBanner text={error} />}

      {loading ? (
        <p style={loadingStyle}>Loading documents…</p>
      ) : config.multi ? (
        <>
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              busy={busy}
              onView={() => handleView(doc)}
              onReplace={(file) => handleReplace(doc, file)}
              onRemove={() => handleRemove(doc)}
            />
          ))}
          <DropZone
            label={documents.length === 0 ? DROP_PROMPT : ADD_ANOTHER_PROMPT}
            busy={busy}
            onPick={handleUpload}
          />
        </>
      ) : documents.length === 0 ? (
        <DropZone label={DROP_PROMPT} busy={busy} onPick={handleUpload} />
      ) : (
        <DocumentRow
          doc={documents[0]}
          busy={busy}
          onView={() => handleView(documents[0])}
          onReplace={(file) => handleReplace(documents[0], file)}
          onRemove={() => handleRemove(documents[0])}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents (cribbed verbatim from FundingDocumentSlot — same
// presentational shape so the two slots feel identical to the user)
// -----------------------------------------------------------------------------

function SlotHeader({ title, badge, help }) {
  return (
    <div style={headerStyle}>
      <span style={titleStyle}>{title}</span>
      {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
      {help && (
        <HelpTooltip text={help} label={`Help: ${title}`}>
          <Info size={14} style={{ color: 'var(--clr-ink-soft)' }} />
        </HelpTooltip>
      )}
    </div>
  )
}

function Badge({ tone, children }) {
  const palette =
    tone === 'required'
      ? { bg: 'var(--clr-warm-mid)', fg: 'var(--clr-ink)' }
      : { bg: 'var(--clr-cream)', fg: 'var(--clr-ink-soft)' }
  return (
    <span
      style={{
        fontSize: '0.6875rem',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        background: palette.bg,
        color: palette.fg,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

function ErrorBanner({ text }) {
  return (
    <div role="alert" style={errorBannerStyle}>
      {text}
    </div>
  )
}

function DropZone({ label, busy, onPick }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const openPicker = () => {
    if (busy) return
    inputRef.current?.click()
  }
  const onChange = (e) => {
    const f = e.target.files?.[0]
    if (f) onPick(f)
    e.target.value = ''
  }
  const onDragOver = (e) => {
    e.preventDefault()
    if (!busy) setDragging(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault()
    setDragging(false)
  }
  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    const f = e.dataTransfer?.files?.[0]
    if (f) onPick(f)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPicker()
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        ...dropZoneStyle,
        ...(dragging ? dropZoneActiveStyle : {}),
        opacity: busy ? 0.6 : 1,
        cursor: busy ? 'progress' : 'pointer',
      }}
    >
      <Upload size={20} style={{ color: 'var(--clr-ink-soft)', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500 }}>{busy ? 'Uploading…' : label}</div>
        <div
          style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-soft)',
            marginTop: 2,
          }}
        >
          {FORMAT_HINT}
        </div>
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--clr-ink-soft)',
            marginTop: 4,
            fontStyle: 'italic',
          }}
        >
          {WORD_DOC_HINT}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={onChange}
        style={{ display: 'none' }}
        disabled={busy}
      />
    </div>
  )
}

function DocumentRow({ doc, busy, onView, onReplace, onRemove }) {
  const replaceInputRef = useRef(null)
  const onReplaceClick = () => {
    if (busy) return
    replaceInputRef.current?.click()
  }
  const onReplaceChange = (e) => {
    const f = e.target.files?.[0]
    if (f) onReplace(f)
    e.target.value = ''
  }

  return (
    <div style={rowStyle}>
      <FileText
        size={20}
        style={{ color: 'var(--clr-ink-soft)', flexShrink: 0, marginTop: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>
          {doc.original_filename}
        </div>
        <div
          style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-soft)',
            marginTop: 2,
          }}
        >
          Uploaded {formatDate(doc.uploaded_at)}
        </div>
        <div
          style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-soft)',
            marginTop: 2,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          Kept on file until {formatDate(doc.retention_until)}
          <HelpTooltip text={RETENTION_TOOLTIP} label="Help: retention date">
            <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'stretch',
        }}
      >
        <button className="btn-discard" onClick={onView} disabled={busy} style={btnStyle}>
          <Eye size={14} /> View
        </button>
        <button className="btn-discard" onClick={onReplaceClick} disabled={busy} style={btnStyle}>
          <RotateCw size={14} /> Replace
        </button>
        <input
          ref={replaceInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onReplaceChange}
          style={{ display: 'none' }}
          disabled={busy}
        />
        <button className="btn-discard" onClick={onRemove} disabled={busy} style={btnStyle}>
          <Trash2 size={14} /> Remove
        </button>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function formatDate(isoOrYmd) {
  if (!isoOrYmd) return ''
  const d = new Date(isoOrYmd)
  if (Number.isNaN(d.getTime())) return ''
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

class SlotError extends Error {
  constructor(kind, cause) {
    super(`SlotError: ${kind}`)
    this.kind = kind
    this.cause = cause
  }
}

// -----------------------------------------------------------------------------
// Inline styles (same as FundingDocumentSlot's — feel identical)
// -----------------------------------------------------------------------------

const slotStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) 0',
  borderBottom: '1px solid var(--clr-warm-mid)',
}
const headerStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const titleStyle = { fontWeight: 500, fontSize: '0.9375rem', color: 'var(--clr-ink)' }
const loadingStyle = { margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-soft)' }
const dropZoneStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 12,
  padding: 'var(--space-4)',
  border: '2px dashed var(--clr-warm-mid)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--clr-cream)',
  outline: 'none',
}
const dropZoneActiveStyle = {
  borderColor: 'var(--clr-ink)',
  background: 'var(--clr-warm-mid)',
}
const rowStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 12,
  padding: 'var(--space-3)',
  background: 'var(--clr-cream)',
  borderRadius: 'var(--radius-md)',
}
const btnStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: 6, padding: '0.375rem 0.75rem',
  fontSize: '0.8125rem', whiteSpace: 'nowrap',
}
const errorBannerStyle = {
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
}
