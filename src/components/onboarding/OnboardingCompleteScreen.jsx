// The final onboarding wizard screen (spec § 3.3). It summarises which
// tools the provider's answers turned on and links to the dashboard.
// completed_at is already stamped by the time this renders — it is
// written in the same Supabase call that resolved the last question
// (see buildProfileUpdate), so this screen performs no writes.

import { CheckCircle2 } from 'lucide-react'
import { LICENSE_STATUS, YES_NO } from '@/lib/onboarding'

// Human-readable list of what the provider's answers activated. Mirrors
// the activation mapping in onboarding_wizard_spec.md § 5.1.
function activatedTools(answers) {
  const tools = []
  if (answers.license_status === LICENSE_STATUS.EXEMPT) {
    tools.push('the MiRegistry training tracker')
  }
  if (answers.cdc === YES_NO.YES) tools.push('CDC Scholarship billing tools')
  if (answers.tri_share === YES_NO.YES) tools.push('Tri-Share tools')
  if (answers.gsrp === YES_NO.YES) tools.push('GSRP tools')
  const cacfp = answers.cacfp
  if (cacfp && cacfp.participates === YES_NO.YES) {
    tools.push('food program (CACFP) tracking')
  }
  return tools
}

export default function OnboardingCompleteScreen({ answers = {}, onDone }) {
  const tools = activatedTools(answers)

  return (
    <div className="onboarding-complete">
      <CheckCircle2
        size={48}
        aria-hidden="true"
        className="onboarding-complete__icon"
      />
      <h1 className="onboarding-complete__heading">You&rsquo;re all set</h1>

      {tools.length > 0 ? (
        <>
          <p className="onboarding-complete__lead">
            Based on your answers, we&rsquo;ve turned on:
          </p>
          <ul className="onboarding-complete__list">
            {tools.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="onboarding-complete__lead">
          Your dashboard is ready. You can turn on program tools anytime
          from settings as your needs change.
        </p>
      )}

      <button
        type="button"
        className="onboarding-btn onboarding-btn--primary"
        onClick={onDone}
      >
        Go to my dashboard
      </button>
    </div>
  )
}
