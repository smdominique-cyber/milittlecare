// Centralized state-change notification dispatcher
// Called by client when meaningful changes happen
// Logs the notification + sends email via Resend

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

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return { sent: false, error: 'no_api_key' }
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, html }),
    })
    const data = await resp.json()
    if (!resp.ok) return { sent: false, error: data.message || 'send_failed' }
    return { sent: true, id: data.id }
  } catch (err) { return { sent: false, error: err.message } }
}

// ─── Notification templates ──────────────────────────────

const NOTIFICATIONS = {
  // Parent → Provider
  allergy_updated: {
    direction: 'parent_to_provider',
    isLoud: true,  // flagged red
    subject: ({ childName }) => `🚨 Allergy updated for ${childName}`,
    body: ({ childName, changedBy, allergies, providerName }) => `
      <h2 style="color:#c0392b;">Allergy information updated</h2>
      <p><strong>${changedBy || 'A parent'}</strong> updated allergy information for <strong>${childName}</strong>.</p>
      <div style="background:#fdf2f1;border:1px solid #f5cdc8;padding:14px;border-radius:8px;margin:16px 0;">
        <strong style="color:#8b3128;">Current allergies:</strong><br>
        ${allergies || 'None listed'}
      </div>
      <p>Please review this information and update your records.</p>
    `,
  },
  emergency_contact_updated: {
    direction: 'parent_to_provider',
    isLoud: false,
    subject: ({ familyName }) => `Emergency contact updated for ${familyName}`,
    body: ({ familyName, changedBy }) => `
      <p><strong>${changedBy || 'A parent'}</strong> updated emergency contact info for <strong>${familyName}</strong>.</p>
      <p>You can view the updated information in the family details.</p>
    `,
  },
  guardian_added: {
    direction: 'parent_to_provider',
    isLoud: false,
    subject: ({ guardianName, familyName }) => `${guardianName} added to ${familyName}`,
    body: ({ guardianName, familyName, changedBy }) => `
      <p><strong>${changedBy || 'A parent'}</strong> added <strong>${guardianName}</strong> as a guardian for <strong>${familyName}</strong>.</p>
    `,
  },
  guardian_removed: {
    direction: 'parent_to_provider',
    isLoud: false,
    subject: ({ guardianName, familyName }) => `${guardianName} removed from ${familyName}`,
    body: ({ guardianName, familyName, changedBy }) => `
      <p><strong>${changedBy || 'A parent'}</strong> removed <strong>${guardianName}</strong> as a guardian for <strong>${familyName}</strong>.</p>
    `,
  },
  pickup_authorized: {
    direction: 'parent_to_provider',
    isLoud: false,
    subject: ({ name, familyName }) => `${name} authorized for pickup — ${familyName}`,
    body: ({ name, familyName, changedBy }) => `
      <p><strong>${changedBy || 'A parent'}</strong> added <strong>${name}</strong> to the authorized pickup list for <strong>${familyName}</strong>.</p>
    `,
  },
  contact_updated: {
    direction: 'parent_to_provider',
    isLoud: false,
    subject: ({ familyName }) => `Contact info updated for ${familyName}`,
    body: ({ familyName, changedBy, summary }) => `
      <p><strong>${changedBy || 'A parent'}</strong> updated their contact information for <strong>${familyName}</strong>.</p>
      ${summary ? `<p><strong>What changed:</strong> ${summary}</p>` : ''}
    `,
  },

  // Provider → Parent
  hours_changed: {
    direction: 'provider_to_parent',
    isLoud: false,
    subject: ({ providerName }) => `${providerName} updated their hours`,
    body: ({ providerName, summary }) => `
      <h2>Hours updated</h2>
      <p><strong>${providerName}</strong> updated their operating hours.</p>
      ${summary ? `<p>${summary}</p>` : ''}
      <p style="margin-top:24px;">
        <a href="https://milittlecare.vercel.app/parent" style="display:inline-block;background:#3e5849;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">View in your portal</a>
      </p>
    `,
  },
  closure_added: {
    direction: 'provider_to_parent',
    isLoud: false,
    subject: ({ providerName, dateRange }) => `${providerName} closed ${dateRange}`,
    body: ({ providerName, dateRange, reason }) => `
      <h2>Closure added</h2>
      <p><strong>${providerName}</strong> will be closed <strong>${dateRange}</strong>${reason ? ` — ${reason}` : ''}.</p>
      <p style="margin-top:24px;">
        <a href="https://milittlecare.vercel.app/parent" style="display:inline-block;background:#3e5849;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">View in your portal</a>
      </p>
    `,
  },
  rate_updated: {
    direction: 'provider_to_parent',
    isLoud: true,
    subject: ({ providerName }) => `Your rate has been updated`,
    body: ({ providerName, oldRate, newRate, billingType, effectiveDate }) => `
      <h2>Rate change</h2>
      <p><strong>${providerName}</strong> updated your billing rate.</p>
      <div style="background:#faf6ec;border:1px solid #d4763b;padding:14px;border-radius:8px;margin:16px 0;">
        <strong>New rate:</strong> $${newRate} ${billingType === 'weekly' ? 'per week' : 'per hour'}<br>
        ${effectiveDate ? `<strong>Effective:</strong> ${effectiveDate}<br>` : ''}
        ${oldRate ? `<span style="color:#6b7c6f;">(Previous rate: $${oldRate})</span>` : ''}
      </div>
      <p>If you have questions, please contact your provider directly.</p>
    `,
  },
  payment_due_day_changed: {
    direction: 'provider_to_parent',
    isLoud: false,
    subject: ({ providerName, newDay }) => `Payment day changed: now due ${newDay}s`,
    body: ({ providerName, newDay }) => `
      <p><strong>${providerName}</strong> changed the weekly payment due day.</p>
      <p>Payments are now due each <strong>${newDay}</strong>.</p>
      <p>If you have autopay enabled, your charge schedule will adjust automatically.</p>
    `,
  },
}

function buildEmailWrapper(content) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fbf8f1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1e2620;">
<div style="max-width:560px;margin:0 auto;padding:40px 24px;">
<div style="background:white;border:1px solid #e5d9c4;border-radius:16px;overflow:hidden;">
<div style="background:linear-gradient(135deg,#3e5849,#7a9e8a);padding:24px 28px;color:white;">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.8;">MI Little Care</div>
</div>
<div style="padding:32px;font-size:15px;line-height:1.6;">${content}</div>
<div style="background:#fbf8f1;padding:14px 32px;text-align:center;font-size:11px;color:#8a9281;border-top:1px solid #e5d9c4;">
You're receiving this because of activity on your MI Little Care account.
</div>
</div>
</div></body></html>`
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const user = await verifyAuth(req.headers.get('authorization'))
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { change_type, family_id, child_id, data } = await req.json()
    const template = NOTIFICATIONS[change_type]
    if (!template) {
      return new Response(JSON.stringify({ error: 'Unknown change type' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Get family + provider info
    if (!family_id) {
      return new Response(JSON.stringify({ error: 'family_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const famResp = await supabaseRequest(`families?id=eq.${family_id}&select=*`, 'GET')
    const families = await famResp.json()
    if (!families || families.length === 0) {
      return new Response(JSON.stringify({ error: 'Family not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    const family = families[0]

    // Authorization: user must be either the provider OR a parent linked to this family
    let userRole = null
    if (family.user_id === user.id) {
      userRole = 'provider'
    } else {
      const linkResp = await supabaseRequest(
        `parent_family_links?parent_id=eq.${user.id}&family_id=eq.${family_id}&status=eq.active&select=*`,
        'GET'
      )
      const links = await linkResp.json()
      if (links && links.length > 0) userRole = 'parent'
    }

    if (!userRole) {
      return new Response(JSON.stringify({ error: 'Not authorized for this family' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Determine recipients based on direction
    const recipients = []

    if (template.direction === 'parent_to_provider') {
      // Get provider profile
      const provResp = await supabaseRequest(
        `profiles?id=eq.${family.user_id}&select=email,full_name,daycare_name`,
        'GET'
      )
      const provs = await provResp.json()
      if (provs && provs[0]?.email) {
        recipients.push({
          recipient_type: 'provider',
          recipient_id: family.user_id,
          recipient_email: provs[0].email,
          name: provs[0].daycare_name || provs[0].full_name,
        })
      }
    } else if (template.direction === 'provider_to_parent') {
      // Get all linked parents
      const linksResp = await supabaseRequest(
        `parent_family_links?family_id=eq.${family_id}&status=eq.active&select=parent_id`,
        'GET'
      )
      const links = await linksResp.json()
      for (const link of links || []) {
        const parentResp = await supabaseRequest(
          `parent_profiles?id=eq.${link.parent_id}&select=email,full_name`,
          'GET'
        )
        const parents = await parentResp.json()
        if (parents && parents[0]?.email) {
          recipients.push({
            recipient_type: 'parent',
            recipient_id: link.parent_id,
            recipient_email: parents[0].email,
            name: parents[0].full_name,
          })
        }
      }
    }

    if (recipients.length === 0) {
      // No recipients to email — still log the change but skip sending
      return new Response(JSON.stringify({
        ok: true,
        sent: 0,
        skipped: 'no_recipients',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Build email content
    const emailData = { ...data, familyName: family.family_name }
    let sentCount = 0
    const results = []

    for (const recipient of recipients) {
      const subject = template.subject(emailData)
      const bodyContent = template.body(emailData)
      const html = buildEmailWrapper(bodyContent)

      const result = await sendEmail({
        to: recipient.recipient_email,
        subject,
        html,
      })

      // Log to notification_log
      await supabaseRequest('notification_log', 'POST', {
        recipient_type: recipient.recipient_type,
        recipient_id: recipient.recipient_id,
        recipient_email: recipient.recipient_email,
        change_type,
        change_description: subject,
        changed_by_user_id: user.id,
        changed_by_role: userRole,
        family_id,
        child_id: child_id || null,
        email_sent: result.sent,
        email_sent_at: result.sent ? new Date().toISOString() : null,
        email_id: result.id || null,
        metadata: data || {},
      })

      if (result.sent) sentCount++
      results.push({ recipient: recipient.recipient_email, sent: result.sent, error: result.error })
    }

    return new Response(JSON.stringify({
      ok: true,
      sent: sentCount,
      total: recipients.length,
      results,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
