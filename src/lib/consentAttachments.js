// PR consent-attachments Part 1 — provider-side data layer.
//
// Authoritative spec: docs/pr-consent-attachments-scope.md. This
// module owns every DB write for the consent-attachments substrate:
//   - upload + insert with orphan cleanup on failed insert
//   - soft-delete (archived_at)
//   - list attachments for a consent
//   - provider-side signed-URL (owner-only via storage RLS)
//
// PARENT-SIDE READ goes through `api/consent-attachment-url.js`
// (the Edge Function — the privacy boundary). NOT through this
// module. Calling `getSignedConsentAttachmentUrl` from a parent
// client returns null (the bucket's owner-only storage RLS denies
// the read).
//
// Allowed target_type values (must match migration 029's CHECK
// constraint and the Edge Function's resolution paths):
//   - 'acknowledgment'              — target_id = acknowledgments.id
//   - 'medication_authorization'    — target_id = medication_authorizations.id
//
// No DB-level FK on the polymorphic target (scope doc §6 tradeoff).
// The insert helper here validates the target row EXISTS for the
// named type before inserting; the Edge Function re-validates on
// read. Three layers of defense: app-side insert validation, the
// CHECK constraint on target_type, the Edge Function's resolution
// step that returns null on an orphan.

import { supabase } from './supabase'
import {
  buildScopedStoragePath,
  getSignedUrl,
  validateFile,
  defaultRetentionUntil,
} from './storage'

export const BUCKET = 'consent-attachments'

export const ALLOWED_TARGET_TYPES = Object.freeze([
  'acknowledgment',
  'medication_authorization',
])

// -----------------------------------------------------------------------------
// Path builder — bucket-specific wrapper around the shared helper
// -----------------------------------------------------------------------------

/**
 * Returns the storage object key for a consent-attachment upload,
 * in the format `<providerUserId>/<targetId>/<uuid>.<ext>`. The
 * first segment is what the storage RLS policy keys off
 * (provider-only); the second segment makes per-consent listing
 * trivial; the UUID prevents same-filename collisions on re-upload.
 *
 * Thin wrapper around `buildScopedStoragePath` with the
 * consent-attachments naming for the second segment (`targetId`)
 * preserved at this API surface so call-site code reads clearly.
 */
export function buildStoragePath({ providerUserId, targetId, file }) {
  if (!providerUserId) {
    throw new Error('buildStoragePath: providerUserId is required')
  }
  if (!targetId) {
    throw new Error('buildStoragePath: targetId is required')
  }
  if (!file || !file.name) {
    throw new Error('buildStoragePath: file with name is required')
  }
  return buildScopedStoragePath({
    userId: providerUserId,
    scopeId: targetId,
    file,
  })
}

// -----------------------------------------------------------------------------
// Target validation — defense-in-depth for the polymorphic reference
// -----------------------------------------------------------------------------

/**
 * Verify the named target row exists (and is non-archived) before
 * inserting an attachment that references it. The DB has no FK on
 * the polymorphic `target_id` column (per decision 6 — polymorphism
 * precludes a strict FK). This app-side validator catches the
 * obvious typo / stale-id case before a row is written.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason: string }`
 * otherwise.
 */
export async function validateAttachmentTarget({ targetType, targetId, providerId } = {}) {
  if (!ALLOWED_TARGET_TYPES.includes(targetType)) {
    return { ok: false, reason: `Unknown target_type "${targetType}"` }
  }
  if (!targetId) {
    return { ok: false, reason: 'targetId is required' }
  }

  if (targetType === 'acknowledgment') {
    const { data, error } = await supabase
      .from('acknowledgments')
      .select('id, archived_at, provider_id')
      .eq('id', targetId)
      .maybeSingle()
    if (error) return { ok: false, reason: error.message }
    if (!data) return { ok: false, reason: 'Acknowledgment not found' }
    if (data.archived_at) return { ok: false, reason: 'Acknowledgment is archived' }
    // Cross-tenant defense: providers cannot attach scans to another
    // provider's consent rows even if they somehow knew the ack id.
    if (providerId && data.provider_id !== providerId) {
      return { ok: false, reason: 'Acknowledgment does not belong to this provider' }
    }
    return { ok: true }
  }

  if (targetType === 'medication_authorization') {
    const { data, error } = await supabase
      .from('medication_authorizations')
      .select('id, archived_at, provider_id')
      .eq('id', targetId)
      .maybeSingle()
    if (error) return { ok: false, reason: error.message }
    if (!data) return { ok: false, reason: 'Medication authorization not found' }
    if (data.archived_at) return { ok: false, reason: 'Medication authorization is archived' }
    if (providerId && data.provider_id !== providerId) {
      return { ok: false, reason: 'Medication authorization does not belong to this provider' }
    }
    return { ok: true }
  }

  // Shouldn't reach (the ALLOWED_TARGET_TYPES guard above covers
  // every accepted value), but defensive.
  return { ok: false, reason: `Unhandled target_type "${targetType}"` }
}

// -----------------------------------------------------------------------------
// Upload + insert with orphan cleanup (the atomic write path)
// -----------------------------------------------------------------------------

/**
 * Upload a file to the consent-attachments bucket and insert the
 * matching consent_attachments row. Mirrors the
 * FundingDocumentSlot.handleUpload pattern: upload first, insert
 * second; if the insert fails, delete the just-uploaded storage
 * object so no orphan accumulates.
 *
 * The caller is responsible for first calling `validateFile(file)`
 * (from src/lib/storage.js) and surfacing the friendly rejection
 * reason to the user. This helper assumes the file is acceptable.
 *
 * It DOES re-call validateAttachmentTarget before uploading — a
 * stale target id is cheaper to catch BEFORE the upload than after.
 *
 * Returns `{ data: <inserted row>, error: null }` on success or
 * `{ data: null, error: <error> }` on any failure. Storage orphans
 * are cleaned up best-effort; the returned error reflects the
 * original failure cause, not the cleanup's outcome.
 */
export async function uploadConsentAttachment({
  providerUserId,
  targetType,
  targetId,
  file,
  uploadedByUserId,    // optional; defaults to providerUserId
  retentionUntil,      // optional; defaults to defaultRetentionUntil()
  notes,
} = {}) {
  if (!providerUserId) {
    return { data: null, error: new Error('providerUserId is required') }
  }
  if (!file) {
    return { data: null, error: new Error('file is required') }
  }

  // (1) Validate the file shape.
  const fileCheck = validateFile(file)
  if (!fileCheck.ok) {
    return { data: null, error: new Error(fileCheck.reason) }
  }

  // (2) Validate the polymorphic target row exists and belongs to
  // this provider. Cheaper to fail here than to upload then fail.
  const targetCheck = await validateAttachmentTarget({
    targetType,
    targetId,
    providerId: providerUserId,
  })
  if (!targetCheck.ok) {
    return { data: null, error: new Error(targetCheck.reason) }
  }

  // (3) Build the storage path.
  let path
  try {
    path = buildStoragePath({ providerUserId, targetId, file })
  } catch (err) {
    return { data: null, error: err }
  }

  // (4) Upload.
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, {
      contentType: file.type || 'application/octet-stream',
    })
  if (upErr) {
    return { data: null, error: upErr }
  }

  // (5) Insert metadata. If this fails, clean up the orphan we just
  // uploaded (same pattern as FundingDocumentSlot:262-267).
  const row = {
    provider_id: providerUserId,
    target_type: targetType,
    target_id: targetId,
    storage_path: path,
    original_filename: file.name,
    content_type: file.type || 'application/octet-stream',
    file_size_bytes: file.size,
    uploaded_by_user_id: uploadedByUserId || providerUserId,
    retention_until: retentionUntil || defaultRetentionUntil(),
    notes: notes || null,
  }
  const { data, error: insErr } = await supabase
    .from('consent_attachments')
    .insert([row])
    .select()
    .maybeSingle()
  if (insErr) {
    // Orphan cleanup — best-effort, swallow secondary failures.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {})
    return { data: null, error: insErr }
  }

  return { data, error: null }
}

// -----------------------------------------------------------------------------
// Soft-delete (archive) — the only "remove" path
// -----------------------------------------------------------------------------

/**
 * Soft-delete an attachment metadata row. The storage object stays
 * in the bucket per the retention convention (CLAUDE.md
 * never-hard-delete + the funding-docs precedent). A future
 * retention-sweep cron (still pending, see scope doc §13) handles
 * the eventual storage cleanup once retention_until is past.
 *
 * Returns `{ error: null }` on success.
 */
export async function archiveConsentAttachment({ attachmentId, archivedByUserId } = {}) {
  if (!attachmentId) {
    return { error: new Error('attachmentId is required') }
  }
  const { error } = await supabase
    .from('consent_attachments')
    .update({
      archived_at: new Date().toISOString(),
      archived_by: archivedByUserId || null,
    })
    .eq('id', attachmentId)
  return { error: error || null }
}

// -----------------------------------------------------------------------------
// List attachments for a consent
// -----------------------------------------------------------------------------

/**
 * Fetch active attachments for a given consent target. Default
 * ordering: most-recent `uploaded_at` first. The provider-side and
 * parent-side both call this same helper:
 *
 *   - Provider session: returns rows where provider_id matches
 *     auth.uid() via the provider RLS policy.
 *   - Parent session: returns rows for THIS parent's child's
 *     consents via the parent metadata SELECT policy (the §12
 *     sub-decision). Parents cannot list attachments for children
 *     they aren't linked to — verified by Test 4 in the runbook.
 *
 * Either way the metadata is the same shape; the difference is
 * what the RLS filter returns.
 */
export async function listConsentAttachments({ targetType, targetId, limit } = {}) {
  if (!targetType || !targetId) return { data: [], error: null }
  if (!ALLOWED_TARGET_TYPES.includes(targetType)) {
    return { data: [], error: new Error(`Unknown target_type "${targetType}"`) }
  }
  let query = supabase
    .from('consent_attachments')
    .select(
      'id, provider_id, target_type, target_id, storage_path, ' +
      'original_filename, content_type, file_size_bytes, ' +
      'uploaded_at, uploaded_by_user_id, retention_until, ' +
      'archived_at, created_at, updated_at'
    )
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .is('archived_at', null)
    .order('uploaded_at', { ascending: false })
  if (Number.isFinite(limit) && limit > 0) query = query.limit(limit)
  const { data, error } = await query
  return { data: data || [], error: error || null }
}

// -----------------------------------------------------------------------------
// Provider-side signed URL (owner-only via storage RLS)
// -----------------------------------------------------------------------------

/**
 * Returns a signed URL for an attachment's storage object via the
 * client's own RLS context (provider-only). 15-minute TTL matches
 * funding-docs convention. Returns null on error (RLS denial,
 * missing object, expired session, etc.).
 *
 * PARENTS DO NOT USE THIS. Calling this from a parent client
 * returns null because the bucket's storage RLS gates on
 * first-folder-segment = auth.uid(), and a parent's auth.uid() is
 * never the first segment of an attachment path (that's the
 * provider's). The parent path is the Edge Function
 * `api/consent-attachment-url.js`.
 */
export async function getSignedConsentAttachmentUrl(storagePath, ttlSeconds) {
  return getSignedUrl({ bucket: BUCKET, storagePath, ttlSeconds })
}

/**
 * Parent-side signed URL — call the Edge Function. Returns the
 * signed URL on success or null on any denial (the function
 * collapses 403 → 404 per the anti-enumeration note; callers see
 * "null" either way).
 *
 * The function performs the same join check the parent metadata
 * SELECT policy enforces (and more — it also verifies the target
 * resolves to a child, not just to an ack of any subject_type).
 * Both must deny in the verification gate's Test 4.
 */
export async function getParentSignedConsentAttachmentUrl({ attachmentId } = {}) {
  if (!attachmentId) return null
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return null
    const resp = await fetch('/api/consent-attachment-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ attachment_id: attachmentId }),
    })
    if (!resp.ok) return null
    const body = await resp.json().catch(() => null)
    return body?.signedUrl || null
  } catch (err) {
    console.error('getParentSignedConsentAttachmentUrl: request failed', err)
    return null
  }
}
