// Compliance Engine Phase 3 — per-category card.
//
// Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md §5.
//
// One card per category (child_files, consents, medication,
// staff_files, miregistry, funding_docs, cdc_compliance,
// attendance, drills, property). Renders the category's summary
// counts in the header + the per-requirement rows beneath. Honors
// §5.5 by hiding `not_applicable` rows behind a "Show rows that
// don't apply" disclosure (default collapsed).

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  REQUIREMENT_STATE_KIND,
  REQUIREMENT_REGISTRY,
} from '@/lib/complianceState'
import ChecklistRow from './ChecklistRow'

const CATEGORY_LABEL = Object.freeze({
  child_files:     'Child files (R 400.1907)',
  consents:        'Consents',
  medication:      'Medication (R 400.1931)',
  staff_files:     'Staff files (R 400.1919–1924)',
  miregistry:      'MiRegistry (mirrored)',
  funding_docs:    'Funding documents',
  cdc_compliance:  'CDC compliance',
  attendance:      'Attendance acknowledgments',
  drills:          'Drills + emergency response',
  property:        'Property records',
})

function summaryLine(category) {
  if (!category) return ''
  const parts = []
  if (category.on_file_count)          parts.push(`${category.on_file_count} on file`)
  if (category.expired_count)          parts.push(`${category.expired_count} expired`)
  if (category.missing_required_count) parts.push(`${category.missing_required_count} missing`)
  if (category.pending_parent_count)   parts.push(`${category.pending_parent_count} pending parent`)
  if (category.unknown_count)          parts.push(`${category.unknown_count} unknown`)
  if (!parts.length && category.not_applicable_count) parts.push('all not applicable')
  return parts.join(' · ')
}

/**
 * @param {object} props
 * @param {string} props.categoryKey
 * @param {object} props.category    A CategoryState from the engine
 *                                   (per_category[categoryKey]).
 * @param {string} [props.businessInfoApplicabilityHref]
 */
export default function ChecklistCategoryCard({
  categoryKey,
  category,
  businessInfoApplicabilityHref,
}) {
  const [showNotApplicable, setShowNotApplicable] = useState(false)

  if (!category) return null
  const label = CATEGORY_LABEL[categoryKey] || categoryKey
  const rows = category.requirements || []
  const visible = rows.filter(r => r.state?.kind !== REQUIREMENT_STATE_KIND.NOT_APPLICABLE)
  const notApplicable = rows.filter(r => r.state?.kind === REQUIREMENT_STATE_KIND.NOT_APPLICABLE)

  // Empty category — don't render at all (e.g., the medication category
  // for a child with no authorizations and no per-medication rows).
  if (rows.length === 0) return null

  return (
    <section
      style={{
        border: '1px solid var(--clr-border, #e0d7c4)',
        borderRadius: 'var(--radius-lg, 12px)',
        padding: 'var(--space-4, 16px)',
        marginBottom: 'var(--space-4, 16px)',
        background: 'white',
      }}
    >
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 'var(--space-3, 12px)',
        flexWrap: 'wrap',
        gap: 'var(--space-2, 8px)',
      }}>
        <h3 style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: '1.0625rem',
          color: 'var(--clr-ink)',
        }}>
          {label}
        </h3>
        <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.875rem' }}>
          {summaryLine(category)}
        </div>
      </header>

      <ul style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2, 8px)',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      }}>
        {visible.map((row, idx) => (
          <ChecklistRow
            key={row.state?.requirement_key || idx}
            row={row}
            businessInfoApplicabilityHref={businessInfoApplicabilityHref}
          />
        ))}
      </ul>

      {notApplicable.length > 0 && (
        <div style={{ marginTop: 'var(--space-3, 12px)' }}>
          <button
            type="button"
            onClick={() => setShowNotApplicable(v => !v)}
            style={{
              background: 'transparent',
              border: 0,
              padding: 0,
              cursor: 'pointer',
              color: 'var(--clr-ink-mid)',
              fontSize: '0.8125rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
            aria-expanded={showNotApplicable}
          >
            {showNotApplicable ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {showNotApplicable
              ? `Hide ${notApplicable.length} row${notApplicable.length === 1 ? '' : 's'} that don’t apply`
              : `Show ${notApplicable.length} row${notApplicable.length === 1 ? '' : 's'} that don’t apply`}
          </button>
          {showNotApplicable && (
            <ul style={{
              marginTop: 'var(--space-2, 8px)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2, 8px)',
              padding: 0,
              listStyle: 'none',
            }}>
              {notApplicable.map((row, idx) => (
                <ChecklistRow
                  key={row.state?.requirement_key || idx}
                  row={{ ...row, state: { ...row.state } }}
                  businessInfoApplicabilityHref={businessInfoApplicabilityHref}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

// Suppress the warning about unused REQUIREMENT_REGISTRY — referenced
// only via ChecklistRow.
void REQUIREMENT_REGISTRY
