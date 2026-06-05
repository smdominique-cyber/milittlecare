// Compliance Engine Phase 3 — provider-wide checklist surface.
//
// Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md §5.1.
//
// Route /compliance. Sidebar entry under Compliance section. Module-
// gated to licensed homes only (`license_type IN ('family_home',
// 'group_home')`) via the existing MODULE_KEYS.LICENSED_COMPLIANCE
// gate in src/lib/modules.js + Sidebar.jsx. LEPs see no entry.
//
// Renders:
//   - Provider-level categories (drills, property, staff_files,
//     miregistry, funding_docs, cdc_compliance) as
//     ChecklistCategoryCard.
//   - A per-child rollup summary list. Each child row links into
//     the per-child Compliance tab in Families.
//
// Read-only per decision #6 — no deep-link to capture, no score
// (Phase 4).

import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useActiveModules } from '@/hooks/useActiveModules'
import { MODULE_KEYS } from '@/lib/modules'
import { computeProviderComplianceStateWithOverrides } from '@/lib/complianceStateLoader'
import { CATEGORIES } from '@/lib/complianceState'
import ChecklistCategoryCard from '@/components/compliance/ChecklistCategoryCard'

// Render order — provider-level categories first (the ones surfaced
// on this page), per-child rollup at the bottom.
const PROVIDER_LEVEL_CATEGORIES = Object.freeze([
  'staff_files',
  'miregistry',
  'drills',
  'property',
  'funding_docs',
  'cdc_compliance',
  'attendance',
])

// child_files, consents, and medication are per-child — they DO
// appear in provider_level.per_category from the engine (with empty
// rows for provider-only requirements), but the meaningful rollup
// lives on the per-child surface. Hide them from the provider-wide
// view to avoid confusion.
const PROVIDER_LEVEL_HIDE = Object.freeze(['child_files', 'consents', 'medication'])

export default function ComplianceChecklistPage() {
  const { user } = useAuth()
  const { modules, profile } = useActiveModules()
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Module gate — licensed homes only. Sidebar already filters this;
  // belt-and-suspenders against a direct URL hit.
  const isLicensedGated = !modules?.has(MODULE_KEYS.LICENSED_COMPLIANCE)
  // Phase 3 decision #8 — opt-in flag. Sidebar already hides the entry
  // when off; this redirect catches direct URL navigation.
  const isOptedIn = profile?.program_settings?.compliance_checklist_enabled === true

  useEffect(() => {
    if (!user || isLicensedGated || !isOptedIn) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await computeProviderComplianceStateWithOverrides({
          providerId: user.id,
        })
        if (cancelled) return
        setState(result)
      } catch (err) {
        if (cancelled) return
        setError(err?.message || 'Failed to compute compliance state')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [user, isLicensedGated, isOptedIn])

  if (isLicensedGated) {
    return <Navigate to="/dashboard" replace />
  }
  if (!isOptedIn) {
    // Licensed home but hasn't opted in — send to Business Info where
    // the toggle lives. Avoids a "broken page" for someone who
    // bookmarked /compliance before opting in.
    return <Navigate to="/business-info?section=compliance_applicability" replace />
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.5rem',
          fontWeight: 500,
        }}>Compliance Checklist</h1>
        <p style={{ color: 'var(--clr-ink-mid)' }}>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--space-4)' }} role="alert">
        <h1>Compliance Checklist</h1>
        <p style={{ color: 'var(--clr-error, #b03a3a)' }}>{error}</p>
      </div>
    )
  }

  if (!state) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <h1>Compliance Checklist</h1>
        <p>No data available.</p>
      </div>
    )
  }

  const providerLevel = state.provider_level?.per_category || {}
  const perChild = state.per_child || []

  return (
    <div style={{ padding: 'var(--space-4) 0', maxWidth: 960, margin: '0 auto' }}>
      <header style={{ marginBottom: 'var(--space-4)' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 500,
          fontSize: '1.625rem',
          letterSpacing: '-0.02em',
          margin: 0,
        }}>
          Compliance Checklist
        </h1>
        <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', marginTop: 4 }}>
          Read-only view of what&rsquo;s on file, what&rsquo;s missing, and what
          still needs your input.{' '}
          <Link
            to="/business-info?section=compliance_applicability"
            style={{ color: 'var(--clr-sage-dark, #3e5849)' }}
          >
            Answer applicability questions →
          </Link>
        </p>
      </header>

      <Totals state={state} />

      <button
        type="button"
        onClick={() => window.print()}
        style={{
          marginBottom: 'var(--space-4)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          background: 'white',
          border: '1px solid var(--clr-border, #e0d7c4)',
          borderRadius: 'var(--radius-md, 8px)',
          cursor: 'pointer',
          color: 'var(--clr-ink)',
          fontSize: '0.875rem',
        }}
        title="Use your browser's print to produce an inspection-prep PDF."
      >
        <Printer size={14} /> Print for inspection prep
      </button>

      <section style={{ marginBottom: 'var(--space-6, 32px)' }}>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.125rem',
          fontWeight: 500,
          margin: '0 0 var(--space-3, 12px)',
        }}>
          Provider-level
        </h2>
        {PROVIDER_LEVEL_CATEGORIES.map(cat => (
          <ChecklistCategoryCard
            key={cat}
            categoryKey={cat}
            category={providerLevel[cat]}
            businessInfoApplicabilityHref="/business-info"
          />
        ))}
      </section>

      <section>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.125rem',
          fontWeight: 500,
          margin: '0 0 var(--space-3, 12px)',
        }}>
          Per-child rollup
        </h2>
        {perChild.length === 0 && (
          <p style={{ color: 'var(--clr-ink-mid)' }}>
            No active children. Add children in the Families page to see
            per-child compliance.
          </p>
        )}
        {perChild.map(pc => (
          <PerChildSummary key={pc.child_id} per_child={pc} />
        ))}
      </section>

      <p style={{
        marginTop: 'var(--space-6, 32px)',
        fontSize: '0.8125rem',
        color: 'var(--clr-ink-soft, #7a705a)',
        borderTop: '1px solid var(--clr-border, #e0d7c4)',
        paddingTop: 'var(--space-3, 12px)',
        lineHeight: 1.5,
      }}>
        Rows tagged <strong>MiR</strong> mirror data from your MiRegistry
        transcript. An auditor verifies these in MiRegistry directly
        (R 400.1922) — we surface them here for your visibility.
      </p>
    </div>
  )
  // Silence unused-import warning in code-only style; CATEGORIES is
  // referenced symbolically in ChecklistCategoryCard's lookup.
  void CATEGORIES   // eslint-disable-line no-unused-expressions
  void profile      // eslint-disable-line no-unused-expressions
}

function Totals({ state }) {
  const t = state.totals || {}
  const items = [
    { key: 'on_file',          label: 'On file',          n: t.on_file },
    { key: 'missing_required', label: 'Missing',          n: t.missing_required },
    { key: 'expired',          label: 'Expired',          n: t.expired },
    { key: 'pending_parent',   label: 'Pending parent',   n: t.pending_parent },
    { key: 'unknown',          label: 'Awaiting input',   n: t.unknown },
  ]
  return (
    <div
      role="region"
      aria-label="Compliance totals"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: 'var(--space-2, 8px)',
        background: 'var(--clr-cream, #faf5e8)',
        border: '1px solid var(--clr-warm-mid, #ddc8a4)',
        borderRadius: 'var(--radius-lg, 12px)',
        padding: 'var(--space-3, 12px)',
        marginBottom: 'var(--space-4, 16px)',
      }}
    >
      {items.map(item => (
        <div key={item.key} style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: '1.5rem',
            fontWeight: 600,
            color: 'var(--clr-ink)',
          }}>{item.n || 0}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--clr-ink-mid)' }}>{item.label}</div>
        </div>
      ))}
    </div>
  )
}

function PerChildSummary({ per_child }) {
  const t = per_child.totals || {}
  const childId = per_child.child_id
  const summary = []
  if (t.on_file)          summary.push(`${t.on_file} on file`)
  if (t.missing_required) summary.push(`${t.missing_required} missing`)
  if (t.expired)          summary.push(`${t.expired} expired`)
  if (t.pending_parent)   summary.push(`${t.pending_parent} pending parent`)
  if (t.unknown)          summary.push(`${t.unknown} awaiting input`)
  const detail = summary.length ? summary.join(' · ') : 'No applicable requirements'

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 'var(--space-3, 12px) var(--space-4, 16px)',
        background: 'white',
        border: '1px solid var(--clr-border, #e0d7c4)',
        borderRadius: 'var(--radius-md, 8px)',
        marginBottom: 'var(--space-2, 8px)',
      }}
    >
      <div>
        <div style={{ fontWeight: 500 }}>Child {childId.slice(0, 8)}…</div>
        <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.875rem' }}>{detail}</div>
      </div>
      <Link
        to={`/families?child=${childId}&tab=compliance`}
        style={{
          color: 'var(--clr-sage-dark, #3e5849)',
          fontSize: '0.875rem',
        }}
      >
        Open child&rsquo;s compliance tab →
      </Link>
    </div>
  )
}
