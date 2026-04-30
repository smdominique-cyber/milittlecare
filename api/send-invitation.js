// Creates a family invitation and emails the magic link to the parent
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

export const config = { runtime: 'edge' }

function generateToken() {
  // 24 random bytes → URL-safe base64
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

async function verifyProviderAuth(authHeader) {
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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const provider = await verifyProviderAuth(req.headers.get('authorization'))
    if (!provider) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { family_id, recipient_name, recipient_email, recipient_phone, delivery_method } = await req.json()

    if (!family_id || !recipient_email) {
      return new Response(JSON.stringify({ error: 'Missing family_id or recipient_email' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify the family belongs to this provider
    const familyResp = await supabaseRequest(
      `families?id=eq.${family_id}&user_id=eq.${provider.id}&select=*`,
      'GET'
    )
    const families = await familyResp.json()
    if (!families || families.length === 0) {
      return new Response(JSON.stringify({ error: 'Family not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const family = families[0]

    // Check for existing pending invite to same email
    const existingResp = await supabaseRequest(
      `family_invitations?family_id=eq.${family_id}&recipient_email=eq.${encodeURIComponent(recipient_email)}&status=eq.pending&select=*`,
      'GET'
    )
    const existing = await existingResp.json()

    let invitation
    if (existing && existing.length > 0) {
      // Resend: reset expiration, increment count
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const updateResp = await supabaseRequest(
        `family_invitations?id=eq.${existing[0].id}`,
        'PATCH',
        {
          expires_at: expiresAt,
          resent_count: (existing[0].resent_count || 0) + 1,
          sent_at: new Date().toISOString(),
        }
      )
      const updated = await updateResp.json()
      invitation = updated[0]
    } else {
      // New invitation
      const token = generateToken()
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      const insertResp = await supabaseRequest(
        'family_invitations',
        'POST',
        {
          user_id: provider.id,
          family_id,
          recipient_name: recipient_name || null,
          recipient_email,
          recipient_phone: recipient_phone || null,
          token,
          expires_at: expiresAt,
          status: 'pending',
          delivery_method: delivery_method || 'email',
          created_by_user_id: provider.id,
        }
      )
      const inserted = await insertResp.json()
      if (!Array.isArray(inserted) || inserted.length === 0) {
        return new Response(JSON.stringify({
          error: 'Failed to create invitation',
          details: inserted,
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      invitation = inserted[0]
    }

    // Build the link
    const origin = req.headers.get('origin') || 'https://milittlecare.vercel.app'
    const acceptUrl = `${origin}/invite/${invitation.token}`

    // Get provider's display name for the email
    const providerProfileResp = await supabaseRequest(
      `profiles?id=eq.${provider.id}&select=full_name,daycare_name`,
      'GET'
    )
    const providerProfiles = await providerProfileResp.json()
    const providerName = (providerProfiles[0]?.daycare_name || providerProfiles[0]?.full_name || 'Your child care provider')

    // Send email via Resend if configured
    let emailSent = false
    let emailError = null
    if (process.env.RESEND_API_KEY && (delivery_method === 'email' || delivery_method === 'both' || !delivery_method)) {
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
            subject: `${providerName} invited you to MI Little Care`,
            html: buildInvitationEmail({
              providerName,
              familyName: family.family_name,
              recipientName: recipient_name,
              acceptUrl,
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

function buildInvitationEmail({ providerName, familyName, recipientName, acceptUrl, expiresAt }) {
  const expiresDate = new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const greeting = recipientName ? `Hi ${recipientName.split(' ')[0]},` : 'Hi there,'

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>You're invited</title>
</head>
<body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e2620;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3e5849 0%,#7a9e8a 100%);padding:32px 32px 28px;color:white;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;letter-spacing:-0.02em;line-height:1.2;">
          ${providerName} invited you
        </div>
      </div>
      <div style="padding:32px;">
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#3e4639;">${greeting}</p>
        <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#3e4639;">
          <strong>${providerName}</strong> uses MI Little Care to manage billing for the
          <strong>${familyName}</strong>. They've invited you to view your invoices, pay online,
          and manage your family's information.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${acceptUrl}" style="display:inline-block;background:#3e5849;color:white;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;text-decoration:none;">
            Accept invitation
          </a>
        </div>
        <p style="margin:0 0 8px;font-size:14px;color:#6b7c6f;">
          This invitation expires on <strong>${expiresDate}</strong>.
        </p>
        <p style="margin:0 0 16px;font-size:14px;color:#6b7c6f;">
          Not sure why you got this email? You can safely ignore it — no account will be created.
        </p>
        <hr style="border:none;border-top:1px solid #e5d9c4;margin:24px 0;">
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#8a9281;">
          <span style="font-size:14px;">🔒</span>
          <span>Payments processed securely by Stripe. MI Little Care never sees your card details.</span>
        </div>
      </div>
    </div>
    <div style="text-align:center;padding:24px;font-size:12px;color:#8a9281;">
      Sent via MI Little Care · <a href="https://milittlecare.vercel.app" style="color:#7a9e8a;text-decoration:none;">milittlecare.vercel.app</a>
    </div>
  </div>
</body>
</html>`
}
