// The licensee's "needs attention" list (docs/staff_training_tracking_spec.md
// § 3.2): every non-compliant cell flattened out of the compliance
// matrix — expired / overdue items, certifications expiring soon, and
// training not yet on record. Pure presentation.

import { AlertTriangle, CheckCircle } from 'lucide-react'
import { CATEGORY_META, CELL_STATUS } from '@/lib/staffTraining'

const VERB = {
  [CELL_STATUS.EXPIRED]: 'expired',
  [CELL_STATUS.OVERDUE]: 'overdue',
  [CELL_STATUS.EXPIRING_SOON]: 'expiring soon',
  [CELL_STATUS.MISSING]: 'not on record',
}

export default function ExpiringSoonList({ attentionItems }) {
  const items = attentionItems || []

  if (items.length === 0) {
    return (
      <div className="st-card">
        <div className="st-attention-ok">
          <CheckCircle size={16} style={{ color: 'var(--clr-success, #4a6957)' }} />
          Every caregiver is up to date — nothing needs attention right now.
        </div>
      </div>
    )
  }

  return (
    <div className="st-card st-attention">
      <div className="st-attention-head">
        <AlertTriangle size={16} />
        {items.length} {items.length === 1 ? 'item needs' : 'items need'} attention
      </div>
      <ul className="st-attention-list">
        {items.map((item, i) => (
          <li key={`${item.caregiverId}-${item.category}-${i}`}>
            <strong>{item.caregiverName}</strong> — {CATEGORY_META[item.category]?.label || item.category}
            {': '}
            {VERB[item.status] || item.status}
            {item.detail ? ` (${item.detail})` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
