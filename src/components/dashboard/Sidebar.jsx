import { useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { useActiveModules } from '@/hooks/useActiveModules'
import { MODULE_KEYS } from '@/lib/modules'
import { supabase } from '@/lib/supabase'
import { InstallLink } from '@/components/ui/InstallBanner'
import {
  LayoutDashboard,
  Receipt,
  Calculator,
  Users,
  BarChart2,
  Settings,
  LogOut,
  Megaphone,
  DollarSign,
  CreditCard,
  Shield,
  Building2,
  UserCog,
  MessageSquare,
  MessageCircle,
  Calendar,
  CalendarClock,
  GraduationCap,
  ClipboardCheck,
  ClipboardList,
  FileSpreadsheet,
  UserCheck,
  BookOpen,
  Bell,
} from 'lucide-react'

function getInitials(name) {
  if (!name) return '?'
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default function Sidebar({ isOpen = false }) {
  const { user, signOut } = useAuth()
  const { role, isLicensee, licenseeId } = useRole()
  const { modules, profile } = useActiveModules()
  const navigate = useNavigate()
  const [messagingEnabled, setMessagingEnabled] = useState(false)
  // Phase 3 decision #8 — opt-in flag for the Compliance Checklist
  // sidebar entry. Absent → OFF (existing-provider default during
  // rollout); explicit true → ON (provider opted in via Business Info).
  const complianceChecklistEnabled =
    profile?.program_settings?.compliance_checklist_enabled === true

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'You'
  const email = user?.email || ''
  const initials = getInitials(fullName)

  // Check whether messaging is enabled for this provider
  useEffect(() => {
    if (!licenseeId) return
    let cancelled = false
    async function check() {
      const { data } = await supabase
        .from('business_policies')
        .select('messaging_enabled')
        .eq('user_id', licenseeId)
        .maybeSingle()
      if (!cancelled) setMessagingEnabled(!!data?.messaging_enabled)
    }
    check()
    return () => { cancelled = true }
  }, [licenseeId])

  // Build nav items dynamically so we can conditionally include Messages
  const NAV_ITEMS = [
    {
      section: 'Overview',
      items: [
        { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      ],
    },
    {
      section: 'Operations',
      items: [
        { label: 'Attendance', icon: Calendar, path: '/attendance' },
      ],
    },
    {
      section: 'Revenue',
      items: [
        { label: 'Families', icon: Users, path: '/families' },
        { label: 'Billing', icon: DollarSign, path: '/billing', roles: ['licensee', 'adult_staff'] },
        ...(messagingEnabled
          ? [{ label: 'Messages', icon: MessageCircle, path: '/messages', roles: ['licensee', 'adult_staff'] }]
          : []),
      ],
    },
    {
      section: 'Tax Tools',
      items: [
        { label: 'Receipts', icon: Receipt, path: '/receipts', roles: ['licensee', 'adult_staff'] },
        { label: 'Deductions', icon: Calculator, path: '/deductions', roles: ['licensee', 'adult_staff', 'view_only'] },
        { label: 'T/S Ratio', icon: BarChart2, path: '/ts-ratio', roles: ['licensee', 'adult_staff', 'view_only'] },
      ],
    },
    {
      section: 'Compliance',
      items: [
        { label: 'MiRegistry', icon: GraduationCap, path: '/miregistry', roles: ['licensee', 'adult_staff'], module: MODULE_KEYS.MIREGISTRY_TRACKER },
        { label: 'Staff Training', icon: ClipboardCheck, path: '/staff-training', roles: ['licensee', 'adult_staff', 'assistant'], module: MODULE_KEYS.STAFF_TRAINING },
        // Phase 3 — Compliance Checklist (provider-wide). Module-gated
        // to licensed homes only via MODULE_KEYS.LICENSED_COMPLIANCE
        // (license_type IN family_home / group_home). LEPs see no entry.
        // Plus the opt-in flag — hidden when the provider hasn't
        // explicitly enabled it in Business Info (decision #8).
        ...(complianceChecklistEnabled
          ? [{ label: 'Compliance Checklist', icon: ClipboardList, path: '/compliance', roles: ['licensee', 'adult_staff'], module: MODULE_KEYS.LICENSED_COMPLIANCE }]
          : []),
        { label: 'Parent Acknowledgments', icon: UserCheck, path: '/acknowledgments', roles: ['licensee', 'adult_staff'] },
        { label: 'CDC Pay Periods', icon: CalendarClock, path: '/cdc-pay-periods', roles: ['licensee', 'adult_staff'], module: MODULE_KEYS.CDC },
        { label: 'CDC I-Billing', icon: FileSpreadsheet, path: '/i-billing', roles: ['licensee', 'adult_staff'], module: MODULE_KEYS.CDC },
      ],
    },
    {
      section: 'Settings',
      items: [
        { label: 'Business Info', icon: Building2, path: '/business-info', roles: ['licensee'] },
        { label: 'Team', icon: UserCog, path: '/staff', roles: ['licensee'] },
        { label: 'Reminders', icon: Bell, path: '/reminders', roles: ['licensee'], module: MODULE_KEYS.REMINDERS },
        { label: 'Subscription', icon: CreditCard, path: '/subscription', roles: ['licensee'] },
        { label: 'How Money Works', icon: Shield, path: '/how-money-works' },
        { label: 'Contact / Support', icon: MessageSquare, path: '/contact' },
        // Static asset, not a route: opens the manual PDF in a new tab.
        { label: 'Provider Manual', icon: BookOpen, href: '/MILittleCare_Provider_Manual_v2.pdf', external: true },
      ],
    },
  ]

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  // Filter nav by role + module activation
  const visibleSections = NAV_ITEMS.map(section => ({
    ...section,
    items: section.items.filter(item => {
      if (item.roles && !item.roles.includes(role)) return false
      if (item.module && !modules.has(item.module)) return false
      return true
    }),
  })).filter(s => s.items.length > 0)

  const ROLE_LABELS = {
    licensee: 'Licensee',
    adult_staff: 'Staff',
    assistant: 'Assistant',
    view_only: 'View-only',
  }

  return (
    <aside className={`sidebar${isOpen ? ' open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="logo-mark">🏡</div>
          <div>
            <div className="logo-text">MI Little Care</div>
            <div className="logo-sub">{isLicensee ? 'Provider Portal' : `${ROLE_LABELS[role]} Access`}</div>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {visibleSections.map((section) => (
          <div key={section.section}>
            <div className="nav-section-label">{section.section}</div>
            {section.items.map((item) => (
              item.external ? (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener"
                  className="nav-item"
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </a>
              ) : (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/dashboard'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </NavLink>
              )
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <InstallLink>📱 Install on phone</InstallLink>
        </div>
        <div className="sidebar-user">
          <div className="user-avatar">{initials}</div>
          <div className="user-info">
            <div className="user-name">
              {fullName}
              {!isLicensee && (
                <span style={{
                  fontSize: '0.625rem',
                  marginLeft: 6,
                  padding: '1px 6px',
                  background: 'var(--clr-sage-pale)',
                  color: 'var(--clr-sage-dark)',
                  borderRadius: 'var(--radius-full)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>{ROLE_LABELS[role]}</span>
              )}
            </div>
            <div className="user-email">{email}</div>
          </div>
          <button
            className="signout-btn"
            onClick={handleSignOut}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
