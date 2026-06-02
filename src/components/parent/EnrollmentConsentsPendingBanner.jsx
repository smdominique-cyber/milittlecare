// PR Consents Phase A — parent dashboard banner.
//
// Sibling to IntakePendingBanner (on the parent-home-intake-banner
// branch — unmerged at the time this file was created). Surfaces when
// the parent has children with at least one enrollment-level consent
// (field_trip_permission, photo_sharing_consent / revocation) NOT
// recorded via a parent-signed channel.
//
// IMPORTANT — informational only in Phase A (per scope §c / P3):
// the parent has NO parent-portal self-confirm path for these consents
// in this phase. The provider records via in_person_paper or
// provider_override. The banner therefore links to the read-only
// Consents tab (so the parent can verify what IS on file) and the
// copy frames the action as "talk to your provider," not "confirm now."
// A future Phase B with a generalized parent-confirm RPC can flip this
// to an actionable banner; for now informational discovery is the
// honest framing.
//
// Honest-copy rule (scope §d): no claims about photo enforcement.
// The banner says "preference is not on file," NOT "photos are being
// shared" or "photos will be blocked."

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'
// cc-followup-consent-count-parity (2026-05-30): banner uses the SAME
// shared verdict function the provider audit helper does. Inline logic
// was here previously; the drift risk on the revocation-pair rule is
// now structurally eliminated.
// Consents Phase B (2026-06-01): the banner now also partitions acks
// by expiry before feeding the verdict, so the "captured then lapsed"
// state surfaces in the banner copy alongside "never captured."
import {
  pendingEnrollmentConsentsForChild,
  partitionAcksByExpiry,
} from '@/lib/childFiles'

/**
 * @param {object} props
 * @param {Array<{id: string, first_name?: string}>} [props.children]
 *   Optional — if the parent dashboard already loaded children for the
 *   Today widget, pass them in to skip the redundant fetch. The banner
 *   falls back to its own fetch if absent.
 * @param {string} [props.parentId] auth.uid() of the signed-in parent.
 *   Used as the effect dependency; refetches if it changes.
 */
export default function EnrollmentConsentsPendingBanner({ children: childrenProp, parentId }) {
  const [loaded, setLoaded] = useState(false)
  const [pendingChildren, setPendingChildren] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // 1) Get children — from prop if provided, else fetch fresh.
        let kids = childrenProp
        if (!kids || kids.length === 0) {
          const linksResp = await supabase
            .from('parent_family_links')
            .select('family_id')
            .eq('parent_id', parentId)
            .eq('status', 'active')
          if (cancelled) return
          const familyIds = (linksResp.data || []).map(r => r.family_id)
          if (familyIds.length === 0) {
            setLoaded(true)
            return
          }
          const kidsResp = await supabase
            .from('children')
            .select('id, first_name, family_id')
            .in('family_id', familyIds)
            .is('archived_at', null)
          if (cancelled) return
          kids = kidsResp.data || []
        }
        if (kids.length === 0) {
          setLoaded(true)
          return
        }

        // 2) Pull active enrollment-consent acks for those children.
        //    Parent has RLS SELECT on their linked children's acks
        //    (migration 024). Projection covers everything the shared
        //    verdict function reads — `type`, `acknowledged_via`, and
        //    (Phase B, 2026-06-01) `expires_at` so we can partition
        //    captured-but-lapsed rows from currently-valid ones.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('subject_id, type, acknowledged_via, expires_at')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .is('archived_at', null)
        if (cancelled) return

        // 3) Group raw acks per child, partition each child's acks
        //    into currently-valid vs. expired via the shared helper,
        //    then feed both arrays to the shared verdict. The verdict
        //    distinguishes never-captured (pending) from
        //    captured-but-lapsed (expired); the banner surfaces
        //    either as a compliance gap (any_pending = true if
        //    either is non-empty).
        const acksByChild = new Map()
        for (const a of ackResp.data || []) {
          let list = acksByChild.get(a.subject_id)
          if (!list) { list = []; acksByChild.set(a.subject_id, list) }
          list.push(a)
        }
        const affected = []
        for (const k of kids) {
          const { activeAcks, expiredAcks } = partitionAcksByExpiry({
            rows: acksByChild.get(k.id) || [],
          })
          const verdict = pendingEnrollmentConsentsForChild({
            activeAcks,
            expiredAcks,
          })
          if (verdict.any_pending) affected.push(k)
        }
        if (!cancelled) {
          setPendingChildren(affected)
          setLoaded(true)
        }
      } catch {
        // Non-fatal: banner hides, the Consents tab is the backstop.
        if (!cancelled) setLoaded(true)
      }
    }
    if (parentId) load()
    return () => { cancelled = true }
  }, [parentId, childrenProp])

  if (!loaded) return null
  if (pendingChildren.length === 0) return null

  const visibleCount = pendingChildren.length
  let copy
  if (visibleCount === 1 && pendingChildren[0]?.first_name) {
    copy =
      `Some enrollment consents for ${pendingChildren[0].first_name} ` +
      `aren’t on file yet — next time you’re with your provider, ask them to record them.`
  } else {
    copy =
      `Some enrollment consents for ${visibleCount} of your ` +
      `${visibleCount === 1 ? 'child' : 'children'} aren’t on file yet ` +
      `— next time you’re with your provider, ask them to record them.`
  }

  return (
    <div
      role="status"
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
      <ShieldAlert size={20} style={{ color: 'var(--clr-ink-mid)', flexShrink: 0 }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.9375rem', color: 'var(--clr-ink)', marginBottom: 2 }}>
          Enrollment consents on file
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', lineHeight: 1.4 }}>
          {copy}
        </div>
      </div>
      <Link
        to="/parent/acknowledge?tab=consents"
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
        View status
      </Link>
    </div>
  )
}
