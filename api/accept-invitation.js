// Accepts a family invitation and creates/links the parent account
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

async function authAdminRequest(path, method, body) {
  const url = `${process.env.SUPABASE_URL}/auth/v1/${path}`
  const resp = await fetch(url, {
    method,
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return resp
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

    // Check status
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

    // Check if parent already exists in auth.users by email
    const usersResp = await authAdminRequest(
      `admin/users?email=${encodeURIComponent(invitation.recipient_email)}`,
      'GET'
    )
    const usersData = await usersResp.json()
    let parentUser = null
    if (usersData.users && usersData.users.length > 0) {
      parentUser = usersData.users[0]
    }

    // If parent doesn't exist, create them
    if (!parentUser) {
      const createResp = await authAdminRequest('admin/users', 'POST', {
        email: invitation.recipient_email,
        email_confirm: true,
        user_metadata: {
          full_name: full_name || invitation.recipient_name || null,
          is_parent: true,
        },
      })
      const created = await createResp.json()
      if (!createResp.ok) {
        return new Response(JSON.stringify({
          error: created.message || 'Failed to create parent account',
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      parentUser = created
    }

    // Upsert parent_profile
    await supabaseRequest('parent_profiles', 'POST', {
      id: parentUser.id,
      email: invitation.recipient_email,
      full_name: full_name || invitation.recipient_name || null,
      phone: invitation.recipient_phone || null,
    }).catch(() => {
      // If conflict, update instead
      return supabaseRequest(`parent_profiles?id=eq.${parentUser.id}`, 'PATCH', {
        email: invitation.recipient_email,
        full_name: full_name || invitation.recipient_name || parentUser.user_metadata?.full_name || null,
      })
    })

    // Create the parent-family link (idempotent)
    const existingLinkResp = await supabaseRequest(
      `parent_family_links?parent_id=eq.${parentUser.id}&family_id=eq.${invitation.family_id}&select=*`,
      'GET'
    )
    const existingLinks = await existingLinkResp.json()

    if (!existingLinks || existingLinks.length === 0) {
      await supabaseRequest('parent_family_links', 'POST', {
        parent_id: parentUser.id,
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
        accepted_by_parent_id: parentUser.id,
      }
    )

    // Generate a magic link sign-in token for immediate authentication
    const magicResp = await authAdminRequest('admin/generate_link', 'POST', {
      type: 'magiclink',
      email: invitation.recipient_email,
    })
    const magicData = await magicResp.json()

    return new Response(JSON.stringify({
      success: true,
      parent_id: parentUser.id,
      email: invitation.recipient_email,
      family_id: invitation.family_id,
      magic_link: magicData.properties?.action_link || null,
      auto_signin_token: magicData.properties?.hashed_token || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
