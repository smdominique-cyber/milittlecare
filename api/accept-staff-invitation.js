// Accepts a staff invitation, creates account if needed, links to licensee

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
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

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
      return new Response(JSON.stringify({ error: 'This invitation has already been accepted. Please sign in.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (inv.status === 'revoked') {
      return new Response(JSON.stringify({ error: 'This invitation has been revoked.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (new Date(inv.expires_at) < new Date()) {
      await supabaseRequest(`staff_invitations?id=eq.${inv.id}`, 'PATCH', { status: 'expired' })
      return new Response(JSON.stringify({ error: 'This invitation has expired.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Look up or create user
    const usersResp = await authAdminRequest(
      `admin/users?email=${encodeURIComponent(inv.recipient_email)}`,
      'GET'
    )
    const usersData = await usersResp.json()
    let staffUser = null
    if (usersData.users && usersData.users.length > 0) {
      staffUser = usersData.users[0]
    }

    if (!staffUser) {
      const createResp = await authAdminRequest('admin/users', 'POST', {
        email: inv.recipient_email,
        email_confirm: true,
        user_metadata: {
          full_name: full_name || inv.recipient_name || null,
          is_staff: true,
        },
      })
      const created = await createResp.json()
      if (!createResp.ok) {
        return new Response(JSON.stringify({
          error: created.message || 'Failed to create staff account',
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      staffUser = created
    }

    // Create / activate staff membership
    const existingMembershipResp = await supabaseRequest(
      `staff_memberships?staff_user_id=eq.${staffUser.id}&licensee_id=eq.${inv.licensee_id}&select=*`,
      'GET'
    )
    const existingMemberships = await existingMembershipResp.json()

    if (!existingMemberships || existingMemberships.length === 0) {
      await supabaseRequest('staff_memberships', 'POST', {
        staff_user_id: staffUser.id,
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
      accepted_by_user_id: staffUser.id,
    })

    // Generate magic link for auto sign-in
    const magicResp = await authAdminRequest('admin/generate_link', 'POST', {
      type: 'magiclink',
      email: inv.recipient_email,
    })
    const magicData = await magicResp.json()

    return new Response(JSON.stringify({
      success: true,
      staff_user_id: staffUser.id,
      email: inv.recipient_email,
      role: inv.intended_role,
      magic_link: magicData.properties?.action_link || null,
      auto_signin_token: magicData.properties?.hashed_token || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
