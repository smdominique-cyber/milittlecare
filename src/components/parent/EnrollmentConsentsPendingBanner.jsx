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
import { ACK_TYPES } from '@/lib/acknowledgments'

const SATISFYING_CHANNELS = new Set(['parent_portal', 'in_person_paper'])

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
        //    Parent has RLS SELECT on their linked children's acks.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('subject_id, type, acknowledged_via')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .is('archived_at', null)
        if (cancelled) return

        // 3) Index parent-signed acks per child.
        const havePer = new Map()  // childId → Set<type>
        for (const a of ackResp.data || []) {
          if (!SATISFYING_CHANNELS.has(a.acknowledged_via)) continue
          let s = havePer.get(a.subject_id)
          if (!s) { s = new Set(); havePer.set(a.subject_id, s) }
          s.add(a.type)
        }

        // 4) Compute affected children. Field trip = pending if no
        //    parent-signed field_trip_permission. Photo = pending if
        //    neither a parent-signed consent nor a parent-signed
        //    revocation. A child with EITHER pending is affected.
        const affected = []
        for (const k of kids) {
          const have = havePer.get(k.id) || new Set()
          const fieldTripOk = have.has(ACK_TYPES.FIELD_TRIP_PERMISSION)
          const photoCaptured = have.has(ACK_TYPES.PHOTO_SHARING_CONSENT) ||
                                have.has(ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED)
          if (!fieldTripOk || !photoCaptured) affected.push(k)
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
