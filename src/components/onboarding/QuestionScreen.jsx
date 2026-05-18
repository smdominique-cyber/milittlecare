// One onboarding wizard question screen — the prompt, the input, and
// the inline "why we ask" line (spec § 3.1, § 3.5: every screen carries
// its own help, one question per screen).
//
// Generic and data-driven: it reads a QUESTION_CATALOG entry and
// delegates the input to ChoiceInput or TextFields by `kind`. It owns
// no state — the in-progress draft and its setter are passed down from
// the page (which holds them via useOnboarding).

import { Info } from 'lucide-react'
import ChoiceInput from './ChoiceInput'
import TextFields from './TextFields'

export default function QuestionScreen({ question, draft, onDraftChange }) {
  if (!question) return null

  return (
    <div className="onboarding-question">
      <h1 className="onboarding-question__prompt">{question.prompt}</h1>

      {question.kind === 'choice' ? (
        <ChoiceInput question={question} value={draft} onChange={onDraftChange} />
      ) : (
        <TextFields question={question} value={draft} onChange={onDraftChange} />
      )}

      <p className="onboarding-question__why">
        <Info size={16} aria-hidden="true" className="onboarding-question__why-icon" />
        <span>
          <strong>Why we ask:</strong> {question.why}
        </span>
      </p>
    </div>
  )
}
