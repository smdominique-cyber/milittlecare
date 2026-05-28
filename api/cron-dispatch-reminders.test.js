import { describe, it, expect } from 'vitest'
import { decideAction, composeEmail } from './cron-dispatch-reminders.js'

// ─── decideAction ──────────────────────────────────────────────────────

describe('decideAction', () => {
  const inst = { id: 'i1', category: 'drill_fire' }

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
