// PR #16 third pass — parent-side wiring for the
// `intake_acknowledgment_pending` reminder loop.
//
// The provider triggers a reminder via the SECURITY DEFINER RPC
// `reminder_instance_request_intake_ack` (migration 024). The hourly
// dispatcher fires it once (see api/cron-dispatch-reminders.js:252 —
// the fire-selection query requires `fired_at IS NULL`, so a row that
// has already fired is not re-picked until it is resolved). The
// parent then visits /parent/intake-acknowledge?child=<id>; this
// module is how the page (a) discovers which reminder rows belong to
// the calling parent, and (b) resolves them once the parent confirms.
//
// Both helpers go through SECURITY DEFINER RPCs because parents have
// no SELECT or UPDATE policy on `reminder_instances` directly. A
// previous pass attempted a direct `.from('reminder_instances')
// .select(...)` and the SELECT silently returned zero rows under RLS,
// leaving the resolve loop unreachable. This module fixes that.
//
// Pure-ish: each function takes an injected supabase client so the
// test file can hand in a mock. Real callers pass `supabase` from
// `src/lib/supabase.js`.

const LIST_RPC    = 'reminder_instance_list_for_parent'
const RESOLVE_RPC = 'reminder_instance_resolve_for_parent'

/**
 * Fetch the calling parent's pending intake-acknowledgment reminders
 * and group them by `subject_id` (the child id).
 *
 * Server-side guard (migration 024 — `reminder_instance_list_for_parent`):
 *   - category   = 'intake_acknowledgment_pending'
 *   - subject_type = 'child'
 *   - subject_id   linked to auth.uid() via active parent_family_links
 *   - resolved_at  IS NULL
 *   - archived_at  IS NULL
 *
 * Always returns a plain object — never throws. The page treats a
 * failed list as "nothing to resolve" (non-fatal: the acks themselves
 * still land, the dispatcher is fire-once so no re-fire loop).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {Promise<{ pendingByChild: Record<string, string[]>, error: any }>}
 */
export async function listPendingForParent(supabaseClient) {
  const pendingByChild = {}
  try {
    const { data, error } = await supabaseClient.rpc(LIST_RPC)
    if (error) {
      return { pendingByChild, error }
    }
    if (!Array.isArray(data)) {
      return { pendingByChild, error: null }
    }
    for (const row of data) {
      if (!row || !row.subject_id || !row.id) continue
      const list = pendingByChild[row.subject_id] || (pendingByChild[row.subject_id] = [])
      list.push(row.id)
    }
    return { pendingByChild, error: null }
  } catch (err) {
    return { pendingByChild, error: err }
  }
}

/**
 * Resolve every pending reminder for one child. Calls the parent-scoped
 * resolve RPC once per id; failures are collected but never thrown
 * (the parent's ack rows have already been written, so a failed resolve
 * is stale-row hygiene, not a data-loss bug).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @param {Record<string, string[]>} pendingByChild
 * @param {string} childId
 * @returns {Promise<{ resolved: number, failures: Array<{ id: string, error: any }> }>}
 */
export async function resolvePendingForChild(supabaseClient, pendingByChild, childId) {
  const ids = (pendingByChild && pendingByChild[childId]) || []
  let resolved = 0
  const failures = []
  for (const id of ids) {
    try {
      const { error } = await supabaseClient.rpc(RESOLVE_RPC, { p_instance_id: id })
      if (error) {
        failures.push({ id, error })
      } else {
        resolved += 1
      }
    } catch (err) {
      failures.push({ id, error: err })
    }
  }
  return { resolved, failures }
}

// Exported for the test file so the assertions reference the same
// strings the production code passes to supabase.rpc.
export const RPC_NAMES = Object.freeze({ list: LIST_RPC, resolve: RESOLVE_RPC })
