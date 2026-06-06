// Compliance Engine Phase 3 — per-family Compliance tab in Families
// modal. Renders one card per child + a per-category breakdown using
// the engine.
//
// Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md §5.2.
// Module gating happens at the consumer (FamiliesPage) — this tab
// renders only when licenseeProfile.license_type IN (family_home,
// group_home). LEPs never see it.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { computeProviderComplianceStateWithOverrides } from '@/lib/complianceStateLoader'
import { findChildDisplayName } from '@/lib/children'
import ChecklistCategoryCard from './ChecklistCategoryCard'

// Categories that make sense at the per-child surface. The engine
// reports child_files, consents, medication, and (per-child)
// attendance acks scoped to each child. Provider-level categories
// (drills, property, staff_files, miregistry, funding_docs,
// cdc_compliance) belong on the /compliance page.
const PER_CHILD_CATEGORIES = Object.freeze([
  'child_files',
  'consents',
  'medication',
  'attendance',
])

export default function FamilyComplianceTab({ children: familyChildren }) {
  const { user } = useAuth()
  const [providerState, setProviderState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const childIds = (familyChildren || []).map(c => c.id)

  useEffect(() => {
    if (!user || childIds.length === 0) {
      setLoading(false)
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await computeProviderComplianceStateWithOverrides({
          providerId: user.id,
          childIds,
        })
        if (cancelled) return
        // Phase 3 fix-forward: loader now returns { state, children }.
        // Tolerate the older { only state } shape for any test/mock.
        if (result && Object.prototype.hasOwnProperty.call(result, 'state')) {
          setProviderState(result.state)
        } else {
          setProviderState(result)
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to compute compliance state')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, childIds.join(',')])

  if (loading) {
    return <p style={{ padding: 'var(--space-3, 12px)', color: 'var(--clr-ink-mid)' }}>Loading compliance state…</p>
  }
  if (error) {
    return <p role="alert" style={{ padding: 'var(--space-3, 12px)', color: 'var(--clr-error, #b03a3a)' }}>{error}</p>
  }
  if (childIds.length === 0) {
    return (
      <p style={{ padding: 'var(--space-3, 12px)', color: 'var(--clr-ink-mid)' }}>
        Add a child to this family to see their compliance file.
      </p>
    )
  }
  if (!providerState) {
    return (
      <p style={{ padding: 'var(--space-3, 12px)', color: 'var(--clr-ink-mid)' }}>
        No data available.
      </p>
    )
  }

  return (
    <div style={{ padding: 'var(--space-3, 12px)' }}>
      <p style={{
        color: 'var(--clr-ink-mid)',
        fontSize: '0.875rem',
        marginBottom: 'var(--space-3, 12px)',
        lineHeight: 1.5,
      }}>
        Read-only per-child compliance file. Capture flows live in
        the Children tab.{' '}
        <Link
          to="/compliance"
          style={{ color: 'var(--clr-sage-dark, #3e5849)' }}
        >
          Open provider-wide checklist →
        </Link>
      </p>

      {(providerState.per_child || []).map(pc => {
        if (!pc) return null
        const name = findChildDisplayName(familyChildren, pc.child_id)
        return (
          <section
            key={pc.child_id}
            style={{
              marginBottom: 'var(--space-5, 24px)',
              padding: 'var(--space-3, 12px)',
              background: 'var(--clr-cream, #faf5e8)',
              border: '1px solid var(--clr-warm-mid, #ddc8a4)',
              borderRadius: 'var(--radius-lg, 12px)',
            }}
          >
            <header style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: 'var(--space-2, 8px)',
              marginBottom: 'var(--space-3, 12px)',
            }}>
              <h3 style={{
                margin: 0,
                fontFamily: 'var(--font-display)',
                fontWeight: 500,
                fontSize: '1.125rem',
              }}>
                {name || `Child ${pc.child_id.slice(0, 8)}…`}
              </h3>
              <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)' }}>
                {pc.totals.applicable || 0} applicable ·{' '}
                {pc.totals.on_file || 0} on file ·{' '}
                {pc.totals.missing_required || 0} missing ·{' '}
                {pc.totals.unknown || 0} awaiting input
              </div>
            </header>

            {PER_CHILD_CATEGORIES.map(cat => (
              <ChecklistCategoryCard
                key={cat}
                categoryKey={cat}
                category={pc.per_category?.[cat]}
                businessInfoApplicabilityHref="/business-info"
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}
