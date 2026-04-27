// Creates a Stripe Customer Portal session so users can manage their subscription
// (update payment method, cancel, view invoices, etc.)

export const config = {
  runtime: 'edge',
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
    const { customer_id, return_url } = await req.json()

    if (!customer_id) {
      return new Response(JSON.stringify({ error: 'Missing customer_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const origin = return_url || req.headers.get('origin') || 'https://milittlecare.vercel.app'

    const params = new URLSearchParams()
    params.append('customer', customer_id)
    params.append('return_url', `${origin}/subscription`)

    const resp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
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
        error: data.error?.message || 'Failed to create portal session',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ url: data.url }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
