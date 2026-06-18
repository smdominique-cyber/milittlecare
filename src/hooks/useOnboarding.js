// useOnboarding — the stateful wizard hook for the first-login
// onboarding flow (PR #7). It wraps the pure onboardingReducer with
// useReducer and owns all I/O: loading the provider's profile on mount
// and writing each confirmed answer / skip / dismiss back to Supabase.
//
// Write-through is strict-await (spec § 9 decision 2, Phase 2 review):
// SAVE_START -> await the Supabase write -> ANSWER_SUCCESS on success,
// SAVE_ERROR on failure. Local state never advances ahead of the DB.
//
// The pure transition logic lives in onboardingReducer.js and the
// catalog / write-payload logic in src/lib/onboarding.js — both are
// Vitest-tested. This hook is the thin React + Supabase wrapper.

import { useReducer, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import {
  getQuestion,
  getStepSequence,
  isDraftSubmittable,
  reconstructAnswers,
  buildProfileUpdate,
  STEPS_PER_PROVIDER,
} from '@/lib/onboarding'
import { ensureLicenseeSelfCaregiverRow } from '@/lib/licenseeRoster'
import { onboardingReducer, initialOnboardingState, STATUS } from './onboardingReducer'

// The profile columns the wizard reads and writes.
const PROFILE_COLUMNS =
  'id, is_license_exempt, miregistry_id, michigan_license_number, '
  + 'michigan_provider_id, program_settings, onboarding_state'

export function useOnboarding() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(onboardingReducer, initialOnboardingState)

  // The latest persisted profile snapshot — the merge base for the next
  // write. A ref (not reducer state) because only the write path reads it
  // and it must always be current without forcing a re-render.
  const profileRef = useRef(null)

  // Hydrate on mount / signed-in user change.
  useEffect(() => {
    let cancelled = false

    async function hydrate() {
      if (!user) return
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', user.id)
        .maybeSingle()
      if (cancelled) return
      if (error || !data) {
        dispatch({ type: 'HYDRATE_ERROR', error: 'We could not load your account. Please reload.' })
        return
      }
      profileRef.current = data
      const blob = data.onboarding_state || {}
      dispatch({
        type: 'HYDRATE',
        answers: reconstructAnswers(data),
        skipped: Array.isArray(blob.skipped) ? blob.skipped : [],
        currentStep: blob.last_step || 'license_status',
        completed: !!blob.completed_at,
      })
    }

    hydrate()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Apply one wizard event to Supabase; throws on failure.
  //
  // SIDE EFFECT on first completion: when this persist transitions the
  // profile from "not yet completed" → "completed" (i.e. the answer or
  // skip that resolved the final step), it also ensures the licensee
  // has a `caregivers` self-row. See src/lib/licenseeRoster.js for the
  // rationale + the single-create-path discipline. The side effect is
  // intentionally fired AFTER the primary profile write succeeds —
  // never before — so a failed profile write cannot leave a stray
  // self-row. The self-row create is best-effort: if it fails, we log
  // and proceed; mig 046 catches up any licensee whose post-completion
  // create did not stick (e.g., transient network) on next page load
  // via a one-time sweep. Onboarding is not blocked.
  //
  // Licensee gate (2026-06-18 Step 2 review): the side effect is
  // additionally gated on the absence of an active `staff_memberships`
  // row for the current user. RoleProvider treats that absence as the
  // definitive "this account is a licensee" signal (useRole.jsx:37-44)
  // and routes non-licensees away from useOnboarding entirely. The
  // gate here is insurance, not the primary defense — a future refactor
  // that exposes onboarding to a staff/co-provider account must not
  // silently create a self-row that puts that account into the
  // caregivers table as its own licensee. The check is one extra
  // round-trip on completion (rare event, cost acceptable). On gate
  // error (RLS / network), we skip the create — mig 046 (or any future
  // run) catches up.
  //
  // `license_type` was considered as the signal but rejected: it is
  // not in PROFILE_COLUMNS so the hydrate path doesn't see it, and a
  // staff account that ever entered onboarding could in principle
  // answer screen 1 and have `license_type` set on its OWN profile
  // row — making it an unreliable filter. `staff_memberships` absence
  // is what `RoleProvider` already uses and is the same source of
  // truth.
  async function persist(event) {
    const profile = profileRef.current
    if (!profile) throw new Error('profile not loaded')
    const wasCompleted = !!(profile.onboarding_state && profile.onboarding_state.completed_at)
    const { update, nextProfile } = buildProfileUpdate({ profile, event })
    const { error } = await supabase.from('profiles').update(update).eq('id', profile.id)
    if (error) throw error
    profileRef.current = nextProfile
    const nowCompleted = !!(nextProfile.onboarding_state && nextProfile.onboarding_state.completed_at)
    if (!wasCompleted && nowCompleted && user) {
      // Licensee gate — see comment block above for rationale.
      // staff_memberships predates this hook (mig 020 area). We query
      // by `staff_user_id = auth.uid()` AND `status = 'active'`; any
      // hit means the account is a staff member of someone else's
      // home and the self-row create must be skipped. The query
      // mirrors useRole.jsx:37-43 exactly so a future refactor of the
      // licensee detection rule can be made in one place.
      let isLicensee = true  // optimistic; corrected below
      try {
        const { data: memberships, error: mErr } = await supabase
          .from('staff_memberships')
          .select('id')
          .eq('staff_user_id', user.id)
          .eq('status', 'active')
          .limit(1)
        if (mErr) {
          console.error('useOnboarding: staff_memberships gate query failed; skipping self-row create', mErr)
          isLicensee = false
        } else if (memberships && memberships.length > 0) {
          // A staff account completed onboarding. Should not happen
          // today (RoleProvider routes them away) but we refuse to
          // pollute caregivers if it ever does.
          console.warn('useOnboarding: completion fired for non-licensee account; skipping self-row create')
          isLicensee = false
        }
      } catch (mThrew) {
        console.error('useOnboarding: staff_memberships gate threw; skipping self-row create', mThrew)
        isLicensee = false
      }
      if (isLicensee) {
        // Onboarding only runs for licensees (confirmed above by the
        // gate). The helper itself is defensive (it gates on user.id
        // and uses the unique (licensee_id, app_user_id) constraint
        // for idempotency). A catch here is paranoid — the helper
        // does not throw — but we wrap anyway so any future contract
        // change is contained.
        try {
          const { error: roleErr } = await ensureLicenseeSelfCaregiverRow({ user })
          if (roleErr) {
            console.error('useOnboarding: licensee self-row create returned an error', roleErr)
          }
        } catch (selfErr) {
          console.error('useOnboarding: licensee self-row create threw', selfErr)
        }
      }
    }
  }

  const question = getQuestion(state.currentStep)
  const sequence = getStepSequence(state.answers)
  const stepIndex = sequence.indexOf(state.currentStep) // 0-based, -1 if off-sequence

  function setDraft(value) {
    dispatch({ type: 'SET_DRAFT', value })
  }

  async function answer() {
    if (state.status !== STATUS.READY) return
    const stepKey = state.currentStep
    const value = state.draft
    dispatch({ type: 'SAVE_START' })
    try {
      await persist({ type: 'answer', stepKey, answer: value })
      dispatch({ type: 'ANSWER_SUCCESS', stepKey, answer: value })
    } catch {
      dispatch({ type: 'SAVE_ERROR', error: 'We could not save your answer. Please try again.' })
    }
  }

  async function skip() {
    if (state.status !== STATUS.READY) return
    const stepKey = state.currentStep
    dispatch({ type: 'SAVE_START' })
    try {
      await persist({ type: 'skip', stepKey })
      dispatch({ type: 'SKIP_SUCCESS', stepKey })
    } catch {
      dispatch({ type: 'SAVE_ERROR', error: 'We could not skip this question. Please try again.' })
    }
  }

  function back() {
    if (state.status !== STATUS.READY) return
    dispatch({ type: 'BACK' })
  }

  async function finishLater() {
    if (state.status !== STATUS.READY) return
    const currentStep = state.currentStep
    dispatch({ type: 'SAVE_START' })
    try {
      await persist({ type: 'dismiss', currentStep })
      navigate('/dashboard')
    } catch {
      dispatch({ type: 'SAVE_ERROR', error: 'We could not save your progress. Please try again.' })
    }
  }

  return {
    status: state.status,
    error: state.error,
    question,
    draft: state.draft,
    stepNumber: stepIndex < 0 ? 1 : stepIndex + 1, // 1-based, for display
    totalSteps: STEPS_PER_PROVIDER,
    canGoBack: stepIndex > 0,
    canContinue: state.status === STATUS.READY && isDraftSubmittable(question, state.draft),
    isSaving: state.status === STATUS.SAVING,
    answers: state.answers,
    skipped: state.skipped,
    setDraft,
    answer,
    skip,
    back,
    finishLater,
  }
}
