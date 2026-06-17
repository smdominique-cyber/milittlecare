// Auditor Portal Phase 1 — mint endpoint integration tests.
//
// The headline tests are:
//   - EMAIL-UNIQUENESS GATE blocks hijack of a parent/provider
//     account.
//   - provider_id in the request body is IGNORED (the inserted row
//     uses the JWT's auth.uid()).
//   - Auditor JWT cannot call this endpoint (no privilege
//     escalation).
//   - The temp password leaves the function ONCE in the response;
//     never persisted cleartext in the inserted rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from './auditor-mint.js'
import { characterizePassword } from '../src/lib/auditorPassword.js'

// ─── Fixtures ─────────────────────────────────────────────────────────

const PROVIDER_A_ID    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROVIDER_B_ID    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const VALID_JWT_A      = 'jwt-provider-a'
const VALID_JWT_B      = 'jwt-provider-b'
const AUDITOR_JWT_X    = 'jwt-auditor-x'
const EXISTING_AUDITOR_USER_ID = '11111111-1111-1111-1111-111111111111'
const EXISTING_PARENT_USER_ID  = '22222222-2222-2222-2222-222222222222'

// What the profiles table contains for the email-uniqueness gate.
let profilesByEmail
let createdAuthUsers   // tracks admin/createUser calls
let updatedAuthUsers   // tracks admin/updateUser (password rotation) calls
let insertedSessions
let logRowInserts
let nextNewUserId
// Whether the next session-insert should hit the unique-active
// partial-index error (23505 / auditor_sessions_active_unique_idx).
let nextSessionInsertReturns23505

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function buildFetchMock() {
  return vi.fn(async (url, init) => {
    const u = new URL(url)

    // /auth/v1/user — verifyAuth caller-id lookup.
    if (u.pathname.endsWith('/auth/v1/user')) {
      const auth = init?.headers?.Authorization || init?.headers?.authorization
      if (auth === `Bearer ${VALID_JWT_A}`) {
        return jsonResponse({ id: PROVIDER_A_ID, email: 'a@example.com', app_metadata: { role: undefined } }, 200)
      }
      if (auth === `Bearer ${VALID_JWT_B}`) {
        return jsonResponse({ id: PROVIDER_B_ID, email: 'b@example.com', app_metadata: { role: undefined } }, 200)
      }
      if (auth === `Bearer ${AUDITOR_JWT_X}`) {
        return jsonResponse({ id: EXISTING_AUDITOR_USER_ID, email: 'auditor@miLEAP.gov', app_metadata: { role: 'auditor' } }, 200)
      }
      return new Response('{"error":"bad token"}', { status: 401 })
    }

    // /auth/v1/admin/users (POST) — create new auditor.
    if (u.pathname.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
      const payload = JSON.parse(init.body)
      createdAuthUsers.push(payload)
      const id = nextNewUserId || '33333333-3333-3333-3333-333333333333'
      return jsonResponse({ id, email: payload.email, app_metadata: payload.app_metadata }, 200)
    }

    // /auth/v1/admin/users/<id> (PUT) — rotate password.
    if (u.pathname.includes('/auth/v1/admin/users/') && init?.method === 'PUT') {
      const id = u.pathname.split('/').pop()
      const payload = JSON.parse(init.body)
      updatedAuthUsers.push({ id, payload })
      return jsonResponse({ id, ...payload }, 200)
    }

    // /rest/v1/profiles?email=eq.X (GET) — email-uniqueness gate.
    if (u.pathname.endsWith('/rest/v1/profiles') && (init?.method === undefined || init.method === 'GET')) {
      const emailEq = u.searchParams.get('email')
      if (emailEq) {
        const email = emailEq.replace(/^eq\./, '')
        const row = profilesByEmail.get(email)
        return jsonResponse(row ? [row] : [], 200)
      }
      return jsonResponse([], 200)
    }

    // /rest/v1/profiles?id=eq.X (PATCH) — clear password_disabled_at on re-use.
    if (u.pathname.endsWith('/rest/v1/profiles') && init?.method === 'PATCH') {
      return jsonResponse([], 200)
    }

    // /rest/v1/auditor_sessions (POST) — insert session row.
    if (u.pathname.endsWith('/rest/v1/auditor_sessions') && init?.method === 'POST') {
      if (nextSessionInsertReturns23505) {
        nextSessionInsertReturns23505 = false
        return new Response(
          '{"code":"23505","message":"duplicate key value violates unique constraint \\"auditor_sessions_active_unique_idx\\""}',
          { status: 409 }
        )
      }
      const payload = JSON.parse(init.body)
      insertedSessions.push(payload)
      const id = `session-${insertedSessions.length}`
      return jsonResponse([{
        id,
        provider_id: payload.provider_id,
        auditor_user_id: payload.auditor_user_id,
        email_at_creation: payload.email_at_creation,
        starts_at: new Date().toISOString(),
        expires_at: payload.expires_at,
        revoked_at: null,
        auditor_label: payload.auditor_label || null,
        notes: payload.notes || null,
      }], 201)
    }

    // /rest/v1/auditor_session_access_log (POST) — log row insert.
    if (u.pathname.endsWith('/rest/v1/auditor_session_access_log') && init?.method === 'POST') {
      logRowInserts.push(JSON.parse(init.body))
      return jsonResponse([{ id: `log-${logRowInserts.length}` }], 201)
    }

    return jsonResponse({ error: 'unhandled mock url ' + String(url) }, 500)
  })
}

let originalFetch
beforeEach(() => {
  profilesByEmail = new Map()
  createdAuthUsers = []
  updatedAuthUsers = []
  insertedSessions = []
  logRowInserts = []
  nextNewUserId = null
  nextSessionInsertReturns23505 = false
  process.env.SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  originalFetch = globalThis.fetch
  globalThis.fetch = buildFetchMock()
})
afterEach(() => { globalThis.fetch = originalFetch })

function postMint(body, jwt = VALID_JWT_A) {
  return new Request('http://localhost/api/auditor-mint', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

// ─── Method + auth gates ─────────────────────────────────────────────

describe('auditor-mint — gates', () => {
  it('GET → 405', async () => {
    const r = await handler(new Request('http://localhost/api/auditor-mint'))
    expect(r.status).toBe(405)
  })
  it('unauthenticated POST → 401', async () => {
    const r = await handler(postMint({ email: 'a@b.gov' }, null))
    expect(r.status).toBe(401)
  })
  it('invalid Bearer → 401', async () => {
    const r = await handler(new Request('http://localhost/api/auditor-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer bogus' },
      body: '{}',
    }))
    expect(r.status).toBe(401)
  })
  it('auditor JWT CANNOT mint other auditor accounts → 401', async () => {
    // An auditor authenticating with their own JWT must not be able
    // to escalate to provider role and mint new audit accounts.
    const r = await handler(postMint({ email: 'second@miLEAP.gov' }, AUDITOR_JWT_X))
    expect(r.status).toBe(401)
    expect(createdAuthUsers).toHaveLength(0)
    expect(insertedSessions).toHaveLength(0)
  })
})

// ─── Body validation ─────────────────────────────────────────────────

describe('auditor-mint — body validation', () => {
  it('400 on missing email', async () => {
    const r = await handler(postMint({}))
    expect(r.status).toBe(400)
  })
  it('400 on malformed email', async () => {
    const r = await handler(postMint({ email: 'not-an-email' }))
    expect(r.status).toBe(400)
  })
  it('400 on expires_at exceeding 72h cap', async () => {
    const tooFar = new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString()
    const r = await handler(postMint({ email: 'a@b.gov', expires_at: tooFar }))
    expect(r.status).toBe(400)
    expect(createdAuthUsers).toHaveLength(0)
  })
  it('400 on past expires_at', async () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const r = await handler(postMint({ email: 'a@b.gov', expires_at: past }))
    expect(r.status).toBe(400)
  })
})

// ─── EMAIL-UNIQUENESS GATE — load-bearing safety ─────────────────────

describe('auditor-mint — EMAIL-UNIQUENESS GATE', () => {
  it('refuses when email belongs to a non-audit user (parent/provider)', async () => {
    profilesByEmail.set('parent@example.com', {
      id: EXISTING_PARENT_USER_ID,
      is_audit_account: false,
    })
    const r = await handler(postMint({ email: 'parent@example.com' }))
    expect(r.status).toBe(400)
    const body = await r.json()
    expect(body.code).toBe('email_in_use_by_non_audit_user')
    // The existing user was NOT touched.
    expect(createdAuthUsers).toHaveLength(0)
    expect(updatedAuthUsers).toHaveLength(0)
    expect(insertedSessions).toHaveLength(0)
  })

  it('reuses an existing AUDITOR profile and rotates the password (no new auth user created)', async () => {
    // profilesByEmail is keyed by the normalized (lowercased) email
    // since that's what classifyEmail() looks up.
    profilesByEmail.set('reuse@mileap.gov', {
      id: EXISTING_AUDITOR_USER_ID,
      is_audit_account: true,
    })
    const r = await handler(postMint({ email: 'reuse@miLEAP.gov' }))
    expect(r.status).toBe(200)
    expect(createdAuthUsers).toHaveLength(0)            // NOT created
    expect(updatedAuthUsers).toHaveLength(1)            // rotated
    expect(updatedAuthUsers[0].id).toBe(EXISTING_AUDITOR_USER_ID)
    expect(updatedAuthUsers[0].payload.password).toBeTruthy()
    const body = await r.json()
    expect(body.auditor_user_id).toBe(EXISTING_AUDITOR_USER_ID)
    expect(body.was_new_account).toBe(false)
  })

  it('creates a NEW auth user when no profile exists (sets app_metadata.role=auditor at creation)', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    const r = await handler(postMint({ email: 'fresh@miLEAP.gov' }))
    expect(r.status).toBe(200)
    expect(createdAuthUsers).toHaveLength(1)
    // Email was normalized to lowercase before being sent to admin.
    expect(createdAuthUsers[0].email).toBe('fresh@mileap.gov')
    expect(createdAuthUsers[0].app_metadata).toEqual({ role: 'auditor' })
    expect(createdAuthUsers[0].email_confirm).toBe(true)
    const body = await r.json()
    expect(body.was_new_account).toBe(true)
    expect(body.auditor_user_id).toBe(nextNewUserId)
  })
})

// ─── Provider-id is from JWT, NOT body ───────────────────────────────

describe('auditor-mint — provider_id comes from JWT, NEVER from the body', () => {
  it('ignores client-supplied provider_id and uses the authenticated provider', async () => {
    const r = await handler(postMint({
      email: 'fresh@miLEAP.gov',
      provider_id: PROVIDER_B_ID,        // attacker override
    }, VALID_JWT_A))
    expect(r.status).toBe(200)
    expect(insertedSessions).toHaveLength(1)
    expect(insertedSessions[0].provider_id).toBe(PROVIDER_A_ID)
    expect(insertedSessions[0].provider_id).not.toBe(PROVIDER_B_ID)
  })
})

// ─── Password discipline ─────────────────────────────────────────────

describe('auditor-mint — password discipline', () => {
  it('generated password meets the strength contract', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    const r = await handler(postMint({ email: 'fresh@miLEAP.gov' }))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(typeof body.temp_password).toBe('string')
    expect(characterizePassword(body.temp_password)).toEqual({ ok: true })
  })

  it('password is sent to admin createUser; cleartext is NEVER in the inserted session row or log row', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    const r = await handler(postMint({ email: 'fresh@miLEAP.gov' }))
    expect(r.status).toBe(200)
    const body = await r.json()
    const password = body.temp_password

    // Password was sent to admin API.
    expect(createdAuthUsers[0].password).toBe(password)
    // But NEVER appears in any auditor_sessions or access_log row.
    const sessJson = JSON.stringify(insertedSessions)
    const logJson = JSON.stringify(logRowInserts)
    expect(sessJson.includes(password)).toBe(false)
    expect(logJson.includes(password)).toBe(false)
  })

  it('two different auditor mints produce different passwords', async () => {
    nextNewUserId = '11111111-1111-1111-1111-111111111111'
    const r1 = await handler(postMint({ email: 'one@miLEAP.gov' }))
    const b1 = await r1.json()
    nextNewUserId = '22222222-2222-2222-2222-222222222222'
    const r2 = await handler(postMint({ email: 'two@miLEAP.gov' }))
    const b2 = await r2.json()
    expect(b1.temp_password).not.toBe(b2.temp_password)
  })
})

// ─── Active-session uniqueness ───────────────────────────────────────

describe('auditor-mint — unique active session per (auditor, provider)', () => {
  it('returns 409 when the DB unique-active partial index fires', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    nextSessionInsertReturns23505 = true
    const r = await handler(postMint({ email: 'dup@miLEAP.gov' }))
    expect(r.status).toBe(409)
    const body = await r.json()
    expect(body.code).toBe('active_session_exists')
  })
})

// ─── Log + return shape ──────────────────────────────────────────────

describe('auditor-mint — log and response shape', () => {
  it('emits a session_created log row', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    await handler(postMint({ email: 'fresh@miLEAP.gov' }))
    const createds = logRowInserts.filter(r => r.event_kind === 'session_created')
    expect(createds).toHaveLength(1)
  })

  it('returns email, temp_password, session_id, expires_at, auditor_user_id, was_new_account', async () => {
    nextNewUserId = '99999999-9999-9999-9999-999999999999'
    const r = await handler(postMint({ email: 'fresh@miLEAP.gov' }))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toHaveProperty('email')
    expect(body).toHaveProperty('temp_password')
    expect(body).toHaveProperty('session_id')
    expect(body).toHaveProperty('expires_at')
    expect(body).toHaveProperty('auditor_user_id')
    expect(body).toHaveProperty('was_new_account')
  })
})
