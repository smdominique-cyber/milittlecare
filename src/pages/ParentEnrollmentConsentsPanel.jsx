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

import { useEffect, useState } from 'react'
import { CheckCircle2, ShieldAlert, Info } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { ACK_TYPES } from '@/lib/acknowledgments'

// Display names for the per-child status rows.
const TYPE_LABEL = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]: 'Field trip permission',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]: 'Photo sharing',
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
  const [acksByChild, setAcksByChild] = useState({})

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
        // both the consent and revocation-pair types to render status.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('id, type, subject_id, acknowledged_via, acknowledged_at, archived_at')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .is('archived_at', null)
        if (ackResp.error) throw ackResp.error

        const byChild = {}
        for (const a of ackResp.data || []) {
          (byChild[a.subject_id] = byChild[a.subject_id] || []).push(a)
        }

        if (!cancelled) {
          setChildren(kids)
          setAcksByChild(byChild)
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
        const acks = acksByChild[child.id] || []
        const fieldTrip = pickActive(acks, ACK_TYPES.FIELD_TRIP_PERMISSION)
        const photoConsent = pickActive(acks, ACK_TYPES.PHOTO_SHARING_CONSENT)
        const photoRevoked = pickActive(acks, ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED)

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

            <StatusRow
              label={TYPE_LABEL[ACK_TYPES.FIELD_TRIP_PERMISSION]}
              ackRow={fieldTrip}
              ifMissingCopy={
                'Not on file yet. Your provider should record this at enrollment ' +
                '(R 400.1952(2) requires written permission for non-vehicle field trips).'
              }
            />

            <PhotoStatusRow
              consent={photoConsent}
              revoked={photoRevoked}
            />
          </section>
        )
      })}
    </div>
  )
}

function pickActive(acks, type) {
  for (const a of acks) {
    if (a.archived_at) continue
    if (a.type === type) return a
  }
  return null
}

function StatusRow({ label, ackRow, ifMissingCopy }) {
  if (ackRow) {
    return (
      <Row
        icon={CheckCircle2}
        iconColor="var(--clr-sage-dark)"
        label={label}
        badge="On file"
        badgeKind="ok"
        detail={
          'Recorded ' +
          (HUMAN_CHANNEL[ackRow.acknowledged_via] || ackRow.acknowledged_via) +
          (ackRow.acknowledged_at ? ` on ${formatDate(ackRow.acknowledged_at)}` : '') +
          '.'
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
      detail={ifMissingCopy}
    />
  )
}

function PhotoStatusRow({ consent, revoked }) {
  const label = TYPE_LABEL[ACK_TYPES.PHOTO_SHARING_CONSENT]

  if (revoked) {
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
          (HUMAN_CHANNEL[revoked.acknowledged_via] || revoked.acknowledged_via) +
          (revoked.acknowledged_at ? ` on ${formatDate(revoked.acknowledged_at)}` : '') +
          '). Note: the messaging system does not yet automatically block ' +
          'photo attachments — your provider is handling photo decisions ' +
          'manually until the enforcement update ships.'
        }
      />
    )
  }
  if (consent) {
    return (
      <Row
        icon={CheckCircle2}
        iconColor="var(--clr-sage-dark)"
        label={label}
        badge="Consented"
        badgeKind="ok"
        detail={
          'Recorded ' +
          (HUMAN_CHANNEL[consent.acknowledged_via] || consent.acknowledged_via) +
          (consent.acknowledged_at ? ` on ${formatDate(consent.acknowledged_at)}` : '') +
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
