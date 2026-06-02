// PR Consents Phase A — parent-side enrollment-consents panel.
//
// Mounted as the "Consents" tab on ParentAcknowledgmentsPage. Phase A
// is READ-ONLY for the parent: per scope §c (P3), there is no
// parent-portal self-confirmation path for these consents — recording
// flows through the provider's EnrollmentConsentsModal via in_person_paper
// or provider_override. The parent's tab here surfaces status (so the
// parent can verify what's on file) but has NO action buttons.
//
// Honest-copy rule (scope §d): until messaging-enforcement ships, the
// revoked-photo-sharing surface must NOT claim photo sharing has been
// stopped. Word it as "preference is recorded," not "photos will no
// longer be shared." Photo-attachment send paths in the messaging code
// do not yet consult this consent state — that's the next PR.
//
// Consents Phase B (2026-06-01) — resolver consolidation per decision 6:
//   - The inline pickActive + per-type render logic that this panel
//     used to implement is REMOVED. Status determination flows through
//     the shared `pendingEnrollmentConsentsForChild` verdict — same
//     function the provider audit helper and the parent dashboard
//     banner call.
//   - The panel now surfaces FOUR states per row:
//        on-file, revoked (photo only), expired, not-on-file.
//   - The expired state is the Phase B addition — a time-bound consent
//     (transportation_routine_annual / water_activities_on_premises_seasonal)
//     whose row is active in the DB sense but past expires_at. The
//     status copy reads "expired on YYYY-MM-DD — needs renewal" and
//     reuses the not-on-file "needs action" treatment.
//   - Phase A's photo-sharing tri-state (consented / revoked / not on
//     file) is preserved unchanged. Photo consent has no expires_at,
//     so it never lands in the expired bucket.

import { useEffect, useState } from 'react'
import { CheckCircle2, ShieldAlert, Info } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { ACK_TYPES } from '@/lib/acknowledgments'
import {
  ENROLLMENT_CONSENT_TYPES,
  TIME_BOUND_TYPES,
  REVOCATION_PAIRS,
  PARENT_SIGNED_SATISFYING_CHANNELS,
  partitionAcksByExpiry,
  pendingEnrollmentConsentsForChild,
} from '@/lib/childFiles'

// Display names for the per-child status rows.
const TYPE_LABEL = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]: 'Field trip permission',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]: 'Photo sharing',
  // Phase B (2026-06-01).
  [ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]:         'Routine transportation (annual)',
  [ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]: 'On-premises water activities (annual)',
})

const TYPE_MISSING_COPY = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]:
    'Not on file yet. Your provider should record this at enrollment ' +
    '(R 400.1952(2) requires written permission for non-vehicle field trips).',
  [ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]:
    'Not on file yet. Your provider should record this if they routinely ' +
    'transport your child (R 400.1952(1) requires written permission for ' +
    'routine transportation, renewed at least annually).',
  [ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]:
    'Not on file yet. Your provider should record this before the ' +
    'water-activity season if they offer on-premises water activities ' +
    '(R 400.1934(10) requires written permission, renewed seasonally).',
})

const HUMAN_CHANNEL = Object.freeze({
  in_person_paper:   'signed on paper',
  parent_portal:     'confirmed in the portal',
  provider_override: 'recorded by provider on your behalf',
})

export default function ParentEnrollmentConsentsPanel() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [children, setChildren] = useState([])
  const [activeByChild, setActiveByChild] = useState({})
  const [expiredByChild, setExpiredByChild] = useState({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (cancelled) return
        if (!user) {
          setError(new Error('Not signed in.'))
          setLoading(false)
          return
        }

        // Parent's active families.
        const linksResp = await supabase
          .from('parent_family_links')
          .select('family_id')
          .eq('parent_id', user.id)
          .eq('status', 'active')
        if (linksResp.error) throw linksResp.error
        const familyIds = (linksResp.data || []).map(r => r.family_id)
        if (familyIds.length === 0) {
          if (!cancelled) { setChildren([]); setLoading(false) }
          return
        }

        const kidsResp = await supabase
          .from('children')
          .select('id, first_name, last_name, family_id, user_id')
          .in('family_id', familyIds)
          .is('archived_at', null)
        if (kidsResp.error) throw kidsResp.error
        const kids = Array.isArray(kidsResp.data) ? kidsResp.data : []
        if (kids.length === 0) {
          if (!cancelled) { setChildren([]); setLoading(false) }
          return
        }

        // Parent-side SELECT on acknowledgments is permitted by the
        // migration 024 RLS policy "Parents can view acks on their
        // children" (subject scoped by parent_family_links). We pull
        // every active (archived_at IS NULL) row including expires_at
        // (Phase B, 2026-06-01) so the panel can render the four
        // states the shared resolver distinguishes.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('id, type, subject_id, acknowledged_via, acknowledged_at, expires_at, archived_at')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .is('archived_at', null)
        if (ackResp.error) throw ackResp.error

        const active = {}
        const expired = {}
        for (const k of kids) {
          const childRows = (ackResp.data || []).filter(a => a.subject_id === k.id)
          const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows: childRows })
          active[k.id] = activeAcks
          expired[k.id] = expiredAcks
        }

        if (!cancelled) {
          setChildren(kids)
          setActiveByChild(active)
          setExpiredByChild(expired)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err)
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="parent-portal" style={{ padding: 24, textAlign: 'center' }}>
        Loading your enrollment consents…
      </div>
    )
  }

  if (error) {
    return (
      <div className="parent-portal" style={{ padding: 16 }}>
        <div role="alert" style={{ background: 'var(--clr-danger-pale)', color: 'var(--clr-danger)', padding: 12, borderRadius: 8 }}>
          {error.message || String(error)}
        </div>
      </div>
    )
  }

  if (children.length === 0) {
    return (
      <div className="parent-portal" style={{ padding: 24, textAlign: 'center' }}>
        <CheckCircle2 size={28} style={{ color: 'var(--clr-sage-dark)' }} aria-hidden="true" />
        <p style={{ margin: '8px 0 0 0' }}>No children on file yet.</p>
      </div>
    )
  }

  return (
    <div className="parent-portal" style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '12px 0 8px 0' }}>Enrollment consents</h1>
      <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.55 }}>
        These are the consents your provider has on file for each child. To
        update or add a consent, talk to your provider — they record these on
        your behalf, on paper, when you&apos;re together. (Self-service via the
        portal is coming in a future update.)
      </p>

      {children.map(child => {
        const activeAcks = activeByChild[child.id] || []
        const expiredAcks = expiredByChild[child.id] || []
        const verdict = pendingEnrollmentConsentsForChild({ activeAcks, expiredAcks })
        const pendingSet = new Set(verdict.enrollment_consents_pending)
        const expiredSet = new Set(verdict.enrollment_consents_expired)

        return (
          <section key={child.id} style={{
            background: 'white',
            border: '1px solid var(--clr-warm-mid)',
            borderRadius: 12,
            padding: 16,
            marginTop: 16,
          }}>
            <h2 style={{ fontSize: '1.125rem', margin: '0 0 12px 0' }}>
              {child.first_name} {child.last_name}
            </h2>

            {/* Licensing-required enrollment consents: one row per
                ENROLLMENT_CONSENT_TYPES entry. The shared verdict
                tells us which state to render. */}
            {ENROLLMENT_CONSENT_TYPES.map(type => (
              <EnrollmentConsentRow
                key={type}
                type={type}
                pending={pendingSet.has(type)}
                expired={expiredSet.has(type)}
                activeAcks={activeAcks}
                expiredAcks={expiredAcks}
              />
            ))}

            {/* Photo sharing — tri-state (consented / revoked /
                not-on-file). Photo consent has no expires_at so the
                expired bucket can't apply. */}
            <PhotoStatusRow
              activeAcks={activeAcks}
            />
          </section>
        )
      })}
    </div>
  )
}

function pickFirstByType(rows, type) {
  for (const a of rows || []) {
    if (a && a.type === type) return a
  }
  return null
}

/**
 * Renders one of three states for a licensing-required enrollment
 * consent (field_trip_permission or one of the Phase B time-bound
 * types): on-file (with channel + date, plus expires_at when set),
 * expired (with capture date and the past expires_at), or not-on-file
 * (with type-specific missing copy).
 */
function EnrollmentConsentRow({ type, pending, expired, activeAcks, expiredAcks }) {
  const label = TYPE_LABEL[type] || type

  if (expired) {
    // Captured-but-lapsed — find the expired row to show its dates.
    const row = pickFirstByType(expiredAcks, type)
    return (
      <Row
        icon={ShieldAlert}
        iconColor="var(--clr-amber, #8a6a1a)"
        label={label}
        badge={`Expired ${formatDate(row?.expires_at)}`}
        badgeKind="pending"
        detail={
          'On file ' +
          (row ? (HUMAN_CHANNEL[row.acknowledged_via] || row.acknowledged_via) : '') +
          (row?.acknowledged_at ? ` on ${formatDate(row.acknowledged_at)}` : '') +
          '. Renewal is overdue — talk to your provider so they can record a fresh signature.'
        }
      />
    )
  }

  if (pending) {
    return (
      <Row
        icon={ShieldAlert}
        iconColor="var(--clr-amber, #8a6a1a)"
        label={label}
        badge="Not on file"
        badgeKind="pending"
        detail={TYPE_MISSING_COPY[type] ||
          'Not on file yet. Your provider should record this on your behalf.'}
      />
    )
  }

  // On file — the verdict said the type is satisfied by a parent-signed
  // row in the currently-valid set. Surface the channel + date and, for
  // time-bound types, the upcoming expires_at.
  const row = pickFirstByType(activeAcks, type)
  const isTimeBound = TIME_BOUND_TYPES.includes(type)
  return (
    <Row
      icon={CheckCircle2}
      iconColor="var(--clr-sage-dark)"
      label={label}
      badge={isTimeBound && row?.expires_at
        ? `On file — renews ${formatDate(row.expires_at)}`
        : 'On file'}
      badgeKind="ok"
      detail={
        'Recorded ' +
        (row ? (HUMAN_CHANNEL[row.acknowledged_via] || row.acknowledged_via) : '') +
        (row?.acknowledged_at ? ` on ${formatDate(row.acknowledged_at)}` : '') +
        '.'
      }
    />
  )
}

function PhotoStatusRow({ activeAcks }) {
  const label = TYPE_LABEL[ACK_TYPES.PHOTO_SHARING_CONSENT]
  // Photo sharing has its own revocation-pair semantic; we resolve
  // tri-state from the activeAcks set against PARENT_SIGNED_SATISFYING_CHANNELS,
  // mirroring the audit verdict's channel-aware rule. We look at the
  // active set only — photo consent has no expires_at, so an "expired"
  // photo row would only ever appear if a future feature adds it.
  let consent = null
  let revoked = null
  for (const a of activeAcks) {
    if (!a) continue
    if (!PARENT_SIGNED_SATISFYING_CHANNELS.includes(a.acknowledged_via)) continue
    if (a.type === ACK_TYPES.PHOTO_SHARING_CONSENT) consent = a
    else if (a.type === REVOCATION_PAIRS[ACK_TYPES.PHOTO_SHARING_CONSENT]) revoked = a
  }
  // Also surface non-parent-signed rows (provider_override) as "on file
  // but not parent-signed" — Phase A's render path showed them as if
  // they were on file. The shared verdict counts them as pending, but
  // the panel renders them so the parent can see the provider's
  // attestation exists.
  let consentAnyChannel = consent
  let revokedAnyChannel = revoked
  if (!consent) {
    for (const a of activeAcks) {
      if (a && a.type === ACK_TYPES.PHOTO_SHARING_CONSENT) { consentAnyChannel = a; break }
    }
  }
  if (!revoked) {
    for (const a of activeAcks) {
      if (a && a.type === REVOCATION_PAIRS[ACK_TYPES.PHOTO_SHARING_CONSENT]) { revokedAnyChannel = a; break }
    }
  }

  if (revokedAnyChannel) {
    // Honest-copy rule: do NOT say "photos will no longer be shared."
    // The messaging attachment path does not yet consult this consent
    // state — enforcement is the next PR.
    return (
      <Row
        icon={Info}
        iconColor="var(--clr-ink-mid)"
        label={label}
        badge="Revoked — preference recorded"
        badgeKind="info"
        detail={
          'Your withdrawal of photo-sharing consent is on file (' +
          (HUMAN_CHANNEL[revokedAnyChannel.acknowledged_via] || revokedAnyChannel.acknowledged_via) +
          (revokedAnyChannel.acknowledged_at ? ` on ${formatDate(revokedAnyChannel.acknowledged_at)}` : '') +
          '). Note: the messaging system does not yet automatically block ' +
          'photo attachments — your provider is handling photo decisions ' +
          'manually until the enforcement update ships.'
        }
      />
    )
  }
  if (consentAnyChannel) {
    return (
      <Row
        icon={CheckCircle2}
        iconColor="var(--clr-sage-dark)"
        label={label}
        badge="Consented"
        badgeKind="ok"
        detail={
          'Recorded ' +
          (HUMAN_CHANNEL[consentAnyChannel.acknowledged_via] || consentAnyChannel.acknowledged_via) +
          (consentAnyChannel.acknowledged_at ? ` on ${formatDate(consentAnyChannel.acknowledged_at)}` : '') +
          '. To withdraw consent, tell your provider — they\'ll record it on file.'
        }
      />
    )
  }
  return (
    <Row
      icon={ShieldAlert}
      iconColor="var(--clr-amber, #8a6a1a)"
      label={label}
      badge="Not on file"
      badgeKind="pending"
      detail={
        'Your photo-sharing preference is not on file yet. Talk to your ' +
        'provider — they record your preference (either way) for the audit ' +
        'trail. Michigan licensing does not require this, but it protects ' +
        'both of you.'
      }
    />
  )
}

function Row({ icon: Icon, iconColor, label, badge, badgeKind, detail }) {
  const badgeColors = {
    ok:      { bg: 'var(--clr-sage-pale, #e6efe7)', text: 'var(--clr-sage-dark)' },
    pending: { bg: 'var(--clr-amber-pale, #fdf3d8)', text: 'var(--clr-amber, #8a6a1a)' },
    info:    { bg: 'var(--clr-cream)', text: 'var(--clr-ink-mid)' },
  }[badgeKind] || { bg: 'var(--clr-cream)', text: 'var(--clr-ink-mid)' }

  return (
    <div style={{
      padding: '10px 0',
      borderTop: '1px solid var(--clr-warm-mid)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
    }}>
      <Icon size={18} style={{ color: iconColor, flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: '0.9375rem' }}>{label}</strong>
          <span style={{
            background: badgeColors.bg,
            color: badgeColors.text,
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            fontSize: '0.6875rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}>{badge}</span>
        </div>
        <p style={{ margin: 0, color: 'var(--clr-ink-soft)', fontSize: '0.8125rem', lineHeight: 1.45 }}>
          {detail}
        </p>
      </div>
    </div>
  )
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return ''
  }
}
