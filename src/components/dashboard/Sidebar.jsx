import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
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
} from 'lucide-react'

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
      { label: 'Billing', icon: DollarSign, path: '/billing' },
    ],
  },
  {
    section: 'Tax Tools',
    items: [
      { label: 'Receipts', icon: Receipt, path: '/receipts' },
      { label: 'Deductions', icon: Calculator, path: '/deductions' },
      { label: 'T/S Ratio', icon: BarChart2, path: '/ts-ratio' },
    ],
  },
  {
    section: 'Settings',
    items: [
      { label: 'Business Info', icon: Building2, path: '/business-info' },
      { label: 'Subscription', icon: CreditCard, path: '/subscription' },
      { label: 'How Money Works', icon: Shield, path: '/how-money-works' },
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
  const navigate = useNavigate()

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'You'
  const email = user?.email || ''
  const initials = getInitials(fullName)

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <aside className={`sidebar${isOpen ? ' open' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="logo-mark">🏡</div>
          <div>
            <div className="logo-text">Mi Little Care</div>
            <div className="logo-sub">Provider Portal</div>
          </div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((section) => (
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
            <div className="user-name">{fullName}</div>
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
