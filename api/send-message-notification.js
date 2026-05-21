// Sends an email notification to the OTHER party when someone posts a new message.
// Provider posts → notify all linked parents.
// Parent posts → notify the provider (the family owner).
// Throttled: at most one email per recipient per thread per 10 minutes.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

export const config = { runtime: 'edge' }

const THROTTLE_MS = 10 * 60 * 1000

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
    const sender = await verifyAuth(req.headers.get('authorization'))
    if (!sender) {
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

    // Load thread with family + child info, and verify sender has access
    const threadResp = await supabaseRequest(
      `message_threads?id=eq.${thread_id}&select=*,families(family_name),children(first_name,last_name)`,
      'GET'
    )
    const threadsRaw = await threadResp.json().catch(() => null)
    const threads = Array.isArray(threadsRaw) ? threadsRaw : []
    if (threads.length === 0) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const thread = threads[0]
    const childFirstName = thread.children?.first_name || 'your child'
    const familyName = thread.families?.family_name || ''

    // Determine sender type by checking the message that was just posted
    const msgResp = await supabaseRequest(
      `messages?id=eq.${message_id}&select=sender_type,sender_user_id`,
      'GET'
    )
    const msgRowsRaw = await msgResp.json().catch(() => null)
    const msgRows = Array.isArray(msgRowsRaw) ? msgRowsRaw : []
    if (msgRows.length === 0) {
      return new Response(JSON.stringify({ error: 'Message not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const senderType = msgRows[0].sender_type
    const senderUserId = msgRows[0].sender_user_id

    // Verify the sender of the message is the authed user
    if (senderUserId !== sender.id) {
      return new Response(JSON.stringify({ error: 'Sender mismatch' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Verify thread access matches sender type
    if (senderType === 'provider' && thread.provider_user_id !== sender.id) {
      return new Response(JSON.stringify({ error: 'Not your thread' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (senderType === 'parent') {
      const linkResp = await supabaseRequest(
        `parent_family_links?parent_id=eq.${sender.id}&family_id=eq.${thread.family_id}&status=eq.active&select=id`,
        'GET'
      )
      const linksRaw = await linkResp.json().catch(() => null)
      const links = Array.isArray(linksRaw) ? linksRaw : []
      if (links.length === 0) {
        return new Response(JSON.stringify({ error: 'Not linked to this family' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Throttle: skip if a previous SAME-SENDER-TYPE message was posted within the window
    const cutoff = new Date(Date.now() - THROTTLE_MS).toISOString()
    const recentResp = await supabaseRequest(
      `messages?thread_id=eq.${thread_id}&sender_type=eq.${senderType}&created_at=gte.${cutoff}&id=neq.${message_id}&select=id&limit=1`,
      'GET'
    )
    const recent = await recentResp.json()
    if (Array.isArray(recent) && recent.length > 0) {
      return new Response(JSON.stringify({
        email_sent: false,
        throttled: true,
        reason: 'A recent message already triggered a notification',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

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

    // Build recipients list based on direction
    let toEmails = []  // [{ email, firstName }]
    let providerName = 'Your child care provider'
    let parentName = 'A parent'

    // Get provider profile (we'll need it either way)
    const provProfResp = await supabaseRequest(
      `profiles?id=eq.${thread.provider_user_id}&select=full_name,daycare_name`,
      'GET'
    )
    const provProfsRaw = await provProfResp.json().catch(() => null)
    const provProfs = Array.isArray(provProfsRaw) ? provProfsRaw : []
    providerName = provProfs[0]?.daycare_name || provProfs[0]?.full_name || providerName

    if (senderType === 'provider') {
      // Provider posted → notify all linked parents.
      // parent_family_links.parent_id FKs to auth.users(id), not parent_profiles(id).
      // The hint-syntax workaround was tried 2026-05-22 and did NOT work in
      // production — PostgREST does not transitively follow auth.users →
      // parent_profiles. Two-query fallback is the only viable fix until a
      // real FK lands. See docs/tech_debt.md § parent_profiles FK gap.

      // Query 1: links (no embed).
      const linksResp = await supabaseRequest(
        `parent_family_links?family_id=eq.${thread.family_id}&status=eq.active&select=parent_id`,
        'GET'
      )
      const linksJson = await linksResp.json().catch(() => null)
      const safeLinks = Array.isArray(linksJson) ? linksJson : []
      const parentIds = safeLinks.map(l => l && l.parent_id).filter(Boolean)

      // Query 2: profiles for those parent_ids.
      let parentsByIds = {}
      if (parentIds.length > 0) {
        const idsList = parentIds.join(',')
        const profilesResp = await supabaseRequest(
          `parent_profiles?id=in.(${idsList})&select=id,email,full_name`,
          'GET'
        )
        const profilesJson = await profilesResp.json().catch(() => null)
        const safeProfiles = Array.isArray(profilesJson) ? profilesJson : []
        parentsByIds = Object.fromEntries(safeProfiles.map(p => [p.id, p]))
      }

      // Merge + filter. Drop parents with no email row (and log the skip so
      // a missing-email follow-up is debuggable without piecing it together
      // from Vercel access logs).
      for (const link of safeLinks) {
        const profile = parentsByIds[link.parent_id]
        if (!profile) {
          console.log('send-message-notification: skipping parent without profile', { parent_id: link.parent_id })
          continue
        }
        if (!profile.email) {
          console.log('send-message-notification: skipping parent without email', { parent_id: link.parent_id })
          continue
        }
        const firstName = (profile.full_name || '').split(' ')[0] || ''
        toEmails.push({ email: profile.email, firstName })
      }

      // Temporary diagnostic for the 2026-05-22 deploy. Remove once the
      // notification flow is confirmed delivering — leaves a clean trail in
      // Vercel logs to distinguish "zero recipients found" from "recipients
      // found, Resend failing."
      console.log('send-message-notification: recipients resolved',
        { count: toEmails.length, emails: toEmails.map(t => t.email) })
    } else {
      // Parent posted → notify the provider
      // Get provider email from auth.users
      const provUserResp = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/admin/users/${thread.provider_user_id}`,
        {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      )
      if (provUserResp.ok) {
        const provUser = await provUserResp.json().catch(() => null)
        if (provUser && provUser.email) {
          toEmails.push({
            email: provUser.email,
            firstName: (provProfs[0]?.full_name || '').split(' ')[0] || '',
          })
        } else {
          console.log('send-message-notification: skipping provider notify, no email on auth user', { provider_user_id: thread.provider_user_id })
        }
      } else {
        console.log('send-message-notification: failed to load provider auth user', { status: provUserResp.status })
      }

      // Get parent name for display in email
      const parentProfResp = await supabaseRequest(
        `parent_profiles?id=eq.${sender.id}&select=full_name`,
        'GET'
      )
      const parentProfsRaw = await parentProfResp.json().catch(() => null)
      const parentProfs = Array.isArray(parentProfsRaw) ? parentProfsRaw : []
      parentName = parentProfs[0]?.full_name || 'A parent'

      // Same temporary diagnostic on the parent->provider path.
      console.log('send-message-notification: recipients resolved',
        { count: toEmails.length, emails: toEmails.map(t => t.email) })
    }

    if (toEmails.length === 0) {
      return new Response(JSON.stringify({
        email_sent: false,
        reason: 'No recipients found',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Build subject + body based on direction
    let subject, portalUrl
    if (senderType === 'provider') {
      subject = `New update about ${childFirstName}`
      portalUrl = `${origin}/parent/messages`
    } else {
      subject = `${parentName} sent a message about ${childFirstName}`
      portalUrl = `${origin}/messages`
    }

    for (const recipient of toEmails) {
      // Defence in depth: never pass null/empty to Resend, even if a future
      // code path constructs toEmails without filtering.
      if (!recipient || !recipient.email) {
        console.log('send-message-notification: skipping recipient with no email at send time', { recipient })
        continue
      }
      try {
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [recipient.email],
            subject,
            html: buildMessageEmail({
              senderType,
              providerName,
              parentName,
              childFirstName,
              familyName,
              recipientFirstName: recipient.firstName,
              hasPhotos: !!has_photos,
              bodyPreview: body_preview || '',
              portalUrl,
            }),
          }),
        })
        if (emailResp.ok) {
          recipients.push(recipient.email)
        } else {
          const errData = await emailResp.json().catch(() => ({}))
          errors.push({ email: recipient.email, error: errData.message || 'Failed to send' })
        }
      } catch (err) {
        errors.push({ email: recipient.email, error: err.message })
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

function buildMessageEmail({ senderType, providerName, parentName, childFirstName, familyName, recipientFirstName, hasPhotos, bodyPreview, portalUrl }) {
  const greeting = recipientFirstName ? `Hi ${recipientFirstName},` : 'Hi there,'
  const senderDisplayName = senderType === 'provider' ? providerName : parentName
  const truncated = bodyPreview.length > 200 ? bodyPreview.slice(0, 200) + '…' : bodyPreview
  const previewBlock = truncated
    ? `<div style="background:#fbf8f1;border-left:3px solid #7a9e8a;padding:14px 16px;margin:20px 0;border-radius:4px;font-size:15px;line-height:1.5;color:#3e4639;">${escapeHtml(truncated)}</div>`
    : ''
  const photoLine = hasPhotos
    ? `<p style="margin:0 0 8px;font-size:14px;color:#6b7c6f;">📷 Includes photo(s)</p>`
    : ''

  const headerText = senderType === 'provider'
    ? `New update about ${escapeHtml(childFirstName)}`
    : `New message from ${escapeHtml(parentName)}`

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${headerText}</title>
</head>
<body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e2620;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#3e5849 0%,#7a9e8a 100%);padding:32px 32px 28px;color:white;">
        <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;margin-bottom:8px;">MI Little Care</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:400;letter-spacing:-0.02em;line-height:1.2;">
          ${headerText}
        </div>
      </div>
      <div style="padding:32px;">
        <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#3e4639;">${greeting}</p>
        <p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#3e4639;">
          <strong>${escapeHtml(senderDisplayName)}</strong> just sent a message${senderType === 'parent' ? ` about ${escapeHtml(childFirstName)}` : (familyName ? ` about the ${escapeHtml(familyName)}` : '')}.
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
          You're getting this because messaging is enabled in MI Little Care.
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
