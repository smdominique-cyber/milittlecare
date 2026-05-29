import { describe, it, expect } from 'vitest'
import {
  nextReviewDueDate,
  triggerYMD,
  buildInstancePayload,
  scheduleChildAnnualReviewReminders,
} from './childAnnualReviewScheduler'

describe('nextReviewDueDate', () => {
  it('records_last_reviewed_on + 1 year wins when present', () => {
    expect(nextReviewDueDate({ records_last_reviewed_on: '2026-05-29' }, '2026-06-01'))
      .toBe('2027-05-29')
  })

  it('falls back to intake_completed_at + 1 year when never reviewed', () => {
    expect(nextReviewDueDate({ intake_completed_at: '2026-05-29T12:00:00Z' }, '2026-06-01'))
      .toBe('2027-05-29')
  })

  it('returns null when neither anchor exists', () => {
    expect(nextReviewDueDate({}, '2026-06-01')).toBeNull()
  })

  it('clamps Feb 29 to Feb 28 on non-leap target year', () => {
    expect(nextReviewDueDate({ records_last_reviewed_on: '2024-02-29' }, '2025-01-01'))
      .toBe('2025-02-28')
  })
})

describe('triggerYMD', () => {
  it('returns due minus lead when ahead of window', () => {
    expect(triggerYMD('2027-05-29', 30, '2027-01-01')).toBe('2027-04-29')
  })

  it('clamps to today when inside the lead window', () => {
    expect(triggerYMD('2027-05-29', 30, '2027-05-15')).toBe('2027-05-15')
  })

  it('coerces non-numeric lead to 0', () => {
    expect(triggerYMD('2027-05-29', 'foo', '2027-01-01')).toBe('2027-05-29')
  })
})

describe('buildInstancePayload', () => {
  it('includes provider/category/subject + ISO timestamps + CTA', () => {
    const p = buildInstancePayload(
      'user-1',
      { id: 'kid-1', first_name: 'Mia' },
      '2027-05-29',
      '2027-04-29',
    )
    expect(p.provider_id).toBe('user-1')
    expect(p.category).toBe('child_annual_review')
    expect(p.subject_type).toBe('child')
    expect(p.subject_id).toBe('kid-1')
    expect(p.trigger_at).toBe('2027-04-29T08:00:00.000Z')
    expect(p.due_at).toBe('2027-05-29T23:59:00.000Z')
    expect(p.cta_path).toBe('/families')
    expect(p.body).toMatch(/Mia/)
  })
})

// ─── Orchestrator (idempotency + license-type filter) ──────────────────

function makeOrchestratorMock({ prefs = [], profiles = [], children = [], existingInstances = [] } = {}) {
  const inserted = []
  const calls = []

  function makeChain(initial) {
    let data = initial
    const filters = []
    const chain = {
      select() { return chain },
      eq(col, val) { filters.push({ eq: [col, val] }); return chain },
      in(col, vals) { filters.push({ in: [col, vals] }); return chain },
      is(col, val) { filters.push({ is: [col, val] }); return chain },
      gte() { return chain }, lte() { return chain }, limit() { return chain },
      then(resolve, reject) {
        let result = Array.isArray(data) ? [...data] : []
        for (const f of filters) {
          if (f.eq) result = result.filter(r => r[f.eq[0]] === f.eq[1])
          if (f.in) result = result.filter(r => f.in[1].includes(r[f.in[0]]))
          if (f.is) result = result.filter(r => (r[f.is[0]] ?? null) === f.is[1])
        }
        return Promise.resolve({ data: result, error: null }).then(resolve, reject)
      },
    }
    return chain
  }

  const client = {
    from(table) {
      calls.push({ from: table })
      const map = {
        reminder_preferences: prefs,
        profiles,
        children,
        reminder_instances: existingInstances,
      }
      const chain = makeChain(map[table] || [])
      chain.insert = (payload) => {
        inserted.push({ table, payload })
        return Promise.resolve({ data: payload, error: null })
      }
      return chain
    },
  }
  return { client, inserted, calls }
}

describe('scheduleChildAnnualReviewReminders', () => {
  it('inserts one instance per child for an opted-in licensed home', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'child_annual_review', lead_time_days: 30, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'family_home' }],
      children: [
        { id: 'k1', user_id: 'u1', first_name: 'A', records_last_reviewed_on: '2026-05-29', archived_at: null },
        { id: 'k2', user_id: 'u1', first_name: 'B', intake_completed_at: '2026-05-29T12:00:00Z', archived_at: null },
      ],
    })
    const stats = await scheduleChildAnnualReviewReminders(client, '2027-04-15')
    expect(stats.providersChecked).toBe(1)
    expect(stats.childrenChecked).toBe(2)
    expect(stats.instancesInserted).toBe(2)
    expect(inserted).toHaveLength(2)
  })

  it('filters out LEPs even when opted in', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'child_annual_review', lead_time_days: 30, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'license_exempt' }],
      children: [{ id: 'k1', user_id: 'u1', records_last_reviewed_on: '2026-05-29', archived_at: null }],
    })
    const stats = await scheduleChildAnnualReviewReminders(client, '2027-04-15')
    expect(stats.providersChecked).toBe(0)
    expect(stats.instancesInserted).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('is idempotent: skips when an instance already exists at the computed trigger_at', async () => {
    const existingTriggerAt = '2027-04-29T08:00:00.000Z'
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'child_annual_review', lead_time_days: 30, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'family_home' }],
      children: [{ id: 'k1', user_id: 'u1', records_last_reviewed_on: '2026-05-29', archived_at: null }],
      existingInstances: [
        { id: 'e1', provider_id: 'u1', category: 'child_annual_review', subject_id: 'k1', trigger_at: existingTriggerAt, archived_at: null },
      ],
    })
    const stats = await scheduleChildAnnualReviewReminders(client, '2027-04-01')
    expect(stats.instancesSkipped).toBe(1)
    expect(stats.instancesInserted).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('skips children with no review timeline (neither prior review nor intake)', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'child_annual_review', lead_time_days: 30, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'group_home' }],
      children: [{ id: 'k1', user_id: 'u1', archived_at: null }],
    })
    const stats = await scheduleChildAnnualReviewReminders(client, '2027-04-15')
    expect(stats.instancesInserted).toBe(0)
    expect(stats.instancesSkipped).toBe(1)
    expect(inserted).toHaveLength(0)
  })

  it('returns zero-shape when there are no opted-in providers', async () => {
    const { client, inserted } = makeOrchestratorMock({ prefs: [] })
    const stats = await scheduleChildAnnualReviewReminders(client, '2027-04-15')
    expect(stats).toEqual({ providersChecked: 0, childrenChecked: 0, instancesInserted: 0, instancesSkipped: 0 })
    expect(inserted).toHaveLength(0)
  })
})
