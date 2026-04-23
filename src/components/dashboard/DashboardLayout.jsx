import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { Bell, HelpCircle } from 'lucide-react'
import '@/styles/dashboard.css'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/receipts': 'Receipts',
  '/deductions': 'Deductions',
  '/ts-ratio': 'T/S Ratio Calculator',
  '/families': 'Families',
  '/reports': 'Reports',
  '/settings': 'Settings',
}

const CURRENT_TAX_YEAR = new Date().getFullYear()

export default function DashboardLayout() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] || 'Mi Little Care'

  return (
    <div className="dashboard-shell">
      <Sidebar />
      <div className="dashboard-main">
        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <div className="topbar-pill">
              <span>Tax Year</span>
              <span className="tax-year">{CURRENT_TAX_YEAR}</span>
            </div>
            <button className="topbar-btn" aria-label="Help">
              <HelpCircle size={18} />
            </button>
            <button className="topbar-btn" aria-label="Notifications">
              <Bell size={18} />
            </button>
          </div>
        </header>

        <main className="page-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
