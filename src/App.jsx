import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/hooks/useAuth'
import ProtectedRoute from '@/components/auth/ProtectedRoute'
import PaywallGate from '@/components/subscription/PaywallGate'
import DashboardLayout from '@/components/dashboard/DashboardLayout'

import LoginPage from '@/pages/LoginPage'
import AuthCallbackPage from '@/pages/AuthCallbackPage'
import DashboardPage from '@/pages/DashboardPage'
import ReceiptsPage from '@/pages/ReceiptsPage'
import DeductionsPage from '@/pages/DeductionsPage'
import TSRatioPage from '@/pages/TSRatioPage'
import FamiliesPage from '@/pages/FamiliesPage'
import BillingPage from '@/pages/BillingPage'
import SubscriptionPage from '@/pages/SubscriptionPage'
import {
  ReportsPage,
  SettingsPage,
} from '@/pages/PlaceholderPages'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />

          {/* Redirect root to dashboard */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          {/* Protected dashboard routes (with paywall gate) */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <PaywallGate>
                  <DashboardLayout />
                </PaywallGate>
              </ProtectedRoute>
            }
          >
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="receipts" element={<ReceiptsPage />} />
            <Route path="deductions" element={<DeductionsPage />} />
            <Route path="ts-ratio" element={<TSRatioPage />} />
            <Route path="families" element={<FamiliesPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="subscription" element={<SubscriptionPage />} />
          </Route>

          {/* 404 fallback */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
