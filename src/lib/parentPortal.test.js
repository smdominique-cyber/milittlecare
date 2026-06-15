import { describe, it, expect } from 'vitest'
import {
  resolveParentPortalProviderName,
  resolveHasPasswordState,
  shouldShowPasswordBanner,
  PASSWORD_BANNER_STATE,
  PARENT_PORTAL_PROVIDER_NAME_FALLBACK,
} from './parentPortal'

// ─── Scope ────────────────────────────────────────────────────────────
//
// Pure functions, no I/O. These tests pin the two branching
// expressions that drive the parent portal's branding header and
// password-banner gate — both surfaces had bugs in production
// (header was hardcoded "MI Little Care"; banner fired for parents
// who DID have a password).
//
// The dashboard wiring that reads these helpers is exercised in the
// IntakePendingBanner mount test (parent-side) and via Seth's live-
// gate (visual confirmation).

// ─── resolveParentPortalProviderName ─────────────────────────────────

describe('resolveParentPortalProviderName', () => {
  it('prefers daycare_name when set', () => {
    expect(
      resolveParentPortalProviderName({
        daycare_name: 'Bright Beginnings Daycare',
        full_name: 'Sarah Smith',
      })
    ).toBe('Bright Beginnings Daycare')
  })

  it('falls back to full_name when daycare_name is null / missing / blank', () => {
    expect(
      resolveParentPortalProviderName({ daycare_name: null, full_name: 'Sarah Smith' })
    ).toBe('Sarah Smith')
    expect(
      resolveParentPortalProviderName({ daycare_name: '', full_name: 'Sarah Smith' })
    ).toBe('Sarah Smith')
    expect(
      resolveParentPortalProviderName({ daycare_name: '   ', full_name: 'Sarah Smith' })
    ).toBe('Sarah Smith')
    expect(
      resolveParentPortalProviderName({ full_name: 'Sarah Smith' })
    ).toBe('Sarah Smith')
  })

  it('falls back to the constant when neither name is set', () => {
    expect(resolveParentPortalProviderName({})).toBe(PARENT_PORTAL_PROVIDER_NAME_FALLBACK)
    expect(resolveParentPortalProviderName({ daycare_name: null, full_name: null })).toBe(
      PARENT_PORTAL_PROVIDER_NAME_FALLBACK
    )
    expect(resolveParentPortalProviderName({ daycare_name: '   ', full_name: '   ' })).toBe(
      PARENT_PORTAL_PROVIDER_NAME_FALLBACK
    )
  })

  it('returns the fallback for null / undefined provider arg', () => {
    expect(resolveParentPortalProviderName(null)).toBe(PARENT_PORTAL_PROVIDER_NAME_FALLBACK)
    expect(resolveParentPortalProviderName(undefined)).toBe(PARENT_PORTAL_PROVIDER_NAME_FALLBACK)
  })

  it('matches the documented fallback string', () => {
    // Locking the wording — the docstring promises "Your provider"
    // and the dashboard's old in-page fallback used the same. A
    // future caller (settings page, autopay modal) needs this to
    // stay stable.
    expect(PARENT_PORTAL_PROVIDER_NAME_FALLBACK).toBe('Your provider')
  })
})

// ─── resolveHasPasswordState ─────────────────────────────────────────

describe('resolveHasPasswordState', () => {
  it('returns HAS_PASSWORD only when has_password is strictly true', () => {
    expect(resolveHasPasswordState({ has_password: true })).toBe(
      PASSWORD_BANNER_STATE.HAS_PASSWORD
    )
  })

  it('returns EXPLICITLY_NO_PASSWORD only when has_password is strictly false', () => {
    expect(resolveHasPasswordState({ has_password: false })).toBe(
      PASSWORD_BANNER_STATE.EXPLICITLY_NO_PASSWORD
    )
  })

  it('returns UNKNOWN for null / undefined / missing column (THE BUG FIX)', () => {
    // The pre-fix code did `!!data?.has_password` which collapsed
    // every one of these to `false`, causing the banner to fire for
    // legacy parents who DID have a password but were never written
    // to parent_profiles.has_password = true.
    expect(resolveHasPasswordState({ has_password: null })).toBe(
      PASSWORD_BANNER_STATE.UNKNOWN
    )
    expect(resolveHasPasswordState({ has_password: undefined })).toBe(
      PASSWORD_BANNER_STATE.UNKNOWN
    )
    expect(resolveHasPasswordState({})).toBe(PASSWORD_BANNER_STATE.UNKNOWN)
  })

  it('returns UNKNOWN for null row (RLS-blocked / no row)', () => {
    expect(resolveHasPasswordState(null)).toBe(PASSWORD_BANNER_STATE.UNKNOWN)
    expect(resolveHasPasswordState(undefined)).toBe(PASSWORD_BANNER_STATE.UNKNOWN)
  })

  it('treats non-boolean truthy values as UNKNOWN (defensive)', () => {
    // Belt-and-suspenders: the column is a boolean in the DB, but if
    // it ever came back as 'true' / 1 / 'yes' due to a JSON quirk we
    // want UNKNOWN rather than a confidently-wrong HAS_PASSWORD.
    expect(resolveHasPasswordState({ has_password: 'true' })).toBe(
      PASSWORD_BANNER_STATE.UNKNOWN
    )
    expect(resolveHasPasswordState({ has_password: 1 })).toBe(
      PASSWORD_BANNER_STATE.UNKNOWN
    )
  })
})

// ─── shouldShowPasswordBanner ────────────────────────────────────────

describe('shouldShowPasswordBanner', () => {
  it('shows the banner ONLY on EXPLICITLY_NO_PASSWORD', () => {
    expect(shouldShowPasswordBanner(PASSWORD_BANNER_STATE.EXPLICITLY_NO_PASSWORD)).toBe(true)
    expect(shouldShowPasswordBanner(PASSWORD_BANNER_STATE.HAS_PASSWORD)).toBe(false)
    expect(shouldShowPasswordBanner(PASSWORD_BANNER_STATE.UNKNOWN)).toBe(false)
  })

  it('hides the banner on an unrecognized state (safer default)', () => {
    expect(shouldShowPasswordBanner(null)).toBe(false)
    expect(shouldShowPasswordBanner(undefined)).toBe(false)
    expect(shouldShowPasswordBanner('whatever')).toBe(false)
  })
})

// ─── End-to-end: the bug scenario, exercised through the helpers ─────

describe('the bug it fixes', () => {
  it('a row with has_password=null does NOT trigger the banner', () => {
    // Pre-fix: !!null === false; gate `hasPassword === false` matched;
    // banner fired for every legacy parent.
    // Post-fix: UNKNOWN → hidden.
    const state = resolveHasPasswordState({ has_password: null })
    expect(shouldShowPasswordBanner(state)).toBe(false)
  })

  it('a row with has_password=true does NOT trigger the banner', () => {
    const state = resolveHasPasswordState({ has_password: true })
    expect(shouldShowPasswordBanner(state)).toBe(false)
  })

  it('a row with has_password=false DOES trigger the banner', () => {
    const state = resolveHasPasswordState({ has_password: false })
    expect(shouldShowPasswordBanner(state)).toBe(true)
  })

  it('an RLS-blocked / missing row does NOT trigger the banner', () => {
    const state = resolveHasPasswordState(null)
    expect(shouldShowPasswordBanner(state)).toBe(false)
  })
})
