// PR #15 Half 2 — generic dashboard banner host.
//
// Reads useActiveReminders(); renders one stacked banner per active
// instance, severity-tinted via the catalog's optional
// `severity_thresholds` (default ladder otherwise). Each banner has:
//   - icon
//   - title (headline) + body (supporting text)
//   - CTA button -> cta_path (react-router Link)
//   - Dismiss button -> calls dismiss(id) which hits the
//     reminder_instance_dismiss RPC
//
// The legacy bespoke banners (AnnualTrainingBanner,
// LicenseTypeReviewBanner, MiRegistryWarningBanner) coexist with this
// host in V1 per OQ4 resolution. Consolidation is a follow-up PR;
// see docs/tech_debt.md.

import { Link } from 'react-router-dom'
import { AlertCircle, ArrowRight, Bell, CalendarCheck, X } from 'lucide-react'
import { useActiveReminders } from '@/hooks/useActiveReminders'
import { REMINDER_CATEGORIES } from '@/lib/reminderCategories'
import { getSeverityForDueDate } from '@/lib/reminderSeverity'

// ─── Severity styles ──────────────────────────────────────────────────
//
// Matches AnnualTrainingBanner.jsx's SEVERITY_STYLES so the new host
// blends visually with the legacy banners while we coexist (OQ4).
// Single source-of-truth pending the consolidation PR.

const SEVERITY_STYLES = Object.freeze({
  info: {
    background: 'linear-gradient(135deg, #f0f4f8 0%, #e6ecf2 100%)',
    border: '1px solid var(--clr-warm-mid)',
    color: 'var(--clr-ink)',
    iconColor: 'var(--clr-sage-dark)',
  },
  warning: {
    background: 'var(--clr-warn-pale, #fdf3d8)',
    border: '1px solid var(--clr-warn-mid, #e8d196)',
    color: 'var(--clr-warn-ink, #8a6a1a)',
    iconColor: 'var(--clr-warn-ink, #8a6a1a)',
  },
  urgent: {
    background: '#fdebd0',
    border: '1px solid #d4831f',
    color: '#7a4500',
    iconColor: '#7a4500',
  },
  critical: {
    background: 'var(--clr-danger-pale, #fbe9eb)',
    border: '1px solid var(--clr-danger, #b00020)',
    color: 'var(--clr-danger, #b00020)',
    iconColor: 'var(--clr-danger, #b00020)',
  },
  expired: {
    background: 'var(--clr-danger-pale, #fbe9eb)',
    border: '1px solid var(--clr-danger, #b00020)',
    color: 'var(--clr-danger, #b00020)',
    iconColor: 'var(--clr-danger, #b00020)',
  },
  null_: {  // null severity -> fall back to info palette
    background: 'linear-gradient(135deg, #f0f4f8 0%, #e6ecf2 100%)',
    border: '1px solid var(--clr-warm-mid)',
    color: 'var(--clr-ink)',
    iconColor: 'var(--clr-sage-dark)',
  },
})

function pickIcon(severity) {
  if (severity === 'critical' || severity === 'expired') return AlertCircle
  if (severity === 'urgent') return AlertCircle
  if (severity === 'warning' || severity === 'info') return CalendarCheck
  return Bell
}

/**
 * Compute the severity rung for an instance. Prefers `due_at`; falls
 * back to `trigger_at` so the rung is always defined for the host.
 * Returns null when neither is set (renders the info palette).
 */
function instanceSeverity(instance) {
  const catalog = REMINDER_CATEGORIES[instance.category]
  const thresholds = catalog?.severity_thresholds
  const ymd = (instance.due_at || instance.trigger_at || '').slice(0, 10)
  return getSeverityForDueDate(ymd, thresholds)
}

export default function ReminderBanners() {
  const { instances, dismiss } = useActiveReminders()

  if (!instances || instances.length === 0) return null

  return (
    <>
      {instances.map(inst => {
        const sev = instanceSeverity(inst)
        const style = SEVERITY_STYLES[sev] || SEVERITY_STYLES.null_
        const Icon = pickIcon(sev)
        return (
          <div
            key={inst.id}
            role="alert"
            style={{
              background: style.background,
              border: style.border,
              color: style.color,
              borderRadius: 'var(--radius-lg)',
              padding: 14,
              marginBottom: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Icon size={20} style={{ color: style.iconColor, flexShrink: 0 }} aria-hidden="true" />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: '0.9375rem',
                marginBottom: inst.body ? 2 : 0,
              }}>
                {inst.title}
              </div>
              {inst.body && (
                <div style={{
                  fontSize: '0.8125rem',
                  color: 'var(--clr-ink-mid)',
                  lineHeight: 1.4,
                }}>
                  {inst.body}
                </div>
              )}
            </div>

            {inst.cta_path && (
              <Link
                to={inst.cta_path}
                style={{
                  background: 'var(--clr-sage-dark)',
                  color: 'white',
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  whiteSpace: 'nowrap',
                }}
              >
                Open <ArrowRight size={14} />
              </Link>
            )}

            <button
              type="button"
              onClick={() => dismiss(inst.id)}
              title="Dismiss until next reminder"
              aria-label="Dismiss reminder"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 6,
                borderRadius: 'var(--radius-md)',
                color: 'var(--clr-ink-soft)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </>
  )
}
