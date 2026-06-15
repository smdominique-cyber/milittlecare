// 2026-06-15 — Part 3 of the parent-portal-branding-and-banners PR.
//
// CONFIRMED cause of the "intake banner doesn't show": no such banner
// ever existed on the parent dashboard. The infrastructure was in
// place — `src/lib/parentIntakeReminders.js` exports
// `listPendingForParent` (which fans an RLS-safe RPC through to a
// per-child map) — but no surface consumed it. The sibling
// `EnrollmentConsentsPendingBanner` even left a header comment
// promising IntakePendingBanner "on the parent-home-intake-banner
// branch — unmerged at the time this file was created." That branch
// never landed. This is it.
//
// The banner is a sibling of `EnrollmentConsentsPendingBanner`:
//   - same callsite pattern: takes `parentId` + optional `children`;
//   - same visual treatment (warm gradient card, status role, View
//     link on the right);
//   - same load-failure ethic: a failed RPC hides the banner rather
//     than misreporting state — the dispatcher is fire-once so the
//     parent eventually receives an email even if this banner never
//     surfaces.
//
// Destination link:
//   - 1 child pending → /parent/intake-acknowledge?child=<id>
//     (matches the deep link that `api/send-invitation.js` and
//     `ChildIntakeModal` use, so the URL the parent reaches from the
//     banner equals the URL their email points to).
//   - 2+ children pending → /parent/acknowledge?tab=intake
//     (the picker tab on the tabbed ack page handles selection).

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { listPendingForParent } from '@/lib/parentIntakeReminders'

/**
 * @param {object} props
 * @param {Array<{id: string, first_name?: string}>} [props.children]
 *   Optional — if the parent dashboard already loaded children for the
 *   Today widget, pass them in so the banner can render first names
 *   without a redundant fetch.
 * @param {string} [props.parentId] auth.uid() of the signed-in parent.
 *   Re-fires the effect when it changes (e.g., after sign-in).
 */
export default function IntakePendingBanner({ children: childrenProp, parentId }) {
  const [loaded, setLoaded] = useState(false)
  const [pendingChildIds, setPendingChildIds] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!parentId) {
        if (!cancelled) setLoaded(true)
        return
      }
      const { pendingByChild, error } = await listPendingForParent(supabase)
      if (cancelled) return
      if (error) {
        // Non-fatal: dispatcher is the backstop (fire-once email).
        setLoaded(true)
        return
      }
      setPendingChildIds(Object.keys(pendingByChild))
      setLoaded(true)
    }
    load()
    return () => { cancelled = true }
  }, [parentId])

  if (!loaded) return null
  if (pendingChildIds.length === 0) return null

  // Resolve first names from the prop if we have them; otherwise the
  // copy falls back to a count-only sentence.
  const childIdToName = new Map(
    (childrenProp || []).map(k => [k.id, k.first_name || null])
  )
  const visibleNames = pendingChildIds
    .map(id => childIdToName.get(id))
    .filter(name => typeof name === 'string' && name.length > 0)

  const visibleCount = pendingChildIds.length
  let copy
  if (visibleCount === 1 && visibleNames[0]) {
    copy =
      `${visibleNames[0]}'s intake packet has updates waiting for your acknowledgment.`
  } else if (visibleCount === 1) {
    copy = `An intake packet has updates waiting for your acknowledgment.`
  } else {
    copy =
      `Intake packets for ${visibleCount} of your children have updates ` +
      `waiting for your acknowledgment.`
  }

  // Single-child case deep-links to the same URL the email CTA uses;
  // multi-child sends the parent to the tabbed picker so they choose.
  const linkTarget =
    visibleCount === 1
      ? `/parent/intake-acknowledge?child=${pendingChildIds[0]}`
      : `/parent/acknowledge?tab=intake`

  return (
    <div
      role="status"
      data-testid="intake-pending-banner"
      style={{
        background: 'linear-gradient(135deg, #faf6ec 0%, #f4eee2 100%)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 14,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <ClipboardList size={20} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0 }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem', color: 'var(--clr-ink)', marginBottom: 2 }}>
          Intake packet pending
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', lineHeight: 1.4 }}>
          {copy}
        </div>
      </div>
      <Link
        to={linkTarget}
        style={{
          background: 'transparent',
          border: '1px solid var(--clr-sage-dark)',
          color: 'var(--clr-sage-dark)',
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.8125rem',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        Review intake
      </Link>
    </div>
  )
}
