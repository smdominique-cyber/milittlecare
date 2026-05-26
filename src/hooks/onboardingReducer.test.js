import { describe, it, expect } from 'vitest'
import { onboardingReducer, initialOnboardingState, STATUS } from './onboardingReducer'
import { LICENSE_STATUS, YES_NO } from '@/lib/onboarding'

// A 'ready' state partway through the wizard, license-exempt branch.
const readyAt = (currentStep, overrides = {}) => ({
  ...initialOnboardingState,
  status: STATUS.READY,
  currentStep,
  answers: { license_status: LICENSE_STATUS.EXEMPT },
  ...overrides,
})

describe('initialOnboardingState', () => {
  it('starts loading, on the first step, with no answers', () => {
    expect(initialOnboardingState.status).toBe(STATUS.LOADING)
    expect(initialOnboardingState.currentStep).toBe('license_status')
    expect(initialOnboardingState.answers).toEqual({})
    expect(initialOnboardingState.skipped).toEqual([])
  })
})

describe('HYDRATE', () => {
  it('moves to ready and lands on the resume step', () => {
    const next = onboardingReducer(initialOnboardingState, {
      type: 'HYDRATE',
      answers: { license_status: LICENSE_STATUS.EXEMPT, cdc: YES_NO.YES },
      skipped: ['miregistry_id'],
      currentStep: 'tri_share',
    })
    expect(next.status).toBe(STATUS.READY)
    expect(next.currentStep).toBe('tri_share')
    expect(next.skipped).toEqual(['miregistry_id'])
  })

  it('pre-fills the draft from an existing answer for the resume step', () => {
    const next = onboardingReducer(initialOnboardingState, {
      type: 'HYDRATE',
      answers: { cdc: YES_NO.NO },
      skipped: [],
      currentStep: 'cdc',
    })
    expect(next.draft).toBe(YES_NO.NO)
  })

  it('goes straight to completed when the profile is already onboarded', () => {
    const next = onboardingReducer(initialOnboardingState, {
      type: 'HYDRATE',
      answers: {},
      skipped: [],
      currentStep: 'care_hours',
      completed: true,
    })
    expect(next.status).toBe(STATUS.COMPLETED)
  })

  it('HYDRATE_ERROR moves to the error state', () => {
    const next = onboardingReducer(initialOnboardingState, {
      type: 'HYDRATE_ERROR',
      error: 'boom',
    })
    expect(next.status).toBe(STATUS.ERROR)
    expect(next.error).toBe('boom')
  })
})

describe('SET_DRAFT', () => {
  it('updates only the draft', () => {
    const state = readyAt('cdc')
    const next = onboardingReducer(state, { type: 'SET_DRAFT', value: YES_NO.YES })
    expect(next.draft).toBe(YES_NO.YES)
    expect(next.currentStep).toBe('cdc')
  })
})

describe('SAVE_START / SAVE_ERROR', () => {
  it('SAVE_START moves to saving and clears any prior error', () => {
    const next = onboardingReducer(readyAt('cdc', { error: 'old' }), { type: 'SAVE_START' })
    expect(next.status).toBe(STATUS.SAVING)
    expect(next.error).toBeNull()
  })

  it('SAVE_ERROR returns to ready WITHOUT advancing the step', () => {
    const state = { ...readyAt('cdc'), status: STATUS.SAVING }
    const next = onboardingReducer(state, { type: 'SAVE_ERROR', error: 'network down' })
    expect(next.status).toBe(STATUS.READY)
    expect(next.error).toBe('network down')
    expect(next.currentStep).toBe('cdc') // unchanged — no desync
  })
})

describe('ANSWER_SUCCESS', () => {
  it('commits the answer and advances to the next step', () => {
    const next = onboardingReducer(readyAt('cdc'), {
      type: 'ANSWER_SUCCESS', stepKey: 'cdc', answer: YES_NO.YES,
    })
    expect(next.answers.cdc).toBe(YES_NO.YES)
    expect(next.currentStep).toBe('tri_share')
    expect(next.status).toBe(STATUS.READY)
  })

  it('follows the conditional branch when license_status is answered', () => {
    const licensed = onboardingReducer(
      { ...initialOnboardingState, status: STATUS.READY, currentStep: 'license_status' },
      { type: 'ANSWER_SUCCESS', stepKey: 'license_status', answer: LICENSE_STATUS.FAMILY_HOME },
    )
    expect(licensed.currentStep).toBe('license_number')

    const exempt = onboardingReducer(
      { ...initialOnboardingState, status: STATUS.READY, currentStep: 'license_status' },
      { type: 'ANSWER_SUCCESS', stepKey: 'license_status', answer: LICENSE_STATUS.EXEMPT },
    )
    expect(exempt.currentStep).toBe('miregistry_id')
  })

  it('pre-fills the draft for the next step from an existing answer', () => {
    const state = readyAt('cdc', { answers: { license_status: LICENSE_STATUS.EXEMPT, tri_share: YES_NO.NO } })
    const next = onboardingReducer(state, { type: 'ANSWER_SUCCESS', stepKey: 'cdc', answer: YES_NO.YES })
    expect(next.currentStep).toBe('tri_share')
    expect(next.draft).toBe(YES_NO.NO)
  })

  it('un-skips a step that was previously skipped', () => {
    const state = readyAt('cdc', { skipped: ['cdc'] })
    const next = onboardingReducer(state, { type: 'ANSWER_SUCCESS', stepKey: 'cdc', answer: YES_NO.NO })
    expect(next.skipped).not.toContain('cdc')
  })

  it('moves to completed when the final step is answered', () => {
    const next = onboardingReducer(readyAt('care_hours'), {
      type: 'ANSWER_SUCCESS', stepKey: 'care_hours', answer: 'under_20',
    })
    expect(next.status).toBe(STATUS.COMPLETED)
    expect(next.answers.care_hours).toBe('under_20')
  })
})

describe('SKIP_SUCCESS', () => {
  it('records the skip and advances', () => {
    const next = onboardingReducer(readyAt('cdc'), { type: 'SKIP_SUCCESS', stepKey: 'cdc' })
    expect(next.skipped).toContain('cdc')
    expect(next.currentStep).toBe('tri_share')
  })

  it('drops any prior answer for the skipped step', () => {
    const state = readyAt('cdc', { answers: { license_status: LICENSE_STATUS.EXEMPT, cdc: YES_NO.YES } })
    const next = onboardingReducer(state, { type: 'SKIP_SUCCESS', stepKey: 'cdc' })
    expect(next.answers.cdc).toBeUndefined()
  })

  it('moves to completed when the final step is skipped', () => {
    const next = onboardingReducer(readyAt('care_hours'), { type: 'SKIP_SUCCESS', stepKey: 'care_hours' })
    expect(next.status).toBe(STATUS.COMPLETED)
  })
})

describe('BACK', () => {
  it('moves to the previous step in the sequence', () => {
    const next = onboardingReducer(readyAt('tri_share'), { type: 'BACK' })
    expect(next.currentStep).toBe('cdc')
  })

  it('pre-fills the draft with the previous step\'s answer', () => {
    const state = readyAt('tri_share', {
      answers: { license_status: LICENSE_STATUS.EXEMPT, cdc: YES_NO.YES },
    })
    const next = onboardingReducer(state, { type: 'BACK' })
    expect(next.currentStep).toBe('cdc')
    expect(next.draft).toBe(YES_NO.YES)
  })

  it('crosses the conditional branch correctly', () => {
    // Licensed branch: the step before cdc is license_number, not miregistry_id.
    const state = readyAt('cdc', { answers: { license_status: LICENSE_STATUS.FAMILY_HOME } })
    const next = onboardingReducer(state, { type: 'BACK' })
    expect(next.currentStep).toBe('license_number')
  })

  it('is a no-op on the first step', () => {
    const state = readyAt('license_status')
    expect(onboardingReducer(state, { type: 'BACK' })).toBe(state)
  })
})

describe('unknown action', () => {
  it('returns the state unchanged', () => {
    const state = readyAt('cdc')
    expect(onboardingReducer(state, { type: 'NOPE' })).toBe(state)
  })
})
