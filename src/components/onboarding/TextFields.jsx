// Text input(s) for the onboarding wizard, driven by a QUESTION_CATALOG
// entry's `fields`. Covers two question kinds:
//
//   - 'text'      one field; the draft is the bare string value
//                 (e.g. miregistry_id)
//   - 'compound'  several fields on one screen; the draft is an object
//                 keyed by field name (e.g. license_number +
//                 provider_id)
//
// The two draft shapes match what getWriteTargets / reconstructAnswers
// in src/lib/onboarding.js expect for each question.

function FieldRow({ field, questionKey, value, onChange }) {
  const id = `onboarding-field-${questionKey}-${field.name}`
  return (
    <div className="onboarding-field">
      <label htmlFor={id} className="onboarding-field__label">
        {field.label}
      </label>
      <input
        id={id}
        type="text"
        className="onboarding-field__input"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export default function TextFields({ question, value, onChange }) {
  // 'text' — a single field; the draft is the string itself.
  if (question.kind === 'text') {
    const field = question.fields[0]
    return (
      <div className="onboarding-fields">
        <FieldRow
          field={field}
          questionKey={question.key}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
        />
      </div>
    )
  }

  // 'compound' — several fields; the draft is an object keyed by name.
  return (
    <div className="onboarding-fields">
      {question.fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          questionKey={question.key}
          value={(value && value[field.name]) || ''}
          onChange={(text) => onChange({ ...(value || {}), [field.name]: text })}
        />
      ))}
    </div>
  )
}
