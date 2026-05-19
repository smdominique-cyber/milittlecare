import { useState, useEffect, createContext, useContext } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'

const RoleContext = createContext({
  role: 'licensee',
  licenseeId: null,
  isLicensee: true,
  isCoProvider: false,
  isDailyHelper: false,
  isViewOnly: false,
  is18OrOlder: true,
  loading: true,
})

export function RoleProvider({ children }) {
  const { user } = useAuth()
  const [role, setRole] = useState('licensee')
  const [licenseeId, setLicenseeId] = useState(null)
  const [is18OrOlder, setIs18OrOlder] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setRole('licensee')
      setLicenseeId(null)
      setIs18OrOlder(true)
      setLoading(false)
      return
    }
    loadRole()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function loadRole() {
    setLoading(true)
    const { data: memberships } = await supabase
      .from('staff_memberships')
      .select('licensee_id, role, status, is_18_or_older')
      .eq('staff_user_id', user.id)
      .eq('status', 'active')
      .limit(1)

    if (memberships && memberships.length > 0) {
      setRole(memberships[0].role)
      setLicenseeId(memberships[0].licensee_id)
      setIs18OrOlder(memberships[0].is_18_or_older ?? true)
    } else {
      setRole('licensee')
      setLicenseeId(user.id)
      setIs18OrOlder(true)
    }
    setLoading(false)
  }

  const value = {
    role,
    licenseeId,
    is18OrOlder,
    isLicensee: role === 'licensee',
    isCoProvider: role === 'adult_staff',
    isDailyHelper: role === 'assistant',
    isViewOnly: role === 'view_only',
    // Legacy aliases — old code that references these still works
    isAdultStaff: role === 'adult_staff',
    isAssistant: role === 'assistant',
    loading,
    refresh: loadRole,
  }

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole() {
  return useContext(RoleContext)
}

// ─── Permission map ──────────────────────────────────────
//
// Internal DB role values → display labels:
//   licensee     → "Licensee" (the owner)
//   adult_staff  → "Co-Provider" (full trust, no subscription access)
//   assistant    → "Daily Helper" (no financial access)
//   view_only    → "View-only" (read-only)
//
// Medication permission depends on is_18_or_older flag, NOT role —
// use hasMedicationPermission() instead of PERMISSIONS for that.
//
export const PERMISSIONS = {
  // Licensee-only
  manage_subscription:    ['licensee'],
  manage_business_info:   ['licensee'],
  manage_staff:           ['licensee'],

  // Financial — Licensee + Co-Provider only
  manage_billing:         ['licensee', 'adult_staff'],
  send_invoices:          ['licensee', 'adult_staff'],
  manage_receipts:        ['licensee', 'adult_staff'],

  // Family management — Licensee + Co-Provider
  manage_families:        ['licensee', 'adult_staff'],

  // Daily ops — everyone except view_only
  log_attendance:         ['licensee', 'adult_staff', 'assistant'],
  log_incidents:          ['licensee', 'adult_staff', 'assistant'],

  // Viewing financial data — Licensee + Co-Provider + View-only (for accountants)
  view_deductions:        ['licensee', 'adult_staff', 'view_only'],
  view_ts_ratio:          ['licensee', 'adult_staff', 'view_only'],

  // Viewing operational data — everyone
  view_dashboard:         ['licensee', 'adult_staff', 'assistant', 'view_only'],
  view_families:          ['licensee', 'adult_staff', 'assistant', 'view_only'],
  view_business_info:     ['licensee', 'adult_staff', 'assistant', 'view_only'],
  view_messages:          ['licensee', 'adult_staff', 'assistant'],
}

export function hasPermission(role, action) {
  const allowed = PERMISSIONS[action]
  if (!allowed) return false
  return allowed.includes(role)
}

/**
 * Medication permission is special — it depends on the staff member's age,
 * not their role tier. Michigan R 400.1931(1) prohibits a child care
 * assistant (a 14–15-year-old) from administering medication.
 *
 * Daily Helper who is 18+ → can log medication.
 * Daily Helper who is under 18 → cannot.
 * Co-Provider (always 18+ in practice) → can log medication.
 */
export function hasMedicationPermission(role, is18OrOlder) {
  if (role === 'view_only') return false
  if (role === 'licensee') return true  // licensees are always adults
  return !!is18OrOlder
}
