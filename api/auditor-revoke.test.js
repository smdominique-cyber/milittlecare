// Auditor Portal Phase 1 — revoke endpoint tests.
//
// Coverage:
//   - Provider can revoke their own session.
//   - Provider cannot revoke another provider's session (404 anti-
//     enumeration; the row's provider_id mismatch is "RLS-
//     equivalent in code").
//   - Auditor JWT cannot revoke anything.
//   - Already-revoked = idempotent success.
//   - Revoke emits session_revoked log row.
//   - PATCH body only sets revoked_at + revoked_by_user_id; no
//     scope changes possible through this endpoint.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from './auditor-revoke.js'

const PROVIDER_A_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROVIDER_B_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const AUDITOR_X_ID    = '11111111-1111-1111-1111-111111111111'
const JWT_A = 'jwt-a'
const JWT_B = 'jwt-b'
const JWT_AUDITOR = 'jwt-aud'

const SESS_A_LIVE      = 'sess-a-live'
const SESS_A_REVOKED   = 'sess-a-already-revoked'
const SESS_B_LIVE      = 'sess-b-live'

let fetchCalls
let patches

function sessionRow(id) {
  if (id === SESS_A_LIVE)
    return { id, provider_id: PROVIDER_A_ID, revoked_at: null }
  if (id === SESS_A_REVOKED)
    return { id, provider_id: PROVIDER_A_ID, revoked_at: '2026-06-15T20:00:00Z' }
  if (id === SESS_B_LIVE)
    return { id, provider_id: PROVIDER_B_ID, revoked_at: null }
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
      if (auth === `Bearer ${JWT_A}`) return jsonResponse({ id: PROVIDER_A_ID, app_metadata: {} }, 200)
      if (auth === `Bearer ${JWT_B}`) return jsonResponse({ id: PROVIDER_B_ID, app_metadata: {} }, 200)
      if (auth === `Bearer ${JWT_AUDITOR}`)
        return jsonResponse({ id: AUDITOR_X_ID, app_metadata: { role: 'auditor' } }, 200)
      return new Response('{"e":"bad"}', { status: 401 })
    }
    if (u.pathname.endsWith('/rest/v1/auditor_sessions')) {
      if (init?.method === 'PATCH') {
        patches.push({ url: String(url), payload: JSON.parse(init.body) })
        return jsonResponse([], 200)
      }
      const idEq = u.searchParams.get('id')
      const id = idEq?.replace(/^eq\./, '')
      const row = sessionRow(id)
      return jsonResponse(row ? [row] : [], 200)
    }
    if (u.pathname.endsWith('/rest/v1/auditor_session_access_log')) {
      return jsonResponse([{ id: 'log' }], 201)
    }
    return jsonResponse({ error: 'unhandled ' + String(url) }, 500)
  })
}

let originalFetch
beforeEach(() => {
  fetchCalls = []
  patches = []
  process.env.SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk'
  originalFetch = globalThis.fetch
  globalThis.fetch = buildFetchMock()
})
afterEach(() => { globalThis.fetch = originalFetch })

function post(body, jwt) {
  return new Request('http://localhost/api/auditor-revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('auditor-revoke — gates', () => {
  it('405 on GET', async () => {
    const r = await handler(new Request('http://localhost/api/auditor-revoke'))
    expect(r.status).toBe(405)
  })
  it('401 without JWT', async () => {
    const r = await handler(post({ session_id: SESS_A_LIVE }, null))
    expect(r.status).toBe(401)
  })
  it('401 with auditor JWT', async () => {
    const r = await handler(post({ session_id: SESS_A_LIVE }, JWT_AUDITOR))
    expect(r.status).toBe(401)
    expect(patches).toHaveLength(0)
  })
  it('400 missing session_id', async () => {
    const r = await handler(post({}, JWT_A))
    expect(r.status).toBe(400)
  })
})

describe('auditor-revoke — provider boundary', () => {
  it('provider A CAN revoke their own session → 200, PATCH sets revoked_at', async () => {
    const r = await handler(post({ session_id: SESS_A_LIVE }, JWT_A))
    expect(r.status).toBe(200)
    expect(patches).toHaveLength(1)
    expect(patches[0].payload.revoked_at).toBeTruthy()
    expect(patches[0].payload.revoked_by_user_id).toBe(PROVIDER_A_ID)
    // Payload contains ONLY the revoke fields — no scope override.
    expect(Object.keys(patches[0].payload).sort()).toEqual(['revoked_at', 'revoked_by_user_id'])
  })

  it('provider B CANNOT revoke provider A\'s session → 404 (anti-enumeration)', async () => {
    const r = await handler(post({ session_id: SESS_A_LIVE }, JWT_B))
    expect(r.status).toBe(404)
    expect(patches).toHaveLength(0)
  })

  it('already-revoked session → 200 idempotent (no second PATCH)', async () => {
    const r = await handler(post({ session_id: SESS_A_REVOKED }, JWT_A))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.already_revoked).toBe(true)
    expect(patches).toHaveLength(0)
  })
})

describe('auditor-revoke — log', () => {
  it('emits a session_revoked log row', async () => {
    await handler(post({ session_id: SESS_A_LIVE }, JWT_A))
    const logs = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].body).event_kind).toBe('session_revoked')
  })
})
