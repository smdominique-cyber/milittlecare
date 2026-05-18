// Pure helpers + data for the first-login onboarding wizard (PR #7).
// No Supabase imports, no React, no I/O. The wizard component fetches
// the provider's profile, holds the in-progress answers in component
// state, and calls into this module for: the question catalog, the
// conditional step sequence, the completion check, the still-missing
// structural fields, and the canonical write targets each answer maps
// to.
//
// See docs/onboarding_wizard_spec.md (§ 2, § 3, § 4, § 5, Appendix).
// Mirrors the style of src/lib/cdcPayPeriods.js: frozen data + pure
// functions, Vitest-tested, no side effects. UI rendering lives in the
// Phase 2 components, not here.
//
// Two notes on decisions baked into this file:
//
//   - Copy (prompt / why / option labels) is provisional. Spec § 3.5
//     defers copy review to a later cadence; the catalog carries a
//     stable `copyKey` per question and option so wording can change
//     without breaking callers.
//
//   - Soft-context answers (child count, weekly care hours, CACFP
//     sponsor name) are written into profiles.program_settings under
//     namespaced keys (`onboarding_*`, `cacfp_sponsor`). Spec § 2.2 /
//     § 9 decision 11 allows program_settings OR onboarding_state;
//     program_settings is chosen so all provider configuration sits in
//     one blob. modules.js ignores unknown keys, so this is safe.

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// The blob schema version written into profiles.onboarding_state.version.
export const ONBOARDING_STATE_VERSION = 1

// Every provider answers the license-status question, then a branch,
// then six common questions: 8 screens total (spec Appendix).
export const STEPS_PER_PROVIDER = 8

// License-status answer values (wizard screen 1, the branch question).
export const LICENSE_STATUS = Object.freeze({
  EXEMPT: 'license_exempt',
  LICENSED: 'licensed',
})

// Plain yes/no answer values (CDC, GSRP).
export const YES_NO = Object.freeze({
  YES: 'yes',
  NO: 'no',
})

// Tri-Share is a three-option question (§ 9 decision 9): "never heard
// of it" stores the same state as "no" but is also recorded in
// onboarding_state as a product-analytics signal.
export const TRI_SHARE_ANSWER = Object.freeze({
  YES: 'yes',
  NO: 'no',
  NEVER_HEARD: 'never_heard',
})

// Coarse buckets — answers are deliberately approximate (§ 9 decision 11).
export const CHILD_COUNT_BUCKETS = Object.freeze(['1_3', '4_6', '7_12', '12_plus'])
export const CARE_HOURS_BUCKETS = Object.freeze([
  'under_20', '20_to_34', '35_to_49', '50_plus',
])

// Question scope, used to decide which branch step a provider sees.
const APPLIES_TO = Object.freeze({
  ALL: 'all',
  EXEMPT: 'license_exempt',
  LICENSED: 'licensed',
})

// Question input kind, consumed by the Phase 2 screen components.
const QUESTION_KIND = Object.freeze({
  CHOICE: 'choice',     // pick one option
  TEXT: 'text',         // one free-text field
  COMPOUND: 'compound', // several fields on one screen
})

// -----------------------------------------------------------------------------
// Question catalog
//
// Nine question definitions (spec Appendix). Any one provider sees
// eight: the license-status branch (screen 2a vs 2b) shows exactly one
// of `miregistry_id` / `license_number`.
// -----------------------------------------------------------------------------

const RAW_CATALOG = [
  {
    key: 'license_status',
    screen: 1,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: true,
    copyKey: 'onboarding.q.license_status',
    prompt: 'First — how does your child care operate?',
    why: 'This decides which training and compliance tools we turn on '
      + 'for you — they are different for each.',
    options: [
      {
        value: LICENSE_STATUS.EXEMPT,
        copyKey: 'onboarding.q.license_status.opt.exempt',
        label: 'I care for children I am related to or already know, '
          + 'registered with MDHHS',
        help: 'The most common setup for in-home providers. Not licensed '
          + 'by the State of Michigan.',
      },
      {
        value: LICENSE_STATUS.LICENSED,
        copyKey: 'onboarding.q.license_status.opt.licensed',
        label: 'I hold a Michigan child care license',
        help: 'A licensed Family or Group Child Care Home.',
      },
    ],
  },
  {
    key: 'miregistry_id',
    screen: 2,          // screen 2a — license-exempt branch
    appliesTo: APPLIES_TO.EXEMPT,
    kind: QUESTION_KIND.TEXT,
    isBranch: false,
    copyKey: 'onboarding.q.miregistry_id',
    prompt: 'What is your MiRegistry ID?',
    why: 'We use it to track your December 16 training deadline and your '
      + 'Level 1 / Level 2 pay rate.',
    fields: [
      {
        name: 'miregistry_id',
        copyKey: 'onboarding.q.miregistry_id.field',
        label: 'MiRegistry ID',
        optional: true,
      },
    ],
  },
  {
    key: 'license_number',
    screen: 2,          // screen 2b — licensed branch
    appliesTo: APPLIES_TO.LICENSED,
    kind: QUESTION_KIND.COMPOUND,
    isBranch: false,
    copyKey: 'onboarding.q.license_number',
    prompt: 'What is your Michigan child care license number?',
    why: 'It identifies your licensed home for compliance tracking.',
    fields: [
      {
        name: 'license_number',
        copyKey: 'onboarding.q.license_number.field.license',
        label: 'Michigan license number',
        optional: false,
      },
      {
        name: 'provider_id',
        copyKey: 'onboarding.q.license_number.field.provider',
        label: 'Provider ID (optional)',
        optional: true,
      },
    ],
  },
  {
    key: 'cdc',
    screen: 3,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.cdc',
    prompt: 'Do you take payment from a state child care program for any '
      + 'of your families?',
    why: 'If you do, we turn on CDC Scholarship billing and the I-Billing '
      + 'tools.',
    options: [
      { value: YES_NO.YES, copyKey: 'onboarding.q.cdc.opt.yes', label: 'Yes' },
      { value: YES_NO.NO, copyKey: 'onboarding.q.cdc.opt.no', label: 'No' },
    ],
  },
  {
    key: 'tri_share',
    screen: 4,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.tri_share',
    prompt: 'Do any families pay through a Tri-Share program?',
    why: 'Tri-Share splits child care cost between the family, their '
      + 'employer, and the state. If you take part, we turn on Tri-Share '
      + 'tools.',
    options: [
      {
        value: TRI_SHARE_ANSWER.YES,
        copyKey: 'onboarding.q.tri_share.opt.yes',
        label: 'Yes',
      },
      {
        value: TRI_SHARE_ANSWER.NO,
        copyKey: 'onboarding.q.tri_share.opt.no',
        label: 'No',
      },
      {
        value: TRI_SHARE_ANSWER.NEVER_HEARD,
        copyKey: 'onboarding.q.tri_share.opt.never_heard',
        label: 'I have never heard of Tri-Share',
      },
    ],
  },
  {
    key: 'gsrp',
    screen: 5,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.gsrp',
    prompt: 'Do you run a Great Start Readiness Program classroom?',
    why: 'GSRP is Michigan’s state-funded preschool program. If you '
      + 'participate, we turn on GSRP tools.',
    options: [
      { value: YES_NO.YES, copyKey: 'onboarding.q.gsrp.opt.yes', label: 'Yes' },
      { value: YES_NO.NO, copyKey: 'onboarding.q.gsrp.opt.no', label: 'No' },
    ],
  },
  {
    key: 'cacfp',
    screen: 6,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.cacfp',
    prompt: 'Do you serve meals through a food program?',
    why: 'The CACFP food program reimburses providers for meals and '
      + 'snacks. If you take part, we turn on food-program tracking.',
    options: [
      { value: YES_NO.YES, copyKey: 'onboarding.q.cacfp.opt.yes', label: 'Yes' },
      { value: YES_NO.NO, copyKey: 'onboarding.q.cacfp.opt.no', label: 'No' },
    ],
    // Shown only when the answer is "yes". Sponsor is free text — there
    // is no CACFP sponsor directory in the system (§ 9 decision 10).
    followUp: {
      whenValue: YES_NO.YES,
      field: 'sponsor',
      copyKey: 'onboarding.q.cacfp.followup.sponsor',
      label: 'Who is your CACFP sponsor?',
      optional: true,
    },
  },
  {
    key: 'child_count',
    screen: 7,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.child_count',
    prompt: 'Roughly how many children are in your care right now?',
    why: 'A rough number helps us size the tools you see. You can change '
      + 'it anytime.',
    options: [
      { value: '1_3', copyKey: 'onboarding.q.child_count.opt.1_3', label: '1–3 children' },
      { value: '4_6', copyKey: 'onboarding.q.child_count.opt.4_6', label: '4–6 children' },
      { value: '7_12', copyKey: 'onboarding.q.child_count.opt.7_12', label: '7–12 children' },
      { value: '12_plus', copyKey: 'onboarding.q.child_count.opt.12_plus', label: 'More than 12 children' },
    ],
  },
  {
    key: 'care_hours',
    screen: 8,
    appliesTo: APPLIES_TO.ALL,
    kind: QUESTION_KIND.CHOICE,
    isBranch: false,
    copyKey: 'onboarding.q.care_hours',
    prompt: 'About how many hours of care do you provide in a typical week?',
    why: 'A rough picture of your schedule helps us tailor reminders. You '
      + 'can change it anytime.',
    options: [
      { value: 'under_20', copyKey: 'onboarding.q.care_hours.opt.under_20', label: 'Under 20 hours a week' },
      { value: '20_to_34', copyKey: 'onboarding.q.care_hours.opt.20_to_34', label: '20–34 hours a week' },
      { value: '35_to_49', copyKey: 'onboarding.q.care_hours.opt.35_to_49', label: '35–49 hours a week' },
      { value: '50_plus', copyKey: 'onboarding.q.care_hours.opt.50_plus', label: '50 or more hours a week' },
    ],
  },
]

/** Recursively freeze an object graph so the exported catalog is immutable. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

// The exported catalog (all 9 question definitions), deeply frozen.
export const QUESTION_CATALOG = deepFreeze(RAW_CATALOG)

const QUESTION_BY_KEY = Object.freeze(
  Object.fromEntries(QUESTION_CATALOG.map(q => [q.key, q]))
)

// The branch step a provider sees at screen 2, by license-status answer.
const BRANCH_STEP_BY_STATUS = Object.freeze({
  [LICENSE_STATUS.EXEMPT]: 'miregistry_id',
  [LICENSE_STATUS.LICENSED]: 'license_number',
})

// -----------------------------------------------------------------------------
// Catalog lookup
// -----------------------------------------------------------------------------

/**
 * The question definition for a step key, or null if the key is unknown.
 *
 * @param {string} key   A wizard step key (e.g. 'cdc').
 * @returns {object|null}
 */
export function getQuestion(key) {
  return QUESTION_BY_KEY[key] || null
}

// -----------------------------------------------------------------------------
// Conditional flow
// -----------------------------------------------------------------------------

/**
 * The ordered list of step keys this provider walks — always 8 entries
 * (STEPS_PER_PROVIDER). Screen 2 is the conditional branch: a `licensed`
 * license-status answer routes to `license_number`; every other case —
 * `license_exempt`, an unrecognised value, or no answer yet — routes to
 * `miregistry_id`.
 *
 * The license-exempt default is deliberate: it is the most common setup
 * (spec § 3.2), and before screen 1 is answered the wizard still needs a
 * stable sequence to drive "Question X of 8" and resume. A provider who
 * explicitly skips screen 1 lands on the MiRegistry question, which is
 * itself skippable. This default is flagged for Checkpoint A review.
 *
 * @param {object} [answers]   Map of step key -> confirmed answer.
 * @returns {string[]}         8 step keys, in screen order.
 */
export function getStepSequence(answers = {}) {
  const status = (answers && answers.license_status) || null
  const branchStep = BRANCH_STEP_BY_STATUS[status] || 'miregistry_id'
  return [
    'license_status',
    branchStep,
    'cdc',
    'tri_share',
    'gsrp',
    'cacfp',
    'child_count',
    'care_hours',
  ]
}

/**
 * The step that follows `currentKey` in this provider's sequence.
 * Returns the first step when `currentKey` is null/undefined, and null
 * when `currentKey` is the last step (or is not in the sequence).
 *
 * @param {string|null} currentKey   The step just completed, or null.
 * @param {object}      [answers]    Map of step key -> confirmed answer.
 * @returns {string|null}
 */
export function getNextStep(currentKey, answers = {}) {
  const sequence = getStepSequence(answers)
  if (currentKey === null || currentKey === undefined) return sequence[0]
  const i = sequence.indexOf(currentKey)
  if (i === -1 || i === sequence.length - 1) return null
  return sequence[i + 1]
}

// -----------------------------------------------------------------------------
// Completion
// -----------------------------------------------------------------------------

/** True when `answers` holds a confirmed (non-empty) value for `key`. */
function hasAnswer(answers, key) {
  if (!answers || !(key in answers)) return false
  const v = answers[key]
  return v !== null && v !== undefined && v !== ''
}

/**
 * Whether the wizard has run to the end (spec § 4.2): every step in the
 * provider's sequence is either answered or explicitly skipped. This is
 * "the wizard completed", NOT "every field is populated" — a provider
 * who skips questions still completes the wizard.
 *
 * @param {object}   [answers]   Map of step key -> confirmed answer.
 * @param {string[]} [skipped]   Step keys the provider explicitly skipped.
 * @returns {boolean}
 */
export function isComplete(answers = {}, skipped = []) {
  const skippedSet = new Set(Array.isArray(skipped) ? skipped : [])
  return getStepSequence(answers).every(
    key => hasAnswer(answers, key) || skippedSet.has(key),
  )
}

// -----------------------------------------------------------------------------
// Missing structural fields
// -----------------------------------------------------------------------------

/**
 * The structural fields whose canonical home is still empty for this
 * provider — the input to the dashboard next-step prompts (spec § 3.3).
 * Pure inspection of the profile row; does not consider wizard answers.
 *
 * The screen-2 branch fields are conditional: `miregistry_id` is only
 * reported for a license-exempt provider, `license_number` only for a
 * licensed one. While `is_license_exempt` itself is null the branch is
 * unknown, so neither branch field is reported — only `license_status`.
 *
 * Note: for the participation gates (cdc / tri_share / gsrp) a wizard
 * "no" leaves the program_settings key absent by design (§ 9 decision
 * 13), so an absent key reads as "missing" here. That is acceptable for
 * V1, which ships a single generic next-step prompt; the richer
 * per-field prompts are a V2 item (spec § 3.3, § 7.2).
 *
 * @param {object} [profile]   A profiles row.
 * @returns {string[]}         Step keys, in screen order.
 */
export function getMissingFields(profile = {}) {
  const p = profile || {}
  const settings = p.program_settings || {}
  const missing = []
  const isExempt = p.is_license_exempt

  if (isExempt === null || isExempt === undefined) {
    missing.push('license_status')
  } else if (isExempt === true) {
    if (!p.miregistry_id) missing.push('miregistry_id')
  } else {
    if (!p.michigan_license_number) missing.push('license_number')
  }

  if (settings.cdc === undefined) missing.push('cdc')
  if (settings.tri_share === undefined) missing.push('tri_share')
  if (settings.gsrp === undefined) missing.push('gsrp')
  if (settings.cacfp === undefined) missing.push('cacfp')
  if (settings.onboarding_child_count === undefined) missing.push('child_count')
  if (settings.onboarding_care_hours === undefined) missing.push('care_hours')

  return missing
}

// -----------------------------------------------------------------------------
// Answer -> canonical write targets
// -----------------------------------------------------------------------------

/** A write into a profiles column. */
function profileTarget(field, value) {
  return { store: 'profile', field, value }
}

/**
 * A write into profiles.program_settings for a gateable program (cdc /
 * tri_share / gsrp). A "yes" sets 'force_on'; anything else removes the
 * key, leaving it absent ('auto') — never 'force_off' (§ 9 decision 13).
 */
function gateTarget(field, isYes) {
  return isYes
    ? { store: 'program_settings', field, value: 'force_on' }
    : { store: 'program_settings', field, remove: true }
}

/**
 * The canonical write operations a confirmed answer produces. Each
 * descriptor is one of:
 *
 *   { store, field, value }        — set this field to this value
 *   { store, field, remove: true } — ensure this field is absent
 *
 * where `store` is 'profile' (a profiles column), 'program_settings' (a
 * key inside profiles.program_settings), or 'onboarding_state' (a key
 * inside profiles.onboarding_state). The wizard applies these the moment
 * an answer is confirmed (spec § 9 decision 2).
 *
 * Returns [] for a null/undefined answer (a skipped question writes
 * nothing) and for an unknown question key.
 *
 * @param {string} questionKey   A wizard step key.
 * @param {*}      answer        The confirmed answer for that question.
 * @returns {Array<object>}
 */
export function getWriteTargets(questionKey, answer) {
  if (answer === null || answer === undefined) return []

  switch (questionKey) {
    case 'license_status':
      return [profileTarget('is_license_exempt', answer === LICENSE_STATUS.EXEMPT)]

    case 'miregistry_id':
      return [profileTarget('miregistry_id', String(answer))]

    case 'license_number': {
      // answer: { license_number, provider_id? }
      const out = []
      if (answer.license_number) {
        out.push(profileTarget('michigan_license_number', String(answer.license_number)))
      }
      if (answer.provider_id) {
        out.push(profileTarget('michigan_provider_id', String(answer.provider_id)))
      }
      return out
    }

    case 'cdc':
      return [gateTarget('cdc', answer === YES_NO.YES)]

    case 'gsrp':
      return [gateTarget('gsrp', answer === YES_NO.YES)]

    case 'tri_share': {
      const out = [gateTarget('tri_share', answer === TRI_SHARE_ANSWER.YES)]
      // "Never heard of it" stores the same gate state as "no" but is
      // also recorded as a product-analytics signal (§ 9 decision 9).
      if (answer === TRI_SHARE_ANSWER.NEVER_HEARD) {
        out.push({ store: 'onboarding_state', field: 'tri_share_never_heard', value: true })
      }
      return out
    }

    case 'cacfp': {
      // answer: 'yes' | 'no'  OR  { participates: 'yes'|'no', sponsor? }
      const participates = typeof answer === 'string' ? answer : answer.participates
      const sponsor = typeof answer === 'object' ? answer.sponsor : null
      const out = [{
        store: 'program_settings',
        field: 'cacfp',
        value: participates === YES_NO.YES,
      }]
      if (participates === YES_NO.YES && sponsor) {
        out.push({ store: 'program_settings', field: 'cacfp_sponsor', value: String(sponsor) })
      }
      return out
    }

    case 'child_count':
      return [{ store: 'program_settings', field: 'onboarding_child_count', value: String(answer) }]

    case 'care_hours':
      return [{ store: 'program_settings', field: 'onboarding_care_hours', value: String(answer) }]

    default:
      return []
  }
}
