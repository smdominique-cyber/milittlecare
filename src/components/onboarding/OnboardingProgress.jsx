// Onboarding wizard progress indicator. Shows the current question
// number out of the total only — it deliberately does NOT preview
// upcoming questions, so the conditional branch (spec § 3.1) stays
// invisible until the provider answers screen 1.
//
// Progress is "visible but de-emphasised" per spec § 3.1 — a quiet
// label plus a thin track, not a prominent progress bar to grind.

export default function OnboardingProgress({ current, total }) {
  const safeCurrent = Math.min(Math.max(current || 1, 1), total)
  const pct = Math.round((safeCurrent / total) * 100)

  return (
    <div className="onboarding-progress">
      <span className="onboarding-progress__label">
        Question {safeCurrent} of {total}
      </span>
      <div
        className="onboarding-progress__track"
        role="progressbar"
        aria-valuenow={safeCurrent}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={`Question ${safeCurrent} of ${total}`}
      >
        <div className="onboarding-progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
