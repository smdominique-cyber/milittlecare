// PR #15 Half 2 — hook + supporting pure-ish operators for managing
// the current provider's reminder_preferences rows.
//
// The hook is thin: it owns React state and lifecycle. All the
// business behavior (load, upsert-by-category, toggle on/off, default
// values for newly-toggled-on categories) lives in the exported helper
// functions below so they can be unit-tested without RTL.
//
// Contract:
//   const { preferences, byCategory, update, enable, disable, loading, error } =
//     useReminderPreferences()
//
// Behavior:
//   - Single round-trip on mount (and on user change).
//   - Toggle-off flips `enabled = false`. The row is NEVER deleted, so
//     the configured `lead_time_days` and `channel` are preserved for a
//     subsequent enable.
//   - Toggle-on of a brand-new category seeds defaults from
//     REMINDER_CATEGORIES[category].default_lead_time_days (channel
//     defaults to 'in_app' per Half 2 spec).
//   - Toggle-on of a previously-disabled category just flips
//     `enabled = true` and leaves the prior channel + lead_time_days
//     untouched.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { REMINDER_CATEGORIES } from '@/lib/reminderCategories'

// -----------------------------------------------------------------------------
// Pure ops (exported for testing).
//
// Each takes a supabase-client object so the test can pass in a mock.
// The hook calls them with the real client.
// -----------------------------------------------------------------------------

const PREFERENCES_TABLE = 'reminder_preferences'

/**
 * Default lead time for a given category. Falls back to 7 days when
 * the category is unknown (defensive — the catalog is the authority).
 *
 * @param {string} category
 * @returns {number}
 */
export function defaultLeadTimeFor(category) {
  const entry = REMINDER_CATEGORIES[category]
  if (entry && Number.isFinite(entry.default_lead_time_days)) {
    return entry.default_lead_time_days
  }
  return 7
}

/**
 * Compute the patch payload for toggling a category ON.
 *
 * @param {object|null} existing  The current preferences row, if any.
 * @param {number}      defaultLeadTimeDays
 * @returns {object}              { enabled, lead_time_days?, channel? }
 */
export function buildEnablePatch(existing, defaultLeadTimeDays) {
  if (existing) return { enabled: true }
  return {
    enabled: true,
    lead_time_days: Math.max(0, Math.min(365, Math.floor(defaultLeadTimeDays || 7))),
    channel: 'in_app',
  }
}

/**
 * Patch payload for toggling a category OFF. Preserves prior
 * lead_time_days + channel by NOT including them in the patch (the
 * upsert merges into the existing row).
 */
export function buildDisablePatch() {
  return { enabled: false }
}

/**
 * Build a `preferences -> { [category]: preferenceRow }` map for fast
 * lookup by the settings UI and the hook's `byCategory` consumer.
 *
 * @param {object[]} preferences
 * @returns {object}
 */
export function byCategoryMap(preferences) {
  const map = {}
  for (const p of preferences || []) {
    if (p && p.category) map[p.category] = p
  }
  return map
}

/**
 * Fetch every reminder_preferences row for a provider in one round-trip.
 *
 * @param {object} supabaseClient
 * @param {string} providerId
 * @returns {Promise<object[]>}
 */
export async function fetchPreferences(supabaseClient, providerId) {
  const { data, error } = await supabaseClient
    .from(PREFERENCES_TABLE)
    .select('id, category, channel, lead_time_days, enabled, created_at, updated_at')
    .eq('provider_id', providerId)
  if (error) throw error
  return Array.isArray(data) ? data : []
}

/**
 * Upsert one preference row by (provider_id, category). Returns the
 * row PostgREST returns (the merged final state).
 *
 * @param {object} supabaseClient
 * @param {string} providerId
 * @param {string} category
 * @param {object} patch        partial row — channel / lead_time_days /
 *                              enabled. provider_id and category are
 *                              filled in for the upsert payload.
 * @returns {Promise<object>}
 */
export async function upsertPreference(supabaseClient, providerId, category, patch) {
  const payload = {
    provider_id: providerId,
    category,
    ...patch,
  }
  const { data, error } = await supabaseClient
    .from(PREFERENCES_TABLE)
    .upsert(payload, { onConflict: 'provider_id,category' })
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Replace a row in a preferences array, or append if not yet present.
 *
 * @param {object[]} prev
 * @param {object}   updated   The new row (must carry `category`).
 * @returns {object[]}
 */
export function replacePreference(prev, updated) {
  if (!updated || !updated.category) return prev
  const list = Array.isArray(prev) ? prev : []
  const idx = list.findIndex(p => p && p.category === updated.category)
  if (idx === -1) return [...list, updated]
  const next = list.slice()
  next[idx] = updated
  return next
}

// -----------------------------------------------------------------------------
// The hook.
// -----------------------------------------------------------------------------

export function useReminderPreferences() {
  const { user } = useAuth()
  const [preferences, setPreferences] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setPreferences([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    fetchPreferences(supabase, user.id)
      .then(rows => { if (!cancelled) setPreferences(rows) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err : new Error(String(err))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user?.id])

  const byCategory = useMemo(() => byCategoryMap(preferences), [preferences])

  // `update` accepts any partial patch (e.g. just { channel: 'email' })
  // and applies optimistic state with rollback on error. The caller does
  // not need to await — but may, to learn whether the write succeeded.
  const update = useCallback(async (category, patch) => {
    if (!user) return null
    const prior = byCategoryMap(preferences)[category] || null

    // Optimistic local merge so the settings UI feels instant.
    const optimistic = { ...(prior || {}), provider_id: user.id, category, ...patch }
    setPreferences(prev => replacePreference(prev, optimistic))

    try {
      const updated = await upsertPreference(supabase, user.id, category, patch)
      if (updated) setPreferences(prev => replacePreference(prev, updated))
      return updated
    } catch (err) {
      // Rollback the optimistic write.
      if (prior) {
        setPreferences(prev => replacePreference(prev, prior))
      } else {
        setPreferences(prev => (Array.isArray(prev) ? prev.filter(p => p && p.category !== category) : prev))
      }
      setError(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }, [user, preferences])

  const enable = useCallback((category) => {
    const existing = byCategoryMap(preferences)[category] || null
    const patch = buildEnablePatch(existing, defaultLeadTimeFor(category))
    return update(category, patch)
  }, [preferences, update])

  const disable = useCallback((category) => {
    return update(category, buildDisablePatch())
  }, [update])

  return { preferences, byCategory, update, enable, disable, loading, error }
}
