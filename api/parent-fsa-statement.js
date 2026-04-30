// Generates a year-end FSA-ready tax statement PDF for a parent
// Returns a simple HTML-based PDF (parent's browser converts to PDF on print)
// We return formatted HTML that the browser can save/print as PDF

export const config = { runtime: 'edge' }

async function supabaseRequest(path) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`
  const resp = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
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

function fmt(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default async function handler(req) {
  try {
    const url = new URL(req.url)
    const familyId = url.searchParams.get('family_id')
    const year = parseInt(url.searchParams.get('year') || new Date().getFullYear())

    if (!familyId || !year) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const parent = await verifyAuth(req.headers.get('authorization'))
    if (!parent) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify parent linked to family
    const linkResp = await supabaseRequest(
      `parent_family_links?parent_id=eq.${parent.id}&family_id=eq.${familyId}&status=eq.active&select=*`
    )
    const links = await linkResp.json()
    if (!links || links.length === 0) {
      return new Response(JSON.stringify({ error: 'Not authorized for this family' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get family + provider + children
    const [famResp, childrenResp] = await Promise.all([
      supabaseRequest(`families?id=eq.${familyId}&select=*`),
      supabaseRequest(`children?family_id=eq.${familyId}&select=*`),
    ])
    const family = (await famResp.json())[0]
    const children = await childrenResp.json()

    const providerResp = await supabaseRequest(
      `profiles?id=eq.${family.user_id}&select=full_name,email,daycare_name,phone,address,tax_id,tax_id_type`
    )
    const provider = (await providerResp.json())[0]

    // Get all paid invoices for this family in the year
    const startDate = `${year}-01-01`
    const endDate = `${year}-12-31`
    const invResp = await supabaseRequest(
      `invoices?family_id=eq.${familyId}&status=eq.paid&paid_at=gte.${startDate}&paid_at=lte.${endDate}T23:59:59&select=*&order=paid_at.asc`
    )
    const invoices = await invResp.json()

    const total = invoices.reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0)

    // Group by month
    const byMonth = {}
    for (let m = 0; m < 12; m++) {
      byMonth[m] = { month: m, total: 0, count: 0 }
    }
    for (const inv of invoices) {
      const date = new Date(inv.paid_at)
      const m = date.getMonth()
      byMonth[m].total += parseFloat(inv.amount_paid || 0)
      byMonth[m].count++
    }

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Year-End Statement ${year} — ${family.family_name}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1e2620; max-width: 7in; margin: 0 auto; padding: 24px; line-height: 1.5; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7c6f; margin: 24px 0 8px; border-bottom: 1px solid #e5d9c4; padding-bottom: 4px; }
  .header { border-bottom: 2px solid #3e5849; padding-bottom: 12px; margin-bottom: 20px; }
  .header-tagline { font-size: 11px; color: #6b7c6f; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 10px; border-bottom: 1px solid #e5d9c4; color: #6b7c6f; }
  td { padding: 8px 10px; border-bottom: 1px solid #f4eee2; font-size: 13px; }
  td.amount { text-align: right; font-family: 'Helvetica', 'Arial', sans-serif; }
  th.amount { text-align: right; }
  .info-row { display: flex; gap: 16px; margin-bottom: 6px; font-size: 13px; }
  .info-label { font-weight: 600; min-width: 120px; }
  .total-row td { font-weight: 600; font-size: 14px; background: #faf6ec; border-top: 2px solid #3e5849; border-bottom: none; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5d9c4; font-size: 11px; color: #8a9281; text-align: center; }
  .disclaimer { background: #faf6ec; padding: 12px; border-left: 3px solid #d4763b; font-size: 12px; color: #6b7c6f; margin-top: 16px; line-height: 1.5; }
  .print-btn { display: inline-block; background: #3e5849; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 13px; margin: 16px 0; font-family: -apple-system, sans-serif; }
  @media print { .print-btn { display: none; } }
</style>
</head>
<body>
  <a href="javascript:window.print()" class="print-btn">📄 Print or save as PDF</a>

  <div class="header">
    <div class="header-tagline">MI Little Care · Year-End Statement</div>
    <h1>${year} Tax & FSA Summary</h1>
    <div style="font-size: 14px; color: #3e4639;">For: <strong>${family.family_name}</strong></div>
  </div>

  <h2>Care Provider</h2>
  <div class="info-row"><span class="info-label">Name:</span><span>${provider.daycare_name || provider.full_name || ''}</span></div>
  ${provider.full_name && provider.daycare_name && provider.full_name !== provider.daycare_name ? `<div class="info-row"><span class="info-label">Operator:</span><span>${provider.full_name}</span></div>` : ''}
  ${provider.address ? `<div class="info-row"><span class="info-label">Address:</span><span>${provider.address}</span></div>` : ''}
  ${provider.phone ? `<div class="info-row"><span class="info-label">Phone:</span><span>${provider.phone}</span></div>` : ''}
  <div class="info-row"><span class="info-label">Email:</span><span>${provider.email}</span></div>
  ${provider.tax_id ? `<div class="info-row"><span class="info-label">${(provider.tax_id_type || 'ssn').toUpperCase()}:</span><span>${provider.tax_id}</span></div>` : `<div class="info-row"><span class="info-label">Tax ID:</span><span style="color: #999; font-style: italic;">Ask provider for SSN/EIN</span></div>`}

  <h2>Children in Care</h2>
  ${children.length > 0 ? children.map(c => `
    <div class="info-row"><span class="info-label">${c.first_name} ${c.last_name || ''}</span>${c.birth_date ? `<span style="color: #6b7c6f;">DOB: ${new Date(c.birth_date + 'T12:00:00').toLocaleDateString()}</span>` : ''}</div>
  `).join('') : '<div class="info-row" style="color: #6b7c6f;">No children listed</div>'}

  <h2>Monthly Payment Breakdown</h2>
  <table>
    <thead>
      <tr>
        <th>Month</th>
        <th>Payments</th>
        <th class="amount">Total Paid</th>
      </tr>
    </thead>
    <tbody>
      ${MONTH_NAMES.map((name, i) => `
        <tr>
          <td>${name} ${year}</td>
          <td>${byMonth[i].count}</td>
          <td class="amount">${byMonth[i].total > 0 ? fmt(byMonth[i].total) : '—'}</td>
        </tr>
      `).join('')}
      <tr class="total-row">
        <td>Total ${year}</td>
        <td>${invoices.length} payment${invoices.length !== 1 ? 's' : ''}</td>
        <td class="amount">${fmt(total)}</td>
      </tr>
    </tbody>
  </table>

  <h2>All Payments (Detail)</h2>
  <table>
    <thead>
      <tr>
        <th>Date Paid</th>
        <th>Period</th>
        <th>Invoice</th>
        <th class="amount">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${invoices.length === 0 ? '<tr><td colspan="4" style="text-align: center; color: #6b7c6f; padding: 20px;">No payments recorded for this year.</td></tr>' :
        invoices.map(inv => `
        <tr>
          <td>${new Date(inv.paid_at).toLocaleDateString()}</td>
          <td>${new Date(inv.period_start + 'T12:00:00').toLocaleDateString()} – ${new Date(inv.period_end + 'T12:00:00').toLocaleDateString()}</td>
          <td>${inv.invoice_number || '—'}</td>
          <td class="amount">${fmt(inv.amount_paid)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="disclaimer">
    <strong>FSA / Tax Filing Note:</strong> This statement summarizes payments made to the provider listed above for child care services rendered to the family listed above during the ${year} calendar year. For Dependent Care FSA claims, attach this statement to your reimbursement request. For Form 2441 (Credit for Child and Dependent Care Expenses), use the provider's name, address, and tax identification number listed above. If your provider has not entered their tax ID here, please request it directly from them.
  </div>

  <div class="footer">
    Generated by MI Little Care · ${new Date().toLocaleDateString()} · This document is for the recipient's tax records.
  </div>
</body>
</html>`

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Content-Disposition': `inline; filename="MI-Little-Care-FSA-${year}.html"`,
      },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
