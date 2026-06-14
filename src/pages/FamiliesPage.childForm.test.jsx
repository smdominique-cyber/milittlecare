// 2026-06-14 — locks the B1 + B2 integrity-hole closure on ChildForm:
//
//   B1  child_immunization_record: the engine's resolver
//        (complianceState.js:671-677) treats child.immunization_status
//        as on_file when it's one of
//        ['up_to_date', 'waiver_on_file', 'in_progress'].
//        The dropdown MUST offer exactly those three values — the
//        subtle trap is enum drift between the UI and the resolver
//        (and the migration-024 CHECK constraint). Any other value
//        would write successfully but never satisfy the row.
//
//   B2  child_annual_record_review: the resolver reads
//        child.records_last_reviewed_on as a date string. Setting it
//        to a valid date within 366 days of `now` flips the row to
//        on_file; the scheduler (lib/schedulers/childAnnualReviewScheduler.js)
//        then anchors the next reminder on records_last_reviewed_on
//        + 1 year and stops firing repeatedly.
//
// The save path normalizes empty strings to null (date_of_birth,
// immunization_status, records_last_reviewed_on) because the CHECK
// constraint and date column type both reject ''.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

const calls = vi.hoisted(() => ({
  from: [], update: [], insert: [], eq: [], error: null,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from(table) {
      calls.from.push(table)
      const chain = {
        update(payload) { calls.update.push({ table, payload }); return chain },
        insert(payload) { calls.insert.push({ table, payload }); return chain },
        eq(col, val) { calls.eq.push({ table, col, val }); return chain },
        then(resolve) { resolve({ data: null, error: calls.error }) },
      }
      return chain
    },
  },
}))

// The other modules FamiliesPage imports at the top of the file —
// none of them runs side-effects at import time, but the auth/role
// hooks ARE imported even though ChildForm itself doesn't use them.
// Mock them out as a defense against the resolver running real code.
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/hooks/useRole', () => ({ useRole: () => ({ role: 'licensee' }) }))

const { ChildForm, IMMUNIZATION_STATUS_OPTIONS } = await import('./FamiliesPage')
const { REQUIREMENT_REGISTRY, REQUIREMENT_STATE_KIND } =
  await import('@/lib/complianceState')

beforeEach(() => {
  calls.from.length = 0
  calls.update.length = 0
  calls.insert.length = 0
  calls.eq.length = 0
  calls.error = null
})

afterEach(cleanup)

// -----------------------------------------------------------------------------
// Alignment lock — the B1 trap
// -----------------------------------------------------------------------------
//
// The dropdown's option values MUST match the resolver's expectations
// exactly. We don't lift the resolver's literal list and compare —
// we run the resolver against each value and assert it resolves to
// on_file. A behavioral lock is stricter than a constant lock: it
// catches a renamed-value bug too, not just an added/removed one.

describe('IMMUNIZATION_STATUS_OPTIONS — B1 alignment with the engine resolver', () => {
  const req = REQUIREMENT_REGISTRY.child_immunization_record

  it('every dropdown value satisfies the resolver (returns on_file)', () => {
    expect(req).toBeDefined()
    for (const opt of IMMUNIZATION_STATUS_OPTIONS) {
      const state = req.state_resolver({
        child: { immunization_status: opt.value },
        now: new Date('2026-06-14T12:00:00Z'),
      })
      expect(state.kind, `value=${opt.value} should resolve to on_file`)
        .toBe(REQUIREMENT_STATE_KIND.ON_FILE)
    }
  })

  it('the dropdown has exactly three entries — a fourth would need both registry + CHECK constraint updates first', () => {
    // If the rule grows a fourth accepted status, this test forces an
    // explicit registry + migration audit before the UI changes.
    expect(IMMUNIZATION_STATUS_OPTIONS.length).toBe(3)
  })

  it('the resolver rejects unrecognized strings (the trap: a wrong value writes but never satisfies)', () => {
    const state = req.state_resolver({
      child: { immunization_status: 'fully_vaccinated' /* the wrong-name trap */ },
      now: new Date('2026-06-14T12:00:00Z'),
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })

  it('null immunization_status → missing_required (regression: empty-string normalization to null on write must keep this honest)', () => {
    const state = req.state_resolver({
      child: { immunization_status: null },
      now: new Date('2026-06-14T12:00:00Z'),
    })
    expect(state.kind).toBe(REQUIREMENT_STATE_KIND.MISSING_REQUIRED)
  })
})

// -----------------------------------------------------------------------------
// ChildForm render + save path
// -----------------------------------------------------------------------------

function mountWithExistingChild(overrides = {}) {
  return render(
    <ChildForm
      userId="u-licensee"
      familyId="fam-1"
      child={{
        id: 'child-1',
        first_name: 'Avery',
        last_name: 'Aldine',
        date_of_birth: '2022-04-01',
        allergies: '',
        medical_notes: '',
        notes: '',
        immunization_status: null,
        records_last_reviewed_on: null,
        ...overrides,
      }}
      onClose={() => {}}
      onSaved={vi.fn()}
    />
  )
}

describe('ChildForm — B1 + B2 inputs render', () => {
  it('the Immunization status select offers exactly the three resolver-accepted values plus an empty "Not recorded" option', () => {
    mountWithExistingChild()
    const select = screen.getByLabelText(/immunization status/i)
    const optionValues = Array.from(select.options).map(o => o.value)
    // Empty option first (clears to null), then the three locked values.
    expect(optionValues).toEqual([
      '',
      'up_to_date',
      'waiver_on_file',
      'in_progress',
    ])
  })

  it('the Records-last-reviewed-on date input is rendered', () => {
    mountWithExistingChild()
    const input = screen.getByLabelText(/records last reviewed on/i)
    expect(input.tagName).toBe('INPUT')
    expect(input.getAttribute('type')).toBe('date')
  })
})

describe('ChildForm — save writes the new fields through the existing .update path', () => {
  async function fillAndSave({ immunizationValue, lastReviewedValue }) {
    mountWithExistingChild()
    const immSelect = screen.getByLabelText(/immunization status/i)
    fireEvent.change(immSelect, { target: { value: immunizationValue } })
    const dateInput = screen.getByLabelText(/records last reviewed on/i)
    fireEvent.change(dateInput, { target: { value: lastReviewedValue } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    })
  }

  it('writes immunization_status and records_last_reviewed_on on the same .update payload', async () => {
    await fillAndSave({
      immunizationValue: 'up_to_date',
      lastReviewedValue: '2026-05-01',
    })

    // One write to children, no second .from() call, and it landed on
    // the existing .update path (not a sibling .insert or .upsert).
    expect(calls.from).toEqual(['children'])
    expect(calls.update).toHaveLength(1)
    expect(calls.insert).toHaveLength(0)
    // The payload carries BOTH new fields.
    expect(calls.update[0].payload).toMatchObject({
      immunization_status:      'up_to_date',
      records_last_reviewed_on: '2026-05-01',
    })
    // Scoped by id (mirrors the date_of_birth behavior the form
    // already had — no behavior regression).
    expect(calls.eq).toEqual([{ table: 'children', col: 'id', val: 'child-1' }])
  })

  it('empty Immunization status writes null (avoids the migration-024 CHECK constraint violation)', async () => {
    await fillAndSave({
      immunizationValue: '',  // user clears the dropdown
      lastReviewedValue: '2026-05-01',
    })
    expect(calls.update[0].payload.immunization_status).toBeNull()
  })

  it('empty Records-last-reviewed-on date writes null (date column cannot accept empty string)', async () => {
    await fillAndSave({
      immunizationValue: 'up_to_date',
      lastReviewedValue: '',
    })
    expect(calls.update[0].payload.records_last_reviewed_on).toBeNull()
  })

  it('saved values pre-populate the form from the existing child record (B2 edit case — provider amending a stale review date)', async () => {
    mountWithExistingChild({
      immunization_status:      'in_progress',
      records_last_reviewed_on: '2025-06-01',
    })
    expect(screen.getByLabelText(/immunization status/i).value).toBe('in_progress')
    expect(screen.getByLabelText(/records last reviewed on/i).value).toBe('2025-06-01')
  })
})

describe('ChildForm — insert path also carries the new fields (B2 first-time child)', () => {
  // The existing pre-B1/B2 ChildForm inputs (First name etc.) don't
  // have htmlFor/id, so getByLabelText can't reach them. We don't add
  // those associations here (out of scope for the B1/B2 fix). Instead
  // we drive the form state through the same field-input class the
  // existing inputs use — the first .field-input is First name (its
  // ordering in the JSX is stable).
  it('insert payload includes immunization_status + records_last_reviewed_on', async () => {
    const { container } = render(
      <ChildForm
        userId="u-licensee"
        familyId="fam-1"
        child={null}
        onClose={() => {}}
        onSaved={vi.fn()}
      />
    )
    const inputs = container.querySelectorAll('input.field-input')
    // [0]=First name, [1]=Last name, [2]=DOB, [3]=Allergies,
    // [5]=records_last_reviewed_on. (Index 4 is the immunization
    // SELECT, not INPUT.)
    fireEvent.change(inputs[0], { target: { value: 'New' } })
    fireEvent.change(screen.getByLabelText(/immunization status/i), { target: { value: 'waiver_on_file' } })
    fireEvent.change(screen.getByLabelText(/records last reviewed on/i), { target: { value: '2026-06-01' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    })

    expect(calls.update).toHaveLength(0)
    expect(calls.insert).toHaveLength(1)
    expect(calls.insert[0].payload).toMatchObject({
      user_id: 'u-licensee',
      family_id: 'fam-1',
      first_name: 'New',
      immunization_status:      'waiver_on_file',
      records_last_reviewed_on: '2026-06-01',
    })
  })
})
