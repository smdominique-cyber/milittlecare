import { useId, useState } from 'react'

/**
 * Tooltip that works on hover, keyboard focus, AND tap. Native title=
 * breaks on mobile and has a ~1s appearance delay; this renders a
 * positioned bubble immediately and toggles on tap for touch users.
 *
 * Props:
 *   text     string — the help content
 *   label    string — accessible name for the trigger (announced to screen readers)
 *   children any    — the visible trigger element (icon, badge, text, etc.)
 */
export default function HelpTooltip({ text, label, children }) {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        role="button"
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={e => {
          e.stopPropagation()
          setOpen(o => !o)
        }}
        onKeyDown={e => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(o => !o)
          }
        }}
        style={{ cursor: 'help', display: 'inline-flex', alignItems: 'center' }}
      >
        {children}
      </span>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            zIndex: 20,
            background: 'var(--clr-ink, #2c2a26)',
            color: 'var(--clr-cream, #f6f1e7)',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.8125rem',
            lineHeight: 1.45,
            maxWidth: 320,
            width: 'max-content',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            textTransform: 'none',
            letterSpacing: 0,
            fontWeight: 400,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}
