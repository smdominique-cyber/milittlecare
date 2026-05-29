// PR #16 — Annual-review reminder scheduler for PR #15.
//
// Per the scope's § B.4: insert a reminder_instances row 30 days before
// each child's `records_last_reviewed_on + 1 year` (or, for never-reviewed
// children, 30 days after `intake_completed_at`). Provider opens the
// intake form -> updates records_last_reviewed_on -> the reminder is
// satisfied (next tick computes a new trigger and inserts a fresh one).
//
// Same contract as PR #15's miregistryAnnualTrainingScheduler: a single
// exported function the dispatcher cron calls hourly. Idempotent — the
// unique partial indexes on reminder_instances prevent double-inserts
// AND we pre-check before insert to keep stats clean.
//
// Per the Edge-bundling guardrail (PR #15 lesson), this module is on
// the api/cron-dispatch-reminders.js import chain and so uses relative
// paths with explicit .js extensions instead of Vite '@/' aliases.

import { todayYMD, daysBetweenYMD } from '../dates.js'
import { REMINDER_CATEGORIES } from '../reminderCategories.js'

const CATEGORY = 'child_annual_review'

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing)
// -----------------------------------------------------------------------------

/**
 * Compute the next due date for a child's annual records review.
 *
 * @param {object} child   { records_last_reviewed_on, intake_completed_at }
 * @param {string} today   YMD
 * @returns {string|null}  YMD of the next-due review, or null when there
 *                          is no review timeline yet (child has neither
 *                          a prior review nor an intake completion).
 */
export function nextReviewDueDate(child, today) {
  if (!child) return null
  if (child.records_last_reviewed_on) {
    return addYearsYMD(child.records_last_reviewed_on, 1)
  }
  if (child.intake_completed_at) {
    // Anchor on intake completion date; reviews start one year from then.
    const intakeYmd = String(child.intake_completed_at).slice(0, 10)
    return addYearsYMD(intakeYmd, 1)
  }
  return null
}

/**
 * Compute the trigger date (when the dispatcher should fire). Clamps to
 * `today` if the lead window has already opened (the dispatcher then
 * fires immediately on the next tick).
 *
 * @param {string} dueYmd
 * @param {number} leadTimeDays
 * @param {string} today
 * @returns {string}
 */
export function triggerYMD(dueYmd, leadTimeDays, today) {
  const lead = Math.max(0, Math.floor(Number(leadTimeDays) || 0))
  const daysUntil = daysBetweenYMD(today, dueYmd)
  if (daysUntil <= lead) return today
  const [y, m, d] = dueYmd.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) - lead * 86400000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * Build the reminder_instances payload for a child's annual review.
 *
 * @param {string} providerId
 * @param {object} child
 * @param {string} dueYmd
 * @param {string} triggerAtYmd
 * @returns {object}
 */
export function buildInstancePayload(providerId, child, dueYmd, triggerAtYmd) {
  const catalog = REMINDER_CATEGORIES[CATEGORY]
  const firstName = child.first_name || 'this child'
  return {
    provider_id: providerId,
    category: CATEGORY,
    subject_type: 'child',
    subject_id: child.id,
    trigger_at: `${triggerAtYmd}T08:00:00.000Z`,
    due_at: `${dueYmd}T23:59:00.000Z`,
    title: catalog?.label || 'Annual child-records review due',
    body:
      `Time to review ${firstName}'s records (immunization, allergies, ` +
      `parent contact, intake disclosures). Per R 400.1907, child records ` +
      `must be reviewed at least once a year.`,
    cta_path: '/families',
  }
}

function addYearsYMD(ymd, years) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const target = new Date(Date.UTC(y + years, m - 1, 1))
  const ty = target.getUTCFullYear()
  const tm = target.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  const td = Math.min(d, lastDay)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------------

/**
 * Schedule reminder_instances rows for the annual records review of
 * every opted-in licensee's active children. Idempotent: re-running in
 * the same cycle does not double-insert.
 *
 * @param {object} supabaseClient
 * @param {string} [today]
 * @returns {Promise<{providersChecked: number, childrenChecked: number, instancesInserted: number, instancesSkipped: number}>}
 */
export async function scheduleChildAnnualReviewReminders(supabaseClient, today) {
  const t = today || todayYMD()
  const stats = {
    providersChecked: 0,
    childrenChecked: 0,
    instancesInserted: 0,
    instancesSkipped: 0,
  }

  // 1) Find every active opt-in for this category.
  const prefsResp = await supabaseClient
    .from('reminder_preferences')
    .select('provider_id, lead_time_days, enabled, category')
    .eq('category', CATEGORY)
    .eq('enabled', true)
  if (prefsResp.error) throw prefsResp.error
  const prefs = Array.isArray(prefsResp.data) ? prefsResp.data : []
  if (prefs.length === 0) return stats

  const providerIds = prefs.map(p => p.provider_id)
  const leadByProvider = new Map(prefs.map(p => [p.provider_id, p.lead_time_days ?? 30]))

  // 2) Filter to licensed providers (family/group home). Child-files
  //    reminders only matter for licensed homes per constraint C.
  const profilesResp = await supabaseClient
    .from('profiles')
    .select('id, license_type')
    .in('id', providerIds)
  if (profilesResp.error) throw profilesResp.error
  const profiles = Array.isArray(profilesResp.data) ? profilesResp.data : []
  const licensedIds = profiles
    .filter(p => p && (p.license_type === 'family_home' || p.license_type === 'group_home'))
    .map(p => p.id)
  if (licensedIds.length === 0) return stats

  stats.providersChecked = licensedIds.length

  // 3) Pull active children for those providers.
  const childrenResp = await supabaseClient
    .from('children')
    .select('id, user_id, first_name, records_last_reviewed_on, intake_completed_at, archived_at')
    .in('user_id', licensedIds)
    .is('archived_at', null)
  if (childrenResp.error) throw childrenResp.error
  const children = Array.isArray(childrenResp.data) ? childrenResp.data : []
  stats.childrenChecked = children.length

  for (const child of children) {
    const providerId = child.user_id
    const dueYmd = nextReviewDueDate(child, t)
    if (!dueYmd) {
      stats.instancesSkipped += 1
      continue
    }
    const leadTimeDays = leadByProvider.get(providerId) ?? 30
    const triggerAtYmd = triggerYMD(dueYmd, leadTimeDays, t)
    const payload = buildInstancePayload(providerId, child, dueYmd, triggerAtYmd)

    // 4) Pre-check for an existing pending instance.
    const existingResp = await supabaseClient
      .from('reminder_instances')
      .select('id')
      .eq('provider_id', providerId)
      .eq('category', CATEGORY)
      .eq('subject_id', child.id)
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
