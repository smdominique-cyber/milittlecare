// Auditor Portal Phase 1 — revoke endpoint.
//
// Authoritative design: docs/auditor-portal-auth-design.md § 4.2.
//
// Provider-JWT-authed. Sets revoked_at on an auditor_sessions row
// the provider owns. Logs session_revoked. If this revocation was
// the last active session for the auditor (no other non-revoked,
// non-expired sessions), the lifecycle cron will rotate the
// password on its next tick — we don't rotate here so revocation
// stays fast and idempotent.
//
// The session.provider_id check is "RLS-equivalent in code" — even
// if RLS were dropped, the function refuses to revoke a row whose
// provider_id doesn't match the JWT. RLS is the belt; this code is
// the suspenders.

export const config = { runtime: 'edge' }

// -----------------------------------------------------------------------------
// Shared helpers — mirror api/auditor-mint.js
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

const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' })
const NOT_FOUND_RESPONSE_INIT = { status: 404, headers: { 'Content-Type': 'application/json' } }

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
    // (1) Provider JWT.
    const provider = await verifyAuth(req.headers.get('authorization'))
    if (!provider || !provider.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (provider.app_metadata?.role === 'auditor') {
      // Auditor JWT cannot revoke any session.
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (2) Body.
    let body
    try { body = await req.json() } catch {
      return new Response(JSON.stringify({ error: 'Malformed request body' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    const sessionId = body?.session_id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return new Response(JSON.stringify({ error: 'session_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (3) Load + verify ownership. Anti-enumeration 404 if missing
    // OR if owned by a different provider.
    const sessResp = await supabaseRequest(
      `auditor_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,provider_id,revoked_at&limit=1`
    )
    if (!sessResp.ok) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }
    const rows = await sessResp.json().catch(() => null)
    const session = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (!session || session.provider_id !== provider.id) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }
    if (session.revoked_at) {
      // Already revoked — idempotent success.
      return new Response(JSON.stringify({ already_revoked: true, revoked_at: session.revoked_at }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (4) UPDATE the row.
    const now = new Date().toISOString()
    const updResp = await supabaseRequest(
      `auditor_sessions?id=eq.${encodeURIComponent(sessionId)}&provider_id=eq.${encodeURIComponent(provider.id)}`,
      'PATCH',
      { revoked_at: now, revoked_by_user_id: provider.id }
    )
    if (!updResp.ok) {
      const errBody = await updResp.text().catch(() => '')
      console.error('auditor-revoke: update failed', updResp.status, errBody)
      return new Response(JSON.stringify({ error: 'Could not revoke session' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (5) Log.
    await supabaseRequest('auditor_session_access_log', 'POST', {
      session_id: sessionId,
      event_kind: 'session_revoked',
      ip_address: req.headers.get('x-forwarded-for') || null,
      user_agent: req.headers.get('user-agent') || null,
    }).catch(() => {})

    return new Response(JSON.stringify({ revoked_at: now }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('auditor-revoke: unhandled error', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
