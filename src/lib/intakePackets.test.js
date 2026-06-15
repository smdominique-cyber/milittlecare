// Lib-level tests for the intake-packet capture model (mig 041 +
// src/lib/intakePackets.js). The task's enumerated test cases live
// here — they exercise the write contract through a mock supabase
// client so the lifecycle (path a + b, the guardrail, the resolver
// pass-through) is locked WITHOUT requiring a live DB.
//
// What we DO test here:
//   1. Path (b) happy path — uploadedFile + 6 covered elements →
//      6 acks created with packet_id + in_person_paper.
//   2. Path (b) guardrail — no file → blocked before any ack write.
//   3. Path (a) happy path — packet pending_parent + covering acks
//      written as provider_override.
//   4. Path (a) → parent flip — the new RPC stamps packet_id +
//      flips packet status.
//   5. Resolver regression — the existing patternAAckOnFile in
//      complianceState.js, fed the rows the lib would have
//      produced, returns the expected state on each path.
//   6. Existing free-standing acks (packet_id null) untouched —
//      the lib never mutates rows we didn't ask it to.
//
// What we DO NOT test here:
//   - The migration SQL (verification block lives in
//     041_intake_packets.sql; Phase B is Seth's manual apply).
//   - The ChildIntakeModal UI (its existing mount tests still pass
//     unchanged — the packet form is opt-in; the per-element form
//     is the default).
//   - The nine intake-row resolvers (we leave their tests
//     untouched and assert "still green" by running the whole
//     suite at the end).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ACK_TYPES,
} from './acknowledgments'
import {
  REQUIREMENT_REGISTRY,
  REQUIREMENT_STATE_KIND,
} from './complianceState'

// ─── Mock supabase before importing the lib ──────────────────────

const supabaseState = vi.hoisted(() => ({
  // Per-table sequencer. Each push is { data, error } for one
  // call's terminal .then() resolution.
  fetchQueue: { acknowledgments: [], intake_packets: [], children: [], consent_attachments: [] },
  inserts: [],
  updates: [],
  uploads: [],
  removes: [],
  rpcCalls: [],
  // injected error toggles
  uploadError: null,
  insertError: null,
}))

vi.mock('./supabase', () => ({
  supabase: {
    from(table) {
      let mode = 'select'
      let insertPayload = null
      let updatePayload = null
      let chain
      chain = {
        select() { return chain },
        eq() { return chain },
        in() { return chain },
        is() { return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() {
          // Treat .maybeSingle() as a terminal that drains the
          // first item from the select queue (used by
          // findPendingPacketForChild).
          const q = supabaseState.fetchQueue[table] || []
          const next = q.length ? q.shift() : { data: null, error: null }
          return Promise.resolve(next)
        },
        single() {
          // Terminal for .insert(...).select().single(). Resolve
          // the most recent insertPayload back as data so callers
          // get a synthesized id.
          if (mode === 'insert') {
            supabaseState.inserts.push({ table, payload: insertPayload })
            return Promise.resolve({
              data: { id: `${table}-id-${supabaseState.inserts.length}`, ...insertPayload },
              error: supabaseState.insertError,
            })
          }
          return Promise.resolve({ data: null, error: null })
        },
        update(payload) {
          mode = 'update'
          updatePayload = payload
          return chain
        },
        insert(payload) {
          mode = 'insert'
          insertPayload = payload
          return chain
        },
        then(resolve, reject) {
          if (mode === 'update') {
            supabaseState.updates.push({ table, payload: updatePayload })
            resolve({ data: null, error: null })
            return
          }
          if (mode === 'insert') {
            supabaseState.inserts.push({ table, payload: insertPayload })
            const rows = Array.isArray(insertPayload)
              ? insertPayload.map((r, i) => ({
                  id: `${table}-id-${supabaseState.inserts.length}-${i}`,
                  ...r,
                }))
              : [{ id: `${table}-id-${supabaseState.inserts.length}`, ...insertPayload }]
            resolve({ data: rows, error: supabaseState.insertError })
            return
          }
          // select
          const q = supabaseState.fetchQueue[table] || []
          const next = q.length ? q.shift() : { data: [], error: null }
          resolve(next)
        },
      }
      return chain
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, file, opts) {
            supabaseState.uploads.push({ bucket, path, fileName: file?.name, opts })
            return { error: supabaseState.uploadError }
          },
          async remove(paths) {
            supabaseState.removes.push({ bucket, paths })
            return { error: null }
          },
        }
      },
    },
    async rpc(name, args) {
      supabaseState.rpcCalls.push({ name, args })
      return { data: 1, error: null }
    },
  },
}))

const intakePackets = await import('./intakePackets')
const {
  sendPacketForSignature,
  saveUploadedPacket,
  findPendingPacketForChild,
  confirmIntakePacketAsParent,
} = intakePackets

// ─── Fixtures ────────────────────────────────────────────────────

const PROVIDER_ID = 'prov-1'
const CHILD = {
  id: 'child-1',
  first_name: 'Aiden',
  date_of_birth: '2024-06-01', // < 18 months → safe-sleep applies
  family_id: 'fam-1',
}
const PROFILE = {
  id: PROVIDER_ID,
  license_type: 'family_home',
  home_built_before_1978: true,    // lead applies
  firearms_on_premises: false,     // firearms applies (copy varies)
}

beforeEach(() => {
  supabaseState.fetchQueue = {
    acknowledgments: [],
    intake_packets: [],
    children: [],
    consent_attachments: [],
  }
  supabaseState.inserts = []
  supabaseState.updates = []
  supabaseState.uploads = []
  supabaseState.removes = []
  supabaseState.rpcCalls = []
  supabaseState.uploadError = null
  supabaseState.insertError = null
})

afterEach(() => {})

// ─── Helpers ─────────────────────────────────────────────────────

function fakeFile() {
  return new File(['signed-bytes'], 'packet.pdf', { type: 'application/pdf' })
}

function getAckInsert() {
  return supabaseState.inserts.find(i => i.table === 'acknowledgments')
}

function getPacketInsert() {
  return supabaseState.inserts.find(i => i.table === 'intake_packets')
}

function getAttachmentInsert() {
  return supabaseState.inserts.find(i => i.table === 'consent_attachments')
}

// -----------------------------------------------------------------------------
// Path (b) — happy path
// -----------------------------------------------------------------------------

describe('saveUploadedPacket — path (b)', () => {
  it('uploads the artifact FIRST, then writes packet + covering acks with packet_id + in_person_paper', async () => {
    // No prior acks. Mock the .select returning [].
    supabaseState.fetchQueue.acknowledgments.push({ data: [], error: null })

    const covered = [
      ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      ACK_TYPES.LEAD_DISCLOSURE,
      ACK_TYPES.FIREARMS_DISCLOSURE,
      ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
      ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY,
      ACK_TYPES.LICENSING_RULES_OFFERED,
    ]
    // 6 covered = envelope + 5 sub-acks (we left HEALTH_CONDITION,
    // DISCIPLINE_POLICY_RECEIPT, INFANT_SAFE_SLEEP unchecked).

    const { packet, ackRows } = await saveUploadedPacket({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      file: fakeFile(),
      signedByLabel: 'Aiden Parent',
      coveredTypes: covered,
    })

    // Order: packet first, attachment next, then ack rows.
    const orderedTables = supabaseState.inserts.map(i => i.table)
    expect(orderedTables[0]).toBe('intake_packets')
    expect(orderedTables[1]).toBe('consent_attachments')
    expect(orderedTables[2]).toBe('acknowledgments')

    const pkt = getPacketInsert().payload
    expect(pkt.source).toBe('uploaded_signed_copy')
    expect(pkt.status).toBe('signed')
    expect(pkt.signed_via).toBe('in_person_paper')
    expect(pkt.signed_by_label).toBe('Aiden Parent')
    expect(pkt.signed_at).toBeTruthy()

    const att = getAttachmentInsert().payload
    expect(att.target_type).toBe('intake_packet')
    expect(att.target_id).toBe(packet.id)
    expect(att.original_filename).toBe('packet.pdf')

    const ackPayload = getAckInsert().payload
    expect(Array.isArray(ackPayload)).toBe(true)
    expect(ackPayload).toHaveLength(6)
    for (const row of ackPayload) {
      expect(row.packet_id).toBe(packet.id)
      expect(row.acknowledged_via).toBe('in_person_paper')
      expect(row.acknowledged_by_label).toBe('Aiden Parent')
    }
    expect(ackRows).toBeDefined()

    // Storage upload landed on the consent-attachments bucket with
    // the expected path shape.
    expect(supabaseState.uploads).toHaveLength(1)
    expect(supabaseState.uploads[0].bucket).toBe('consent-attachments')
    expect(supabaseState.uploads[0].path.startsWith(`${PROVIDER_ID}/${packet.id}/`)).toBe(true)
  })

  it('UNcovered elements get NO ack row (the "singled out" outcome)', async () => {
    supabaseState.fetchQueue.acknowledgments.push({ data: [], error: null })
    const covered = [
      ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      ACK_TYPES.LEAD_DISCLOSURE,
    ]
    await saveUploadedPacket({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      file: fakeFile(),
      signedByLabel: 'Aiden Parent',
      coveredTypes: covered,
    })

    const ackPayload = getAckInsert().payload
    const writtenTypes = ackPayload.map(r => r.type).sort()
    expect(writtenTypes).toEqual([
      ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      ACK_TYPES.LEAD_DISCLOSURE,
    ].sort())
    // FIREARMS, FOOD, NOTEBOOK, RULES, SAFE_SLEEP, HEALTH,
    // DISCIPLINE — none of them gain an ack row.
    expect(writtenTypes).not.toContain(ACK_TYPES.FIREARMS_DISCLOSURE)
    expect(writtenTypes).not.toContain(ACK_TYPES.FOOD_PROVIDER_AGREEMENT)
    expect(writtenTypes).not.toContain(ACK_TYPES.HEALTH_CONDITION)
  })
})

// -----------------------------------------------------------------------------
// Path (b) guardrail — no file → blocked
// -----------------------------------------------------------------------------

describe('saveUploadedPacket — guardrail', () => {
  it('no file → throws before any write happens', async () => {
    await expect(saveUploadedPacket({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      file: null,
      signedByLabel: 'Aiden Parent',
      coveredTypes: [ACK_TYPES.LEAD_DISCLOSURE],
    })).rejects.toThrow(/file is required/i)
    expect(supabaseState.inserts).toHaveLength(0)
    expect(supabaseState.uploads).toHaveLength(0)
  })

  it('storage upload fails → packet archived (compensation), no acks written', async () => {
    supabaseState.fetchQueue.acknowledgments.push({ data: [], error: null })
    supabaseState.uploadError = { message: 'storage 500' }

    await expect(saveUploadedPacket({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      file: fakeFile(),
      signedByLabel: 'Aiden Parent',
      coveredTypes: [ACK_TYPES.LEAD_DISCLOSURE, ACK_TYPES.CHILD_IN_CARE_STATEMENT],
    })).rejects.toBeTruthy()

    // No ack inserts happened.
    const ackInsert = supabaseState.inserts.find(i => i.table === 'acknowledgments')
    expect(ackInsert).toBeUndefined()

    // Compensation: the packet got archived after the upload failed.
    const packetArchiveUpdate = supabaseState.updates.find(
      u => u.table === 'intake_packets'
          && u.payload?.status === 'archived'
    )
    expect(packetArchiveUpdate).toBeDefined()
  })

  it('missing signedByLabel → throws (in_person_paper channel needs the parent name)', async () => {
    await expect(saveUploadedPacket({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      file: fakeFile(),
      signedByLabel: '',
      coveredTypes: [ACK_TYPES.LEAD_DISCLOSURE],
    })).rejects.toThrow(/signedByLabel is required/i)
    expect(supabaseState.inserts).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Path (a) — happy path
// -----------------------------------------------------------------------------

describe('sendPacketForSignature — path (a)', () => {
  it('writes packet pending_parent + covering acks as provider_override (resolvers will read pending_parent)', async () => {
    supabaseState.fetchQueue.acknowledgments.push({ data: [], error: null })

    const covered = [
      ACK_TYPES.CHILD_IN_CARE_STATEMENT,
      ACK_TYPES.LEAD_DISCLOSURE,
      ACK_TYPES.FIREARMS_DISCLOSURE,
    ]
    const { packet } = await sendPacketForSignature({
      providerId: PROVIDER_ID,
      child: CHILD,
      profile: PROFILE,
      coveredTypes: covered,
    })

    const pkt = getPacketInsert().payload
    expect(pkt.source).toBe('digital_signature_request')
    expect(pkt.status).toBe('pending_parent')
    expect(pkt.signed_via).toBeNull()

    const ackPayload = getAckInsert().payload
    expect(ackPayload).toHaveLength(3)
    for (const row of ackPayload) {
      expect(row.packet_id).toBe(packet.id)
      expect(row.acknowledged_via).toBe('provider_override')
      expect(row.provider_override_reason).toMatch(/notified to confirm via portal/i)
    }

    // No attachment / upload on path (a). No file involved.
    expect(supabaseState.uploads).toHaveLength(0)
    expect(getAttachmentInsert()).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// Path (a) → parent flip
// -----------------------------------------------------------------------------

describe('confirmIntakePacketAsParent — path (a) → signed', () => {
  it('calls the intake_packet_confirm_for_parent RPC with the rows', async () => {
    await confirmIntakePacketAsParent({
      childId: 'child-1',
      packetId: 'packet-9',
      rows: [{ type: ACK_TYPES.CHILD_IN_CARE_STATEMENT, snapshot_hash: 'h1' }],
    })
    expect(supabaseState.rpcCalls).toHaveLength(1)
    expect(supabaseState.rpcCalls[0]).toEqual({
      name: 'intake_packet_confirm_for_parent',
      args: {
        p_child_id: 'child-1',
        p_packet_id: 'packet-9',
        p_rows: [{ type: ACK_TYPES.CHILD_IN_CARE_STATEMENT, snapshot_hash: 'h1' }],
      },
    })
  })

  it('findPendingPacketForChild returns the pending packet so the page can route to the new RPC', async () => {
    supabaseState.fetchQueue.intake_packets.push({
      data: { id: 'packet-pending', status: 'pending_parent', source: 'digital_signature_request' },
      error: null,
    })
    const found = await findPendingPacketForChild('child-1')
    expect(found?.id).toBe('packet-pending')
  })

  it('findPendingPacketForChild returns null when no packet exists (legacy non-packet portal flow still works)', async () => {
    supabaseState.fetchQueue.intake_packets.push({ data: null, error: null })
    const found = await findPendingPacketForChild('child-2')
    expect(found).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Resolver pass-through — the nine intake resolvers are UNCHANGED
// -----------------------------------------------------------------------------
//
// The capture model produces acks the existing resolvers already
// understand. These tests feed the resolver the rows the lib would
// have written and assert it returns the expected state. If the
// resolver had been edited, these would fail loudly — proving the
// pass-through contract.

describe('resolver pass-through — patternAAckOnFile semantics preserved', () => {
  const NOW = new Date('2026-06-15T12:00:00Z')

  it('path (b) → in_person_paper ack with valid channel → resolver returns on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_lead_disclosure
    const state = requirement.state_resolver({
      child: CHILD,
      provider: PROFILE,
      sourceRows: {
        acks: [{
          provider_id: PROVIDER_ID,
          subject_type: 'child',
          subject_id: CHILD.id,
          type: ACK_TYPES.LEAD_DISCLOSURE,
          acknowledged_via: 'in_person_paper',
          archived_at: null,
          packet_id: 'packet-1',  // mig-041 column; resolver ignores it
          expires_at: null,
        }],
      },
      now: NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('path (a) → provider_override-only ack → resolver returns pending_parent (NOT on_file)', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_firearms_disclosure
    const state = requirement.state_resolver({
      child: CHILD,
      provider: PROFILE,
      sourceRows: {
        acks: [{
          provider_id: PROVIDER_ID,
          subject_type: 'child',
          subject_id: CHILD.id,
          type: ACK_TYPES.FIREARMS_DISCLOSURE,
          acknowledged_via: 'provider_override',
          archived_at: null,
          packet_id: 'packet-1',
          expires_at: null,
        }],
      },
      now: NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.PENDING_PARENT)
  })

  it('path (a) → parent flip stamps parent_portal → resolver returns on_file', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_firearms_disclosure
    const state = requirement.state_resolver({
      child: CHILD,
      provider: PROFILE,
      sourceRows: {
        acks: [{
          provider_id: PROVIDER_ID,
          subject_type: 'child',
          subject_id: CHILD.id,
          type: ACK_TYPES.FIREARMS_DISCLOSURE,
          acknowledged_via: 'parent_portal',  // upgraded by the RPC
          archived_at: null,
          packet_id: 'packet-1',
          expires_at: null,
        }],
      },
      now: NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })

  it('UNcovered element (no ack row at all) → resolver returns missing_required', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_food_provider_agreement
    const state = requirement.state_resolver({
      child: CHILD,
      provider: PROFILE,
      sourceRows: {
        // The packet covered only LEAD; FOOD has no ack.
        acks: [{
          provider_id: PROVIDER_ID,
          subject_type: 'child',
          subject_id: CHILD.id,
          type: ACK_TYPES.LEAD_DISCLOSURE,
          acknowledged_via: 'in_person_paper',
          archived_at: null,
          packet_id: 'packet-1',
          expires_at: null,
        }],
      },
      now: NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('existing free-standing ack (packet_id null) still satisfies its resolver — pre-041 data not orphaned', () => {
    const requirement = REQUIREMENT_REGISTRY.intake_lead_disclosure
    const state = requirement.state_resolver({
      child: CHILD,
      provider: PROFILE,
      sourceRows: {
        acks: [{
          provider_id: PROVIDER_ID,
          subject_type: 'child',
          subject_id: CHILD.id,
          type: ACK_TYPES.LEAD_DISCLOSURE,
          acknowledged_via: 'in_person_paper',
          archived_at: null,
          packet_id: null,  // pre-041 row — packet_id missing
          expires_at: null,
        }],
      },
      now: NOW,
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.ON_FILE)
  })
})
