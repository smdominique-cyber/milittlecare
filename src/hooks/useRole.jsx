import { useState, useEffect, createContext, useContext } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'

const RoleContext = createContext({
  role: 'licensee',
  licenseeId: null,
  isLicensee: true,
  isAdultStaff: false,
  isAssistant: false,
  isViewOnly: false,
  loading: true,
})

export function RoleProvider({ children }) {
  const { user } = useAuth()
  const [role, setRole] = useState('licensee')
  const [licenseeId, setLicenseeId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setRole('licensee')
      setLicenseeId(null)
      setLoading(false)
      return
    }
    loadRole()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function loadRole() {
    setLoading(true)
    // Check if this user is staff for some licensee
    const { data: memberships } = await supabase
      .from('staff_memberships')
      .select('licensee_id, role, status')
      .eq('staff_user_id', user.id)
      .eq('status', 'active')
      .limit(1)

    if (memberships && memberships.length > 0) {
      // User is staff
      setRole(memberships[0].role)
      setLicenseeId(memberships[0].licensee_id)
    } else {
      // User is the licensee themselves
      setRole('licensee')
      setLicenseeId(user.id)
    }
    setLoading(false)
  }

  const value = {
    role,
    licenseeId,
    isLicensee: role === 'licensee',
    isAdultStaff: role === 'adult_staff',
    isAssistant: role === 'assistant',
    isViewOnly: role === 'view_only',
    loading,
    refresh: loadRole,
  }

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole() {
  return useContext(RoleContext)
}

// Helper: can the current user perform this action?
export const PERMISSIONS = {
  // Billing / subscription / settings = Licensee only
  manage_billing: ['licensee'],
  manage_subscription: ['licensee'],
  manage_business_info: ['licensee'],
  manage_staff: ['licensee'],

  // Family management = Licensee + Adult Staff
  manage_families: ['licensee', 'adult_staff'],
  send_invoices: ['licensee', 'adult_staff'],

  // Daily ops = all except view_only
  log_attendance: ['licensee', 'adult_staff', 'assistant'],
  log_medication: ['licensee', 'adult_staff'],  // NOT assistant per Michigan rules
  log_incidents: ['licensee', 'adult_staff'],

  // Tax tools (financial) = Licensee + Adult Staff
  manage_receipts: ['licensee', 'adult_staff'],
  view_deductions: ['licensee', 'adult_staff', 'view_only'],

  // View everything = all roles
  view_dashboard: ['licensee', 'adult_staff', 'assistant', 'view_only'],
  view_families: ['licensee', 'adult_staff', 'assistant', 'view_only'],
  view_business_info: ['licensee', 'adult_staff', 'assistant', 'view_only'],
}

export function hasPermission(role, action) {
  const allowed = PERMISSIONS[action]
  if (!allowed) return false
  return allowed.includes(role)
}
