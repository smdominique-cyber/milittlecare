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
 * has not yet answered the license-status question — i.e.
 * `is_license_exempt` is neither `true` nor `false` (it is `null`, the
 * default state for every provider until they answer).
 *
 * @param {object} args
 * @param {object} args.profile      The provider's `profiles` row.
 * @param {object} args.savedSource  The `funding_sources` row just created.
 * @returns {boolean}
 */
export function shouldFireLicenseStatusPrompt({ profile, savedSource } = {}) {
  if (!savedSource || savedSource.type !== 'cdc_scholarship') return false
  if (!profile) return false

  // "Answered" means a definitive boolean. null / undefined / anything
  // else means the provider has not chosen yet — so prompt.
  const answered =
    profile.is_license_exempt === true || profile.is_license_exempt === false
  return !answered
}
