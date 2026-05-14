// Pure helpers for the funding document vault. Async signed-URL
// fetcher is here too but lazy-imports the supabase client so unit
// tests can exercise the pure helpers without env-var setup.
//
// See supabase/migrations/008_funding_documents.sql for the data model.

export const BUCKET = 'funding-documents'

export const MAX_FILE_SIZE_MB = 10
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

// 15 minutes. Long enough to open the document, short enough that a
// shared link from a leaked screen recording goes stale quickly.
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60

// Allowlist per CLAUDE.md domain rules + PR #2 directives:
//   PDF for compliance documents.
//   JPG/PNG/HEIC/HEIF for phone photos of those documents.
//   No Word docs — compliance evidence must be immutable; export to PDF.
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
])

export const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'heic',
  'heif',
])

export const REJECTION_REASONS = {
  NO_FILE: 'No file selected. Pick a file to upload.',
  EMPTY:
    'This file looks empty. Pick a different file, or re-export the PDF if it ' +
    'came from a print-to-PDF that didn’t finish.',
  WRONG_TYPE:
    'Only PDF and image files (JPG, PNG, HEIC) are accepted. For Word ' +
    'documents, export or print to PDF before uploading.',
}

export function rejectionForOversize(actualBytes) {
  const mb = (actualBytes / 1024 / 1024).toFixed(1)
  return (
    `This file is ${mb} MB, larger than the ${MAX_FILE_SIZE_MB} MB limit. ` +
    'Try compressing the PDF, or photograph just the page you need rather ' +
    'than the whole packet.'
  )
}

// -----------------------------------------------------------------------------
// validateFile — pure
// -----------------------------------------------------------------------------
//
// Returns { ok: true } or { ok: false, reason: string }.
// Reason is intended for direct surfacing to the user (per directive F:
// friendly error messages).
//
// MIME-or-extension acceptance: iOS Safari sometimes reports HEIC photos
// with an empty MIME or 'application/octet-stream'. We accept the file if
// EITHER its declared MIME OR its extension is on the allowlist, so a
// genuine HEIC isn't rejected for browser quirks.
export function validateFile(file) {
  if (!file) {
    return { ok: false, reason: REJECTION_REASONS.NO_FILE }
  }
  if (file.size === 0) {
    return { ok: false, reason: REJECTION_REASONS.EMPTY }
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: rejectionForOversize(file.size) }
  }
  const ext = getExtension(file.name)
  const mime = (file.type || '').toLowerCase()
  const mimeOk = ALLOWED_MIME_TYPES.has(mime)
  const extOk = ALLOWED_EXTENSIONS.has(ext)
  if (!mimeOk && !extOk) {
    return { ok: false, reason: REJECTION_REASONS.WRONG_TYPE }
  }
  return { ok: true }
}

// -----------------------------------------------------------------------------
// buildStoragePath — pure
// -----------------------------------------------------------------------------
//
// Returns the storage object key for an upload, in the format
// `<userId>/<fundingSourceId>/<uuid>.<ext>`. The first segment is what
// the storage RLS policy keys off; the second segment makes per-source
// listing trivial; the UUID prevents same-filename collisions on
// re-upload.
export function buildStoragePath({ userId, fundingSourceId, file }) {
  if (!userId) {
    throw new Error('buildStoragePath: userId is required')
  }
  if (!fundingSourceId) {
    throw new Error('buildStoragePath: fundingSourceId is required')
  }
  if (!file || !file.name) {
    throw new Error('buildStoragePath: file with name is required')
  }
  const ext = getExtension(file.name) || 'bin'
  return `${userId}/${fundingSourceId}/${randomUuid()}.${ext}`
}

// -----------------------------------------------------------------------------
// defaultRetentionUntil — pure
// -----------------------------------------------------------------------------
//
// Returns the YYYY-MM-DD date 4 years after the supplied timestamp.
// Default is now(). Mirrors the SQL default in migration 008
// (`(current_date + interval '4 years')::date`) so the client and DB
// agree on the value when the client supplies it explicitly.
//
// Leap-day edge case: Feb 29 + 4 years lands on Feb 29 in most cases
// (leap years repeat every 4) but breaks on century-non-leap years
// like 2100. When the target year cannot represent the day, we back
// off to the last valid day of the original month (Feb 28).
export function defaultRetentionUntil(uploadedAt = new Date()) {
  const src = new Date(uploadedAt)
  const targetMonth = src.getMonth()
  const candidate = new Date(
    src.getFullYear() + 4,
    targetMonth,
    src.getDate()
  )
  if (candidate.getMonth() !== targetMonth) {
    // Date overflowed into the next month (e.g. Feb 29 -> Mar 1 in
    // a non-leap target year). Back off to the last day of the
    // original month.
    candidate.setDate(0)
  }
  return ymd(candidate)
}

// -----------------------------------------------------------------------------
// getSignedFundingDocUrl — async (touches Supabase)
// -----------------------------------------------------------------------------
//
// Returns a signed URL for an object in the funding-documents bucket.
// Returns null on error (caller surfaces a friendly error message).
//
// Lazy-imports the supabase client so this module can be exercised by
// Vitest without VITE_SUPABASE_* env vars being defined. The dynamic
// import is cached after the first call by the module loader, so the
// runtime cost is one extra await on cold start only.
export async function getSignedFundingDocUrl(
  storagePath,
  ttlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS
) {
  if (!storagePath) return null
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .storage
    .from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds)
  if (error) {
    console.error('getSignedFundingDocUrl: createSignedUrl failed', error)
    return null
  }
  return data?.signedUrl || null
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function getExtension(filename) {
  if (!filename) return ''
  const i = filename.lastIndexOf('.')
  if (i < 0 || i === filename.length - 1) return ''
  return filename.slice(i + 1).toLowerCase()
}

function ymd(d) {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC4122 v4 fallback for environments without crypto.randomUUID.
  // Math.random is fine here — uniqueness inside a per-user/per-source
  // path scope is the only requirement, not cryptographic randomness.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
