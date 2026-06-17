// Auditor Portal Phase 1 — lifecycle cron tests.
//
// Coverage:
//   - CRON_SECRET enforcement.
//   - Skips auditors with at least one active (non-revoked,
//     non-expired) session.
//   - Rotates password + sets password_disabled_at when ALL sessions
//     are terminated.
//   - Emits 'password_rotated' log row per session.
//   - Skips already-disabled accounts (idempotent).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from './cron-auditor-lifecycle.js'
import { characterizePassword } from '../src/lib/auditorPassword.js'

const AUDITOR_X = '11111111-1111-1111-1111-111111111111'   // all sessions terminated
const AUDITOR_Y = '22222222-2222-2222-2222-222222222222'   // has an active session

let fetchCalls
let candidateProfiles
let activeSessionsByAuditor
let allSessionsByAuditor
let updatedAuthUsers
let profilePatches

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function buildFetchMock() {
  return vi.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method || 'GET', body: init?.body || null })
    const u = new URL(url)

    const method = init?.method || 'GET'

    // Candidate fetch: profiles?is_audit_account=is.true&password_disabled_at=is.null
    if (u.pathname.endsWith('/rest/v1/profiles') && method === 'GET') {
      if (u.searchParams.get('is_audit_account') === 'is.true') {
        return jsonResponse(candidateProfiles, 200)
      }
    }

    // Active-session check: auditor_sessions?auditor_user_id=eq.<id>&revoked_at=is.null&expires_at=gt.<iso>&limit=1
    if (u.pathname.endsWith('/rest/v1/auditor_sessions') && method === 'GET') {
      const auidEq = u.searchParams.get('auditor_user_id')
      const auid = auidEq?.replace(/^eq\./, '')
      const revokedFilter = u.searchParams.get('revoked_at')
      const expiresFilter = u.searchParams.get('expires_at')
      // The "active session probe" carries both filters.
      if (revokedFilter === 'is.null' && expiresFilter?.startsWith('gt.')) {
        const active = activeSessionsByAuditor.get(auid) || []
        return jsonResponse(active.slice(0, 1), 200)
      }
      // The "list all sessions" call (for logging).
      return jsonResponse(allSessionsByAuditor.get(auid) || [], 200)
    }

    // PATCH profiles?id=eq.<id> — mark password_disabled_at.
    if (u.pathname.endsWith('/rest/v1/profiles') && init?.method === 'PATCH') {
      profilePatches.push({ url: String(url), payload: JSON.parse(init.body) })
      return jsonResponse([], 200)
    }

    // PUT /auth/v1/admin/users/<id> — rotate password.
    if (u.pathname.includes('/auth/v1/admin/users/') && init?.method === 'PUT') {
      const id = u.pathname.split('/').pop()
      updatedAuthUsers.push({ id, payload: JSON.parse(init.body) })
      return jsonResponse({ id }, 200)
    }

    // POST /rest/v1/auditor_session_access_log
    if (u.pathname.endsWith('/rest/v1/auditor_session_access_log') && init?.method === 'POST') {
      return jsonResponse([{ id: 'log' }], 201)
    }

    return jsonResponse({ error: 'unhandled ' + String(url) }, 500)
  })
}

let originalFetch
beforeEach(() => {
  fetchCalls = []
  updatedAuthUsers = []
  profilePatches = []
  candidateProfiles = []
  activeSessionsByAuditor = new Map()
  allSessionsByAuditor = new Map()
  process.env.SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk'
  originalFetch = globalThis.fetch
  globalThis.fetch = buildFetchMock()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.CRON_SECRET
})

function callCron(secret) {
  return new Request('http://localhost/api/cron-auditor-lifecycle', {
    method: 'GET',
    headers: secret ? { 'Authorization': `Bearer ${secret}` } : {},
  })
}

describe('cron-auditor-lifecycle — auth', () => {
  it('CRON_SECRET set + wrong Bearer → 401', async () => {
    process.env.CRON_SECRET = 'shh'
    const r = await handler(callCron('wrong'))
    expect(r.status).toBe(401)
  })
  it('CRON_SECRET unset → runs', async () => {
    candidateProfiles = []
    const r = await handler(callCron())
    expect(r.status).toBe(200)
  })
})

describe('cron-auditor-lifecycle — per-auditor lifecycle pass', () => {
  it('skips an auditor with an active session', async () => {
    candidateProfiles = [{ id: AUDITOR_Y, email: 'y@miLEAP.gov' }]
    activeSessionsByAuditor.set(AUDITOR_Y, [{ id: 'live-1' }])
    const r = await handler(callCron())
    expect(r.status).toBe(200)
    const summary = await r.json()
    expect(summary).toMatchObject({ examined: 1, rotated: 0, skipped: 1, errors: 0 })
    expect(updatedAuthUsers).toHaveLength(0)
  })

  it('rotates password + sets password_disabled_at when all sessions are terminated', async () => {
    candidateProfiles = [{ id: AUDITOR_X, email: 'x@miLEAP.gov' }]
    activeSessionsByAuditor.set(AUDITOR_X, [])
    allSessionsByAuditor.set(AUDITOR_X, [
      { id: 'sess-1' }, { id: 'sess-2' },
    ])
    const r = await handler(callCron())
    expect(r.status).toBe(200)
    const summary = await r.json()
    expect(summary).toMatchObject({ examined: 1, rotated: 1, skipped: 0, errors: 0 })
    // Password actually rotated.
    expect(updatedAuthUsers).toHaveLength(1)
    expect(updatedAuthUsers[0].id).toBe(AUDITOR_X)
    expect(characterizePassword(updatedAuthUsers[0].payload.password)).toEqual({ ok: true })
    // Profile marked disabled.
    expect(profilePatches).toHaveLength(1)
    expect(profilePatches[0].payload.password_disabled_at).toBeTruthy()
    // password_rotated log written for every session this auditor had.
    const logWrites = fetchCalls.filter(c =>
      c.url.includes('/rest/v1/auditor_session_access_log') && c.method === 'POST'
    )
    expect(logWrites).toHaveLength(2)
    for (const lw of logWrites) {
      expect(JSON.parse(lw.body).event_kind).toBe('password_rotated')
    }
  })

  it('candidates list filters out already-disabled accounts (the cron only fetches password_disabled_at=is.null)', async () => {
    // The candidate fetch in handler uses password_disabled_at=is.null.
    // Even if we add AUDITOR_Z to the candidates, that's a mock; the
    // production query would filter it out. Verify the query string
    // carries the filter.
    candidateProfiles = []
    await handler(callCron())
    const candFetch = fetchCalls.find(c => c.url.includes('/rest/v1/profiles?'))
    expect(candFetch.url).toContain('password_disabled_at=is.null')
    expect(candFetch.url).toContain('is_audit_account=is.true')
  })
})
