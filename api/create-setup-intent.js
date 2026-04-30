// Creates a Stripe Setup Intent so the parent can save a card for autopay
// Required env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

async function stripeRequest(path, params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) {
      v.forEach((item, i) => body.append(`${k}[${i}]`, item))
    } else if (typeof v === 'object' && v !== null) {
      for (const [sk, sv] of Object.entries(v)) body.append(`${k}[${sk}]`, sv)
    } else if (v != null) {
      body.append(k, String(v))
    }
  }
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  return resp
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const parent = await verifyAuth(req.headers.get('authorization'))
    if (!parent) {
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

    // Verify parent is linked to family
    const linkResp = await supabaseRequest(
      `parent_family_links?parent_id=eq.${parent.id}&family_id=eq.${family_id}&status=eq.active&select=*`,
      'GET'
    )
    const links = await linkResp.json()
    if (!links || links.length === 0) {
      return new Response(JSON.stringify({ error: 'Not authorized for this family' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get parent profile (or create one)
    let profileResp = await supabaseRequest(`parent_profiles?id=eq.${parent.id}&select=*`, 'GET')
    let profiles = await profileResp.json()
    let profile = profiles[0]
    if (!profile) {
      const insertResp = await supabaseRequest('parent_profiles', 'POST', {
        id: parent.id,
        email: parent.email,
        full_name: parent.user_metadata?.full_name || null,
      })
      const inserted = await insertResp.json()
      profile = inserted[0]
    }

    // Get or create Stripe customer
    let customerId = profile.stripe_customer_id
    if (!customerId) {
      const custResp = await stripeRequest('customers', {
        email: parent.email,
        name: profile.full_name || parent.user_metadata?.full_name || parent.email,
        'metadata[parent_id]': parent.id,
      })
      const custData = await custResp.json()
      if (!custResp.ok) {
        return new Response(JSON.stringify({ error: custData.error?.message || 'Failed to create customer' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
      customerId = custData.id

      // Save customer ID
      await supabaseRequest(`parent_profiles?id=eq.${parent.id}`, 'PATCH', {
        stripe_customer_id: customerId,
      })
    }

    // Create Setup Intent
    const setupResp = await stripeRequest('setup_intents', {
      customer: customerId,
      'payment_method_types[0]': 'card',
      usage: 'off_session',
      'metadata[parent_id]': parent.id,
      'metadata[family_id]': family_id,
    })
    const setupData = await setupResp.json()
    if (!setupResp.ok) {
      return new Response(JSON.stringify({ error: setupData.error?.message || 'Failed to create setup intent' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      client_secret: setupData.client_secret,
      customer_id: customerId,
      setup_intent_id: setupData.id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
