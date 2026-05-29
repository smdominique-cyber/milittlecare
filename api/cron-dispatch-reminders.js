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
import { scheduleChildAnnualReviewReminders } from '../src/lib/schedulers/childAnnualReviewScheduler.js'
import { REMINDER_CATEGORIES } from '../src/lib/reminderCategories.js'

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
 * matching preference row (or undefined if none exists) and the
 * catalog entry for the instance's category.
 *
 *   { action: 'skip_no_pref' | 'skip_disabled' | 'fire', channel?: 'in_app' | 'email' | 'both' }
 *
 * PR #16 follow-up: when the catalog entry is `transactional: true`,
 * the dispatcher fires even when no preference row exists — the
 * provider's explicit trigger action is the consent. The provider can
 * still set `enabled = false` to opt OUT, which is honored.
 *
 * The catalog argument is optional for back-compat with the existing
 * test cases that pre-date the follow-up; an undefined or missing
 * catalog entry falls through to the PR #15 default-OFF behavior.
 */
export function decideAction(instance, preference, category) {
  const isTransactional = category && category.transactional === true
  if (!preference) {
    if (isTransactional) {
      // Default channel for transactional categories is email — the
      // whole point of a transactional category is the parent (or other
      // recipient) needs to be notified now. In-app banners only do not
      // serve that recipient.
      return { action: 'fire', channel: 'email' }
    }
    return { action: 'skip_no_pref' }
  }
  if (preference.enabled === false) return { action: 'skip_disabled' }
  // For transactional categories, default channel is 'email' rather
  // than 'in_app' when the preference row omits a channel — the parent
  // can't see the provider's in-app banner.
  const fallbackChannel = isTransactional ? 'email' : 'in_app'
  return { action: 'fire', channel: preference.channel || fallbackChannel }
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
// Recipient resolution — PR #16 follow-up Issue #4.
//
// PR #15's V1 hard-coded the email-to as providerProfile.email. That's
// correct for state-driven, provider-facing categories (CPR, drills,
// annual review). Categories whose recipient is the PARENT need a
// different lookup. The catalog entry's `recipient_resolver` field
// selects which lookup to use.
//
// Currently:
//   - undefined / 'provider' → [{ provider profile }]
//   - 'parent_via_subject_child' → fan-out to every active linked
//     parent of the subject child whose `acknowledgment_email_opt_in`
//     is not explicitly false.
//
// Returns an array of recipients: [{ email, recipient_type, recipient_id, family_id? }, ...]
// Empty array means "no deliverable recipient" — the caller writes a
// notification_log "no_recipient" row and leaves fired_at NULL so the
// next tick can retry.
//
// Reuses the exact lookup pattern already running in production at
// api/cron-send-acknowledgment-digest.js:234-256. Same role
// (SUPABASE_SERVICE_ROLE_KEY), same PostgREST embed shape, same
// acknowledgment_email_opt_in respect.
// -----------------------------------------------------------------------------
export async function resolveRecipients(instance, providerProfile, category) {
  const resolver = category && category.recipient_resolver
  if (!resolver || resolver === 'provider') {
    if (providerProfile && providerProfile.email) {
      return [{
        email: providerProfile.email,
        recipient_type: 'provider',
        recipient_id: instance.provider_id,
        family_id: null,
      }]
    }
    return []
  }
  if (resolver === 'parent_via_subject_child') {
    if (instance.subject_type !== 'child' || !instance.subject_id) return []
    // 1. child → family_id
    const childRows = await supabaseGet(
      `children?id=eq.${instance.subject_id}&select=family_id`
    )
    if (!Array.isArray(childRows) || childRows.length === 0) return []
    const familyId = childRows[0].family_id
    if (!familyId) return []
    // 2. family_id + status=active → parent_profiles(email, opt-in).
    // Embed shape matches cron-send-acknowledgment-digest.js — same
    // PostgREST inference used in production for the digest cron.
    const links = await supabaseGet(
      `parent_family_links?family_id=eq.${familyId}&status=eq.active` +
      '&select=parent_id,family_id,parent_profiles(id,email,full_name,acknowledgment_email_opt_in)'
    )
    if (!Array.isArray(links) || links.length === 0) return []
    const out = []
    const seen = new Set()
    for (const link of links) {
      const p = link.parent_profiles
      if (!p || !p.email) continue
      if (p.acknowledgment_email_opt_in === false) continue
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push({
        email: p.email,
        recipient_type: 'parent',
        recipient_id: p.id,
        family_id: familyId,
      })
    }
    return out
  }
  return []
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
    // 1) Run per-category schedulers. Future PRs (#17-#21) plug
    //    additional schedulers in here.
    const shim = makePostgrestShim()
    const schedStats = await scheduleMiregistryAnnualTrainingReminders(shim)
    const reviewStats = await scheduleChildAnnualReviewReminders(shim)
    stats.scheduler_inserted = schedStats.instancesInserted + reviewStats.instancesInserted
    stats.scheduler_skipped = schedStats.instancesSkipped + reviewStats.instancesSkipped

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
      const category = REMINDER_CATEGORIES[inst.category]
      const pref = prefByKey.get(`${inst.provider_id}|${inst.category}`)
      const decision = decideAction(inst, pref, category)
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

      // Email leg: send via Resend + write notification_log per recipient.
      // For provider-facing categories the recipient list is the provider
      // alone (PR #15 behavior). For categories with a `parent_via_subject_child`
      // resolver (PR #16 follow-up — intake_acknowledgment_pending), this
      // fans out to every active linked parent of the subject child who
      // has not opted out via parent_profiles.acknowledgment_email_opt_in.
      let anyEmailOk = false
      let anyEmailAttempted = false
      if (channel === 'email' || channel === 'both') {
        anyEmailAttempted = true
        const recipients = await resolveRecipients(inst, providerProfile, category)
        if (recipients.length === 0) {
          // No deliverable recipient. Log the gap; do NOT mark fired so
          // the next tick can retry (the parent may opt back in, the
          // link may be created later, etc. — same retry semantics as
          // a failed Resend send).
          await supabasePost('notification_log', {
            recipient_type: category?.recipient_resolver === 'parent_via_subject_child'
              ? 'parent' : 'provider',
            recipient_id: null,
            recipient_email: null,
            change_type: `reminder_${inst.category}`,
            change_description: inst.title,
            changed_by_user_id: null,
            changed_by_role: 'system',
            family_id: null,
            child_id: inst.subject_type === 'child' ? inst.subject_id : null,
            email_sent: false,
            email_sent_at: null,
            email_id: null,
            metadata: {
              category: inst.category,
              subject_type: inst.subject_type || null,
              subject_id: inst.subject_id || null,
              instance_id: inst.id,
              delivery_status: 'no_recipient',
              error_detail:
                category?.recipient_resolver === 'parent_via_subject_child'
                  ? 'no_linked_opted_in_parent'
                  : 'no_provider_email_on_profile',
            },
          })
        }
        for (const r of recipients) {
          const { subject, html, text } = composeEmail(inst, providerName)
          const send = await sendViaResend({
            to: r.email, subject, html, text,
          })
          const okHere = send.ok
          if (okHere) anyEmailOk = true
          const delivery_status = okHere
            ? 'sent'
            : (process.env.RESEND_API_KEY ? 'failed' : 'queued')
          await supabasePost('notification_log', {
            recipient_type: r.recipient_type,
            recipient_id: r.recipient_id,
            recipient_email: r.email,
            change_type: `reminder_${inst.category}`,
            change_description: inst.title,
            changed_by_user_id: null,
            changed_by_role: 'system',
            family_id: r.family_id || null,
            child_id: inst.subject_type === 'child' ? inst.subject_id : null,
            email_sent: okHere,
            email_sent_at: okHere ? new Date().toISOString() : null,
            email_id: send.providerMessageId || null,
            metadata: {
              category: inst.category,
              subject_type: inst.subject_type || null,
              subject_id: inst.subject_id || null,
              instance_id: inst.id,
              delivery_status,
              error_detail: send.errorDetail || null,
            },
          })
        }
      }

      // Mark fired. If channel was email-only and EVERY send failed,
      // leave fired_at NULL so the next tick retries.
      const inAppLeg = channel === 'in_app' || channel === 'both'
      const emailLegOk = channel === 'in_app'
        ? true
        : (anyEmailAttempted ? anyEmailOk : false)
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
        // email-only with no successful send -> leave fired_at NULL.
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
