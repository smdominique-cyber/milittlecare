// PR Consents Phase A — provider-facing enrollment-consents modal.
//
// Sibling to ChildIntakeModal. Per pr-consents-A-scope.md § UX, this
// modal captures the two enrollment-level consents that sit OUTSIDE
// the R 400.1907 intake bundle:
//   - FIELD_TRIP_PERMISSION       (R 400.1952(2), licensing-required)
//   - PHOTO_SHARING_CONSENT        (no rule, provider-protective,
//                                   revocable via photo_sharing_consent_revoked)
//
// Phase A scope (P3 — no parent-portal self-confirm):
//   - Channels: in_person_paper + provider_override ONLY.
//   - Recording is provider-driven. No new RPC.
//   - Photo revocation = archive active consent row + insert a
//     PHOTO_SHARING_CONSENT_REVOKED row. Same channel rule applies
//     to the revocation row (parent's preference, recorded via the
//     same channels).
//
// Standing copy rule (scope §d): until messaging-enforcement ships,
// revocation UI MUST NOT claim photo sharing has stopped. Word it as
// "preference recorded," not "sharing will stop." The messaging
// attachment path does NOT currently consult consent state.

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ShieldAlert, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  ACK_TYPES,
  computeAckHash,
  findActiveAck,
} from '@/lib/acknowledgments'

const COPY_VERSIONS = Object.freeze({
  field_trip_permission: 'v1',
  photo_sharing_consent: 'v1',
  photo_sharing_consent_revoked: 'v1',
})

const TYPE_LABEL = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]: 'Field trip permission (non-vehicle)',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]: 'Photo sharing consent',
})

const TYPE_HELP = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]:
    'Required by Michigan rule R 400.1952(2) at initial enrollment — ' +
    'written parent permission for the child to go on field trips ' +
    'that do not involve a vehicle.',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]:
    'Consent to share photos of this child with this child\'s parent ' +
    '(e.g. via messaging). Michigan licensing does not require this; ' +
    'capturing it protects you and respects the parent\'s preference. ' +
    'The wording below is a placeholder — final consent language should ' +
    'be reviewed with your lawyer or insurer before relying on it.',
})

export default function EnrollmentConsentsModal({
  userId,                 // licensee's auth uid → provider_id
  child,
  primaryGuardianName,    // optional, prefills parent_label
  onClose,
  onSaved,
}) {
  const [acks, setAcks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Per-row channel + inputs. Default to in_person_paper which is the
  // channel that actually moves the audit-state needle (the parent-
  // signed channel rule from PR #16 applies here too).
  const [channel, setChannel] = useState('in_person_paper')
  const [parentLabel, setParentLabel] = useState(primaryGuardianName || '')
  const [providerReason, setProviderReason] = useState(
    'Captured at child enrollment; parent acknowledged in person.'
  )

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      const { data, error } = await supabase
        .from('acknowledgments')
        .select('id, type, subject_type, subject_id, snapshot_hash, archived_at, acknowledged_via, acknowledged_at')
        .eq('provider_id', userId)
        .eq('subject_type', 'child')
        .eq('subject_id', child.id)
        .is('archived_at', null)
      if (cancelled) return
      if (error) setError(error)
      else setAcks(Array.isArray(data) ? data : [])
      setLoading(false)
    }
    if (child && userId) load()
    return () => { cancelled = true }
  }, [child, userId])

  // Per-type active state, computed from the loaded acks.
  const state = useMemo(() => {
    const fieldTrip = findActiveAck(acks, {
      type: ACK_TYPES.FIELD_TRIP_PERMISSION,
      subjectType: 'child',
      subjectId: child.id,
    })
    const photoConsent = findActiveAck(acks, {
      type: ACK_TYPES.PHOTO_SHARING_CONSENT,
      subjectType: 'child',
      subjectId: child.id,
    })
    const photoRevoked = findActiveAck(acks, {
      type: ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED,
      subjectType: 'child',
      subjectId: child.id,
    })
    // For audit-state reporting we'd also weigh the channel; for the
    // modal UX it's enough to show "recorded" / "revoked" / "not yet
    // recorded" — providers can re-record to upgrade the channel.
    let photoState = 'unrecorded'
    if (photoRevoked) photoState = 'revoked'
    else if (photoConsent) photoState = 'consented'
    return {
      fieldTripRecorded: !!fieldTrip,
      fieldTripChannel: fieldTrip?.acknowledged_via || null,
      photoState,
      photoChannel: photoState === 'consented'
        ? photoConsent?.acknowledged_via
        : photoState === 'revoked'
          ? photoRevoked?.acknowledged_via
          : null,
    }
  }, [acks, child.id])

  const channelValid = (() => {
    if (channel === 'in_person_paper') return parentLabel.trim().length > 0
    if (channel === 'provider_override') return providerReason.trim().length > 0
    return false
  })()

  // Shared field block for an insert — same shape ChildIntakeModal uses,
  // minus envelope concerns. Phase A: parent_portal not offered (P3).
  function buildSharedFields() {
    return {
      provider_id: userId,
      subject_type: 'child',
      subject_id: child.id,
      acknowledged_via: channel,
      acknowledged_by_user_id: null,
      acknowledged_by_label: channel === 'in_person_paper' ? parentLabel.trim() : null,
      provider_override_reason: channel === 'provider_override' ? providerReason.trim() : null,
    }
  }

  async function archiveActiveOfType(type) {
    const existing = acks.filter(a => a.type === type && !a.archived_at)
    if (existing.length === 0) return
    const ids = existing.map(a => a.id)
    const { error: err } = await supabase
      .from('acknowledgments')
      .update({ archived_at: new Date().toISOString() })
      .in('id', ids)
    if (err) throw err
  }

  async function recordOne(type) {
    if (!channelValid || saving) return
    setSaving(true)
    setError(null)
    try {
      // Archive any existing active row of this exact type so the
      // partial unique index allows the new insert.
      await archiveActiveOfType(type)
      // For photo CONSENT: also archive any active REVOKED row (a
      // re-consent overrides a prior revocation). Symmetric on the
      // revoke side.
      if (type === ACK_TYPES.PHOTO_SHARING_CONSENT) {
        await archiveActiveOfType(ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED)
      }

      const payload = subTypePayload(type)
      const snapshot_hash = computeAckHash({ type, payload })

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert([{
          ...buildSharedFields(),
          type,
          snapshot_hash,
          snapshot_version: COPY_VERSIONS[type] || null,
        }])
      if (insertErr) throw insertErr

      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  async function revokePhotoConsent() {
    if (!channelValid || saving) return
    setSaving(true)
    setError(null)
    try {
      // Archive the active consent row (if any), then insert a
      // revocation-pair row. Both events survive in the audit trail.
      await archiveActiveOfType(ACK_TYPES.PHOTO_SHARING_CONSENT)
      // Archive any prior active revoke row too (a second revoke
      // overrides the older one — only one active state per child).
      await archiveActiveOfType(ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED)

      const type = ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED
      const payload = subTypePayload(type)
      const snapshot_hash = computeAckHash({ type, payload })

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert([{
          ...buildSharedFields(),
          type,
          snapshot_hash,
          snapshot_version: COPY_VERSIONS[type] || null,
        }])
      if (insertErr) throw insertErr

      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div
        className="modal-card"
        style={{ maxWidth: 640, width: '95%', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="modal-header" style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
          <span className="modal-title">
            Enrollment consents for {child.first_name}
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close enrollment consents form"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, color: 'var(--clr-ink-mid)', fontSize: '0.875rem', lineHeight: 1.5 }}>
            Record this child&apos;s enrollment-level consents. These are SEPARATE
            from the Rule 7 intake bundle. Use the channel chooser below to
            record whether the parent signed on paper or you are recording on
            their behalf.
          </p>

          {loading ? (
            <p>Loading enrollment consents…</p>
          ) : (
            <>
              <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <ConsentRow
                  icon={state.fieldTripRecorded ? CheckCircle2 : ShieldAlert}
                  title={TYPE_LABEL[ACK_TYPES.FIELD_TRIP_PERMISSION]}
                  badge={
                    state.fieldTripRecorded
                      ? `Recorded (${humanChannel(state.fieldTripChannel)})`
                      : 'Not recorded'
                  }
                  badgeKind={state.fieldTripRecorded ? 'ok' : 'pending'}
                  help={TYPE_HELP[ACK_TYPES.FIELD_TRIP_PERMISSION]}
                  actions={[
                    {
                      label: state.fieldTripRecorded ? 'Re-record' : 'Record',
                      onClick: () => recordOne(ACK_TYPES.FIELD_TRIP_PERMISSION),
                      disabled: saving || !channelValid,
                    },
                  ]}
                />

                <ConsentRow
                  icon={
                    state.photoState === 'consented' ? CheckCircle2
                      : state.photoState === 'revoked' ? ShieldAlert
                      : ShieldAlert
                  }
                  title={TYPE_LABEL[ACK_TYPES.PHOTO_SHARING_CONSENT]}
                  badge={
                    state.photoState === 'consented'
                      ? `Consented (${humanChannel(state.photoChannel)})`
                      : state.photoState === 'revoked'
                        ? `Revoked — preference recorded (${humanChannel(state.photoChannel)})`
                        : 'Not recorded'
                  }
                  badgeKind={
                    state.photoState === 'consented' ? 'ok'
                      : state.photoState === 'revoked' ? 'info'
                      : 'pending'
                  }
                  help={TYPE_HELP[ACK_TYPES.PHOTO_SHARING_CONSENT]}
                  footnote={
                    state.photoState === 'revoked'
                      ? 'The parent\'s preference is on file. Note: photo sharing in messaging is not yet automatically blocked — that enforcement ships in a follow-up. Handle photo decisions manually for now.'
                      : null
                  }
                  actions={[
                    {
                      label: state.photoState === 'consented' ? 'Re-record consent' : 'Record consent',
                      onClick: () => recordOne(ACK_TYPES.PHOTO_SHARING_CONSENT),
                      disabled: saving || !channelValid,
                    },
                    ...(state.photoState === 'consented'
                      ? [{
                          label: 'Record revocation',
                          onClick: revokePhotoConsent,
                          disabled: saving || !channelValid,
                          variant: 'discard',
                        }]
                      : []),
                  ]}
                />
              </section>

              <section>
                <h3 style={{ fontSize: '1rem', margin: '0 0 8px 0' }}>How is the parent acknowledging?</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label>
                    <input
                      type="radio"
                      name="channel"
                      value="in_person_paper"
                      checked={channel === 'in_person_paper'}
                      onChange={() => setChannel('in_person_paper')}
                    /> Parent signed in person / on paper
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="channel"
                      value="provider_override"
                      checked={channel === 'provider_override'}
                      onChange={() => setChannel('provider_override')}
                    /> I am recording on the parent&apos;s behalf
                  </label>
                </div>

                {channel === 'in_person_paper' && (
                  <div style={{ marginTop: 8 }}>
                    <label style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
                      Parent name (as signed on paper)
                    </label>
                    <input
                      type="text"
                      value={parentLabel}
                      onChange={e => setParentLabel(e.target.value)}
                      style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                    />
                    <p style={{ marginTop: 6, fontSize: '0.75rem', color: 'var(--clr-ink-soft)' }}>
                      Recording this way clears the audit-state pending count for this consent.
                    </p>
                  </div>
                )}
                {channel === 'provider_override' && (
                  <div style={{ marginTop: 8 }}>
                    <label style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
                      Reason
                    </label>
                    <textarea
                      value={providerReason}
                      onChange={e => setProviderReason(e.target.value)}
                      rows={2}
                      style={{ width: '100%', padding: 6, boxSizing: 'border-box', fontFamily: 'inherit' }}
                    />
                    <p style={{ marginTop: 6, fontSize: '0.75rem', color: 'var(--clr-ink-soft)' }}>
                      Provider override is captured in the audit trail but does NOT
                      clear the parent-signed pending count. Use &ldquo;Parent signed
                      in person&rdquo; once you have the paper signature.
                    </p>
                  </div>
                )}
              </section>

              {error && (
                <div role="alert" style={{ color: 'var(--clr-danger)', fontSize: '0.875rem' }}>
                  <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  Could not save: {error.message || String(error)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: 12 }}>
          <button className="btn-discard" onClick={onClose} disabled={saving}>Close</button>
        </div>
      </div>
    </div>
  )
}

function ConsentRow({ icon: Icon, title, badge, badgeKind, help, footnote, actions }) {
  const badgeColors = {
    ok:      { bg: 'var(--clr-sage-pale, #e6efe7)', text: 'var(--clr-sage-dark)' },
    pending: { bg: 'var(--clr-amber-pale, #fdf3d8)', text: 'var(--clr-amber, #8a6a1a)' },
    info:    { bg: 'var(--clr-cream)', text: 'var(--clr-ink-mid)' },
  }[badgeKind] || { bg: 'var(--clr-cream)', text: 'var(--clr-ink-mid)' }

  return (
    <div style={{
      padding: 12,
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-md)',
      background: 'white',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Icon size={18} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: '0.9375rem' }}>{title}</strong>
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
            {help}
          </p>
          {footnote && (
            <p style={{ margin: '6px 0 0 0', color: 'var(--clr-ink-mid)', fontSize: '0.75rem', fontStyle: 'italic', lineHeight: 1.4 }}>
              {footnote}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {actions.map((a, i) => (
              <button
                key={i}
                className={a.variant === 'discard' ? 'btn-discard' : 'btn-save'}
                onClick={a.onClick}
                disabled={a.disabled}
              >{a.label}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function humanChannel(c) {
  if (c === 'in_person_paper') return 'paper'
  if (c === 'provider_override') return 'provider record'
  if (c === 'parent_portal') return 'portal'
  return c || ''
}

function subTypePayload(type) {
  if (type === ACK_TYPES.FIELD_TRIP_PERMISSION) {
    return { copyVersion: COPY_VERSIONS.field_trip_permission }
  }
  if (type === ACK_TYPES.PHOTO_SHARING_CONSENT) {
    return { copyVersion: COPY_VERSIONS.photo_sharing_consent }
  }
  if (type === ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED) {
    return { copyVersion: COPY_VERSIONS.photo_sharing_consent_revoked }
  }
  return {}
}
