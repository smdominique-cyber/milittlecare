import { describe, it, expect } from 'vitest'
import {
  deadlineFor,
  nextDeadline,
  triggerYMD,
  buildInstancePayload,
  providerNeedsReminder,
  scheduleMiregistryAnnualTrainingReminders,
} from './miregistryAnnualTrainingScheduler'

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('deadlineFor', () => {
  it('returns Dec 16 of the given year', () => {
    expect(deadlineFor(2026)).toBe('2026-12-16')
    expect(deadlineFor(2027)).toBe('2027-12-16')
  })
})

describe('nextDeadline', () => {
  it('returns this year before/on Dec 16', () => {
    expect(nextDeadline('2026-05-28')).toBe('2026-12-16')
    expect(nextDeadline('2026-12-16')).toBe('2026-12-16')
  })

  it('rolls to next year after Dec 16', () => {
    expect(nextDeadline('2026-12-17')).toBe('2027-12-16')
    expect(nextDeadline('2026-12-31')).toBe('2027-12-16')
  })
})

describe('triggerYMD', () => {
  it('returns deadline minus lead_time_days when fully ahead of the window', () => {
    // deadline 2026-12-16, lead 45 -> 2026-11-01
    expect(triggerYMD('2026-12-16', 45, '2026-05-28')).toBe('2026-11-01')
  })

  it('clamps to today when the lead window has already started', () => {
    // 45 days before 2026-12-16 = 2026-11-01; today 2026-11-10 is inside window.
    expect(triggerYMD('2026-12-16', 45, '2026-11-10')).toBe('2026-11-10')
  })

  it('treats lead 0 as deadline-of-day trigger', () => {
    expect(triggerYMD('2026-12-16', 0, '2026-05-28')).toBe('2026-12-16')
  })

  it('coerces non-numeric leadTimeDays to 0', () => {
    expect(triggerYMD('2026-12-16', 'foo', '2026-05-28')).toBe('2026-12-16')
  })
})

describe('buildInstancePayload', () => {
  it('produces the expected shape with title/body/cta_path and ISO timestamps', () => {
    const payload = buildInstancePayload('user-1', '2026-12-16', '2026-11-01')
    expect(payload.provider_id).toBe('user-1')
    expect(payload.category).toBe('miregistry_annual_training')
    expect(payload.subject_type).toBeNull()
    expect(payload.subject_id).toBeNull()
    expect(payload.trigger_at).toBe('2026-11-01T08:00:00.000Z')
    expect(payload.due_at).toBe('2026-12-16T23:59:00.000Z')
    expect(payload.cta_path).toBe('/miregistry')
    expect(payload.title).toMatch(/Annual Ongoing Training/i)
    expect(payload.body).toMatch(/MiRegistry/)
  })
})

describe('providerNeedsReminder', () => {
  const lep = { id: 'u1', license_type: 'license_exempt' }
  const licensed = { id: 'u2', license_type: 'family_home' }

  it('false for non-LEP providers regardless of training history', () => {
    expect(providerNeedsReminder(licensed, [], '2026-05-28')).toBe(false)
    expect(providerNeedsReminder(licensed, [{ completed_on: '2026-04-01' }], '2026-05-28')).toBe(false)
  })

  it('true for LEP with no completion entries in the deadline year', () => {
    expect(providerNeedsReminder(lep, [], '2026-05-28')).toBe(true)
  })

  it('false for LEP who already completed in the deadline year', () => {
    expect(providerNeedsReminder(
      lep,
      [{ completed_on: '2026-04-01' }],
      '2026-05-28',
    )).toBe(false)
  })

  it('uses the rolled-over deadline year past Dec 16 (last year completion does not count)', () => {
    // Dec 17 2026 -> deadline year is 2027. A 2026 completion does NOT
    // satisfy the 2027 cycle, so reminder is still needed.
    expect(providerNeedsReminder(
      lep,
      [{ completed_on: '2026-04-01' }],
      '2026-12-17',
    )).toBe(true)
  })
})

// ─── Orchestrator (idempotency + happy path) ───────────────────────────
//
// We build a small in-memory mock of the PostgREST builder shape. The
// scheduler is exercised end-to-end against it.

function makeOrchestratorMock({ prefs = [], profiles = [], entries = [], existingInstances = [] } = {}) {
  const inserted = []
  const calls = []

  function makeChain(initialData) {
    let data = initialData
    const chain = {
      _filters: [],
      select() { return chain },
      eq(col, val) { chain._filters.push({ eq: [col, val] }); return chain },
      in(col, vals) { chain._filters.push({ in: [col, vals] }); return chain },
      is(col, val) { chain._filters.push({ is: [col, val] }); return chain },
      gte(col, val) { chain._filters.push({ gte: [col, val] }); return chain },
      lte(col, val) { chain._filters.push({ lte: [col, val] }); return chain },
      limit() { return chain },
      then(resolve, reject) {
        // Apply the filter list to `data`.
        let result = Array.isArray(data) ? [...data] : []
        for (const f of chain._filters) {
          if (f.eq) result = result.filter(r => r[f.eq[0]] === f.eq[1])
          if (f.in) result = result.filter(r => f.in[1].includes(r[f.in[0]]))
          if (f.is) result = result.filter(r => (r[f.is[0]] ?? null) === f.is[1])
          if (f.gte) result = result.filter(r => r[f.gte[0]] >= f.gte[1])
          if (f.lte) result = result.filter(r => r[f.lte[0]] <= f.lte[1])
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
        miregistry_training_entries: entries,
        reminder_instances: existingInstances,
      }
      const chain = makeChain(map[table] || [])
      // Insert path: chain.insert(payload) -> resolves on await.
      chain.insert = (payload) => {
        inserted.push({ table, payload })
        return Promise.resolve({ data: payload, error: null })
      }
      return chain
    },
  }
  return { client, inserted, calls }
}

describe('scheduleMiregistryAnnualTrainingReminders', () => {
  it('inserts one instance for a LEP provider with no completion in the deadline year', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'miregistry_annual_training', lead_time_days: 45, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'license_exempt' }],
      entries: [],
      existingInstances: [],
    })
    const stats = await scheduleMiregistryAnnualTrainingReminders(client, '2026-05-28')
    expect(stats).toEqual({ providersChecked: 1, instancesInserted: 1, instancesSkipped: 0 })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].table).toBe('reminder_instances')
    expect(inserted[0].payload.provider_id).toBe('u1')
    expect(inserted[0].payload.category).toBe('miregistry_annual_training')
    expect(inserted[0].payload.trigger_at).toBe('2026-11-01T08:00:00.000Z')
  })

  it('is idempotent: skips when an instance already exists for the same trigger_at', async () => {
    const existingTriggerAt = '2026-11-01T08:00:00.000Z'
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'miregistry_annual_training', lead_time_days: 45, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'license_exempt' }],
      entries: [],
      existingInstances: [
        { id: 'existing-1', provider_id: 'u1', category: 'miregistry_annual_training', subject_id: null, trigger_at: existingTriggerAt, archived_at: null },
      ],
    })
    const stats = await scheduleMiregistryAnnualTrainingReminders(client, '2026-05-28')
    expect(stats).toEqual({ providersChecked: 1, instancesInserted: 0, instancesSkipped: 1 })
    expect(inserted).toHaveLength(0)
  })

  it('skips LEPs who completed training in the deadline year', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [{ provider_id: 'u1', category: 'miregistry_annual_training', lead_time_days: 45, enabled: true }],
      profiles: [{ id: 'u1', license_type: 'license_exempt' }],
      entries: [{ user_id: 'u1', completed_on: '2026-04-01', source: 'annual_ongoing', archived_at: null }],
    })
    const stats = await scheduleMiregistryAnnualTrainingReminders(client, '2026-05-28')
    expect(stats).toEqual({ providersChecked: 1, instancesInserted: 0, instancesSkipped: 1 })
    expect(inserted).toHaveLength(0)
  })

  it('filters out non-LEP providers even if they opted in', async () => {
    const { client, inserted } = makeOrchestratorMock({
      prefs: [
        { provider_id: 'u1', category: 'miregistry_annual_training', lead_time_days: 45, enabled: true },
        { provider_id: 'u2', category: 'miregistry_annual_training', lead_time_days: 45, enabled: true },
      ],
      profiles: [
        { id: 'u1', license_type: 'license_exempt' },
        { id: 'u2', license_type: 'family_home' },  // not eligible
      ],
      entries: [],
    })
    const stats = await scheduleMiregistryAnnualTrainingReminders(client, '2026-05-28')
    expect(stats.providersChecked).toBe(1)
    expect(stats.instancesInserted).toBe(1)
    expect(inserted[0].payload.provider_id).toBe('u1')
  })

  it('returns the zero-shape when there are no opted-in providers', async () => {
    const { client, inserted } = makeOrchestratorMock({ prefs: [] })
    const stats = await scheduleMiregistryAnnualTrainingReminders(client, '2026-05-28')
    expect(stats).toEqual({ providersChecked: 0, instancesInserted: 0, instancesSkipped: 0 })
    expect(inserted).toHaveLength(0)
  })
})
