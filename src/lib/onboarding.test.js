import { describe, it, expect } from 'vitest'
import {
  QUESTION_CATALOG,
  STEPS_PER_PROVIDER,
  ONBOARDING_STATE_VERSION,
  LICENSE_STATUS,
  YES_NO,
  TRI_SHARE_ANSWER,
  CHILD_COUNT_BUCKETS,
  CARE_HOURS_BUCKETS,
  getQuestion,
  getStepSequence,
  getNextStep,
  isComplete,
  getMissingFields,
  getWriteTargets,
} from './onboarding'

// -----------------------------------------------------------------------------
// Question catalog completeness
// -----------------------------------------------------------------------------

describe('QUESTION_CATALOG (completeness)', () => {
  it('defines exactly 9 questions', () => {
    expect(QUESTION_CATALOG).toHaveLength(9)
  })

  it('has a unique key for every question', () => {
    const keys = QUESTION_CATALOG.map(q => q.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers screens 1 through 8 (2a and 2b share screen 2)', () => {
    const screens = QUESTION_CATALOG.map(q => q.screen).sort((a, b) => a - b)
    expect(screens).toEqual([1, 2, 2, 3, 4, 5, 6, 7, 8])
  })

  it('gives every question a copyKey, prompt, why, appliesTo and kind', () => {
    for (const q of QUESTION_CATALOG) {
      expect(typeof q.copyKey).toBe('string')
      expect(q.copyKey.length).toBeGreaterThan(0)
      expect(typeof q.prompt).toBe('string')
      expect(q.prompt.length).toBeGreaterThan(0)
      expect(typeof q.why).toBe('string')
      expect(q.why.length).toBeGreaterThan(0)
      expect(['all', 'license_exempt', 'licensed']).toContain(q.appliesTo)
      expect(['choice', 'text', 'compound']).toContain(q.kind)
    }
  })

  it('gives every choice question at least two options, each with a value, copyKey and label', () => {
    for (const q of QUESTION_CATALOG.filter(x => x.kind === 'choice')) {
      expect(q.options.length).toBeGreaterThanOrEqual(2)
      for (const opt of q.options) {
        expect(opt.value).toBeTruthy()
        expect(typeof opt.copyKey).toBe('string')
        expect(typeof opt.label).toBe('string')
      }
    }
  })

  it('gives every text/compound question a non-empty fields list', () => {
    for (const q of QUESTION_CATALOG.filter(x => x.kind !== 'choice')) {
      expect(Array.isArray(q.fields)).toBe(true)
      expect(q.fields.length).toBeGreaterThan(0)
    }
  })

  it('has exactly one branch question, and it is license_status', () => {
    const branches = QUESTION_CATALOG.filter(q => q.isBranch)
    expect(branches).toHaveLength(1)
    expect(branches[0].key).toBe('license_status')
  })

  it('scopes the two branch destinations correctly and leaves all others "all"', () => {
    expect(getQuestion('miregistry_id').appliesTo).toBe('license_exempt')
    expect(getQuestion('license_number').appliesTo).toBe('licensed')
    const common = QUESTION_CATALOG.filter(
      q => !['miregistry_id', 'license_number'].includes(q.key),
    )
    for (const q of common) expect(q.appliesTo).toBe('all')
  })

  it('exposes the expected constants', () => {
    expect(STEPS_PER_PROVIDER).toBe(8)
    expect(ONBOARDING_STATE_VERSION).toBe(1)
    expect(CHILD_COUNT_BUCKETS).toEqual(['1_3', '4_6', '7_12', '12_plus'])
    expect(CARE_HOURS_BUCKETS).toEqual(['under_20', '20_to_34', '35_to_49', '50_plus'])
  })

  it('is frozen (catalog cannot be mutated)', () => {
    expect(Object.isFrozen(QUESTION_CATALOG)).toBe(true)
    expect(Object.isFrozen(QUESTION_CATALOG[0])).toBe(true)
    expect(Object.isFrozen(QUESTION_CATALOG[0].options)).toBe(true)
  })

  it('getQuestion returns null for an unknown key', () => {
    expect(getQuestion('nope')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Conditional next-step — license-exempt branch vs licensed branch
// -----------------------------------------------------------------------------

describe('getStepSequence (conditional branch)', () => {
  it('routes a license-exempt provider through the MiRegistry question', () => {
    const seq = getStepSequence({ license_status: LICENSE_STATUS.EXEMPT })
    expect(seq).toEqual([
      'license_status', 'miregistry_id', 'cdc', 'tri_share',
      'gsrp', 'cacfp', 'child_count', 'care_hours',
    ])
    expect(seq).not.toContain('license_number')
  })

  it('routes a licensed provider through the license-number question', () => {
    const seq = getStepSequence({ license_status: LICENSE_STATUS.LICENSED })
    expect(seq).toEqual([
      'license_status', 'license_number', 'cdc', 'tri_share',
      'gsrp', 'cacfp', 'child_count', 'care_hours',
    ])
    expect(seq).not.toContain('miregistry_id')
  })

  it('is always 8 steps long', () => {
    expect(getStepSequence({ license_status: LICENSE_STATUS.EXEMPT })).toHaveLength(8)
    expect(getStepSequence({ license_status: LICENSE_STATUS.LICENSED })).toHaveLength(8)
    expect(getStepSequence({})).toHaveLength(8)
  })

  it('defaults to the license-exempt branch when status is unanswered', () => {
    expect(getStepSequence({})).toContain('miregistry_id')
    expect(getStepSequence(undefined)).toContain('miregistry_id')
  })
})

describe('getNextStep', () => {
  it('returns the first step (license_status) for a null current key', () => {
    expect(getNextStep(null)).toBe('license_status')
    expect(getNextStep(undefined, {})).toBe('license_status')
  })

  it('branches to miregistry_id after a license-exempt answer', () => {
    expect(getNextStep('license_status', { license_status: LICENSE_STATUS.EXEMPT }))
      .toBe('miregistry_id')
  })

  it('branches to license_number after a licensed answer', () => {
    expect(getNextStep('license_status', { license_status: LICENSE_STATUS.LICENSED }))
      .toBe('license_number')
  })

  it('walks the common tail of the sequence', () => {
    const a = { license_status: LICENSE_STATUS.EXEMPT }
    expect(getNextStep('miregistry_id', a)).toBe('cdc')
    expect(getNextStep('cdc', a)).toBe('tri_share')
    expect(getNextStep('tri_share', a)).toBe('gsrp')
    expect(getNextStep('gsrp', a)).toBe('cacfp')
    expect(getNextStep('cacfp', a)).toBe('child_count')
    expect(getNextStep('child_count', a)).toBe('care_hours')
  })

  it('returns null after the final step', () => {
    expect(getNextStep('care_hours', { license_status: LICENSE_STATUS.EXEMPT })).toBeNull()
  })

  it('returns null for a step that is not in this provider\'s sequence', () => {
    // license_number is not in a license-exempt provider's sequence.
    expect(getNextStep('license_number', { license_status: LICENSE_STATUS.EXEMPT })).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Completion check
// -----------------------------------------------------------------------------

describe('isComplete', () => {
  const exemptAllAnswered = {
    license_status: LICENSE_STATUS.EXEMPT,
    miregistry_id: 'MR-12345',
    cdc: YES_NO.YES,
    tri_share: TRI_SHARE_ANSWER.NO,
    gsrp: YES_NO.NO,
    cacfp: YES_NO.NO,
    child_count: '4_6',
    care_hours: '35_to_49',
  }

  it('is false when no questions are answered', () => {
    expect(isComplete({}, [])).toBe(false)
  })

  it('is false when only some questions are answered', () => {
    expect(isComplete({ license_status: LICENSE_STATUS.EXEMPT, cdc: YES_NO.YES }, []))
      .toBe(false)
  })

  it('is true when every question on the provider\'s path is answered', () => {
    expect(isComplete(exemptAllAnswered, [])).toBe(true)
  })

  it('is true when remaining questions are explicitly skipped', () => {
    const partial = {
      license_status: LICENSE_STATUS.EXEMPT,
      cdc: YES_NO.YES,
      gsrp: YES_NO.NO,
    }
    const skipped = ['miregistry_id', 'tri_share', 'cacfp', 'child_count', 'care_hours']
    expect(isComplete(partial, skipped)).toBe(true)
  })

  it('treats an empty-string answer as not answered', () => {
    expect(isComplete({ ...exemptAllAnswered, miregistry_id: '' }, [])).toBe(false)
  })

  it('checks the licensed branch (license_number, not miregistry_id)', () => {
    const licensed = {
      license_status: LICENSE_STATUS.LICENSED,
      license_number: { license_number: 'DC-99' },
      cdc: YES_NO.NO,
      tri_share: TRI_SHARE_ANSWER.NO,
      gsrp: YES_NO.NO,
      cacfp: YES_NO.NO,
      child_count: '1_3',
      care_hours: 'under_20',
    }
    expect(isComplete(licensed, [])).toBe(true)
    // miregistry_id answered but license_number missing -> not complete.
    const wrongBranch = { ...licensed }
    delete wrongBranch.license_number
    wrongBranch.miregistry_id = 'MR-1'
    expect(isComplete(wrongBranch, [])).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Missing-fields enumeration
// -----------------------------------------------------------------------------

describe('getMissingFields', () => {
  it('reports license_status plus the program questions for an empty profile', () => {
    // is_license_exempt is null -> branch unknown -> no branch field.
    expect(getMissingFields({})).toEqual([
      'license_status', 'cdc', 'tri_share', 'gsrp', 'cacfp',
      'child_count', 'care_hours',
    ])
  })

  it('reports miregistry_id for a license-exempt provider with no ID', () => {
    const missing = getMissingFields({ is_license_exempt: true })
    expect(missing).toContain('miregistry_id')
    expect(missing).not.toContain('license_number')
    expect(missing).not.toContain('license_status')
  })

  it('does not report miregistry_id once the exempt provider has an ID', () => {
    const missing = getMissingFields({ is_license_exempt: true, miregistry_id: 'MR-1' })
    expect(missing).not.toContain('miregistry_id')
  })

  it('reports license_number for a licensed provider with no number', () => {
    const missing = getMissingFields({ is_license_exempt: false })
    expect(missing).toContain('license_number')
    expect(missing).not.toContain('miregistry_id')
  })

  it('does not report license_number once the licensed provider has one', () => {
    const missing = getMissingFields({
      is_license_exempt: false,
      michigan_license_number: 'DC-99',
    })
    expect(missing).not.toContain('license_number')
  })

  it('drops program questions once program_settings carries a value', () => {
    const profile = {
      is_license_exempt: true,
      miregistry_id: 'MR-1',
      program_settings: {
        cdc: 'force_on',
        tri_share: 'auto',
        gsrp: 'force_off',
        cacfp: false,
        onboarding_child_count: '4_6',
        onboarding_care_hours: 'under_20',
      },
    }
    expect(getMissingFields(profile)).toEqual([])
  })

  it('treats a present-but-false cacfp setting as not missing', () => {
    const missing = getMissingFields({
      is_license_exempt: true,
      miregistry_id: 'MR-1',
      program_settings: { cacfp: false },
    })
    expect(missing).not.toContain('cacfp')
  })

  it('does not throw on a null profile', () => {
    expect(() => getMissingFields(null)).not.toThrow()
    expect(getMissingFields(null)).toContain('license_status')
  })
})

// -----------------------------------------------------------------------------
// Answer -> write-target mapping
// -----------------------------------------------------------------------------

describe('getWriteTargets', () => {
  it('maps license_status to the is_license_exempt boolean', () => {
    expect(getWriteTargets('license_status', LICENSE_STATUS.EXEMPT)).toEqual([
      { store: 'profile', field: 'is_license_exempt', value: true },
    ])
    expect(getWriteTargets('license_status', LICENSE_STATUS.LICENSED)).toEqual([
      { store: 'profile', field: 'is_license_exempt', value: false },
    ])
  })

  it('maps miregistry_id to the profile column', () => {
    expect(getWriteTargets('miregistry_id', 'MR-12345')).toEqual([
      { store: 'profile', field: 'miregistry_id', value: 'MR-12345' },
    ])
  })

  it('maps license_number, including the optional provider id', () => {
    expect(getWriteTargets('license_number', { license_number: 'DC-99' })).toEqual([
      { store: 'profile', field: 'michigan_license_number', value: 'DC-99' },
    ])
    expect(getWriteTargets('license_number', {
      license_number: 'DC-99',
      provider_id: 'PRV-7',
    })).toEqual([
      { store: 'profile', field: 'michigan_license_number', value: 'DC-99' },
      { store: 'profile', field: 'michigan_provider_id', value: 'PRV-7' },
    ])
  })

  it('maps a CDC "yes" to force_on and a "no" to a key removal', () => {
    expect(getWriteTargets('cdc', YES_NO.YES)).toEqual([
      { store: 'program_settings', field: 'cdc', value: 'force_on' },
    ])
    expect(getWriteTargets('cdc', YES_NO.NO)).toEqual([
      { store: 'program_settings', field: 'cdc', remove: true },
    ])
  })

  it('maps a GSRP "yes" to force_on and a "no" to a key removal', () => {
    expect(getWriteTargets('gsrp', YES_NO.YES)).toEqual([
      { store: 'program_settings', field: 'gsrp', value: 'force_on' },
    ])
    expect(getWriteTargets('gsrp', YES_NO.NO)).toEqual([
      { store: 'program_settings', field: 'gsrp', remove: true },
    ])
  })

  it('maps Tri-Share yes/no like the other gates', () => {
    expect(getWriteTargets('tri_share', TRI_SHARE_ANSWER.YES)).toEqual([
      { store: 'program_settings', field: 'tri_share', value: 'force_on' },
    ])
    expect(getWriteTargets('tri_share', TRI_SHARE_ANSWER.NO)).toEqual([
      { store: 'program_settings', field: 'tri_share', remove: true },
    ])
  })

  it('maps Tri-Share "never heard of it" to the no-state plus an onboarding_state signal', () => {
    expect(getWriteTargets('tri_share', TRI_SHARE_ANSWER.NEVER_HEARD)).toEqual([
      { store: 'program_settings', field: 'tri_share', remove: true },
      { store: 'onboarding_state', field: 'tri_share_never_heard', value: true },
    ])
  })

  it('maps CACFP, accepting both a plain string and the {participates, sponsor} object', () => {
    expect(getWriteTargets('cacfp', YES_NO.NO)).toEqual([
      { store: 'program_settings', field: 'cacfp', value: false },
    ])
    expect(getWriteTargets('cacfp', { participates: YES_NO.YES })).toEqual([
      { store: 'program_settings', field: 'cacfp', value: true },
    ])
    expect(getWriteTargets('cacfp', {
      participates: YES_NO.YES,
      sponsor: 'Great Lakes CACFP',
    })).toEqual([
      { store: 'program_settings', field: 'cacfp', value: true },
      { store: 'program_settings', field: 'cacfp_sponsor', value: 'Great Lakes CACFP' },
    ])
  })

  it('does not write a sponsor when CACFP participation is "no"', () => {
    expect(getWriteTargets('cacfp', { participates: YES_NO.NO, sponsor: 'ignored' })).toEqual([
      { store: 'program_settings', field: 'cacfp', value: false },
    ])
  })

  it('maps the soft-context buckets to namespaced program_settings keys', () => {
    expect(getWriteTargets('child_count', '7_12')).toEqual([
      { store: 'program_settings', field: 'onboarding_child_count', value: '7_12' },
    ])
    expect(getWriteTargets('care_hours', '50_plus')).toEqual([
      { store: 'program_settings', field: 'onboarding_care_hours', value: '50_plus' },
    ])
  })

  it('returns [] for a skipped (null/undefined) answer', () => {
    expect(getWriteTargets('cdc', null)).toEqual([])
    expect(getWriteTargets('cdc', undefined)).toEqual([])
  })

  it('returns [] for an unknown question key', () => {
    expect(getWriteTargets('mystery', 'yes')).toEqual([])
  })
})
