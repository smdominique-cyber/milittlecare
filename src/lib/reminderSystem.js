// Audit-state helper for the reminder system (PR #15 Half 1).
//
// Per the cross-cutting audit-state mandate (CLAUDE.md § Critical Domain
// Knowledge + PR #15 scope § B.3a), every domain PR ships a
// `getXxxAuditState(licensee_id)` pure helper consumed by the future
// PR #22 (Compliance Health Score). For PR #15 the helper reports
// reminder-system state for the given provider: how many preferences
// they have configured, how many instances are pending vs overdue, and
// when the dispatcher last delivered to them.
//
// Read-only. Single Supabase round-trip-set; tolerates the schema not
// being applied yet (this PR is Half 1; the user applies migration 023
// manually before Half 2). When the tables don't exist, the helper
// returns the empty/zero state without throwing - same shape, just
// zeros - so the dashboard can call it before Half 2 lands.

import { supabase } from './supabase'

/**
 * Return a structured signal-object describing the provider's
 * reminder-system state. Consumed by PR #22 to compose the unified
 * compliance health score (Type 2 - MILittleCare-owned data, counted
 * by default).
 *
 * @param {string} licenseeId   auth user id (the provider).
 * @returns {Promise<object>}
 */
export async function getReminderSystemAuditState(licenseeId) {
  const empty = {
    domain: 'reminder_system',
    type: 'type_2',
    preferences_configured_count: 0,
    pending_instances_count: 0,
    overdue_instances_count: 0,
    last_dispatch_at: null,
    email_channel_enabled: false,
  }

  if (!licenseeId) return empty

  // Preferences: how many categories has the provider opted in to?
  // Only `enabled = true` rows count toward the configured-count.
  // `email_channel_enabled` is true if any enabled preference selects
  // 'email' or 'both' (drives the future "set up email" nudge in
  // PR #22).
  let preferences = []
  try {
    const { data, error } = await supabase
      .from('reminder_preferences')
      .select('category, channel, enabled')
      .eq('provider_id', licenseeId)
    if (error) {
      // Defensive: if the table doesn't exist yet (Half 1 not applied),
      // PostgREST returns an error; fall back to the empty state
      // instead of crashing the dashboard.
      return empty
    }
    preferences = Array.isArray(data) ? data : []
  } catch {
    return empty
  }

  const enabledPrefs = preferences.filter(p => p && p.enabled)
  const preferences_configured_count = enabledPrefs.length
  const email_channel_enabled = enabledPrefs.some(
    p => p.channel === 'email' || p.channel === 'both'
  )

  // Instances: pending = active (not dismissed/resolved/archived), and
  // overdue = the subset of pending where trigger_at <= now.
  let pendingRows = []
  try {
    const { data, error } = await supabase
      .from('reminder_instances')
      .select('trigger_at')
      .eq('provider_id', licenseeId)
      .is('dismissed_at', null)
      .is('resolved_at', null)
      .is('archived_at', null)
    if (error) {
      return {
        ...empty,
        preferences_configured_count,
        email_channel_enabled,
      }
    }
    pendingRows = Array.isArray(data) ? data : []
  } catch {
    return {
      ...empty,
      preferences_configured_count,
      email_channel_enabled,
    }
  }

  const nowMs = Date.now()
  const pending_instances_count = pendingRows.length
  const overdue_instances_count = pendingRows.filter(r => {
    const t = r && r.trigger_at ? Date.parse(r.trigger_at) : NaN
    return Number.isFinite(t) && t <= nowMs
  }).length

  // Last dispatch: most recent notification_log row for this provider
  // whose change_type begins with 'reminder_' (the dispatcher's
  // change_type convention; Half 2 writes one row per fired instance).
  // notification_log is the existing production table reused by PR #12;
  // its shape is recipient_type/recipient_id + change_type + email_sent.
  // We filter loosely so the Half-2 wire-up has freedom to pick the
  // exact change_type string.
  let last_dispatch_at = null
  try {
    const { data, error } = await supabase
      .from('notification_log')
      .select('email_sent_at')
      .eq('recipient_type', 'provider')
      .eq('recipient_id', licenseeId)
      .like('change_type', 'reminder_%')
      .order('email_sent_at', { ascending: false })
      .limit(1)
    if (!error && Array.isArray(data) && data.length > 0) {
      last_dispatch_at = data[0].email_sent_at || null
    }
  } catch {
    // Non-fatal: leave null.
  }

  return {
    domain: 'reminder_system',
    type: 'type_2',
    preferences_configured_count,
    pending_instances_count,
    overdue_instances_count,
    last_dispatch_at,
    email_channel_enabled,
  }
}
