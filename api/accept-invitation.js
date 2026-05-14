// Accepts a family invitation and creates the parent-family link.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Authorization: requires a Bearer token from a Supabase session whose
// email matches the invitation's recipient_email (case-insensitive,
// trimmed). Unauthenticated calls and email mismatches are rejected.
// The browser session is the source of truth for parent identity.
//
// Background (incident 2026-05-14): the previous accept flow looked
// up the parent user by `admin/users?email=<recipient>`, which on the
// deployed Supabase Auth version is an unreliable filter — it returns
// the wrong user some percentage of the time. Combined with a
// verifyOtp-driven session swap on the client, this corrupted
// parent_family_links rows for 3 customer families and exposed
// cross-tenant billing data. The fix removes both: identity is taken
// from the authenticated session, and no magic-link OTP swap occurs.

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
      return new Response(JSON.stringify({ error: 'Missing invitation token' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Resolve the caller's session. We do this BEFORE any DB lookups
    // so unauthenticated callers cannot probe token validity.
    const session = await verifySession(req.headers.get('authorization'))

    // Look up the invitation
    const inviteResp = await supabaseRequest(
      `family_invitations?token=eq.${encodeURIComponent(token)}&select=*`,
      'GET'
    )
    const invitations = await inviteResp.json()
    if (!invitations || invitations.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid invitation' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const invitation = invitations[0]

    // Status checks
    if (invitation.status === 'accepted') {
      return new Response(JSON.stringify({
        error: 'This invitation has already been accepted. Please sign in instead.',
        code: 'already_accepted',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    if (invitation.status === 'revoked') {
      return new Response(JSON.stringify({
        error: 'This invitation has been revoked. Please contact your provider.',
        code: 'revoked',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    if (new Date(invitation.expires_at) < new Date()) {
      // Mark expired
      await supabaseRequest(
        `family_invitations?id=eq.${invitation.id}`,
        'PATCH',
        { status: 'expired' }
      )
      return new Response(JSON.stringify({
        error: 'This invitation has expired. Please ask your provider to send a new one.',
        code: 'expired',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // Authorization gate: require an authenticated session whose email
    // matches the invitation's recipient. Pure-function so it can be
    // unit-tested without standing up the edge runtime.
    const gate = validateInvitationAccept({ session, invitation })
    if (!gate.ok) {
      return new Response(JSON.stringify({
        error: gate.error,
        code: gate.code,
      }), { status: gate.status, headers: { 'Content-Type': 'application/json' } })
    }

    // Parent identity = session identity. No more lookup-by-email
    // (the previous admin/users?email=... path was unreliable; see
    // file header).
    const parentId = session.id
    const parentEmail = session.email

    // Upsert parent_profile keyed off the session's user id.
    await supabaseRequest('parent_profiles', 'POST', {
      id: parentId,
      email: parentEmail,
      full_name: full_name || invitation.recipient_name || null,
      phone: invitation.recipient_phone || null,
    }).catch(() => {
      // If conflict, update instead
      return supabaseRequest(`parent_profiles?id=eq.${parentId}`, 'PATCH', {
        email: parentEmail,
        full_name: full_name || invitation.recipient_name || null,
      })
    })

    // Create the parent-family link (idempotent)
    const existingLinkResp = await supabaseRequest(
      `parent_family_links?parent_id=eq.${parentId}&family_id=eq.${invitation.family_id}&select=*`,
      'GET'
    )
    const existingLinks = await existingLinkResp.json()

    if (!existingLinks || existingLinks.length === 0) {
      await supabaseRequest('parent_family_links', 'POST', {
        parent_id: parentId,
        family_id: invitation.family_id,
        provider_user_id: invitation.user_id,
        invitation_id: invitation.id,
        status: 'active',
      })
    } else if (existingLinks[0].status !== 'active') {
      // Reactivate
      await supabaseRequest(
        `parent_family_links?id=eq.${existingLinks[0].id}`,
        'PATCH',
        { status: 'active', revoked_at: null }
      )
    }

    // Mark invitation as accepted
    await supabaseRequest(
      `family_invitations?id=eq.${invitation.id}`,
      'PATCH',
      {
        status: 'accepted',
        accepted_at: new Date().toISOString(),
        accepted_by_parent_id: parentId,
      }
    )

    // No magic_link / auto_signin_token in the response — the caller
    // is already authenticated (per the gate above), so the client
    // navigates to /parent on its own existing session.
    return new Response(JSON.stringify({
      success: true,
      parent_id: parentId,
      email: parentEmail,
      family_id: invitation.family_id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
