import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
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
} from 'lucide-react'

// Each item has an optional `roles` array of which roles see it.
// Items without `roles` are visible to everyone.
const NAV_ITEMS = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
    ],
  },
  {
    section: 'Revenue',
    items: [
      { label: 'Families', icon: Users, path: '/families' },
      { label: 'Billing', icon: DollarSign, path: '/billing', roles: ['licensee', 'adult_staff'] },
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
    section: 'Settings',
    items: [
      { label: 'Business Info', icon: Building2, path: '/business-info', roles: ['licensee'] },
      { label: 'Team', icon: UserCog, path: '/staff', roles: ['licensee'] },
      { label: 'Subscription', icon: CreditCard, path: '/subscription', roles: ['licensee'] },
      { label: 'How Money Works', icon: Shield, path: '/how-money-works' },
      { label: 'Contact / Support', icon: MessageSquare, path: '/contact' },
    ],
  },
]

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
  const { role, isLicensee } = useRole()
  const navigate = useNavigate()

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'You'
  const email = user?.email || ''
  const initials = getInitials(fullName)

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  // Filter nav by role
  const visibleSections = NAV_ITEMS.map(section => ({
    ...section,
    items: section.items.filter(item => !item.roles || item.roles.includes(role)),
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
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
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
