// PR #15 Half 2 — Reminders settings page.
//
// Lists every catalog category gated to the provider's license_type
// (`categoriesForLicenseType`) with a per-row toggle, lead-time
// dropdown, and channel dropdown. Optimistic save-on-change with
// rollback on error (handled inside useReminderPreferences). Empty
// state when no categories apply.

import { useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { Bell, BellOff, Info } from 'lucide-react'
import { useActiveModules } from '@/hooks/useActiveModules'
import { useReminderPreferences } from '@/hooks/useReminderPreferences'
import { MODULE_KEYS } from '@/lib/modules'
import {
  REMINDER_CATEGORIES,
  categoriesForLicenseType,
} from '@/lib/reminderCategories'

const LEAD_TIME_OPTIONS = [0, 1, 7, 14, 30]

const CHANNEL_OPTIONS = [
  { value: 'in_app', label: 'In-app banner only' },
  { value: 'email', label: 'Email only' },
  { value: 'both', label: 'In-app banner + email' },
]

function formatLead(n) {
  if (n === 0) return 'On the day of'
  if (n === 1) return '1 day before'
  return `${n} days before`
}

export default function RemindersSettingsPage() {
  const { loading: modulesLoading, modules, profile } = useActiveModules()
  const { byCategory, enable, disable, update, loading, error } =
    useReminderPreferences()

  const licenseType = profile?.license_type ?? null
  const categories = useMemo(
    () => categoriesForLicenseType(licenseType),
    [licenseType]
  )

  if (modulesLoading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  // Module-gate redirect — matches the pattern used by other compliance
  // pages. The settings page is only reachable when MODULE_KEYS.REMINDERS
  // is active (i.e. license_type is set), so this should rarely fire
  // outside a deep-link or stale tab.
  if (!modules.has(MODULE_KEYS.REMINDERS)) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <div className="reminders-settings" style={pageStyles.root}>
      <header style={pageStyles.header}>
        <h1 style={pageStyles.h1}>Reminders</h1>
        <p style={pageStyles.lede}>
          Compliance reminders are opt-in. Turn on the categories you want,
          pick how far in advance you want the heads-up, and choose where
          to receive it. Most are off by default; a few marked &ldquo;On unless
          you opt out&rdquo; fire automatically when you take an explicit
          action that triggers them.
        </p>
      </header>

      {error && (
        <div role="alert" style={pageStyles.errorBox}>
          We could not save that change. Please retry. Detail: {String(error.message || error)}
        </div>
      )}

      {categories.length === 0 ? (
        <EmptyState />
      ) : (
        <ul style={pageStyles.list}>
          {categories.map(c => (
            <CategoryRow
              key={c.key}
              category={c}
              preference={byCategory[c.key]}
              busy={loading}
              onEnable={() => enable(c.key)}
              onDisable={() => disable(c.key)}
              onUpdate={(patch) => update(c.key, patch)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div style={pageStyles.empty}>
      <Bell size={28} style={{ color: 'var(--clr-ink-soft)' }} />
      <p style={{ margin: '8px 0 0 0', color: 'var(--clr-ink-mid)' }}>
        No reminder categories apply to your account yet. Once you set
        your license type, the relevant categories will appear here.
      </p>
    </div>
  )
}

function CategoryRow({ category, preference, busy, onEnable, onDisable, onUpdate }) {
  // PR #16 follow-up — transactional categories ship with the toggle
  // visibly ON when no preference row exists (because the dispatcher
  // fires them by default; the row's only purpose is the explicit
  // off-switch). Stateful (default) categories keep the PR #15
  // "enabled only when preference exists and enabled=true" semantics.
  const isTransactional = category.transactional === true
  const enabled = preference
    ? preference.enabled === true
    : isTransactional   // default visible state for transactional = ON

  const leadTimeRaw =
    preference?.lead_time_days != null
      ? preference.lead_time_days
      : category.default_lead_time_days
  const leadTime = LEAD_TIME_OPTIONS.includes(leadTimeRaw)
    ? leadTimeRaw
    : LEAD_TIME_OPTIONS[2]   // 7
  // For transactional categories the dispatcher's "no row" default
  // channel is email — keep the UI consistent.
  const channel = preference?.channel || (isTransactional ? 'email' : 'in_app')

  const handleToggle = () => {
    if (enabled) onDisable()
    else onEnable()
  }

  const toggleTitle = category.settings_label_override || category.label

  return (
    <li style={pageStyles.card(enabled)}>
      <div style={pageStyles.cardHeader}>
        <label style={pageStyles.toggleLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={handleToggle}
            disabled={busy}
            style={{ width: 18, height: 18, margin: 0 }}
            aria-label={`${toggleTitle} reminders`}
          />
          <span style={pageStyles.toggleIcon} aria-hidden="true">
            {enabled
              ? <Bell size={18} style={{ color: 'var(--clr-sage-dark)' }} />
              : <BellOff size={18} style={{ color: 'var(--clr-ink-soft)' }} />}
          </span>
          <span style={pageStyles.toggleTitle}>{toggleTitle}</span>
          {isTransactional && (
            <span style={pageStyles.transactionalBadge}>
              On unless you opt out
            </span>
          )}
        </label>
      </div>

      <p style={pageStyles.description}>
        <Info size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />
        {category.description}
      </p>

      {enabled && (
        <div style={pageStyles.controls}>
          <label style={pageStyles.field}>
            <span style={pageStyles.fieldLabel}>Send the reminder</span>
            <select
              value={leadTime}
              onChange={e => onUpdate({ lead_time_days: Number(e.target.value) })}
              disabled={busy}
              style={pageStyles.select}
            >
              {LEAD_TIME_OPTIONS.map(n => (
                <option key={n} value={n}>{formatLead(n)}</option>
              ))}
            </select>
          </label>

          <label style={pageStyles.field}>
            <span style={pageStyles.fieldLabel}>Where to send it</span>
            <select
              value={channel}
              onChange={e => onUpdate({ channel: e.target.value })}
              disabled={busy}
              style={pageStyles.select}
            >
              {CHANNEL_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </li>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────
// Matches the BusinessInfoPage / other Settings pages' inline-style
// vocabulary: --clr-* tokens for colors, --space-* for spacing,
// --radius-* for corners.

const pageStyles = {
  root: {
    maxWidth: 760,
    margin: '0 auto',
    padding: 'var(--space-4) var(--space-4) var(--space-8)',
  },
  header: { marginBottom: 'var(--space-6)' },
  h1: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.5rem',
    color: 'var(--clr-ink)',
    margin: '0 0 8px 0',
    letterSpacing: '-0.01em',
    fontWeight: 500,
  },
  lede: {
    margin: 0,
    color: 'var(--clr-ink-mid)',
    fontSize: '0.9375rem',
    lineHeight: 1.55,
  },
  errorBox: {
    background: 'var(--clr-danger-pale, #fbe9eb)',
    border: '1px solid var(--clr-danger, #b00020)',
    color: 'var(--clr-danger, #b00020)',
    padding: '10px 14px',
    borderRadius: 'var(--radius-md)',
    marginBottom: 'var(--space-4)',
    fontSize: '0.875rem',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  },
  card: (enabled) => ({
    background: 'white',
    border: `1px solid ${enabled ? 'var(--clr-sage)' : 'var(--clr-warm-mid)'}`,
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-4)',
  }),
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    marginBottom: 6,
  },
  toggleLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
    flex: 1,
  },
  toggleIcon: {
    display: 'inline-flex',
    alignItems: 'center',
  },
  toggleTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: '1rem',
    color: 'var(--clr-ink)',
    fontWeight: 500,
  },
  transactionalBadge: {
    fontSize: '0.6875rem',
    color: 'var(--clr-sage-dark)',
    background: 'var(--clr-sage-pale, #e6efe7)',
    border: '1px solid var(--clr-sage, #b8d2bc)',
    padding: '2px 8px',
    borderRadius: 12,
    marginLeft: 8,
    letterSpacing: '0.02em',
    fontWeight: 500,
  },
  description: {
    margin: '0 0 var(--space-3) 28px',
    color: 'var(--clr-ink-soft)',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
  },
  controls: {
    display: 'flex',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    marginLeft: 28,
    paddingTop: 'var(--space-2)',
    borderTop: '1px dashed var(--clr-warm-mid)',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 200,
    flex: 1,
  },
  fieldLabel: {
    fontSize: '0.75rem',
    color: 'var(--clr-ink-soft)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 500,
  },
  select: {
    padding: '8px 10px',
    border: '1px solid var(--clr-warm-mid)',
    borderRadius: 'var(--radius-md)',
    background: 'white',
    fontSize: '0.875rem',
    color: 'var(--clr-ink)',
    fontFamily: 'var(--font-body)',
  },
  empty: {
    background: 'var(--clr-cream)',
    border: '1px dashed var(--clr-warm-mid)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-8)',
    textAlign: 'center',
  },
}

// Exported for downstream consumers / tests if needed.
export { LEAD_TIME_OPTIONS, CHANNEL_OPTIONS }

// REMINDER_CATEGORIES is re-exported here purely so a single
// `import { …Page, REMINDER_CATEGORIES } from '…RemindersSettingsPage'`
// can pull both. Optional convenience.
export { REMINDER_CATEGORIES }
