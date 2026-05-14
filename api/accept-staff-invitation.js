// Accepts a staff invitation and creates the staff_memberships row.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Authorization: requires a Bearer token from a Supabase session whose
// email matches the invitation's recipient_email (case-insensitive,
// trimmed). Unauthenticated calls and email mismatches are rejected.
// The browser session is the source of truth for staff identity.
//
// Background (incident 2026-05-14): the previous accept flow had the
// identical bugs as accept-invitation.js — an unreliable
// admin/users?email=... lookup combined with a verifyOtp session swap
// on the client. For staff this is arguably worse: adult_staff role
// grants full access to all of a licensee's families, billing,
// attendance, messages, receipts, and reports. Closed in the same
// hotfix as the parent flow.

import { validateInvitationAccept } from '../src/lib/inviteAuthorization.js'

export const config = { runtime: 'edge' }

async function supabaseRequest(path, method, body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`
  const resp = await fetch(url, {
    method,
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return resp
}

async function verifySession(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const resp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  })
  if (!resp.ok) return null
  const user = await resp.json()
  if (!user || !user.id || !user.email) return null
  return { id: user.id, email: user.email }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { token, full_name } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Resolve the caller's session BEFORE any DB lookups so
    // unauthenticated callers cannot probe token validity.
    const session = await verifySession(req.headers.get('authorization'))

    // Look up invitation
    const invResp = await supabaseRequest(
      `staff_invitations?token=eq.${encodeURIComponent(token)}&select=*`,
      'GET'
    )
    const invitations = await invResp.json()
    if (!invitations || invitations.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid invitation' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const inv = invitations[0]

    if (inv.status === 'accepted') {
      return new Response(JSON.stringify({
        error: 'This invitation has already been accepted. Please sign in.',
        code: 'already_accepted',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    if (inv.status === 'revoked') {
      return new Response(JSON.stringify({
        error: 'This invitation has been revoked.',
        code: 'revoked',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    if (new Date(inv.expires_at) < new Date()) {
      await supabaseRequest(`staff_invitations?id=eq.${inv.id}`, 'PATCH', { status: 'expired' })
      return new Response(JSON.stringify({
        error: 'This invitation has expired.',
        code: 'expired',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // Authorization gate: same pure validator the parent flow uses.
    // Required: session present AND session.email matches
    // invitation.recipient_email (case-insensitive, trimmed).
    const gate = validateInvitationAccept({ session, invitation: inv })
    if (!gate.ok) {
      return new Response(JSON.stringify({
        error: gate.error,
        code: gate.code,
      }), { status: gate.status, headers: { 'Content-Type': 'application/json' } })
    }

    // Staff identity = session identity. No more lookup-by-email.
    const staffUserId = session.id

    // Optional: write full_name back to auth.users metadata if provided.
    // Skipped here — the user already has their account, and changing
    // their metadata from this endpoint would be a confusing side effect.
    // The dashboard offers a separate profile-edit surface.

    // Create / activate staff membership
    const existingMembershipResp = await supabaseRequest(
      `staff_memberships?staff_user_id=eq.${staffUserId}&licensee_id=eq.${inv.licensee_id}&select=*`,
      'GET'
    )
    const existingMemberships = await existingMembershipResp.json()

    if (!existingMemberships || existingMemberships.length === 0) {
      await supabaseRequest('staff_memberships', 'POST', {
        staff_user_id: staffUserId,
        licensee_id: inv.licensee_id,
        role: inv.intended_role,
        status: 'active',
        invitation_id: inv.id,
        invited_at: inv.sent_at,
      })
    } else {
      // Reactivate
      await supabaseRequest(`staff_memberships?id=eq.${existingMemberships[0].id}`, 'PATCH', {
        status: 'active',
        role: inv.intended_role,
        revoked_at: null,
      })
    }

    // Mark invitation accepted
    await supabaseRequest(`staff_invitations?id=eq.${inv.id}`, 'PATCH', {
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by_user_id: staffUserId,
    })

    // No magic_link / auto_signin_token in the response — caller is
    // already authenticated (per the gate above). Client navigates to
    // /dashboard on its own existing session. Optional `full_name` on
    // the request is intentionally unused server-side; client can use
    // it to update their own profile via the dashboard.
    void full_name  // documents the intentional non-use
    return new Response(JSON.stringify({
      success: true,
      staff_user_id: staffUserId,
      email: session.email,
      role: inv.intended_role,
      licensee_id: inv.licensee_id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
