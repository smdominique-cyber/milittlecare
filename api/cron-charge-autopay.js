// Vercel Cron: runs every Monday at 9 AM EST (2 PM UTC)
// For each autopay-enabled family with an unpaid auto-approved invoice,
// charges the saved card via Stripe PaymentIntent.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, RESEND_API_KEY

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

async function stripeRequest(path, params) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) body.append(k, String(v))
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

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return null
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'
  try {
    return await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, html }),
    })
  } catch { return null }
}

function fmt(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default async function handler(req) {
  // Optional cron secret check
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Find unpaid invoices for autopay-enabled families
    // Status = 'sent' and amount_paid < total
    const familiesResp = await supabaseRequest(
      `families?autopay_enabled=eq.true&select=*`,
      'GET'
    )
    const families = await familiesResp.json()
    if (!families || families.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No autopay families', charged: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    const familyIds = families.map(f => f.id)
    const invResp = await supabaseRequest(
      `invoices?family_id=in.(${familyIds.join(',')})&status=in.(sent,partial,overdue)&select=*`,
      'GET'
    )
    const invoices = await invResp.json()

    if (!invoices || invoices.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No unpaid invoices', charged: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    let succeeded = 0
    let failed = 0
    const providerSummaries = {}  // user_id -> { successes: [], failures: [] }
    const results = []

    for (const invoice of invoices) {
      const family = families.find(f => f.id === invoice.family_id)
      if (!family || !family.autopay_payment_method_id) continue

      const balance = parseFloat(invoice.total) - parseFloat(invoice.amount_paid || 0)
      if (balance <= 0) continue

      // Get parent customer ID
      const parentResp = await supabaseRequest(
        `parent_profiles?id=eq.${family.autopay_parent_id}&select=stripe_customer_id,email,full_name`,
        'GET'
      )
      const parents = await parentResp.json()
      const parent = parents[0]
      if (!parent || !parent.stripe_customer_id) {
        results.push({ invoice_id: invoice.id, status: 'skipped', reason: 'no_customer_id' })
        continue
      }

      const amountCents = Math.round(balance * 100)

      // Create + confirm payment intent
      const piResp = await stripeRequest('payment_intents', {
        amount: amountCents,
        currency: 'usd',
        customer: parent.stripe_customer_id,
        payment_method: family.autopay_payment_method_id,
        off_session: 'true',
        confirm: 'true',
        'metadata[invoice_id]': invoice.id,
        'metadata[family_id]': family.id,
        'metadata[parent_id]': family.autopay_parent_id,
        'metadata[autopay]': 'true',
        description: `${family.family_name} - ${invoice.invoice_number || invoice.id}`,
      })
      const piData = await piResp.json()

      // Track in autopay_charges
      const chargeRecord = {
        user_id: invoice.user_id,
        family_id: family.id,
        invoice_id: invoice.id,
        parent_id: family.autopay_parent_id,
        payment_method_id: family.autopay_payment_method_id,
        amount: balance,
        attempted_at: new Date().toISOString(),
      }

      if (!providerSummaries[invoice.user_id]) {
        providerSummaries[invoice.user_id] = { successes: [], failures: [] }
      }

      if (piResp.ok && piData.status === 'succeeded') {
        // Success: update invoice
        const newAmountPaid = parseFloat(invoice.amount_paid || 0) + balance
        await supabaseRequest(`invoices?id=eq.${invoice.id}`, 'PATCH', {
          amount_paid: newAmountPaid,
          status: 'paid',
          paid_at: new Date().toISOString(),
          payment_method: 'stripe',
          autopay_attempted_at: new Date().toISOString(),
        })

        await supabaseRequest('payments', 'POST', {
          user_id: invoice.user_id,
          invoice_id: invoice.id,
          family_id: family.id,
          amount: balance,
          payment_date: new Date().toISOString().split('T')[0],
          payment_method: 'stripe',
          reference: piData.id,
          stripe_payment_intent: piData.id,
          notes: 'Autopay charge',
        })

        await supabaseRequest('autopay_charges', 'POST', {
          ...chargeRecord,
          payment_intent_id: piData.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
        })

        await supabaseRequest(`families?id=eq.${family.id}`, 'PATCH', {
          autopay_last_charged_at: new Date().toISOString(),
          autopay_failure_count: 0,
        })

        succeeded++
        providerSummaries[invoice.user_id].successes.push({ family: family.family_name, amount: balance })
        results.push({ invoice_id: invoice.id, status: 'succeeded', amount: balance })

        // Email parent receipt
        if (parent.email) {
          await sendEmail({
            to: parent.email,
            subject: `Autopay receipt: ${fmt(balance)} for ${family.family_name}`,
            html: buildPaymentReceiptEmail({
              parentName: parent.full_name,
              familyName: family.family_name,
              amount: balance,
              invoiceNumber: invoice.invoice_number,
            }),
          })
        }
      } else {
        // Failed
        const failureCode = piData.error?.code || piData.last_payment_error?.code || 'unknown'
        const failureMessage = piData.error?.message || piData.last_payment_error?.message || 'Charge failed'

        await supabaseRequest(`invoices?id=eq.${invoice.id}`, 'PATCH', {
          autopay_attempted_at: new Date().toISOString(),
          autopay_failure_reason: failureMessage,
        })

        await supabaseRequest('autopay_charges', 'POST', {
          ...chargeRecord,
          payment_intent_id: piData.id || null,
          status: 'failed',
          failure_code: failureCode,
          failure_message: failureMessage,
        })

        await supabaseRequest(`families?id=eq.${family.id}`, 'PATCH', {
          autopay_last_failed_at: new Date().toISOString(),
          autopay_failure_count: (family.autopay_failure_count || 0) + 1,
        })

        failed++
        providerSummaries[invoice.user_id].failures.push({
          family: family.family_name,
          amount: balance,
          reason: failureMessage,
        })
        results.push({ invoice_id: invoice.id, status: 'failed', reason: failureMessage })

        // Email parent: card failed
        if (parent.email) {
          await sendEmail({
            to: parent.email,
            subject: `Autopay couldn't charge your card`,
            html: buildPaymentFailedEmail({
              parentName: parent.full_name,
              familyName: family.family_name,
              amount: balance,
              reason: failureMessage,
            }),
          })
        }
      }
    }

    // Send provider summary emails
    for (const [providerId, summary] of Object.entries(providerSummaries)) {
      const provResp = await supabaseRequest(
        `profiles?id=eq.${providerId}&select=email,full_name`,
        'GET'
      )
      const providers = await provResp.json()
      const provider = providers[0]
      if (!provider || !provider.email) continue

      await sendEmail({
        to: provider.email,
        subject: summary.failures.length === 0
          ? `🎉 Autopay complete: ${summary.successes.length} ${summary.successes.length === 1 ? 'family' : 'families'} paid`
          : `Autopay summary: ${summary.successes.length} paid, ${summary.failures.length} failed`,
        html: buildProviderSummaryEmail({
          providerName: provider.full_name,
          successes: summary.successes,
          failures: summary.failures,
        }),
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      total_invoices: invoices.length,
      succeeded,
      failed,
      results,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function buildPaymentReceiptEmail({ parentName, familyName, amount, invoiceNumber }) {
  const greeting = parentName ? `Hi ${parentName.split(' ')[0]},` : 'Hi there,'
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;">
<div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#3e5849,#7a9e8a);padding:28px;color:white;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care · Receipt</div>
<div style="font-family:Georgia,serif;font-size:28px;font-weight:400;letter-spacing:-0.02em;">Payment received</div>
</div>
<div style="padding:32px;">
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${greeting}</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.6;">Your autopay charge for <strong>${familyName}</strong> has been processed successfully.</p>
<div style="background:#f4eee2;padding:20px;border-radius:8px;margin:24px 0;">
<div style="font-size:13px;color:#6b7c6f;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Amount charged</div>
<div style="font-family:Georgia,serif;font-size:32px;color:#1e2620;font-weight:400;">${fmt(amount)}</div>
${invoiceNumber ? `<div style="font-size:14px;color:#6b7c6f;margin-top:8px;">Invoice ${invoiceNumber}</div>` : ''}
</div>
<p style="margin:0 0 16px;font-size:14px;color:#6b7c6f;">Thank you. We'll automatically charge your card again next week.</p>
<hr style="border:none;border-top:1px solid #e5d9c4;margin:24px 0;">
<div style="font-size:13px;color:#8a9281;">🔒 Payment processed securely by Stripe. MI Little Care never sees your card details.</div>
</div></div></div></body></html>`
}

function buildPaymentFailedEmail({ parentName, familyName, amount, reason }) {
  const greeting = parentName ? `Hi ${parentName.split(' ')[0]},` : 'Hi there,'
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;">
<div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#c0392b,#a23725);padding:28px;color:white;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.85;margin-bottom:8px;">MI Little Care · Action needed</div>
<div style="font-family:Georgia,serif;font-size:26px;font-weight:400;letter-spacing:-0.02em;">Couldn't charge your card</div>
</div>
<div style="padding:32px;">
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;">${greeting}</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.6;">We tried to charge your saved card for <strong>${familyName}</strong> (${fmt(amount)}) but it was declined.</p>
<div style="background:#fdf2f1;border:1px solid #f5cdc8;padding:16px;border-radius:8px;margin:20px 0;font-size:14px;color:#8b3128;">${reason}</div>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">You can update your card or pay this invoice manually by logging into your family portal.</p>
<div style="text-align:center;margin:24px 0;">
<a href="https://milittlecare.vercel.app/parent" style="display:inline-block;background:#3e5849;color:white;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:500;text-decoration:none;">Open family portal</a>
</div>
<p style="margin:0;font-size:13px;color:#8a9281;">Your provider has also been notified.</p>
</div></div></div></body></html>`
}

function buildProviderSummaryEmail({ providerName, successes, failures }) {
  const greeting = providerName ? `Hi ${providerName.split(' ')[0]},` : 'Hi,'
  const total = successes.reduce((s, x) => s + parseFloat(x.amount), 0)
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;">
<div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#3e5849,#7a9e8a);padding:28px;color:white;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care · Monday autopay</div>
<div style="font-family:Georgia,serif;font-size:28px;font-weight:400;letter-spacing:-0.02em;">${failures.length === 0 ? 'All families paid 🎉' : 'Autopay summary'}</div>
</div>
<div style="padding:32px;">
<p style="margin:0 0 20px;font-size:16px;line-height:1.6;">${greeting}</p>
${successes.length > 0 ? `
<div style="background:#eaf5ed;border-left:4px solid #4a9b6f;padding:16px;border-radius:8px;margin:16px 0;">
<div style="font-size:13px;color:#2c6b48;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;font-weight:600;">${successes.length} ${successes.length === 1 ? 'family' : 'families'} paid · ${fmt(total)} total</div>
${successes.map(s => `<div style="font-size:14px;color:#1e2620;padding:4px 0;">✓ ${s.family} — ${fmt(s.amount)}</div>`).join('')}
</div>` : ''}
${failures.length > 0 ? `
<div style="background:#fdf2f1;border-left:4px solid #c0392b;padding:16px;border-radius:8px;margin:16px 0;">
<div style="font-size:13px;color:#8b3128;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;font-weight:600;">${failures.length} ${failures.length === 1 ? 'failure' : 'failures'} — parent has been notified</div>
${failures.map(f => `<div style="font-size:14px;color:#1e2620;padding:6px 0;">✗ ${f.family} — ${fmt(f.amount)}<br><span style="font-size:12px;color:#8a9281;">${f.reason}</span></div>`).join('')}
</div>` : ''}
<div style="text-align:center;margin:24px 0;">
<a href="https://milittlecare.vercel.app/billing" style="display:inline-block;background:#3e5849;color:white;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:500;text-decoration:none;">View billing</a>
</div>
</div></div></div></body></html>`
}
