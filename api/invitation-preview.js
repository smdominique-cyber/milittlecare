// Returns minimal info about an invitation for the acceptance page
// Public endpoint — only returns data needed for the parent to decide whether to accept

export const config = { runtime: 'edge' }

async function supabaseRequest(path) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`
  const resp = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
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
    const { token } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing token' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const inviteResp = await supabaseRequest(
      `family_invitations?token=eq.${encodeURIComponent(token)}&select=id,family_id,recipient_name,recipient_email,status,expires_at,user_id`
    )
    const invitations = await inviteResp.json()
    if (!invitations || invitations.length === 0) {
      return new Response(JSON.stringify({ error: 'Invitation not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const inv = invitations[0]

    if (inv.status === 'accepted') {
      return new Response(JSON.stringify({ error: 'This invitation has already been accepted. Please sign in instead.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (inv.status === 'revoked') {
      return new Response(JSON.stringify({ error: 'This invitation has been revoked' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (new Date(inv.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: 'This invitation has expired. Please ask your provider to send a new one.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get family + provider names
    const [famResp, profResp] = await Promise.all([
      supabaseRequest(`families?id=eq.${inv.family_id}&select=family_name`),
      supabaseRequest(`profiles?id=eq.${inv.user_id}&select=full_name,daycare_name`),
    ])
    const families = await famResp.json()
    const profiles = await profResp.json()

    return new Response(JSON.stringify({
      family_name: families[0]?.family_name || 'your family',
      provider_name: profiles[0]?.daycare_name || profiles[0]?.full_name || 'Your provider',
      recipient_name: inv.recipient_name,
      recipient_email: inv.recipient_email,
      expires_at: inv.expires_at,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
