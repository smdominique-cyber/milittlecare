// Compliance Engine Phase 3.1a — reusable "actionable gap" primitive.
//
// Authoritative contract: docs/pr-compliance-engine-phase-3-1-scope.md §1.
//
// Renders plain-language "how to resolve" guidance plus, when the
// caller supplies a fully-built fixTarget, a react-router <Link>
// styled as a button. No fixTarget → text only. There is never a
// dead or disabled button: the link renders only when both `label`
// and `to` are present.
//
// `severity` is visual weight ONLY — it does not gate the button or
// alter behavior. The surrounding row (ChecklistRow) keeps its own
// state color, icon, and rule citation; this primitive carries no
// compliance-specific assumptions so future adopters (dashboard
// banners, staff-training matrix, iBilling cells) can reuse it.

import { Link } from 'react-router-dom'

const SEVERITY_TEXT_STYLE = Object.freeze({
  critical: { color: 'var(--clr-ink, #3a342a)', fontWeight: 500 },
  warning:  { color: 'var(--clr-ink, #3a342a)', fontWeight: 400 },
  info:     { color: 'var(--clr-ink-mid)',      fontWeight: 400 },
})

/**
 * @param {object} props
 * @param {string} props.guidanceText  REQUIRED. Plain-language "how to
 *                                     resolve" copy. Empty → renders
 *                                     nothing (defensive).
 * @param {{label: string, to: string}} [props.fixTarget]
 *                                     Fully-built destination, query
 *                                     string included. Absent → text
 *                                     only; never a dead button.
 * @param {'critical'|'warning'|'info'} [props.severity='info']
 *                                     Visual weight only.
 */
export default function ActionableGap({ guidanceText, fixTarget, severity = 'info' }) {
  if (!guidanceText) return null
  const tier = SEVERITY_TEXT_STYLE[severity] ? severity : 'info'
  const textStyle = SEVERITY_TEXT_STYLE[tier]
  const hasTarget = Boolean(fixTarget && fixTarget.label && fixTarget.to)

  return (
    <div className={`actionable-gap actionable-gap--${tier}`} style={{ marginTop: 4 }}>
      <p
        style={{
          margin: 0,
          fontSize: '0.875rem',
          lineHeight: 1.5,
          color: textStyle.color,
          fontWeight: textStyle.fontWeight,
        }}
      >
        {guidanceText}
      </p>
      {hasTarget && (
        <Link
          to={fixTarget.to}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 6,
            padding: '4px 12px',
            fontSize: '0.8125rem',
            fontWeight: 500,
            color: 'white',
            background: 'var(--clr-sage-dark, #3e5849)',
            borderRadius: 'var(--radius-md, 8px)',
            textDecoration: 'none',
          }}
        >
          {fixTarget.label} →
        </Link>
      )}
    </div>
  )
}
