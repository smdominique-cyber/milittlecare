import { describe, it, expect } from 'vitest'
import { _internals_for_test } from './consent-attachment-url.js'

const { resolveChildIdSync, isValidStoragePath } = _internals_for_test

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

// ─── Part 2 hardening — isValidStoragePath shape guard ──────────────
//
// Per the Part 1 audit (theoretical path-traversal vector): before
// minting a signed URL, the Edge Function validates that storage_path
// matches the exact shape the upload helper produces:
//   <providerUuid>/<targetUuid>/<uuid>.<ext>
// Three lowercase-hex UUID segments + a short lowercase extension. No
// '..', no leading '/', no extra segments, no mixed case.
//
// A row whose storage_path doesn't match → mintSignedUrl returns
// null → handler returns 404. The shape check makes the theoretical
// path-traversal class unreachable from the parent surface.

describe('isValidStoragePath — Part 2 hardening (path-traversal guard)', () => {
  const validUuid = '12345678-1234-1234-1234-123456789abc'
  const okPath = `${validUuid}/${validUuid}/${validUuid}.pdf`

  it('accepts the canonical shape: <uuid>/<uuid>/<uuid>.<ext>', () => {
    expect(isValidStoragePath(okPath)).toBe(true)
  })

  it('accepts each allowed extension shape', () => {
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.jpg`)).toBe(true)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.jpeg`)).toBe(true)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.png`)).toBe(true)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.heic`)).toBe(true)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.heif`)).toBe(true)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.bin`)).toBe(true)
  })

  it('rejects path traversal via ".."', () => {
    expect(isValidStoragePath('../receipts/file.jpg')).toBe(false)
    expect(isValidStoragePath(`${validUuid}/../${validUuid}/${validUuid}.pdf`)).toBe(false)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/../${validUuid}.pdf`)).toBe(false)
  })

  it('rejects a leading slash', () => {
    expect(isValidStoragePath(`/${validUuid}/${validUuid}/${validUuid}.pdf`)).toBe(false)
  })

  it('rejects extra segments', () => {
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}/${validUuid}.pdf`)).toBe(false)
  })

  it('rejects missing segments', () => {
    expect(isValidStoragePath(`${validUuid}/${validUuid}.pdf`)).toBe(false)
    expect(isValidStoragePath(`${validUuid}.pdf`)).toBe(false)
  })

  it('rejects non-lowercase hex in segments (UUIDs are normalized to lowercase)', () => {
    const upperUuid = '12345678-1234-1234-1234-123456789ABC'
    expect(isValidStoragePath(`${upperUuid}/${validUuid}/${validUuid}.pdf`)).toBe(false)
  })

  it('rejects missing extension', () => {
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}`)).toBe(false)
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.`)).toBe(false)
  })

  it('rejects uppercase extension', () => {
    expect(isValidStoragePath(`${validUuid}/${validUuid}/${validUuid}.PDF`)).toBe(false)
  })

  it('rejects non-string input (defensive)', () => {
    expect(isValidStoragePath(null)).toBe(false)
    expect(isValidStoragePath(undefined)).toBe(false)
    expect(isValidStoragePath(42)).toBe(false)
    expect(isValidStoragePath({})).toBe(false)
    expect(isValidStoragePath([])).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidStoragePath('')).toBe(false)
  })

  it('rejects URL-encoded traversal attempts', () => {
    // Even if the attacker manages to insert URL-encoded path
    // segments into storage_path, the regex requires literal
    // hyphens and hex — `%2e%2e` doesn't match the UUID shape.
    expect(isValidStoragePath(`${validUuid}/%2e%2e/${validUuid}.pdf`)).toBe(false)
  })

  it('rejects bucket-prefix injection', () => {
    expect(isValidStoragePath(`receipts/${validUuid}/${validUuid}.pdf`)).toBe(false)
  })
})
