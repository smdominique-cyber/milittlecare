// Disables autopay for a family — can be called by either the parent or provider

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

async function verifyAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const resp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${token}`,
    },
  })
  if (!resp.ok) return null
  return await resp.json()
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const user = await verifyAuth(req.headers.get('authorization'))
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { family_id } = await req.json()
    if (!family_id) {
      return new Response(JSON.stringify({ error: 'Missing family_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Check if user is provider OR parent linked to family
    const famResp = await supabaseRequest(`families?id=eq.${family_id}&select=*`, 'GET')
    const families = await famResp.json()
    if (!families || families.length === 0) {
      return new Response(JSON.stringify({ error: 'Family not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const family = families[0]

    let authorized = false
    if (family.user_id === user.id) {
      authorized = true  // Provider owns it
    } else {
      // Check if parent is linked
      const linkResp = await supabaseRequest(
        `parent_family_links?parent_id=eq.${user.id}&family_id=eq.${family_id}&status=eq.active&select=*`,
        'GET'
      )
      const links = await linkResp.json()
      if (links && links.length > 0) authorized = true
    }

    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Not authorized' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Disable autopay
    await supabaseRequest(`families?id=eq.${family_id}`, 'PATCH', {
      autopay_enabled: false,
      autopay_payment_method_id: null,
      autopay_parent_id: null,
    })

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
