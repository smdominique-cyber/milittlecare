// Generic next-step prompt for the dashboard (spec § 3.3, § 7.1). It is
// distinct from the completion card: the card nudges a provider to
// *finish the wizard*; this prompt appears *after* the wizard is
// complete, when questions were skipped and their fields are still
// empty. The two are mutually exclusive — completion clears the card,
// then this picks up the remaining gaps (spec § 4.2).
//
// V1 ships this single generic prompt; the richer per-field set is a
// V2 follow-on. It routes to Business Info, the permanent settings home
// (spec § 6.2) — see docs/tech_debt.md for the note that program-
// participation fields do not yet have their own settings surface.

import { useNavigate } from 'react-router-dom'
import { ListChecks, ArrowRight } from 'lucide-react'
import '@/styles/onboarding.css'

export default function OnboardingNextStepPrompt({ progress }) {
  const navigate = useNavigate()

  // Only after the wizard is complete, and only if skipped fields remain.
  if (!progress || !progress.completed) return null
  const count = progress.outstandingFields.length
  if (count === 0) return null

  const noun = count === 1 ? 'question' : 'questions'
  const them = count === 1 ? 'it' : 'them'

  return (
    <div
      className="onboarding-nextstep"
      role="region"
      aria-label="Finish your setup details"
    >
      <div className="onboarding-nextstep__icon" aria-hidden="true">
        <ListChecks size={22} />
      </div>
      <div className="onboarding-nextstep__body">
        <h3 className="onboarding-nextstep__title">A few setup details left</h3>
        <p className="onboarding-nextstep__text">
          You skipped {count} {noun} during setup. You can add {them} from
          your business info whenever you&rsquo;re ready.
        </p>
      </div>
      <button
        type="button"
        className="onboarding-nextstep__cta"
        onClick={() => navigate('/business-info')}
      >
        Review setup
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
