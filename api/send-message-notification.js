// Sends an email notification to parents when a provider posts a new message.
// Throttled: at most one email per parent per thread per 10 minutes.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

export const config = { runtime: 'edge' }

const THROTTLE_MS = 10 * 60 * 1000  // 10 minutes

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

    const { thread_id, message_id, has_photos, body_preview } = await req.json()

    if (!thread_id || !message_id) {
      return new Response(JSON.stringify({ error: 'Missing thread_id or message_id' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify thread belongs to this provider
    const threadResp = await supabaseRequest(
      `message_threads?id=eq.${thread_id}&provider_user_id=eq.${provider.id}&select=*,families(family_name),children(first_name,last_name)`,
      'GET'
    )
    const threads = await threadResp.json()
    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const thread = threads[0]
    const childFirstName = thread.children?.first_name || 'your child'
    const familyName = thread.families?.family_name || ''

    // Find recent message in this thread (within throttle window) sent by provider
    const cutoff = new Date(Date.now() - THROTTLE_MS).toISOString()
    const recentResp = await supabaseRequest(
      `messages?thread_id=eq.${thread_id}&sender_type=eq.provider&created_at=gte.${cutoff}&id=neq.${message_id}&select=id&limit=1`,
      'GET'
    )
    const recent = await recentResp.json()
    if (Array.isArray(recent) && recent.length > 0) {
      // Throttle: a previous provider message in this thread within the window already triggered an email
      return new Response(JSON.stringify({
        email_sent: false,
        throttled: true,
        reason: 'A recent message already triggered a notification within 10 minutes',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Get linked parents for this family
    const linksResp = await supabaseRequest(
      `parent_family_links?family_id=eq.${thread.family_id}&status=eq.active&select=parent_id,parent_profiles(email,full_name)`,
      'GET'
    )
    const links = await linksResp.json()
    if (!Array.isArray(links) || links.length === 0) {
      return new Response(JSON.stringify({
        email_sent: false,
        reason: 'No active parent links for this family',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Get provider display name
    const providerProfileResp = await supabaseRequest(
      `profiles?id=eq.${provider.id}&select=full_name,daycare_name`,
      'GET'
    )
    const providerProfiles = await providerProfileResp.json()
    const providerName = (providerProfiles[0]?.daycare_name || providerProfiles[0]?.full_name || 'Your child care provider')

    if (!process.env.RESEND_API_KEY) {
      return new Response(JSON.stringify({
        email_sent: false,
        reason: 'Resend not configured',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const origin = req.headers.get('origin') || 'https://milittlecare.com'
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'
    const recipients = []
    const errors = []

    for (const link of links) {
      const email = link.parent_profiles?.email
      if (!email) continue
      const parentFirstName = (link.parent_profiles?.full_name || '').split(' ')[0] || ''
      try {
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [email],
            subject: `New update about ${childFirstName}`,
            html: buildMessageEmail({
              providerName,
              childFirstName,
              familyName,
              parentFirstName,
              hasPhotos: !!has_photos,
              bodyPreview: body_preview || '',
              portalUrl: `${origin}/parent/messages`,
            }),
          }),
        })
        if (emailResp.ok) {
          recipients.push(email)
        } else {
          const errData = await emailResp.json().catch(() => ({}))
          errors.push({ email, error: errData.message || 'Failed to send' })
        }
      } catch (err) {
        errors.push({ email, error: err.message })
      }
    }

    return new Response(JSON.stringify({
      email_sent: recipients.length > 0,
      recipients,
      errors: errors.length > 0 ? errors : undefined,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function buildMessageEmail({ providerName, childFirstName, familyName, parentFirstName, hasPhotos, bodyPreview, portalUrl }) {
  const greeting = parentFirstName ? `Hi ${parentFirstName},` : 'Hi there,'
  const truncated = bodyPreview.length > 200 ? bodyPreview.slice(0, 200) + '…' : bodyPreview
  const previewBlock = truncated
    ? `<div style="background:#fbf8f1;border-left:3px solid #7a9e8a;padding:14px 16px;margin:20px 0;border-radius:4px;font-size:15px;line-height:1.5;color:#3e4639;">${escapeHtml(truncated)}</div>`
    : ''
  const photoLine = hasPhotos
    ? `<p style="margin:0 0 8px;font-size:14px;color:#6b7c6f;">📷 Includes photo${hasPhotos > 1 ? 's' : ''}</p>`
    : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New update from ${escapeHtml(providerName)}</title>
</head>
<body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e2620;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3e5849 0%,#7a9e8a 100%);padding:32px 32px 28px;color:white;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:400;letter-spacing:-0.02em;line-height:1.2;">
          New update about ${escapeHtml(childFirstName)}
        </div>
      </div>
      <div style="padding:32px;">
        <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#3e4639;">${greeting}</p>
        <p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#3e4639;">
          <strong>${escapeHtml(providerName)}</strong> just sent you a message${familyName ? ` about the ${escapeHtml(familyName)}` : ''}.
        </p>
        ${photoLine}
        ${previewBlock}
        <div style="text-align:center;margin:28px 0 8px;">
          <a href="${portalUrl}" style="display:inline-block;background:#3e5849;color:white;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:500;text-decoration:none;">
            View message
          </a>
        </div>
        <hr style="border:none;border-top:1px solid #e5d9c4;margin:24px 0;">
        <p style="margin:0;font-size:13px;color:#8a9281;line-height:1.5;">
          You're getting this because you're linked to a family in MI Little Care.
          To stop receiving message notifications, ask your provider to turn off messaging,
          or unlink your account in your parent portal.
        </p>
      </div>
    </div>
  </div>
</body>
</html>`
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
