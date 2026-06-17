// Auditor Portal Phase 1 — read endpoint integration tests.
//
// THE ISOLATION INVARIANT is what these tests prove:
//   An auditor JWT bound to provider A's session NEVER returns
//   provider B's data, even when the request body claims a different
//   provider_id. Scope is read from the SESSION ROW, never from any
//   client-supplied value.
//
// Also covered:
//   - Provider JWT (non-auditor role) calling this endpoint → 401.
//   - No JWT → 401.
//   - Missing session_id → 400.
//   - Cross-auditor session URL (auditor X tries auditor Y's session
//     id) → 404 + denied log row with reason=out_of_scope.
//   - Revoked → 404 + denied log row with reason=revoked.
//   - Expired → 404 + denied log row with reason=expired.
//   - Rate limited → 429 + denied log row with reason=rate_limited.
//   - Successful read appends a 'read' log row.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from './auditor-read.js'

// ─── Fixtures ─────────────────────────────────────────────────────────

const PROVIDER_A_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROVIDER_B_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const AUDITOR_X_ID   = '11111111-1111-1111-1111-111111111111'
const AUDITOR_Y_ID   = '22222222-2222-2222-2222-222222222222'
const PROVIDER_JWT_A = 'jwt-provider-a'
const AUDITOR_JWT_X  = 'jwt-auditor-x'
const AUDITOR_JWT_Y  = 'jwt-auditor-y'

const SESSION_X_FOR_A   = 'sess-x-for-a'
const SESSION_Y_FOR_B   = 'sess-y-for-b'
const SESSION_REVOKED   = 'sess-revoked'
const SESSION_EXPIRED   = 'sess-expired'

const tomorrow  = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

let fetchCalls
let rateLimitedSessionIds

function bundleRowsForProvider(providerId) {
  if (providerId === PROVIDER_A_ID) {
    return {
      profile:                          [{ id: PROVIDER_A_ID, full_name: 'Provider A', daycare_name: 'Daycare A' }],
      children:                         [{ id: 'child-A1', user_id: PROVIDER_A_ID, first_name: 'Aiden' }],
      families:                         [],
      caregivers:                       [],
      staff_training_records:           [],
      acknowledgments:                  [{ id: 'ack-A1', provider_id: PROVIDER_A_ID }],
      consent_attachments:              [],
      medication_authorizations:        [],
      medication_administration_events: [],
      compliance_documents:             [],
      funding_sources:                  [],
      funding_documents:                [],
      intake_packets:                   [],
      business_policies:                [],
      business_hours:                   [],
      closures:                         [],
    }
  }
  if (providerId === PROVIDER_B_ID) {
    return {
      profile:                          [{ id: PROVIDER_B_ID, full_name: 'Provider B', daycare_name: 'Daycare B' }],
      children:                         [{ id: 'child-B1', user_id: PROVIDER_B_ID, first_name: 'Bea' }],
      families:                         [],
      caregivers:                       [],
      staff_training_records:           [],
      acknowledgments:                  [{ id: 'ack-B1', provider_id: PROVIDER_B_ID }],
      consent_attachments:              [],
      medication_authorizations:        [],
      medication_administration_events: [],
      compliance_documents:             [],
      funding_sources:                  [],
      funding_documents:                [],
      intake_packets:                   [],
      business_policies:                [],
      business_hours:                   [],
      closures:                         [],
    }
  }
  return null
}

function sessionRowForId(id) {
  if (id === SESSION_X_FOR_A) {
    return { id: SESSION_X_FOR_A, provider_id: PROVIDER_A_ID, auditor_user_id: AUDITOR_X_ID,
             starts_at: yesterday(), expires_at: tomorrow(), revoked_at: null,
             auditor_acknowledged_at: null }
  }
  if (id === SESSION_Y_FOR_B) {
    return { id: SESSION_Y_FOR_B, provider_id: PROVIDER_B_ID, auditor_user_id: AUDITOR_Y_ID,
             starts_at: yesterday(), expires_at: tomorrow(), revoked_at: null,
             auditor_acknowledged_at: null }
  }
  if (id === SESSION_REVOKED) {
    return { id: SESSION_REVOKED, provider_id: PROVIDER_A_ID, auditor_user_id: AUDITOR_X_ID,
             starts_at: yesterday(), expires_at: tomorrow(), revoked_at: yesterday(),
             auditor_acknowledged_at: null }
  }
  if (id === SESSION_EXPIRED) {
    return { id: SESSION_EXPIRED, provider_id: PROVIDER_A_ID, auditor_user_id: AUDITOR_X_ID,
             starts_at: yesterday(), expires_at: yesterday(), revoked_at: null,
             auditor_acknowledged_at: null }
  }
  return null
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function buildFetchMock() {
  return vi.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method || 'GET', body: init?.body || null })
    const u = new URL(url)

    if (u.pathname.endsWith('/auth/v1/user')) {
      const auth = init?.headers?.Authorization || init?.headers?.authorization
      if (auth === `Bearer ${PROVIDER_JWT_A}`) {
        return jsonResponse({ id: PROVIDER_A_ID, email: 'a@example.com', app_metadata: {} }, 200)
      }
      if (auth === `Bearer ${AUDITOR_JWT_X}`) {
        return jsonResponse({ id: AUDITOR_X_ID, email: 'x@miLEAP.gov', app_metadata: { role: 'auditor' } }, 200)
      }
      if (auth === `Bearer ${AUDITOR_JWT_Y}`) {
        return jsonResponse({ id: AUDITOR_Y_ID, email: 'y@miLEAP.gov', app_metadata: { role: 'auditor' } }, 200)
      }
      return new Response('{"error":"bad token"}', { status: 401 })
    }

    if (u.pathname.endsWith('/rest/v1/auditor_sessions')) {
      const idEq = u.searchParams.get('id')
      const id = idEq?.replace(/^eq\./, '')
      const row = sessionRowForId(id)
      return jsonResponse(row ? [row] : [], 200)
    }

    if (u.pathname.endsWith('/rest/v1/auditor_session_access_log')) {
      if (init?.method === 'POST') {
        return jsonResponse([{ id: 'log' }], 201)
      }
      const sidEq = u.searchParams.get('session_id')
      const sid = sidEq?.replace(/^eq\./, '')
      if (rateLimitedSessionIds.has(sid)) {
        return jsonResponse(Array.from({ length: 100 }, (_, i) => ({ id: `log-${i}` })), 200)
      }
      return jsonResponse([], 200)
    }

    const tableMatch = u.pathname.match(/\/rest\/v1\/(\w+)$/)
    if (tableMatch) {
      const table = tableMatch[1]
      const providerEq =
        u.searchParams.get('provider_id') ||
        u.searchParams.get('user_id') ||
        u.searchParams.get('licensee_id') ||
        u.searchParams.get('id')
      const pid = providerEq?.replace(/^eq\./, '')
      const bundle = bundleRowsForProvider(pid)
      if (!bundle) return jsonResponse([], 200)
      const key = table === 'profiles' ? 'profile' : table
      return jsonResponse(bundle[key] || [], 200)
    }

    return jsonResponse({ error: 'unhandled mock url ' + String(url) }, 500)
  })
}

let originalFetch
beforeEach(() => {
  fetchCalls = []
  rateLimitedSessionIds = new Set()
  process.env.SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  originalFetch = globalThis.fetch
  globalThis.fetch = buildFetchMock()
})
afterEach(() => { globalThis.fetch = originalFetch })

function postRead(body, jwt = AUDITOR_JWT_X) {
  return new Request('http://localhost/api/auditor-read', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

// ─── Gates ───────────────────────────────────────────────────────────

describe('auditor-read — gates', () => {
  it('GET → 405', async () => {
    const r = await handler(new Request('http://localhost/api/auditor-read'))
    expect(r.status).toBe(405)
  })
  it('no Bearer → 401', async () => {
    const r = await handler(postRead({ session_id: SESSION_X_FOR_A }, null))
    expect(r.status).toBe(401)
  })
  it('PROVIDER JWT (no auditor role) → 401 (role gate)', async () => {
    const r = await handler(postRead({ session_id: SESSION_X_FOR_A }, PROVIDER_JWT_A))
    expect(r.status).toBe(401)
    // No bundle fetch happened.
    const bundleCalls = fetchCalls.filter(c =>
      c.method === 'GET' && !c.url.includes('auditor_session') && !c.url.includes('/auth/')
    )
    expect(bundleCalls).toHaveLength(0)
  })
  it('400 on missing session_id', async () => {
    const r = await handler(postRead({}))
    expect(r.status).toBe(400)
  })
})

// ─── Cross-auditor session URL ───────────────────────────────────────

describe('auditor-read — auditor X cannot read auditor Y\'s session', () => {
  it('auditor X using session_id that belongs to auditor Y → 404 + denied log out_of_scope', async () => {
    const r = await handler(postRead({ session_id: SESSION_Y_FOR_B }, AUDITOR_JWT_X))
    expect(r.status).toBe(404)
    const logWrites = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logWrites).toHaveLength(1)
    const payload = JSON.parse(logWrites[0].body)
    expect(payload.event_kind).toBe('denied')
    expect(payload.denial_reason).toBe('out_of_scope')
  })
})

// ─── Revoke / expire ─────────────────────────────────────────────────

describe('auditor-read — revoked / expired denials', () => {
  it('revoked session → 404 + denied log revoked', async () => {
    const r = await handler(postRead({ session_id: SESSION_REVOKED }, AUDITOR_JWT_X))
    expect(r.status).toBe(404)
    const logWrites = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logWrites).toHaveLength(1)
    expect(JSON.parse(logWrites[0].body).denial_reason).toBe('revoked')
  })
  it('expired session → 404 + denied log expired', async () => {
    const r = await handler(postRead({ session_id: SESSION_EXPIRED }, AUDITOR_JWT_X))
    expect(r.status).toBe(404)
    const logWrites = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logWrites).toHaveLength(1)
    expect(JSON.parse(logWrites[0].body).denial_reason).toBe('expired')
  })
})

// ─── HAPPY PATH ──────────────────────────────────────────────────────

describe('auditor-read — happy path', () => {
  it('returns provider A\'s bundle for auditor X with session_X_for_A', async () => {
    const r = await handler(postRead({ session_id: SESSION_X_FOR_A }, AUDITOR_JWT_X))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.session.id).toBe(SESSION_X_FOR_A)
    expect(body.bundle.profile?.id).toBe(PROVIDER_A_ID)
    expect(body.bundle.profile?.daycare_name).toBe('Daycare A')
    // A 'read' log row was written.
    const reads = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    ).map(c => JSON.parse(c.body))
    expect(reads.filter(r => r.event_kind === 'read')).toHaveLength(1)
  })
})

// ─── THE ISOLATION INVARIANT ─────────────────────────────────────────

describe('auditor-read — THE ISOLATION INVARIANT (cross-provider)', () => {
  it('auditor X with provider A\'s session NEVER returns provider B data, even with malicious provider_id in body', async () => {
    const r = await handler(postRead({
      session_id: SESSION_X_FOR_A,
      provider_id: PROVIDER_B_ID,        // attacker override
      scope: { provider_id: PROVIDER_B_ID }, // additional malice
    }, AUDITOR_JWT_X))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.bundle.profile?.id).toBe(PROVIDER_A_ID)
    expect(body.bundle.profile?.id).not.toBe(PROVIDER_B_ID)
    expect(body.bundle.children.every(c => c.user_id === PROVIDER_A_ID)).toBe(true)
    expect(body.bundle.acknowledgments.every(a => a.provider_id === PROVIDER_A_ID)).toBe(true)
    // No supabase call mentioned provider B.
    const calls = fetchCalls.filter(c => c.url.includes(PROVIDER_B_ID))
    expect(calls).toHaveLength(0)
    // Every bundle fetch was scoped to A.
    const bundleFetches = fetchCalls.filter(c =>
      c.method === 'GET'
      && !c.url.includes('/auditor_sessions')
      && !c.url.includes('/auditor_session_access_log')
      && !c.url.includes('/auth/')
    )
    expect(bundleFetches.length).toBeGreaterThan(0)
    for (const c of bundleFetches) {
      expect(c.url).toContain(PROVIDER_A_ID)
    }
  })

  it('symmetric: auditor Y with provider B\'s session NEVER returns provider A data', async () => {
    const r = await handler(postRead({
      session_id: SESSION_Y_FOR_B,
      provider_id: PROVIDER_A_ID,
    }, AUDITOR_JWT_Y))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.bundle.profile?.id).toBe(PROVIDER_B_ID)
    expect(body.bundle.children.every(c => c.user_id === PROVIDER_B_ID)).toBe(true)
    const calls = fetchCalls.filter(c => c.url.includes(PROVIDER_A_ID))
    expect(calls).toHaveLength(0)
  })
})

// ─── Rate limit ──────────────────────────────────────────────────────

describe('auditor-read — rate limit', () => {
  it('429 + denied log rate_limited', async () => {
    rateLimitedSessionIds.add(SESSION_X_FOR_A)
    const r = await handler(postRead({ session_id: SESSION_X_FOR_A }, AUDITOR_JWT_X))
    expect(r.status).toBe(429)
    const logWrites = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logWrites).toHaveLength(1)
    expect(JSON.parse(logWrites[0].body).denial_reason).toBe('rate_limited')
  })
})

// ─── Log endpoint never emits UPDATE/DELETE ──────────────────────────

describe('auditor-read — log endpoint append-only contract', () => {
  it('no PATCH/PUT/DELETE to auditor_session_access_log', async () => {
    await handler(postRead({ session_id: SESSION_X_FOR_A }, AUDITOR_JWT_X))
    const mutations = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log')
      && ['PATCH', 'PUT', 'DELETE'].includes(c.method)
    )
    expect(mutations).toHaveLength(0)
  })
})
