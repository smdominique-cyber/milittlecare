// Intake packet capture (Option D from the scoping report, 2026-06-14).
//
// One provider-facing "I have a signed PDF that covers these N
// intake elements" workflow with TWO entry paths:
//
//   path (a) — send-for-signature  → packet status='pending_parent';
//     covering acks written with acknowledged_via='provider_override'.
//     Parent later signs via the portal; the new RPC
//     intake_packet_confirm_for_parent (mig 041) atomically archives
//     those acks, writes fresh parent_portal rows tagged with the
//     same packet_id, and flips intake_packets.status='signed'.
//
//   path (b) — upload-signed-copy → consent_attachments row written
//     first (target_type='intake_packet', target_id=packet.id); the
//     covering acks are only written AFTER the attachment lands.
//     packet status='signed' immediately, signed_via='in_person_paper'.
//
// The nine intake-row resolvers in complianceState.js DO NOT CHANGE.
// They keep reading sourceRows.acks. The packet model produces acks
// the resolvers already understand — packet_id is metadata for a
// future "display grouping" PR.
//
// Honesty guardrail (the load-bearing one) is enforced at the
// WRITE layer: path (b) refuses to insert covering acks unless an
// attachment exists; path (a) writes acks in the provider_override
// channel so resolvers read pending_parent until the parent signs.
//
// Data model: supabase/migrations/041_intake_packets.sql.

import { supabase } from './supabase'
import {
  ACK_TYPES,
  computeAckHash,
  computeEnvelopeHash,
  requiredSubTypesForChild,
} from './acknowledgments'
import {
  BUCKET as CONSENT_ATTACHMENTS_BUCKET,
  buildStoragePath as buildConsentAttachmentPath,
} from './consentAttachments'
import { validateFile, defaultRetentionUntil as defaultConsentRetentionUntil } from './storage'

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

/**
 * The nine intake elements a packet can cover. The envelope first
 * (so the provider's coverage list reads top-down), then the eight
 * sub-acknowledgments. The eight sub-acks correspond one-to-one with
 * R 400.1907(1)(b) clauses (lead is (vi), firearms is (v), etc.).
 *
 * `requiredForChild(child, profile)` filters this list down to the
 * sub-set the rule actually requires for THIS child given premises
 * + age — same gating `acknowledgments.requiredSubTypesForChild`
 * uses. The provider can only uncheck a required element; checking
 * an UN-required element is a no-op (the engine would never read
 * such an ack as satisfying anything).
 */
export const INTAKE_PACKET_COVERABLE_TYPES = Object.freeze([
  ACK_TYPES.CHILD_IN_CARE_STATEMENT,    // envelope
  ACK_TYPES.LEAD_DISCLOSURE,
  ACK_TYPES.FIREARMS_DISCLOSURE,
  ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
  ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY,
  ACK_TYPES.LICENSING_RULES_OFFERED,
  ACK_TYPES.INFANT_SAFE_SLEEP,
  ACK_TYPES.HEALTH_CONDITION,
  ACK_TYPES.DISCIPLINE_POLICY_RECEIPT,
])

/**
 * For a given child + profile, the subset of INTAKE_PACKET_COVERABLE_TYPES
 * that the rule actually requires (envelope + the sub-types from
 * requiredSubTypesForChild). The UI defaults all of these to checked.
 */
export function packetCoverableForChild({ child, profile, today }) {
  const subs = requiredSubTypesForChild({ child, profile, today })
  // Envelope is always "covered" if any of the bundle is — it's the
  // wrapper that lets the existing envelope resolver flip on_file.
  return [ACK_TYPES.CHILD_IN_CARE_STATEMENT, ...subs]
}

// -----------------------------------------------------------------------------
// Internal — payload composition (mirrors ChildIntakeModal)
// -----------------------------------------------------------------------------

/**
 * Compose the deterministic payload object for a sub-type. Mirrors
 * the COPY_VERSIONS + payload-keys shape ChildIntakeModal already
 * uses so the resulting snapshot_hash is comparable across surfaces.
 *
 * The packet path uses a SINGLE attestation_text + the child + the
 * profile premises for hashing; per-element specifics (e.g. food
 * provider choice) aren't asked individually in the packet UI.
 * Anything not in the per-element payload here is intentionally
 * fixed for the packet — the artifact carries the per-element
 * detail, not the engine's metadata.
 */
function buildSubPayload({ subType, packetId, attestationText }) {
  return {
    sub: subType,
    packet_id: packetId,
    attestation: attestationText || '',
  }
}

function computeRowHashes({ coveredTypes, packetId, attestationText }) {
  const subHashes = []
  for (const t of coveredTypes) {
    if (t === ACK_TYPES.CHILD_IN_CARE_STATEMENT) continue
    subHashes.push(computeAckHash({
      type: t,
      payload: buildSubPayload({ subType: t, packetId, attestationText }),
    }))
  }
  return {
    subHashes,
    envelopeHash: computeEnvelopeHash(subHashes),
  }
}

// -----------------------------------------------------------------------------
// path (a) — send for parent digital signature
// -----------------------------------------------------------------------------

/**
 * Create a `digital_signature_request` packet + provider_override
 * ack rows for the covered types. Parent later signs via the new
 * intake_packet_confirm_for_parent RPC.
 *
 * Write sequence (matches ChildIntakeModal.handleSendToPortal):
 *   1. Archive any active acks on this child for the covered types.
 *      Defensive against double-send leftovers.
 *   2. Insert the intake_packets row (status='pending_parent',
 *      signed_via=null — DB-floor CHECK enforces both).
 *   3. Insert one ack row per covered type with
 *      acknowledged_via='provider_override' + packet_id stamped.
 *      The provider_override_reason mirrors the legacy "parent
 *      notified to confirm via portal" pattern so the existing
 *      patternAAckOnFile resolver reads them as pending_parent.
 *   4. Stamp children.intake_completed_at (the legacy modal does
 *      this too — represents "provider attested at intake," not
 *      "parent has signed").
 *
 * On any write error the caller surfaces the message; partial state
 * is not compensated client-side (the existing legacy modal has the
 * same posture — see ChildIntakeModal.handleSendToPortal:280-).
 *
 * @returns {{ packet, ackRows }} — the inserted packet row + acks
 *   the caller can use for a confirmation chip.
 */
export async function sendPacketForSignature({
  providerId,
  child,
  profile,
  coveredTypes,
  attestationText,
  today,
}) {
  validatePacketWriteInputs({ providerId, child, coveredTypes })

  const covered = filterToRequired({ coveredTypes, child, profile, today })
  if (covered.length === 0) {
    throw new Error('sendPacketForSignature: no required elements selected for coverage')
  }
  const overrideReason = buildSendForSigOverrideReason({ child, today })

  // ── 1) Archive existing acks for the covered types ───────────
  await archiveExistingActiveAcks({ providerId, childId: child.id, types: covered })

  // ── 2) Insert the packet row ─────────────────────────────────
  //       Has to come BEFORE the acks so we have an id to stamp.
  const { data: packetData, error: packetErr } = await supabase
    .from('intake_packets')
    .insert({
      provider_id: providerId,
      subject_type: 'child',
      subject_id: child.id,
      source: 'digital_signature_request',
      status: 'pending_parent',
      signed_via: null,
      attestation_text: attestationText || null,
    })
    .select('id, status, source')
    .single()
  if (packetErr) throw packetErr
  const packet = packetData

  // ── 3) Compose + insert covering acks ───────────────────────
  const { subHashes, envelopeHash } = computeRowHashes({
    coveredTypes: covered,
    packetId: packet.id,
    attestationText,
  })

  const sharedFields = {
    provider_id: providerId,
    subject_type: 'child',
    subject_id: child.id,
    acknowledged_via: 'provider_override',
    acknowledged_by_user_id: null,
    acknowledged_by_label: null,
    provider_override_reason: overrideReason,
    packet_id: packet.id,
  }

  const subTypes = covered.filter(t => t !== ACK_TYPES.CHILD_IN_CARE_STATEMENT)
  const rows = []
  if (covered.includes(ACK_TYPES.CHILD_IN_CARE_STATEMENT)) {
    rows.push({
      ...sharedFields,
      type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      snapshot_hash: envelopeHash,
      snapshot_version: null,
    })
  }
  subTypes.forEach((t, i) => {
    rows.push({
      ...sharedFields,
      type: t,
      snapshot_hash: subHashes[i],
      snapshot_version: null,
    })
  })

  const { data: ackRows, error: ackErr } = await supabase
    .from('acknowledgments')
    .insert(rows)
    .select('id, type, packet_id, acknowledged_via')
  if (ackErr) throw ackErr

  // ── 4) Stamp intake_completed_at on the child ───────────────
  const { error: childErr } = await supabase
    .from('children')
    .update({ intake_completed_at: new Date().toISOString() })
    .eq('id', child.id)
  if (childErr) throw childErr

  return { packet, ackRows: ackRows || [] }
}

function buildSendForSigOverrideReason({ child, today }) {
  const ymd = (today || new Date().toISOString().slice(0, 10))
  return (
    `Provider attested at intake on ${ymd} via intake packet; ` +
    `parent notified to confirm via portal at ` +
    `/parent/intake-acknowledge?child=${child.id}.`
  )
}

// -----------------------------------------------------------------------------
// path (b) — upload signed copy
// -----------------------------------------------------------------------------

/**
 * Create an `uploaded_signed_copy` packet, upload the artifact, and
 * insert the covering acks — IN THAT ORDER. The guardrail is
 * enforced here:
 *
 *   - file MUST validate (validateFile from shared storage).
 *   - storage.upload + consent_attachments.insert MUST succeed
 *     BEFORE the covering ack rows are written. A failure at either
 *     of those steps throws and the ack-write step never runs.
 *   - signedByLabel (parent's name) is required for the
 *     in_person_paper channel (acknowledgments_channel_shape
 *     CHECK enforces it at the DB layer too).
 *
 * Write sequence:
 *   1. validate inputs (file, label, coverage).
 *   2. Archive existing active acks for the covered types.
 *   3. Insert intake_packets (status='signed' immediately —
 *      signed_via='in_person_paper' satisfies the signed-shape
 *      CHECK; the attachment-exists guardrail is enforced in JS
 *      below).
 *   4. Upload file → storage.upload.
 *   5. Insert consent_attachments row (target_type='intake_packet',
 *      target_id=packet.id). ── THE GUARDRAIL: if either 4 or 5
 *      fails, we throw BEFORE the ack write below.
 *   6. Insert covering acks with acknowledged_via='in_person_paper'
 *      + packet_id stamped.
 *   7. Stamp children.intake_completed_at.
 *
 * On step 3 success but step 4/5 failure: the packet exists with
 * status='signed' but no attachment. Compensation: archive the
 * packet (status='archived', archived_at=now()) so the per-child
 * unique-active index frees up for a retry. The user sees an
 * error and can re-submit.
 */
export async function saveUploadedPacket({
  providerId,
  child,
  profile,
  file,
  signedByLabel,
  coveredTypes,
  attestationText,
  today,
}) {
  validatePacketWriteInputs({ providerId, child, coveredTypes })

  if (!file) {
    throw new Error('saveUploadedPacket: file is required (guardrail — no artifact, no ack rows)')
  }
  const fileCheck = validateFile(file)
  if (!fileCheck.ok) throw new Error(`saveUploadedPacket: ${fileCheck.reason}`)

  if (!signedByLabel || !signedByLabel.trim()) {
    throw new Error('saveUploadedPacket: signedByLabel is required for in_person_paper channel')
  }

  const covered = filterToRequired({ coveredTypes, child, profile, today })
  if (covered.length === 0) {
    throw new Error('saveUploadedPacket: no required elements selected for coverage')
  }

  const trimmedLabel = signedByLabel.trim()

  // ── 1) Archive existing acks for the covered types ───────────
  await archiveExistingActiveAcks({ providerId, childId: child.id, types: covered })

  // ── 2) Insert the packet row (status='signed' — signed_via +
  //       signed_at satisfy the signed-shape CHECK).
  const signedAtIso = new Date().toISOString()
  const { data: packet, error: packetErr } = await supabase
    .from('intake_packets')
    .insert({
      provider_id: providerId,
      subject_type: 'child',
      subject_id: child.id,
      source: 'uploaded_signed_copy',
      status: 'signed',
      signed_via: 'in_person_paper',
      signed_at: signedAtIso,
      signed_by_user_id: null,
      signed_by_label: trimmedLabel,
      attestation_text: attestationText || null,
    })
    .select('id, status, source')
    .single()
  if (packetErr) throw packetErr

  // ── 3) Upload artifact + insert consent_attachments row.
  //       THIS IS THE GUARDRAIL. If either step fails, we
  //       compensate the packet (archive it) and throw before
  //       any ack row is written.
  let storagePath = null
  try {
    storagePath = buildConsentAttachmentPath({
      providerUserId: providerId,
      targetId: packet.id,
      file,
    })
    const { error: upErr } = await supabase.storage
      .from(CONSENT_ATTACHMENTS_BUCKET)
      .upload(storagePath, file, {
        contentType: file.type || 'application/octet-stream',
      })
    if (upErr) throw upErr

    const { error: attachErr } = await supabase
      .from('consent_attachments')
      .insert({
        provider_id: providerId,
        target_type: 'intake_packet',
        target_id: packet.id,
        storage_path: storagePath,
        original_filename: file.name,
        content_type: file.type || 'application/octet-stream',
        file_size_bytes: file.size,
        uploaded_by_user_id: providerId,
        retention_until: defaultConsentRetentionUntil(),
      })
    if (attachErr) throw attachErr
  } catch (e) {
    // Compensate: archive the orphaned packet. Best-effort cleanup
    // of the uploaded object if we got that far.
    if (storagePath) {
      await supabase.storage
        .from(CONSENT_ATTACHMENTS_BUCKET)
        .remove([storagePath])
        .catch(() => {})
    }
    await supabase
      .from('intake_packets')
      .update({
        status: 'archived',
        archived_at: new Date().toISOString(),
      })
      .eq('id', packet.id)
      .then(() => {}, () => {})
    throw e
  }

  // ── 4) Compose + insert covering acks (in_person_paper channel) ──
  const { subHashes, envelopeHash } = computeRowHashes({
    coveredTypes: covered,
    packetId: packet.id,
    attestationText,
  })

  const sharedFields = {
    provider_id: providerId,
    subject_type: 'child',
    subject_id: child.id,
    acknowledged_via: 'in_person_paper',
    acknowledged_by_user_id: null,
    acknowledged_by_label: trimmedLabel,
    acknowledged_at: signedAtIso,
    provider_override_reason: null,
    packet_id: packet.id,
  }

  const subTypes = covered.filter(t => t !== ACK_TYPES.CHILD_IN_CARE_STATEMENT)
  const rows = []
  if (covered.includes(ACK_TYPES.CHILD_IN_CARE_STATEMENT)) {
    rows.push({
      ...sharedFields,
      type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      snapshot_hash: envelopeHash,
      snapshot_version: null,
    })
  }
  subTypes.forEach((t, i) => {
    rows.push({
      ...sharedFields,
      type: t,
      snapshot_hash: subHashes[i],
      snapshot_version: null,
    })
  })

  const { data: ackRows, error: ackErr } = await supabase
    .from('acknowledgments')
    .insert(rows)
    .select('id, type, packet_id, acknowledged_via')
  if (ackErr) throw ackErr

  // ── 5) Stamp intake_completed_at on the child ───────────────
  const { error: childErr } = await supabase
    .from('children')
    .update({ intake_completed_at: signedAtIso })
    .eq('id', child.id)
  if (childErr) throw childErr

  return { packet, ackRows: ackRows || [] }
}

// -----------------------------------------------------------------------------
// Parent side — completes path (a)
// -----------------------------------------------------------------------------

/**
 * Look up the active pending packet (if any) for this child so the
 * parent portal can pick the right RPC to call. Returns null when
 * no packet exists (the caller falls back to the legacy
 * intake_confirm_for_parent path — no behaviour change for
 * pre-041 send-to-portal sessions).
 */
export async function findPendingPacketForChild(childId) {
  if (!childId) return null
  const { data, error } = await supabase
    .from('intake_packets')
    .select('id, status, source, subject_id, signed_via, signed_at, snapshot_hash')
    .eq('subject_id', childId)
    .eq('status', 'pending_parent')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return data || null
}

/**
 * Confirm a packet on the parent's behalf via the SECURITY DEFINER
 * RPC. Thin wrapper so the page-level code reads cleanly.
 */
export async function confirmIntakePacketAsParent({ childId, packetId, rows }) {
  if (!childId) throw new Error('confirmIntakePacketAsParent: childId required')
  if (!packetId) throw new Error('confirmIntakePacketAsParent: packetId required')
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('confirmIntakePacketAsParent: rows must be a non-empty array')
  }
  const { data, error } = await supabase.rpc('intake_packet_confirm_for_parent', {
    p_child_id: childId,
    p_packet_id: packetId,
    p_rows: rows,
  })
  if (error) throw error
  return data
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function validatePacketWriteInputs({ providerId, child, coveredTypes }) {
  if (!providerId) throw new Error('packet write: providerId is required')
  if (!child || !child.id) throw new Error('packet write: child with id is required')
  if (!Array.isArray(coveredTypes) || coveredTypes.length === 0) {
    throw new Error('packet write: coveredTypes must be a non-empty array')
  }
  for (const t of coveredTypes) {
    if (!INTAKE_PACKET_COVERABLE_TYPES.includes(t)) {
      throw new Error(`packet write: ${t} is not a coverable intake element`)
    }
  }
}

function filterToRequired({ coveredTypes, child, profile, today }) {
  const allowed = new Set(packetCoverableForChild({ child, profile, today }))
  return coveredTypes.filter(t => allowed.has(t))
}

async function archiveExistingActiveAcks({ providerId, childId, types }) {
  if (types.length === 0) return
  const nowIso = new Date().toISOString()
  // Two queries (active acks → archive by id) rather than a single
  // .update().eq().in() because PostgREST .in() on .update() carries
  // a 1k-id cap we don't want to silently lean on. The intake
  // bundle's working set is ≤ 9 rows, so this is fast.
  const { data, error } = await supabase
    .from('acknowledgments')
    .select('id')
    .eq('provider_id', providerId)
    .eq('subject_type', 'child')
    .eq('subject_id', childId)
    .in('type', types)
    .is('archived_at', null)
  if (error) throw error
  const ids = (data || []).map(r => r.id)
  if (ids.length === 0) return
  const { error: archiveErr } = await supabase
    .from('acknowledgments')
    .update({ archived_at: nowIso })
    .in('id', ids)
  if (archiveErr) throw archiveErr
}
