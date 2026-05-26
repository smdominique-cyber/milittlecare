import { describe, it, expect } from 'vitest'
import { shouldFireLicenseStatusPrompt, needsLicenseTypeReview } from './licenseStatusPrompt'

// Readable builders.
const cdc = (overrides = {}) => ({ type: 'cdc_scholarship', ...overrides })
const profileLT = (license_type, license_type_review_needed = false) => ({
  license_type, license_type_review_needed,
})

describe('shouldFireLicenseStatusPrompt', () => {
  describe('fires', () => {
    it('CDC source + license_type null → fires', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT(null),
        savedSource: cdc(),
      })).toBe(true)
    })

    it('CDC source + license_type missing (empty profile) → fires', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: {},
        savedSource: cdc(),
      })).toBe(true)
    })

    it('CDC source + license_type set but review_needed=true → fires', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT('family_home', true),
        savedSource: cdc(),
      })).toBe(true)
    })
  })

  describe('does not fire', () => {
    it('license_type=family_home + review_needed=false → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT('family_home'),
        savedSource: cdc(),
      })).toBe(false)
    })

    it('license_type=group_home + review_needed=false → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT('group_home'),
        savedSource: cdc(),
      })).toBe(false)
    })

    it('license_type=license_exempt + review_needed=false → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT('license_exempt'),
        savedSource: cdc(),
      })).toBe(false)
    })

    it('non-CDC source (private_pay) → no fire even when unanswered', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT(null),
        savedSource: { type: 'private_pay' },
      })).toBe(false)
    })

    it('non-CDC source (tri_share) → no fire even when unanswered', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profileLT(null),
        savedSource: { type: 'tri_share' },
      })).toBe(false)
    })
  })

  describe('defensive — missing arguments', () => {
    it('no savedSource → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({ profile: profileLT(null) }))
        .toBe(false)
    })

    it('no profile → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({ savedSource: cdc() }))
        .toBe(false)
    })

    it('no arguments at all → no fire, no throw', () => {
      expect(shouldFireLicenseStatusPrompt()).toBe(false)
    })
  })
})

describe('needsLicenseTypeReview', () => {
  it('null license_type → true', () => {
    expect(needsLicenseTypeReview(profileLT(null))).toBe(true)
  })

  it('missing license_type field entirely → true', () => {
    expect(needsLicenseTypeReview({})).toBe(true)
  })

  it('set + review_needed=true → true', () => {
    expect(needsLicenseTypeReview(profileLT('family_home', true))).toBe(true)
  })

  it('set + review_needed=false → false', () => {
    expect(needsLicenseTypeReview(profileLT('family_home'))).toBe(false)
    expect(needsLicenseTypeReview(profileLT('group_home'))).toBe(false)
    expect(needsLicenseTypeReview(profileLT('license_exempt'))).toBe(false)
  })

  it('no profile → false (nothing to review)', () => {
    expect(needsLicenseTypeReview(null)).toBe(false)
    expect(needsLicenseTypeReview(undefined)).toBe(false)
  })
})
