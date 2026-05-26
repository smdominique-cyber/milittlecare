// Fire-condition logic for the license-status prompt.
// See docs/license_status_prompt_spec.md § 3.
//
// Pure function: no React, no Supabase, no I/O. The caller fetches the
// provider's profile and passes it in along with the funding source that
// was just saved.
//
// NOTE: this helper deliberately does NOT check the provider's role. The
// modal is licensee-only, but role is a call-site concern — the caller
// checks useRole().isLicensee before invoking this. See spec § 9
// decisions 2 and 7.

/**
 * Should the license-status prompt modal fire after a funding source save?
 *
 * Fires when a CDC Scholarship source was just created AND the provider
 * still owes a license_type answer. PR #14 (migration 022) made
 * `license_type` the compliance source of truth — three values:
 * `'family_home'` | `'group_home'` | `'license_exempt'`. A row needs a
 * (re-)prompt when `license_type` is null OR when the backfill flagged it
 * for human disambiguation (`license_type_review_needed === true`,
 * commonly: licensed providers whose `provider_type` was never set, so we
 * can't tell family vs group from the legacy signals alone).
 *
 * Pre-PR-#14 this function keyed on `is_license_exempt` (binary). The
 * mirror invariant maintained by every capture surface guarantees
 * `license_type` is set whenever `is_license_exempt` is set, so callers
 * that hand us a profile loaded before PR #14's columns existed (during
 * the brief window before the deploy) still fire correctly — they look
 * unanswered, which is the right behavior.
 *
 * @param {object} args
 * @param {object} args.profile      The provider's `profiles` row.
 * @param {object} args.savedSource  The `funding_sources` row just created.
 * @returns {boolean}
 */
export function shouldFireLicenseStatusPrompt({ profile, savedSource } = {}) {
  if (!savedSource || savedSource.type !== 'cdc_scholarship') return false
  if (!profile) return false

  // Needs a (re-)prompt iff license_type is unset OR the backfill flagged
  // it for human disambiguation.
  return profile.license_type == null || profile.license_type_review_needed === true
}

/**
 * Should the dashboard re-prompt the license_type modal on load? Used by
 * `LicenseTypeReviewBanner` so the modal fires once per dashboard mount
 * when the provider still owes an answer (PR #14 § Review-needed surfacing).
 *
 * @param {object} [profile]  The provider's `profiles` row.
 * @returns {boolean}
 */
export function needsLicenseTypeReview(profile) {
  if (!profile) return false
  return profile.license_type == null || profile.license_type_review_needed === true
}
