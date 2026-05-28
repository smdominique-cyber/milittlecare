// PR #15 Half 2 — hook + pure ops for surfacing active reminder
// instances on the dashboard banner stack.
//
// "Active" means: fired by the dispatcher (`fired_at IS NOT NULL`),
// not yet dismissed (`dismissed_at IS NULL`), not yet resolved
// (`resolved_at IS NULL`), and not soft-archived (`archived_at IS NULL`).
//
// Mutations: the provider can dismiss or resolve an instance. Both go
// through the SECURITY DEFINER RPCs created by migration 023
// (`reminder_instance_dismiss`, `reminder_instance_resolve`) rather than
// direct UPDATE statements. The RPCs enforce ownership server-side via
// `auth.uid()`.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'

// -----------------------------------------------------------------------------
// Pure ops (exported for testing).
// -----------------------------------------------------------------------------

const INSTANCES_TABLE = 'reminder_instances'
const DISMISS_RPC = 'reminder_instance_dismiss'
const RESOLVE_RPC = 'reminder_instance_resolve'

/**
 * Fetch every active reminder instance for a provider.
 *
 * @param {object} supabaseClient
 * @param {string} providerId
 * @returns {Promise<object[]>}
 */
export async function fetchActiveReminders(supabaseClient, providerId) {
  const { data, error } = await supabaseClient
    .from(INSTANCES_TABLE)
    .select(
      'id, category, subject_type, subject_id, ' +
      'trigger_at, due_at, title, body, cta_path, ' +
      'fired_at, fired_via'
    )
    .eq('provider_id', providerId)
    .not('fired_at', 'is', null)
    .is('dismissed_at', null)
    .is('resolved_at', null)
    .is('archived_at', null)
    .order('trigger_at', { ascending: false })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

/**
 * Call the dismiss RPC. RPC is a no-op if the instance does not belong
 * to the calling user or is already dismissed (see migration 023).
 *
 * @param {object} supabaseClient
 * @param {string} instanceId
 * @returns {Promise<void>}
 */
export async function callDismissRpc(supabaseClient, instanceId) {
  const { error } = await supabaseClient.rpc(DISMISS_RPC, {
    p_instance_id: instanceId,
  })
  if (error) throw error
}

/**
 * Call the resolve RPC. Same ownership / idempotency semantics as
 * dismiss (see migration 023).
 */
export async function callResolveRpc(supabaseClient, instanceId) {
  const { error } = await supabaseClient.rpc(RESOLVE_RPC, {
    p_instance_id: instanceId,
  })
  if (error) throw error
}

/**
 * Remove an instance from a list by id. Used by the hook for
 * optimistic local state when a dismiss / resolve succeeds.
 *
 * @param {object[]} list
 * @param {string}   instanceId
 * @returns {object[]}
 */
export function removeInstanceById(list, instanceId) {
  if (!Array.isArray(list)) return []
  return list.filter(r => r && r.id !== instanceId)
}

// -----------------------------------------------------------------------------
// The hook.
// -----------------------------------------------------------------------------

export function useActiveReminders() {
  const { user } = useAuth()
  const [instances, setInstances] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!user) {
      setInstances([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    fetchActiveReminders(supabase, user.id)
      .then(rows => { if (!cancelled) setInstances(rows) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err : new Error(String(err))) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user?.id])

  const dismiss = useCallback(async (instanceId) => {
    if (!instanceId) return
    // Optimistic remove + rollback on error keeps the banner click
    // feeling instant. The RPC is idempotent so a stale re-call is
    // harmless.
    const prior = instances
    setInstances(prev => removeInstanceById(prev, instanceId))
    try {
      await callDismissRpc(supabase, instanceId)
    } catch (err) {
      setInstances(prior)
      setError(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }, [instances])

  const resolve = useCallback(async (instanceId) => {
    if (!instanceId) return
    const prior = instances
    setInstances(prev => removeInstanceById(prev, instanceId))
    try {
      await callResolveRpc(supabase, instanceId)
    } catch (err) {
      setInstances(prior)
      setError(err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }, [instances])

  return { instances, loading, error, dismiss, resolve }
}
