// Pure validation gate for invitation acceptance (parent + staff).
//
// Background (incident 2026-05-14): both accept flows looked up the
// invited user by `admin/users?email=<recipient>`, which on the
// deployed Supabase Auth version is an unreliable filter — it returns
// the wrong user some percentage of the time, leading to corrupt
// parent_family_links / staff_memberships rows and verifyOtp-driven
// session swaps.
//
// The fix is to source identity from the authenticated session and
// require that session's email matches the invitation's recipient_email
// (case-insensitive, whitespace-trimmed). This module holds that
// validation as a pure function so it can be unit-tested in Vitest
// without standing up an integration harness for the edge runtime
// endpoints that call it.
//
// The validator is generic on `invitation.recipient_email` and
// `session.email`; it does not look at parent_id, staff_user_id, role,
// licensee_id, or family_id. The same gate applies to both parent
// invitations and staff invitations — the calling endpoint is
// responsible for the downstream link insert specifics.
//
// Imported by api/accept-invitation.js and api/accept-staff-invitation.js.

export function validateInvitationAccept({ session, invitation } = {}) {
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: 'auth_required',
      error: 'You must be signed in to accept an invitation.',
    }
  }

  const sessionEmail = String(session.email || '').toLowerCase().trim()
  if (!sessionEmail) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_input',
      error: 'Your session has no associated email. Sign out and sign in again.',
    }
  }

  const recipientEmail = String(invitation && invitation.recipient_email || '')
    .toLowerCase()
    .trim()
  if (!recipientEmail) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_input',
      error: 'This invitation is missing a recipient email and cannot be accepted.',
    }
  }

  if (sessionEmail !== recipientEmail) {
    return {
      ok: false,
      status: 403,
      code: 'email_mismatch',
      error:
        `This invitation is for ${invitation.recipient_email}, ` +
        `but you're signed in as ${session.email}. Sign out and ` +
        `click the invitation link again with the correct account.`,
    }
  }

  return { ok: true }
}
