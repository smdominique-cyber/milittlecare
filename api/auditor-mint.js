// Auditor Portal Phase 1 — provider-side MINT endpoint (REBUILD).
//
// Authoritative design: docs/auditor-portal-auth-design.md § 2.
//
// This endpoint creates (or reuses) a temp Supabase auth account for
// an auditor's state email, generates a strong temp password,
// inserts an auditor_sessions row, and returns the one-time reveal.
//
// Replaces the Phase 1 HMAC mint. The HMAC token layer
// (src/lib/auditorTokens.js) is deleted in the same PR.
//
// THE EMAIL-UNIQUENESS GATE (load-bearing — design doc § 2.2 step 3):
//   - If a profiles row exists for the email AND is_audit_account =
//     false: refuse with 400, "use a different state email." NEVER
//     hijack a non-audit account.
//   - If a profiles row exists for the email AND is_audit_account =
//     true: reuse the auth.users id; rotate the password.
//   - If no profiles row exists: create a new auth.users via the
//     admin API with app_metadata.role = 'auditor'. The
//     handle_new_user trigger (migration 042) sets profiles.
//     is_audit_account = true off raw_app_meta_data.
//
// PROVIDER-ID IS NEVER FROM THE BODY. The auditor_sessions.provider_id
// is the validated JWT's auth.uid(). Any client-supplied provider_id
// in the body is structurally ignored — this is the isolation
// invariant's start.
//
// Required env vars:
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY

import { generateAuditorPassword } from '../src/lib/auditorPassword.js'

export const config = { runtime: 'edge' }

const MAX_EXPIRY_HOURS     = 72
const DEFAULT_EXPIRY_HOURS = 24
const AUDITOR_ROLE         = 'auditor'

// -----------------------------------------------------------------------------
// Supabase REST helpers (service-role) — match consent-attachment-url.js
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

// -----------------------------------------------------------------------------
// Input validation
// -----------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(s)) return null
  if (s.length > 254) return null
  return s
}

function resolveExpiresAt(rawExpiresAt) {
  const now = Date.now()
  const capMs = MAX_EXPIRY_HOURS * 60 * 60 * 1000
  if (rawExpiresAt === undefined || rawExpiresAt === null) {
    return { iso: new Date(now + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(), errorReason: null }
  }
  if (typeof rawExpiresAt !== 'string') {
    return { iso: null, errorReason: 'expires_at must be an ISO timestamp string' }
  }
  const t = Date.parse(rawExpiresAt)
  if (!Number.isFinite(t)) {
    return { iso: null, errorReason: 'expires_at could not be parsed as an ISO timestamp' }
  }
  if (t <= now) {
    return { iso: null, errorReason: 'expires_at must be in the future' }
  }
  if (t > now + capMs) {
    return { iso: null, errorReason: `expires_at exceeds the ${MAX_EXPIRY_HOURS}h cap` }
  }
  return { iso: new Date(t).toISOString(), errorReason: null }
}

// -----------------------------------------------------------------------------
// Email-uniqueness gate — the load-bearing safety
// -----------------------------------------------------------------------------

/**
 * Returns one of:
 *   - { kind: 'free' }                                      no profile exists
 *   - { kind: 'audit_account', authUserId }                 existing auditor profile
 *   - { kind: 'non_audit_account_blocking', authUserId }    refuse
 *
 * On REST error, returns { kind: 'error' } and the caller serves 500.
 */
async function classifyEmail(email) {
  const resp = await supabaseRequest(
    `profiles?email=eq.${encodeURIComponent(email)}&select=id,is_audit_account&limit=1`
  )
  if (!resp.ok) return { kind: 'error' }
  const rows = await resp.json().catch(() => null)
  if (!Array.isArray(rows)) return { kind: 'error' }
  if (rows.length === 0) return { kind: 'free' }
  const row = rows[0]
  if (row.is_audit_account === true) {
    return { kind: 'audit_account', authUserId: row.id }
  }
  return { kind: 'non_audit_account_blocking', authUserId: row.id }
}

// -----------------------------------------------------------------------------
// Auth admin operations
// -----------------------------------------------------------------------------

/**
 * Create a new auditor auth.users via admin API. Returns the new
 * user's id, or null on error.
 *
 * Sets app_metadata.role = 'auditor' at creation time so the
 * is_auditor_jwt() helper in mig 042 picks it up immediately — the
 * deny seal is active from the first JWT this user ever holds.
 * email_confirm:true skips email verification (the auditor doesn't
 * need to confirm; the provider verified the email out of band).
 */
async function adminCreateAuditorUser(email, password) {
  const resp = await supabaseAdmin('users', 'POST', {
    email,
    password,
    email_confirm: true,
    app_metadata: { role: AUDITOR_ROLE },
  })
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    console.error('auditor-mint: admin createUser failed', resp.status, errBody)
    return null
  }
  const body = await resp.json().catch(() => null)
  return body?.id || null
}

/**
 * Rotate the password on an existing auditor user via admin API.
 * Returns true on success.
 */
async function adminRotateAuditorPassword(userId, password) {
  const resp = await supabaseAdmin(`users/${encodeURIComponent(userId)}`, 'PUT', {
    password,
  })
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    console.error('auditor-mint: admin password rotation failed', resp.status, errBody)
    return false
  }
  return true
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

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
    // (1) JWT → provider's auth.uid().
    const provider = await verifyAuth(req.headers.get('authorization'))
    if (!provider || !provider.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }
    // Defense-in-depth: a JWT whose role IS already 'auditor' must
    // not be able to mint other auditor accounts. (Shouldn't happen
    // — auditors can't authenticate via the provider login UI — but
    // close the path here regardless.)
    const providerRole = provider.app_metadata?.role
    if (providerRole === AUDITOR_ROLE) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (2) Parse + validate request body.
    let body
    try { body = await req.json() } catch { body = {} }
    if (body && typeof body !== 'object') {
      return new Response(JSON.stringify({ error: 'Malformed request body' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const email = normalizeEmail(body?.email)
    if (!email) {
      return new Response(JSON.stringify({ error: 'email required (valid state email address)' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const { iso: expiresAtIso, errorReason } = resolveExpiresAt(body?.expires_at)
    if (errorReason) {
      return new Response(JSON.stringify({ error: errorReason }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const auditorLabel = (typeof body?.auditor_label === 'string' && body.auditor_label.trim().length > 0)
      ? body.auditor_label.trim().slice(0, 200)
      : null
    const notes = (typeof body?.notes === 'string' && body.notes.trim().length > 0)
      ? body.notes.trim().slice(0, 2000)
      : null

    // (3) EMAIL-UNIQUENESS GATE. The load-bearing safety.
    const classification = await classifyEmail(email)
    if (classification.kind === 'error') {
      return new Response(JSON.stringify({ error: 'Could not look up email' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (classification.kind === 'non_audit_account_blocking') {
      return new Response(JSON.stringify({
        error: 'This email is already in use by a non-audit user. Please use a different state email for this auditor.',
        code: 'email_in_use_by_non_audit_user',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // (4) Generate the strong temp password.
    const tempPassword = generateAuditorPassword((out) => globalThis.crypto.getRandomValues(out))

    // (5) Create or rotate the auth user. Either path ends with a
    // known auditorUserId and an up-to-date password.
    let auditorUserId
    if (classification.kind === 'free') {
      auditorUserId = await adminCreateAuditorUser(email, tempPassword)
      if (!auditorUserId) {
        return new Response(JSON.stringify({ error: 'Could not create auditor account' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
    } else {
      // existing audit account — rotate password + re-enable
      auditorUserId = classification.authUserId
      const ok = await adminRotateAuditorPassword(auditorUserId, tempPassword)
      if (!ok) {
        return new Response(JSON.stringify({ error: 'Could not rotate auditor password' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        })
      }
      // Clear password_disabled_at so the lifecycle cron doesn't re-
      // rotate this account immediately on its next tick.
      const clearResp = await supabaseRequest(
        `profiles?id=eq.${encodeURIComponent(auditorUserId)}`,
        'PATCH',
        { password_disabled_at: null }
      )
      if (!clearResp.ok) {
        console.warn('auditor-mint: could not clear password_disabled_at (non-fatal)')
      }
    }

    // (6) Insert auditor_sessions row. provider_id is from the JWT.
    // The partial unique index in mig 042 enforces "at most one
    // active session per (auditor_user_id, provider_id)" — if the
    // provider re-invites the same auditor while a prior session is
    // still active, the INSERT fails the unique constraint.
    const insertResp = await supabaseRequest(
      'auditor_sessions',
      'POST',
      {
        provider_id: provider.id,
        auditor_user_id: auditorUserId,
        email_at_creation: email,
        expires_at: expiresAtIso,
        auditor_label: auditorLabel,
        notes,
      }
    )
    if (!insertResp.ok) {
      const errBody = await insertResp.text().catch(() => '')
      console.error('auditor-mint: session insert failed', insertResp.status, errBody)
      // Try to detect the unique-active-session violation (Postgres
      // error code 23505 for unique_violation; the REST body usually
      // includes that code).
      if (errBody.includes('23505') || errBody.includes('auditor_sessions_active_unique_idx')) {
        // 2026-06-16 — message no longer says "wait for it to expire."
        // The DB unique index predicate is `revoked_at IS NULL` only
        // (Postgres 42P17 forbade now() in the predicate); expired
        // sessions still hold the slot until explicitly revoked.
        // The provider MUST revoke before re-minting.
        return new Response(JSON.stringify({
          error: 'This auditor already has an active or expired session for this provider. Revoke it first, then re-mint.',
          code: 'active_session_exists',
        }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'Could not create session' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }
    const insertRows = await insertResp.json().catch(() => null)
    const session = Array.isArray(insertRows) && insertRows.length > 0 ? insertRows[0] : null
    if (!session || !session.id) {
      return new Response(JSON.stringify({ error: 'Could not create session' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (7) Append session_created to the access log. Non-fatal.
    const logResp = await supabaseRequest(
      'auditor_session_access_log',
      'POST',
      {
        session_id: session.id,
        event_kind: 'session_created',
        ip_address: req.headers.get('x-forwarded-for') || null,
        user_agent: req.headers.get('user-agent') || null,
      }
    )
    if (!logResp.ok) {
      console.warn('auditor-mint: session_created log insert failed (non-fatal)')
    }

    // (8) One-time reveal. The temp_password leaves this function
    // ONCE and is never persisted cleartext server-side (Supabase
    // only stores the bcrypt hash via the admin API).
    return new Response(
      JSON.stringify({
        email,
        temp_password: tempPassword,
        session_id: session.id,
        expires_at: session.expires_at,
        auditor_user_id: auditorUserId,
        was_new_account: classification.kind === 'free',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('auditor-mint: unhandled error', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
