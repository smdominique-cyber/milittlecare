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
  reconstructAnswers,
  isDraftSubmittable,
  buildProfileUpdate,
  getOnboardingProgress,
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
    const seq = getStepSequence({ license_status: LICENSE_STATUS.FAMILY_HOME })
    expect(seq).toEqual([
      'license_status', 'license_number', 'cdc', 'tri_share',
      'gsrp', 'cacfp', 'child_count', 'care_hours',
    ])
    expect(seq).not.toContain('miregistry_id')
  })

  it('is always 8 steps long', () => {
    expect(getStepSequence({ license_status: LICENSE_STATUS.EXEMPT })).toHaveLength(8)
    expect(getStepSequence({ license_status: LICENSE_STATUS.FAMILY_HOME })).toHaveLength(8)
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
    expect(getNextStep('license_status', { license_status: LICENSE_STATUS.FAMILY_HOME }))
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

  it('falls back to the license-exempt sequence when license_status itself is skipped', () => {
    // license_status skipped -> absent from answers -> getStepSequence
    // defaults to the miregistry_id branch. Completion still requires all
    // 8 steps to be answered-or-skipped.
    const answers = {
      cdc: YES_NO.YES,
      tri_share: TRI_SHARE_ANSWER.NO,
      gsrp: YES_NO.NO,
      cacfp: YES_NO.NO,
      child_count: '4_6',
      care_hours: 'under_20',
    }
    // license_status and miregistry_id are still unresolved -> not complete.
    expect(isComplete(answers, [])).toBe(false)
    // Skipping both resolves the full 8-step sequence -> complete.
    expect(isComplete(answers, ['license_status', 'miregistry_id'])).toBe(true)
  })

  it('checks the licensed branch (license_number, not miregistry_id)', () => {
    const licensed = {
      license_status: LICENSE_STATUS.FAMILY_HOME,
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
    // license_type is null -> branch unknown -> no branch field.
    expect(getMissingFields({})).toEqual([
      'license_status', 'cdc', 'tri_share', 'gsrp', 'cacfp',
      'child_count', 'care_hours',
    ])
  })

  it('reports miregistry_id for a license-exempt provider with no ID', () => {
    const missing = getMissingFields({ license_type: 'license_exempt' })
    expect(missing).toContain('miregistry_id')
    expect(missing).not.toContain('license_number')
    expect(missing).not.toContain('license_status')
  })

  it('does not report miregistry_id once the exempt provider has an ID', () => {
    const missing = getMissingFields({ license_type: 'license_exempt', miregistry_id: 'MR-1' })
    expect(missing).not.toContain('miregistry_id')
  })

  it('reports license_number for a licensed provider with no number', () => {
    const missing = getMissingFields({ license_type: 'family_home' })
    expect(missing).toContain('license_number')
    expect(missing).not.toContain('miregistry_id')
  })

  it('reports license_number for a group_home provider with no number', () => {
    const missing = getMissingFields({ license_type: 'group_home' })
    expect(missing).toContain('license_number')
    expect(missing).not.toContain('miregistry_id')
  })

  it('does not report license_number once the licensed provider has one', () => {
    const missing = getMissingFields({
      license_type: 'family_home',
      michigan_license_number: 'DC-99',
    })
    expect(missing).not.toContain('license_number')
  })

  it('reports license_status when the row is flagged for review (PR #14 backfill case)', () => {
    // license_type is set but the backfill could not confirm family vs group
    // — re-prompt the human via license_status.
    const missing = getMissingFields({
      license_type: 'family_home',
      license_type_review_needed: true,
      michigan_license_number: 'DC-99',
    })
    expect(missing).toContain('license_status')
  })

  it('drops program questions once program_settings carries a value', () => {
    const profile = {
      license_type: 'license_exempt',
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
      license_type: 'license_exempt',
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
  it('maps license_status to license_type + mirrored is_license_exempt + cleared review_needed (PR #14)', () => {
    expect(getWriteTargets('license_status', LICENSE_STATUS.EXEMPT)).toEqual([
      { store: 'profile', field: 'license_type', value: 'license_exempt' },
      { store: 'profile', field: 'is_license_exempt', value: true },
      { store: 'profile', field: 'license_type_review_needed', value: false },
    ])
    expect(getWriteTargets('license_status', LICENSE_STATUS.FAMILY_HOME)).toEqual([
      { store: 'profile', field: 'license_type', value: 'family_home' },
      { store: 'profile', field: 'is_license_exempt', value: false },
      { store: 'profile', field: 'license_type_review_needed', value: false },
    ])
    expect(getWriteTargets('license_status', LICENSE_STATUS.GROUP_HOME)).toEqual([
      { store: 'profile', field: 'license_type', value: 'group_home' },
      { store: 'profile', field: 'is_license_exempt', value: false },
      { store: 'profile', field: 'license_type_review_needed', value: false },
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

  it('maps Tri-Share "never heard of it" to the same gate removal as "no"', () => {
    // The distinct "never heard of it" signal is preserved in
    // onboarding_state.gate_answers by buildProfileUpdate, not here.
    expect(getWriteTargets('tri_share', TRI_SHARE_ANSWER.NEVER_HEARD)).toEqual([
      { store: 'program_settings', field: 'tri_share', remove: true },
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

// -----------------------------------------------------------------------------
// reconstructAnswers — resume hydration
// -----------------------------------------------------------------------------

describe('reconstructAnswers', () => {
  it('returns an empty map for a blank profile', () => {
    expect(reconstructAnswers({})).toEqual({})
    expect(reconstructAnswers(null)).toEqual({})
  })

  it('reconstructs a license-exempt provider with a MiRegistry ID', () => {
    expect(reconstructAnswers({ license_type: 'license_exempt', miregistry_id: 'MR-1' }))
      .toEqual({ license_status: LICENSE_STATUS.EXEMPT, miregistry_id: 'MR-1' })
  })

  it('reconstructs a family_home provider with license and provider numbers', () => {
    expect(reconstructAnswers({
      license_type: 'family_home',
      michigan_license_number: 'DC-99',
      michigan_provider_id: 'PRV-7',
    })).toEqual({
      license_status: LICENSE_STATUS.FAMILY_HOME,
      license_number: { license_number: 'DC-99', provider_id: 'PRV-7' },
    })
  })

  it('reconstructs a group_home provider', () => {
    expect(reconstructAnswers({
      license_type: 'group_home',
      michigan_license_number: 'DC-12345',
    })).toEqual({
      license_status: LICENSE_STATUS.GROUP_HOME,
      license_number: { license_number: 'DC-12345' },
    })
  })

  it('reads the three participation gates from onboarding_state.gate_answers', () => {
    const answers = reconstructAnswers({
      license_type: 'license_exempt',
      program_settings: { cdc: 'force_on' },
      onboarding_state: {
        gate_answers: { cdc: 'yes', tri_share: 'never_heard', gsrp: 'no' },
      },
    })
    expect(answers.cdc).toBe('yes')
    expect(answers.tri_share).toBe(TRI_SHARE_ANSWER.NEVER_HEARD)
    expect(answers.gsrp).toBe('no')
  })

  it('does not infer a gate answer when gate_answers has no entry', () => {
    // program_settings.cdc force_on but no gate_answers -> not reconstructed.
    const answers = reconstructAnswers({ program_settings: { cdc: 'force_on' } })
    expect(answers.cdc).toBeUndefined()
  })

  it('reconstructs CACFP from the canonical boolean, with the sponsor', () => {
    expect(reconstructAnswers({
      program_settings: { cacfp: true, cacfp_sponsor: 'Great Lakes CACFP' },
    }).cacfp).toEqual({ participates: 'yes', sponsor: 'Great Lakes CACFP' })

    expect(reconstructAnswers({ program_settings: { cacfp: true } }).cacfp)
      .toEqual({ participates: 'yes' })

    expect(reconstructAnswers({ program_settings: { cacfp: false } }).cacfp)
      .toEqual({ participates: 'no' })
  })

  it('reconstructs the soft-context buckets', () => {
    const answers = reconstructAnswers({
      program_settings: { onboarding_child_count: '4_6', onboarding_care_hours: '50_plus' },
    })
    expect(answers.child_count).toBe('4_6')
    expect(answers.care_hours).toBe('50_plus')
  })
})

// -----------------------------------------------------------------------------
// isDraftSubmittable
// -----------------------------------------------------------------------------

describe('isDraftSubmittable', () => {
  const choice = getQuestion('cdc')
  const cacfp = getQuestion('cacfp')
  const text = getQuestion('miregistry_id')
  const compound = getQuestion('license_number')

  it('requires a selection for a plain choice question', () => {
    expect(isDraftSubmittable(choice, null)).toBe(false)
    expect(isDraftSubmittable(choice, YES_NO.YES)).toBe(true)
  })

  it('requires the participation choice (not the sponsor) for cacfp', () => {
    expect(isDraftSubmittable(cacfp, null)).toBe(false)
    expect(isDraftSubmittable(cacfp, { sponsor: 'x' })).toBe(false)
    expect(isDraftSubmittable(cacfp, { participates: YES_NO.YES })).toBe(true)
  })

  it('requires non-empty text for a text question', () => {
    expect(isDraftSubmittable(text, null)).toBe(false)
    expect(isDraftSubmittable(text, '')).toBe(false)
    expect(isDraftSubmittable(text, '   ')).toBe(false)
    expect(isDraftSubmittable(text, 'MR-1')).toBe(true)
  })

  it('requires every non-optional field for a compound question', () => {
    // license_number is required, provider_id is optional.
    expect(isDraftSubmittable(compound, null)).toBe(false)
    expect(isDraftSubmittable(compound, { provider_id: 'PRV-7' })).toBe(false)
    expect(isDraftSubmittable(compound, { license_number: 'DC-99' })).toBe(true)
  })

  it('returns false for a missing question', () => {
    expect(isDraftSubmittable(null, 'anything')).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// buildProfileUpdate — the write payload
// -----------------------------------------------------------------------------

describe('buildProfileUpdate', () => {
  const NOW = '2026-05-18T12:00:00.000Z'

  it('writes license_type + mirrored is_license_exempt + cleared review_needed for a license_status answer (PR #14)', () => {
    const { update } = buildProfileUpdate({
      profile: {},
      event: { type: 'answer', stepKey: 'license_status', answer: LICENSE_STATUS.FAMILY_HOME },
      now: NOW,
    })
    expect(update.license_type).toBe('family_home')
    expect(update.is_license_exempt).toBe(false)
    expect(update.license_type_review_needed).toBe(false)
    expect(update.onboarding_state.version).toBe(1)
    expect(update.onboarding_state.last_step).toBe('license_number')
    expect(update.onboarding_state.completed_at).toBeNull()
  })

  it('records a gate "yes" in both program_settings and gate_answers', () => {
    const { update } = buildProfileUpdate({
      profile: { onboarding_state: { last_step: 'cdc' } },
      event: { type: 'answer', stepKey: 'cdc', answer: YES_NO.YES },
      now: NOW,
    })
    expect(update.program_settings.cdc).toBe('force_on')
    expect(update.onboarding_state.gate_answers.cdc).toBe('yes')
    expect(update.onboarding_state.last_step).toBe('tri_share')
  })

  it('records a gate "no" as an absent key but a stored gate_answer', () => {
    const { update } = buildProfileUpdate({
      profile: { program_settings: { cdc: 'force_on' } },
      event: { type: 'answer', stepKey: 'cdc', answer: YES_NO.NO },
      now: NOW,
    })
    expect('cdc' in update.program_settings).toBe(false)
    expect(update.onboarding_state.gate_answers.cdc).toBe('no')
  })

  it('keeps Tri-Share "never heard" distinct in gate_answers', () => {
    const { update } = buildProfileUpdate({
      profile: {},
      event: { type: 'answer', stepKey: 'tri_share', answer: TRI_SHARE_ANSWER.NEVER_HEARD },
      now: NOW,
    })
    expect('tri_share' in update.program_settings).toBe(false)
    expect(update.onboarding_state.gate_answers.tri_share).toBe('never_heard')
  })

  it('stamps completed_at when an answer resolves the final step', () => {
    const { update } = buildProfileUpdate({
      profile: { license_type: 'license_exempt' },
      event: { type: 'answer', stepKey: 'care_hours', answer: 'under_20' },
      now: NOW,
    })
    expect(update.onboarding_state.completed_at).toBe(NOW)
  })

  it('adds a skipped step and advances last_step', () => {
    const { update } = buildProfileUpdate({
      profile: { onboarding_state: { skipped: [] } },
      event: { type: 'skip', stepKey: 'cdc' },
      now: NOW,
    })
    expect(update.onboarding_state.skipped).toContain('cdc')
    expect(update.onboarding_state.last_step).toBe('tri_share')
  })

  it('stamps completed_at when a skip resolves the final step', () => {
    const { update } = buildProfileUpdate({
      profile: { license_type: 'license_exempt' },
      event: { type: 'skip', stepKey: 'care_hours' },
      now: NOW,
    })
    expect(update.onboarding_state.completed_at).toBe(NOW)
  })

  it('stamps dismissed_at and parks last_step on the current step for a dismiss', () => {
    const { update } = buildProfileUpdate({
      profile: {},
      event: { type: 'dismiss', currentStep: 'gsrp' },
      now: NOW,
    })
    expect(update.onboarding_state.dismissed_at).toBe(NOW)
    expect(update.onboarding_state.last_step).toBe('gsrp')
  })

  it('preserves existing program_settings keys and skipped entries', () => {
    const { update } = buildProfileUpdate({
      profile: {
        program_settings: { tri_share: 'force_on', cacfp: true },
        onboarding_state: { skipped: ['miregistry_id'] },
      },
      event: { type: 'answer', stepKey: 'cdc', answer: YES_NO.YES },
      now: NOW,
    })
    expect(update.program_settings.tri_share).toBe('force_on')
    expect(update.program_settings.cacfp).toBe(true)
    expect(update.onboarding_state.skipped).toContain('miregistry_id')
  })

  it('does not overwrite an already-set completed_at', () => {
    const { update } = buildProfileUpdate({
      profile: { onboarding_state: { completed_at: '2026-01-01T00:00:00.000Z' } },
      event: { type: 'answer', stepKey: 'cdc', answer: YES_NO.NO },
      now: NOW,
    })
    expect(update.onboarding_state.completed_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns a nextProfile snapshot reflecting the update', () => {
    const { nextProfile } = buildProfileUpdate({
      profile: { id: 'u1', license_type: null },
      event: { type: 'answer', stepKey: 'license_status', answer: LICENSE_STATUS.EXEMPT },
      now: NOW,
    })
    expect(nextProfile.id).toBe('u1')
    expect(nextProfile.license_type).toBe('license_exempt')
    expect(nextProfile.is_license_exempt).toBe(true)
    expect(nextProfile.license_type_review_needed).toBe(false)
    expect(nextProfile.onboarding_state.last_step).toBe('miregistry_id')
  })
})

// -----------------------------------------------------------------------------
// getOnboardingProgress — dashboard summary
// -----------------------------------------------------------------------------

describe('getOnboardingProgress', () => {
  it('reports a blank profile as not started, not completed', () => {
    const p = getOnboardingProgress({})
    expect(p.completed).toBe(false)
    expect(p.dismissed).toBe(false)
    expect(p.started).toBe(false)
    expect(p.stepsResolved).toBe(0)
    expect(p.totalSteps).toBe(8)
    expect(p.outstandingFields).toEqual([])
  })

  it('counts resolved steps for a wizard in progress', () => {
    // license_status answered (via license_type), miregistry_id skipped — two steps resolved.
    const p = getOnboardingProgress({
      license_type: 'license_exempt',
      onboarding_state: { last_step: 'cdc', skipped: ['miregistry_id'] },
    })
    expect(p.started).toBe(true)
    expect(p.completed).toBe(false)
    expect(p.stepsResolved).toBe(2)
  })

  it('treats a dismissed-at-step-1 provider as started', () => {
    const p = getOnboardingProgress({
      onboarding_state: { last_step: 'license_status', dismissed_at: '2026-05-18T00:00:00Z' },
    })
    expect(p.started).toBe(true)
    expect(p.dismissed).toBe(true)
  })

  it('reports completed when completed_at is set', () => {
    const p = getOnboardingProgress({
      license_type: 'license_exempt',
      onboarding_state: { completed_at: '2026-05-18T00:00:00Z', skipped: [] },
    })
    expect(p.completed).toBe(true)
  })

  it('lists a skipped, still-empty field as outstanding', () => {
    const p = getOnboardingProgress({
      license_type: 'license_exempt',
      miregistry_id: null,
      onboarding_state: {
        completed_at: '2026-05-18T00:00:00Z',
        skipped: ['miregistry_id'],
      },
    })
    expect(p.outstandingFields).toContain('miregistry_id')
  })

  it('does NOT list a gate answered "no" as outstanding', () => {
    // cdc answered "no" -> program_settings.cdc absent (looks "missing"),
    // but it is not in skipped[], so it is not an outstanding field.
    const p = getOnboardingProgress({
      license_type: 'license_exempt',
      miregistry_id: 'MR-1',
      onboarding_state: {
        completed_at: '2026-05-18T00:00:00Z',
        skipped: [],
        gate_answers: { cdc: 'no', tri_share: 'no', gsrp: 'no' },
      },
    })
    expect(p.outstandingFields).toEqual([])
  })
})
