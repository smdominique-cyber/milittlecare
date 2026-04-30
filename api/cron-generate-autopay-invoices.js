// Vercel Cron: runs every Sunday at 10 PM EST (3 AM UTC Monday)
// For each provider's autopay-enabled active families:
//   - Generate this week's invoice (using the same logic as manual generation)
//   - Auto-approve it (status='sent') with auto_approved=true flag
// This gives parents a notification window before charges fire Monday 9 AM
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (optional)

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

function dateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function shortDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default async function handler(req) {
  // Optional cron secret check
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Determine the period: last Monday → last Sunday (the week that just ended)
    const today = new Date()
    const thisMonday = getMonday(today)
    const lastMonday = new Date(thisMonday)
    lastMonday.setDate(lastMonday.getDate() - 7)
    const lastSunday = new Date(thisMonday)
    lastSunday.setDate(lastSunday.getDate() - 1)

    const periodStart = dateStr(lastMonday)
    const periodEnd = dateStr(lastSunday)

    // Fetch all autopay-enabled families with active enrollment
    const familiesResp = await supabaseRequest(
      `families?autopay_enabled=eq.true&enrollment_status=eq.active&select=*`,
      'GET'
    )
    const families = await familiesResp.json()

    if (!families || families.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        message: 'No autopay families found',
        period: { start: periodStart, end: periodEnd },
        created: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    let created = 0
    let skipped = 0
    const results = []

    for (const family of families) {
      // Skip if invoice already exists for this period
      const existResp = await supabaseRequest(
        `invoices?family_id=eq.${family.id}&period_start=eq.${periodStart}&period_end=eq.${periodEnd}&select=id`,
        'GET'
      )
      const existing = await existResp.json()
      if (existing && existing.length > 0) {
        skipped++
        results.push({ family_id: family.id, skipped: true, reason: 'already_exists' })
        continue
      }

      // Determine subtotal + line items
      let subtotal = 0
      let lineItems = []
      let hoursBilled = 0

      if (family.billing_type === 'weekly' && family.weekly_rate) {
        const rate = parseFloat(family.weekly_rate)
        subtotal = rate
        lineItems.push({
          description: `Weekly tuition (${shortDate(periodStart)} – ${shortDate(periodEnd)})`,
          quantity: 1,
          unit: 'weeks',
          unit_price: rate,
          line_total: rate,
        })
      } else if (family.billing_type === 'hourly' && family.hourly_rate) {
        const rate = parseFloat(family.hourly_rate)
        // Get all children for this family
        const childrenResp = await supabaseRequest(
          `children?family_id=eq.${family.id}&select=id,first_name`,
          'GET'
        )
        const familyChildren = await childrenResp.json()

        for (const child of familyChildren) {
          const attendResp = await supabaseRequest(
            `attendance?child_id=eq.${child.id}&date=gte.${periodStart}&date=lte.${periodEnd}&select=hours`,
            'GET'
          )
          const childAttendance = await attendResp.json()
          const childHours = childAttendance.reduce((s, a) => s + parseFloat(a.hours || 0), 0)
          if (childHours > 0) {
            const lineTotal = childHours * rate
            subtotal += lineTotal
            hoursBilled += childHours
            lineItems.push({
              description: `${child.first_name} – ${childHours.toFixed(2)} hrs × $${rate.toFixed(2)}`,
              quantity: childHours,
              unit: 'hours',
              unit_price: rate,
              line_total: lineTotal,
              child_id: child.id,
            })
          }
        }
      }

      // Skip if no amount due
      if (subtotal <= 0) {
        skipped++
        results.push({ family_id: family.id, skipped: true, reason: 'no_amount' })
        continue
      }

      // Due date: today + late_fee_after_days
      const dueDate = new Date(today)
      dueDate.setDate(dueDate.getDate() + (family.late_fee_after_days || 7))

      // Generate invoice number (count existing invoices)
      const countResp = await supabaseRequest(
        `invoices?user_id=eq.${family.user_id}&select=id`,
        'GET'
      )
      const userInvoices = await countResp.json()
      const invoiceNumber = `INV-${today.getFullYear()}-${String((userInvoices?.length || 0) + 1).padStart(4, '0')}`

      // Insert invoice — auto-approved (status=sent)
      const invResp = await supabaseRequest('invoices', 'POST', {
        user_id: family.user_id,
        family_id: family.id,
        invoice_number: invoiceNumber,
        period_start: periodStart,
        period_end: periodEnd,
        due_date: dateStr(dueDate),
        subtotal,
        total: subtotal,
        billing_type: family.billing_type,
        rate_used: family.billing_type === 'weekly' ? family.weekly_rate : family.hourly_rate,
        hours_billed: hoursBilled || null,
        weeks_billed: family.billing_type === 'weekly' ? 1 : null,
        status: 'sent',
        delivery_method: family.invoice_delivery || 'email',
        sent_at: new Date().toISOString(),
        generated_by_cron: true,
        auto_approved: true,
      })
      const inserted = await invResp.json()
      if (!Array.isArray(inserted) || inserted.length === 0) {
        results.push({ family_id: family.id, error: 'failed_to_insert' })
        continue
      }
      const invoice = inserted[0]

      // Insert line items
      for (let idx = 0; idx < lineItems.length; idx++) {
        const li = lineItems[idx]
        await supabaseRequest('invoice_items', 'POST', {
          ...li,
          invoice_id: invoice.id,
          user_id: family.user_id,
          sort_order: idx,
        })
      }

      created++
      results.push({
        family_id: family.id,
        family_name: family.family_name,
        invoice_id: invoice.id,
        amount: subtotal,
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      period: { start: periodStart, end: periodEnd },
      total_autopay_families: families.length,
      created,
      skipped,
      results,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
