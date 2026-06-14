// Compliance-document-specific helpers — thin wrappers over the
// bucket-agnostic helpers in `src/lib/storage.js`. Mirrors the
// `src/lib/fundingDocuments.js` shape: a per-domain bucket name +
// a per-domain `buildStoragePath` whose second-segment label reads
// clearly to callers, both delegating to the shared substrate.
//
// The data model lives in
// `supabase/migrations/038_compliance_documents.sql`.

import { buildScopedStoragePath, getSignedUrl } from './storage'

// Re-exports — keep the same import surface as the funding equivalent
// so callers don't pull from two places.
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

export const BUCKET = 'compliance-documents'

// Catalog of accepted document_type values. Lives in the JS layer
// MIRRORING the SQL CHECK constraint in migration 038. Keep these
// two in lockstep — a new type must be added to BOTH the migration
// and this list (and almost certainly carries a new entry in
// COMPLIANCE_DOCUMENT_TYPE_CONFIG below + a new consumer slot in
// the relevant page).
//
// A regression test asserts the catalog is the same length as the
// config map and that every key is recognized by both.
export const COMPLIANCE_DOCUMENT_TYPES = Object.freeze([
  'fingerprint_reprint',           // G4   — Phase A (mig 038)
  'property_radon_test',           // J1   — Phase A batch (mig 039)
  'property_heating_inspection',   // J2   — Phase A batch (mig 039)
  'property_licensing_notebook',   // J8   — Phase A batch (mig 039)
])

/**
 * Returns the storage object key for a compliance-documents upload,
 * in the format `<userId>/<documentType>/<uuid>.<ext>`. Thin wrapper
 * around the shared `buildScopedStoragePath` — the compliance domain
 * naming for the second segment (`documentType`) is preserved at this
 * API surface so callers read clearly.
 *
 * Unlike funding_documents, this table is provider-level — there is
 * no parent funding_source_id to scope into the path. The second
 * segment is the document_type itself, which makes per-type bulk
 * listing (`<userId>/fingerprint_reprint/`) the natural shape.
 */
export function buildStoragePath({ userId, documentType, file }) {
  if (!userId) {
    throw new Error('buildStoragePath: userId is required')
  }
  if (!documentType) {
    throw new Error('buildStoragePath: documentType is required')
  }
  if (!file || !file.name) {
    throw new Error('buildStoragePath: file with name is required')
  }
  return buildScopedStoragePath({ userId, scopeId: documentType, file })
}

/**
 * Returns a signed URL for an object in the compliance-documents
 * bucket. Returns null on error. Thin wrapper around the shared
 * `getSignedUrl` with the compliance bucket baked in.
 */
export async function getSignedComplianceDocUrl(storagePath, ttlSeconds) {
  return getSignedUrl({ bucket: BUCKET, storagePath, ttlSeconds })
}

// Per-type UI config. Each entry mirrors the shape FundingDocumentSlot
// already uses (TYPE_CONFIG at the top of that file) so the generic
// DocumentSlot can read either domain without branching.
//
//   title  — slot heading shown to the provider
//   badge  — { text, tone } or null. tone in ('required', 'neutral')
//   help   — long-form help tooltip body
//   multi  — true for "add another" slots (other-docs-style); false for
//            single-instance "Replace" slots (the fingerprint case).
//
// When PR #21 / PR #18 add their consumer slots, they extend this map
// and COMPLIANCE_DOCUMENT_TYPES + the SQL CHECK in one follow-up
// migration. No DocumentSlot.jsx change needed for new types.
export const COMPLIANCE_DOCUMENT_TYPE_CONFIG = Object.freeze({
  fingerprint_reprint: {
    title: 'Fingerprint reprint record',
    badge: { text: 'Recommended', tone: 'neutral' },
    help:
      'Upload your most recent fingerprint reprint receipt or notice. ' +
      'The licensing rule is a 5-year cycle — keeping the latest one ' +
      'on file means you can hand it to an auditor without rummaging ' +
      'through paper. This slot covers YOU (the licensee). Staff and ' +
      'household-member fingerprint records still live on paper for ' +
      'now (no per-person model in MILittleCare yet).',
    multi: false,
  },
  property_radon_test: {
    title: 'Radon test',
    badge: { text: 'Required', tone: 'required' },
    help:
      'Upload your most recent radon test report from a certified ' +
      'tester. Rules R 400.1932 / R 400.1934 require a test on a ' +
      '4-year cycle — replace this with the latest report after each ' +
      'retest. If you have older reports for the same home, the ' +
      '"Replace" flow keeps the prior one in archive for the ' +
      'retention window.',
    multi: false,
  },
  property_heating_inspection: {
    title: 'Heating equipment inspection',
    badge: { text: 'Required', tone: 'required' },
    help:
      'Upload your most recent heating/HVAC inspection report from a ' +
      'qualified contractor. R 400.1932 requires inspection on a ' +
      '4-year cycle. Replace after each inspection; prior reports ' +
      'stay in archive for the retention window.',
    multi: false,
  },
  property_licensing_notebook: {
    title: 'Licensing notebook archive',
    badge: { text: 'Required', tone: 'required' },
    help:
      'Upload a single PDF (or photo) of your current licensing ' +
      'notebook — your licensing certificate, recent licensing ' +
      'correspondence, and any inspection reports parents may ask ' +
      'to see per R 400.1906(3). Replace whenever your notebook ' +
      'changes; the prior copy stays in archive for the retention ' +
      'window.',
    multi: false,
  },
})
