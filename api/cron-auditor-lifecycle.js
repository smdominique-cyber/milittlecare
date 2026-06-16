// Auditor Portal Phase 1 — lifecycle cron (hourly).
//
// Authoritative design: docs/auditor-portal-auth-design.md § 4.3 +
// § 7 decision 2.
//
// What this does on each tick:
//   1. Find every auditor profile (profiles.is_audit_account = true)
//      whose password_disabled_at IS NULL — i.e., still able to log in.
//   2. For each, check whether ALL of their auditor_sessions rows are
//      either revoked (revoked_at IS NOT NULL) or expired
//      (expires_at <= now()).
//   3. If yes: rotate the auth.users password to a fresh
//      cryptographically-random value (NOT stored anywhere) AND set
//      profiles.password_disabled_at = now(). The account is then
//      unloggable; the row stays for audit retention.
//   4. Log one 'password_rotated' row per session that belonged to
//      the disabled account (so the provider's audit view shows the
//      lifecycle event for each session they minted).
//
// Idempotency: skips rows where password_disabled_at IS NOT NULL.
// The mint endpoint clears password_disabled_at when it re-uses an
// existing auditor account + rotates the password (re-enables it).
//
// Auth: same Bearer CRON_SECRET pattern the other crons use.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional env vars: CRON_SECRET (recommended; matches existing
// cron pattern).

import { generateAuditorPassword } from '../src/lib/auditorPassword.js'

export const config = { runtime: 'edge' }

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function supabaseRequest(path, method = 'GET', body) {
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

async function supabaseAdmin(path, method = 'GET', body) {
  const url = `${process.env.SUPABASE_URL}/auth/v1/admin/${path}`
  const resp = await fetch(url, {
    method,
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return resp
}

// -----------------------------------------------------------------------------
// Per-auditor lifecycle pass
// -----------------------------------------------------------------------------

/**
 * Returns true iff every auditor_sessions row for this auditor is
 * either revoked OR expired (at the time of the query).
 */
async function allSessionsTerminated(auditorUserId) {
  // PostgREST OR-of-AND syntax: not revoked AND not expired.
  const nowIso = new Date().toISOString()
  const resp = await supabaseRequest(
    `auditor_sessions?auditor_user_id=eq.${encodeURIComponent(auditorUserId)}&revoked_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}&select=id&limit=1`
  )
  if (!resp.ok) return false        // be cautious; don't disable on a probe failure
  const rows = await resp.json().catch(() => null)
  return Array.isArray(rows) && rows.length === 0
}

/**
 * Lists the auditor's session ids — used for logging
 * 'password_rotated' rows once we disable the password.
 */
async function listSessionsForAuditor(auditorUserId) {
  const resp = await supabaseRequest(
    `auditor_sessions?auditor_user_id=eq.${encodeURIComponent(auditorUserId)}&select=id`
  )
  if (!resp.ok) return []
  const rows = await resp.json().catch(() => null)
  return Array.isArray(rows) ? rows.map(r => r.id) : []
}

async function processOneAuditor(authUserId) {
  if (!await allSessionsTerminated(authUserId)) {
    return { skipped: 'has_active_session' }
  }

  // Generate a fresh unguessable password the auditor doesn't know.
  // We never return this anywhere; it goes straight into bcrypt via
  // the admin API and is discarded after the call returns.
  const newPassword = generateAuditorPassword((out) => globalThis.crypto.getRandomValues(out))
  const updateResp = await supabaseAdmin(
    `users/${encodeURIComponent(authUserId)}`,
    'PUT',
    { password: newPassword }
  )
  if (!updateResp.ok) {
    const errBody = await updateResp.text().catch(() => '')
    console.error('cron-auditor-lifecycle: password rotation failed for', authUserId, updateResp.status, errBody)
    return { error: 'rotation_failed' }
  }

  // Mark profile so we don't re-rotate on next tick.
  const markResp = await supabaseRequest(
    `profiles?id=eq.${encodeURIComponent(authUserId)}`,
    'PATCH',
    { password_disabled_at: new Date().toISOString() }
  )
  if (!markResp.ok) {
    console.warn('cron-auditor-lifecycle: failed to set password_disabled_at; the rotation already happened so next tick may rotate again (harmless)')
  }

  // Log a 'password_rotated' row for every session this auditor had,
  // so the provider sees the lifecycle event per-session.
  const sessionIds = await listSessionsForAuditor(authUserId)
  for (const sid of sessionIds) {
    await supabaseRequest('auditor_session_access_log', 'POST', {
      session_id: sid,
      event_kind: 'password_rotated',
    }).catch(() => {})
  }

  return { rotated: true, sessions: sessionIds.length }
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export default async function handler(req) {
  // Match the existing cron auth pattern (cron-dispatch-reminders.js).
  const auth = req.headers.get('authorization')
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // Page over the candidate auditor profiles (defensive against
    // future fan-out — for the foreseeable future this is a handful
    // of rows; the page size 200 keeps the query trivially cheap).
    const resp = await supabaseRequest(
      `profiles?is_audit_account=is.true&password_disabled_at=is.null&select=id,email&limit=200`
    )
    if (!resp.ok) {
      console.error('cron-auditor-lifecycle: candidate fetch failed', resp.status)
      return new Response(JSON.stringify({ error: 'fetch_failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }
    const candidates = await resp.json().catch(() => null)
    if (!Array.isArray(candidates)) {
      return new Response(JSON.stringify({ error: 'parse_failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    const results = { examined: candidates.length, rotated: 0, skipped: 0, errors: 0 }
    for (const cand of candidates) {
      const r = await processOneAuditor(cand.id)
      if (r.rotated) results.rotated += 1
      else if (r.error) results.errors += 1
      else results.skipped += 1
    }

    return new Response(JSON.stringify(results), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('cron-auditor-lifecycle: unhandled error', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

// Exported for tests.
export const _internals_for_test = {
  processOneAuditor,
  allSessionsTerminated,
  listSessionsForAuditor,
}
