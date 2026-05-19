// The licensee roster compliance matrix (docs/staff_training_tracking_spec.md
// § 3.2): one row per caregiver, one column per training category, each
// cell a derived status. Pure presentation — all derivation is done by
// getStaffComplianceMatrix in src/lib/staffTraining.js.

import { Info } from 'lucide-react'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { CATEGORY_META, CELL_STATUS, REGULATORY_ROLE_META } from '@/lib/staffTraining'

const STATUS_LABEL = {
  [CELL_STATUS.OK]: '✓ On record',
  [CELL_STATUS.EXPIRING_SOON]: '⚠ Expiring',
  [CELL_STATUS.EXPIRED]: '✗ Expired',
  [CELL_STATUS.OVERDUE]: '✗ Overdue',
  [CELL_STATUS.PENDING]: 'In window',
  [CELL_STATUS.MISSING]: '— Not on record',
  [CELL_STATUS.NOT_REQUIRED]: 'n/a',
}

export function StatusPill({ status, detail }) {
  return (
    <>
      <span className={`st-pill st-pill-${status}`}>{STATUS_LABEL[status] || status}</span>
      {detail && <span className="st-pill-detail">{detail}</span>}
    </>
  )
}

export default function StaffComplianceMatrix({ matrix, onSelectCaregiver }) {
  const { categories, rows } = matrix

  return (
    <div className="st-card">
      <h3 className="st-section-title">Roster compliance</h3>
      <div className="st-matrix-wrap">
        <table className="st-matrix">
          <thead>
            <tr>
              <th scope="col">Caregiver</th>
              {categories.map(c => (
                <th key={c} scope="col">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {CATEGORY_META[c].short}
                    <HelpTooltip text={CATEGORY_META[c].help} label={`What is ${CATEGORY_META[c].label}?`}>
                      <Info size={11} style={{ color: 'var(--clr-ink-soft)' }} />
                    </HelpTooltip>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.caregiver.id}>
                <th scope="row">
                  <button
                    type="button"
                    className="st-caregiver-link"
                    onClick={() => onSelectCaregiver?.(row.caregiver)}
                  >
                    {row.caregiver.full_name}
                  </button>
                  <span className="st-caregiver-sub">
                    {row.roles.length > 0
                      ? row.roles.map(r => REGULATORY_ROLE_META[r]?.label || r).join(', ')
                      : 'No regulatory role assigned'}
                  </span>
                </th>
                {categories.map(c => {
                  const cell = row.cells[c]
                  return (
                    <td key={c}>
                      <StatusPill
                        status={cell ? cell.status : CELL_STATUS.NOT_REQUIRED}
                        detail={cell ? cell.detail : ''}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="st-legend">
        <span><span className="st-pill st-pill-ok">✓</span> on record</span>
        <span><span className="st-pill st-pill-expiring_soon">⚠</span> expiring ≤ 60 days</span>
        <span><span className="st-pill st-pill-overdue">✗</span> expired / overdue</span>
        <span><span className="st-pill st-pill-missing">—</span> not on record</span>
        <span><span className="st-pill st-pill-not_required">n/a</span> not required for this role</span>
      </div>

      <p className="st-info-banner" style={{ marginTop: 'var(--space-3)' }}>
        <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Requirement rules are verified against MiLEAP rules
          R&nbsp;400.1901–1963. A cell marked <strong>n/a</strong> is a role
          the adopted rules do not address. Expiration dates you enter are
          exact; click a caregiver to open their full training log.
        </span>
      </p>
    </div>
  )
}
