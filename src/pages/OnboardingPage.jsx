// First-login onboarding wizard page (PR #7). A full-screen flow
// mounted at /onboarding inside PaywallGate but outside DashboardLayout
// (spec § 4.1) — no sidebar chrome.
//
// The page is a thin shell: all wizard state and write-through live in
// useOnboarding. This component picks a view by status, renders the
// active question screen, and wires the Back / Skip / Continue /
// Finish-later controls.
//
// Licensee-only (spec § 9 decision 4). The Phase 3 auto-open trigger is
// separate; this page is currently reached by visiting /onboarding.

import { Navigate, useNavigate } from 'react-router-dom'
import { useRole } from '@/hooks/useRole'
import { useOnboarding } from '@/hooks/useOnboarding'
import { STATUS } from '@/hooks/onboardingReducer'
import OnboardingProgress from '@/components/onboarding/OnboardingProgress'
import QuestionScreen from '@/components/onboarding/QuestionScreen'
import OnboardingCompleteScreen from '@/components/onboarding/OnboardingCompleteScreen'
import '@/styles/onboarding.css'

export default function OnboardingPage() {
  const { isLicensee, loading: roleLoading } = useRole()
  const navigate = useNavigate()
  const wizard = useOnboarding()

  // Wait for the role and the profile fetch before deciding anything.
  if (roleLoading || wizard.status === STATUS.LOADING) {
    return (
      <div className="onboarding-shell onboarding-shell--center">
        <p className="onboarding-status">Loading&hellip;</p>
      </div>
    )
  }

  // Structural identity is a licensee-level concern (spec § 9 decision 4).
  if (!isLicensee) return <Navigate to="/dashboard" replace />

  if (wizard.status === STATUS.ERROR) {
    return (
      <div className="onboarding-shell onboarding-shell--center">
        <p className="onboarding-status onboarding-status--error" role="alert">
          {wizard.error}
        </p>
      </div>
    )
  }

  if (wizard.status === STATUS.COMPLETED) {
    return (
      <div className="onboarding-shell onboarding-shell--center">
        <div className="onboarding-card">
          <OnboardingCompleteScreen
            answers={wizard.answers}
            onDone={() => navigate('/dashboard')}
          />
        </div>
      </div>
    )
  }

  // STATUS.READY or STATUS.SAVING — an interactive question screen.
  return (
    <div className="onboarding-shell">
      <div className="onboarding-card">
        <header className="onboarding-card__header">
          <span className="onboarding-card__brand">Setting up MILittleCare</span>
          <OnboardingProgress
            current={wizard.stepNumber}
            total={wizard.totalSteps}
          />
        </header>

        <QuestionScreen
          question={wizard.question}
          draft={wizard.draft}
          onDraftChange={wizard.setDraft}
        />

        {wizard.error && (
          <p className="onboarding-error" role="alert">
            {wizard.error}
          </p>
        )}

        <div className="onboarding-actions">
          <button
            type="button"
            className="onboarding-btn onboarding-btn--ghost"
            onClick={wizard.back}
            disabled={!wizard.canGoBack || wizard.isSaving}
          >
            Back
          </button>
          <div className="onboarding-actions__right">
            <button
              type="button"
              className="onboarding-btn onboarding-btn--ghost"
              onClick={wizard.skip}
              disabled={wizard.isSaving}
            >
              Skip this question
            </button>
            <button
              type="button"
              className="onboarding-btn onboarding-btn--primary"
              onClick={wizard.answer}
              disabled={!wizard.canContinue}
            >
              {wizard.isSaving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>

        <footer className="onboarding-card__footer">
          <button
            type="button"
            className="onboarding-link"
            onClick={wizard.finishLater}
            disabled={wizard.isSaving}
          >
            Finish later
          </button>
          <span className="onboarding-card__footer-note">
            {' '}&mdash; you can pick this up from your dashboard anytime.
          </span>
        </footer>
      </div>
    </div>
  )
}
