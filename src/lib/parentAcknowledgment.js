// Pure helpers for parent acknowledgment derived state (PR #12).
//
// Two concerns:
//   - Tamper-detection hashing: stable canonical serialization of an
//     attendance row's billable shape, then a deterministic non-crypto
//     hash. Written at acknowledgment time, recomputed at validation
//     time; mismatch means the provider edited the row after the
//     parent confirmed it (spec § 7.4).
//   - Derived per-segment acknowledgment state for the validation
//     engine (PR #9 Rule 8) and the parent / provider dashboards.
//
// Pure functions only. No Supabase, no React. Inputs are plain rows
// from `attendance` and `attendance_acknowledgments` /
// `acknowledgment_flags`. Same testability convention as the other
// src/lib helpers.
//
// Hash choice. The spec offers SHA-256 or FNV-1a and asks for the
// choice + rationale in pr-12-review.md. **FNV-1a 32-bit** is the
// pick: synchronous (no `crypto.subtle.digest` async), works
// identically in browser and Node so Vitest tests are deterministic,
// and adequate for tamper-detection at the application layer (a
// malicious provider with direct DB access could rewrite the stored
// hash anyway — the goal is honest-edit detection, not cryptographic
// integrity).

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Per-segment acknowledgment state, as observed by the validation
 *  engine and the dashboards. Computed; not persisted. */
export const ACK_STATE = Object.freeze({
  ACKNOWLEDGED_CLEAN:     'acknowledged_clean',      // parent ack on file, hash matches
  ACKNOWLEDGED_OVERRIDE:  'acknowledged_override',   // provider override on file
  TAMPERED:               'tampered',                // ack on file, hash MISMATCH
  FLAGGED:                'flagged',                 // unresolved parent flag on file
  UNACKNOWLEDGED:         'unacknowledged',          // billed, no ack, no flag
})

/** Default lookback window for the parent dashboard banner. The spec
 *  caps at 30 days back so historical gaps don't dredge forever (spec
 *  § 10.1). */
export const PARENT_BANNER_LOOKBACK_DAYS = 30

// -----------------------------------------------------------------------------
// Internal date helpers
//
// Duplicated from the other src/lib date helpers — see
// docs/tech_debt.md § "Deferred work introduced by PR #6".
// -----------------------------------------------------------------------------

/** Today's local date as 'YYYY-MM-DD'. */
export function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `aYmd` shifted by `days` calendar days, as 'YYYY-MM-DD'. */
function addDaysYMD(aYmd, days) {
  const [y, m, d] = String(aYmd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Tamper-detection hash
// -----------------------------------------------------------------------------

/**
 * Return the canonical hash payload string for an attendance row.
 * Exported so tests and audit logs can see the exact serialised form
 * that the hash was taken over.
 *
 * The shape is `{check_in, check_out, status, segment_index}` in
 * **alphabetical** key order so the serialisation is reproducible
 * across JS engines without depending on object insertion order.
 * `null` / `undefined` are normalised to the literal `null` token so
 * "no time recorded" hashes differently from "08:00" but identically
 * across reads.
 *
 * @param {object} record  One attendance row.
 * @returns {string}       Canonical JSON-like payload.
 */
export function canonicalAttendanceForHash(record) {
  const safe = record || {}
  // Build in alphabetical order, normalise nulls.
  const norm = v => (v === undefined || v === null) ? null : String(v)
  return JSON.stringify({
    check_in:      norm(safe.check_in),
    check_out:     norm(safe.check_out),
    segment_index: safe.segment_index ?? 0,
    status:        norm(safe.status),
  })
}

/**
 * FNV-1a 32-bit hash over the canonical payload, returned as 8 lowercase
 * hex characters. Synchronous, deterministic, browser/Node-safe.
 *
 * @param {object} record  One attendance row.
 * @returns {string}       8-char hex string.
 */
export function computeAttendanceHash(record) {
  const canonical = canonicalAttendanceForHash(record)
  // FNV-1a 32-bit: offset basis 0x811c9dc5, prime 0x01000193, all math
  // forced into unsigned 32-bit via `>>> 0` and Math.imul to dodge
  // JavaScript's signed-32-bit-on-bitwise-ops quirk.
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// -----------------------------------------------------------------------------
// Per-segment acknowledgment state
// -----------------------------------------------------------------------------

/**
 * Find the active (non-archived) acknowledgment row for a given
 * attendance segment, or null.
 *
 * @param {object[]} acknowledgments
 * @param {object}   record  An attendance row with child_id + date.
 * @returns {object|null}
 */
export function findActiveAcknowledgment(acknowledgments, record) {
  if (!record) return null
  const safe = Array.isArray(acknowledgments) ? acknowledgments : []
  const segIdx = record.segment_index ?? 0
  for (const a of safe) {
    if (!a || a.archived_at) continue
    if (a.child_id !== record.child_id) continue
    if (a.date !== record.date) continue
    if ((a.segment_index ?? 0) !== segIdx) continue
    return a
  }
  return null
}

/**
 * Find the active (non-resolved, non-archived) flag for a given
 * attendance segment, or null.
 *
 * @param {object[]} flags
 * @param {object}   record
 * @returns {object|null}
 */
export function findActiveFlag(flags, record) {
  if (!record) return null
  const safe = Array.isArray(flags) ? flags : []
  const segIdx = record.segment_index ?? 0
  for (const f of safe) {
    if (!f || f.archived_at || f.resolved_at) continue
    if (f.child_id !== record.child_id) continue
    if (f.date !== record.date) continue
    if ((f.segment_index ?? 0) !== segIdx) continue
    return f
  }
  return null
}

/**
 * Derived acknowledgment state for one attendance segment.
 *
 * Resolution order:
 *   1. Active parent flag → FLAGGED (the parent's dispute supersedes
 *      any earlier ack; resolution lifecycle reopens the day).
 *   2. Acknowledgment row exists → check hash. Match → CLEAN
 *      (or OVERRIDE if `acknowledged_via = 'provider_override'`).
 *      Mismatch → TAMPERED.
 *   3. Otherwise → UNACKNOWLEDGED.
 *
 * @param {object}   record           Attendance row.
 * @param {object[]} acknowledgments  Acknowledgment rows for the child.
 * @param {object[]} [flags]          Flag rows for the child.
 * @returns {string} An `ACK_STATE` value.
 */
export function getAcknowledgmentState(record, acknowledgments, flags) {
  if (!record) return ACK_STATE.UNACKNOWLEDGED

  const flag = findActiveFlag(flags, record)
  if (flag) return ACK_STATE.FLAGGED

  const ack = findActiveAcknowledgment(acknowledgments, record)
  if (!ack) return ACK_STATE.UNACKNOWLEDGED

  const currentHash = computeAttendanceHash(record)
  if (ack.attendance_snapshot_hash !== currentHash) return ACK_STATE.TAMPERED

  return ack.acknowledged_via === 'provider_override'
    ? ACK_STATE.ACKNOWLEDGED_OVERRIDE
    : ACK_STATE.ACKNOWLEDGED_CLEAN
}

// -----------------------------------------------------------------------------
// Dashboard counts
// -----------------------------------------------------------------------------

/**
 * Helper for the parent dashboard banner (spec § 10.1): count distinct
 * billed segments in the last N days that are not yet cleanly
 * acknowledged. Includes UNACKNOWLEDGED and TAMPERED — both require
 * parent action. Excludes FLAGGED (parent already acted, awaiting
 * provider resolution) and ACKNOWLEDGED_OVERRIDE (provider attested).
 *
 * @param {object} args
 * @param {object[]} args.attendance        Billed attendance rows.
 * @param {object[]} args.acknowledgments   Acknowledgment rows.
 * @param {object[]} [args.flags]           Flag rows.
 * @param {string}   [args.today]           'YYYY-MM-DD'.
 * @param {number}   [args.lookbackDays]
 * @returns {object[]} Rows awaiting parent review.
 */
export function getDaysAwaitingParentReview({
  attendance,
  acknowledgments,
  flags,
  today,
  lookbackDays = PARENT_BANNER_LOOKBACK_DAYS,
} = {}) {
  const todayStr = today || todayYMD()
  const earliest = addDaysYMD(todayStr, -lookbackDays)
  const safe = Array.isArray(attendance) ? attendance : []

  const awaiting = []
  for (const rec of safe) {
    if (!rec || rec.status !== 'present') continue
    if (!rec.date || rec.date < earliest || rec.date > todayStr) continue
    // Only count billed segments (status='present' with hours > 0).
    const hours = computeSegmentHours(rec)
    if (hours <= 0) continue

    const state = getAcknowledgmentState(rec, acknowledgments, flags)
    if (state === ACK_STATE.UNACKNOWLEDGED || state === ACK_STATE.TAMPERED) {
      awaiting.push(rec)
    }
  }
  return awaiting
}

/**
 * Helper for the provider parent-ack dashboard (spec § 10.4): count
 * each per-segment state across the supplied attendance set.
 *
 * @param {object} args
 * @returns {{ acknowledged_clean: number, acknowledged_override: number,
 *            tampered: number, flagged: number, unacknowledged: number }}
 */
export function countAcknowledgmentStates({ attendance, acknowledgments, flags } = {}) {
  const counts = {
    [ACK_STATE.ACKNOWLEDGED_CLEAN]:    0,
    [ACK_STATE.ACKNOWLEDGED_OVERRIDE]: 0,
    [ACK_STATE.TAMPERED]:              0,
    [ACK_STATE.FLAGGED]:               0,
    [ACK_STATE.UNACKNOWLEDGED]:        0,
  }
  const safe = Array.isArray(attendance) ? attendance : []
  for (const rec of safe) {
    if (!rec || rec.status !== 'present') continue
    if (computeSegmentHours(rec) <= 0) continue
    counts[getAcknowledgmentState(rec, acknowledgments, flags)] += 1
  }
  return counts
}

// -----------------------------------------------------------------------------
// Internal duration helper (kept inline to avoid a circular dep with
// src/lib/iBilling.js, which imports from this file in step 6).
// -----------------------------------------------------------------------------

function computeSegmentHours(record) {
  if (!record || record.status !== 'present') return 0
  const inH = parseTimeToHours(record.check_in)
  const outH = parseTimeToHours(record.check_out)
  if (inH == null || outH == null) return 0
  const diff = outH - inH
  return diff > 0 ? diff : 0
}

function parseTimeToHours(hms) {
  if (!hms) return null
  const parts = String(hms).split(':').map(Number)
  if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null
  const [h, m, s = 0] = parts
  return h + m / 60 + s / 3600
}
