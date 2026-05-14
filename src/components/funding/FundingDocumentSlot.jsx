// TODO(testing): Render tests pending React Testing Library install. Cover:
// loading/empty/populated states, license-exempt badge swap on
// enrollment_agreement, upload validation surfacing, replace flow's
// archive-then-insert ordering, and remove flow soft-delete.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, FileText, Info, RotateCw, Trash2, Upload } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import {
  BUCKET,
  buildStoragePath,
  defaultRetentionUntil,
  getSignedFundingDocUrl,
  validateFile,
} from '@/lib/fundingDocuments'

// -----------------------------------------------------------------------------
// Per-document-type configuration (per CLAUDE.md § Documentation Conventions
// rule 1: every user-facing element has inline help)
// -----------------------------------------------------------------------------

const TYPE_CONFIG = {
  dhs_198: {
    title: 'DHS-198 letter',
    badge: { text: 'Required for I-Billing', tone: 'required' },
    help:
      'Upload the most recent DHS-198 authorization letter from MDHHS. ' +
      'The case number, dates, and approved hours above come from this ' +
      'letter — keeping the original here gives you something to point ' +
      'to if a billing period is questioned. When MDHHS reauthorizes ' +
      '(typically every 6 months), upload the new letter and we’ll keep ' +
      'the prior one on file for audit.',
    multi: false,
  },
  enrollment_agreement: {
    title: 'Enrollment Agreement',
    // badge + help are dynamic based on isLicenseExempt — see component.
    helpLicensed:
      'Upload the signed Enrollment Agreement between you and the family. ' +
      'Licensed providers must keep this on file for the duration of CDC ' +
      'authorization plus 4 years. License-exempt providers don’t need ' +
      'this — leave it blank.',
    helpLicenseExempt:
      'Upload the signed Enrollment Agreement between you and the family ' +
      'if you have one. License-exempt providers aren’t required to use ' +
      'one for CDC, but you’re welcome to store voluntary written ' +
      'agreements with families here for your records.',
    multi: false,
  },
  other: {
    title: 'Other documents',
    badge: { text: 'Optional', tone: 'neutral' },
    help:
      'A place for anything else MDHHS or the family might ask about — ' +
      'Notice of Action letters, change-of-circumstance forms, prior ' +
      'DHS-198s, or supporting paperwork. You can add as many as you need.',
    multi: true,
  },
}

const RETENTION_TOOLTIP =
  'CDC Scholarship records must be kept for at least 4 years per the ' +
  'MDHHS provider handbook. This date tracks when retention requirements ' +
  'end for this document. You can change it for special cases (longer ' +
  'retention, an active dispute) by contacting support.'

const FORMAT_HINT = 'PDF, JPG, PNG, or HEIC. Up to 10 MB.'
const WORD_DOC_HINT =
  'For Word documents, export or print to PDF before uploading.'
const DROP_PROMPT = 'Drop a file here, or click to choose'
const ADD_ANOTHER_PROMPT = 'Add another file'

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

export default function FundingDocumentSlot(props) {
  const config = TYPE_CONFIG[props.documentType]
  if (!config) {
    if (typeof console !== 'undefined') {
      console.warn(
        `FundingDocumentSlot: unknown documentType "${props.documentType}"`
      )
    }
    return null
  }
  return <SlotInner {...props} config={config} />
}

function SlotInner({ fundingSourceId, documentType, onChanged, config }) {
  const { user } = useAuth()
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [isLicenseExempt, setIsLicenseExempt] = useState(null)

  // Initial fetch + refetch on key change.
  useEffect(() => {
    if (!fundingSourceId || !user) {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    supabase
      .from('funding_documents')
      .select('*')
      .eq('funding_source_id', fundingSourceId)
      .eq('document_type', documentType)
      .is('archived_at', null)
      .order('uploaded_at', { ascending: false })
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          console.error('FundingDocumentSlot: fetch failed', err)
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
  }, [fundingSourceId, documentType, user])

  // Fetch license-exempt status only for the enrollment_agreement variant.
  // Drives the dynamic badge + help text so license-exempt providers see
  // "Optional" instead of being told they don't need a slot they can see.
  useEffect(() => {
    if (documentType !== 'enrollment_agreement' || !user) return undefined
    let cancelled = false
    supabase
      .from('profiles')
      .select('is_license_exempt')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsLicenseExempt(data?.is_license_exempt ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [documentType, user])

  const badge = useMemo(() => {
    if (documentType === 'enrollment_agreement') {
      if (isLicenseExempt === true) {
        return { text: 'Optional for license-exempt', tone: 'neutral' }
      }
      // false OR null (unknown) → default to required-for-licensed
      return { text: 'Required for licensed providers', tone: 'required' }
    }
    return config.badge || null
  }, [documentType, isLicenseExempt, config])

  const helpText = useMemo(() => {
    if (documentType === 'enrollment_agreement') {
      return isLicenseExempt === true
        ? config.helpLicenseExempt
        : config.helpLicensed
    }
    return config.help
  }, [documentType, isLicenseExempt, config])

  const refetch = async () => {
    const { data, error: err } = await supabase
      .from('funding_documents')
      .select('*')
      .eq('funding_source_id', fundingSourceId)
      .eq('document_type', documentType)
      .is('archived_at', null)
      .order('uploaded_at', { ascending: false })
    if (!err) setDocuments(data || [])
  }

  // Add a new document. For single-slot types this is the empty-state
  // upload; for 'other' it's also the "Add another" path.
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
      const path = buildStoragePath({
        userId: user.id,
        fundingSourceId,
        file,
      })
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, {
          contentType: file.type || 'application/octet-stream',
        })
      if (upErr) throw new SlotError('upload', upErr)
      uploadedPath = path

      const { error: insErr } = await supabase
        .from('funding_documents')
        .insert({
          user_id: user.id,
          funding_source_id: fundingSourceId,
          document_type: documentType,
          storage_path: path,
          original_filename: file.name,
          content_type: file.type || 'application/octet-stream',
          file_size_bytes: file.size,
          uploaded_by_user_id: user.id,
          retention_until: defaultRetentionUntil(),
        })
      if (insErr) throw new SlotError('insert', insErr)

      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('FundingDocumentSlot: upload failed', e)
      // Orphan cleanup: storage object exists but metadata insert failed.
      if (uploadedPath && e.kind === 'insert') {
        await supabase.storage
          .from(BUCKET)
          .remove([uploadedPath])
          .catch(() => {})
      }
      setError(ERRORS[e.kind] || ERRORS.upload)
    } finally {
      setBusy(false)
    }
  }

  // Replace an existing document. Required ordering: archive old THEN
  // insert new — the partial-unique index funding_documents_one_active_per_type
  // forbids two active rows of the same non-other type per source. A
  // failed insert after archive triggers a best-effort restore so the
  // user is not left with no active document.
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
      const path = buildStoragePath({
        userId: user.id,
        fundingSourceId,
        file,
      })
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, {
          contentType: file.type || 'application/octet-stream',
        })
      if (upErr) throw new SlotError('upload', upErr)
      uploadedPath = path

      const { error: arcErr } = await supabase
        .from('funding_documents')
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user.id,
        })
        .eq('id', oldDoc.id)
      if (arcErr) throw new SlotError('replace', arcErr)
      oldArchived = true

      const { error: insErr } = await supabase
        .from('funding_documents')
        .insert({
          user_id: user.id,
          funding_source_id: fundingSourceId,
          document_type: documentType,
          storage_path: path,
          original_filename: file.name,
          content_type: file.type || 'application/octet-stream',
          file_size_bytes: file.size,
          uploaded_by_user_id: user.id,
          retention_until: defaultRetentionUntil(),
        })
      if (insErr) throw new SlotError('replace', insErr)

      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('FundingDocumentSlot: replace failed', e)
      if (oldArchived) {
        await supabase
          .from('funding_documents')
          .update({ archived_at: null, archived_by: null })
          .eq('id', oldDoc.id)
          .then(() => {}, () => {})
      }
      if (uploadedPath) {
        await supabase.storage
          .from(BUCKET)
          .remove([uploadedPath])
          .catch(() => {})
      }
      setError(ERRORS[e.kind] || ERRORS.upload)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (doc) => {
    if (!window.confirm(REMOVE_CONFIRM)) return
    setError(null)
    setBusy(true)
    try {
      const { error: arcErr } = await supabase
        .from('funding_documents')
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user.id,
        })
        .eq('id', doc.id)
      if (arcErr) throw arcErr
      await refetch()
      onChanged?.()
    } catch (e) {
      console.error('FundingDocumentSlot: remove failed', e)
      setError(ERRORS.remove)
    } finally {
      setBusy(false)
    }
  }

  const handleView = async (doc) => {
    setError(null)
    const url = await getSignedFundingDocUrl(doc.storage_path)
    if (!url) {
      setError(ERRORS.view)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div style={slotStyle}>
      <SlotHeader title={config.title} badge={badge} help={helpText} />

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
            label={
              documents.length === 0 ? DROP_PROMPT : ADD_ANOTHER_PROMPT
            }
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
// Subcomponents
// -----------------------------------------------------------------------------

function SlotHeader({ title, badge, help }) {
  return (
    <div style={headerStyle}>
      <span style={titleStyle}>{title}</span>
      {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
      <HelpTooltip text={help} label={`Help: ${title}`}>
        <Info size={14} style={{ color: 'var(--clr-ink-soft)' }} />
      </HelpTooltip>
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
        <button
          className="btn-discard"
          onClick={onView}
          disabled={busy}
          style={btnStyle}
        >
          <Eye size={14} /> View
        </button>
        <button
          className="btn-discard"
          onClick={onReplaceClick}
          disabled={busy}
          style={btnStyle}
        >
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
        <button
          className="btn-discard"
          onClick={onRemove}
          disabled={busy}
          style={btnStyle}
        >
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
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function formatDate(isoOrYmd) {
  if (!isoOrYmd) return ''
  // Accepts both timestamptz (uploaded_at) and YYYY-MM-DD (retention_until).
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
// Inline styles (per docs/tech_debt.md: lift to CSS classes when a third
// file joins src/components/funding/, or earlier if styling diverges)
// -----------------------------------------------------------------------------

const slotStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) 0',
  borderBottom: '1px solid var(--clr-warm-mid)',
}

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const titleStyle = {
  fontWeight: 500,
  fontSize: '0.9375rem',
  color: 'var(--clr-ink)',
}

const loadingStyle = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const dropZoneStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
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
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: 'var(--space-3)',
  background: 'var(--clr-cream)',
  borderRadius: 'var(--radius-md)',
}

const btnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0.375rem 0.75rem',
  fontSize: '0.8125rem',
  whiteSpace: 'nowrap',
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
