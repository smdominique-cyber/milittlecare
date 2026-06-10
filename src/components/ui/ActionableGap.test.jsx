// Phase 3.1a — <ActionableGap> component contract tests.
//
// The contract (docs/pr-compliance-engine-phase-3-1-scope.md §1):
// guidance text always; a react-router <Link> styled as a button ONLY
// when a fully-built fixTarget is supplied; never a dead or disabled
// button; severity is visual weight only.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ActionableGap from './ActionableGap'

function mount(props) {
  return render(
    <MemoryRouter>
      <ActionableGap {...props} />
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('ActionableGap — guidance text', () => {
  it('renders guidance text with no fixTarget — and no link', () => {
    mount({ guidanceText: 'Capture the parent’s signature.' })
    expect(screen.getByText('Capture the parent’s signature.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('empty guidanceText renders nothing at all', () => {
    const { container } = mount({ guidanceText: '' })
    expect(container.querySelector('.actionable-gap')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('missing guidanceText renders nothing even when fixTarget is supplied', () => {
    const { container } = mount({
      guidanceText: null,
      fixTarget: { label: 'Open this child in Families', to: '/families?family=f1&child=c1&tab=children' },
    })
    expect(container.querySelector('.actionable-gap')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('ActionableGap — fixTarget link', () => {
  it('renders a working <Link> with the exact href when fixTarget is fully built', () => {
    mount({
      guidanceText: 'Record the child’s immunization status.',
      fixTarget: { label: 'Open this child in Families', to: '/families?family=f1&child=c1&tab=children' },
      severity: 'critical',
    })
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/families?family=f1&child=c1&tab=children')
    expect(link.textContent).toContain('Open this child in Families')
  })

  it('never renders a button element — link-styled-as-button, no disabled state', () => {
    const { container } = mount({
      guidanceText: 'Complete the annual training.',
      fixTarget: { label: 'Open MiRegistry tracker', to: '/miregistry' },
    })
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[disabled]')).toBeNull()
    expect(container.querySelector('[aria-disabled]')).toBeNull()
  })

  it('partial fixTarget (missing `to`) renders text only — no dead button', () => {
    mount({
      guidanceText: 'Some guidance.',
      fixTarget: { label: 'Open something' },
    })
    expect(screen.getByText('Some guidance.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('partial fixTarget (missing `label`) renders text only — no dead button', () => {
    mount({
      guidanceText: 'Some guidance.',
      fixTarget: { to: '/miregistry' },
    })
    expect(screen.getByText('Some guidance.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('ActionableGap — severity (visual weight only)', () => {
  it.each(['critical', 'warning', 'info'])(
    'applies the actionable-gap--%s class to the container',
    (severity) => {
      const { container } = mount({ guidanceText: 'Guidance.', severity })
      expect(container.querySelector(`.actionable-gap--${severity}`)).toBeTruthy()
    }
  )

  it('defaults to info when severity is omitted', () => {
    const { container } = mount({ guidanceText: 'Guidance.' })
    expect(container.querySelector('.actionable-gap--info')).toBeTruthy()
  })

  it('falls back to info on an unrecognized severity value', () => {
    const { container } = mount({ guidanceText: 'Guidance.', severity: 'catastrophic' })
    expect(container.querySelector('.actionable-gap--info')).toBeTruthy()
    expect(container.querySelector('.actionable-gap--catastrophic')).toBeNull()
  })

  it('severity does NOT gate the link — critical and info both render it', () => {
    for (const severity of ['critical', 'info']) {
      const { unmount } = mount({
        guidanceText: 'Guidance.',
        fixTarget: { label: 'Open MiRegistry tracker', to: '/miregistry' },
        severity,
      })
      expect(screen.getByRole('link').getAttribute('href')).toBe('/miregistry')
      unmount()
    }
  })
})
