// Thin wrapper around the generic <DocumentSlot/>: locks the
// compliance-documents table + bucket + per-type helpers in place
// so callers in BusinessInfoPage (and the future PR #21 / #18
// consumers) only have to name the documentType.
//
// Data model: supabase/migrations/038_compliance_documents.sql.

import DocumentSlot from './DocumentSlot'
import {
  BUCKET,
  buildStoragePath,
  getSignedComplianceDocUrl,
  COMPLIANCE_DOCUMENT_TYPE_CONFIG,
} from '@/lib/complianceDocuments'

export const COMPLIANCE_DOCUMENTS_TABLE = 'compliance_documents'

export default function ComplianceDocumentSlot({ documentType, subjectCaregiverId = null, onChanged }) {
  const config = COMPLIANCE_DOCUMENT_TYPE_CONFIG[documentType]
  if (!config) {
    if (typeof console !== 'undefined') {
      console.warn(
        `ComplianceDocumentSlot: unknown documentType "${documentType}". ` +
        'Add it to COMPLIANCE_DOCUMENT_TYPE_CONFIG + the SQL CHECK in ' +
        'migration 038 (and any follow-up) before using.'
      )
    }
    return null
  }
  // 2026-06-17 PR #17/#18 foundation (mig 045) — per-caregiver
  // scoping. When the caller supplies subjectCaregiverId, the slot
  // reads/writes via the subject_caregiver_id projection: filter on
  // it during SELECT, INSERT it with the new row. Caller-side
  // parentScope mechanism is the same pattern FundingDocumentSlot
  // uses for funding_source_id; DocumentSlot already understands the
  // parentScope prop.
  const parentScope = subjectCaregiverId
    ? { columnName: 'subject_caregiver_id', value: subjectCaregiverId }
    : null
  return (
    <DocumentSlot
      table={COMPLIANCE_DOCUMENTS_TABLE}
      bucket={BUCKET}
      documentType={documentType}
      config={config}
      buildStoragePath={buildStoragePath}
      getSignedUrl={getSignedComplianceDocUrl}
      parentScope={parentScope}
      onChanged={onChanged}
    />
  )
}
