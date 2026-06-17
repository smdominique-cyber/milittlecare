// 2026-06-17 — pins the absence of dev-reference leakage in every
// provider-visible reminder description.
//
// The descriptions render directly into RemindersSettingsPage.jsx as
// inline help under each toggle. Internal build artifacts ("PR #16",
// "scope § B.4") were leaking into that surface; this test catches
// the leak class as a category, not just the three specific
// descriptions that were rewritten in this PR.
//
// What's intentionally NOT asserted-absent:
//   - "R 400.xxxx" rule citations are provider-useful and stay.
//   - Internal helper / column names ("getDoseLogState", "miregistry
//     _training_entries where source = annual_ongoing") are out of
//     scope for THIS PR per the user directive — only "PR #" / "§" /
//     "scope §" patterns are. A follow-up could broaden the pattern;
//     for now we pin only what was asked.

import { describe, it, expect } from 'vitest'
import {
  REMINDER_CATEGORIES,
  categoriesForLicenseType,
  isKnownCategory,
} from './reminderCategories'

// ─── Leak-class regression ───────────────────────────────────────────

describe('REMINDER_CATEGORIES — no dev-reference leakage in provider-visible descriptions', () => {
  // The leak patterns recorded by the user 2026-06-17:
  //   - "PR #<N>"    — internal pull-request number
  //   - "§"          — internal scope-doc section marker
  //   - "scope §"    — explicit scope-doc reference
  const LEAK_PATTERNS = [
    { name: 'PR #<N>',        re: /PR #\d+/ },
    { name: '§ section mark', re: /§/ },
    { name: 'scope §',        re: /scope §/i },
  ]

  for (const [key, entry] of Object.entries(REMINDER_CATEGORIES)) {
    const description = entry?.description
    if (typeof description !== 'string') continue
    for (const { name, re } of LEAK_PATTERNS) {
      it(`${key}.description does NOT contain "${name}" (provider-visible leak class)`, () => {
        expect(description, `${key}.description leaks "${name}":\n${description}`).not.toMatch(re)
      })
    }
  }
})

// ─── Spot-check the three rewritten descriptions ─────────────────────
//
// Each rewritten description should read in plain provider language —
// not just absent the leak markers, but actually describing what the
// reminder does. Spot-check the load-bearing phrases so a future copy
// editor knows what the description is required to convey.

describe('REMINDER_CATEGORIES — three rewritten descriptions read in provider language', () => {
  it('intake_acknowledgment_pending: mentions parent + acknowledgment + the "fires when sent, clears when confirmed" lifecycle', () => {
    const d = REMINDER_CATEGORIES.intake_acknowledgment_pending.description
    expect(d).toMatch(/parent/i)
    expect(d).toMatch(/acknowledgment/i)
    expect(d).toMatch(/clears/i)
    expect(d).toMatch(/confirm/i)
  })

  it('staff_discipline_policy_ack_pending: keeps the R 400.xxxx citations and explains the "stale on policy update" mechanic in plain words', () => {
    const d = REMINDER_CATEGORIES.staff_discipline_policy_ack_pending.description
    expect(d).toMatch(/R 400\.1906/)
    expect(d).toMatch(/R 400\.1942/)
    // The "stale when policy version bumps" mechanic in provider terms.
    expect(d).toMatch(/policy/i)
    expect(d).toMatch(/stale|re-acknowledge/i)
    // No internal build references.
    expect(d).not.toMatch(/PR #|§|scope §/)
  })

  it('physician_attestation_expiration: keeps R 400.1933 + states "annual" + frames the lead as "configured number of days"', () => {
    const d = REMINDER_CATEGORIES.physician_attestation_expiration.description
    expect(d).toMatch(/R 400\.1933/)
    expect(d).toMatch(/annual|each year|every year/i)
    // Not "PR #18 contributes...".
    expect(d).not.toMatch(/PR #/)
  })
})

// ─── Catalog integrity — sanity-check the rewrites didn't break shape ─

describe('REMINDER_CATEGORIES — shape integrity (rewrite did not drop required fields)', () => {
  for (const [key, entry] of Object.entries(REMINDER_CATEGORIES)) {
    it(`${key} carries the required catalog shape`, () => {
      expect(typeof entry.key).toBe('string')
      expect(entry.key).toBe(key)
      expect(typeof entry.label).toBe('string')
      expect(typeof entry.description).toBe('string')
      expect(entry.description.length).toBeGreaterThan(40)  // not accidentally truncated
      expect(typeof entry.default_lead_time_days).toBe('number')
      expect(Array.isArray(entry.license_type_gating)).toBe(true)
      expect(entry.license_type_gating.length).toBeGreaterThan(0)
    })
  }

  it('isKnownCategory + categoriesForLicenseType still resolve every category through the catalog', () => {
    for (const key of Object.keys(REMINDER_CATEGORIES)) {
      expect(isKnownCategory(key)).toBe(true)
    }
    // Every category lands in exactly one of the three license-type
    // buckets the settings page filters by.
    const familyHomeKeys = new Set(categoriesForLicenseType('family_home').map(c => c.key))
    const groupHomeKeys  = new Set(categoriesForLicenseType('group_home').map(c => c.key))
    const lepKeys        = new Set(categoriesForLicenseType('license_exempt').map(c => c.key))
    const union = new Set([...familyHomeKeys, ...groupHomeKeys, ...lepKeys])
    for (const key of Object.keys(REMINDER_CATEGORIES)) {
      expect(union.has(key)).toBe(true)
    }
  })
})
