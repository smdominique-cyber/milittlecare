// Shared, bucket-agnostic storage helpers.
//
// 2026-06-02 extraction (PR consent-attachments Part 1, decision 10
// in docs/pr-consent-attachments-scope.md): the domain-agnostic
// parts of `src/lib/fundingDocuments.js` were lifted here so the
// new consent-attachments substrate can reuse the same file
// validation + retention math + signed-URL helper without
// duplicating logic. `fundingDocuments.js` now re-exports from
// here; the existing funding-docs tests pass unchanged, which is
// the behavior-preservation contract.
//
// Anything bucket-specific (the bucket name, the second-segment
// scope id name like `funding_source_id` vs `target_id`, any
// per-domain retention math) stays in the per-domain file.
// Everything truly generic — the allowlist, the file-size cap,
// the path-shape function — lives here.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const MAX_FILE_SIZE_MB = 10
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

// 15 minutes. Long enough to open the document, short enough that a
// shared link from a leaked screen recording goes stale quickly.
// Matches the funding-documents convention; the consent-attachment
// Edge Function uses this value too so all signed URLs in the
// codebase share a single TTL story.
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
// validateFile — pure (bucket-agnostic)
// -----------------------------------------------------------------------------
//
// Returns { ok: true } or { ok: false, reason: string }. Reason is
// intended for direct surfacing to the user.
//
// MIME-or-extension acceptance: iOS Safari sometimes reports HEIC
// photos with an empty MIME or 'application/octet-stream'. We accept
// the file if EITHER its declared MIME OR its extension is on the
// allowlist, so a genuine HEIC isn't rejected for browser quirks.
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
// buildScopedStoragePath — pure (bucket-agnostic)
// -----------------------------------------------------------------------------
//
// Returns the storage object key for an upload, in the format
// `<userId>/<scopeId>/<uuid>.<ext>`. The first segment is what every
// bucket's storage RLS policy keys off; the second segment makes
// per-scope listing trivial (per-funding-source, per-consent-target,
// etc.); the UUID prevents same-filename collisions on re-upload.
//
// Per-domain wrappers (e.g. fundingDocuments.buildStoragePath,
// consentAttachments.buildStoragePath) call this with their domain's
// scope-id name so callers read clearly.
export function buildScopedStoragePath({ userId, scopeId, file }) {
  if (!userId) {
    throw new Error('buildScopedStoragePath: userId is required')
  }
  if (!scopeId) {
    throw new Error('buildScopedStoragePath: scopeId is required')
  }
  if (!file || !file.name) {
    throw new Error('buildScopedStoragePath: file with name is required')
  }
  const ext = getExtension(file.name) || 'bin'
  return `${userId}/${scopeId}/${randomUuid()}.${ext}`
}

// -----------------------------------------------------------------------------
// defaultRetentionUntil — pure
// -----------------------------------------------------------------------------
//
// Returns the YYYY-MM-DD date 4 years after the supplied timestamp.
// Default is now(). Mirrors the SQL default in migration 008
// (`(current_date + interval '4 years')::date`) so the client and DB
// agree on the value when the client supplies it explicitly. The
// consent-attachments table inherits the same default in migration
// 029 — same retention math both ways.
//
// Leap-day edge case: Feb 29 + 4 years lands on Feb 29 in most
// cases (leap years repeat every 4) but breaks on century-non-leap
// years like 2100. When the target year cannot represent the day,
// we back off to the last valid day of the original month (Feb 28).
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
// getSignedUrl — async (touches Supabase)
// -----------------------------------------------------------------------------
//
// Returns a signed URL for an object in the named bucket. Returns
// null on error (caller surfaces a friendly error message).
//
// Lazy-imports the supabase client so this module can be exercised
// by Vitest without VITE_SUPABASE_* env vars being defined. The
// dynamic import is cached after the first call by the module
// loader, so the runtime cost is one extra await on cold start
// only.
//
// This is the PROVIDER-SIDE (owner-only) signed-URL fetcher — it
// runs against the client's RLS context. Parent-side signed URLs
// for consent attachments come from the Edge Function (see
// `api/consent-attachment-url.js`), not from this helper.
export async function getSignedUrl({ bucket, storagePath, ttlSeconds } = {}) {
  if (!bucket || !storagePath) return null
  const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : DEFAULT_SIGNED_URL_TTL_SECONDS
  const { supabase } = await import('./supabase')
  const { data, error } = await supabase
    .storage
    .from(bucket)
    .createSignedUrl(storagePath, ttl)
  if (error) {
    console.error('getSignedUrl: createSignedUrl failed', { bucket, error })
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
  // Math.random is fine here — uniqueness inside a per-user/per-scope
  // path scope is the only requirement, not cryptographic randomness.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
