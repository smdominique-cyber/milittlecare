// PR #16 — Child intake modal (Rule 7 / R 400.1907).
//
// Captures the child-in-care statement bundle for licensed providers
// (family_home, group_home). LEPs do not see this surface; the existing
// basics form remains the only intake on the LEP path.
//
// Bundle structure (per scope OQ4): one envelope row of type
// 'child_in_care_statement' + N sub-rows (lead/firearms/food/etc.).
// All rows share the same `provider_id`, `subject_type='child'`,
// `subject_id=child.id`, and `acknowledged_via` channel. The envelope's
// `snapshot_hash` is a deterministic composition of the sub-row hashes.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertCircle, X, CheckCircle2, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  ACK_TYPES,
  arePremisesAnsweredForIntake,
  computeAckHash,
  computeEnvelopeHash,
  findActiveAck,
  requiredSubTypesForChild,
} from '@/lib/acknowledgments'

// Copy version strings are stamped into each ack row's snapshot_hash via
// the payload. Bumping a version invalidates prior acks of that type
// (drift detection in getChildFileCompleteness).
//
// Note (2026-05-29): the key `licensing_notebook_offered` is the DB
// string value for the constant ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY
// (renamed in JS, value preserved for back-compat — see
// src/lib/acknowledgments.js header). `licensing_rules_offered` is the
// genuinely-new acknowledgment for R 400.1907(1)(b)(iii).
const COPY_VERSIONS = Object.freeze({
  lead_disclosure: 'v1',
  firearms_disclosure: 'v1',
  food_provider_agreement: 'v1',
  licensing_notebook_offered: 'v1',  // DB string for LICENSING_NOTEBOOK_AVAILABILITY ((vii))
  licensing_rules_offered: 'v1',      // (iii)
  infant_safe_sleep: 'v1',
  health_condition: 'v1',
  discipline_policy_receipt: 'v1',
})

const SUB_TYPE_LABEL = Object.freeze({
  [ACK_TYPES.LEAD_DISCLOSURE]:                'Lead-based paint disclosure',
  [ACK_TYPES.FIREARMS_DISCLOSURE]:            'Firearms on premises disclosure',
  [ACK_TYPES.FOOD_PROVIDER_AGREEMENT]:        'Agreement on who provides food',
  // R 400.1907(1)(b)(vii) — THIS home's licensing notebook
  // (inspection reports, corrective actions, approval letters per
  // R 400.1906(3)). Label was previously "Licensing notebook offered
  // to the parent" — renamed 2026-05-29 to match (vii)'s "availability"
  // language, since (iii) "offered" is now a separate type below.
  [ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY]: 'Licensing notebook availability',
  // R 400.1907(1)(b)(iii) — genuinely new 2026-05-29.
  [ACK_TYPES.LICENSING_RULES_OFFERED]:        'Licensing rules offered to the parent',
  [ACK_TYPES.INFANT_SAFE_SLEEP]:              'Infant safe-sleep practices',
  [ACK_TYPES.HEALTH_CONDITION]:               'Condition of child health acknowledged',
  [ACK_TYPES.DISCIPLINE_POLICY_RECEIPT]:      'Discipline policy received',
})

const SUB_TYPE_HELP = Object.freeze({
  [ACK_TYPES.LEAD_DISCLOSURE]:
    'Required because your home was built before 1978. Tell the parent ' +
    'that lead-based paint may be present.',
  [ACK_TYPES.FIREARMS_DISCLOSURE]:
    'Disclose whether firearms are kept on premises. Required at intake ' +
    'regardless of yes/no.',
  [ACK_TYPES.FOOD_PROVIDER_AGREEMENT]:
    'Confirm who provides meals: you (the provider), the parent, or both.',
  [ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY]:
    'Tell the parent your licensing notebook (inspection reports, ' +
    'corrective action plans, approval letters per R 400.1906(3)) is ' +
    'available to them during operating hours.',
  [ACK_TYPES.LICENSING_RULES_OFFERED]:
    'Tell the parent you can provide them a copy of the licensing rules ' +
    '(R 400.1901–1951) on request.',
  [ACK_TYPES.INFANT_SAFE_SLEEP]:
    'Required for children under 18 months. Cover back-sleeping, no soft ' +
    'bedding, and supervision.',
  [ACK_TYPES.HEALTH_CONDITION]:
    'Capture the parent acknowledging the child\'s general health and ' +
    'any conditions you should know about.',
  [ACK_TYPES.DISCIPLINE_POLICY_RECEIPT]:
    'Confirm the parent received your written discipline policy.',
})

export default function ChildIntakeModal({
  userId,            // licensee's auth.users.id (provider_id on ack rows)
  child,
  profile,           // licensee profile (home_built_before_1978, firearms_on_premises)
  primaryGuardianName, // optional, prefills parent_label
  onClose,
  onSaved,
}) {
  const [acks, setAcks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Per-ack-row form state. Lead/firearms/food/discipline have their own
  // small inputs that contribute to the snapshot_hash payload.
  const [foodProvider, setFoodProvider] = useState(child?.food_provider || 'provider')
  const [healthSummary, setHealthSummary] = useState(child?.medical_notes || '')
  const [disciplineVersion] = useState(1)
  const [channel, setChannel] = useState('in_person_paper')
  const [parentLabel, setParentLabel] = useState(primaryGuardianName || '')
  const [providerReason, setProviderReason] = useState(
    'Captured at child intake; parent acknowledged in person.'
  )

  const required = useMemo(
    () => requiredSubTypesForChild({ child, profile }),
    [child, profile]
  )

  // PR #16 follow-up (premises gate, 2026-05-29).
  //
  // Confirmed live: a provider clicked Send-to-Portal with both premises
  // booleans null (Premises section never filled). `required` quietly
  // dropped lead_disclosure and firearms_disclosure, the bundle wrote
  // without them, intake_completed_at got stamped, and the provider was
  // never warned. The bundle is missing two legally-required
  // disclosures.
  //
  // Every save path (handleSendToPortal, handleSaveBundle for both
  // in_person_paper and provider_override) now blocks when this gate is
  // not satisfied. The button is disabled (visible UX), the handler
  // re-checks at the top (defense in depth), and a banner above the
  // channel section names exactly which premises questions are
  // outstanding plus where to answer them.
  const premisesGate = useMemo(
    () => arePremisesAnsweredForIntake(profile),
    [profile]
  )

  // Per-sub-type payload (drives snapshot_hash).
  const payloads = useMemo(() => {
    const p = {}
    for (const t of required) {
      p[t] = subTypePayload(t, {
        profile,
        child,
        foodProvider,
        healthSummary,
        disciplineVersion,
      })
    }
    return p
  }, [required, profile, child, foodProvider, healthSummary, disciplineVersion])

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
      if (error) {
        setError(error)
      } else {
        setAcks(Array.isArray(data) ? data : [])
      }
      setLoading(false)
    }
    if (child && userId) load()
    return () => { cancelled = true }
  }, [child, userId])

  const channelValid = (() => {
    // PR #16 follow-up (premises gate): no channel is valid until the
    // licensee has answered both Premises booleans. The required-set
    // derivation would otherwise silently drop missing disclosures.
    if (!premisesGate.ready) return false
    if (channel === 'in_person_paper') return parentLabel.trim().length > 0
    if (channel === 'provider_override') return providerReason.trim().length > 0
    if (channel === 'parent_portal_trigger') return true
    return false
  })()

  // PR #16 follow-up (compliance-meaningful confirm, 2026-05-29).
  //
  // Original behavior: this handler ONLY inserted a reminder_instances
  // row and left no acknowledgments to confirm. The parent's portal
  // confirm then wrote an empty envelope and never produced per-
  // disclosure sub-rows — so pending_lead_disclosures_count /
  // pending_firearms_disclosures_count stayed positive even after the
  // loop "completed." Compliance theater, not compliance.
  //
  // Fix: pre-write the full provider-attested bundle (envelope + every
  // required sub-row, per `requiredSubTypesForChild`) BEFORE firing
  // the reminder. The rows are stamped `acknowledged_via =
  // 'provider_override'` with an explicit reason that documents the
  // portal-pending state. The provider's intake modal IS where the
  // provider attests each disclosure, so this is honest audit data:
  // provider attested at intake, parent has been notified to formally
  // confirm at /parent/intake-acknowledge. The parent's portal confirm
  // archives these rows and re-stamps the bundle as `parent_portal`
  // (existing confirmChild path), preserving the channel transition as
  // the audit story.
  //
  // Counts behavior: getChildFilesAuditState counts ANY active
  // acknowledgments row of the required type — it does not filter by
  // channel. Pending counts therefore drop to zero at SEND time
  // (provider-attested rows are active) and STAY at zero after parent
  // confirm (parent_portal rows replace provider_override). The
  // approved acceptance criterion (16patch follow-up, 2026-05-29) is
  // exactly this: counts drop at send, do not bounce back up on confirm.
  //
  // RLS: provider's INSERT under "Providers can insert their own
  // acknowledgments" (migration 024) requires provider_id = auth.uid()
  // — userId is passed as the licensee's auth uid by the caller. The
  // archive UPDATE goes through "Providers can update their own
  // acknowledgments" (same migration). The required-set derivation
  // reads the licensee's premises booleans from `profile`, which the
  // caller already pulled under the profiles "Users can view their
  // own profile" policy (migration 001).
  async function handleSendToPortal() {
    // PR #16 follow-up (premises gate, 2026-05-29). Defense in depth —
    // the button is also disabled via `channelValid`; this throw catches
    // any path that bypasses the disabled state (programmatic call,
    // future refactor, automated test that misses the prop).
    if (!premisesGate.ready) {
      setError(new Error(buildPremisesGateMessage(premisesGate.missing)))
      return
    }
    setSaving(true)
    setError(null)
    try {
      // 1. Archive any existing active rows so the new pre-attest
      //    bundle is the only active set. Mirrors handleSaveBundle.
      const existing = acks.filter(a => !a.archived_at)
      if (existing.length > 0) {
        const ids = existing.map(a => a.id)
        const { error: archiveErr } = await supabase
          .from('acknowledgments')
          .update({ archived_at: new Date().toISOString() })
          .in('id', ids)
        if (archiveErr) throw archiveErr
      }

      // 2. Compute the sub-row hashes from the same payload composition
      //    `handleSaveBundle` uses. `required` and `payloads` are the
      //    same useMemos the existing channels rely on.
      const subHashes = required.map(
        t => computeAckHash({ type: t, payload: payloads[t] })
      )
      const envelopeHash = computeEnvelopeHash(subHashes)

      // 3. Build the provider-attested rows. acknowledged_via =
      //    'provider_override' with a reason naming the portal-pending
      //    state. acknowledged_by_user_id stays null (parent has not
      //    acknowledged yet); acknowledged_by_label stays null (no
      //    paper signature was taken). The reason is the audit-trail
      //    explanation an auditor reads.
      const triggeredAtIso = new Date().toISOString()
      const overrideReason =
        `Provider attested at intake on ${triggeredAtIso.slice(0, 10)}; ` +
        `parent notified to confirm via portal at ` +
        `/parent/intake-acknowledge?child=${child.id}.`

      const sharedFields = {
        provider_id: userId,
        subject_type: 'child',
        subject_id: child.id,
        acknowledged_via: 'provider_override',
        acknowledged_by_user_id: null,
        acknowledged_by_label: null,
        provider_override_reason: overrideReason,
      }

      const rows = [
        // Envelope row first.
        {
          ...sharedFields,
          type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
          snapshot_hash: envelopeHash,
          snapshot_version: null,
        },
        // Sub-rows.
        ...required.map((t, i) => ({
          ...sharedFields,
          type: t,
          snapshot_hash: subHashes[i],
          snapshot_version: COPY_VERSIONS[t] || null,
        })),
      ]

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert(rows)
      if (insertErr) throw insertErr

      // 4. Stamp the child's intake_completed_at and per-row inputs.
      //    Same payload the other channels write so re-renders show the
      //    bundle as complete in the provider's view.
      const childUpdate = {
        intake_completed_at: triggeredAtIso,
        food_provider: foodProvider,
      }
      if (healthSummary && healthSummary.trim().length > 0) {
        childUpdate.medical_notes = healthSummary.trim()
      }
      const { error: childErr } = await supabase
        .from('children')
        .update(childUpdate)
        .eq('id', child.id)
      if (childErr) throw childErr

      // 5. NOW fire the reminder. The dispatcher emails the parent;
      //    the parent's confirm path (ParentIntakeAcknowledgePage) sees
      //    the provider_override sub-rows as `existing` and re-stamps
      //    each one as parent_portal — the existing-acks branch of
      //    confirmChild, already tested.
      const body =
        `Your child care provider has requested your acknowledgment of ` +
        `Michigan-required intake disclosures for ${child.first_name || 'your child'}. ` +
        `Open the link to review and confirm.`
      const ctaPath = `/parent/intake-acknowledge?child=${encodeURIComponent(child.id)}`
      const { error: rpcErr } = await supabase.rpc(
        'reminder_instance_request_intake_ack',
        {
          p_child_id: child.id,
          p_title: `Intake acknowledgments needed for ${child.first_name || 'your child'}`,
          p_body: body,
          p_cta_path: ctaPath,
          p_trigger_at: triggeredAtIso,
        }
      )
      if (rpcErr) throw rpcErr
      onSaved?.()
      onClose?.()
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveBundle() {
    if (channel === 'parent_portal_trigger') return handleSendToPortal()
    // PR #16 follow-up (premises gate, 2026-05-29). Same defense-in-
    // depth check as handleSendToPortal: the in_person_paper and
    // provider_override channels share the SAME required-set derivation
    // and the SAME latent bug — without this gate they would also write
    // an incomplete bundle when the licensee never filled the Premises
    // section.
    if (!premisesGate.ready) {
      setError(new Error(buildPremisesGateMessage(premisesGate.missing)))
      return
    }
    if (!channelValid || saving) return
    setSaving(true)
    setError(null)

    try {
      // Archive any existing active rows so the re-acknowledgment is
      // recorded fresh (preserves the audit trail).
      const existing = acks.filter(a => !a.archived_at)
      if (existing.length > 0) {
        const ids = existing.map(a => a.id)
        const { error: archiveErr } = await supabase
          .from('acknowledgments')
          .update({ archived_at: new Date().toISOString() })
          .in('id', ids)
        if (archiveErr) throw archiveErr
      }

      // Compute sub-row hashes (deterministic from payloads).
      const subHashes = required.map(t => computeAckHash({ type: t, payload: payloads[t] }))
      const envelopeHash = computeEnvelopeHash(subHashes)

      const sharedFields = {
        provider_id: userId,
        subject_type: 'child',
        subject_id: child.id,
        acknowledged_via: channel,
        acknowledged_by_user_id: null,
        acknowledged_by_label: channel === 'in_person_paper' ? parentLabel.trim() : null,
        provider_override_reason: channel === 'provider_override' ? providerReason.trim() : null,
      }

      const rows = []
      // Envelope row first (snapshot_hash is the composite).
      rows.push({
        ...sharedFields,
        type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
        snapshot_hash: envelopeHash,
        snapshot_version: null,
      })
      // Sub-rows.
      required.forEach((t, i) => {
        rows.push({
          ...sharedFields,
          type: t,
          snapshot_hash: subHashes[i],
          snapshot_version: COPY_VERSIONS[t] || null,
        })
      })

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert(rows)
      if (insertErr) throw insertErr

      // Stamp intake_completed_at on the child + persist food_provider /
      // health_summary so future re-acks recompute the same hash.
      const childUpdate = {
        intake_completed_at: new Date().toISOString(),
        food_provider: foodProvider,
      }
      if (healthSummary && healthSummary.trim().length > 0) {
        childUpdate.medical_notes = healthSummary.trim()
      }
      const { error: childErr } = await supabase
        .from('children')
        .update(childUpdate)
        .eq('id', child.id)
      if (childErr) throw childErr

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
            Record intake for {child.first_name}
          </span>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close intake form"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, color: 'var(--clr-ink-mid)', fontSize: '0.875rem', lineHeight: 1.5 }}>
            Per Rule 7 (R 400.1907), Michigan licensed homes capture a "child in
            care statement" at intake. We will write one envelope acknowledgment
            plus one row per applicable disclosure below.
          </p>

          {loading ? (
            <p>Loading existing acknowledgments...</p>
          ) : (
            <>
              {!premisesGate.ready && (
                <PremisesGateBanner missing={premisesGate.missing} onClose={onClose} />
              )}

              <section>
                <h3 style={{ fontSize: '1rem', margin: '0 0 8px 0' }}>
                  Disclosures that apply to {child.first_name}
                </h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {required.map(t => {
                    const ack = findActiveAck(acks, { type: t, subjectType: 'child', subjectId: child.id })
                    const present = !!ack
                    return (
                      <li
                        key={t}
                        style={{
                          padding: 12,
                          border: `1px solid ${present ? 'var(--clr-sage)' : 'var(--clr-warm-mid)'}`,
                          borderRadius: 'var(--radius-md)',
                          background: present ? 'var(--clr-cream)' : 'white',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                          {present
                            ? <CheckCircle2 size={16} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0, marginTop: 2 }} />
                            : <ShieldAlert size={16} style={{ color: 'var(--clr-ink-soft)', flexShrink: 0, marginTop: 2 }} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <strong style={{ display: 'block' }}>{SUB_TYPE_LABEL[t]}</strong>
                            <span style={{ color: 'var(--clr-ink-soft)', fontSize: '0.8125rem' }}>
                              {SUB_TYPE_HELP[t]}
                            </span>
                            {t === ACK_TYPES.FOOD_PROVIDER_AGREEMENT && (
                              <div style={{ marginTop: 6 }}>
                                <label style={{ marginRight: 12 }}>
                                  <input type="radio" name="food_provider" value="provider" checked={foodProvider === 'provider'} onChange={() => setFoodProvider('provider')} /> Provider
                                </label>
                                <label style={{ marginRight: 12 }}>
                                  <input type="radio" name="food_provider" value="parent" checked={foodProvider === 'parent'} onChange={() => setFoodProvider('parent')} /> Parent
                                </label>
                                <label>
                                  <input type="radio" name="food_provider" value="both" checked={foodProvider === 'both'} onChange={() => setFoodProvider('both')} /> Both
                                </label>
                              </div>
                            )}
                            {t === ACK_TYPES.HEALTH_CONDITION && (
                              <div style={{ marginTop: 6 }}>
                                <textarea
                                  value={healthSummary}
                                  onChange={e => setHealthSummary(e.target.value)}
                                  placeholder="Notes on the child's health, conditions, allergies..."
                                  rows={2}
                                  style={{ width: '100%', boxSizing: 'border-box', padding: 6, fontFamily: 'inherit', fontSize: '0.875rem' }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
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
                    /> I am recording on the parent's behalf
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="channel"
                      value="parent_portal_trigger"
                      checked={channel === 'parent_portal_trigger'}
                      onChange={() => setChannel('parent_portal_trigger')}
                    /> Send to parent's portal (we will email them a link to confirm)
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
                  </div>
                )}
                {channel === 'parent_portal_trigger' && (
                  <div style={{ marginTop: 8, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.5 }}>
                    We will record your attestation of every disclosure above
                    and notify the parent to formally confirm. The next hourly
                    dispatcher run emails them a link to <code>/parent/intake-acknowledge</code>;
                    when they confirm, your provider attestation is preserved
                    in the audit trail and re-stamped as their portal confirmation.
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
          <button className="btn-discard" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn-save"
            onClick={handleSaveBundle}
            disabled={saving || !channelValid || loading}
          >
            {saving
              ? 'Saving...'
              : channel === 'parent_portal_trigger'
                ? 'Send to parent'
                : 'Save intake bundle'}
          </button>
        </div>
      </div>
    </div>
  )
}

// PR #16 follow-up (premises gate, 2026-05-29).
// Visible banner that names the missing premises fields and points
// the provider to BusinessInfoPage's Premises section. Rendered
// inside the modal above the channel chooser when the gate fails.
// The button is disabled in parallel via `channelValid`; this banner
// is the explanation for why.
function PremisesGateBanner({ missing, onClose }) {
  const fieldLabel = (m) =>
    m === 'home_built_before_1978'
      ? 'Was your home built before 1978?'
      : m === 'firearms_on_premises'
        ? 'Are firearms kept on the premises?'
        : m
  return (
    <div
      role="alert"
      style={{
        background: 'var(--clr-amber-pale, #fdf3d8)',
        border: '1px solid var(--clr-amber, #d29c2b)',
        color: 'var(--clr-ink)',
        padding: 12,
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--clr-amber, #d29c2b)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Answer your Premises questions first.
          </strong>
          <p style={{ margin: '0 0 8px 0', fontSize: '0.875rem', lineHeight: 1.5 }}>
            Michigan rule R 400.1907 requires every child's intake bundle to
            include disclosures gated on these answers. Without them, this
            child's bundle would be saved missing the legally-required
            {missing.includes('home_built_before_1978') ? ' lead-based-paint' : ''}
            {missing.length === 2 ? ' and' : ''}
            {missing.includes('firearms_on_premises') ? ' firearms' : ''}
            {' '}disclosure
            {missing.length > 1 ? 's' : ''}.
          </p>
          <ul style={{ margin: '0 0 8px 0', paddingLeft: 20, fontSize: '0.8125rem' }}>
            {missing.map(m => <li key={m}>{fieldLabel(m)}</li>)}
          </ul>
          <p style={{ margin: 0, fontSize: '0.8125rem' }}>
            Open <Link to="/business-info" onClick={onClose}>Business Info</Link>,
            select the <strong>Premises</strong> tab, answer both questions,
            then return to record this child's intake.
          </p>
        </div>
      </div>
    </div>
  )
}

// Backstop error string used when a handler is invoked despite the
// disabled state (shouldn't happen via the UI but covers programmatic
// calls + future refactors that miss the prop).
function buildPremisesGateMessage(missing) {
  const labels = missing.map(m =>
    m === 'home_built_before_1978'
      ? '"Was your home built before 1978?"'
      : m === 'firearms_on_premises'
        ? '"Are firearms kept on the premises?"'
        : m
  )
  return (
    'Premises section is incomplete. Answer ' +
    labels.join(' and ') +
    ' in Business Info → Premises before recording this child\'s intake. ' +
    '(R 400.1907 requires the corresponding disclosure rows in the bundle.)'
  )
}

function subTypePayload(type, ctx) {
  switch (type) {
    case ACK_TYPES.LEAD_DISCLOSURE:
      return { homeBuiltBefore1978: !!ctx.profile.home_built_before_1978, copyVersion: COPY_VERSIONS.lead_disclosure }
    case ACK_TYPES.FIREARMS_DISCLOSURE:
      return { firearmsOnPremises: !!ctx.profile.firearms_on_premises, copyVersion: COPY_VERSIONS.firearms_disclosure }
    case ACK_TYPES.FOOD_PROVIDER_AGREEMENT:
      return { foodProvider: ctx.foodProvider }
    case ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY:
      return { copyVersion: COPY_VERSIONS.licensing_notebook_offered }
    case ACK_TYPES.LICENSING_RULES_OFFERED:
      return { copyVersion: COPY_VERSIONS.licensing_rules_offered }
    case ACK_TYPES.INFANT_SAFE_SLEEP:
      return { copyVersion: COPY_VERSIONS.infant_safe_sleep }
    case ACK_TYPES.HEALTH_CONDITION:
      return { healthSummary: (ctx.healthSummary || '').trim() || null }
    case ACK_TYPES.DISCIPLINE_POLICY_RECEIPT:
      return { policyVersion: ctx.disciplineVersion }
    default:
      return {}
  }
}
