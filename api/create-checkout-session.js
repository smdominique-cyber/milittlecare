// Creates a Stripe Checkout session for the MI Little Care subscription
// Requires STRIPE_SECRET_KEY and STRIPE_PRICE_ID env variables in Vercel

export const config = {
  runtime: 'edge',
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return new Response(JSON.stringify({
      error: 'Stripe is not fully configured. Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID in Vercel settings.',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const { user_id, email, return_url } = await req.json()

    if (!user_id || !email) {
      return new Response(JSON.stringify({ error: 'Missing user_id or email' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const origin = return_url || req.headers.get('origin') || 'https://milittlecare.vercel.app'

    const params = new URLSearchParams()
    params.append('mode', 'subscription')
    params.append('line_items[0][price]', process.env.STRIPE_PRICE_ID)
    params.append('line_items[0][quantity]', '1')
    params.append('customer_email', email)
    params.append('client_reference_id', user_id)
    params.append('success_url', `${origin}/subscription?status=success&session_id={CHECKOUT_SESSION_ID}`)
    params.append('cancel_url', `${origin}/subscription?status=canceled`)
    params.append('metadata[user_id]', user_id)
    params.append('subscription_data[metadata][user_id]', user_id)
    params.append('allow_promotion_codes', 'true')
    params.append('billing_address_collection', 'auto')

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
        error: data.error?.message || 'Failed to create checkout session',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      url: data.url,
      session_id: data.id,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
