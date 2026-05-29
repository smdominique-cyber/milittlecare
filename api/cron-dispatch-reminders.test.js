import { describe, it, expect } from 'vitest'
import { decideAction, composeEmail, resolveRecipients } from './cron-dispatch-reminders.js'

// ─── decideAction ──────────────────────────────────────────────────────

describe('decideAction', () => {
  const inst = { id: 'i1', category: 'drill_fire' }

  // Pre-existing PR #15 behavior (back-compat: category arg omitted).
  // Existing call sites can keep passing two args until they are
  // updated; the third arg is optional and defaults to PR #15
  // semantics when absent.

  it('skips when no preference row exists (default OFF)', () => {
    expect(decideAction(inst, undefined)).toEqual({ action: 'skip_no_pref' })
    expect(decideAction(inst, null)).toEqual({ action: 'skip_no_pref' })
  })

  it('skips when preference exists but enabled is false', () => {
    expect(decideAction(inst, { enabled: false, channel: 'in_app' }))
      .toEqual({ action: 'skip_disabled' })
  })

  it('fires with the preference channel when enabled', () => {
    expect(decideAction(inst, { enabled: true, channel: 'in_app' }))
      .toEqual({ action: 'fire', channel: 'in_app' })
    expect(decideAction(inst, { enabled: true, channel: 'email' }))
      .toEqual({ action: 'fire', channel: 'email' })
    expect(decideAction(inst, { enabled: true, channel: 'both' }))
      .toEqual({ action: 'fire', channel: 'both' })
  })

  it('defaults to in_app when enabled but channel is missing', () => {
    expect(decideAction(inst, { enabled: true })).toEqual({ action: 'fire', channel: 'in_app' })
  })

  // PR #16 follow-up: transactional categories bypass default-OFF.

  describe('transactional categories', () => {
    const inst2 = { id: 'i2', category: 'intake_acknowledgment_pending' }
    const transactional = { key: 'intake_acknowledgment_pending', transactional: true }
    const stateful = { key: 'drill_fire' }

    it('FIRES when no preference row exists for a transactional category', () => {
      // The provider's explicit action (clicking "Send to parent's portal")
      // is the consent — no separate opt-in required. Default channel is
      // email because the parent can't see the provider's in-app banner.
      expect(decideAction(inst2, undefined, transactional))
        .toEqual({ action: 'fire', channel: 'email' })
      expect(decideAction(inst2, null, transactional))
        .toEqual({ action: 'fire', channel: 'email' })
    })

    it('STILL honors enabled=false for a transactional category (explicit opt-out)', () => {
      expect(decideAction(inst2, { enabled: false, channel: 'email' }, transactional))
        .toEqual({ action: 'skip_disabled' })
    })

    it('uses the preference channel when set for a transactional category', () => {
      expect(decideAction(inst2, { enabled: true, channel: 'both' }, transactional))
        .toEqual({ action: 'fire', channel: 'both' })
    })

    it('defaults to email (not in_app) when a transactional row omits the channel', () => {
      expect(decideAction(inst2, { enabled: true }, transactional))
        .toEqual({ action: 'fire', channel: 'email' })
    })

    it('non-transactional category with the catalog arg present behaves as PR #15 (no behavioral change)', () => {
      expect(decideAction(inst, undefined, stateful))
        .toEqual({ action: 'skip_no_pref' })
    })

    it('a transactional flag set to falsy is treated as non-transactional', () => {
      expect(decideAction(inst2, undefined, { key: 'x', transactional: false }))
        .toEqual({ action: 'skip_no_pref' })
    })
  })
})

// ─── resolveRecipients ──────────────────────────────────────────────────
//
// Pure mocks for supabaseGet by monkey-patching the module's import. The
// helper resolves recipients via the existing service-role REST path; we
// inject a fetch shim through `globalThis.fetch` to drive deterministic
// responses. This is exactly the role the dispatcher uses in production.

describe('resolveRecipients', () => {
  const ORIG_FETCH = globalThis.fetch
  const ORIG_URL = process.env.SUPABASE_URL
  const ORIG_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  function installFetch(handler) {
    globalThis.fetch = async (url, opts) => {
      const body = await handler(String(url), opts || {})
      return {
        ok: true,
        status: 200,
        async json() { return body },
        async text() { return JSON.stringify(body) },
      }
    }
  }

  function restoreFetch() {
    globalThis.fetch = ORIG_FETCH
    process.env.SUPABASE_URL = ORIG_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIG_KEY
  }

  beforeEachSetup()
  function beforeEachSetup() {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
  }

  it('provider resolver: returns the provider profile email as a single recipient', async () => {
    const out = await resolveRecipients(
      { provider_id: 'prov-1' },
      { email: 'pro@example.com' },
      { key: 'drill_fire' },     // no recipient_resolver → defaults to provider
    )
    expect(out).toEqual([{
      email: 'pro@example.com',
      recipient_type: 'provider',
      recipient_id: 'prov-1',
      family_id: null,
    }])
  })

  it('provider resolver with explicit "provider" resolver behaves identically', async () => {
    const out = await resolveRecipients(
      { provider_id: 'prov-1' },
      { email: 'pro@example.com' },
      { key: 'drill_fire', recipient_resolver: 'provider' },
    )
    expect(out[0].recipient_type).toBe('provider')
    expect(out[0].email).toBe('pro@example.com')
  })

  it('provider resolver returns [] when providerProfile has no email', async () => {
    const out = await resolveRecipients(
      { provider_id: 'prov-1' },
      { email: null },
      undefined,
    )
    expect(out).toEqual([])
  })

  it('parent_via_subject_child: fans out to every active linked parent who has not opted out', async () => {
    installFetch(async (url) => {
      if (url.includes('children?id=eq.kid-1')) {
        return [{ family_id: 'fam-1' }]
      }
      if (url.includes('parent_family_links?family_id=eq.fam-1')) {
        return [
          { parent_id: 'pA', family_id: 'fam-1', parent_profiles: {
            id: 'pA', email: 'a@example.com', full_name: 'A',
            acknowledgment_email_opt_in: true,
          }},
          { parent_id: 'pB', family_id: 'fam-1', parent_profiles: {
            id: 'pB', email: 'b@example.com', full_name: 'B',
            acknowledgment_email_opt_in: false,    // opted out — excluded
          }},
          { parent_id: 'pC', family_id: 'fam-1', parent_profiles: {
            id: 'pC', email: 'c@example.com', full_name: 'C',
            acknowledgment_email_opt_in: null,     // null = default true → included
          }},
        ]
      }
      return []
    })
    try {
      const out = await resolveRecipients(
        { provider_id: 'prov-1', subject_type: 'child', subject_id: 'kid-1' },
        { email: 'pro@example.com' },
        { key: 'intake_acknowledgment_pending',
          recipient_resolver: 'parent_via_subject_child' },
      )
      const emails = out.map(r => r.email).sort()
      expect(emails).toEqual(['a@example.com', 'c@example.com'])
      // All entries are parent-tagged with the family_id from the lookup.
      for (const r of out) {
        expect(r.recipient_type).toBe('parent')
        expect(r.family_id).toBe('fam-1')
      }
    } finally {
      restoreFetch()
    }
  })

  it('parent_via_subject_child: de-dupes parents linked to the same family more than once', async () => {
    installFetch(async (url) => {
      if (url.includes('children?id=eq.kid-1')) return [{ family_id: 'fam-1' }]
      if (url.includes('parent_family_links')) {
        return [
          { parent_id: 'pA', family_id: 'fam-1', parent_profiles: {
            id: 'pA', email: 'a@example.com', acknowledgment_email_opt_in: true,
          }},
          { parent_id: 'pA', family_id: 'fam-1', parent_profiles: {
            id: 'pA', email: 'a@example.com', acknowledgment_email_opt_in: true,
          }},
        ]
      }
      return []
    })
    try {
      const out = await resolveRecipients(
        { provider_id: 'p', subject_type: 'child', subject_id: 'kid-1' },
        {},
        { recipient_resolver: 'parent_via_subject_child' },
      )
      expect(out).toHaveLength(1)
    } finally {
      restoreFetch()
    }
  })

  it('parent_via_subject_child: returns [] for an instance that is not subject_type=child', async () => {
    const out = await resolveRecipients(
      { provider_id: 'p', subject_type: null, subject_id: null },
      {},
      { recipient_resolver: 'parent_via_subject_child' },
    )
    expect(out).toEqual([])
  })

  it('parent_via_subject_child: returns [] when the child has no family_id', async () => {
    installFetch(async (url) => {
      if (url.includes('children?id=eq.kid-1')) return [{ family_id: null }]
      return []
    })
    try {
      const out = await resolveRecipients(
        { provider_id: 'p', subject_type: 'child', subject_id: 'kid-1' },
        {},
        { recipient_resolver: 'parent_via_subject_child' },
      )
      expect(out).toEqual([])
    } finally {
      restoreFetch()
    }
  })

  it('parent_via_subject_child: returns [] when no active parent links exist', async () => {
    installFetch(async (url) => {
      if (url.includes('children?id=eq.kid-1')) return [{ family_id: 'fam-1' }]
      if (url.includes('parent_family_links')) return []
      return []
    })
    try {
      const out = await resolveRecipients(
        { provider_id: 'p', subject_type: 'child', subject_id: 'kid-1' },
        {},
        { recipient_resolver: 'parent_via_subject_child' },
      )
      expect(out).toEqual([])
    } finally {
      restoreFetch()
    }
  })

  it('returns [] for an unknown resolver name', async () => {
    const out = await resolveRecipients(
      { provider_id: 'p' },
      { email: 'x@example.com' },
      { recipient_resolver: 'bogus_resolver' },
    )
    expect(out).toEqual([])
  })
})

// ─── composeEmail ──────────────────────────────────────────────────────

describe('composeEmail', () => {
  it('builds subject/text/html from the instance', () => {
    const inst = {
      title: 'Fire drill due',
      body: 'Per R 400.1939, fire drills every 3 months.',
      cta_path: '/drill-log',
    }
    const { subject, html, text } = composeEmail(inst, 'Venessa\'s Place')
    expect(subject).toBe('Fire drill due')
    expect(text).toContain('Fire drill due')
    expect(text).toContain('Per R 400.1939')
    expect(text).toMatch(/Open: https?:\/\/.+\/drill-log/)
    expect(html).toContain('<strong>Fire drill due</strong>')
    expect(html).toContain('drill-log')
    expect(html).toContain('From Venessa')
  })

  it('escapes HTML special characters in title and body', () => {
    const inst = {
      title: 'Fire <drill> & "safety"',
      body: 'New \'rules\' apply',
      cta_path: null,
    }
    const { html } = composeEmail(inst, 'Provider')
    expect(html).toContain('&lt;drill&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;safety&quot;')
    expect(html).toContain('&#39;rules&#39;')
  })

  it('uses the public app URL when no cta_path is set', () => {
    const inst = { title: 'X', body: null, cta_path: null }
    const { text, html } = composeEmail(inst, 'Provider')
    // We do not assert a specific host here; just that the deep link is a URL.
    expect(text).toMatch(/Open: https?:\/\/\S+/)
    expect(html).toMatch(/<a href="https?:\/\/\S+/)
  })

  it('handles missing body cleanly (no <p></p> insertion)', () => {
    const inst = { title: 'X', body: null, cta_path: '/x' }
    const { html } = composeEmail(inst, 'Provider')
    // Only one body line should appear (the link), plus title + footer.
    expect((html.match(/<p>/g) || []).length).toBeLessThanOrEqual(3)
  })
})
