import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'

// Loads everything the Staff Training page needs in one place
// (docs/staff_training_tracking_spec.md § 2): the caregiver roster with
// regulatory roles attached, the per-caregiver training records, the
// verified requirement catalog (migration 013), and the licensee's
// health & safety update notices.
//
// Role-aware (spec § 3.1):
//   - licensee  → roster = every caregiver they own (caregivers.licensee_id)
//   - staff     → roster = their own caregiver row(s) (caregivers.app_user_id)
//
// "The licensee is themselves a caregiver" (spec § 4.1): on first load
// for a licensee we ensure a self-caregiver row exists so the dashboard
// can render their own training even before any staff are added.
//
// Returns { loading, error, isLicensee, roster, records, requirements,
//           updates, refresh }.
export function useStaffTraining() {
  const { user } = useAuth()
  const { isLicensee, loading: roleLoading } = useRole()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [roster, setRoster] = useState([])
  const [records, setRecords] = useState([])
  const [requirements, setRequirements] = useState([])
  const [updates, setUpdates] = useState([])

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // The licensee self-row used to be created HERE on page mount,
      // gated on isLicensee. As of 2026-06-18, the create lives at
      // onboarding completion (useOnboarding.js → persist on first
      // completed_at transition) and existing licensees were
      // backfilled by migration 046. This page now READS the roster
      // and trusts that the self-row is already present for any
      // licensee who has completed onboarding (or who was backfilled).
      //
      // If a licensee somehow lands here without a self-row (e.g.
      // an account that bypassed both onboarding AND the backfill —
      // not a path that exists in production today), the staff list
      // simply will not include them. That is a degraded display, not
      // a data corruption. Surfacing it explicitly would require
      // adding a second create path here, which would defeat the
      // single-create-path discipline; instead, the licenseeRoster
      // helper is callable from anywhere if a future need arises.
      // See src/lib/licenseeRoster.js for the canonical create.

      // The roster — scoped by role.
      const base = supabase.from('caregivers').select('*')
      const { data: caregivers, error: cgErr } = isLicensee
        ? await base.eq('licensee_id', user.id)
        : await base.eq('app_user_id', user.id)
      if (cgErr) throw cgErr

      const caregiverIds = (caregivers || []).map(c => c.id)
      const haveCaregivers = caregiverIds.length > 0

      const [rolesResp, recordsResp, reqResp, updatesResp] = await Promise.all([
        haveCaregivers
          ? supabase
              .from('caregiver_regulatory_roles')
              .select('*')
              .in('caregiver_id', caregiverIds)
          : Promise.resolve({ data: [], error: null }),
        haveCaregivers
          ? supabase
              .from('staff_training_records')
              .select('*')
              .in('caregiver_id', caregiverIds)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('training_requirements').select('*'),
        isLicensee
          ? supabase
              .from('health_safety_updates')
              .select('*')
              .eq('licensee_id', user.id)
          : Promise.resolve({ data: [], error: null }),
      ])
      if (rolesResp.error) throw rolesResp.error
      if (recordsResp.error) throw recordsResp.error
      if (reqResp.error) throw reqResp.error
      if (updatesResp.error) throw updatesResp.error

      // Attach each caregiver's regulatory roles to its roster row so
      // the compliance engine can roll requirements up per person.
      const rolesByCaregiver = new Map()
      for (const row of rolesResp.data || []) {
        const list = rolesByCaregiver.get(row.caregiver_id) || []
        list.push(row)
        rolesByCaregiver.set(row.caregiver_id, list)
      }
      const withRoles = (caregivers || []).map(c => ({
        ...c,
        regulatory_roles: rolesByCaregiver.get(c.id) || [],
      }))

      setRoster(withRoles)
      setRecords(recordsResp.data || [])
      setRequirements(reqResp.data || [])
      setUpdates(updatesResp.data || [])
    } catch (err) {
      console.error('useStaffTraining: load failed', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [user, isLicensee])

  useEffect(() => {
    // Wait for useRole to settle — isLicensee drives which rows load.
    if (roleLoading) return
    load()
  }, [load, roleLoading])

  return {
    loading: loading || roleLoading,
    error,
    isLicensee,
    roster,
    records,
    requirements,
    updates,
    refresh: load,
  }
}
