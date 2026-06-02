import { describe, it, expect } from 'vitest'
import { _internals_for_test } from './consent-attachment-url.js'

const { resolveChildIdSync } = _internals_for_test

// These tests cover the JS-pure branching the Edge Function uses to
// resolve an attachment → child_id. The async wrapper around this
// (`resolveChildIdFromAttachment`) glues it to Supabase REST and is
// exercised live via the runbook's three-test verification gate;
// the pure logic below is the unit surface.
//
// The privacy boundary itself (parent_family_links check) lives in
// the handler and runs against real auth — it cannot be unit-tested
// without a JWT issuer + service-role. That's why the runbook's
// cross-tenant test is the gate.

describe('resolveChildIdSync — Edge Function branch logic', () => {
  it('attachment is null → null', () => {
    expect(resolveChildIdSync({ attachment: null })).toBeNull()
    expect(resolveChildIdSync({})).toBeNull()
  })

  // ── target_type='acknowledgment' branch ──

  describe('target_type=acknowledgment', () => {
    const attachment = { target_type: 'acknowledgment', target_id: 'A1' }

    it('ack missing → null (orphan attachment)', () => {
      expect(resolveChildIdSync({ attachment, ack: null })).toBeNull()
    })

    it('ack archived → null (archived consents don\'t surface attachments)', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'child', subject_id: 'C1', archived_at: '2026-06-01T00:00:00Z' },
      })).toBeNull()
    })

    it('ack.subject_type=child → returns ack.subject_id directly', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'child', subject_id: 'C1', archived_at: null },
      })).toBe('C1')
    })

    it('ack.subject_type=medication_authorization → joins through medAuth.child_id', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'medication_authorization', subject_id: 'M1', archived_at: null },
        medAuth: { id: 'M1', child_id: 'C2', archived_at: null },
      })).toBe('C2')
    })

    it('ack.subject_type=medication_authorization with medAuth archived → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'medication_authorization', subject_id: 'M1', archived_at: null },
        medAuth: { id: 'M1', child_id: 'C2', archived_at: '2026-06-01T00:00:00Z' },
      })).toBeNull()
    })

    it('ack.subject_type=medication_authorization with medAuth missing → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'medication_authorization', subject_id: 'M1', archived_at: null },
        medAuth: null,
      })).toBeNull()
    })

    // CRITICAL DENIAL CASES — these mirror the parent-side
    // SELECT policy in migration 029 which only grants parent
    // access to subject_type='child' or 'medication_authorization'.

    it('ack.subject_type=caregiver → null (not parent-visible)', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'caregiver', subject_id: 'X', archived_at: null },
      })).toBeNull()
    })

    it('ack.subject_type=family → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'family', subject_id: 'X', archived_at: null },
      })).toBeNull()
    })

    it('ack.subject_type=provider → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'provider', subject_id: 'X', archived_at: null },
      })).toBeNull()
    })

    it('ack.subject_type=null → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: null, subject_id: null, archived_at: null },
      })).toBeNull()
    })

    it('ack.subject_type=arbitrary-unknown → null', () => {
      expect(resolveChildIdSync({
        attachment,
        ack: { id: 'A1', subject_type: 'never-seen-before', subject_id: 'X', archived_at: null },
      })).toBeNull()
    })
  })

  // ── target_type='medication_authorization' branch ──

  describe('target_type=medication_authorization (direct)', () => {
    const attachment = { target_type: 'medication_authorization', target_id: 'M1' }

    it('medAuth present, non-archived → returns medAuth.child_id', () => {
      expect(resolveChildIdSync({
        attachment,
        medAuth: { id: 'M1', child_id: 'C3', archived_at: null },
      })).toBe('C3')
    })

    it('medAuth archived → null', () => {
      expect(resolveChildIdSync({
        attachment,
        medAuth: { id: 'M1', child_id: 'C3', archived_at: '2026-06-01T00:00:00Z' },
      })).toBeNull()
    })

    it('medAuth missing → null (orphan attachment)', () => {
      expect(resolveChildIdSync({ attachment, medAuth: null })).toBeNull()
    })

    it('medAuth without child_id → null', () => {
      expect(resolveChildIdSync({
        attachment,
        medAuth: { id: 'M1', child_id: null, archived_at: null },
      })).toBeNull()
    })
  })

  // ── unknown / future target_type ──

  describe('target_type unrecognized (defensive)', () => {
    it('any unknown target_type → null even with rows supplied', () => {
      expect(resolveChildIdSync({
        attachment: { target_type: 'trip', target_id: 'X' },
        ack: { id: 'A1', subject_type: 'child', subject_id: 'C1', archived_at: null },
        medAuth: { id: 'M1', child_id: 'C2', archived_at: null },
      })).toBeNull()
    })
  })
})
