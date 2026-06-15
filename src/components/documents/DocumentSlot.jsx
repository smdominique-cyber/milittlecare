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
  // ─── ALL HOOKS GO ABOVE THE PROP-VALIDITY GUARD ─────────────────────
  //
  // 2026-06-15 — rules-of-hooks correction. The prop-validity guard
  // that follows this block used to sit ABOVE these hooks; that meant
  // a caller who re-rendered DocumentSlot with present-then-missing
  // props would skip every hook on the missing-props cycle, leaving
  // React's hook-order tracking out of sync on the next present-props
  // cycle (subsequent useStates would receive each other's values).
  // In production the bug never fired — every caller
  // (ComplianceDocumentSlot, FundingDocumentSlot, etc.) supplies all
  // required props at compile time — but the rule exists for the
  // exact case where a future caller doesn't. Hooks moved up; guard
  // returns null below.
  //
  // Hook bodies that read from `config` use optional chaining so they
  // don't throw when this render is going to be a no-op anyway.

  const { user } = useAuth()
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // 2026-06-14 mig 040 — the provider-entered next-due date for
  // cycle types (radon, heating). Empty string when unset; the
  // payload writes null in that case. For requiresDueDate slots an
  // empty value blocks the upload (the engine would resolve the
  // resulting row to MISSING_REQUIRED 'due-date-missing' anyway —
  // failing client-side surfaces the error where the provider can
  // act on it). For non-cycle slots this state is ignored and the
  // input never renders.
  // `config?.requiresDueDate` — optional chaining so the
  // missing-prop render path (handled by the guard below) doesn't
  // throw before the guard runs.
  const requiresDueDate = !!config?.requiresDueDate
  const [dueDate, setDueDate] = useState('')

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
    // Guard inside the effect body — required props might be missing
    // on this render (the component guard below returns null in that
    // case, but the effect still scheduled and would otherwise call
    // supabase.from(undefined)).
    if (!table || !documentType) {
      setLoading(false)
      return undefined
    }
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

  // Sync the dueDate state with whatever's on the loaded doc — so an
  // existing row's value pre-fills the input rather than reading
  // empty (which would block any subsequent Replace until the
  // provider re-typed the date). Multi-slot configs are excluded
  // because there's no single "current" doc to pre-fill from; the
  // requiresDueDate / multi=true combination would need its own UX
  // and isn't shipping today.
  //
  // `config?.multi` — same optional-chaining reason as above; the
  // hook runs even on the missing-prop render and `config` can be
  // undefined until the prop-validity guard below returns null.
  useEffect(() => {
    if (!requiresDueDate || config?.multi) return
    const current = (documents || []).find(d => !d.archived_at)
    setDueDate(current?.next_due_on || '')
  }, [requiresDueDate, config?.multi, documents])

  // ─── PROP-VALIDITY GUARD (moved BELOW the hooks per rules-of-hooks) ──
  //
  // The guard preserves the original null-render behavior — if a
  // caller forgets a required prop, we still bail. We just bail
  // AFTER the hooks have registered, so the hook-order contract is
  // honored on every render regardless of which props are present.
  if (!table || !bucket || !documentType || !config) {
    if (typeof console !== 'undefined') {
      console.warn(
        'DocumentSlot: missing required props ' +
        `{ table, bucket, documentType, config } (got ${table} / ${bucket} / ${documentType})`
      )
    }
    return null
  }

  // Build the INSERT payload. parentScope inserts the column on
  // funding_documents; without it, the row is provider-level. For
  // cycle types (mig 040, requiresDueDate=true) the provider-entered
  // next_due_on rides through; for non-cycle types the column stays
  // NULL on the row (the migration left it nullable for exactly
  // this case).
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
    if (requiresDueDate) {
      base.next_due_on = dueDate || null
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
    // mig-040 guard. A cycle-type upload without a next-due date
    // would land as a MISSING_REQUIRED 'due-date-missing' row the
    // moment it's saved; failing here puts the error in front of
    // the provider where they can fix it.
    if (requiresDueDate && !dueDate) {
      setError(dueDateMissingMessage(config))
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
    if (requiresDueDate && !dueDate) {
      setError(dueDateMissingMessage(config))
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

      {/* mig-040: due-date input renders ONLY for cycle types. The
          non-cycle path is untouched — fingerprint + notebook never
          see this element, so their behaviour is byte-for-byte
          identical to pre-040. */}
      {requiresDueDate && !loading && (
        <DueDateInput
          documentType={documentType}
          label={config.dueDateLabel}
          help={config.dueDateHelp}
          value={dueDate}
          onChange={setDueDate}
          disabled={busy}
        />
      )}

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

// mig-040: provider-entered next-due date. Required input that
// pre-fills from the active doc's value when present and lives
// above the upload zone so the provider answers it BEFORE picking
// the file. Wrapped in its own component so the type=date / id /
// label association stays tidy across the cycle types without
// repeating the JSX in each consumer.
function DueDateInput({ documentType, label, help, value, onChange, disabled }) {
  const inputId = `document-slot-due-${documentType}`
  return (
    <div style={dueDateGroupStyle}>
      <label htmlFor={inputId} style={dueDateLabelStyle}>
        {label || 'Next due'} <span style={dueDateRequiredStyle}>*</span>
      </label>
      <input
        id={inputId}
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={dueDateInputStyle}
      />
      {help && <p style={dueDateHelpStyle}>{help}</p>}
    </div>
  )
}

// Error message for the requiresDueDate guard. Title-scoped so the
// provider sees "Set a next-due date for the radon test…" instead
// of a generic "this field is required" sentence. The slot's
// title carries the audit-readable name.
function dueDateMissingMessage(config) {
  const what = config && config.title
    ? config.title.toLowerCase()
    : 'this document'
  return (
    `Enter a next-due date for the ${what} before uploading. The ` +
    'requirement needs a date to compare against today — without it, ' +
    'the compliance row stays marked as missing.'
  )
}

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

// mig-040 — due-date input styling
const dueDateGroupStyle = {
  display: 'flex', flexDirection: 'column', gap: 4,
}
const dueDateLabelStyle = {
  fontWeight: 500, fontSize: '0.8125rem', color: 'var(--clr-ink)',
}
const dueDateRequiredStyle = {
  color: 'var(--clr-danger, #b00020)', marginLeft: 2,
}
const dueDateInputStyle = {
  alignSelf: 'flex-start',
  padding: '6px 8px',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.875rem',
  background: 'white',
}
const dueDateHelpStyle = {
  margin: 0, fontSize: '0.75rem', color: 'var(--clr-ink-soft)', lineHeight: 1.4,
}
