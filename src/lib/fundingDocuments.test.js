import { describe, it, expect } from 'vitest'
import {
  validateFile,
  buildStoragePath,
  defaultRetentionUntil,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
  REJECTION_REASONS,
} from './fundingDocuments'

// File-like fixture: validateFile / buildStoragePath only read .name,
// .size, .type — no need to construct a real File object.
const fakeFile = ({ name = 'doc.pdf', size = 1024, type = 'application/pdf' } = {}) => ({
  name,
  size,
  type,
})

// -----------------------------------------------------------------------------
// validateFile
// -----------------------------------------------------------------------------

describe('validateFile', () => {
  describe('accepts allowed types', () => {
    it.each([
      ['PDF',  { name: 'dhs198.pdf',          type: 'application/pdf' }],
      ['JPEG', { name: 'photo.jpg',           type: 'image/jpeg' }],
      ['PNG',  { name: 'screenshot.png',      type: 'image/png' }],
      ['HEIC', { name: 'iphone-photo.heic',   type: 'image/heic' }],
      ['HEIF', { name: 'iphone-photo.heif',   type: 'image/heif' }],
    ])('accepts %s by MIME type', (_label, props) => {
      expect(validateFile(fakeFile(props)).ok).toBe(true)
    })

    it('accepts a HEIC by extension when MIME is empty (iOS Safari quirk)', () => {
      expect(validateFile(fakeFile({ name: 'photo.HEIC', type: '' })).ok).toBe(true)
    })

    it('accepts a HEIC by extension when MIME is application/octet-stream', () => {
      expect(
        validateFile(fakeFile({ name: 'photo.heic', type: 'application/octet-stream' }))
          .ok
      ).toBe(true)
    })

    it('is case-insensitive on the extension', () => {
      expect(validateFile(fakeFile({ name: 'doc.PDF', type: '' })).ok).toBe(true)
    })
  })

  describe('rejects disallowed types', () => {
    it('rejects a Word doc with the friendly export-to-PDF hint', () => {
      const result = validateFile(
        fakeFile({ name: 'agreement.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe(REJECTION_REASONS.WRONG_TYPE)
      expect(result.reason).toMatch(/export.*PDF/i)
    })

    it('rejects a totally unknown MIME with no matching extension', () => {
      const result = validateFile(fakeFile({ name: 'thing.xyz', type: 'application/x-bizarre' }))
      expect(result.ok).toBe(false)
      expect(result.reason).toBe(REJECTION_REASONS.WRONG_TYPE)
    })
  })

  describe('size limits', () => {
    it('accepts a file at exactly the size cap', () => {
      expect(validateFile(fakeFile({ size: MAX_FILE_SIZE_BYTES })).ok).toBe(true)
    })

    it('rejects a file one byte over the cap with size-aware messaging', () => {
      const result = validateFile(fakeFile({ size: MAX_FILE_SIZE_BYTES + 1 }))
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(new RegExp(`${MAX_FILE_SIZE_MB} MB`))
    })

    it('rejects a 0-byte file', () => {
      const result = validateFile(fakeFile({ size: 0 }))
      expect(result.ok).toBe(false)
      expect(result.reason).toBe(REJECTION_REASONS.EMPTY)
    })
  })

  describe('missing input', () => {
    it('rejects null', () => {
      const result = validateFile(null)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe(REJECTION_REASONS.NO_FILE)
    })

    it('rejects undefined', () => {
      const result = validateFile(undefined)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe(REJECTION_REASONS.NO_FILE)
    })
  })
})

// -----------------------------------------------------------------------------
// buildStoragePath
// -----------------------------------------------------------------------------

describe('buildStoragePath', () => {
  const userId = '00000000-0000-0000-0000-00000000aaaa'
  const fundingSourceId = '00000000-0000-0000-0000-00000000bbbb'

  it('returns a three-segment path', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'dhs198.pdf' }),
    })
    expect(path.split('/')).toHaveLength(3)
  })

  it('starts with the user_id segment (storage RLS depends on this)', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'dhs198.pdf' }),
    })
    expect(path.startsWith(`${userId}/`)).toBe(true)
  })

  it('places funding_source_id as the second segment', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'dhs198.pdf' }),
    })
    expect(path.split('/')[1]).toBe(fundingSourceId)
  })

  it('preserves the file extension', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'dhs198.pdf' }),
    })
    expect(path.endsWith('.pdf')).toBe(true)
  })

  it('lowercases the extension', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'Photo.HEIC' }),
    })
    expect(path.endsWith('.heic')).toBe(true)
  })

  it('falls back to .bin when filename has no extension', () => {
    const path = buildStoragePath({
      userId,
      fundingSourceId,
      file: fakeFile({ name: 'no-extension' }),
    })
    expect(path.endsWith('.bin')).toBe(true)
  })

  it('generates a unique third segment on each call', () => {
    const a = buildStoragePath({ userId, fundingSourceId, file: fakeFile() })
    const b = buildStoragePath({ userId, fundingSourceId, file: fakeFile() })
    expect(a).not.toBe(b)
    expect(a.split('/')[2]).not.toBe(b.split('/')[2])
  })

  it('throws when userId is missing', () => {
    expect(() =>
      buildStoragePath({ fundingSourceId, file: fakeFile() })
    ).toThrow(/userId/)
  })

  it('throws when fundingSourceId is missing', () => {
    expect(() =>
      buildStoragePath({ userId, file: fakeFile() })
    ).toThrow(/fundingSourceId/)
  })

  it('throws when file or filename is missing', () => {
    expect(() => buildStoragePath({ userId, fundingSourceId })).toThrow(/file/)
    expect(() =>
      buildStoragePath({ userId, fundingSourceId, file: { size: 100 } })
    ).toThrow(/file/)
  })
})

// -----------------------------------------------------------------------------
// defaultRetentionUntil
// -----------------------------------------------------------------------------

describe('defaultRetentionUntil', () => {
  it('returns YYYY-MM-DD format', () => {
    const out = defaultRetentionUntil(new Date(2026, 4, 13))
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns the date exactly 4 years after the input', () => {
    expect(defaultRetentionUntil(new Date(2026, 4, 13))).toBe('2030-05-13')
  })

  it('handles January correctly (no off-by-one on month)', () => {
    expect(defaultRetentionUntil(new Date(2026, 0, 1))).toBe('2030-01-01')
  })

  it('handles December correctly (no overflow)', () => {
    expect(defaultRetentionUntil(new Date(2026, 11, 31))).toBe('2030-12-31')
  })

  it('handles Feb 29 in a leap year + 4 (target is also a leap year)', () => {
    // 2024 leap; 2028 also leap.
    expect(defaultRetentionUntil(new Date(2024, 1, 29))).toBe('2028-02-29')
  })

  it('handles Feb 29 + 4 when target year is non-leap (century rule)', () => {
    // 2096 leap; 2100 century-non-leap. Should back off to Feb 28 2100.
    expect(defaultRetentionUntil(new Date(2096, 1, 29))).toBe('2100-02-28')
  })

  it('uses now() as default input', () => {
    const before = new Date()
    const got = defaultRetentionUntil()
    const after = new Date()
    const gotYear = Number(got.slice(0, 4))
    expect(gotYear).toBeGreaterThanOrEqual(before.getFullYear() + 4)
    expect(gotYear).toBeLessThanOrEqual(after.getFullYear() + 4)
  })
})
