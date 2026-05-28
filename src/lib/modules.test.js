import { describe, it, expect } from 'vitest'
import { getActiveModules, hasModule, MODULE_KEYS } from './modules'

// Small helper to keep test setup readable.
const fs = (type, overrides = {}) => ({
  type,
  status: 'active',
  archived_at: null,
  ...overrides,
})

describe('getActiveModules', () => {
  describe('the 8 spec scenarios', () => {
    it('private-pay-only provider returns just core', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('private_pay')],
      })
      expect([...modules]).toEqual([MODULE_KEYS.CORE])
    })

    it('one active CDC source activates the CDC module', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('cdc_scholarship')],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(true)
      expect(modules.has(MODULE_KEYS.CORE)).toBe(true)
    })

    it('one CDC kid plus one private-pay family yields core + cdc only', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('cdc_scholarship'), fs('private_pay')],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(true)
      expect(modules.has(MODULE_KEYS.CORE)).toBe(true)
      expect(modules.size).toBe(2)
    })

    it('paused CDC source plus force_off override removes the CDC module', () => {
      const modules = getActiveModules({
        profile: { program_settings: { cdc: 'force_off' } },
        fundingSources: [fs('cdc_scholarship', { status: 'paused' })],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(false)
      expect([...modules]).toEqual([MODULE_KEYS.CORE])
    })

    it('one active Tri-Share source activates the Tri-Share module', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('tri_share')],
      })
      expect(modules.has(MODULE_KEYS.TRI_SHARE)).toBe(true)
    })

    it('CDC + Tri-Share + private + GSRP activates all relevant modules', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [
          fs('cdc_scholarship'),
          fs('tri_share'),
          fs('private_pay'),
          fs('gsrp'),
        ],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(true)
      expect(modules.has(MODULE_KEYS.TRI_SHARE)).toBe(true)
      expect(modules.has(MODULE_KEYS.GSRP)).toBe(true)
      expect(modules.has(MODULE_KEYS.CORE)).toBe(true)
    })

    it('miregistry_id alone activates the MiRegistry tracker', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, miregistry_id: 'MR-12345' },
        fundingSources: [fs('private_pay')],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(true)
      expect(modules.has(MODULE_KEYS.CDC)).toBe(false)
    })

    it('cdc force_on shows the module even with no CDC funding sources', () => {
      const modules = getActiveModules({
        profile: { program_settings: { cdc: 'force_on' } },
        fundingSources: [fs('private_pay')],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(true)
    })
  })

  describe('MiRegistry tracker activation (combined rule per miregistry_tracker_spec.md § 4)', () => {
    it('is_license_exempt = true with no miregistry_id activates the tracker (the new rule)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: true },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(true)
    })

    it('is_license_exempt = true AND miregistry_id set still activates (both paths overlap, no double-add)', () => {
      const modules = getActiveModules({
        profile: {
          program_settings: {},
          is_license_exempt: true,
          miregistry_id: 'MR-12345',
        },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(true)
    })

    it('is_license_exempt = false with no miregistry_id does NOT activate (regression guard)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: false },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(false)
    })

    it('is_license_exempt = null with no miregistry_id does NOT activate (default state for never-onboarded providers)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: null },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(false)
    })

    it('miregistry_id set with is_license_exempt = false (licensed provider opt-in) still activates via the existing rule', () => {
      const modules = getActiveModules({
        profile: {
          program_settings: {},
          miregistry_id: 'MR-67890',
          is_license_exempt: false,
        },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.MIREGISTRY_TRACKER)).toBe(true)
    })
  })

  describe('Staff Training activation (staff_training_tracking_spec.md § 5.1)', () => {
    it('is_license_exempt === false activates the Staff Training module', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: false },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(true)
    })

    it('activates even with no michigan_license_number on file', () => {
      // Keyed on the onboarding answer, not the license number — a
      // licensed provider who skipped the number question still gets it.
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: false },
        fundingSources: [fs('cdc_scholarship')],
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(true)
    })

    it('a staff member on a licensee roster activates Staff Training', () => {
      // The staff member's own profile carries no license status — the
      // signal is roster membership (a caregivers row owned by their
      // licensee). See useActiveModules.
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: null },
        fundingSources: [],
        isTrackedStaffCaregiver: true,
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(true)
    })

    it('isTrackedStaffCaregiver false does NOT activate Staff Training', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: null },
        fundingSources: [],
        isTrackedStaffCaregiver: false,
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(false)
    })

    it('is_license_exempt === true does NOT activate Staff Training', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: true },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(false)
    })

    it('is_license_exempt === null does NOT activate Staff Training', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, is_license_exempt: null },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(false)
    })

    it('unanswered (is_license_exempt absent) does NOT activate Staff Training', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('private_pay')],
      })
      expect(modules.has(MODULE_KEYS.STAFF_TRAINING)).toBe(false)
    })
  })

  describe('edge cases beyond the spec', () => {
    it('archived funding sources are ignored regardless of status', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [
          fs('cdc_scholarship', {
            status: 'active',
            archived_at: '2025-01-01T00:00:00Z',
          }),
        ],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(false)
    })

    it('ended funding sources are ignored', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('cdc_scholarship', { status: 'ended' })],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(false)
    })

    it('head_start and agency_other auto-activate their modules', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [fs('head_start'), fs('agency_other')],
      })
      expect(modules.has(MODULE_KEYS.HEAD_START)).toBe(true)
      expect(modules.has(MODULE_KEYS.AGENCY_BILLING)).toBe(true)
    })

    // PR #14: compliance gates read license_type (migration 022), not the
    // legacy michigan_license_number / is_license_exempt signals.
    it('license_type=family_home activates LICENSED_COMPLIANCE', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'family_home' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)).toBe(true)
      expect(modules.has(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)).toBe(false)
    })

    it('license_type=group_home activates LICENSED_COMPLIANCE', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'group_home' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)).toBe(true)
      expect(modules.has(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)).toBe(false)
    })

    it('license_type=license_exempt activates LICENSE_EXEMPT_COMPLIANCE (and NOT LICENSED_COMPLIANCE)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'license_exempt' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)).toBe(true)
      expect(modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)).toBe(false)
    })

    it('license_type null activates neither compliance gate', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: null },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)).toBe(false)
      expect(modules.has(MODULE_KEYS.LICENSE_EXEMPT_COMPLIANCE)).toBe(false)
    })

    // PR #15 Half 2: REMINDERS module key.
    it('REMINDERS activates whenever license_type is set (family_home)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'family_home' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.REMINDERS)).toBe(true)
    })

    it('REMINDERS activates for group_home providers', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'group_home' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.REMINDERS)).toBe(true)
    })

    it('REMINDERS activates for license_exempt providers (LEPs configure CDC reminders)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: 'license_exempt' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.REMINDERS)).toBe(true)
    })

    it('REMINDERS does NOT activate when license_type is null (provider has not confirmed type yet)', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, license_type: null },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.REMINDERS)).toBe(false)
    })

    it('REMINDERS does NOT activate when license_type is absent from the profile', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.REMINDERS)).toBe(false)
    })

    it('michigan_license_number alone (no license_type) does NOT activate LICENSED_COMPLIANCE — PR #14 dropped that trigger', () => {
      const modules = getActiveModules({
        profile: { program_settings: {}, michigan_license_number: 'DC-1234' },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.LICENSED_COMPLIANCE)).toBe(false)
    })

    it('program_settings.cacfp=true activates the CACFP module', () => {
      const modules = getActiveModules({
        profile: { program_settings: { cacfp: true } },
        fundingSources: [],
      })
      expect(modules.has(MODULE_KEYS.CACFP)).toBe(true)
    })

    it('force_off wins over force_on conflict for the same key (not a realistic case, but documents precedence)', () => {
      // program_settings only carries one value per key; this asserts that
      // a single 'force_off' value beats any auto-activation from sources.
      const modules = getActiveModules({
        profile: { program_settings: { tri_share: 'force_off' } },
        fundingSources: [fs('tri_share')],
      })
      expect(modules.has(MODULE_KEYS.TRI_SHARE)).toBe(false)
    })

    it('handles missing arguments without throwing', () => {
      expect(getActiveModules()).toEqual(new Set([MODULE_KEYS.CORE]))
      expect(getActiveModules({})).toEqual(new Set([MODULE_KEYS.CORE]))
      expect(getActiveModules({ profile: null, fundingSources: null }))
        .toEqual(new Set([MODULE_KEYS.CORE]))
    })

    it('filters out null/undefined funding sources defensively', () => {
      const modules = getActiveModules({
        profile: { program_settings: {} },
        fundingSources: [null, undefined, fs('cdc_scholarship')],
      })
      expect(modules.has(MODULE_KEYS.CDC)).toBe(true)
    })
  })
})

describe('hasModule', () => {
  it('returns true when the module is active', () => {
    expect(
      hasModule(
        { program_settings: {} },
        [fs('cdc_scholarship')],
        MODULE_KEYS.CDC
      )
    ).toBe(true)
  })

  it('returns false when the module is not active', () => {
    expect(
      hasModule(
        { program_settings: {} },
        [fs('private_pay')],
        MODULE_KEYS.CDC
      )
    ).toBe(false)
  })
})
