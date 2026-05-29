// PR #15 Half 2 — Vercel Cron: hourly opt-in reminder dispatcher.
//
// For each pending reminder_instances row where trigger_at <= now() AND
// the matching reminder_preferences row is enabled, fire the reminder
// per the configured channel:
//   - 'in_app' or 'both' -> mark fired_at; the dashboard banner host
//     reads active fired-not-dismissed-not-resolved instances.
//   - 'email' or 'both'  -> call Resend with title as subject + body +
//     deep-link CTA; write a notification_log row mirroring PR #12's
//     schema (change_type = 'reminder_<category>'); mark
//     fired_at / fired_via.
//
// Pattern matches api/cron-send-acknowledgment-digest.js for auth +
// Supabase REST + Resend conventions, so the two crons are operationally
// consistent.
//
// Hourly schedule. Idempotent across ticks: rows that were already
// fired (fired_at IS NOT NULL) are not re-picked. Failures leave
// fired_at NULL so the next tick retries. Pending instances older than
// 7 days from created_at are archived (soft-delete via archived_at)
// rather than retried forever.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   CRON_SECRET (recommended, matches ack-digest cron pattern).
// Optional env vars: RESEND_API_KEY, RESEND_FROM_EMAIL, PUBLIC_APP_URL.
// When RESEND_API_KEY is absent the cron still processes in-app
// reminders and writes notification_log rows for audit purposes;
// email sends are skipped with delivery_status='queued'.

import { scheduleMiregistryAnnualTrainingReminders } from '../src/lib/schedulers/miregistryAnnualTrainingScheduler.js'

export const config = { runtime: 'edge' }

const SEVEN_DAYS_MS = 7 * 86400000

// -----------------------------------------------------------------------------
// PostgREST helpers (matches cron-send-acknowledgment-digest.js shape).
// -----------------------------------------------------------------------------

async function supabaseGet(pathAndQuery) {
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Supabase GET ${pathAndQuery} failed: ${resp.status} ${body}`)
  }
  return resp.json()
}

async function supabasePatch(pathAndQuery, body) {
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  return resp.ok
}

async function supabasePost(table, body) {
  const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  return resp.ok
}

// -----------------------------------------------------------------------------
// PostgREST builder shim for the scheduler.
//
// The scheduler module uses the `.from(table).select()…` chain shape (so
// it can also be unit-tested with a mock). We provide a tiny shim over
// the REST helpers so the same module works in the cron context.
// -----------------------------------------------------------------------------

function makePostgrestShim() {
  function chain(table) {
    const filters = []
    const obj = {
      _table: table,
      select(_cols) { return obj },
      eq(col, val) { filters.push(`${col}=eq.${encodeURIComponent(val)}`); return obj },
      in(col, vals) {
        const list = (vals || []).map(v => `"${v}"`).join(',')
        filters.push(`${col}=in.(${list})`)
        return obj
      },
      is(col, val) {
        const v = val === null ? 'null' : (val === true ? 'true' : 'false')
        filters.push(`${col}=is.${v}`)
        return obj
      },
      gte(col, val) { filters.push(`${col}=gte.${encodeURIComponent(val)}`); return obj },
      lte(col, val) { filters.push(`${col}=lte.${encodeURIComponent(val)}`); return obj },
      limit(_n) { return obj },
      async then(resolve, reject) {
        const qs = filters.length ? `?${filters.join('&')}` : ''
        try {
          const data = await supabaseGet(`${table}${qs}`)
          resolve({ data, error: null })
        } catch (err) {
          resolve({ data: null, error: err })
        }
      },
      async insert(payload) {
        const ok = await supabasePost(table, payload)
        if (!ok) return { data: null, error: new Error(`insert into ${table} failed`) }
        return { data: payload, error: null }
      },
    }
    return obj
  }
  return { from: chain }
}

// -----------------------------------------------------------------------------
// Resend send — matches cron-send-acknowledgment-digest.js sendEmail.
// -----------------------------------------------------------------------------

async function sendViaResend({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, status: null, errorDetail: 'RESEND_API_KEY not configured' }
  }
  const fromEmail =
    process.env.RESEND_FROM_EMAIL || 'MI Little Care <onboarding@resend.dev>'

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, html, text }),
    })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        errorDetail: json?.message || `HTTP ${resp.status}`,
      }
    }
    return { ok: true, status: resp.status, providerMessageId: json?.id || null }
  } catch (err) {
    return { ok: false, status: null, errorDetail: err.message || String(err) }
  }
}

// -----------------------------------------------------------------------------
// Per-instance fire decision (pure — exported for testing).
// -----------------------------------------------------------------------------

/**
 * Decide what the dispatcher should do for a given instance given the
 * matching preference row (or undefined if none exists).
 *
 *   { action: 'skip_no_pref' | 'skip_disabled' | 'fire', channel?: 'in_app' | 'email' | 'both' }
 */
export function decideAction(instance, preference) {
  if (!preference) return { action: 'skip_no_pref' }
  if (preference.enabled === false) return { action: 'skip_disabled' }
  return { action: 'fire', channel: preference.channel || 'in_app' }
}

/**
 * Compose the email subject + html + text bodies. Pure.
 */
export function composeEmail(instance, providerName) {
  const portalBase = process.env.PUBLIC_APP_URL || 'https://milittlecare.com'
  const deepLink = instance.cta_path
    ? `${portalBase}${instance.cta_path}`
    : portalBase
  const subject = instance.title
  const text = `${instance.title}\n\n${instance.body || ''}\n\nOpen: ${deepLink}`
  const html = `
    <p><strong>${escapeHtml(instance.title)}</strong></p>
    ${instance.body ? `<p>${escapeHtml(instance.body)}</p>` : ''}
    <p><a href="${deepLink}">${escapeHtml(deepLink)}</a></p>
    <p style="color:#666;font-size:12px">From ${escapeHtml(providerName || 'MI Little Care')}</p>
  `.trim()
  return { subject, html, text }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req) {
  // Cron-secret auth (matches ack-digest cron pattern).
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  const stats = {
    scheduler_inserted: 0,
    scheduler_skipped: 0,
    instances_processed: 0,
    fired_in_app: 0,
    fired_email: 0,
    fired_both: 0,
    skipped_no_pref: 0,
    skipped_disabled: 0,
    failures: 0,
    archived_stale: 0,
    resend_disabled: !process.env.RESEND_API_KEY,
  }

  try {
    // 1) Run per-category schedulers (V1: only MiRegistry annual training).
    //    Future PRs (#18-#21) plug additional schedulers in here.
    const shim = makePostgrestShim()
    const schedStats = await scheduleMiregistryAnnualTrainingReminders(shim)
    stats.scheduler_inserted = schedStats.instancesInserted
    stats.scheduler_skipped = schedStats.instancesSkipped

    // 2) Pull pending instances ready to fire.
    const nowIso = new Date().toISOString()
    const pending = await supabaseGet(
      'reminder_instances' +
      '?fired_at=is.null' +
      '&resolved_at=is.null' +
      '&archived_at=is.null' +
      `&trigger_at=lte.${encodeURIComponent(nowIso)}` +
      '&select=id,provider_id,category,subject_type,subject_id,trigger_at,' +
      'due_at,title,body,cta_path,created_at'
    )

    if (!Array.isArray(pending) || pending.length === 0) {
      return new Response(JSON.stringify({ ok: true, stats }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Archive instances older than 7 days that were never fired.
    const now = Date.now()
    const stale = pending.filter(p => {
      const created = p.created_at ? Date.parse(p.created_at) : NaN
      return Number.isFinite(created) && now - created > SEVEN_DAYS_MS
    })
    if (stale.length > 0) {
      const ids = stale.map(s => s.id)
      const list = ids.map(id => `"${id}"`).join(',')
      await supabasePatch(
        `reminder_instances?id=in.(${list})`,
        { archived_at: new Date().toISOString() },
      )
      stats.archived_stale = ids.length
    }
    const live = pending.filter(p => !stale.includes(p))

    // 3) Fetch preferences for the providers in the batch (one round-trip).
    const providerIds = Array.from(new Set(live.map(i => i.provider_id)))
    if (providerIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, stats }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    const provList = providerIds.map(id => `"${id}"`).join(',')
    const prefs = await supabaseGet(
      `reminder_preferences?provider_id=in.(${provList})` +
      '&select=provider_id,category,channel,lead_time_days,enabled'
    )
    const prefByKey = new Map(
      (Array.isArray(prefs) ? prefs : []).map(p => [`${p.provider_id}|${p.category}`, p])
    )

    // 4) Fetch provider display names (best-effort; used in email footer).
    const providers = await supabaseGet(
      `profiles?id=in.(${provList})&select=id,full_name,daycare_name,email`
    )
    const profileById = new Map(
      (Array.isArray(providers) ? providers : []).map(p => [p.id, p])
    )

    // 5) Per-instance processing.
    for (const inst of live) {
      stats.instances_processed += 1
      const pref = prefByKey.get(`${inst.provider_id}|${inst.category}`)
      const decision = decideAction(inst, pref)
      if (decision.action === 'skip_no_pref') {
        stats.skipped_no_pref += 1
        continue
      }
      if (decision.action === 'skip_disabled') {
        stats.skipped_disabled += 1
        continue
      }

      const channel = decision.channel
      const providerProfile = profileById.get(inst.provider_id) || {}
      const providerName =
        providerProfile.daycare_name || providerProfile.full_name || 'MI Little Care'

      // Email leg: send via Resend + write notification_log.
      let emailOk = false
      let providerMessageId = null
      let emailError = null
      if (channel === 'email' || channel === 'both') {
        const { subject, html, text } = composeEmail(inst, providerName)
        // For Half 2 V1: email-to is the provider's own login email
        // (auth.users.email is not directly readable from PostgREST;
        // future enhancement could fetch it). When we cannot resolve
        // a destination, fall back to in-app only and log the gap.
        const to = providerProfile.email || null
        if (!to) {
          emailError = 'no_provider_email_on_profile'
        } else {
          const send = await sendViaResend({ to, subject, html, text })
          emailOk = send.ok
          providerMessageId = send.providerMessageId
          emailError = send.errorDetail
        }

        const delivery_status = emailOk
          ? 'sent'
          : (process.env.RESEND_API_KEY ? 'failed' : 'queued')
        await supabasePost('notification_log', {
          recipient_type: 'provider',
          recipient_id: inst.provider_id,
          recipient_email: to || null,
          change_type: `reminder_${inst.category}`,
          change_description: inst.title,
          changed_by_user_id: null,
          changed_by_role: 'system',
          family_id: null,
          child_id: null,
          email_sent: emailOk,
          email_sent_at: emailOk ? new Date().toISOString() : null,
          email_id: providerMessageId || null,
          metadata: {
            category: inst.category,
            subject_type: inst.subject_type || null,
            subject_id: inst.subject_id || null,
            instance_id: inst.id,
            delivery_status,
            error_detail: emailError || null,
          },
        })
      }

      // Mark fired. If channel was email-only and email failed, leave
      // fired_at NULL so the next tick retries.
      const inAppLeg = channel === 'in_app' || channel === 'both'
      const emailLegOk = channel === 'in_app' ? true : emailOk
      if (inAppLeg || emailLegOk) {
        const ok = await supabasePatch(
          `reminder_instances?id=eq.${inst.id}`,
          { fired_at: new Date().toISOString(), fired_via: channel },
        )
        if (ok) {
          if (channel === 'in_app') stats.fired_in_app += 1
          else if (channel === 'email') stats.fired_email += 1
          else stats.fired_both += 1
        } else {
          stats.failures += 1
        }
      } else {
        // email-only with a failed Resend send -> leave fired_at NULL
        // (next tick will retry); the notification_log row records the
        // attempt for audit purposes.
        stats.failures += 1
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err), stats }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true, stats }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
