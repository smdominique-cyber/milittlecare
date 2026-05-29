// PR #16 follow-up — parent home intake-discovery banner.
//
// Problem: a parent landing on /parent (the dashboard) has no in-portal
// surface telling them they owe an intake-acknowledgment confirmation.
// The Acknowledgments page's Intake tab shows it, but to reach that tab
// the parent has to know to navigate there. The email CTA worked, but
// any parent who landed via direct sign-in (spam, password sign-in,
// later visit) missed the signal entirely.
//
// Fix: render a banner on the dashboard when the signed-in parent has
// one or more pending intake_acknowledgment_pending reminders for their
// linked children. Same data source the Intake tab uses:
// `listPendingForParent` in `src/lib/parentIntakeReminders.js`, which
// calls the `reminder_instance_list_for_parent` SECURITY DEFINER RPC.
//
// CRITICAL: do NOT query `reminder_instances` directly from the parent
// session. RLS on that table is provider-scoped — direct SELECTs return
// empty under a parent session. This exact bug bit the parent-confirm
// loop already (PR #16 third pass). Reuse the helper.
//
// Non-dismissable: per spec, a pending legal-disclosure confirmation
// shouldn't be swipe-away-able the way the password nudge is. The
// banner clears only when the intake is actually confirmed (i.e., when
// listPendingForParent returns no pending rows).

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { listPendingForParent } from '@/lib/parentIntakeReminders'

/**
 * @param {object} props
 * @param {Array<{id: string, first_name?: string}>} props.children
 *   The parent's linked children, already loaded by the dashboard
 *   (avoids a duplicate fetch). The banner looks up first_name by
 *   subject_id to humanize the copy.
 * @param {string} [props.parentId]
 *   The signed-in parent's auth.uid(). Used as the effect dependency
 *   so the banner refetches if the session swaps (defensive — the
 *   dashboard re-mounts on auth change anyway).
 */
export default function IntakePendingBanner({ children, parentId }) {
  const [pendingChildIds, setPendingChildIds] = useState([])
  // Loading state is intentionally NOT surfaced to the UI: a brief flash
  // of "no banner" before data lands is preferable to a layout-shifting
  // skeleton on the dashboard. The banner only renders after the RPC
  // returns a non-empty result.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { pendingByChild, error } = await listPendingForParent(supabase)
      if (cancelled) return
      if (error) {
        // Non-fatal. Either RLS denied (shouldn't, but the RPC is
        // defensive) or the network failed. The banner silently
        // doesn't show — the Intake tab's badge is a backstop.
        console.warn('IntakePendingBanner: listPendingForParent failed', error)
        setLoaded(true)
        return
      }
      setPendingChildIds(Object.keys(pendingByChild))
      setLoaded(true)
    }
    if (parentId) load()
    return () => { cancelled = true }
    // parentId in deps so the banner refetches on session change.
  }, [parentId])

  if (!loaded) return null
  if (pendingChildIds.length === 0) return null

  // Resolve first names from the dashboard's children prop. A child
  // present in pendingByChild but missing from `children` (the parent's
  // family link was just removed, child archived, etc.) is silently
  // omitted from the name list — the count still reflects the truth.
  const childIndex = new Map(
    (children || []).map(c => [c.id, c])
  )
  const namedPending = pendingChildIds
    .map(id => childIndex.get(id))
    .filter(Boolean)

  const visibleCount = namedPending.length || pendingChildIds.length
  let copy
  if (visibleCount === 1 && namedPending[0]?.first_name) {
    copy = `Your provider needs you to confirm intake disclosures for ${namedPending[0].first_name}.`
  } else if (visibleCount > 0) {
    copy = `Your provider needs you to confirm intake disclosures for ${visibleCount} ${visibleCount === 1 ? 'child' : 'children'}.`
  } else {
    // Safety net — should be unreachable given the early return above.
    copy = 'Your provider needs you to confirm intake disclosures.'
  }

  return (
    <div
      role="alert"
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
      <ShieldAlert size={20} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0 }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem', color: 'var(--clr-ink)', marginBottom: 2 }}>
          Action needed: intake acknowledgment
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', lineHeight: 1.4 }}>
          {copy}
        </div>
      </div>
      <Link
        to="/parent/intake-acknowledge"
        style={{
          background: 'var(--clr-sage-dark)',
          border: 'none',
          color: 'white',
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
        Review and confirm
      </Link>
    </div>
  )
}
