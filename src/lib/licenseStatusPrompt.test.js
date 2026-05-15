import { describe, it, expect } from 'vitest'
import { shouldFireLicenseStatusPrompt } from './licenseStatusPrompt'

// Readable builders.
const cdc = (overrides = {}) => ({ type: 'cdc_scholarship', ...overrides })
const profile = (is_license_exempt) => ({ is_license_exempt })

describe('shouldFireLicenseStatusPrompt', () => {
  describe('fires', () => {
    it('CDC source + is_license_exempt null → fires', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profile(null),
        savedSource: cdc(),
      })).toBe(true)
    })

    it('CDC source + is_license_exempt missing (undefined) → fires', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: {},
        savedSource: cdc(),
      })).toBe(true)
    })
  })

  describe('does not fire', () => {
    it('is_license_exempt already true → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profile(true),
        savedSource: cdc(),
      })).toBe(false)
    })

    it('is_license_exempt already false → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profile(false),
        savedSource: cdc(),
      })).toBe(false)
    })

    it('non-CDC source (private_pay) → no fire even when unanswered', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profile(null),
        savedSource: { type: 'private_pay' },
      })).toBe(false)
    })

    it('non-CDC source (tri_share) → no fire even when unanswered', () => {
      expect(shouldFireLicenseStatusPrompt({
        profile: profile(null),
        savedSource: { type: 'tri_share' },
      })).toBe(false)
    })
  })

  describe('defensive — missing arguments', () => {
    it('no savedSource → no fire', () => {
      expect(shouldFireLicenseStatusPrompt({ profile: profile(null) }))
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
