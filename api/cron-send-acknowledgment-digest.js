// Vercel Cron: hourly check for parent-acknowledgment digest sends.
// For each provider whose acknowledgment-email settings match the
// current local time/day, find every linked parent with unacknowledged
// billed days in the digest window and send them a Resend digest email
// pointing at the portal. No tokens in the email URL — the parent
// authenticates normally and lands on /parent/acknowledge.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (optional).
// Optional env vars: CRON_SECRET, RESEND_FROM_EMAIL, PUBLIC_APP_URL.
//
// Defensive guard: if RESEND_API_KEY is absent the cron logs the
// intended sends and returns without calling Resend — same shape as
// api/cron-charge-autopay.js. Lets the migration land before the
// human dashboard steps (API key, From-address, domain verification)
// are completed.
//
// Plan-dependency note: this is a 3rd Vercel cron (alongside
// cron-generate-autopay-invoices and cron-charge-autopay). On Vercel
// Hobby this exceeds the 2-cron limit; the project may need Pro or
// cron consolidation. Flagged in docs/pr-12-review.md.

import {
  shouldSendDigestNow,
  digestDateRange,
  buildDigestEmail,
  DEFAULT_TIMEZONE,
} from '../src/lib/acknowledgmentDigest.js'
import {
  computeAttendanceHash,
  ACK_STATE,
} from '../src/lib/parentAcknowledgment.js'

export const config = { runtime: 'edge' }

// -----------------------------------------------------------------------------
// REST helpers (PostgREST via service role — same pattern as
// api/cron-charge-autopay.js)
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
// Resend send — matches api/cron-charge-autopay.js sendEmail pattern.
// Returns { ok, status, providerMessageId, errorDetail }. One retry on
// transient (5xx) failure after 5 minutes is handled at the orchestrator
// level via a second-pass loop in this single invocation (we don't
// re-invoke the cron, we just retry in-process before logging permanent
// failure).
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
// Per-parent digest orchestration
// -----------------------------------------------------------------------------

/**
 * Returns the unique unacknowledged billed (child_id, date, segment_index)
 * keys for a parent's children in the [start, end] window. Drops segments
 * that are already cleanly acknowledged, currently flagged, or acknowledged
 * by provider override. Includes segments whose acknowledgment hash no
 * longer matches (tampered — same as unacked from the parent's view).
 */
async function getUnackedBilledSegmentsForChildren({ childIds, startDate, endDate }) {
  if (!childIds.length) return []

  const childList = childIds.map(id => `"${id}"`).join(',')
  const attendance = await supabaseGet(
    `attendance?child_id=in.(${childList})` +
    `&date=gte.${startDate}&date=lte.${endDate}` +
    `&status=eq.present` +
    `&select=id,child_id,date,segment_index,status,check_in,check_out`
  )

  const acks = await supabaseGet(
    `attendance_acknowledgments?child_id=in.(${childList})` +
    `&date=gte.${startDate}&date=lte.${endDate}` +
    `&archived_at=is.null` +
    `&select=child_id,date,segment_index,acknowledged_via,attendance_snapshot_hash`
  )
  const flags = await supabaseGet(
    `acknowledgment_flags?child_id=in.(${childList})` +
    `&date=gte.${startDate}&date=lte.${endDate}` +
    `&archived_at=is.null&resolved_at=is.null` +
    `&select=child_id,date,segment_index`
  )

  const flagKey = new Set(flags.map(f => `${f.child_id}|${f.date}|${f.segment_index ?? 0}`))
  const ackByKey = new Map(
    acks.map(a => [`${a.child_id}|${a.date}|${a.segment_index ?? 0}`, a])
  )

  const awaiting = []
  for (const rec of attendance) {
    // Only billed segments (status='present' AND positive duration).
    if (!hasPositiveDuration(rec)) continue

    const key = `${rec.child_id}|${rec.date}|${rec.segment_index ?? 0}`
    if (flagKey.has(key)) continue                      // flagged → parent already acted

    const ack = ackByKey.get(key)
    if (ack && ack.acknowledged_via === 'provider_override') continue  // provider handled
    if (ack && ack.attendance_snapshot_hash === computeAttendanceHash(rec)) continue  // clean

    // Either no ack at all, or hash mismatch → needs parent action.
    awaiting.push(rec)
  }
  return awaiting
}

function hasPositiveDuration(rec) {
  if (!rec || rec.status !== 'present' || !rec.check_in || !rec.check_out) return false
  const parse = hms => {
    const [h, m, s = 0] = String(hms).split(':').map(Number)
    return h + m / 60 + s / 3600
  }
  const a = parse(rec.check_in)
  const b = parse(rec.check_out)
  return Number.isFinite(a) && Number.isFinite(b) && b > a
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req) {
  // Optional cron-secret check, same pattern as cron-charge-autopay.js
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

  const nowUtc = new Date()
  const stats = {
    providers_checked: 0,
    providers_in_window: 0,
    digests_sent: 0,
    digests_skipped_no_recipients: 0,
    digests_failed: 0,
    resend_disabled: !process.env.RESEND_API_KEY,
  }

  try {
    // Get every provider with acknowledgment settings present. We can't
    // filter on shouldSendDigestNow at the DB level (TZ math is JS-side),
    // so pull all enabled providers and filter in memory.
    const providers = await supabaseGet(
      'profiles?acknowledgment_email_enabled=eq.true&select=' +
      'id,full_name,daycare_name,' +
      'acknowledgment_cadence,acknowledgment_strictness,' +
      'acknowledgment_email_send_day,acknowledgment_email_send_hour,acknowledgment_email_timezone'
    )
    stats.providers_checked = providers.length

    for (const provider of providers) {
      if (!shouldSendDigestNow({ provider, nowUtc })) continue
      stats.providers_in_window += 1

      const cadence = provider.acknowledgment_cadence || 'weekly'
      const tz = provider.acknowledgment_email_timezone || DEFAULT_TIMEZONE
      const { start, end } = digestDateRange({ cadence, nowUtc, timezone: tz })
      const providerName = provider.daycare_name || provider.full_name || 'your child care provider'

      // Fan out: families → parents → children → unacked segments.
      const families = await supabaseGet(
        `families?user_id=eq.${provider.id}&select=id`
      )
      if (!families.length) continue
      const familyIds = families.map(f => f.id)
      const familyList = familyIds.map(id => `"${id}"`).join(',')

      const parentLinks = await supabaseGet(
        `parent_family_links?family_id=in.(${familyList})&status=eq.active` +
        `&select=parent_id,family_id,parent_profiles(id,email,full_name,acknowledgment_email_opt_in)`
      )
      const children = await supabaseGet(
        `children?family_id=in.(${familyList})&select=id,family_id,first_name`
      )

      // Group children by family for per-parent fan-out.
      const childrenByFamily = new Map()
      for (const c of children) {
        const list = childrenByFamily.get(c.family_id) || []
        list.push(c)
        childrenByFamily.set(c.family_id, list)
      }

      // De-dupe parents (a parent may link to multiple families) and
      // aggregate their reachable kids.
      const parentToKids = new Map()  // parent_id → { profile, kids: [child rows] }
      for (const link of parentLinks) {
        const p = link.parent_profiles
        if (!p || !p.email) continue
        if (p.acknowledgment_email_opt_in === false) continue
        const kids = childrenByFamily.get(link.family_id) || []
        const entry = parentToKids.get(p.id) || { profile: p, kids: [] }
        for (const k of kids) if (!entry.kids.find(x => x.id === k.id)) entry.kids.push(k)
        parentToKids.set(p.id, entry)
      }

      for (const { profile: parent, kids } of parentToKids.values()) {
        if (!kids.length) {
          stats.digests_skipped_no_recipients += 1
          continue
        }
        const childIds = kids.map(k => k.id)
        const unacked = await getUnackedBilledSegmentsForChildren({
          childIds, startDate: start, endDate: end,
        })
        if (!unacked.length) {
          stats.digests_skipped_no_recipients += 1
          continue
        }

        const childFirstNames = kids
          .filter(k => unacked.some(u => u.child_id === k.id))
          .map(k => k.first_name)
        const parentFirstName = (parent.full_name || '').split(' ')[0] || ''
        const portalUrl =
          (process.env.PUBLIC_APP_URL || 'https://milittlecare.com') + '/parent/acknowledge'

        const { subject, text, html } = buildDigestEmail({
          providerName, parentFirstName, childFirstNames,
          weekStart: start, weekEnd: end, portalUrl,
        })

        // Send + one retry on 5xx (in-process; we never re-invoke the cron).
        let send = await sendViaResend({ to: parent.email, subject, html, text })
        if (!send.ok && send.status && send.status >= 500) {
          await new Promise(r => setTimeout(r, 5_000))  // brief backoff
          send = await sendViaResend({ to: parent.email, subject, html, text })
        }

        const summary = {
          provider_id: provider.id,
          child_first_names: childFirstNames,
          window_start: start, window_end: end,
          unacked_segment_count: unacked.length,
        }
        const status = send.ok
          ? 'sent'
          : (process.env.RESEND_API_KEY ? 'failed' : 'queued')

        await supabasePost('notification_log', {
          recipient_guardian_id: null,           // app-layer email→guardian match deferred
          recipient_email: parent.email,
          notification_type: 'acknowledgment_digest',
          sent_at: send.ok ? new Date().toISOString() : null,
          delivery_status: status,
          provider_message_id: send.providerMessageId || null,
          error_detail: send.errorDetail || null,
          payload_summary: summary,
        })

        if (send.ok) stats.digests_sent += 1
        else if (process.env.RESEND_API_KEY) stats.digests_failed += 1
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
