// Stripe webhook handler — receives events from Stripe and updates user subscription status
// Required env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Configure in Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL: https://milittlecare.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed, customer.subscription.updated,
//           customer.subscription.deleted, invoice.payment_failed, invoice.payment_succeeded

// Note: this uses node runtime (not edge) because we need raw body for signature verification
export const config = {
  runtime: 'nodejs',
}

import crypto from 'crypto'

// Manual signature verification (avoids needing the stripe npm package)
function verifyStripeSignature(payload, header, secret) {
  if (!header) return false
  const parts = header.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=')
    acc[k] = v
    return acc
  }, {})

  if (!parts.t || !parts.v1) return false

  const signedPayload = `${parts.t}.${payload}`
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex')

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(parts.v1, 'hex'),
      Buffer.from(expected, 'hex')
    )
  } catch {
    return false
  }
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Read raw body for signature verification
  const chunks = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const rawBody = Buffer.concat(chunks).toString('utf8')

  const sig = req.headers['stripe-signature']
  if (!verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  // Log the event for debugging
  try {
    await supabaseRequest('subscription_events', 'POST', {
      event_type: event.type,
      stripe_event_id: event.id,
      data: event.data?.object || {},
    })
  } catch {} // ignore logging errors

  try {
    switch (event.type) {
      // ─── Checkout completed: subscription created OR invoice paid ──────────
      case 'checkout.session.completed': {
        const session = event.data.object

        // Case A: Subscription checkout (provider subscribing)
        if (session.mode === 'subscription') {
          const userId = session.client_reference_id || session.metadata?.user_id
          if (!userId) break

          await supabaseRequest(`profiles?id=eq.${userId}`, 'PATCH', {
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            subscription_status: 'active',
          })
          break
        }

        // Case B: One-time payment checkout (parent paying invoice)
        if (session.mode === 'payment' && session.metadata?.invoice_id) {
          const invoiceId = session.metadata.invoice_id
          const amountPaid = (session.amount_total || 0) / 100  // cents → dollars
          const paymentIntentId = session.payment_intent

          // Get the invoice
          const invResp = await supabaseRequest(
            `invoices?id=eq.${invoiceId}&select=*`,
            'GET'
          )
          const invoices = await invResp.json()
          if (!invoices || invoices.length === 0) break
          const invoice = invoices[0]

          const newAmountPaid = parseFloat(invoice.amount_paid || 0) + amountPaid
          const totalDue = parseFloat(invoice.total || 0)
          let newStatus = invoice.status
          if (newAmountPaid >= totalDue) newStatus = 'paid'
          else if (newAmountPaid > 0) newStatus = 'partial'

          // Update invoice
          await supabaseRequest(`invoices?id=eq.${invoiceId}`, 'PATCH', {
            amount_paid: newAmountPaid,
            status: newStatus,
            paid_at: newStatus === 'paid' ? new Date().toISOString() : invoice.paid_at,
            payment_method: 'stripe',
          })

          // Insert payment record
          await supabaseRequest('payments', 'POST', {
            user_id: invoice.user_id,
            invoice_id: invoiceId,
            family_id: invoice.family_id,
            amount: amountPaid,
            payment_date: new Date().toISOString().split('T')[0],
            payment_method: 'stripe',
            reference: session.id,
            stripe_payment_intent: paymentIntentId,
          })

          break
        }

        break
      }

      // ─── Subscription state change ──────────
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object
        const userId = sub.metadata?.user_id

        // Map Stripe statuses to ours
        let status = 'active'
        if (sub.status === 'past_due') status = 'past_due'
        else if (sub.status === 'canceled') status = 'canceled'
        else if (sub.status === 'unpaid') status = 'past_due'
        else if (sub.status === 'trialing') status = 'active' // they're on Stripe trial = treat as active
        else if (sub.status === 'active') status = 'active'

        const updates = {
          subscription_status: status,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
          cancel_at_period_end: sub.cancel_at_period_end || false,
          stripe_subscription_id: sub.id,
          stripe_customer_id: sub.customer,
        }

        if (userId) {
          await supabaseRequest(`profiles?id=eq.${userId}`, 'PATCH', updates)
        } else {
          // Fall back to looking up by customer ID
          await supabaseRequest(
            `profiles?stripe_customer_id=eq.${sub.customer}`,
            'PATCH',
            updates
          )
        }
        break
      }

      // ─── Subscription canceled ──────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const userId = sub.metadata?.user_id

        const updates = {
          subscription_status: 'canceled',
          cancel_at_period_end: false,
        }

        if (userId) {
          await supabaseRequest(`profiles?id=eq.${userId}`, 'PATCH', updates)
        } else {
          await supabaseRequest(
            `profiles?stripe_customer_id=eq.${sub.customer}`,
            'PATCH',
            updates
          )
        }
        break
      }

      // ─── Payment failed ──────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.customer) {
          await supabaseRequest(
            `profiles?stripe_customer_id=eq.${invoice.customer}`,
            'PATCH',
            { subscription_status: 'past_due' }
          )
        }
        break
      }

      // ─── Payment Intent Succeeded (covers autopay charges) ──────────
      case 'payment_intent.succeeded': {
        const pi = event.data.object
        // Autopay charges have metadata.autopay='true' and metadata.invoice_id
        // The cron handles DB updates directly, but this webhook is a backup
        // in case the cron's API call to Stripe times out before completing
        if (pi.metadata?.autopay === 'true' && pi.metadata?.invoice_id) {
          const invoiceId = pi.metadata.invoice_id

          // Check if invoice is already marked paid (cron may have done it)
          const invResp = await supabaseRequest(
            `invoices?id=eq.${invoiceId}&select=*`,
            'GET'
          )
          const invoices = await invResp.json()
          if (!invoices || invoices.length === 0) break
          const invoice = invoices[0]

          if (invoice.status === 'paid') break  // Already handled by cron

          const amountPaid = (pi.amount || 0) / 100
          const newAmountPaid = parseFloat(invoice.amount_paid || 0) + amountPaid
          const totalDue = parseFloat(invoice.total || 0)
          let newStatus = invoice.status
          if (newAmountPaid >= totalDue) newStatus = 'paid'
          else if (newAmountPaid > 0) newStatus = 'partial'

          await supabaseRequest(`invoices?id=eq.${invoiceId}`, 'PATCH', {
            amount_paid: newAmountPaid,
            status: newStatus,
            paid_at: newStatus === 'paid' ? new Date().toISOString() : invoice.paid_at,
            payment_method: 'stripe',
          })
        }
        break
      }

      // ─── Payment Intent Failed (covers autopay failures) ──────────
      case 'payment_intent.payment_failed': {
        const pi = event.data.object
        if (pi.metadata?.autopay === 'true' && pi.metadata?.invoice_id) {
          const invoiceId = pi.metadata.invoice_id
          await supabaseRequest(`invoices?id=eq.${invoiceId}`, 'PATCH', {
            autopay_attempted_at: new Date().toISOString(),
            autopay_failure_reason: pi.last_payment_error?.message || 'Charge failed',
          })
        }
        break
      }

      default:
        // Other events ignored
        break
    }

    return res.status(200).json({ received: true })
  } catch (error) {
    console.error('Webhook handler error:', error)
    return res.status(500).json({ error: error.message })
  }
}
