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
  'fingerprint_reprint',                    // G4   — Phase A (mig 038)
  'property_radon_test',                    // J1   — Phase A batch (mig 039)
  'property_heating_inspection',            // J2   — Phase A batch (mig 039)
  'property_licensing_notebook',            // J8   — Phase A batch (mig 039)
  // 2026-06-17 PR #21 inventory batch (mig 043). The original mig 039
  // header classified these as "OUT — evidence type does NOT fit the
  // doc store" (inventory / per-floor counts / boolean attestations).
  // Reversed per user-level product call: a photo of the installed
  // device, the posted sign, or a copy of the parent notification IS
  // a sufficient on-file artifact for an auditor walking the home.
  'property_co_detectors_per_level',        // J3   — mig 043
  'property_smoke_detectors_per_floor',     // J4   — mig 043
  'property_fire_extinguishers_per_floor',  // J5   — mig 043
  'property_animal_notification',           // J6   — mig 043
  'property_smoking_prohibition_posted',    // J7   — mig 043
  // 2026-06-17 PR #19 drills + Emergency Response Plan (mig 044).
  // The plan is a written document the provider uploads; the row
  // resolves via the same buildComplianceDocResolver as the property
  // docs. The three sibling drill rows in PR #19 resolve from the
  // new drill_logs table (different substrate), not from this list.
  'emergency_response_plan',                // PR #19 — mig 044
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
      'tester. R 400.1915(4) requires a test on a 4-year cycle — ' +
      'replace this with the latest report after each retest. If you ' +
      'have older reports for the same home, the "Replace" flow keeps ' +
      'the prior one in archive for the retention window.',
    multi: false,
    // 2026-06-14 mig 040: the resolver compares this date against
    // today. The slot captures it as a required input alongside the
    // file; uploads without it are blocked client-side and the
    // engine flags them server-side ('due-date-missing') if the row
    // ever gets in without one.
    requiresDueDate: true,
    dueDateLabel: 'Next radon test due',
    dueDateHelp:
      'Enter the date this radon test cycle is next due. Your tester ' +
      'should have given you a recommended retest date; otherwise ' +
      'use the report date + 4 years (R 400.1915(4)).',
  },
  property_heating_inspection: {
    title: 'Heating equipment inspection',
    badge: { text: 'Required', tone: 'required' },
    help:
      'Upload your most recent heating/HVAC inspection report from a ' +
      'qualified contractor. R 400.1945(4)–(5) requires inspection on ' +
      'a 4-year cycle (renewed at each license renewal). Replace after ' +
      'each inspection; prior reports stay in archive for the ' +
      'retention window.',
    multi: false,
    // 2026-06-14 mig 040: see radon for the same boundary contract.
    requiresDueDate: true,
    dueDateLabel: 'Next heating inspection due',
    dueDateHelp:
      'Enter the date the next heating/HVAC inspection is due. Your ' +
      'contractor usually notes this on the report; otherwise use the ' +
      'inspection date + 4 years (R 400.1945(4)–(5)).',
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

  // ── PR #21 inventory batch (mig 043) ────────────────────────────────
  //
  // Each row's slot accepts a photo OR a written attestation as the
  // on-file artifact. The auditor's question for each is "show me one"
  // — a single phone photo of the device, sign, or notification
  // satisfies that question for everything except recurring-cycle
  // inspections. None of these are cycle-tracked (no requiresDueDate).

  property_co_detectors_per_level: {
    title: 'Carbon-monoxide detectors per level',
    badge: { text: 'Required', tone: 'required' },
    help:
      'A photo (or short attestation PDF) showing CO detectors are ' +
      'installed and operational on every level of the home — R ' +
      '400.1915(3) (the heating/ventilation rule, where CO lives — ' +
      'NOT R 400.1948, which is the smoke-detector + fire-extinguisher ' +
      'rule). The rule requires an operational CO detector bearing a ' +
      'recognized-laboratory safety mark on all levels approved for ' +
      'child care. One image per level is fine; the slot keeps the ' +
      'most recent upload and archives the prior. Re-photograph after ' +
      'a battery swap or replacement so the on-file image matches ' +
      'what is installed.',
    multi: false,
  },
  property_smoke_detectors_per_floor: {
    title: 'Smoke detectors per floor',
    badge: { text: 'Required', tone: 'required' },
    help:
      'A photo (or short attestation PDF) showing working smoke ' +
      'detectors on every floor — R 400.1948(1). One image per floor ' +
      'is fine; this slot keeps the latest. Re-upload after a battery ' +
      'change or new install so the on-file evidence matches what is ' +
      'currently in the home. (R 400.1948(3) is the per-floor fire-' +
      'extinguisher subrule; this row is the per-floor smoke-detector ' +
      'subrule, R 400.1948(1).)',
    multi: false,
  },
  property_fire_extinguishers_per_floor: {
    title: 'Fire extinguishers per floor (2A-10BC+)',
    badge: { text: 'Required', tone: 'required' },
    help:
      'A photo (or service-tag attestation PDF) showing at least one ' +
      'fire extinguisher rated 2A-10BC or higher on every floor — R ' +
      '400.1948(3). The image should show the rating label and the ' +
      'service tag with the most recent inspection date. Re-upload ' +
      'after the annual service tag is renewed. (R 400.1948(1) is ' +
      'the per-floor smoke-detector subrule on the sibling row.)',
    multi: false,
  },
  property_animal_notification: {
    title: 'Animal/pet notification to parents',
    badge: { text: 'Required', tone: 'required' },
    help:
      'A copy of the written notification you give parents listing the ' +
      'animals/pets on the premises — R 400.1917. One PDF (or photo of ' +
      'the form) is sufficient. Re-upload whenever the animals on the ' +
      'home change. This slot only matters once you have answered ' +
      '"yes" to the animals question on the What-applies questionnaire; ' +
      'if you have no animals, the row resolves as Does-not-apply.',
    multi: false,
  },
  property_smoking_prohibition_posted: {
    title: 'Smoking / vaping prohibition posted',
    badge: { text: 'Required', tone: 'required' },
    help:
      'A photo showing the smoking and vaping prohibition sign posted ' +
      'where parents and staff can see it — R 400.1918. The image ' +
      'should show the sign in its actual location (door, foyer, etc.) ' +
      'so an auditor can see both the wording and that it is posted. ' +
      'Re-photograph if you move the sign or replace it.',
    multi: false,
  },

  // ── PR #19 (mig 044) — Emergency Response Plan ──────────────────────
  //
  // The written plan covering staff roles, evacuation routes, parent
  // notification, reunification, and the other R 400.1939 elements.
  // This row uses the document substrate; the three sibling drill
  // rows resolve from drill_logs (different mechanism — see
  // src/lib/drillSchedule.js).

  emergency_response_plan: {
    title: 'Emergency Response Plan',
    badge: { text: 'Required', tone: 'required' },
    help:
      'Upload your written Emergency Response Plan (PDF or photo of ' +
      'the document). R 400.1939 — the plan covers fire / tornado / ' +
      'lockdown / shelter-in-place / reunification response, staff ' +
      'roles, evacuation routes, and parent notification. This slot ' +
      'is the PLAN itself; the per-drill execution log (fire drills, ' +
      'tornado drills, etc.) lives in the Drills section above. ' +
      'Re-upload whenever you revise the plan; the prior copy stays in ' +
      'archive for the retention window.',
    multi: false,
  },
})
