// PR consent-attachments Part 2 — reusable attach widget for the
// three consent modals (provider side) AND the parent consents
// panel (parent side).
//
// Authoritative spec: docs/pr-consent-attachments-scope.md §12.
// Every DB/storage operation flows through the Part 1 helpers in
// `src/lib/consentAttachments.js` and `src/lib/storage.js`. NO
// inline `supabase.from(...)` or `supabase.storage(...)` calls here
// — if you find yourself reaching for one, add a helper to the
// data-layer module and call it from here.
//
// Provider mode (`mode='provider'`):
//   - Lists attachments via listConsentAttachments (provider RLS
//     surfaces only their own rows).
//   - Allows upload via uploadConsentAttachment (validates file +
//     target row + provider ownership, builds path, uploads, inserts,
//     cleans up orphan on insert failure).
//   - Allows soft-delete via archiveConsentAttachment.
//   - Opens a signed URL via getSignedConsentAttachmentUrl (direct
//     storage RLS — owner-only).
//
// Parent mode (`mode='parent'`):
//   - Lists attachments via the SAME listConsentAttachments — but
//     the parent SELECT RLS policy on consent_attachments returns
//     only rows for children the parent is actively linked to via
//     parent_family_links. The cross-tenant boundary at the
//     metadata layer.
//   - Opens a signed URL via getParentSignedConsentAttachmentUrl
//     (the Edge Function `api/consent-attachment-url.js` — the
//     privacy boundary at the content layer).
//   - NO upload, NO remove. Parents see what's on file; the
//     provider records.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, Paperclip, Trash2, Upload } from 'lucide-react'
import { compressImageForDocument, validateFile, REJECTION_REASONS } from '@/lib/storage'
import {
  ALLOWED_TARGET_TYPES,
  archiveConsentAttachment,
  getParentSignedConsentAttachmentUrl,
  getSignedConsentAttachmentUrl,
  listConsentAttachments,
  uploadConsentAttachment,
} from '@/lib/consentAttachments'

const FORMAT_HINT = 'PDF, JPG, PNG, or HEIC. Up to 10 MB.'
const REMOVE_CONFIRM =
  'Remove this attachment?\n\n' +
  'It stays on file for audit retention — nothing is permanently deleted. ' +
  'The file is no longer visible to the parent or in the recent list.'

const ERRORS = Object.freeze({
  list: 'Couldn\'t load the attachments. Refresh and try again.',
  upload:
    'Couldn\'t finish uploading. Check your connection and try again. ' +
    'If it keeps happening, email support@milittlecare.com.',
  view: 'Couldn\'t open this file. Refresh and try again.',
  remove: 'Couldn\'t remove the attachment. Try again.',
})

/**
 * Reusable attach widget. Renders a compact section: a heading,
 * the recent-N list of attachments (filename + uploaded date +
 * view + remove), and (provider only) an upload affordance.
 *
 * Props:
 * - mode: 'provider' | 'parent'   — REQUIRED.
 * - providerUserId: string         — required for provider mode (the licensee's auth.uid()).
 * - targetType: 'acknowledgment' | 'medication_authorization' — REQUIRED.
 * - targetId: string (uuid)        — REQUIRED; the consent row this widget attaches to.
 * - label: string                  — optional heading override.
 * - onChange: () => void           — optional; fires after a successful upload or archive.
 *
 * The widget does NOT render anything if `targetId` is falsy — the
 * caller is responsible for guarding (e.g., only show after the
 * consent ack has been saved).
 */
export default function ConsentAttachmentSlot({
  mode,
  providerUserId,
  targetType,
  targetId,
  label,
  onChange,
}) {
  const [attachments, setAttachments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(null)   // text shown briefly after a save
  const inputRef = useRef(null)

  // Defensive — refuse to render if the caller gave a bogus target.
  // The data-layer helpers also validate; this is a UI-level guard so
  // we don't issue an invalid query.
  const targetValid = !!targetId && ALLOWED_TARGET_TYPES.includes(targetType)

  const refresh = useCallback(async () => {
    if (!targetValid) return
    setLoading(true)
    setError(null)
    const { data, error: err } = await listConsentAttachments({
      targetType, targetId, limit: 5,
    })
    if (err) setError(ERRORS.list)
    else setAttachments(data || [])
    setLoading(false)
  }, [targetType, targetId, targetValid])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-clear the success chip after 3s — same pattern as the
  // MedicationModal save-confirmation chip.
  useEffect(() => {
    if (!success) return undefined
    const t = setTimeout(() => setSuccess(null), 3000)
    return () => clearTimeout(t)
  }, [success])

  if (!targetValid) return null

  // ─── Upload (provider only) ────────────────────────────────────

  async function handleFile(file) {
    if (mode !== 'provider') return
    setError(null)

    // Validate via the shared helper FIRST so we never start an
    // upload with a known-bad file (wrong type, empty, oversize).
    const check = validateFile(file)
    if (!check.ok) {
      setError(check.reason)
      return
    }

    setBusy(true)
    // 2026-06-02 (consent-attachment UX pass): compress phone photos
    // before upload so a normal 5–8 MB iPhone shot doesn't trip the
    // 10 MB cap and downstream lists stay light. PDFs and small
    // images bypass. On compression failure, the helper falls back to
    // the original — we never block a paper attach on a JS-library
    // edge case. See src/lib/storage.js § compressImageForDocument.
    const fileToUpload = await compressImageForDocument(file)
    const { error: e } = await uploadConsentAttachment({
      providerUserId,
      targetType,
      targetId,
      file: fileToUpload,
    })
    setBusy(false)
    if (e) {
      // Helper returns a friendly message for validation errors;
      // generic upload-failed message otherwise.
      setError(
        e.message && (
          e.message === REJECTION_REASONS.NO_FILE ||
          e.message === REJECTION_REASONS.EMPTY ||
          e.message === REJECTION_REASONS.WRONG_TYPE ||
          /\bMB\b/.test(e.message)
        )
          ? e.message
          : (e.message || ERRORS.upload)
      )
      return
    }
    await refresh()
    setSuccess('✓ Attachment saved')
    onChange?.()
    if (inputRef.current) inputRef.current.value = ''
  }

  function handleFileInputChange(e) {
    const file = e.target.files && e.target.files[0]
    if (file) handleFile(file)
  }

  function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    if (mode !== 'provider' || busy) return
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    if (file) handleFile(file)
  }
  function preventDefault(e) { e.preventDefault(); e.stopPropagation() }

  // ─── View ───────────────────────────────────────────────────────

  async function handleView(attachment) {
    setError(null)
    const url = mode === 'parent'
      ? await getParentSignedConsentAttachmentUrl({ attachmentId: attachment.id })
      : await getSignedConsentAttachmentUrl(attachment.storage_path)
    if (!url) {
      setError(ERRORS.view)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  // ─── Remove (provider only) ────────────────────────────────────

  async function handleRemove(attachment) {
    if (mode !== 'provider') return
    if (!window.confirm(REMOVE_CONFIRM)) return
    setError(null)
    setBusy(true)
    const { error: e } = await archiveConsentAttachment({
      attachmentId: attachment.id,
      archivedByUserId: providerUserId,
    })
    setBusy(false)
    if (e) {
      setError(ERRORS.remove)
      return
    }
    await refresh()
    setSuccess('✓ Attachment removed')
    onChange?.()
  }

  const heading = label || (mode === 'parent' ? 'Signed forms on file' : 'Signed paper form')

  return (
    <div
      data-testid="consent-attachment-slot"
      data-mode={mode}
      data-target-type={targetType}
      style={{
        marginTop: 10,
        padding: 10,
        border: '1px dashed var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--clr-cream)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', fontWeight: 600 }}>
          <Paperclip size={14} aria-hidden="true" />
          <span>{heading}</span>
          <span style={{ fontWeight: 400, color: 'var(--clr-ink-soft)' }}>
            ({attachments.length})
          </span>
        </div>
        {success && (
          <span
            role="status"
            aria-live="polite"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'var(--clr-sage-pale, #e6efe7)',
              color: 'var(--clr-sage-dark)',
              padding: '2px 8px', borderRadius: 'var(--radius-full)',
              fontSize: '0.6875rem', fontWeight: 600, whiteSpace: 'nowrap',
            }}
          >
            <CheckCircle2 size={12} aria-hidden="true" />
            {success}
          </span>
        )}
      </div>

      {/* Existing attachments list */}
      {loading ? (
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>Loading…</p>
      ) : attachments.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', fontStyle: 'italic' }}>
          {mode === 'parent' ? 'None on file yet.' : 'No signed form attached yet.'}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.8125rem', color: 'var(--clr-ink-mid)' }}>
          {attachments.map(a => (
            <li
              key={a.id}
              data-testid="attachment-row"
              data-attachment-id={a.id}
              style={{
                padding: '6px 0',
                borderTop: '1px solid var(--clr-warm-mid)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {a.original_filename}
                <span style={{ color: 'var(--clr-ink-soft)', marginLeft: 6 }}>
                  · {formatDate(a.uploaded_at)}
                </span>
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="btn-discard"
                  onClick={() => handleView(a)}
                  disabled={busy}
                  style={{ padding: '2px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  aria-label={`View ${a.original_filename}`}
                >
                  <Eye size={12} aria-hidden="true" /> View
                </button>
                {mode === 'provider' && (
                  <button
                    type="button"
                    className="btn-discard"
                    onClick={() => handleRemove(a)}
                    disabled={busy}
                    style={{ padding: '2px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    aria-label={`Remove ${a.original_filename}`}
                  >
                    <Trash2 size={12} aria-hidden="true" /> Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Upload affordance (provider only) */}
      {mode === 'provider' && (
        <div
          onDrop={handleDrop}
          onDragOver={preventDefault}
          onDragEnter={preventDefault}
          style={{ marginTop: 8 }}
        >
          <label
            data-testid="attachment-upload-label"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 10px',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-md)',
              background: 'white',
              cursor: busy ? 'wait' : 'pointer',
              fontSize: '0.75rem',
              color: 'var(--clr-ink-mid)',
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Upload size={12} aria-hidden="true" />
            <span>{busy ? 'Uploading…' : 'Attach signed form'}</span>
            {/* `capture="environment"` hints mobile browsers (iOS Safari,
                Chrome Android) to open the rear camera directly so a
                provider standing at the kitchen table can photograph a
                signed paper without leaving the modal. Desktop browsers
                ignore the hint and fall back to the file picker — same
                component, same code path. Mobile OS file pickers also
                surface a library option from the camera flow if the
                provider already photographed the paper. */}
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif"
              capture="environment"
              data-testid="attachment-file-input"
              onChange={handleFileInputChange}
              disabled={busy}
              style={{ display: 'none' }}
            />
          </label>
          <span style={{ marginLeft: 8, fontSize: '0.6875rem', color: 'var(--clr-ink-soft)' }}>
            {FORMAT_HINT}
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 8, padding: 6,
            background: 'var(--clr-danger-pale)',
            color: 'var(--clr-danger)',
            fontSize: '0.75rem', borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'flex-start', gap: 6,
          }}
        >
          <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch {
    return ''
  }
}
