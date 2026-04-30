// Called after Stripe SetupIntent succeeds — confirms the payment method
// is saved and enables autopay for the family

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
    const parent = await verifyAuth(req.headers.get('authorization'))
    if (!parent) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { family_id, payment_method_id, setup_intent_id } = await req.json()
    if (!family_id || !payment_method_id) {
      return new Response(JSON.stringify({ error: 'Missing family_id or payment_method_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify parent linked to family
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

    // Get card details from Stripe
    let cardBrand = null
    let cardLast4 = null
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const pmResp = await fetch(`https://api.stripe.com/v1/payment_methods/${payment_method_id}`, {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
        })
        const pmData = await pmResp.json()
        if (pmResp.ok && pmData.card) {
          cardBrand = pmData.card.brand
          cardLast4 = pmData.card.last4
        }
      } catch {}
    }

    // Update parent profile with default payment method
    await supabaseRequest(`parent_profiles?id=eq.${parent.id}`, 'PATCH', {
      default_payment_method_id: payment_method_id,
      default_card_brand: cardBrand,
      default_card_last4: cardLast4,
    })

    // Enable autopay on the family
    await supabaseRequest(`families?id=eq.${family_id}`, 'PATCH', {
      autopay_enabled: true,
      autopay_enrolled_at: new Date().toISOString(),
      autopay_parent_id: parent.id,
      autopay_payment_method_id: payment_method_id,
      autopay_failure_count: 0,
    })

    return new Response(JSON.stringify({
      success: true,
      card_brand: cardBrand,
      card_last4: cardLast4,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
