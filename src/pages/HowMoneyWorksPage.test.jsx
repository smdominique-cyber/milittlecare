// 2026-06-17 — pins the corrected 1099-K copy after the IRS Fact
// Sheet 2025-08 / One Big Beautiful Bill Act rule reinstatement.
//
// What this asserts:
//   - The prior wrong numbers ("$5,000", "7-8 weeks") no longer appear
//     anywhere on the page.
//   - The corrected threshold ($20,000 + 200 transactions) appears in
//     the body, AND the page frames it as "both must be met."
//   - The page includes the "many small providers won't receive a
//     1099-K at all" explainer so a provider clearing only the dollar
//     amount isn't surprised by no form arriving.
//   - The threshold is dated ("as of 2026" / IRS Fact Sheet 2025-08)
//     so a reader knows when this was last verified.
//   - The framing is "if you cross both thresholds" rather than the
//     prior "you will receive."

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import HowMoneyWorksPage from './HowMoneyWorksPage'

function renderPage() {
  return render(
    <MemoryRouter>
      <HowMoneyWorksPage />
    </MemoryRouter>
  )
}

describe('HowMoneyWorksPage — 1099-K copy (post-OBBBA correction)', () => {
  it('does NOT contain the prior wrong $5,000 threshold anywhere', () => {
    const { container } = renderPage()
    expect(container.textContent).not.toContain('$5,000')
  })

  it('does NOT contain the prior wrong "7-8 weeks" claim', () => {
    const { container } = renderPage()
    expect(container.textContent).not.toMatch(/7-8 weeks/i)
    expect(container.textContent).not.toMatch(/first 7\s*-\s*8 weeks/i)
  })

  it('cites the corrected $20,000 dollar threshold', () => {
    renderPage()
    expect(screen.getAllByText(/\$20,000/).length).toBeGreaterThanOrEqual(1)
  })

  it('cites the 200-transaction threshold', () => {
    renderPage()
    expect(screen.getAllByText(/200\s+separate transactions/i).length).toBeGreaterThanOrEqual(1)
  })

  it('frames the two thresholds as a conjunction ("both must be met")', () => {
    const { container } = renderPage()
    // The page says "Both thresholds must be met" in body copy and
    // surfaces "both" multiple times — at minimum, one
    // assertion-bearing phrase.
    expect(container.textContent).toMatch(/both/i)
    expect(container.textContent).toMatch(/Both thresholds must be met|both must be met/i)
  })

  it('explains that many small home providers receive no 1099-K at all', () => {
    const { container } = renderPage()
    // The explainer mentions clearing the dollar amount but staying
    // under the transaction count.
    expect(container.textContent).toMatch(/no 1099-K|never receive a 1099-K|receive no 1099-K/i)
    expect(container.textContent).toMatch(/under 200 transactions/i)
  })

  it('frames receipt conditionally ("if you do cross both") rather than as guaranteed', () => {
    const { container } = renderPage()
    expect(container.textContent).toMatch(/If you do cross both thresholds/i)
    // And does NOT contain the prior unconditional "you'll receive" /
    // "you will receive" phrasing applied to the 1099-K itself.
    expect(container.textContent).not.toMatch(/You’ll receive your 1099-K|You'll receive your 1099-K|You will receive your 1099-K/i)
  })

  it('dates the threshold (2026 + IRS Fact Sheet 2025-08) so the reader knows when this was last verified', () => {
    const { container } = renderPage()
    expect(container.textContent).toMatch(/as of 2026/i)
    expect(container.textContent).toMatch(/Fact Sheet 2025-08/i)
  })

  it('still has the calming "you\'re not in trouble — this is normal" reassurance', () => {
    const { container } = renderPage()
    expect(container.textContent).toMatch(/You’re not in trouble|You're not in trouble/i)
  })
})
