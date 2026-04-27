import { useState, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import TrialBanner from '@/components/subscription/TrialBanner'
import { Bell, HelpCircle, Menu, X } from 'lucide-react'
import '@/styles/dashboard.css'

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/receipts': 'Receipts',
  '/deductions': 'Deductions',
  '/ts-ratio': 'T/S Ratio Calculator',
  '/families': 'Families',
  '/billing': 'Billing & Invoices',
  '/reports': 'Reports',
  '/settings': 'Settings',
  '/subscription': 'Subscription',
}

const CURRENT_TAX_YEAR = new Date().getFullYear()

export default function DashboardLayout() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] || 'MI Little Care'
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close sidebar when route changes (e.g. user taps a nav link)
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="dashboard-shell">
      <Sidebar isOpen={sidebarOpen} />

      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="dashboard-main">
        <TrialBanner />
        <header className="topbar">
          <button
            className="topbar-btn topbar-menu-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <span className="topbar-title">{title}</span>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <div className="topbar-pill">
              <span>Tax Year</span>
              <span className="tax-year">{CURRENT_TAX_YEAR}</span>
            </div>
            <button className="topbar-btn topbar-btn-desktop" aria-label="Help">
              <HelpCircle size={18} />
            </button>
            <button className="topbar-btn topbar-btn-desktop" aria-label="Notifications">
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
