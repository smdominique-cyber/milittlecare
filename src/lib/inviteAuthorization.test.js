import { describe, it, expect } from 'vitest'
import { validateInvitationAccept } from './inviteAuthorization'

const A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' }
const invFor = (email) => ({ recipient_email: email })

describe('validateInvitationAccept', () => {
  describe('happy path', () => {
    it('allows when session email matches recipient_email exactly', () => {
      expect(
        validateInvitationAccept({ session: A, invitation: invFor('a@example.com') })
      ).toEqual({ ok: true })
    })

    it('matches case-insensitively', () => {
      expect(
        validateInvitationAccept({
          session: { id: A.id, email: 'Parent@Example.COM' },
          invitation: invFor('parent@example.com'),
        })
      ).toEqual({ ok: true })
    })

    it('matches with whitespace tolerance on both sides', () => {
      expect(
        validateInvitationAccept({
          session: { id: A.id, email: '  parent@example.com  ' },
          invitation: invFor('parent@example.com\n'),
        })
      ).toEqual({ ok: true })
    })
  })

  describe('rejects unauthenticated callers', () => {
    it('with 401 / auth_required when session is null', () => {
      const r = validateInvitationAccept({ session: null, invitation: invFor('a@example.com') })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.code).toBe('auth_required')
    })

    it('with 401 / auth_required when session is undefined', () => {
      const r = validateInvitationAccept({ invitation: invFor('a@example.com') })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.code).toBe('auth_required')
    })

    it('with 401 / auth_required when called with no args', () => {
      const r = validateInvitationAccept()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.code).toBe('auth_required')
    })
  })

  describe('rejects mismatched emails (the regression)', () => {
    it('with 403 / email_mismatch when session is A but invitation is for B', () => {
      const r = validateInvitationAccept({ session: A, invitation: invFor('b@example.com') })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(403)
      expect(r.code).toBe('email_mismatch')
    })

    it('error message names both the invitation recipient and the signed-in account', () => {
      const r = validateInvitationAccept({ session: A, invitation: invFor('b@example.com') })
      expect(r.error).toContain('b@example.com')
      expect(r.error).toContain('a@example.com')
    })
  })

  describe('rejects malformed input with explicit 400 / invalid_input', () => {
    it('when invitation has no recipient_email', () => {
      const r = validateInvitationAccept({ session: A, invitation: {} })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.code).toBe('invalid_input')
    })

    it('when invitation is null', () => {
      const r = validateInvitationAccept({ session: A, invitation: null })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.code).toBe('invalid_input')
    })

    it('when session has no email', () => {
      const r = validateInvitationAccept({
        session: { id: A.id, email: '' },
        invitation: invFor('a@example.com'),
      })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.code).toBe('invalid_input')
    })

    it('when session email is whitespace only', () => {
      const r = validateInvitationAccept({
        session: { id: A.id, email: '   ' },
        invitation: invFor('a@example.com'),
      })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(400)
      expect(r.code).toBe('invalid_input')
    })
  })
})
