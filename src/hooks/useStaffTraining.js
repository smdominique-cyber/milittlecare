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
      // Ensure the licensee has their own caregiver row. The
      // unique (licensee_id, app_user_id) constraint makes this safe to
      // attempt — a duplicate insert is rejected, not duplicated.
      if (isLicensee) {
        const { data: self, error: selfErr } = await supabase
          .from('caregivers')
          .select('id')
          .eq('licensee_id', user.id)
          .eq('app_user_id', user.id)
          .maybeSingle()
        if (selfErr) throw selfErr
        if (!self) {
          const { error: insErr } = await supabase.from('caregivers').insert({
            licensee_id: user.id,
            app_user_id: user.id,
            full_name:
              user.user_metadata?.full_name || user.email || 'You (licensee)',
          })
          if (insErr) throw insErr
        }
      }

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
