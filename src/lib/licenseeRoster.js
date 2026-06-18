// Licensee roster identity — single helper that guarantees the
// licensee's own `caregivers` self-row exists.
//
// Background: the regulatory roster (`caregivers` table from migration
// 012) is the system of record for R 400.1933 physician attestations,
// R 400.1924 professional-development hours, R 400.1923 new-hire
// training, and other staff-file requirements. R 400.1933(1)
// specifically requires the LICENSEE's own attestation, and the
// per-caregiver compliance resolver shipped in PR #17/#18 iterates the
// roster to cover that subrule. So the licensee MUST appear in her own
// roster as a row with `app_user_id = licensee_id` — i.e. a self-row.
//
// History (2026-06-18): the self-row used to be created lazily on
// Staff Training page mount (useStaffTraining.js). A licensee who
// opened /compliance before /staff-training would have no self-row,
// silently under-reporting subrule (1). This helper is the
// navigation-independent create site; migration 046 backfills existing
// licensees.
//
// Single create path: this is the ONLY place in the runtime that
// inserts a self-row. The Staff Training mount-create was removed
// on 2026-06-18. Backfill of existing licensees is handled by
// migration 046 (one-time SQL, idempotent via the unique constraint).
//
// Idempotency: protected by the `unique (licensee_id, app_user_id)`
// constraint on `caregivers` (migration 012:106). The select-first-
// then-insert pattern is fast in the steady state (the row already
// exists, so the insert is skipped) and the unique constraint catches
// any concurrent insert race at the DB.
//
// ── full_name source — tripwire (2026-06-18 Step 2 review) ──────────
//
// This helper reads `user.user_metadata.full_name` to match the rest
// of the app's chrome-context reads (Sidebar, DashboardPage greeting,
// StaffPage's licensee-row, AttendancePage closure email "from"
// name, TaxExportButton / ReportsPage filename prefixes). The
// value is identical to `profiles.full_name` in production today
// because both are frozen-at-signup mirrors kept in sync by the
// `handle_new_user` trigger (mig 001:39-53). Neither is updated by
// any user-facing affordance — `BusinessInfoPage` only edits
// `daycare_name`; `supabase.auth.updateUser` is called only for
// password changes.
//
// FUTURE-PROOFING: if anyone ships a "rename yourself" affordance
// that updates `profiles.full_name` WITHOUT also calling
// `supabase.auth.updateUser({ data: { full_name } })` in the same
// flow, the JWT's `user_metadata.full_name` will lag behind and new
// self-rows produced here will carry the stale name. Two fixes when
// that day arrives — pick one:
//   (a) Update both fields in lockstep at the rename site (no change
//       here). Keeps every other chrome-context read in sync too.
//   (b) Switch this helper to read `profiles.full_name` (one extra
//       Supabase round-trip — load the profile row inside the
//       helper). Fixes the staleness only for this side effect; the
//       other chrome-context reads listed above still risk staleness.
//
// Migration 046's backfill reads `profiles.full_name` directly (the
// canonical record-shaped source). Both code paths produce identical
// strings in production today; the divergence-detection plan above
// covers the future.

import { supabase } from '@/lib/supabase'

/**
 * Ensure the licensee has a `caregivers` self-row.
 *
 * Insert shape mirrors the historical useStaffTraining.js create
 * (lines 53-58 pre-2026-06-18) exactly so the relocated create
 * produces rows indistinguishable from any already present:
 *
 *   { licensee_id:  user.id,
 *     app_user_id:  user.id,                                   // marks self-row
 *     full_name:    user.user_metadata.full_name || user.email || 'You (licensee)' }
 *
 * Every other column uses the table default (id, email→null,
 * date_of_hire→null, archived_at→null, created_at→now(),
 * updated_at→now()).
 *
 * @param {object} args
 * @param {object} args.user  Supabase auth user — the licensee for whom
 *                            the self-row should exist. Must have `id`.
 * @returns {Promise<{ created: boolean, error: Error|null }>}
 *   `created` is true if this call inserted the row, false if a row
 *   already existed (steady state). `error` is non-null on a hard
 *   failure (auth, RLS, network) — callers should log and continue;
 *   the self-row is a side effect, not a precondition for the
 *   primary action (onboarding completion).
 */
export async function ensureLicenseeSelfCaregiverRow({ user } = {}) {
  if (!user || !user.id) {
    return { created: false, error: new Error('ensureLicenseeSelfCaregiverRow: user.id is required') }
  }

  // 1. Existence check. The unique (licensee_id, app_user_id)
  //    constraint guarantees at most one self-row, so a single SELECT
  //    is sufficient. archived_at filter is intentional: an archived
  //    self-row should not produce a duplicate active one — a
  //    licensee re-onboarding after archiving her own row is a
  //    licensing edge case worth flagging by hand, not by silently
  //    creating a second row that violates the unique constraint.
  const { data: existing, error: selErr } = await supabase
    .from('caregivers')
    .select('id')
    .eq('licensee_id', user.id)
    .eq('app_user_id', user.id)
    .maybeSingle()
  if (selErr) {
    return { created: false, error: selErr }
  }
  if (existing) {
    return { created: false, error: null }
  }

  // 2. Insert. Same three-column shape as the historical create. If a
  //    concurrent caller raced ahead between (1) and here, the unique
  //    constraint rejects the duplicate — we treat that as "already
  //    exists" (the desired end state) rather than an error.
  //
  //    full_name fallback is the JS equivalent of mig 046's SQL idiom
  //    `coalesce(nullif(trim(full_name), ''), email, 'You (licensee)')`:
  //    only the first candidate is trimmed (matching the SQL); an
  //    empty-string or whitespace-only `user_metadata.full_name` falls
  //    THROUGH to email rather than landing as a visibly-blank roster
  //    label. email + the literal fallback are passed through as-is
  //    (also matching the SQL — `coalesce` only NULLIF's the first
  //    candidate after trim).
  const rawName = user.user_metadata && user.user_metadata.full_name
  const trimmedName = (typeof rawName === 'string') ? rawName.trim() : ''
  const fullName = trimmedName || user.email || 'You (licensee)'
  const { error: insErr } = await supabase.from('caregivers').insert({
    licensee_id: user.id,
    app_user_id: user.id,
    full_name: fullName,
  })
  if (insErr) {
    // 23505 = unique_violation. Treat as a benign race — another
    // tab or a concurrent backfill created the row first; the
    // end state matches what we wanted.
    if (insErr.code === '23505') {
      return { created: false, error: null }
    }
    return { created: false, error: insErr }
  }
  return { created: true, error: null }
}
