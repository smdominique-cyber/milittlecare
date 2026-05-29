import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/hooks/useAuth'
import { RoleProvider } from '@/hooks/useRole'
import ProtectedRoute from '@/components/auth/ProtectedRoute'
import PaywallGate from '@/components/subscription/PaywallGate'
import DashboardLayout from '@/components/dashboard/DashboardLayout'
import ErrorBoundary from '@/components/ui/ErrorBoundary'
import { ToastProvider } from '@/components/ui/Toast'

import LoginPage from '@/pages/LoginPage'
import LandingPage from '@/pages/LandingPage'
import AttendancePage from '@/pages/AttendancePage'
import AdminPage from '@/pages/AdminPage'
import AuthCallbackPage from '@/pages/AuthCallbackPage'
import ForgotPasswordPage from '@/pages/ForgotPasswordPage'
import ResetPasswordPage from '@/pages/ResetPasswordPage'
import DashboardPage from '@/pages/DashboardPage'
import ReceiptsPage from '@/pages/ReceiptsPage'
import DeductionsPage from '@/pages/DeductionsPage'
import TSRatioPage from '@/pages/TSRatioPage'
import FamiliesPage from '@/pages/FamiliesPage'
import BillingPage from '@/pages/BillingPage'
import SubscriptionPage from '@/pages/SubscriptionPage'
import HowMoneyWorksPage from '@/pages/HowMoneyWorksPage'
import BusinessInfoPage from '@/pages/BusinessInfoPage'
import StaffPage from '@/pages/StaffPage'
import ProviderAcknowledgmentsPage from '@/pages/ProviderAcknowledgmentsPage'
import MiRegistryPage from '@/pages/MiRegistryPage'
import StaffTrainingPage from '@/pages/StaffTrainingPage'
import CdcPayPeriodsPage from '@/pages/CdcPayPeriodsPage'
import IBillingPage from '@/pages/IBillingPage'
import RemindersSettingsPage from '@/pages/RemindersSettingsPage'
import OnboardingPage from '@/pages/OnboardingPage'
import ContactPage from '@/pages/ContactPage'
import PrivacyPage from '@/pages/PrivacyPage'
import TermsPage from '@/pages/TermsPage'
import InviteAcceptPage from '@/pages/InviteAcceptPage'
import StaffInviteAcceptPage from '@/pages/StaffInviteAcceptPage'
import ParentDashboardPage from '@/pages/ParentDashboardPage'
import ParentMyFamilyPage from '@/pages/ParentMyFamilyPage'
import ParentMessagesPage from '@/pages/ParentMessagesPage'
import ParentMessageThreadPage from '@/pages/ParentMessageThreadPage'
import ParentAcknowledgePage from '@/pages/ParentAcknowledgePage'
import ParentIntakeAcknowledgePage from '@/pages/ParentIntakeAcknowledgePage'
import ParentAcknowledgmentsPage from '@/pages/ParentAcknowledgmentsPage'
import MessagesPage from '@/pages/MessagesPage'
import MessageThreadPage from '@/pages/MessageThreadPage'
import {
  ReportsPage,
  SettingsPage,
} from '@/pages/PlaceholderPages'

import '@/styles/toast.css'
import '@/styles/install-banner.css'

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <RoleProvider>
              <Routes>
                {/* Public routes */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/auth/callback" element={<AuthCallbackPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/terms" element={<TermsPage />} />

                {/* Parent-facing routes — no provider auth, no paywall */}
                <Route path="/invite/:token" element={<InviteAcceptPage />} />
                <Route path="/parent" element={<ParentDashboardPage />} />
                <Route path="/parent/family" element={<ParentMyFamilyPage />} />
                <Route path="/parent/messages" element={<ParentMessagesPage />} />
                <Route path="/parent/messages/:childId" element={<ParentMessageThreadPage />} />
                {/*
                  PR #16 follow-up — Issue #2: both /parent/acknowledge
                  and /parent/intake-acknowledge render the same tabbed
                  wrapper. Attendance is the default; the intake route
                  forces the Intake tab to preserve the email CTA
                  (`/parent/intake-acknowledge?child=<id>`). Each route
                  also accepts `?tab=attendance|intake` as an explicit
                  override. The wrapper mounts the existing page
                  components unchanged.
                */}
                <Route path="/parent/acknowledge" element={<ParentAcknowledgmentsPage />} />
                <Route path="/parent/intake-acknowledge" element={<ParentAcknowledgmentsPage />} />
                {/*
                  Direct mounts retained for compat / future internal
                  navigation; not surfaced in user-facing routes. The
                  consolidated `/parent/acknowledge` is the canonical
                  parent path.
                */}
                <Route path="/parent/_attendance-only" element={<ParentAcknowledgePage />} />
                <Route path="/parent/_intake-only" element={<ParentIntakeAcknowledgePage />} />

                {/* Staff invitation accept */}
                <Route path="/staff-invite/:token" element={<StaffInviteAcceptPage />} />

                {/* Public landing page */}
                <Route path="/" element={<LandingPage />} />

                {/* Onboarding wizard — inside PaywallGate but outside
                    DashboardLayout: full-screen, no sidebar (spec § 4.1). */}
                <Route
                  path="/onboarding"
                  element={
                    <ProtectedRoute>
                      <PaywallGate>
                        <OnboardingPage />
                      </PaywallGate>
                    </ProtectedRoute>
                  }
                />

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
                  <Route path="attendance" element={<AttendancePage />} />
                  <Route path="families" element={<FamiliesPage />} />
                  <Route path="billing" element={<BillingPage />} />
                  <Route path="messages" element={<MessagesPage />} />
                  <Route path="messages/:childId" element={<MessageThreadPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="subscription" element={<SubscriptionPage />} />
                  <Route path="how-money-works" element={<HowMoneyWorksPage />} />
                  <Route path="business-info" element={<BusinessInfoPage />} />
                  <Route path="staff" element={<StaffPage />} />
                  <Route path="acknowledgments" element={<ProviderAcknowledgmentsPage />} />
                  <Route path="miregistry" element={<MiRegistryPage />} />
                  <Route path="staff-training" element={<StaffTrainingPage />} />
                  <Route path="cdc-pay-periods" element={<CdcPayPeriodsPage />} />
                  <Route path="i-billing" element={<IBillingPage />} />
                  <Route path="reminders" element={<RemindersSettingsPage />} />
                  <Route path="contact" element={<ContactPage />} />
                  <Route path="admin" element={<AdminPage />} />
                </Route>

                {/* 404 fallback */}
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </RoleProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
