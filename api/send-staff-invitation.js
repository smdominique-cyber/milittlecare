// Sends a staff invitation
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

export const config = { runtime: 'edge' }

function generateToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\//g, '_').replace(/\+/g, '-').replace(/=/g, '')
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

const ROLE_LABELS = {
  adult_staff: 'Adult Staff',
  assistant: 'Assistant (14-17)',
  view_only: 'View-only',
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const licensee = await verifyAuth(req.headers.get('authorization'))
    if (!licensee) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { recipient_name, recipient_email, intended_role } = await req.json()
    if (!recipient_email || !intended_role) {
      return new Response(JSON.stringify({ error: 'Missing recipient_email or intended_role' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!['adult_staff', 'assistant', 'view_only'].includes(intended_role)) {
      return new Response(JSON.stringify({ error: 'Invalid role' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Check existing pending invite
    const existingResp = await supabaseRequest(
      `staff_invitations?licensee_id=eq.${licensee.id}&recipient_email=eq.${encodeURIComponent(recipient_email)}&status=eq.pending&select=*`,
      'GET'
    )
    const existing = await existingResp.json()

    let invitation
    if (existing && existing.length > 0) {
      // Resend: reset expiration
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const updateResp = await supabaseRequest(
        `staff_invitations?id=eq.${existing[0].id}`,
        'PATCH',
        {
          expires_at: expiresAt,
          intended_role,
          recipient_name: recipient_name || existing[0].recipient_name,
          resent_count: (existing[0].resent_count || 0) + 1,
          sent_at: new Date().toISOString(),
        }
      )
      invitation = (await updateResp.json())[0]
    } else {
      const token = generateToken()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const insertResp = await supabaseRequest('staff_invitations', 'POST', {
        licensee_id: licensee.id,
        recipient_name: recipient_name || null,
        recipient_email,
        intended_role,
        token,
        expires_at: expiresAt,
        status: 'pending',
      })
      const inserted = await insertResp.json()
      if (!Array.isArray(inserted) || inserted.length === 0) {
        return new Response(JSON.stringify({
          error: 'Failed to create invitation',
          details: inserted,
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      invitation = inserted[0]
    }

    // Build link
    const origin = req.headers.get('origin') || 'https://milittlecare.vercel.app'
    const acceptUrl = `${origin}/staff-invite/${invitation.token}`

    // Get licensee profile for branding
    const profResp = await supabaseRequest(
      `profiles?id=eq.${licensee.id}&select=full_name,daycare_name`,
      'GET'
    )
    const profs = await profResp.json()
    const licenseeName = profs[0]?.daycare_name || profs[0]?.full_name || 'Your daycare'

    // Send email
    let emailSent = false
    let emailError = null
    if (process.env.RESEND_API_KEY) {
      try {
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [recipient_email],
            subject: `You've been invited to join ${licenseeName} on MI Little Care`,
            html: buildEmail({
              licenseeName,
              recipientName: recipient_name,
              acceptUrl,
              role: ROLE_LABELS[intended_role] || intended_role,
              expiresAt: invitation.expires_at,
            }),
          }),
        })
        if (emailResp.ok) {
          emailSent = true
        } else {
          const errData = await emailResp.json().catch(() => ({}))
          emailError = errData.message || 'Failed to send email'
        }
      } catch (err) {
        emailError = err.message
      }
    }

    return new Response(JSON.stringify({
      invitation: {
        id: invitation.id,
        token: invitation.token,
        url: acceptUrl,
        expires_at: invitation.expires_at,
        recipient_email: invitation.recipient_email,
      },
      email_sent: emailSent,
      email_error: emailError,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function buildEmail({ licenseeName, recipientName, acceptUrl, role, expiresAt }) {
  const expiresDate = new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const greeting = recipientName ? `Hi ${recipientName.split(' ')[0]},` : 'Hi there,'

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;">
<div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#3e5849,#7a9e8a);padding:32px 32px 28px;color:white;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care · Staff Invitation</div>
<div style="font-family:Georgia,serif;font-size:26px;font-weight:400;letter-spacing:-0.02em;line-height:1.2;">
You've been invited to join the team
</div>
</div>
<div style="padding:32px;">
<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#3e4639;">${greeting}</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#3e4639;">
<strong>${licenseeName}</strong> has invited you to join their child care team on MI Little Care as <strong>${role}</strong>.
</p>
<div style="background:#faf6ec;padding:16px;border-radius:8px;margin:20px 0;font-size:14px;color:#6b7c6f;">
Accept this invitation to get access to the family roster, attendance, and daily operations. You'll create your own login.
</div>
<div style="text-align:center;margin:32px 0;">
<a href="${acceptUrl}" style="display:inline-block;background:#3e5849;color:white;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;text-decoration:none;">
Accept invitation
</a>
</div>
<p style="margin:0 0 8px;font-size:14px;color:#6b7c6f;">This invitation expires on <strong>${expiresDate}</strong>.</p>
<p style="margin:0;font-size:14px;color:#6b7c6f;">Not expecting this email? You can safely ignore it.</p>
</div></div>
<div style="text-align:center;padding:24px;font-size:12px;color:#8a9281;">
Sent via MI Little Care
</div>
</div></body></html>`
}
