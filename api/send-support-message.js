// Sends a support message to admin email via Resend

export const config = { runtime: 'edge' }

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

const ADMIN_EMAIL = 'smdominique@gmail.com'

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { subject, message, category, page_context, user_agent } = await req.json()
    if (!subject || !message) {
      return new Response(JSON.stringify({ error: 'Subject and message required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Optional auth — works for anonymous + logged in users
    let userInfo = 'Not signed in'
    const auth = await verifyAuth(req.headers.get('authorization'))
    if (auth) {
      userInfo = `${auth.email} (${auth.user_metadata?.full_name || 'no name'}) — id: ${auth.id}`
    }

    if (!process.env.RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: 'Email service not configured' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'

    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:#3e5849;color:white;padding:20px;border-radius:8px 8px 0 0;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;opacity:0.8;margin-bottom:6px;">MI Little Care · Support Request</div>
<div style="font-size:18px;font-weight:500;">${subject}</div>
</div>
<div style="background:white;border:1px solid #e5d9c4;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
<table style="width:100%;font-size:13px;color:#6b7c6f;margin-bottom:16px;border-collapse:collapse;">
<tr><td style="padding:4px 0;width:90px;"><strong>Category:</strong></td><td style="padding:4px 0;">${category || 'General'}</td></tr>
<tr><td style="padding:4px 0;"><strong>From:</strong></td><td style="padding:4px 0;">${userInfo}</td></tr>
${page_context ? `<tr><td style="padding:4px 0;"><strong>Page:</strong></td><td style="padding:4px 0;">${page_context}</td></tr>` : ''}
${user_agent ? `<tr><td style="padding:4px 0;"><strong>Browser:</strong></td><td style="padding:4px 0;font-size:11px;">${user_agent}</td></tr>` : ''}
<tr><td style="padding:4px 0;"><strong>Time:</strong></td><td style="padding:4px 0;">${new Date().toLocaleString()}</td></tr>
</table>
<hr style="border:none;border-top:1px solid #e5d9c4;margin:16px 0;">
<div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#1e2620;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
</div>
</body></html>`

    const replyTo = auth?.email || undefined

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [ADMIN_EMAIL],
        reply_to: replyTo,
        subject: `[MI Little Care Support] ${subject}`,
        html,
      }),
    })

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}))
      return new Response(JSON.stringify({
        error: errData.message || 'Failed to send message',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
