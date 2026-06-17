// Auditor Portal Phase 1 — the security boundary, REBUILT for the
// temp-account model.
//
// Authoritative design: docs/auditor-portal-auth-design.md § 3.
//
// This is the ONE positive data path for an auditor temp account.
// Everything else in the schema is sealed by the templated
// "auditor jwt denied" RESTRICTIVE policy added to every public
// table by migration 042. An auditor JWT calling PostgREST directly
// against any domain table gets zero rows; the only way they reach
// data is through this function.
//
// THE ISOLATION INVARIANT, enforced server-side:
//
//   An auditor JWT returns ONLY the data of the provider whose
//   auditor_sessions row points at this auditor (matched by
//   auditor_user_id = auth.uid()). The provider_id is resolved from
//   the SESSION ROW, NEVER from any client-supplied parameter.
//
// Boundary discipline (mirrors api/consent-attachment-url.js):
//   1. HTTP method gate (POST only).
//   2. Env presence gate.
//   3. Auth gate: verify Supabase JWT.
//   4. Role gate: JWT's app_metadata.role MUST be 'auditor'. (Any
//      other JWT is REJECTED — providers cannot accidentally hit
//      this endpoint with their own JWT and trigger the read path
//      with a session_id they don't own.)
//   5. Parse + shape-validate input.
//   6. Load auditor_sessions row.
//   7. Verify session.auditor_user_id = JWT.sub. Mismatch -> 404 +
//      denied log (covers "an auditor with multiple sessions tries
//      to read using another auditor's session URL").
//   8. Revocation + expiry checks. Either -> 404 + denied log.
//   9. Rate-limit (60 reads/minute/session) -> 429 + denied log.
//  10. Resolve provider_id FROM THE SESSION ROW.
//  11. Load the bundle, scoped to that provider_id.
//  12. Append 'read' log row.
//  13. Return { session: {...}, bundle: {...} }.
//
// Every deny path returns 404 with the same body. Status codes
// reserved: 400 (malformed body), 401 (missing/invalid JWT),
// 405 (non-POST), 429 (rate-limited), 500 (server config / unhandled).

export const config = { runtime: 'edge' }

const AUDITOR_ROLE          = 'auditor'
const RATE_LIMIT_PER_MINUTE = 60

const NOT_FOUND_BODY = JSON.stringify({ error: 'Not found' })
const NOT_FOUND_RESPONSE_INIT = { status: 404, headers: { 'Content-Type': 'application/json' } }

// -----------------------------------------------------------------------------
// Supabase REST helpers (service-role)
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

// -----------------------------------------------------------------------------
// Access log
// -----------------------------------------------------------------------------

async function appendAccessLog({ sessionId, eventKind, denialReason, resourceDescriptor, req }) {
  if (!sessionId) return
  const payload = {
    session_id: sessionId,
    event_kind: eventKind,
    denial_reason: denialReason || null,
    read_resource_descriptor: resourceDescriptor || null,
    ip_address: req.headers.get('x-forwarded-for') || null,
    user_agent: req.headers.get('user-agent') || null,
  }
  try {
    const resp = await supabaseRequest('auditor_session_access_log', 'POST', payload)
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      console.warn('auditor-read: access-log insert failed', resp.status, errBody)
    }
  } catch (err) {
    console.warn('auditor-read: access-log threw', err)
  }
}

// -----------------------------------------------------------------------------
// Rate limiter — count recent log rows for this session
// -----------------------------------------------------------------------------

async function isRateLimited(sessionId) {
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString()
  const resp = await supabaseRequest(
    `auditor_session_access_log?session_id=eq.${encodeURIComponent(sessionId)}&occurred_at=gte.${encodeURIComponent(cutoff)}&select=id`,
    'GET'
  )
  if (!resp.ok) return false   // fail open on counter outage; primary protection is the scope check
  const rows = await resp.json().catch(() => null)
  if (!Array.isArray(rows)) return false
  return rows.length >= RATE_LIMIT_PER_MINUTE
}

// -----------------------------------------------------------------------------
// Bundle — every read scoped by the resolved provider_id
// -----------------------------------------------------------------------------

async function loadBundleForProvider(providerId) {
  const pid = encodeURIComponent(providerId)

  const [
    profileResp,
    childrenResp,
    familiesResp,
    caregiversResp,
    trainingResp,
    acksResp,
    consentAttachmentsResp,
    medAuthsResp,
    medEventsResp,
    complianceDocsResp,
    fundingSourcesResp,
    fundingDocsResp,
    intakePacketsResp,
    businessPoliciesResp,
    businessHoursResp,
    closuresResp,
  ] = await Promise.all([
    supabaseRequest(`profiles?id=eq.${pid}&select=id,full_name,daycare_name,email,license_type,is_license_exempt,home_built_before_1978,firearms_on_premises`),
    supabaseRequest(`children?user_id=eq.${pid}&select=*`),
    supabaseRequest(`families?user_id=eq.${pid}&select=*`),
    supabaseRequest(`caregivers?licensee_id=eq.${pid}&select=id,full_name,email,date_of_hire,archived_at,created_at`),
    supabaseRequest(`staff_training_records?caregiver_id=in.(select id from caregivers where licensee_id=${pid})&select=*`),
    supabaseRequest(`acknowledgments?provider_id=eq.${pid}&archived_at=is.null&select=*&order=acknowledged_at.desc`),
    supabaseRequest(`consent_attachments?provider_id=eq.${pid}&archived_at=is.null&select=id,target_type,target_id,storage_path,original_filename,content_type,uploaded_at,retention_until,notes`),
    supabaseRequest(`medication_authorizations?provider_id=eq.${pid}&archived_at=is.null&select=*`),
    supabaseRequest(`medication_administration_events?provider_id=eq.${pid}&archived_at=is.null&select=*&order=administered_at.desc`),
    supabaseRequest(`compliance_documents?user_id=eq.${pid}&archived_at=is.null&select=*`),
    supabaseRequest(`funding_sources?user_id=eq.${pid}&select=*`),
    supabaseRequest(`funding_documents?user_id=eq.${pid}&select=*`),
    supabaseRequest(`intake_packets?provider_id=eq.${pid}&select=*`),
    supabaseRequest(`business_policies?user_id=eq.${pid}&select=*`),
    supabaseRequest(`business_hours?user_id=eq.${pid}&select=*`),
    supabaseRequest(`closures?user_id=eq.${pid}&select=*`),
  ])

  const responses = {
    profile: profileResp,
    children: childrenResp,
    families: familiesResp,
    caregivers: caregiversResp,
    staff_training_records: trainingResp,
    acknowledgments: acksResp,
    consent_attachments: consentAttachmentsResp,
    medication_authorizations: medAuthsResp,
    medication_administration_events: medEventsResp,
    compliance_documents: complianceDocsResp,
    funding_sources: fundingSourcesResp,
    funding_documents: fundingDocsResp,
    intake_packets: intakePacketsResp,
    business_policies: businessPoliciesResp,
    business_hours: businessHoursResp,
    closures: closuresResp,
  }
  for (const [name, resp] of Object.entries(responses)) {
    if (!resp.ok) {
      console.error('auditor-read: bundle fetch failed', name, resp.status)
      return null
    }
  }

  const bundle = {}
  for (const [name, resp] of Object.entries(responses)) {
    const rows = await resp.json().catch(() => null)
    if (!Array.isArray(rows)) {
      console.error('auditor-read: bundle parse failed', name)
      return null
    }
    bundle[name] = rows
  }
  bundle.profile = bundle.profile[0] || null
  return bundle
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
    // (1) Verify JWT.
    const auditor = await verifyAuth(req.headers.get('authorization'))
    if (!auditor || !auditor.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (2) Role gate. ONLY auditor JWTs reach the read path. A
    // provider/parent JWT hitting this endpoint is treated as
    // unauthorized — preserves the invariant "auditor reads are the
    // ONLY thing this endpoint does."
    const role = auditor.app_metadata?.role
    if (role !== AUDITOR_ROLE) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (3) Body — only session_id is read. Any malicious provider_id /
    // scope override is structurally ignored.
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

    // (4) Load the session row.
    const sessResp = await supabaseRequest(
      `auditor_sessions?id=eq.${encodeURIComponent(sessionId)}&select=id,provider_id,auditor_user_id,starts_at,expires_at,revoked_at,auditor_acknowledged_at&limit=1`
    )
    if (!sessResp.ok) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }
    const sessRows = await sessResp.json().catch(() => null)
    const session = Array.isArray(sessRows) && sessRows.length > 0 ? sessRows[0] : null
    if (!session) {
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (5) Binding check. The session must be for THIS auditor.
    // Mismatch covers the case where an auditor with credentials for
    // session A tries to read session B (e.g., session B belongs to
    // a different auditor account on the same email-domain, or the
    // URL was swapped). 404 + denied log.
    if (session.auditor_user_id !== auditor.id) {
      await appendAccessLog({
        sessionId: session.id,
        eventKind: 'denied',
        denialReason: 'out_of_scope',
        req,
      })
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (6) Revocation check.
    if (session.revoked_at) {
      await appendAccessLog({
        sessionId: session.id,
        eventKind: 'denied',
        denialReason: 'revoked',
        req,
      })
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (7) Expiry check.
    const nowMs = Date.now()
    const expiresAtMs = Date.parse(session.expires_at)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      await appendAccessLog({
        sessionId: session.id,
        eventKind: 'denied',
        denialReason: 'expired',
        req,
      })
      return new Response(NOT_FOUND_BODY, NOT_FOUND_RESPONSE_INIT)
    }

    // (8) Rate limit.
    if (await isRateLimited(session.id)) {
      await appendAccessLog({
        sessionId: session.id,
        eventKind: 'denied',
        denialReason: 'rate_limited',
        req,
      })
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (9) Resolve provider_id FROM THE ROW. THE isolation invariant.
    const providerId = session.provider_id

    // (10) Load the bundle.
    const bundle = await loadBundleForProvider(providerId)
    if (!bundle) {
      return new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      })
    }

    // (11) Append 'read' log row.
    await appendAccessLog({
      sessionId: session.id,
      eventKind: 'read',
      resourceDescriptor: { kind: 'bundle', whole_roster: true },
      req,
    })

    return new Response(
      JSON.stringify({
        session: {
          id: session.id,
          expires_at: session.expires_at,
          starts_at: session.starts_at,
          auditor_acknowledged_at: session.auditor_acknowledged_at,
        },
        bundle,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('auditor-read: unhandled error', err)
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}
