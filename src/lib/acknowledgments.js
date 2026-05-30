// PR #16 — pure helpers for the general acknowledgments substrate.
//
// Mirrors `src/lib/parentAcknowledgment.js`'s pattern (PR #12) for the
// type-dispatched hash + envelope composition + active-row selectors,
// generalized to the polymorphic `public.acknowledgments` table.
//
// Hash choice: FNV-1a 32-bit, same as PR #12 (synchronous, deterministic,
// browser/Node identical, adequate for honest-edit tamper detection at
// the application layer).

// -----------------------------------------------------------------------------
// Acknowledgment-type catalog (the DB stores free-text; this is the
// authoritative validator and documents the shape per type).
// -----------------------------------------------------------------------------

// ─── R 400.1907 subitem mapping (regulatory-interpretation assumption) ──
//
// The R 400.1907(1)(b) child-in-care statement enumerates seven items
// the parent must sign. Each JS constant below maps to one subitem; the
// mapping is RECORDED HERE so a future maintainer can audit it without
// reverse-engineering the help text. The mapping itself is a
// regulatory-interpretation call — confirm with the licensing
// consultant before PR #22 (Compliance Health Score) consumes the
// pending-signature counts. Mirrors the channel-interpretation note
// in `src/lib/childFiles.js` (same revisit pattern).
//
// Subitem → ACK_TYPES constant (string value):
//   R 400.1907(1)(b)(i)   condition of child's health    → HEALTH_CONDITION
//   R 400.1907(1)(b)(ii)  food provider agreement        → FOOD_PROVIDER_AGREEMENT
//   R 400.1907(1)(b)(iii) offer of licensing RULES copy  → LICENSING_RULES_OFFERED (new 2026-05-29)
//   R 400.1907(1)(b)(iv)  discipline policy receipt      → DISCIPLINE_POLICY_RECEIPT
//   R 400.1907(1)(b)(v)   firearms on premises           → FIREARMS_DISCLOSURE (gated)
//   R 400.1907(1)(b)(vi)  lead-based paint (inform-only) → LEAD_DISCLOSURE (gated, inform-only)
//   R 400.1907(1)(b)(vii) availability of THIS home's
//                         licensing notebook per
//                         R 400.1906(3)                   → LICENSING_NOTEBOOK_AVAILABILITY
//                                                          (formerly LICENSING_NOTEBOOK_OFFERED;
//                                                           DB string value 'licensing_notebook_offered'
//                                                           preserved for back-compat)
//
// Naming note (2026-05-29): the constant LICENSING_NOTEBOOK_OFFERED was
// renamed in JS to LICENSING_NOTEBOOK_AVAILABILITY. The string value
// stays `'licensing_notebook_offered'` so production rows are
// unchanged — no migration. The constant rename is purely a clarity
// fix: the help text and scope doc both describe (vii) "notice of
// availability of THIS home's licensing notebook" but the old
// identifier's "offered" verb misleadingly suggested (iii) "offer of
// the licensing rules." (iii) is now a separate type
// (LICENSING_RULES_OFFERED) — the genuinely-missing acknowledgment.

export const ACK_TYPES = Object.freeze({
  // Rule 7 / R 400.1907 child-in-care statement bundle (PR #16).
  CHILD_IN_CARE_STATEMENT:        'child_in_care_statement',     // envelope
  LEAD_DISCLOSURE:                'lead_disclosure',             // (b)(vi) — inform-only, if home pre-1978
  FIREARMS_DISCLOSURE:            'firearms_disclosure',         // (b)(v) — always (copy varies)
  FOOD_PROVIDER_AGREEMENT:        'food_provider_agreement',     // (b)(ii)
  // (b)(vii) — Notice of THIS home's licensing notebook
  // availability per R 400.1906(3). String value preserved as
  // 'licensing_notebook_offered' for back-compat — see header note.
  LICENSING_NOTEBOOK_AVAILABILITY: 'licensing_notebook_offered',
  // (b)(iii) — Offer to provide a copy of the licensing RULES
  // (R 400.1901-1951). Added 2026-05-29; was missing from the bundle.
  // String value chosen to be unambiguously distinct from (vii).
  LICENSING_RULES_OFFERED:        'licensing_rules_offered',
  INFANT_SAFE_SLEEP:              'infant_safe_sleep',           // R 400.1930, if child age < 18 months
  HEALTH_CONDITION:               'health_condition',            // (b)(i)
  DISCIPLINE_POLICY_RECEIPT:      'discipline_policy_receipt',   // (b)(iv) + PR #17 standalone

  // Future consumers (PR #17 + PR #20). Listed here so the catalog is
  // discoverable from one place.
  STAFF_DISCIPLINE_POLICY_RECEIPT:   'staff_discipline_policy_receipt',
  MEDICATION_PERMISSION_OTC_BLANKET: 'medication_permission_otc_blanket',
  MEDICATION_PERMISSION:             'medication_permission',
})

/**
 * The list of sub-row types that compose the child_in_care_statement
 * envelope. The envelope's `snapshot_hash` is a deterministic function
 * of (the subset of) these sub-row hashes that actually applied to the
 * child at acknowledgment time.
 */
export const CHILD_IN_CARE_SUB_TYPES = Object.freeze([
  ACK_TYPES.LEAD_DISCLOSURE,
  ACK_TYPES.FIREARMS_DISCLOSURE,
  ACK_TYPES.FOOD_PROVIDER_AGREEMENT,
  ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY,
  ACK_TYPES.LICENSING_RULES_OFFERED,           // new 2026-05-29 — R 400.1907(1)(b)(iii)
  ACK_TYPES.INFANT_SAFE_SLEEP,
  ACK_TYPES.HEALTH_CONDITION,
  ACK_TYPES.DISCIPLINE_POLICY_RECEIPT,
])

// -----------------------------------------------------------------------------
// Canonical payload + hash
// -----------------------------------------------------------------------------

/**
 * Build the canonical hashable string for one acknowledgment payload.
 * Sorts keys so order-of-insertion does not change the hash. Numbers /
 * booleans / nulls are stringified the way `JSON.stringify` would, but
 * we walk the object ourselves so we can pin the key order.
 *
 * Per-type payload conventions (kept here for one-source-of-truth):
 *   - lead_disclosure: { homeBuiltBefore1978: boolean, copyVersion: string }
 *   - firearms_disclosure: { firearmsOnPremises: boolean, copyVersion: string }
 *   - food_provider_agreement: { foodProvider: 'provider'|'parent'|'both' }
 *   - licensing_notebook_offered (DB string for LICENSING_NOTEBOOK_AVAILABILITY,
 *     R 400.1907(1)(b)(vii)): { copyVersion: string }
 *   - licensing_rules_offered (R 400.1907(1)(b)(iii)): { copyVersion: string }
 *   - infant_safe_sleep: { copyVersion: string, childAgeMonths: number }
 *   - health_condition: { healthSummary: string|null }
 *   - discipline_policy_receipt: { policyVersion: number|string }
 *   - child_in_care_statement (envelope): { subTypes: string[], subHashes: string[] }
 *     (handled by computeEnvelopeHash below — pass the sorted sub-row
 *     hashes; the helper composes the canonical string.)
 *
 * @param {object} payload
 * @returns {string}
 */
export function canonicalForHash(payload) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload !== 'object') return String(payload)
  const keys = Object.keys(payload).sort()
  const parts = []
  for (const k of keys) {
    parts.push(k)
    parts.push('=')
    const v = payload[k]
    if (v === null) parts.push('null')
    else if (typeof v === 'object') parts.push(canonicalForHash(v))
    else parts.push(String(v))
    parts.push('|')
  }
  return parts.join('')
}

/**
 * FNV-1a 32-bit hash of an arbitrary string. 8 lowercase hex characters.
 *
 * @param {string} str
 * @returns {string}
 */
export function fnv1a32Hex(str) {
  let h = 0x811c9dc5
  const s = String(str || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Compute the FNV-1a snapshot hash for a single acknowledgment row.
 *
 * @param {object} args
 * @param {string} args.type      One of ACK_TYPES values.
 * @param {object} [args.payload] Per-type payload (see canonicalForHash docs).
 * @returns {string}              8-char hex.
 */
export function computeAckHash({ type, payload } = {}) {
  const head = String(type || '') + '#'
  return fnv1a32Hex(head + canonicalForHash(payload || {}))
}

/**
 * Compose the envelope hash for a child_in_care_statement row from the
 * set of sub-row hashes that applied to the child at acknowledgment
 * time. Sorts the sub-hashes so the composition is order-independent.
 *
 * @param {string[]} subRowHashes
 * @returns {string}
 */
export function computeEnvelopeHash(subRowHashes) {
  const list = Array.isArray(subRowHashes) ? subRowHashes : []
  const sorted = list
    .filter(h => typeof h === 'string' && h.length > 0)
    .slice()
    .sort()
  return fnv1a32Hex('child_in_care_statement#' + sorted.join('+'))
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/**
 * Find the active (non-archived) acknowledgment row matching the
 * `(type, subjectType, subjectId)` triple, or null. When `subjectId` is
 * not provided / null, matches a provider-level acknowledgment.
 *
 * @param {object[]} acks
 * @param {object}   filter   { type, subjectType, subjectId }
 * @returns {object|null}
 */
export function findActiveAck(acks, filter) {
  if (!filter || !filter.type) return null
  const list = Array.isArray(acks) ? acks : []
  const wantType = filter.type
  const wantSubjectType = filter.subjectType ?? null
  const wantSubjectId = filter.subjectId ?? null
  for (const a of list) {
    if (!a || a.archived_at) continue
    if (a.type !== wantType) continue
    if ((a.subject_type ?? null) !== wantSubjectType) continue
    if ((a.subject_id ?? null) !== wantSubjectId) continue
    return a
  }
  return null
}

/**
 * Has the licensee answered both premises disclosure questions?
 *
 * The intake bundle's required-set is derived from these answers:
 *   - lead_disclosure is required only when home_built_before_1978 = true
 *   - firearms_disclosure is required whenever firearms_on_premises is a
 *     boolean (R 400.1907(1)(b)(v) — the disclosure is required
 *     regardless of yes/no, copy varies)
 *
 * If either is null ("not yet answered") `requiredSubTypesForChild`
 * silently OMITS the corresponding disclosure from the required set —
 * which means a save path that runs without checking this helper writes
 * an INCOMPLETE bundle, missing legally-required disclosures, with no
 * warning to the provider. This was confirmed live during PR #16
 * follow-up testing (2026-05-29).
 *
 * Every save path that writes the intake bundle MUST gate on
 * `ready === true`. See `ChildIntakeModal.handleSendToPortal` and
 * `ChildIntakeModal.handleSaveBundle`.
 *
 * @param {object|null} profile  profiles row carrying premises booleans
 * @returns {{ ready: boolean, missing: string[] }}
 *   `missing` lists the un-answered field names so UI copy can be
 *   specific. Values: 'home_built_before_1978', 'firearms_on_premises'.
 */
export function arePremisesAnsweredForIntake(profile) {
  const missing = []
  if (profile == null) {
    return {
      ready: false,
      missing: ['home_built_before_1978', 'firearms_on_premises'],
    }
  }
  if (profile.home_built_before_1978 == null) missing.push('home_built_before_1978')
  if (profile.firearms_on_premises == null) missing.push('firearms_on_premises')
  return { ready: missing.length === 0, missing }
}

/**
 * Decide which child-in-care sub-rows actually apply to a particular
 * child given the provider's premises state and the child's age.
 *
 * @param {object} args
 * @param {object} args.child       children row (date_of_birth used for infant-sleep gate)
 * @param {object} args.profile     profiles row carrying premises booleans
 * @param {string} [args.today]     YYYY-MM-DD, defaults to today.
 * @returns {string[]}              Sub-types that must be acknowledged.
 */
export function requiredSubTypesForChild({ child, profile, today }) {
  const req = []
  if (!child || !profile) return req

  if (profile.home_built_before_1978 === true) req.push(ACK_TYPES.LEAD_DISCLOSURE)
  // Firearms disclosure is required regardless of yes/no — the parent
  // must affirmatively know one way or the other. Copy varies by value.
  if (profile.firearms_on_premises === true || profile.firearms_on_premises === false) {
    req.push(ACK_TYPES.FIREARMS_DISCLOSURE)
  }
  req.push(ACK_TYPES.FOOD_PROVIDER_AGREEMENT)
  // R 400.1907(1)(b)(vii) — notice of THIS home's licensing notebook
  // availability per R 400.1906(3). Always required.
  req.push(ACK_TYPES.LICENSING_NOTEBOOK_AVAILABILITY)
  // R 400.1907(1)(b)(iii) — offer to provide a copy of the licensing
  // RULES (R 400.1901-1951). Always required. Added 2026-05-29.
  req.push(ACK_TYPES.LICENSING_RULES_OFFERED)
  req.push(ACK_TYPES.HEALTH_CONDITION)
  req.push(ACK_TYPES.DISCIPLINE_POLICY_RECEIPT)

  // Infant safe sleep: only for children < 18 months at acknowledgment time.
  if (child.date_of_birth) {
    const ageMonths = ageInMonths(child.date_of_birth, today)
    if (ageMonths != null && ageMonths < 18) {
      req.push(ACK_TYPES.INFANT_SAFE_SLEEP)
    }
  }

  return req
}

function ageInMonths(dobYmd, todayYmd) {
  if (!dobYmd) return null
  const today = todayYmd || todayLocalYMD()
  const [dy, dm, dd] = String(dobYmd).split('-').map(Number)
  const [ty, tm, td] = String(today).split('-').map(Number)
  if (!Number.isFinite(dy) || !Number.isFinite(ty)) return null
  let months = (ty - dy) * 12 + (tm - dm)
  if (td < dd) months -= 1
  return Math.max(0, months)
}

function todayLocalYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Completeness
// -----------------------------------------------------------------------------

/**
 * Per-child completeness summary used by the Children-tab badge and the
 * intake form.
 *
 * Drift detection: the envelope row's stored `snapshot_hash` must equal
 * `computeEnvelopeHash(currentSubRowHashes)`. If it doesn't (a sub-row
 * was added because the provider toggled `home_built_before_1978` after
 * the initial intake, for example), the envelope is stale and the
 * child reverts to "intake incomplete" until re-acknowledged.
 *
 * @param {object}   args
 * @param {object}   args.child
 * @param {object}   args.profile
 * @param {object[]} args.acks                 acks for subject_type='child', subject_id=child.id
 * @param {object}   [args.subRowPayloads]     map of subType -> payload (for current-hash computation)
 * @param {string}   [args.today]
 * @returns {object}
 */
export function getChildFileCompleteness({ child, profile, acks, subRowPayloads, today }) {
  const safe = Array.isArray(acks) ? acks : []
  const required = requiredSubTypesForChild({ child, profile, today })

  const presentByType = new Map()
  for (const a of safe) {
    if (!a || a.archived_at) continue
    if (a.subject_type !== 'child') continue
    if (a.subject_id !== (child && child.id)) continue
    presentByType.set(a.type, a)
  }

  const acknowledgmentsPresent = []
  const acknowledgmentsMissing = []
  for (const t of required) {
    if (presentByType.has(t)) acknowledgmentsPresent.push(t)
    else acknowledgmentsMissing.push(t)
  }

  const envelope = presentByType.get(ACK_TYPES.CHILD_IN_CARE_STATEMENT) || null

  // Drift: re-compose the envelope hash from the *current* required
  // sub-rows' hashes (if payloads are provided). If the stored envelope
  // hash differs, the bundle is stale.
  let envelopeHashCurrent = null
  let envelopeHashDrift = false
  if (subRowPayloads) {
    const currentSubHashes = required
      .filter(t => subRowPayloads[t] !== undefined)
      .map(t => computeAckHash({ type: t, payload: subRowPayloads[t] }))
    envelopeHashCurrent = computeEnvelopeHash(currentSubHashes)
    if (envelope && envelope.snapshot_hash) {
      envelopeHashDrift = envelope.snapshot_hash !== envelopeHashCurrent
    }
  }

  const intakeComplete =
    envelope != null
    && acknowledgmentsMissing.length === 0
    && !envelopeHashDrift

  // Annual review status — soft; the badge + reminder drive remediation
  // but nothing in this PR hard-enforces.
  const recordsLastReviewedOn = child ? child.records_last_reviewed_on || null : null
  const recordsReviewDue = isAnnualReviewDue(recordsLastReviewedOn, today)

  return {
    acknowledgmentsPresent,
    acknowledgmentsMissing,
    requiredSubTypes: required,
    envelopePresent: envelope != null,
    envelopeHashDrift,
    envelopeHashCurrent,
    immunizationStatus: child ? (child.immunization_status || null) : null,
    recordsLastReviewedOn,
    recordsReviewDue,
    intakeComplete,
  }
}

/**
 * Annual records review is due (R 400.1907) when the prior review
 * happened more than ~12 months ago. We use the same calendar-month
 * math as `ageInMonths`. Never-reviewed children return true.
 */
export function isAnnualReviewDue(lastReviewedOn, today) {
  if (!lastReviewedOn) return true
  const months = ageInMonths(lastReviewedOn, today)
  return months == null ? true : months >= 12
}
