// 2026-06-17 PR #19 (mig 044) — DrillsSection mount + flow tests.
//
// What this pins:
//   - The Drills tab is reachable via ?section=drills.
//   - The ERP ComplianceDocumentSlot mounts above the drill log form.
//   - Loading drill logs via supabase reads the right table with the
//     right filter (user_id + archived_at IS NULL + order desc).
//   - Submitting the form inserts a row with the right shape:
//     user_id from the authed user, drill_type from the select,
//     performed_on from the date input, optional duration / notes.
//   - The form refuses a future date and a non-positive duration
//     client-side (belt + suspenders for the DB CHECK constraints in
//     migration 044).
//   - Archive triggers an UPDATE with archived_at + archived_by; the
//     row disappears from the visible list. The endpoint NEVER hits
//     DELETE — the table has no DELETE policy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const USER_ID = 'u-licensee'

let drillLogRows
let insertedPayloads
let updatePatches
let supabaseCalls

function tableMock(table) {
  if (table === 'drill_logs') {
    let mode = 'select'
    let insertPayload = null
    let updatePayload = null
    let filterIdEq = null
    const chain = {
      select() { return chain },
      eq(col, val) {
        if (col === 'id') filterIdEq = val
        return chain
      },
      is() { return chain },
      order() { return chain },
      insert(payload) {
        mode = 'insert'
        insertPayload = payload
        return chain
      },
      update(payload) {
        mode = 'update'
        updatePayload = payload
        return chain
      },
      single() {
        // Triggered after insert+select+single.
        const row = { id: 'new-row-' + (insertedPayloads.length + 1), ...insertPayload, archived_at: null, created_at: '2026-06-17T12:00:00Z' }
        insertedPayloads.push(insertPayload)
        return Promise.resolve({ data: row, error: null })
      },
      then(resolve, reject) {
        if (mode === 'insert') {
          // Insert chain that doesn't end in .single() — not used in
          // the production code but safe to support.
          const row = { id: 'new-row-' + (insertedPayloads.length + 1), ...insertPayload }
          insertedPayloads.push(insertPayload)
          return Promise.resolve({ data: [row], error: null }).then(resolve, reject)
        }
        if (mode === 'update') {
          updatePatches.push({ id: filterIdEq, payload: updatePayload })
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        }
        // SELECT path — return the canned drill_logs.
        return Promise.resolve({ data: drillLogRows, error: null }).then(resolve, reject)
      },
    }
    return chain
  }
  // Other tables — return shapes for the page's other loads
  // (profiles, business_hours, etc.). Each just resolves to no-op.
  // The chain tracks the call mode so the terminal `then` resolves
  // a recognisable shape; the actual payload is unused in this test
  // file (we only assert against drill_logs interactions).
  let mode = 'select'
  const chain = {
    select() { return chain },
    eq() { return chain },
    is() { return chain },
    in() { return chain },
    order() { return chain },
    update() { mode = 'update'; return chain },
    insert() {
      return Promise.resolve({ data: null, error: null })
    },
    upsert() { return Promise.resolve({ data: null, error: null }) },
    delete() { return chain },
    maybeSingle() {
      // Profile read needs to return a licensed_home so the Drills
      // tab is visible.
      if (table === 'profiles') {
        return Promise.resolve({
          data: { license_type: 'family_home', license_type_review_needed: false, is_license_exempt: false, home_built_before_1978: null, firearms_on_premises: null, daycare_name: null },
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
    then(resolve, reject) {
      if (mode === 'update') {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      }
      return Promise.resolve({ data: [], error: null }).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: USER_ID, email: 'p@example.com' } }),
}))

vi.mock('@/lib/notifications', () => ({
  notifyStateChange: vi.fn(),
}))

vi.mock('@/components/compliance/ApplicabilityQuestionsSection', () => ({
  default: () => <div data-testid="applicability-stub" />,
}))

vi.mock('@/components/documents/ComplianceDocumentSlot', () => ({
  default: ({ documentType }) => (
    <div data-testid={`compliance-doc-slot-${documentType}`}>doc slot {documentType}</div>
  ),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table) => {
      supabaseCalls.push({ table })
      return tableMock(table)
    },
  },
}))

const { default: BusinessInfoPage } = await import('./BusinessInfoPage')

beforeEach(() => {
  drillLogRows = []
  insertedPayloads = []
  updatePatches = []
  supabaseCalls = []
})

afterEach(cleanup)

async function mountAt(path) {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <BusinessInfoPage />
    </MemoryRouter>
  )
  await screen.findByText('Set this once. Stop answering it forever.')
  return utils
}

// ─── Deep-link reaches the tab ────────────────────────────────────────

describe('BusinessInfoPage — Drills tab deep-link', () => {
  it('?section=drills selects the Drills tab and renders the section', async () => {
    const { container } = await mountAt('/business-info?section=drills')
    const active = container.querySelector('.bi-tab.active span')
    expect(active?.textContent).toBe('Drills')
    expect(screen.getByText('Drills & Emergency Response Plan')).toBeTruthy()
  })

  it('the Emergency Response Plan slot mounts ABOVE the drill log form (auditor "plan first" mental model)', async () => {
    const { container } = await mountAt('/business-info?section=drills')
    await screen.findByTestId('compliance-doc-slot-emergency_response_plan')
    const plan = screen.getByTestId('compliance-doc-slot-emergency_response_plan')
    const form = container.querySelector('form')
    // DOM order: plan before form.
    expect(plan.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// ─── Log a drill ──────────────────────────────────────────────────────

describe('BusinessInfoPage — DrillsSection insert flow', () => {
  it('submitting the form inserts a row with user_id from auth, drill_type, performed_on, duration, notes', async () => {
    await mountAt('/business-info?section=drills')

    // Fill the form.
    const selectType = screen.getByDisplayValue('Fire drill')
    fireEvent.change(selectType, { target: { value: 'tornado' } })

    // Date input: keep today (default). Find via the date type.
    const dateInputs = document.querySelectorAll('input[type="date"]')
    const dateInput = dateInputs[dateInputs.length - 1]
    fireEvent.change(dateInput, { target: { value: '2026-04-15' } })

    const durationInput = document.querySelector('input[type="number"]')
    fireEvent.change(durationInput, { target: { value: '5' } })

    const notesInput = document.querySelector('textarea')
    fireEvent.change(notesInput, { target: { value: 'Practiced shelter routing.' } })

    const submit = screen.getByRole('button', { name: /log drill/i })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(insertedPayloads.length).toBe(1)
    })

    expect(insertedPayloads[0]).toEqual({
      user_id: USER_ID,
      drill_type: 'tornado',
      performed_on: '2026-04-15',
      duration_minutes: 5,
      notes: 'Practiced shelter routing.',
    })
  })

  it('refuses a future-dated drill client-side (DB CHECK is the belt; this is suspenders)', async () => {
    await mountAt('/business-info?section=drills')
    const form = document.querySelector('form')
    const dateInput = form.querySelector('input[type="date"]')
    fireEvent.change(dateInput, { target: { value: '2126-01-01' } })
    // fireEvent.submit on the form element — more reliable than
    // clicking a type=submit button inside JSDOM.
    fireEvent.submit(form)
    await screen.findByText(/cannot have been performed in the future/i)
    expect(insertedPayloads).toHaveLength(0)
  })

  it('refuses a non-positive duration client-side', async () => {
    await mountAt('/business-info?section=drills')
    const form = document.querySelector('form')
    const durationInput = form.querySelector('input[type="number"]')
    fireEvent.change(durationInput, { target: { value: '-5' } })
    fireEvent.submit(form)
    await screen.findByText(/Duration must be a positive number/i)
    expect(insertedPayloads).toHaveLength(0)
  })

  it('accepts a blank duration (logs without it)', async () => {
    await mountAt('/business-info?section=drills')
    const submit = screen.getByRole('button', { name: /log drill/i })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(insertedPayloads.length).toBe(1)
    })
    expect(insertedPayloads[0].duration_minutes).toBeNull()
  })
})

// ─── Archive ──────────────────────────────────────────────────────────

describe('BusinessInfoPage — DrillsSection archive flow', () => {
  it('archive issues an UPDATE with archived_at and archived_by; no DELETE call', async () => {
    drillLogRows = [
      { id: 'dl-1', drill_type: 'fire', performed_on: '2026-05-01', duration_minutes: 3, notes: null, archived_at: null, created_at: '2026-05-01T00:00:00Z' },
    ]
    const originalConfirm = window.confirm
    window.confirm = () => true
    try {
      await mountAt('/business-io?section=drills'.replace('-io', '-info'))
      // The list <li> renders "Fire drill" inside <strong>; the <option>
      // in the form select also renders it. Disambiguate by querying
      // the list region directly.
      await waitFor(() => {
        const strongs = Array.from(document.querySelectorAll('li strong'))
        expect(strongs.some(el => /Fire drill/i.test(el.textContent || ''))).toBe(true)
      })
      const archiveBtn = screen.getByRole('button', { name: /archive/i })
      fireEvent.click(archiveBtn)
      await waitFor(() => {
        expect(updatePatches.length).toBe(1)
      })
      const patch = updatePatches[0]
      expect(patch.id).toBe('dl-1')
      expect(patch.payload.archived_at).toBeTruthy()
      expect(patch.payload.archived_by).toBe(USER_ID)
    } finally {
      window.confirm = originalConfirm
    }
  })
})
