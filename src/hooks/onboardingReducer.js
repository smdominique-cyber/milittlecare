// Pure state machine for the onboarding wizard (PR #7). No React, no
// Supabase — just the reducer and its initial state, so the transition
// logic is unit-testable in isolation. The useOnboarding hook wraps this
// with useReducer and owns all I/O (profile fetch, write-through).
//
// Error handling (spec § 9 decision 2, and the Phase 2 review note):
// the hook awaits every Supabase write BEFORE dispatching a transition.
// SAVE_START moves to 'saving'; on success the hook dispatches
// ANSWER_SUCCESS / SKIP_SUCCESS (which advance); on failure it dispatches
// SAVE_ERROR (which returns to 'ready' WITHOUT advancing). There is no
// optimistic transition, so a failed write can never leave local state
// ahead of the database.

import { getNextStep, getStepSequence } from '@/lib/onboarding'

export const STATUS = Object.freeze({
  LOADING: 'loading',     // fetching the profile
  READY: 'ready',         // a question screen is interactive
  SAVING: 'saving',       // a write is in flight — Continue/Skip disabled
  COMPLETED: 'completed', // the final screen
  ERROR: 'error',         // the profile could not be loaded
})

const FIRST_STEP = 'license_status'

export const initialOnboardingState = Object.freeze({
  status: STATUS.LOADING,
  currentStep: FIRST_STEP,
  answers: {},
  skipped: [],
  draft: null,
  error: null,
})

/** The draft to show for `step`: its prior answer if any, else null. */
function draftFor(answers, step) {
  return Object.prototype.hasOwnProperty.call(answers, step) ? answers[step] : null
}

/**
 * Result of resolving (answering or skipping) `stepKey` given the updated
 * `answers`: the next step and the matching status/draft. When there is
 * no next step the wizard has reached the final screen.
 */
function advance(state, stepKey, answers) {
  const next = getNextStep(stepKey, answers)
  if (next === null) {
    return { ...state, status: STATUS.COMPLETED, answers, error: null }
  }
  return {
    ...state,
    status: STATUS.READY,
    answers,
    currentStep: next,
    draft: draftFor(answers, next),
    error: null,
  }
}

export function onboardingReducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': {
      const answers = action.answers || {}
      const skipped = action.skipped || []
      if (action.completed) {
        return { ...state, status: STATUS.COMPLETED, answers, skipped, error: null }
      }
      const currentStep = action.currentStep || FIRST_STEP
      return {
        ...state,
        status: STATUS.READY,
        answers,
        skipped,
        currentStep,
        draft: draftFor(answers, currentStep),
        error: null,
      }
    }

    case 'HYDRATE_ERROR':
      return { ...state, status: STATUS.ERROR, error: action.error || 'Could not load onboarding.' }

    case 'SET_DRAFT':
      return { ...state, draft: action.value }

    case 'SAVE_START':
      return { ...state, status: STATUS.SAVING, error: null }

    case 'SAVE_ERROR':
      // Return to the same screen — no transition (spec § 9 decision 2).
      return { ...state, status: STATUS.READY, error: action.error || 'Could not save. Please try again.' }

    case 'ANSWER_SUCCESS': {
      const answers = { ...state.answers, [action.stepKey]: action.answer }
      // Answering a previously-skipped step un-skips it.
      const skipped = state.skipped.filter(k => k !== action.stepKey)
      return advance({ ...state, skipped }, action.stepKey, answers)
    }

    case 'SKIP_SUCCESS': {
      const skipped = state.skipped.includes(action.stepKey)
        ? state.skipped
        : [...state.skipped, action.stepKey]
      // Skipping clears any prior answer for that step.
      const answers = { ...state.answers }
      delete answers[action.stepKey]
      return advance({ ...state, skipped }, action.stepKey, answers)
    }

    case 'BACK': {
      const sequence = getStepSequence(state.answers)
      const i = sequence.indexOf(state.currentStep)
      if (i <= 0) return state
      const prev = sequence[i - 1]
      return { ...state, currentStep: prev, draft: draftFor(state.answers, prev), error: null }
    }

    default:
      return state
  }
}
