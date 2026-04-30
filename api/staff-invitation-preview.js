// Returns minimal info about a staff invitation
export const config = { runtime: 'edge' }

async function supabaseRequest(path) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`
  return fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  })
}

const ROLE_LABELS = {
  adult_staff: 'Adult Staff',
  assistant: 'Assistant',
  view_only: 'View-only',
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

    const invResp = await supabaseRequest(
      `staff_invitations?token=eq.${encodeURIComponent(token)}&select=id,licensee_id,recipient_name,recipient_email,intended_role,status,expires_at`
    )
    const invs = await invResp.json()
    if (!invs || invs.length === 0) {
      return new Response(JSON.stringify({ error: 'Invitation not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const inv = invs[0]

    if (inv.status === 'accepted') {
      return new Response(JSON.stringify({ error: 'This invitation has already been accepted.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (inv.status === 'revoked') {
      return new Response(JSON.stringify({ error: 'This invitation has been revoked.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (new Date(inv.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: 'This invitation has expired.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const profResp = await supabaseRequest(`profiles?id=eq.${inv.licensee_id}&select=full_name,daycare_name`)
    const profs = await profResp.json()

    return new Response(JSON.stringify({
      licensee_name: profs[0]?.daycare_name || profs[0]?.full_name || 'Your daycare',
      role: inv.intended_role,
      role_label: ROLE_LABELS[inv.intended_role] || inv.intended_role,
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
