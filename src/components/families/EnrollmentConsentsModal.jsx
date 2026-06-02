// PR Consents Phase A — provider-facing enrollment-consents modal.
//
// Sibling to ChildIntakeModal. Per pr-consents-A-scope.md § UX, this
// modal captures the enrollment-level consents that sit OUTSIDE the
// R 400.1907 intake bundle:
//
//   Phase A (sign-once, durable):
//     - FIELD_TRIP_PERMISSION    (R 400.1952(2), licensing-required)
//     - PHOTO_SHARING_CONSENT    (no rule, provider-protective,
//                                  revocable via _revoked pair)
//
//   Phase B (annual rolling expiry, added 2026-06-01):
//     - TRANSPORTATION_ROUTINE_ANNUAL          (R 400.1952(1)(a))
//     - WATER_ACTIVITIES_ON_PREMISES_SEASONAL  (R 400.1934(10)(b))
//
// Phase A scope (P3 — no parent-portal self-confirm):
//   - Channels: in_person_paper + provider_override ONLY.
//   - Recording is provider-driven. No new RPC.
//   - Photo revocation = archive active consent row + insert a
//     PHOTO_SHARING_CONSENT_REVOKED row.
//
// Phase B (added 2026-06-01) — renewal flow:
//   - On every Phase B capture (initial or renewal), set
//     `expires_at = acknowledged_at + interval '1 year'`. Same
//     formula for both Phase B types; the application is the source
//     of truth for the cadence (the migration adds no CHECK).
//   - Renewal = archive-then-insert in one provider-driven flow.
//     EARLY renewal archives the prior row immediately — no
//     coexistence period. The existing `archiveActiveOfType` helper
//     handles the archive step; the new insert sets the fresh
//     expires_at. This is also the only path that satisfies the
//     `acknowledgments_active_unique` partial-unique constraint when
//     a prior row exists (whether currently-valid or expired-but-
//     not-archived).
//
// Phase C (added 2026-06-01) — per-occurrence consents:
//   - Two new ACK_TYPES: TRANSPORTATION_NONROUTINE_PER_TRIP and
//     WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP. These are EVENT
//     RECORDS, not enrollment state — one acknowledgments row per
//     trip / outing. Multiple active rows per (provider, type,
//     child) are EXPECTED and permitted by the relaxed
//     `acknowledgments_active_unique` partial index (migration 027).
//   - No expires_at, no renewal concept. Each occurrence is one-and-
//     done; corrections via archive-then-insert (same shape as any
//     audit-trail correction).
//   - The row carries `occurrence_metadata jsonb` (trip date,
//     destination, water-body type, etc.) built through the helpers
//     in `src/lib/childFiles.js` — NEVER constructed inline here.
//   - The per-occurrence section renders below the durable
//     consents: a "Record …" button per type opens a sub-form, and
//     a recent-N list shows what's already on file.
//
// Standing copy rule (scope §d): until messaging-enforcement ships,
// revocation UI MUST NOT claim photo sharing has stopped. Word it as
// "preference recorded," not "sharing will stop."

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ShieldAlert, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  ACK_TYPES,
  computeAckHash,
  findActiveAck,
} from '@/lib/acknowledgments'
import {
  TIME_BOUND_TYPES,
  PER_OCCURRENCE_CONSENT_TYPES,
  WATER_BODY_TYPE_OPTIONS,
  buildTransportNonroutineOccurrenceMetadata,
  buildWaterOffPremisesOccurrenceMetadata,
  computePhaseBExpiresAt,
  partitionAcksByExpiry,
} from '@/lib/childFiles'

const COPY_VERSIONS = Object.freeze({
  field_trip_permission: 'v1',
  photo_sharing_consent: 'v1',
  photo_sharing_consent_revoked: 'v1',
  // Phase B (2026-06-01).
  transportation_routine_annual: 'v1',
  water_activities_on_premises_seasonal: 'v1',
  // Phase C (2026-06-01).
  transportation_nonroutine_per_trip: 'v1',
  water_activities_off_premises_per_trip: 'v1',
})

const TYPE_LABEL = Object.freeze({
  [ACK_TYPES.FIELD_TRIP_PERMISSION]: 'Field trip permission (non-vehicle)',
  [ACK_TYPES.PHOTO_SHARING_CONSENT]: 'Photo sharing consent',
  [ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]:         'Routine transportation (annual)',
  [ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]: 'On-premises water activities (annual)',
  // Phase C (2026-06-01) — per-occurrence.
  [ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP]:    'Non-routine transportation (per trip)',
  [ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP]: 'Off-premises water activity (per outing)',
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
  [ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]:
    'Required by Michigan rule R 400.1952(1)(a) — written parent ' +
    'permission for routine transportation, renewed at least annually. ' +
    '"Routine" means regularly scheduled travel on the same day of the ' +
    'week, at the same time, to the same destination (R 400.1901(1)(jj)). ' +
    'Any deviation is a nonroutine trip and needs its own per-trip ' +
    'permission — that path ships in a follow-up.',
  [ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]:
    'Required by Michigan rule R 400.1934(10)(b) — written parent ' +
    'permission for on-premises water activities, renewed once per ' +
    'season. Michigan has effectively one warm-months water season, ' +
    'so we renew this annually (each spring before the season starts).',
  // Phase C (2026-06-01) — per-occurrence. Each capture is a
  // standalone event record; no renewal, no expiry.
  [ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP]:
    'Required by Michigan rule R 400.1952(1)(b) — written parent ' +
    'permission BEFORE EACH non-routine trip. Per R 400.1901(1)(jj), ' +
    '"routine" means regularly scheduled travel on the same day of the ' +
    'week, at the same time, to the same destination — any deviation ' +
    'is non-routine. Capture one consent per trip; a new trip is a ' +
    'new record.',
  [ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP]:
    'Required by Michigan rule R 400.1934(10)(a) — written parent ' +
    'permission BEFORE EACH outdoor water activity at a swimming pool, ' +
    'lake, or other body of water OFF the child care home premises. ' +
    'Per R 400.1901(1)(yy), water-table play, slip-and-slide, wading ' +
    'pools, and playing in sprinklers DO NOT count as water activities ' +
    'under this rule — do not over-collect. Capture one consent per ' +
    'outing; a new outing is a new record.',
})

export default function EnrollmentConsentsModal({
  userId,                 // licensee's auth uid → provider_id
  child,
  primaryGuardianName,    // optional, prefills parent_label
  onClose,
  onSaved,
}) {
  // `acks` = every active (archived_at IS NULL) row for this child.
  // We partition into active vs expired in JS so the modal can show
  // "Expired YYYY-MM-DD — Renew" distinctly from "On file."
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
      // Select expires_at (Phase B, 2026-06-01) so we can show
      // renewal dates and detect expired rows.
      // Select occurrence_metadata (Phase C, 2026-06-01) so we can
      // render the per-occurrence recent-N list with trip / outing
      // details.
      const { data, error } = await supabase
        .from('acknowledgments')
        .select('id, type, subject_type, subject_id, snapshot_hash, archived_at, acknowledged_via, acknowledged_at, expires_at, occurrence_metadata')
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

  // Per-type state, computed from the loaded acks. Partition by
  // expiry first (Phase B) so we can distinguish on-file from
  // expired-needs-renewal.
  const state = useMemo(() => {
    const { activeAcks, expiredAcks } = partitionAcksByExpiry({ rows: acks })

    const fieldTrip = findActiveAck(activeAcks, {
      type: ACK_TYPES.FIELD_TRIP_PERMISSION,
      subjectType: 'child',
      subjectId: child.id,
    })
    const photoConsent = findActiveAck(activeAcks, {
      type: ACK_TYPES.PHOTO_SHARING_CONSENT,
      subjectType: 'child',
      subjectId: child.id,
    })
    const photoRevoked = findActiveAck(activeAcks, {
      type: ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED,
      subjectType: 'child',
      subjectId: child.id,
    })

    // Phase B per-type tri-state: on-file (currently valid), expired
    // (active row in DB sense but past expires_at), or unrecorded.
    function phaseBStateFor(type) {
      const valid = findActiveAck(activeAcks, {
        type, subjectType: 'child', subjectId: child.id,
      })
      if (valid) return { status: 'on_file', row: valid }
      const expired = findActiveAck(expiredAcks, {
        type, subjectType: 'child', subjectId: child.id,
      })
      if (expired) return { status: 'expired', row: expired }
      return { status: 'unrecorded', row: null }
    }
    const transport = phaseBStateFor(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)
    const waterOnPrem = phaseBStateFor(ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL)

    // Phase C (2026-06-01) — per-occurrence row lists. Multiple
    // active rows per (child, type) are EXPECTED here (one per trip
    // / outing). We list them most-recent-first via acknowledged_at;
    // the recent-N view limit is applied at render time.
    function perOccurrenceListFor(type) {
      const list = activeAcks.filter(a =>
        a.type === type
        && a.subject_type === 'child'
        && a.subject_id === child.id
      )
      list.sort((a, b) => {
        const aMs = Date.parse(a.acknowledged_at || '') || 0
        const bMs = Date.parse(b.acknowledged_at || '') || 0
        return bMs - aMs   // newest first
      })
      return list
    }
    const transportNonroutineList = perOccurrenceListFor(ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP)
    const waterOffPremList = perOccurrenceListFor(ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP)

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
      transport,
      waterOnPrem,
      transportNonroutineList,
      waterOffPremList,
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
    // Archive every active (archived_at IS NULL) row of this type for
    // the child, regardless of expires_at. The partial unique index
    // considers an expired-but-not-archived row "active" — we must
    // archive it before insert or the new row violates the constraint.
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
      // partial unique index allows the new insert. This is also the
      // renewal step for Phase B types (early renewal archives the
      // prior row immediately — no coexistence period).
      await archiveActiveOfType(type)
      // For photo CONSENT: also archive any active REVOKED row (a
      // re-consent overrides a prior revocation). Symmetric on the
      // revoke side.
      if (type === ACK_TYPES.PHOTO_SHARING_CONSENT) {
        await archiveActiveOfType(ACK_TYPES.PHOTO_SHARING_CONSENT_REVOKED)
      }

      const payload = subTypePayload(type)
      const snapshot_hash = computeAckHash({ type, payload })
      const acknowledgedAtIso = new Date().toISOString()

      // Phase B (2026-06-01): set expires_at = acknowledged_at + 1 year
      // for time-bound types. All other types leave it NULL.
      const expires_at = TIME_BOUND_TYPES.includes(type)
        ? computePhaseBExpiresAt(acknowledgedAtIso)
        : null

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert([{
          ...buildSharedFields(),
          type,
          acknowledged_at: acknowledgedAtIso,
          expires_at,
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

  /**
   * Phase C (2026-06-01) — record a per-occurrence consent row.
   *
   * Differences from `recordOne`:
   *  - NO archiveActiveOfType — multiple active rows per
   *    (child, type) are EXPECTED for per-occurrence types and
   *    permitted by the relaxed `acknowledgments_active_unique`
   *    partial index (migration 027). A new trip is a NEW row.
   *  - The `occurrence_metadata` jsonb is built through the per-type
   *    helper exported from `src/lib/childFiles.js` — NEVER inline.
   *    If the helper throws (missing required fields, invalid enum)
   *    the error surfaces through the modal's standard error path.
   *  - No expires_at — per-occurrence consents are durable event
   *    records, not time-bound.
   */
  async function recordOccurrence(type, metadataInput) {
    if (!channelValid || saving) return
    setSaving(true)
    setError(null)
    try {
      // Build the canonical jsonb shape via the helper. Throws on
      // missing required fields; the modal surfaces the error.
      let occurrence_metadata
      if (type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP) {
        occurrence_metadata = buildTransportNonroutineOccurrenceMetadata(metadataInput)
      } else if (type === ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP) {
        occurrence_metadata = buildWaterOffPremisesOccurrenceMetadata(metadataInput)
      } else {
        throw new Error(`recordOccurrence: unknown per-occurrence type "${type}"`)
      }

      const payload = subTypePayload(type)
      const snapshot_hash = computeAckHash({ type, payload })
      const acknowledgedAtIso = new Date().toISOString()

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert([{
          ...buildSharedFields(),
          type,
          acknowledged_at: acknowledgedAtIso,
          expires_at: null,
          occurrence_metadata,
          snapshot_hash,
          snapshot_version: COPY_VERSIONS[type] || null,
        }])
      if (insertErr) throw insertErr

      // Refresh the loaded acks in place — the per-occurrence
      // recent-N list needs to reflect the new row WITHOUT closing
      // the modal (provider may want to record another trip).
      const { data: refreshed } = await supabase
        .from('acknowledgments')
        .select('id, type, subject_type, subject_id, snapshot_hash, archived_at, acknowledged_via, acknowledged_at, expires_at, occurrence_metadata')
        .eq('provider_id', userId)
        .eq('subject_type', 'child')
        .eq('subject_id', child.id)
        .is('archived_at', null)
      setAcks(Array.isArray(refreshed) ? refreshed : [])

      onSaved?.()
      // Deliberately do NOT call onClose() here — per-occurrence
      // recording is iterative; the provider may want to capture
      // multiple in one sitting.
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

                {/* Phase B (2026-06-01) — time-bound recurring consents.
                    Each renders one of three states: on-file (with
                    renewal date), expired (with original-capture and
                    expired-on dates, "Renew" button), or not-recorded
                    ("Record" button). */}
                <PhaseBConsentRow
                  type={ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL}
                  state={state.transport}
                  help={TYPE_HELP[ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL]}
                  saving={saving}
                  channelValid={channelValid}
                  onRecord={() => recordOne(ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL)}
                />
                <PhaseBConsentRow
                  type={ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL}
                  state={state.waterOnPrem}
                  help={TYPE_HELP[ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL]}
                  saving={saving}
                  channelValid={channelValid}
                  onRecord={() => recordOne(ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL)}
                />
              </section>

              {/* Phase C (2026-06-01) — per-occurrence event consents.
                  Capture one row per trip / outing; multiple active
                  rows for the same child are EXPECTED. No renewal,
                  no expiry — corrections via archive-then-insert
                  (handled outside this UI). */}
              <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h3 style={{ fontSize: '1rem', margin: 0 }}>Per-trip and per-outing consents</h3>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.45 }}>
                  These are event records — one consent per trip / outing.
                  Capture a new consent for each occurrence; previous trips
                  remain on file as the audit trail.
                </p>
                <PerOccurrenceSection
                  type={ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP}
                  list={state.transportNonroutineList}
                  help={TYPE_HELP[ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP]}
                  saving={saving}
                  channelValid={channelValid}
                  onRecord={(metadata) => recordOccurrence(
                    ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP,
                    metadata,
                  )}
                />
                <PerOccurrenceSection
                  type={ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP}
                  list={state.waterOffPremList}
                  help={TYPE_HELP[ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP]}
                  saving={saving}
                  channelValid={channelValid}
                  onRecord={(metadata) => recordOccurrence(
                    ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP,
                    metadata,
                  )}
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

/**
 * Phase B row — same visual layout as ConsentRow, but with the
 * three-way state machine: on-file → "Renews YYYY-MM-DD", expired →
 * "Expired YYYY-MM-DD" + "Renew" button, unrecorded → "Not recorded"
 * + "Record" button. Renewal uses the SAME onRecord path as initial
 * capture — the archive-then-insert flow handles the prior-row
 * archive automatically, and the new row sets a fresh expires_at.
 */
function PhaseBConsentRow({ type, state, help, saving, channelValid, onRecord }) {
  const { status, row } = state
  const label = TYPE_LABEL[type]
  const channel = row?.acknowledged_via || null

  let icon, badge, badgeKind, footnote = null, actionLabel
  if (status === 'on_file') {
    icon = CheckCircle2
    badge = row?.expires_at
      ? `On file — renews ${formatDate(row.expires_at)} (${humanChannel(channel)})`
      : `On file (${humanChannel(channel)})`
    badgeKind = 'ok'
    actionLabel = 'Re-record'
  } else if (status === 'expired') {
    icon = ShieldAlert
    badge = row?.expires_at
      ? `Expired ${formatDate(row.expires_at)}`
      : 'Expired'
    badgeKind = 'pending'
    footnote = row?.acknowledged_at
      ? `Originally captured ${formatDate(row.acknowledged_at)} via ${humanChannel(channel)}. ` +
        'Renewing now captures a fresh signature and resets the annual clock — ' +
        'the prior row archives automatically.'
      : null
    actionLabel = 'Renew'
  } else {
    icon = ShieldAlert
    badge = 'Not recorded'
    badgeKind = 'pending'
    actionLabel = 'Record'
  }

  return (
    <ConsentRow
      icon={icon}
      title={label}
      badge={badge}
      badgeKind={badgeKind}
      help={help}
      footnote={footnote}
      actions={[
        {
          label: actionLabel,
          onClick: onRecord,
          disabled: saving || !channelValid,
        },
      ]}
    />
  )
}

/**
 * Phase C (2026-06-01) — per-occurrence consent section.
 *
 * Renders: type label + help copy, recent-N list of recorded
 * occurrences (newest first), and an expandable sub-form to capture
 * a new occurrence. Multiple active rows for the same child are
 * EXPECTED (one per trip / outing) — there is no "on file" /
 * "expired" / "unrecorded" state machine; the list itself IS the
 * state.
 *
 * The sub-form's field set differs per type (transport vs water),
 * but both go through the same metadata-helper validation in
 * `recordOccurrence`. Submission keeps the modal open so the
 * provider can capture multiple in sequence.
 */
function PerOccurrenceSection({ type, list, help, saving, channelValid, onRecord }) {
  const [open, setOpen] = useState(false)
  const [fieldErrors, setFieldErrors] = useState(null)
  const isTransport = type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP
  const label = TYPE_LABEL[type]
  const recentLimit = 5
  const recent = (list || []).slice(0, recentLimit)
  const remainder = Math.max(0, (list?.length || 0) - recentLimit)

  // Transport form state.
  const [tripDate, setTripDate] = useState('')
  const [destination, setDestination] = useState('')
  const [purpose, setPurpose] = useState('')
  const [vehicleDescription, setVehicleDescription] = useState('')

  // Water form state.
  const [outingDate, setOutingDate] = useState('')
  const [waterBodyType, setWaterBodyType] = useState('pool')
  const [location, setLocation] = useState('')
  const [address, setAddress] = useState('')
  const [supervisingAdult, setSupervisingAdult] = useState('')

  function resetForm() {
    setTripDate(''); setDestination(''); setPurpose(''); setVehicleDescription('')
    setOutingDate(''); setWaterBodyType('pool'); setLocation('')
    setAddress(''); setSupervisingAdult('')
    setFieldErrors(null)
  }

  async function handleSubmit() {
    setFieldErrors(null)
    try {
      const metadata = isTransport
        ? { trip_date: tripDate, destination, purpose, vehicle_description: vehicleDescription }
        : { outing_date: outingDate, water_body_type: waterBodyType, location, address, supervising_adult: supervisingAdult }
      await onRecord(metadata)
      resetForm()
      setOpen(false)
    } catch (err) {
      // The helper throws on missing required fields; surface the
      // message inline so the provider knows which field to fix.
      setFieldErrors(err.message || String(err))
    }
  }

  return (
    <div style={{
      padding: 12,
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-md)',
      background: 'white',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: '0.9375rem' }}>{label}</strong>
        <span style={{
          background: 'var(--clr-cream)',
          color: 'var(--clr-ink-mid)',
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          fontSize: '0.6875rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
        }}>{list.length} recorded</span>
      </div>
      <p style={{ margin: 0, color: 'var(--clr-ink-soft)', fontSize: '0.8125rem', lineHeight: 1.45 }}>
        {help}
      </p>

      {/* Recent-N list */}
      {recent.length > 0 && (
        <ul style={{
          margin: '10px 0 0 0',
          padding: 0,
          listStyle: 'none',
          fontSize: '0.8125rem',
          color: 'var(--clr-ink-mid)',
        }}>
          {recent.map(row => (
            <li key={row.id} style={{
              padding: '6px 0',
              borderTop: '1px solid var(--clr-warm-mid)',
            }}>
              {formatOccurrenceLine(row)}
            </li>
          ))}
          {remainder > 0 && (
            <li style={{
              padding: '6px 0',
              borderTop: '1px solid var(--clr-warm-mid)',
              fontStyle: 'italic',
              color: 'var(--clr-ink-soft)',
            }}>
              + {remainder} earlier record{remainder === 1 ? '' : 's'} on file
            </li>
          )}
        </ul>
      )}

      {/* Sub-form */}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {!open && (
          <button
            className="btn-save"
            onClick={() => setOpen(true)}
            disabled={saving || !channelValid}
            type="button"
          >Record {isTransport ? 'a trip' : 'an outing'}</button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 12, padding: 10, border: '1px dashed var(--clr-warm-mid)', borderRadius: 'var(--radius-md)' }}>
          {isTransport ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: '0.8125rem' }}>
                Trip date <span style={{ color: 'var(--clr-danger)' }}>*</span>
                <input
                  type="date"
                  value={tripDate}
                  onChange={e => setTripDate(e.target.value)}
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Destination <span style={{ color: 'var(--clr-danger)' }}>*</span>
                <input
                  type="text"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                  placeholder="e.g., Public library"
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Purpose <span style={{ color: 'var(--clr-ink-soft)' }}>(optional)</span>
                <input
                  type="text"
                  value={purpose}
                  onChange={e => setPurpose(e.target.value)}
                  placeholder="e.g., Story time"
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Vehicle description <span style={{ color: 'var(--clr-ink-soft)' }}>(optional)</span>
                <input
                  type="text"
                  value={vehicleDescription}
                  onChange={e => setVehicleDescription(e.target.value)}
                  placeholder="e.g., Provider's minivan"
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: '0.8125rem' }}>
                Outing date <span style={{ color: 'var(--clr-danger)' }}>*</span>
                <input
                  type="date"
                  value={outingDate}
                  onChange={e => setOutingDate(e.target.value)}
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Water body type <span style={{ color: 'var(--clr-danger)' }}>*</span>
                <select
                  value={waterBodyType}
                  onChange={e => setWaterBodyType(e.target.value)}
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                >
                  {WATER_BODY_TYPE_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Location / venue <span style={{ color: 'var(--clr-danger)' }}>*</span>
                <input
                  type="text"
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  placeholder="e.g., Springfield Community Pool"
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Address <span style={{ color: 'var(--clr-ink-soft)' }}>(optional)</span>
                <input
                  type="text"
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ fontSize: '0.8125rem' }}>
                Supervising adult <span style={{ color: 'var(--clr-ink-soft)' }}>(optional)</span>
                <input
                  type="text"
                  value={supervisingAdult}
                  onChange={e => setSupervisingAdult(e.target.value)}
                  style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
                />
              </label>
            </div>
          )}
          {fieldErrors && (
            <div role="alert" style={{ marginTop: 8, color: 'var(--clr-danger)', fontSize: '0.8125rem' }}>
              <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              {fieldErrors}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <button
              className="btn-discard"
              onClick={() => { resetForm(); setOpen(false) }}
              disabled={saving}
              type="button"
            >Cancel</button>
            <button
              className="btn-save"
              onClick={handleSubmit}
              disabled={saving || !channelValid}
              type="button"
            >Save</button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Render one occurrence as a single-line summary for the recent-N
 * list. Reads from `occurrence_metadata` per type; falls back to the
 * recording date if the metadata is missing (defensive — pre-Phase-C
 * rows have NULL metadata).
 */
function formatOccurrenceLine(row) {
  const m = row.occurrence_metadata || {}
  if (row.type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP) {
    const date = m.trip_date ? formatDate(m.trip_date) : '(date missing)'
    const dest = m.destination || '(destination missing)'
    const channelLabel = humanChannel(row.acknowledged_via)
    return `${date} — ${dest} (${channelLabel})`
  }
  if (row.type === ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP) {
    const date = m.outing_date ? formatDate(m.outing_date) : '(date missing)'
    const body = m.water_body_type || '(water body type missing)'
    const loc = m.location || '(location missing)'
    const channelLabel = humanChannel(row.acknowledged_via)
    return `${date} — ${body} at ${loc} (${channelLabel})`
  }
  return `Recorded ${formatDate(row.acknowledged_at)}`
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

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return ''
  }
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
  if (type === ACK_TYPES.TRANSPORTATION_ROUTINE_ANNUAL) {
    return { copyVersion: COPY_VERSIONS.transportation_routine_annual }
  }
  if (type === ACK_TYPES.WATER_ACTIVITIES_ON_PREMISES_SEASONAL) {
    return { copyVersion: COPY_VERSIONS.water_activities_on_premises_seasonal }
  }
  if (type === ACK_TYPES.TRANSPORTATION_NONROUTINE_PER_TRIP) {
    return { copyVersion: COPY_VERSIONS.transportation_nonroutine_per_trip }
  }
  if (type === ACK_TYPES.WATER_ACTIVITIES_OFF_PREMISES_PER_TRIP) {
    return { copyVersion: COPY_VERSIONS.water_activities_off_premises_per_trip }
  }
  return {}
}

