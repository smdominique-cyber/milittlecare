// Persistent dashboard card prompting a provider to finish the
// onboarding wizard (spec § 3.3). It sits on the dashboard — never a
// modal, never blocking — and renders only while the wizard is
// incomplete; once completed_at is set the parent stops rendering it.
//
// "Finish setup" reopens the wizard at /onboarding, which hydrates to
// onboarding_state.last_step on its own.

import { useNavigate } from 'react-router-dom'
import { ClipboardList, ArrowRight } from 'lucide-react'
import '@/styles/onboarding.css'

export default function OnboardingCompletionCard({ progress }) {
  const navigate = useNavigate()

  // Defensive: the dashboard already gates on this, but never show the
  // card for a completed (or unknown) wizard.
  if (!progress || progress.completed) return null

  const { started, stepsResolved, totalSteps } = progress

  return (
    <div
      className="onboarding-dashcard"
      role="region"
      aria-label="Finish setting up MILittleCare"
    >
      <div className="onboarding-dashcard__icon" aria-hidden="true">
        <ClipboardList size={22} />
      </div>
      <div className="onboarding-dashcard__body">
        <h3 className="onboarding-dashcard__title">
          Finish setting up MILittleCare
        </h3>
        <p className="onboarding-dashcard__text">
          {started
            ? `You're ${stepsResolved} of ${totalSteps} questions in. `
              + 'Finishing lets us turn on the right tools for your program.'
            : 'Answer a few quick questions and we’ll turn on the right '
              + 'tools for your program.'}
        </p>
      </div>
      <button
        type="button"
        className="onboarding-dashcard__cta"
        onClick={() => navigate('/onboarding')}
      >
        {started ? 'Finish setup' : 'Get started'}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
