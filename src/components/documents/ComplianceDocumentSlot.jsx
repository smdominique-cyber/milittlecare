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

export default function ComplianceDocumentSlot({ documentType, onChanged }) {
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
  return (
    <DocumentSlot
      table={COMPLIANCE_DOCUMENTS_TABLE}
      bucket={BUCKET}
      documentType={documentType}
      config={config}
      buildStoragePath={buildStoragePath}
      getSignedUrl={getSignedComplianceDocUrl}
      onChanged={onChanged}
    />
  )
}
