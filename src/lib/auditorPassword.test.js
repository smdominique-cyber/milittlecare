// Auditor Portal Phase 1 — password generator tests.
//
// What this pins:
//   - Output length = 20.
//   - Every output character is in the 70-char alphabet.
//   - Rejection-sampling: bytes >= 210 are skipped (not modulo'd
//     into a biased distribution).
//   - When the random source runs out mid-generation, the function
//     re-fills (no out-of-bounds error).
//   - Statistical sanity: 1000 passwords yield diverse characters
//     across the alphabet (not all the same letter).

import { describe, it, expect } from 'vitest'
import {
  PASSWORD_LENGTH,
  ALPHABET_SIZE,
  generateAuditorPassword,
  characterizePassword,
} from './auditorPassword'

const ALPHABET =
  'abcdefghijklmnopqrstuvwxyz'
  + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  + '0123456789'
  + '!@#$%^&*'

function fillFromArray(seq) {
  // Returns a fillRandom function that walks `seq` from the start.
  // Throws if the caller asks for more bytes than provided.
  let next = 0
  return (out) => {
    for (let i = 0; i < out.length; i += 1) {
      if (next >= seq.length) {
        throw new Error('fillFromArray: out of bytes')
      }
      out[i] = seq[next]
      next += 1
    }
    return out
  }
}

function realFillRandom(out) {
  globalThis.crypto.getRandomValues(out)
  return out
}

describe('generateAuditorPassword — basic shape', () => {
  it('returns a string of length PASSWORD_LENGTH', () => {
    const pw = generateAuditorPassword(realFillRandom)
    expect(typeof pw).toBe('string')
    expect(pw).toHaveLength(PASSWORD_LENGTH)
  })

  it('PASSWORD_LENGTH is 20 and ALPHABET_SIZE is 70 (entropy ≈ 123 bits)', () => {
    expect(PASSWORD_LENGTH).toBe(20)
    expect(ALPHABET_SIZE).toBe(70)
  })

  it('every character lands in the 70-char alphabet', () => {
    for (let i = 0; i < 100; i += 1) {
      const pw = generateAuditorPassword(realFillRandom)
      expect(characterizePassword(pw)).toEqual({ ok: true })
    }
  })
})

describe('generateAuditorPassword — rejection sampling', () => {
  it('skips bytes >= 210 instead of producing biased output', () => {
    // Mostly-rejected bytes (each 250 → reject), with valid bytes
    // interleaved. The output should equal the valid bytes mapped
    // into the alphabet, in order.
    //
    // Build a sequence: [250, 0, 250, 1, 250, 2, …] until we have 20
    // valid bytes (0..19). Each valid byte b maps to ALPHABET[b%70].
    const seq = []
    for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
      seq.push(250)        // rejected
      seq.push(i)          // valid → ALPHABET[i]
    }
    // Pad with extras in case the function over-reads.
    while (seq.length < PASSWORD_LENGTH * 6) seq.push(0)
    const pw = generateAuditorPassword(fillFromArray(seq))
    let expected = ''
    for (let i = 0; i < PASSWORD_LENGTH; i += 1) expected += ALPHABET.charAt(i)
    expect(pw).toBe(expected)
  })

  it('handles a stream that runs out by re-filling', () => {
    // First batch is exactly PASSWORD_LENGTH * 1.5 (the initial buf
    // size used inside the function). Make every byte invalid so the
    // first buffer is fully consumed without producing any output,
    // forcing a re-fill.
    const firstBatch = Array(Math.ceil(PASSWORD_LENGTH * 1.5)).fill(250)
    const secondBatch = []
    for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
      secondBatch.push(i)             // valid → ALPHABET[i]
    }
    // Pad second batch in case the function over-reads (it generally
    // does because it fills bufSize again, even if we only need
    // PASSWORD_LENGTH).
    while (secondBatch.length < Math.ceil(PASSWORD_LENGTH * 1.5)) {
      secondBatch.push(0)
    }
    const seq = [...firstBatch, ...secondBatch]
    const pw = generateAuditorPassword(fillFromArray(seq))
    let expected = ''
    for (let i = 0; i < PASSWORD_LENGTH; i += 1) expected += ALPHABET.charAt(i)
    expect(pw).toBe(expected)
  })
})

describe('generateAuditorPassword — statistical sanity', () => {
  it('1000 passwords use a wide spread of the alphabet (not stuck on one char)', () => {
    const counts = new Map()
    for (let i = 0; i < 1000; i += 1) {
      const pw = generateAuditorPassword(realFillRandom)
      for (const c of pw) {
        counts.set(c, (counts.get(c) || 0) + 1)
      }
    }
    // 1000 passwords × 20 chars = 20000 chars. With 70 alphabet
    // size, expected ~286 per char. Demand at least 50 distinct
    // characters appeared — a very loose bound that would catch any
    // gross alphabet/sampling bug without being flaky.
    expect(counts.size).toBeGreaterThanOrEqual(50)
  })

  it('two consecutive calls produce different passwords (almost-certainly)', () => {
    const a = generateAuditorPassword(realFillRandom)
    const b = generateAuditorPassword(realFillRandom)
    expect(a).not.toBe(b)
  })
})

describe('generateAuditorPassword — input validation', () => {
  it('throws when fillRandom is not a function', () => {
    expect(() => generateAuditorPassword(null)).toThrow()
    expect(() => generateAuditorPassword(undefined)).toThrow()
    expect(() => generateAuditorPassword('not a function')).toThrow()
  })
})

describe('characterizePassword — test helper', () => {
  it('accepts a 20-char alphabet string', () => {
    expect(characterizePassword('aaaaaaaaaaaaaaaaaaaa')).toEqual({ ok: true })
  })
  it('rejects wrong length', () => {
    expect(characterizePassword('short')).toEqual({ ok: false, reason: 'wrong length' })
  })
  it('rejects out-of-alphabet characters', () => {
    const bad = 'aaaaaaaaaaaaaaaaaaaa'.split('')
    bad[5] = ' '
    expect(characterizePassword(bad.join(''))).toMatchObject({ ok: false })
  })
  it('rejects non-strings', () => {
    expect(characterizePassword(null)).toMatchObject({ ok: false })
    expect(characterizePassword(123)).toMatchObject({ ok: false })
  })
})
