// Auditor Portal Phase 1 — strong temp password generation.
//
// Authoritative design: docs/auditor-portal-auth-design.md § 2.3 +
// § 7 decision 3 (20 chars; alnum + 8 keyboard-friendly punctuation).
//
// Pure module: takes a randomBytes() function as input so vitest can
// inject deterministic bytes for testing. Production caller passes
// `globalThis.crypto.getRandomValues` (Web Crypto API, available in
// Vercel Edge runtime + Node 16+).
//
// The cleartext password produced here is the ONLY cleartext
// representation that ever exists server-side. It is:
//   - generated in the Edge Function (api/auditor-mint.js),
//   - sent to Supabase via /auth/v1/admin/users to set the bcrypt
//     hash on the auth.users row,
//   - returned to the provider's authenticated browser in the mint
//     response (one-time reveal),
//   - then dropped — never logged, never persisted.

// 70-character alphabet (~6.13 bits per char × 20 chars = ~122.6 bits
// of entropy). Punctuation subset chosen to be:
//   - Visually unambiguous (no `|`, `'`, `"`, `` ` ``, `\`, `/`).
//   - Shell-safe to copy/paste (no glob chars beyond `*`, no quote
//     chars).
//   - Common on US-international keyboards so the auditor doesn't
//     hit a key they can't find.
const ALPHABET =
  'abcdefghijklmnopqrstuvwxyz'      // 26
  + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'    // 26
  + '0123456789'                    // 10
  + '!@#$%^&*'                      // 8
  // total 70

export const PASSWORD_LENGTH = 20
export const ALPHABET_SIZE = ALPHABET.length

/**
 * Generate a strong temp password.
 *
 * @param {(out: Uint8Array) => Uint8Array} fillRandom
 *   Function that fills the passed Uint8Array with cryptographically
 *   secure random bytes and returns it. In production this is
 *   `globalThis.crypto.getRandomValues`; in tests it's a stub that
 *   returns a fixed sequence.
 *
 *   Rejection-sampling note: 256 % 70 = 46, so bytes >= 256 - 46 =
 *   210 would bias the distribution if used directly. We reject and
 *   re-roll those bytes. With 20 output chars + ~18% rejection rate,
 *   the expected initial draw is ~24 bytes; we pad with extra to
 *   amortize re-rolls.
 *
 * @returns {string} the cleartext password, length PASSWORD_LENGTH.
 */
export function generateAuditorPassword(fillRandom) {
  if (typeof fillRandom !== 'function') {
    throw new Error('generateAuditorPassword: fillRandom must be a function')
  }
  // 256 // 70 = 3 complete rounds; valid byte range is [0, 3*70) = [0, 210).
  const REJECT_AT = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE  // 210

  const out = []
  // Initial draw plus 50% headroom for the ~18% rejection rate, so a
  // single fillRandom() typically suffices.
  let bufSize = Math.ceil(PASSWORD_LENGTH * 1.5)
  let buf = new Uint8Array(bufSize)
  fillRandom(buf)
  let pos = 0

  while (out.length < PASSWORD_LENGTH) {
    if (pos >= buf.length) {
      // Ran out of random bytes — re-fill.
      buf = new Uint8Array(bufSize)
      fillRandom(buf)
      pos = 0
    }
    const b = buf[pos]
    pos += 1
    if (b >= REJECT_AT) continue
    out.push(ALPHABET.charAt(b % ALPHABET_SIZE))
  }
  return out.join('')
}

/**
 * Quick characterization of a generated password — used by the mint
 * test to assert "the output is in the alphabet, has the right
 * length, etc." Not part of the production code path; exported for
 * tests.
 */
export function characterizePassword(password) {
  if (typeof password !== 'string') return { ok: false, reason: 'not a string' }
  if (password.length !== PASSWORD_LENGTH) return { ok: false, reason: 'wrong length' }
  for (let i = 0; i < password.length; i += 1) {
    if (ALPHABET.indexOf(password.charAt(i)) < 0) {
      return { ok: false, reason: `char out of alphabet at position ${i}: ${JSON.stringify(password.charAt(i))}` }
    }
  }
  return { ok: true }
}
