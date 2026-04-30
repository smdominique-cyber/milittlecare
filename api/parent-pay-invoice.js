// Creates a Stripe Checkout session for a parent paying an invoice
// Works for authenticated parents OR via invitation token

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

async function verifyParentAuth(authHeader) {
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

  if (!process.env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { invoice_id } = await req.json()
    if (!invoice_id) {
      return new Response(JSON.stringify({ error: 'Missing invoice_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const parent = await verifyParentAuth(req.headers.get('authorization'))
    if (!parent) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get invoice + verify parent has access via parent_family_links
    const invResp = await supabaseRequest(
      `invoices?id=eq.${invoice_id}&select=*`,
      'GET'
    )
    const invoices = await invResp.json()
    if (!invoices || invoices.length === 0) {
      return new Response(JSON.stringify({ error: 'Invoice not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const invoice = invoices[0]

    // Verify parent is linked to this family
    const linkResp = await supabaseRequest(
      `parent_family_links?parent_id=eq.${parent.id}&family_id=eq.${invoice.family_id}&status=eq.active&select=*`,
      'GET'
    )
    const links = await linkResp.json()
    if (!links || links.length === 0) {
      return new Response(JSON.stringify({ error: 'Not authorized for this invoice' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get family + provider for branding
    const famResp = await supabaseRequest(
      `families?id=eq.${invoice.family_id}&select=*`,
      'GET'
    )
    const families = await famResp.json()
    const family = families[0]

    const providerResp = await supabaseRequest(
      `profiles?id=eq.${invoice.user_id}&select=full_name,daycare_name`,
      'GET'
    )
    const providers = await providerResp.json()
    const providerName = providers[0]?.daycare_name || providers[0]?.full_name || 'Your child care provider'

    const balance = parseFloat(invoice.total) - parseFloat(invoice.amount_paid || 0)
    if (balance <= 0) {
      return new Response(JSON.stringify({ error: 'Invoice already paid' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const amountCents = Math.round(balance * 100)
    const origin = req.headers.get('origin') || 'https://milittlecare.vercel.app'

    // Build the Checkout session
    const params = new URLSearchParams()
    params.append('mode', 'payment')
    params.append('payment_method_types[0]', 'card')
    params.append('line_items[0][price_data][currency]', 'usd')
    params.append('line_items[0][price_data][unit_amount]', amountCents.toString())
    params.append('line_items[0][price_data][product_data][name]', `${family?.family_name || 'Child care'} — ${providerName}`)
    params.append('line_items[0][price_data][product_data][description]', `Invoice ${invoice.invoice_number || invoice.id}`)
    params.append('line_items[0][quantity]', '1')
    params.append('customer_email', parent.email)
    params.append('client_reference_id', parent.id)
    params.append('success_url', `${origin}/parent?paid=1&invoice_id=${invoice.id}`)
    params.append('cancel_url', `${origin}/parent?canceled=1&invoice_id=${invoice.id}`)
    params.append('metadata[invoice_id]', invoice.id)
    params.append('metadata[parent_id]', parent.id)
    params.append('metadata[family_id]', invoice.family_id)

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    const data = await resp.json()
    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: data.error?.message || 'Failed to create checkout',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ url: data.url, session_id: data.id }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
