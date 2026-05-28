// PR #15 Half 2 — example per-category scheduler shim.
//
// Implements the contract that future per-category schedulers
// (PR #18 CPR / physician attestation, PR #19 drills, PR #20 medication
// authorizations, PR #21 radon / heating / detectors) will follow.
//
// Responsibility: for each opted-in LEP provider with
// `miregistry_annual_training` enabled, compute the next December 16
// deadline from miregistry_training_entries and ensure exactly one
// reminder_instances row exists pointing at it (idempotent
// re-run-safe).
//
// The existing AnnualTrainingBanner remains in place; this scheduler
// writes parallel instances that the new ReminderBanners host
// renders. Consolidation (one source-of-truth banner) is a follow-up
// PR per OQ4 resolution.
//
// IMPORTANT: this module is consumed by the dispatcher cron
// (api/cron-dispatch-reminders.js), which runs in a Vercel Edge or
// Node serverless environment with the Supabase service-role key.
// It does NOT use the browser supabase client (no auth.uid()).
// Callers pass a service-role-capable client (or a PostgREST-style
// wrapper) explicitly.

import { todayYMD, yearOfYMD, daysBetweenYMD } from '@/lib/dates'
import { REMINDER_CATEGORIES } from '@/lib/reminderCategories'

const CATEGORY = 'miregistry_annual_training'

// Dec 16 each year is the MiRegistry training deadline per CDC
// Scholarship Handbook for License Exempt Provider. Same constants
// as cdcProviderCompliance.js's ANNUAL_TRAINING_DEADLINE_*.
const DEADLINE_MONTH = 12
const DEADLINE_DAY = 16

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing)
// -----------------------------------------------------------------------------

/**
 * Build the YMD for the Dec 16 deadline in a given year.
 *
 * @param {number} year
 * @returns {string}
 */
export function deadlineFor(year) {
  return `${year}-${String(DEADLINE_MONTH).padStart(2, '0')}-${String(DEADLINE_DAY).padStart(2, '0')}`
}

/**
 * Compute the next applicable deadline given today.
 *
 * If today is on or before Dec 16, returns this year's Dec 16. Otherwise
 * returns next year's Dec 16. (After the deadline passes the provider's
 * account is at risk per the handbook; the scheduler still posts a
 * reminder for next year so the banner host has something to render
 * until the provider clears the lapsed state out-of-band.)
 *
 * @param {string} today  'YYYY-MM-DD'
 * @returns {string}
 */
export function nextDeadline(today) {
  const year = yearOfYMD(today)
  const thisYearsDeadline = deadlineFor(year)
  return daysBetweenYMD(today, thisYearsDeadline) >= 0
    ? thisYearsDeadline
    : deadlineFor(year + 1)
}

/**
 * Compute the trigger date (when the dispatcher should fire) given the
 * deadline and the provider's configured lead_time_days. Clamps to
 * `today` if the lead window has already started (i.e. the scheduler
 * is catching up; the dispatcher fires immediately on the next tick).
 *
 * @param {string} deadline       'YYYY-MM-DD'
 * @param {number} leadTimeDays
 * @param {string} today          'YYYY-MM-DD'
 * @returns {string}              'YYYY-MM-DD'
 */
export function triggerYMD(deadline, leadTimeDays, today) {
  const lead = Math.max(0, Math.floor(Number(leadTimeDays) || 0))
  const daysUntil = daysBetweenYMD(today, deadline)
  if (daysUntil <= lead) return today
  // Otherwise, trigger at deadline - lead.
  // We can't easily add negative days to a YMD here without re-deriving;
  // use Date arithmetic via UTC to avoid DST.
  const [y, m, d] = deadline.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) - lead * 86400000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * Build the reminder_instances payload for a provider's annual-training
 * deadline. Pure — no I/O.
 *
 * @param {string} providerId
 * @param {string} deadlineYmd
 * @param {string} triggerAtYmd
 * @returns {object}
 */
export function buildInstancePayload(providerId, deadlineYmd, triggerAtYmd) {
  const catalog = REMINDER_CATEGORIES[CATEGORY]
  return {
    provider_id: providerId,
    category: CATEGORY,
    subject_type: null,
    subject_id: null,
    trigger_at: `${triggerAtYmd}T08:00:00.000Z`,
    due_at: `${deadlineYmd}T23:59:00.000Z`,
    title: catalog?.label || 'Annual Ongoing Training due',
    body:
      'The Michigan Ongoing Health and Safety Refresher is due by ' +
      'December 16. Missing the deadline puts your provider account at risk ' +
      '(CDC Scholarship Handbook for License Exempt Provider). Log the ' +
      'completion in MiRegistry, then record it on the MiRegistry page in ' +
      'MILittleCare.',
    cta_path: '/miregistry',
  }
}

// -----------------------------------------------------------------------------
// Eligibility (pure, given input rows)
// -----------------------------------------------------------------------------

/**
 * Decide whether a given LEP provider needs a reminder for
 * `miregistry_annual_training`. They do iff:
 *   - their license_type is 'license_exempt' (LEP-only category)
 *   - they have NOT already completed annual_ongoing training for the
 *     current calendar year (the deadline year).
 *
 * The completion check accepts a list of miregistry_training_entries
 * rows for the provider, of source 'annual_ongoing'.
 *
 * @param {object}   provider
 * @param {object[]} annualOngoingEntries
 * @param {string}   today
 * @returns {boolean}
 */
export function providerNeedsReminder(provider, annualOngoingEntries, today) {
  if (!provider || provider.license_type !== 'license_exempt') return false
  const deadlineYear = yearOfYMD(nextDeadline(today))
  const completedThisCycle = (annualOngoingEntries || []).some(
    e => e && e.completed_on && yearOfYMD(e.completed_on) === deadlineYear
  )
  return !completedThisCycle
}

// -----------------------------------------------------------------------------
// Orchestrator (the side-effecting function the dispatcher calls)
// -----------------------------------------------------------------------------

/**
 * Schedule reminder_instances for every opted-in license-exempt
 * provider with `miregistry_annual_training` enabled. Idempotent: a
 * second call in the same cycle is a no-op because the unique partial
 * indexes prevent duplicates and we pre-check before insert.
 *
 * Implementation talks to Supabase via the PostgREST builder shape
 * (same as the rest of the lib). The dispatcher passes either the
 * service-role client or a thin REST wrapper exposing the same
 * `.from(table).select()…` surface.
 *
 * @param {object} supabaseClient
 * @param {string} [today]   YMD; defaults to today's local date.
 * @returns {Promise<{providersChecked: number, instancesInserted: number, instancesSkipped: number}>}
 */
export async function scheduleMiregistryAnnualTrainingReminders(supabaseClient, today) {
  const t = today || todayYMD()
  const deadline = nextDeadline(t)

  const stats = {
    providersChecked: 0,
    instancesInserted: 0,
    instancesSkipped: 0,
  }

  // 1) Find every active opt-in for this category.
  const prefsResp = await supabaseClient
    .from('reminder_preferences')
    .select('provider_id, lead_time_days, enabled')
    .eq('category', CATEGORY)
    .eq('enabled', true)
  if (prefsResp.error) throw prefsResp.error
  const prefs = Array.isArray(prefsResp.data) ? prefsResp.data : []
  if (prefs.length === 0) return stats

  const providerIds = prefs.map(p => p.provider_id)
  const leadByProvider = new Map(prefs.map(p => [p.provider_id, p.lead_time_days ?? 45]))

  // 2) Filter to LEP providers (the category is LEP-only).
  const profilesResp = await supabaseClient
    .from('profiles')
    .select('id, license_type')
    .in('id', providerIds)
  if (profilesResp.error) throw profilesResp.error
  const profiles = Array.isArray(profilesResp.data) ? profilesResp.data : []
  const lepIds = profiles
    .filter(p => p && p.license_type === 'license_exempt')
    .map(p => p.id)
  if (lepIds.length === 0) return stats

  // 3) Pull each provider's annual_ongoing entries for the deadline year.
  const deadlineYear = yearOfYMD(deadline)
  const yearStart = `${deadlineYear}-01-01`
  const yearEnd = `${deadlineYear}-12-31`
  const entriesResp = await supabaseClient
    .from('miregistry_training_entries')
    .select('user_id, completed_on, source, archived_at')
    .in('user_id', lepIds)
    .eq('source', 'annual_ongoing')
    .is('archived_at', null)
    .gte('completed_on', yearStart)
    .lte('completed_on', yearEnd)
  if (entriesResp.error) throw entriesResp.error
  const entries = Array.isArray(entriesResp.data) ? entriesResp.data : []
  const entriesByUser = new Map()
  for (const e of entries) {
    const list = entriesByUser.get(e.user_id) || []
    list.push(e)
    entriesByUser.set(e.user_id, list)
  }

  for (const providerId of lepIds) {
    stats.providersChecked += 1
    const provider = profiles.find(p => p.id === providerId)
    const needs = providerNeedsReminder(provider, entriesByUser.get(providerId), t)
    if (!needs) {
      stats.instancesSkipped += 1
      continue
    }

    const leadTimeDays = leadByProvider.get(providerId) ?? 45
    const triggerYmd = triggerYMD(deadline, leadTimeDays, t)
    const payload = buildInstancePayload(providerId, deadline, triggerYmd)

    // 4) Check for an existing pending instance for this
    //    (provider, category, trigger_at). The unique partial index
    //    in migration 023 enforces this at the DB level too; we
    //    pre-check so we can report stats and avoid a 409 round-trip.
    const existingResp = await supabaseClient
      .from('reminder_instances')
      .select('id')
      .eq('provider_id', providerId)
      .eq('category', CATEGORY)
      .is('subject_id', null)
      .eq('trigger_at', payload.trigger_at)
      .is('archived_at', null)
      .limit(1)
    if (existingResp.error) throw existingResp.error
    const existing = Array.isArray(existingResp.data) ? existingResp.data : []
    if (existing.length > 0) {
      stats.instancesSkipped += 1
      continue
    }

    const insertResp = await supabaseClient
      .from('reminder_instances')
      .insert(payload)
    if (insertResp.error) throw insertResp.error
    stats.instancesInserted += 1
  }

  return stats
}
