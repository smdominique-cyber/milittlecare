// Choice input for the onboarding wizard — a styled radio group driven
// by a QUESTION_CATALOG entry's `options`. Used by every choice-kind
// question (license status, CDC, Tri-Share, GSRP, CACFP, child count,
// care hours).
//
// Two draft shapes:
//   - plain choice  -> draft is the selected option value (a string)
//   - cacfp         -> the question carries a `followUp`; draft is
//                      { participates, sponsor } and the sponsor text
//                      field appears once the follow-up's trigger value
//                      is selected.

export default function ChoiceInput({ question, value, onChange }) {
  const followUp = question.followUp
  const selected = followUp ? (value && value.participates) || null : value

  function pick(optionValue) {
    if (followUp) {
      onChange({ ...(value || {}), participates: optionValue })
    } else {
      onChange(optionValue)
    }
  }

  function setFollowUp(text) {
    onChange({ ...(value || {}), [followUp.field]: text })
  }

  const showFollowUp = followUp && selected === followUp.whenValue
  const followUpId = `onboarding-followup-${question.key}`

  return (
    <div className="onboarding-choice">
      <div className="onboarding-choice__options">
        {question.options.map((opt) => {
          const isSelected = selected === opt.value
          return (
            <label
              key={opt.value}
              className={`onboarding-option${isSelected ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                className="onboarding-option__input"
                name={`onboarding-${question.key}`}
                value={opt.value}
                checked={isSelected}
                onChange={() => pick(opt.value)}
              />
              <span className="onboarding-option__marker" aria-hidden="true" />
              <span className="onboarding-option__text">
                <span className="onboarding-option__label">{opt.label}</span>
                {opt.help && (
                  <span className="onboarding-option__help">{opt.help}</span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      {showFollowUp && (
        <div className="onboarding-followup">
          <label htmlFor={followUpId} className="onboarding-field__label">
            {followUp.label}
          </label>
          <input
            id={followUpId}
            type="text"
            className="onboarding-field__input"
            value={(value && value[followUp.field]) || ''}
            onChange={(e) => setFollowUp(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}
