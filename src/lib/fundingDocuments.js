// Funding-document-specific helpers — thin wrappers over the
// bucket-agnostic helpers in `src/lib/storage.js`.
//
// 2026-06-02 (PR consent-attachments Part 1, decision 10 in
// docs/pr-consent-attachments-scope.md): the generic helpers
// previously defined here — `validateFile`, `defaultRetentionUntil`,
// the file-size constants, the allowlist, the path-shape function,
// the signed-URL fetcher — were extracted to `src/lib/storage.js`
// so the new consent-attachments substrate can reuse them. This
// file keeps the funding-domain-specific surface intact:
//
//   - `BUCKET = 'funding-documents'`
//   - `buildStoragePath({ userId, fundingSourceId, file })` — thin
//     wrapper around the shared `buildScopedStoragePath` with the
//     funding-domain name for the second segment.
//   - `getSignedFundingDocUrl(storagePath, ttlSeconds)` — thin
//     wrapper around the shared `getSignedUrl` with the funding
//     bucket baked in.
//   - Re-exports of the generic constants + `validateFile` +
//     `defaultRetentionUntil` so existing callers and the existing
//     test file (`fundingDocuments.test.js`) import the same names
//     from the same path — no caller-side change required, no
//     test-file change required (behavior-preservation contract).
//
// See `supabase/migrations/008_funding_documents.sql` for the data
// model.

import { buildScopedStoragePath, getSignedUrl } from './storage'

export {
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  REJECTION_REASONS,
  rejectionForOversize,
  validateFile,
  defaultRetentionUntil,
} from './storage'

export const BUCKET = 'funding-documents'

/**
 * Returns the storage object key for a funding-documents upload, in
 * the format `<userId>/<fundingSourceId>/<uuid>.<ext>`. Thin wrapper
 * around the shared `buildScopedStoragePath` — the funding-domain
 * naming for the second segment (`fundingSourceId`) is preserved at
 * this API surface so existing callers and tests don't change.
 */
export function buildStoragePath({ userId, fundingSourceId, file }) {
  // Validate the funding-specific param name BEFORE delegating, so
  // the thrown error mentions `fundingSourceId` (what callers know)
  // rather than the shared helper's generic `scopeId`.
  if (!userId) {
    throw new Error('buildStoragePath: userId is required')
  }
  if (!fundingSourceId) {
    throw new Error('buildStoragePath: fundingSourceId is required')
  }
  if (!file || !file.name) {
    throw new Error('buildStoragePath: file with name is required')
  }
  return buildScopedStoragePath({ userId, scopeId: fundingSourceId, file })
}

/**
 * Returns a signed URL for an object in the funding-documents
 * bucket. Returns null on error. Thin wrapper around the shared
 * `getSignedUrl` with the funding bucket baked in.
 */
export async function getSignedFundingDocUrl(storagePath, ttlSeconds) {
  return getSignedUrl({ bucket: BUCKET, storagePath, ttlSeconds })
}
