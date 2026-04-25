// Creates a Stripe payment link for an invoice
// Requires STRIPE_SECRET_KEY env variable in Vercel

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

  if (!process.env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({
      error: 'Stripe is not configured. Add STRIPE_SECRET_KEY in Vercel settings.',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { amount, description, invoice_id, family_name } = await req.json()

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Stripe expects amount in cents
    const amountCents = Math.round(parseFloat(amount) * 100)

    // Create a price + payment link in one go using Stripe REST API directly
    // Step 1 — Create a Price
    const priceParams = new URLSearchParams()
    priceParams.append('currency', 'usd')
    priceParams.append('unit_amount', amountCents.toString())
    priceParams.append('product_data[name]', description || `Invoice ${invoice_id}`)

    const priceResp = await fetch('https://api.stripe.com/v1/prices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: priceParams.toString(),
    })

    const price = await priceResp.json()
    if (!priceResp.ok) {
      return new Response(JSON.stringify({
        error: price.error?.message || 'Failed to create Stripe price',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    // Step 2 — Create Payment Link from price
    const linkParams = new URLSearchParams()
    linkParams.append('line_items[0][price]', price.id)
    linkParams.append('line_items[0][quantity]', '1')
    if (invoice_id) {
      linkParams.append('metadata[invoice_id]', invoice_id)
    }
    if (family_name) {
      linkParams.append('metadata[family_name]', family_name)
    }

    const linkResp = await fetch('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: linkParams.toString(),
    })

    const link = await linkResp.json()
    if (!linkResp.ok) {
      return new Response(JSON.stringify({
        error: link.error?.message || 'Failed to create payment link',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      url: link.url,
      id: link.id,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
