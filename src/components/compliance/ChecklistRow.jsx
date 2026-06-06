// Compliance Engine Phase 3 — single requirement row renderer.
//
// Authoritative spec: docs/pr-compliance-engine-phase-3-scope.md §5.3 + §5.4.
//
// One row per requirement. Reads the engine's state + the registry's
// metadata (label, rule_citation, data_authority) to render the
// correct visual treatment per the six state kinds + the three
// `unknown` sub-buckets (awaiting_input / feature_not_yet_shipped /
// data_anomaly).
//
// Pure presentational — no Supabase, no fetches. The caller supplies
// the registry row, the engine state, and (optionally) a callback to
// navigate to the BusinessInfo applicability section when the row is
// 'awaiting_input'.

import { Link } from 'react-router-dom'
import {
  Check,
  AlertTriangle,
  XCircle,
  Clock,
  CircleDashed,
  Wrench,
  HelpCircle,
} from 'lucide-react'
import {
  REQUIREMENT_REGISTRY,
  REQUIREMENT_STATE_KIND,
  APPLICABILITY_RESULT,
  DATA_STATE,
  classifyUnknownReason,
} from '@/lib/complianceState'

// Per-reason copy for the `needs_provider_data` bucket. The
// classifier returns the bucket; the renderer picks the right
// message per reason code. Phase 3 live-gate finding (2026-06-05):
// these used to show "Data anomaly — please contact support" via
// the generic data_anomaly bucket, which is misleading — these are
// self-fixable by the provider.
//
// If a new reason code joins NEEDS_PROVIDER_DATA_REASONS in
// complianceState.js, add its copy here. A reason without explicit
// copy falls back to the generic "needs more information on the
// underlying record" message (still actionable, not "contact
// support").
const NEEDS_PROVIDER_DATA_COPY = Object.freeze({
  'caregiver-missing-date-of-hire':
    'Needs hire date on the staff record',
  'no-authorization-end-on-funding-source':
    'Needs authorization end date on the funding source',
})

// Pluggable "tracking ships with PR #N" copy per category. The
// not_yet_modelled rows in the registry today are: drills (PR #19),
// property (PR #21), three staff-file gaps (PR #18 mostly; the
// staff discipline ack is PR #17). The registry's `category` value
// drives the lookup; rows whose category isn't here get the
// generic "tracking ships in a future build" fallback.
const TRACKING_SHIPS_WITH = Object.freeze({
  drills:        'PR #19 (drills + emergency response plan)',
  property:      'PR #21 (property records)',
  staff_files:   'PR #18 (staff file gaps) and PR #17 (discipline policy receipt at hire)',
})

function trackingCopy(req) {
  return TRACKING_SHIPS_WITH[req.category] || 'a future MILittleCare build'
}

function formatYMD(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function describeMissing(req) {
  // Best-effort, registry-driven copy. Most child_files + consents
  // rows want a parent signature; most provider-level rows want a
  // provider attestation; staff rows want a caregiver record.
  if (req.subject_type === 'child' || req.subject_type === 'medication_authorization') {
    return 'parent signature'
  }
  if (req.subject_type === 'caregiver') return 'staff record'
  if (req.subject_type === 'funding_source') return 'a funding document'
  return 'a record on file'
}

/**
 * Single requirement-row card.
 *
 * @param {object} props
 * @param {object} props.row     A row from a CategoryState.requirements
 *                               array: { applicability, state } with
 *                               state.requirement_key populated by the
 *                               engine's tallyState.
 * @param {string} [props.businessInfoApplicabilityHref='/business-info']
 *                               Where to deep-link 'awaiting_input'
 *                               rows. Default points at the BusinessInfo
 *                               page; consumers can override.
 */
export default function ChecklistRow({
  row,
  businessInfoApplicabilityHref = '/business-info',
}) {
  if (!row || !row.state) return null
  const key = row.state.requirement_key
  const req = key ? REQUIREMENT_REGISTRY[key] : null
  if (!req) return null

  const state = row.state
  const label = req.label || key
  const isType1 = req.data_authority === 'miregistry'

  // Skip not_applicable rows when invisible-by-default. The parent
  // surface (per-category card) renders a "Show rows that don't apply"
  // disclosure so the provider can verify the engine isn't wrongly
  // classifying — but the default view hides them per §5.5.
  if (state.kind === REQUIREMENT_STATE_KIND.NOT_APPLICABLE) {
    return (
      <RowShell
        icon={<CircleDashed size={16} aria-hidden />}
        color="muted"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <span style={{ color: 'var(--clr-ink-mid)' }}>
            Doesn&rsquo;t apply
          </span>
        }
        secondary={state.reason === 'not-applicable-by-rule' ? null : state.reason}
        isType1={isType1}
      />
    )
  }

  if (state.kind === REQUIREMENT_STATE_KIND.ON_FILE) {
    const since = state.evidence_id ? null : null   // engine doesn't carry the captured-at on every row
    return (
      <RowShell
        icon={<Check size={16} aria-hidden style={{ color: 'var(--clr-sage-dark, #3e5849)' }} />}
        color="ok"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <>
            <span style={{ color: 'var(--clr-sage-dark, #3e5849)' }}>On file</span>
            {state.expires_at && (
              <span style={{ color: 'var(--clr-ink-mid)', marginLeft: 8, fontSize: '0.875rem' }}>
                · renews {formatYMD(state.expires_at)}
              </span>
            )}
            {state.expiring_soon && (
              <span style={{ color: 'var(--clr-warn, #c97d2e)', marginLeft: 8, fontSize: '0.875rem' }}>
                · expiring soon
              </span>
            )}
          </>
        }
        isType1={isType1}
      />
    )
  }

  if (state.kind === REQUIREMENT_STATE_KIND.EXPIRED) {
    return (
      <RowShell
        icon={<AlertTriangle size={16} aria-hidden style={{ color: 'var(--clr-warn, #c97d2e)' }} />}
        color="warn"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <span style={{ color: 'var(--clr-warn, #c97d2e)' }}>
            Expired {formatYMD(state.expired_at)} — renew now
          </span>
        }
        isType1={isType1}
      />
    )
  }

  if (state.kind === REQUIREMENT_STATE_KIND.MISSING_REQUIRED) {
    return (
      <RowShell
        icon={<XCircle size={16} aria-hidden style={{ color: 'var(--clr-error, #b03a3a)' }} />}
        color="bad"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <span style={{ color: 'var(--clr-error, #b03a3a)' }}>
            Missing — needs {describeMissing(req)}
          </span>
        }
        isType1={isType1}
      />
    )
  }

  if (state.kind === REQUIREMENT_STATE_KIND.PENDING_PARENT) {
    return (
      <RowShell
        icon={<Clock size={16} aria-hidden style={{ color: 'var(--clr-warn, #c97d2e)' }} />}
        color="warn"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <span style={{ color: 'var(--clr-warn, #c97d2e)' }}>
            Pending parent signature
          </span>
        }
        isType1={isType1}
      />
    )
  }

  // UNKNOWN — three sub-renderings per §5.4.
  if (state.kind === REQUIREMENT_STATE_KIND.UNKNOWN) {
    const bucket = classifyUnknownReason({ state })

    if (bucket === 'awaiting_input') {
      return (
        <RowShell
          icon={<HelpCircle size={16} aria-hidden style={{ color: 'var(--clr-warn, #c97d2e)' }} />}
          color="warn"
          label={label}
          ruleCitation={req.rule_citation}
          primary={
            <>
              <span style={{ color: 'var(--clr-warn, #c97d2e)' }}>Tell us about this</span>
              <Link
                to={`${businessInfoApplicabilityHref}?section=compliance_applicability`}
                style={{
                  marginLeft: 8,
                  fontSize: '0.875rem',
                  color: 'var(--clr-sage-dark, #3e5849)',
                }}
              >
                → answer in Business Info
              </Link>
            </>
          }
          isType1={isType1}
        />
      )
    }

    if (bucket === 'feature_not_yet_shipped') {
      // Option A from the scope doc §4 — the load-bearing UX.
      // Distinct from "missing" red. Informational gray. PR-name
      // copy from TRACKING_SHIPS_WITH (registry category → PR map).
      return (
        <RowShell
          icon={<Wrench size={16} aria-hidden style={{ color: 'var(--clr-ink-mid)' }} />}
          color="muted"
          label={label}
          ruleCitation={req.rule_citation}
          primary={
            <span style={{ color: 'var(--clr-ink-mid)' }}>
              Tracking ships with {trackingCopy(req)} — keep paper records for
              now. An auditor will ask to see them.
            </span>
          }
          isType1={isType1}
        />
      )
    }

    if (bucket === 'needs_provider_data') {
      // A record exists but is missing a field the provider can
      // supply. Same visual voice as MISSING_REQUIRED rows ("Missing
      // — needs staff record") — actionable, NOT "contact support."
      // Per-reason copy from NEEDS_PROVIDER_DATA_COPY; fallback is
      // generic but still actionable.
      const message = NEEDS_PROVIDER_DATA_COPY[state.reason]
        || 'Needs additional information on the underlying record'
      return (
        <RowShell
          icon={<XCircle size={16} aria-hidden style={{ color: 'var(--clr-error, #b03a3a)' }} />}
          color="bad"
          label={label}
          ruleCitation={req.rule_citation}
          primary={
            <span style={{ color: 'var(--clr-error, #b03a3a)' }}>
              {message}
            </span>
          }
          isType1={isType1}
        />
      )
    }

    // data_anomaly fallthrough — engine encountered something it
    // genuinely can't classify (unparseable date, completion date in
    // future, dev-bug "no-state-resolver", etc.). These ARE worth
    // contacting support over because they imply corrupt data or an
    // engine misuse — not provider-fixable from the UI.
    return (
      <RowShell
        icon={<HelpCircle size={16} aria-hidden style={{ color: 'var(--clr-ink-mid)' }} />}
        color="muted"
        label={label}
        ruleCitation={req.rule_citation}
        primary={
          <span style={{ color: 'var(--clr-ink-mid)' }}>
            Data anomaly — please contact support
          </span>
        }
        secondary={state.reason || null}
        isType1={isType1}
      />
    )
  }

  // Defensive: unknown state.kind value.
  return (
    <RowShell
      icon={<HelpCircle size={16} aria-hidden />}
      color="muted"
      label={label}
      ruleCitation={req.rule_citation}
      primary={<span>{String(state.kind)}</span>}
      isType1={isType1}
    />
  )
}

function RowShell({
  icon,
  color,
  label,
  ruleCitation,
  primary,
  secondary,
  isType1,
}) {
  const bg =
    color === 'ok'    ? 'var(--clr-sage-pale, #e9eee5)'
  : color === 'warn'  ? 'var(--clr-warn-pale, #fbf2e3)'
  : color === 'bad'   ? 'var(--clr-error-pale, #fbe5e3)'
                      : 'var(--clr-cream, #faf5e8)'
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3, 12px)',
        padding: 'var(--space-3, 12px) var(--space-4, 16px)',
        background: bg,
        borderRadius: 'var(--radius-md, 8px)',
        borderLeft: color === 'bad' ? '3px solid var(--clr-error, #b03a3a)'
                  : color === 'warn' ? '3px solid var(--clr-warn, #c97d2e)'
                  : color === 'ok'   ? '3px solid var(--clr-sage-dark, #3e5849)'
                                      : '3px solid var(--clr-warm-mid, #ddc8a4)',
        listStyle: 'none',
      }}
    >
      <span style={{ marginTop: 2 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>
          {label}
          {isType1 && (
            <span
              style={{
                marginLeft: 8,
                padding: '1px 6px',
                fontSize: '0.6875rem',
                fontWeight: 600,
                background: 'var(--clr-warm-mid, #ddc8a4)',
                color: 'var(--clr-ink, #3a342a)',
                borderRadius: 'var(--radius-full, 999px)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
              title="Mirrored from your MiRegistry transcript — verify in MiRegistry."
            >
              MiR
            </span>
          )}
        </div>
        <div style={{ marginTop: 2, fontSize: '0.9375rem' }}>{primary}</div>
        {secondary && (
          <div style={{ marginTop: 2, fontSize: '0.8125rem', color: 'var(--clr-ink-mid)' }}>
            {secondary}
          </div>
        )}
        {ruleCitation && (
          <div style={{ marginTop: 4, fontSize: '0.75rem', color: 'var(--clr-ink-soft, #7a705a)' }}>
            {ruleCitation}
          </div>
        )}
      </div>
    </li>
  )
}
