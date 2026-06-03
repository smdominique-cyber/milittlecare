// PR #20 — Medication administration modal (R 400.1931).
//
// Sibling to EnrollmentConsentsModal. Per docs/pr-20-medication-log-scope.md
// (reconciled against verbatim rule text 2026-06-02), this modal hosts
// the four medication flows over the data-layer helpers in
// `src/lib/medication.js`:
//
//   1. Authorization create / archive — per child × medication.
//   2. Parent permission capture — TWO ACK_TYPES via the existing
//      acknowledgments engine:
//        - `medication_permission`            (per non-OTC authorization,
//                                              subject_type='medication_authorization')
//        - `medication_permission_otc_blanket` (per child;
//                                              covers all topical OTC
//                                              per (8)'s NON-exemption
//                                              from subrule (2)).
//   3. Dose-log entry — one row per administered or applied dose.
//      The caregiver picker is GATED to eligible roles for non-OTC
//      authorizations (R 400.1931(1) — only licensee / staff_member);
//      for topical OTC (R 400.1931(8) exempt) any caregiver is
//      selectable. The DB trigger remains the authoritative guard;
//      this is the UI-side mirror so the provider doesn't hit the
//      trigger error in normal use.
//   4. Allergy display — surfaces children.allergies (free text)
//      prominently at the top of the modal per scope OQ4. No schema
//      change; pulls from the existing column.
//
// EVERY DB WRITE goes through `src/lib/medication.js` helpers. NO
// inline Supabase mutations — the helpers own the row shape, the
// archive-then-insert protocol, the snapshot_hash drift detection,
// and the role-gate UX mirror. If you find yourself reaching for
// `supabase.from(...)` here, add a helper to medication.js instead.
//
// Channel rule: parent_portal / in_person_paper SATISFY the parent-
// signed rule (consent surfaces as "on file" in the audit-state);
// provider_override is captured in the audit trail but does NOT
// satisfy. Mirrors EnrollmentConsentsModal's three-channel UI.

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Pill, ShieldAlert, X } from 'lucide-react'
import ConsentAttachmentSlot from '@/components/families/ConsentAttachmentSlot'
import {
  ELIGIBLE_ADMINISTERING_ROLES,
  archiveDoseEvent,
  archiveMedicationAuthorization,
  createMedicationAuthorization,
  eligibleCaregiversForAdministration,
  getDoseLogState,
  isTopicalOtcExempt,
  listActiveAuthorizationsForChild,
  listActiveEventsForAuthorization,
  listCaregiversWithRoles,
  listMedicationConsentsForChild,
  medicationConsentSatisfied,
  recordDoseEvent,
  recordMedicationPermission,
  recordOtcBlanketPermission,
} from '@/lib/medication'

const ALL_OTC_NOTE =
  'Topical OTC (sunscreen, insect repellent, diaper rash cream and ' +
  'similar) is covered by R 400.1931(8): exempt from the role-gate ' +
  '(any caregiver may apply) and exempt from the per-dose log ' +
  '(logging is optional). Parent permission is STILL required — that\'s ' +
  'the OTC-blanket consent below.'

const NON_OTC_NOTE =
  'Prescription medication and oral OTC (e.g., children\'s Tylenol) ' +
  'are subject to R 400.1931(1): only licensee or child care staff ' +
  'member may administer; date/time/amount of each dose must be ' +
  'logged; written parent permission required per medication.'

export default function MedicationModal({
  userId,                 // licensee's auth uid → provider_id
  child,
  primaryGuardianName,    // optional, prefills parent_label
  onClose,
  onSaved,
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Loaded state.
  const [authorizations, setAuthorizations] = useState([])
  const [eventsByAuth, setEventsByAuth] = useState({})         // { authId → events[] }
  const [caregivers, setCaregivers] = useState([])             // with regulatory_roles[] attached
  const [otcBlanketAck, setOtcBlanketAck] = useState(null)
  const [perAuthAckById, setPerAuthAckById] = useState({})     // { authId → ack }

  // Channel chooser state (shared with consent capture).
  const [channel, setChannel] = useState('in_person_paper')
  const [parentLabel, setParentLabel] = useState(primaryGuardianName || '')
  const [providerReason, setProviderReason] = useState(
    'Captured at medication intake; parent acknowledged in person.'
  )

  // Sub-form toggles.
  const [addAuthOpen, setAddAuthOpen] = useState(false)

  // Inline success confirmation per save (2026-06-02 fix-forward —
  // medication records are unsettling without an explicit ✓; the
  // earlier silent-refresh UX invited double-logging or distrust of
  // the record). Single `{ key, text }` slot — each save path sets
  // its own key so the right card renders the message near the
  // right control. Cleared by a 3-second timer or by the next save
  // (a fresh setSuccessMessage replaces the prior one). Errors are
  // surfaced through the existing `error` state — this is the
  // positive-confirmation counterpart and uses the same visual
  // tokens as the on-file badges (sage-pale background, sage-dark
  // text, CheckCircle2 icon) so the visual language stays one.
  const [successMessage, setSuccessMessage] = useState(null)

  useEffect(() => {
    if (!successMessage) return undefined
    const t = setTimeout(() => setSuccessMessage(null), 3000)
    return () => clearTimeout(t)
  }, [successMessage])

  function showSuccess(key, text) {
    setSuccessMessage({ key, text })
  }

  const channelValid = useMemo(() => {
    if (channel === 'in_person_paper')  return parentLabel.trim().length > 0
    if (channel === 'provider_override') return providerReason.trim().length > 0
    if (channel === 'parent_portal')    return true
    return false
  }, [channel, parentLabel, providerReason])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const authsResp = await listActiveAuthorizationsForChild({
          providerId: userId, childId: child.id,
        })
        if (cancelled) return
        if (authsResp.error) throw authsResp.error
        const auths = authsResp.data || []

        // Parallel: events for each auth + caregivers + consents.
        const eventsList = await Promise.all(auths.map(a =>
          listActiveEventsForAuthorization({ authorizationId: a.id, limit: 10 })
        ))
        const caregiversResp = await listCaregiversWithRoles({ licenseeId: userId })
        const consentsResp = await listMedicationConsentsForChild({
          providerId: userId,
          childId: child.id,
          authorizationIds: auths.map(a => a.id),
        })
        if (cancelled) return
        if (caregiversResp.error) throw caregiversResp.error
        if (consentsResp.error) throw consentsResp.error

        const evMap = {}
        auths.forEach((a, i) => {
          evMap[a.id] = (eventsList[i] && eventsList[i].data) || []
        })

        setAuthorizations(auths)
        setEventsByAuth(evMap)
        setCaregivers(caregiversResp.data || [])
        setOtcBlanketAck(consentsResp.data.otcBlanket || null)
        setPerAuthAckById(consentsResp.data.perAuthorization || {})
        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err)
          setLoading(false)
        }
      }
    }
    if (child && userId) load()
    return () => { cancelled = true }
  }, [child, userId])

  async function refresh() {
    // Reload everything — cheap on the small per-child set.
    const authsResp = await listActiveAuthorizationsForChild({
      providerId: userId, childId: child.id,
    })
    const auths = authsResp.data || []
    const eventsList = await Promise.all(auths.map(a =>
      listActiveEventsForAuthorization({ authorizationId: a.id, limit: 10 })
    ))
    const consentsResp = await listMedicationConsentsForChild({
      providerId: userId, childId: child.id,
      authorizationIds: auths.map(a => a.id),
    })
    const evMap = {}
    auths.forEach((a, i) => {
      evMap[a.id] = (eventsList[i] && eventsList[i].data) || []
    })
    setAuthorizations(auths)
    setEventsByAuth(evMap)
    setOtcBlanketAck(consentsResp.data?.otcBlanket || null)
    setPerAuthAckById(consentsResp.data?.perAuthorization || {})
    // 2026-06-02 fix: deliberately DO NOT call `onSaved?.()` here.
    //
    // Calling it triggers the parent's `loadAll()` (via FamiliesPage's
    // `onChange={loadAll}` chain), which sets the parent's `loading`
    // state to true. The parent's render then short-circuits to a
    // spinner, unmounting FamilyDetailModal, ChildrenTab, AND THIS
    // MODAL along with them. When the spinner clears, the parent
    // remounts FamilyDetailModal → ChildrenTab, but `medicationTarget`
    // (ChildrenTab-local state) is fresh-null on remount, so this
    // modal does NOT come back. The provider perceives this as
    // "saving the dose closed the modal" — and the inline ✓
    // confirmation never paints because the modal is gone.
    //
    // The parent's data fetch (families/children/guardians/emergency/
    // profile) has nothing to do with the medication tables, so the
    // parent doesn't actually need the refetch on a medication save.
    // The modal's own internal state (set above) is the only thing
    // that needs to be current.
    //
    // The `onSaved` prop is still accepted for API symmetry with
    // sibling modals; a future feature that wants to notify the
    // parent (e.g., a per-child medication-count badge in the family
    // tree) can re-introduce the call at a non-destructive moment
    // (e.g., from `onClose`). NOT here — here it eats the modal.
  }

  // ─── Authorization create ───────────────────────────────────────

  async function handleCreateAuthorization(fields) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await createMedicationAuthorization({
        providerId: userId, childId: child.id, fields,
      })
      if (e) throw e
      setAddAuthOpen(false)
      await refresh()
      showSuccess('auth-create', '✓ Medication saved')
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  // ─── Authorization archive ──────────────────────────────────────

  async function handleArchiveAuthorization(authorizationId) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await archiveMedicationAuthorization({ authorizationId })
      if (e) throw e
      await refresh()
      // Archive is destructive — the card disappears from the list,
      // which is itself confirmation. We still surface a brief ✓ at
      // the list level so the provider can tell the action took.
      showSuccess('auth-create', '✓ Medication archived')
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  // ─── Parent permission capture ──────────────────────────────────

  async function handleRecordPerAuthConsent(authorization) {
    if (saving || !channelValid) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await recordMedicationPermission({
        providerId: userId,
        authorization,
        channel,
        parentLabel,
        providerReason,
      })
      if (e) throw e
      await refresh()
      // Key is per-authorization so the ✓ lands in the right card.
      showSuccess(`consent-per-auth:${authorization.id}`, '✓ Consent recorded')
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  async function handleRecordOtcBlanket() {
    if (saving || !channelValid) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await recordOtcBlanketPermission({
        providerId: userId,
        childId: child.id,
        channel,
        parentLabel,
        providerReason,
      })
      if (e) throw e
      await refresh()
      showSuccess('consent-otc-blanket', '✓ Consent recorded')
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  // ─── Dose-log entry ────────────────────────────────────────────

  async function handleRecordDose(authorization, { administeredAt, doseText, caregiverId, notes }) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await recordDoseEvent({
        providerId: userId,
        authorizationId: authorization.id,
        childId: child.id,
        administeredByCaregiverId: caregiverId,
        administeredAt,
        doseAdministeredText: doseText,
        notes,
      })
      if (e) throw e
      await refresh()
      // Per-authorization key — ✓ lands on the right card's dose
      // section, near where the recent-doses list just gained a row.
      showSuccess(`dose:${authorization.id}`, '✓ Dose recorded')
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  async function handleArchiveDose(eventId) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await archiveDoseEvent({ eventId })
      if (e) throw e
      await refresh()
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
        style={{ maxWidth: 720, width: '95%', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div
          className="modal-header"
          style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}
        >
          <span className="modal-title">
            Medication for {child.first_name}
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close medication form"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Allergies banner (scope OQ4). children.allergies is the
              existing free-text column — no schema change. */}
          {child.allergies && child.allergies.trim().length > 0 && (
            <div
              role="alert"
              data-testid="med-allergy-banner"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: 12, borderRadius: 'var(--radius-md)',
                background: 'var(--clr-amber-pale, #fdf3d8)',
                border: '1px solid var(--clr-amber, #8a6a1a)',
                color: 'var(--clr-amber, #8a6a1a)',
              }}
            >
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
              <div>
                <strong style={{ fontSize: '0.875rem' }}>Allergies on file</strong>
                <div style={{ marginTop: 2, fontSize: '0.875rem', lineHeight: 1.45 }}>
                  {child.allergies}
                </div>
              </div>
            </div>
          )}

          <p style={{ margin: 0, color: 'var(--clr-ink-mid)', fontSize: '0.875rem', lineHeight: 1.5 }}>
            Record this child&apos;s medication plan and dose log. Per Michigan
            rule R 400.1931 — prescription and oral OTC require the role-gate
            and per-dose log; topical OTC (sunscreen, repellent, diaper rash
            cream) is exempt from both per subrule (8) but still needs the
            blanket parent permission below.
          </p>

          {/* OTC-blanket consent card — always shown, one per child. */}
          <OtcBlanketCard
            ack={otcBlanketAck}
            channelValid={channelValid}
            saving={saving}
            onRecord={handleRecordOtcBlanket}
            successText={successMessage?.key === 'consent-otc-blanket' ? successMessage.text : null}
            userId={userId}
          />

          {loading ? (
            <p>Loading medication records…</p>
          ) : (
            <>
              <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3 style={{ fontSize: '1rem', margin: 0 }}>Active medications</h3>
                    {successMessage?.key === 'auth-create' && (
                      <SuccessChip text={successMessage.text} />
                    )}
                  </div>
                  {!addAuthOpen && (
                    <button
                      className="btn-save"
                      onClick={() => setAddAuthOpen(true)}
                      disabled={saving}
                      type="button"
                    >
                      Add medication
                    </button>
                  )}
                </div>

                {addAuthOpen && (
                  <AuthorizationForm
                    saving={saving}
                    onCancel={() => setAddAuthOpen(false)}
                    onSubmit={handleCreateAuthorization}
                  />
                )}

                {authorizations.length === 0 && !addAuthOpen && (
                  <p style={{ margin: 0, color: 'var(--clr-ink-soft)', fontSize: '0.875rem' }}>
                    No active medications on file.
                  </p>
                )}

                {authorizations.map(auth => (
                  <AuthorizationCard
                    key={auth.id}
                    authorization={auth}
                    events={eventsByAuth[auth.id] || []}
                    perAuthAck={perAuthAckById[auth.id] || null}
                    otcBlanketAck={otcBlanketAck}
                    caregivers={caregivers}
                    channelValid={channelValid}
                    saving={saving}
                    onRecordConsent={() => handleRecordPerAuthConsent(auth)}
                    onArchive={() => handleArchiveAuthorization(auth.id)}
                    onRecordDose={(fields) => handleRecordDose(auth, fields)}
                    onArchiveDose={handleArchiveDose}
                    userId={userId}
                    consentSuccessText={
                      successMessage?.key === `consent-per-auth:${auth.id}`
                        ? successMessage.text : null
                    }
                    doseSuccessText={
                      successMessage?.key === `dose:${auth.id}`
                        ? successMessage.text : null
                    }
                  />
                ))}
              </section>

              <ChannelChooser
                channel={channel}
                setChannel={setChannel}
                parentLabel={parentLabel}
                setParentLabel={setParentLabel}
                providerReason={providerReason}
                setProviderReason={setProviderReason}
              />

              {error && (
                <div role="alert" style={{ color: 'var(--clr-danger)', fontSize: '0.875rem' }}>
                  <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  {error.message || String(error)}
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

// ─── OTC-blanket consent card ──────────────────────────────────────

function OtcBlanketCard({ ack, channelValid, saving, onRecord, successText, userId }) {
  const onFile = !!(ack && !ack.archived_at &&
    (ack.acknowledged_via === 'parent_portal' || ack.acknowledged_via === 'in_person_paper'))
  const recordedNonSatisfying = !!(ack && !ack.archived_at && !onFile)

  return (
    <div
      data-testid="otc-blanket-card"
      style={{
        padding: 12, border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)', background: 'white',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: '0.9375rem' }}>Topical OTC blanket permission</strong>
        <span style={{
          background: onFile ? 'var(--clr-sage-pale, #e6efe7)' : 'var(--clr-amber-pale, #fdf3d8)',
          color:      onFile ? 'var(--clr-sage-dark)'         : 'var(--clr-amber, #8a6a1a)',
          padding: '2px 8px', borderRadius: 'var(--radius-full)',
          fontSize: '0.6875rem', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.02em', whiteSpace: 'nowrap',
        }}>{onFile ? 'On file' : recordedNonSatisfying ? 'Provider record only' : 'Not on file'}</span>
      </div>
      <p style={{ margin: 0, color: 'var(--clr-ink-soft)', fontSize: '0.8125rem', lineHeight: 1.45 }}>
        {ALL_OTC_NOTE}
      </p>
      {recordedNonSatisfying && (
        <p style={{ margin: '6px 0 0 0', color: 'var(--clr-ink-mid)', fontSize: '0.75rem', fontStyle: 'italic', lineHeight: 1.4 }}>
          Recorded via provider-override only — the audit-state pending
          count is NOT cleared until the parent signs (paper or portal).
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          className="btn-save"
          onClick={onRecord}
          disabled={saving || !channelValid}
          type="button"
        >
          {onFile || recordedNonSatisfying ? 'Re-record consent' : 'Record consent'}
        </button>
        {successText && <SuccessChip text={successText} />}
      </div>
      {/* PR consent-attachments Part 2 — attach scan of the signed
          OTC-blanket form. The ack row must exist (id present);
          target_type='acknowledgment' because the consent itself
          lives in `acknowledgments` (per PR #20 + the consent-
          attachments scope). The OTC-blanket ack covers every
          topical OTC on this child collectively. */}
      {ack?.id && userId && (
        <ConsentAttachmentSlot
          mode="provider"
          providerUserId={userId}
          targetType="acknowledgment"
          targetId={ack.id}
        />
      )}
    </div>
  )
}

// ─── Authorization card (per medication) ───────────────────────────

function AuthorizationCard({
  authorization, events, perAuthAck, otcBlanketAck,
  caregivers, channelValid, saving,
  onRecordConsent, onArchive, onRecordDose, onArchiveDose,
  consentSuccessText, doseSuccessText, userId,
}) {
  const isOtc = isTopicalOtcExempt(authorization)
  const state = getDoseLogState({
    authorization, events,
    activePermissionAck: isOtc ? otcBlanketAck : perAuthAck,
  })
  const consentSatisfied = medicationConsentSatisfied({
    authorization, perAuthAck, otcBlanketAck,
  })
  const [doseOpen, setDoseOpen] = useState(false)

  return (
    <div
      data-testid="authorization-card"
      data-is-topical-otc={isOtc ? 'true' : 'false'}
      style={{
        padding: 12, border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)', background: 'white',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Pill size={18} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
            <strong style={{ fontSize: '0.9375rem' }}>{authorization.medication_name}</strong>
            <span
              data-testid="otc-badge"
              style={{
                background: isOtc ? 'var(--clr-cream)' : 'var(--clr-sage-pale, #e6efe7)',
                color:      isOtc ? 'var(--clr-ink-mid)' : 'var(--clr-sage-dark)',
                padding: '2px 8px', borderRadius: 'var(--radius-full)',
                fontSize: '0.6875rem', fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.02em', whiteSpace: 'nowrap',
              }}
            >{isOtc ? 'Topical OTC' : 'Prescription / oral'}</span>
          </div>
          {authorization.dose_text && (
            <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.8125rem' }}>
              <strong>Dose:</strong> {authorization.dose_text}
            </div>
          )}
          {authorization.schedule_text && (
            <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.8125rem' }}>
              <strong>Schedule:</strong> {authorization.schedule_text}
            </div>
          )}
          {authorization.prescriber_name && (
            <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.8125rem' }}>
              <strong>Prescriber:</strong> {authorization.prescriber_name}
            </div>
          )}
          {(authorization.starts_on || authorization.ends_on) && (
            <div style={{ color: 'var(--clr-ink-mid)', fontSize: '0.8125rem' }}>
              <strong>Active:</strong>{' '}
              {authorization.starts_on || '(no start)'} → {authorization.ends_on || 'ongoing'}
            </div>
          )}
          {authorization.original_container_confirmed && (
            <div style={{ color: 'var(--clr-sage-dark)', fontSize: '0.8125rem', marginTop: 2 }}>
              ✓ Original container confirmed (R 400.1931(4))
            </div>
          )}
          <p style={{ margin: '6px 0 0 0', color: 'var(--clr-ink-soft)', fontSize: '0.75rem', fontStyle: 'italic' }}>
            {isOtc ? 'R 400.1931(8) — role-gate exempt; per-dose log optional.'
                   : NON_OTC_NOTE}
          </p>

          {/* Consent status row */}
          <div
            data-testid="consent-status"
            data-on-file={consentSatisfied ? 'true' : 'false'}
            style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
          >
            <span style={{
              background: consentSatisfied ? 'var(--clr-sage-pale, #e6efe7)' : 'var(--clr-amber-pale, #fdf3d8)',
              color:      consentSatisfied ? 'var(--clr-sage-dark)'         : 'var(--clr-amber, #8a6a1a)',
              padding: '2px 8px', borderRadius: 'var(--radius-full)',
              fontSize: '0.6875rem', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.02em', whiteSpace: 'nowrap',
            }}>
              {consentSatisfied ? 'Consent on file' : (isOtc ? 'Needs OTC-blanket consent' : 'Needs per-medication consent')}
            </span>
            {state.needsReacknowledgment && (
              <span data-testid="reack-flag" style={{
                background: 'var(--clr-amber-pale, #fdf3d8)',
                color: 'var(--clr-amber, #8a6a1a)',
                padding: '2px 8px', borderRadius: 'var(--radius-full)',
                fontSize: '0.6875rem', fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.02em',
              }}>
                Re-ack needed (medication plan changed)
              </span>
            )}
            {!isOtc && (
              <button
                className="btn-save"
                onClick={onRecordConsent}
                disabled={saving || !channelValid}
                type="button"
                style={{ marginLeft: 'auto' }}
              >
                {consentSatisfied ? 'Re-record consent' : 'Record consent'}
              </button>
            )}
            {consentSuccessText && <SuccessChip text={consentSuccessText} />}
          </div>

          {/* PR consent-attachments Part 2 — attach signed paper
              consent for this specific medication. For non-OTC the
              per-auth `medication_permission` ack is the target; for
              OTC the per-child OTC-blanket ack (above the
              authorization list) is the target, so no slot here —
              OtcBlanketCard owns its own. Only render when the
              per-auth ack exists for non-OTC authorizations. */}
          {!isOtc && perAuthAck?.id && userId && (
            <ConsentAttachmentSlot
              mode="provider"
              providerUserId={userId}
              targetType="acknowledgment"
              targetId={perAuthAck.id}
            />
          )}

          {/* Recent dose-log entries */}
          {events.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '0.8125rem' }}>Recent doses</strong>
                {doseSuccessText && <SuccessChip text={doseSuccessText} />}
              </div>
              <ul style={{
                margin: '6px 0 0 0', padding: 0, listStyle: 'none',
                fontSize: '0.8125rem', color: 'var(--clr-ink-mid)',
              }}>
                {events.slice(0, 5).map(ev => (
                  <li key={ev.id} style={{ padding: '4px 0', borderTop: '1px solid var(--clr-warm-mid)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>
                      {formatDateTime(ev.administered_at)}
                      {ev.dose_administered_text ? ` — ${ev.dose_administered_text}` : ''}
                      {' '}({caregiverNameFor(caregivers, ev.administered_by_caregiver_id)})
                    </span>
                    <button
                      className="btn-discard"
                      onClick={() => onArchiveDose(ev.id)}
                      disabled={saving}
                      type="button"
                      style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                    >Archive</button>
                  </li>
                ))}
                {events.length > 5 && (
                  <li style={{ padding: '4px 0', fontStyle: 'italic', color: 'var(--clr-ink-soft)' }}>
                    + {events.length - 5} earlier dose record{events.length - 5 === 1 ? '' : 's'}
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Dose-log entry sub-form */}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!doseOpen && (
              <button
                className="btn-save"
                onClick={() => setDoseOpen(true)}
                disabled={saving}
                type="button"
                data-testid="open-log-dose"
              >Log a dose</button>
            )}
            <button
              className="btn-discard"
              onClick={onArchive}
              disabled={saving}
              type="button"
            >Archive medication</button>
          </div>
          {doseOpen && (
            <DoseEntryForm
              authorization={authorization}
              caregivers={caregivers}
              saving={saving}
              onCancel={() => setDoseOpen(false)}
              onSubmit={async (fields) => {
                await onRecordDose(fields)
                setDoseOpen(false)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Dose entry form ───────────────────────────────────────────────

function DoseEntryForm({ authorization, caregivers, saving, onCancel, onSubmit }) {
  // Caregiver picker is GATED to eligible roles for non-OTC
  // authorizations (R 400.1931(1)); for topical OTC any caregiver is
  // selectable per R 400.1931(8) exemption. This is the UI mirror of
  // the DB trigger — the trigger remains the backstop.
  const eligible = useMemo(
    () => eligibleCaregiversForAdministration({ caregivers, authorization }),
    [caregivers, authorization]
  )
  const isOtc = isTopicalOtcExempt(authorization)

  const [administeredAt, setAdministeredAt] = useState(localIsoNow())
  const [doseText, setDoseText] = useState(authorization.dose_text || '')
  const [caregiverId, setCaregiverId] = useState('')
  const [notes, setNotes] = useState('')
  const [fieldError, setFieldError] = useState(null)

  function submit() {
    setFieldError(null)
    if (!caregiverId) {
      setFieldError('Select the caregiver who administered this dose.')
      return
    }
    onSubmit({
      administeredAt: new Date(administeredAt).toISOString(),
      doseText: doseText.trim() || null,
      caregiverId,
      notes: notes.trim() || null,
    })
  }

  return (
    <div
      data-testid="dose-entry-form"
      data-eligible-count={eligible.length}
      style={{ marginTop: 12, padding: 10, border: '1px dashed var(--clr-warm-mid)', borderRadius: 'var(--radius-md)' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontSize: '0.8125rem' }}>
          Date &amp; time <span style={{ color: 'var(--clr-danger)' }}>*</span>
          <input
            type="datetime-local"
            value={administeredAt}
            onChange={e => setAdministeredAt(e.target.value)}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Dose amount <span style={{ color: 'var(--clr-ink-soft)' }}>(prefilled from medication plan)</span>
          <input
            type="text"
            value={doseText}
            onChange={e => setDoseText(e.target.value)}
            placeholder="e.g., 5 mL"
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Administered by <span style={{ color: 'var(--clr-danger)' }}>*</span>
          <select
            data-testid="caregiver-picker"
            value={caregiverId}
            onChange={e => setCaregiverId(e.target.value)}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          >
            <option value="">— Select caregiver —</option>
            {eligible.map(c => (
              <option key={c.id} value={c.id}>
                {caregiverDisplayName(c)}
              </option>
            ))}
          </select>
          <span style={{ display: 'block', marginTop: 4, fontSize: '0.75rem', color: 'var(--clr-ink-soft)' }}>
            {isOtc
              ? 'Topical OTC: any caregiver may apply (R 400.1931(8) exempts from the role-gate).'
              : `Only ${ELIGIBLE_ADMINISTERING_ROLES.join(' or ').replace(/_/g, ' ')} may administer (R 400.1931(1)).`}
          </span>
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Notes <span style={{ color: 'var(--clr-ink-soft)' }}>(optional)</span>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
        </label>
        {fieldError && (
          <div role="alert" style={{ color: 'var(--clr-danger)', fontSize: '0.8125rem' }}>
            <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            {fieldError}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn-discard" onClick={onCancel} disabled={saving} type="button">Cancel</button>
        <button className="btn-save" onClick={submit} disabled={saving} type="button">Save dose</button>
      </div>
    </div>
  )
}

// ─── Authorization create form ─────────────────────────────────────

function AuthorizationForm({ saving, onCancel, onSubmit }) {
  const [medicationName, setMedicationName] = useState('')
  const [isTopicalOtc, setIsTopicalOtc] = useState(false)
  const [doseText, setDoseText] = useState('')
  const [scheduleText, setScheduleText] = useState('')
  const [prescriberName, setPrescriberName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [originalContainerConfirmed, setOriginalContainerConfirmed] = useState(false)
  const [fieldError, setFieldError] = useState(null)

  function submit() {
    setFieldError(null)
    if (!medicationName.trim()) {
      setFieldError('Medication name is required.')
      return
    }
    if (!isTopicalOtc && !originalContainerConfirmed) {
      // Soft warning — the rule (4) says prescription must have the
      // pharmacy label; we surface this so the provider attests they
      // checked. Not a hard block (the data model allows it), but
      // we surface the friction so providers don't skip silently.
      setFieldError(
        'Please attest that you confirmed the original container (R 400.1931(4)). ' +
        'Tick the checkbox to proceed.'
      )
      return
    }
    onSubmit({
      medication_name: medicationName,
      is_topical_otc: isTopicalOtc,
      dose_text: doseText.trim() || null,
      schedule_text: scheduleText.trim() || null,
      prescriber_name: prescriberName.trim() || null,
      starts_on: startsOn || null,
      ends_on: endsOn || null,
      original_container_confirmed: originalContainerConfirmed,
    })
  }

  return (
    <div
      data-testid="authorization-form"
      style={{
        padding: 12, border: '1px dashed var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)', background: 'var(--clr-cream)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontSize: '0.8125rem' }}>
          Medication name <span style={{ color: 'var(--clr-danger)' }}>*</span>
          <input
            type="text"
            value={medicationName}
            onChange={e => setMedicationName(e.target.value)}
            placeholder="e.g., Children's Tylenol, Sunscreen, Diaper rash ointment"
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          />
        </label>

        {/* OTC vs Rx — the discriminant. Surface PROMINENTLY since
            it drives the entire rule branch (role-gate, dose log
            requirement). */}
        <fieldset
          data-testid="otc-fieldset"
          style={{ border: '1px solid var(--clr-warm-mid)', borderRadius: 'var(--radius-md)', padding: 8 }}
        >
          <legend style={{ fontSize: '0.8125rem', fontWeight: 600, padding: '0 6px' }}>
            Category <span style={{ color: 'var(--clr-danger)' }}>*</span>
          </legend>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '0.8125rem', marginBottom: 4 }}>
            <input
              type="radio"
              name="otc"
              checked={!isTopicalOtc}
              onChange={() => setIsTopicalOtc(false)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>Prescription or oral OTC</strong> (e.g., children&apos;s Tylenol,
              antibiotic) — R 400.1931(1): only licensee/staff may administer;
              R 400.1931(7): per-dose log required; needs per-medication
              parent permission.
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '0.8125rem' }}>
            <input
              type="radio"
              name="otc"
              checked={isTopicalOtc}
              onChange={() => setIsTopicalOtc(true)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>Topical OTC</strong> (sunscreen, insect repellent,
              diaper rash cream and similar) — R 400.1931(8): exempt from
              the role-gate AND the per-dose log; needs the OTC-blanket
              consent (one per child) above.
            </span>
          </label>
        </fieldset>

        <label style={{ fontSize: '0.8125rem' }}>
          Dose <span style={{ color: 'var(--clr-ink-soft)' }}>(free text)</span>
          <input
            type="text"
            value={doseText}
            onChange={e => setDoseText(e.target.value)}
            placeholder={isTopicalOtc ? 'e.g., Apply to face and arms' : 'e.g., 5 mL by mouth'}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Schedule <span style={{ color: 'var(--clr-ink-soft)' }}>(free text)</span>
          <input
            type="text"
            value={scheduleText}
            onChange={e => setScheduleText(e.target.value)}
            placeholder={isTopicalOtc ? 'e.g., Before outdoor time as needed' : 'e.g., Twice daily, 8am + 8pm'}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
          />
        </label>
        {!isTopicalOtc && (
          <label style={{ fontSize: '0.8125rem' }}>
            Prescriber <span style={{ color: 'var(--clr-ink-soft)' }}>(physician name)</span>
            <input
              type="text"
              value={prescriberName}
              onChange={e => setPrescriberName(e.target.value)}
              placeholder="e.g., Dr. Smith"
              style={{ width: '100%', padding: 6, boxSizing: 'border-box' }}
            />
          </label>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ fontSize: '0.8125rem', flex: 1 }}>
            Start date
            <input type="date" value={startsOn} onChange={e => setStartsOn(e.target.value)}
              style={{ width: '100%', padding: 6, boxSizing: 'border-box' }} />
          </label>
          <label style={{ fontSize: '0.8125rem', flex: 1 }}>
            End date <span style={{ color: 'var(--clr-ink-soft)' }}>(blank = ongoing)</span>
            <input type="date" value={endsOn} onChange={e => setEndsOn(e.target.value)}
              style={{ width: '100%', padding: 6, boxSizing: 'border-box' }} />
          </label>
        </div>

        {/* R 400.1931(4) attestation — surfaced even for OTC because
            providers should still confirm the bottle's label matches
            (rule applies to prescription specifically, but the
            attestation is a useful affordance either way). For non-OTC
            it gates the submit. */}
        <label style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={originalContainerConfirmed}
            onChange={e => setOriginalContainerConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I have verified the original container&apos;s label
            (R 400.1931(4): prescription label must indicate the
            physician&apos;s name, child&apos;s name, instructions, and
            medication name + strength).
            {!isTopicalOtc && <span style={{ color: 'var(--clr-danger)' }}> Required for non-topical.</span>}
          </span>
        </label>

        {fieldError && (
          <div role="alert" style={{ color: 'var(--clr-danger)', fontSize: '0.8125rem' }}>
            <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            {fieldError}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="btn-discard" onClick={onCancel} disabled={saving} type="button">Cancel</button>
        <button className="btn-save" onClick={submit} disabled={saving} type="button">Save medication</button>
      </div>
    </div>
  )
}

// ─── Channel chooser (mirrors EnrollmentConsentsModal) ──────────────

function ChannelChooser({ channel, setChannel, parentLabel, setParentLabel, providerReason, setProviderReason }) {
  return (
    <section>
      <h3 style={{ fontSize: '1rem', margin: '0 0 8px 0' }}>How is the parent acknowledging consent?</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label>
          <input
            type="radio"
            name="med-channel"
            value="in_person_paper"
            checked={channel === 'in_person_paper'}
            onChange={() => setChannel('in_person_paper')}
          /> Parent signed in person / on paper
        </label>
        <label>
          <input
            type="radio"
            name="med-channel"
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
          <label style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>Reason</label>
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
  )
}

// ─── Pure render helpers ──────────────────────────────────────────

/**
 * Inline ✓ confirmation chip (2026-06-02 fix-forward). Sits near the
 * control that just succeeded, auto-dismisses after 3s via the modal-
 * level timer. Sage-pale background + sage-dark text + CheckCircle2
 * icon — same visual tokens as the on-file badges so the visual
 * language stays one. Error confirmations (red) and success
 * confirmations (sage) read as a matched pair across the modal.
 */
function SuccessChip({ text }) {
  if (!text) return null
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="med-success-chip"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--clr-sage-pale, #e6efe7)',
        color: 'var(--clr-sage-dark)',
        padding: '2px 10px',
        borderRadius: 'var(--radius-full)',
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <CheckCircle2 size={12} aria-hidden="true" />
      {text}
    </span>
  )
}

function caregiverDisplayName(c) {
  if (!c) return ''
  if (c.full_name) return c.full_name
  return `(caregiver ${c.id.slice(0, 8)})`
}

function caregiverNameFor(caregivers, id) {
  if (!id) return '(unknown)'
  const c = (caregivers || []).find(x => x.id === id)
  return c ? caregiverDisplayName(c) : '(unknown caregiver)'
}

function formatDateTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function localIsoNow() {
  // `datetime-local` wants 'YYYY-MM-DDTHH:MM' without timezone.
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}
