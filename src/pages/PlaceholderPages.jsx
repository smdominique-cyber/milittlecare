// Placeholder pages for Phase 2+
// Each will be built out in its own phase.

import { ScanLine, Calculator, Users, FileText, Settings, BarChart2 } from 'lucide-react'

function ComingSoon({ icon: Icon, title, description }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      gap: 'var(--space-4)',
      textAlign: 'center',
      padding: 'var(--space-8)',
    }}>
      <div style={{
        width: 64,
        height: 64,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--clr-sage-pale)',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--clr-sage-dark)',
      }}>
        <Icon size={28} />
      </div>
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.5rem',
          fontWeight: 400,
          color: 'var(--clr-ink)',
          letterSpacing: '-0.02em',
          marginBottom: 'var(--space-2)',
        }}>
          {title}
        </h2>
        <p style={{ color: 'var(--clr-ink-soft)', maxWidth: 380 }}>
          {description}
        </p>
      </div>
      <div style={{
        padding: 'var(--space-2) var(--space-5)',
        background: 'var(--clr-warm)',
        borderRadius: 'var(--radius-full)',
        fontSize: '0.8125rem',
        color: 'var(--clr-ink-soft)',
        fontWeight: 500,
        border: '1px solid var(--clr-warm-mid)',
      }}>
        Coming in the next phase
      </div>
    </div>
  )
}

export function ReceiptsPage() {
  return (
    <ComingSoon
      icon={ScanLine}
      title="AI Receipt Scanner"
      description="Upload a photo of any receipt and our AI will automatically extract the merchant, amount, date, and category. Phase 2."
    />
  )
}

export function DeductionsPage() {
  return (
    <ComingSoon
      icon={Calculator}
      title="Deductions Tracker"
      description="View, categorize, and manage all your tax deductions in one place. Filter by category, date, or amount."
    />
  )
}

export function TSRatioPage() {
  return (
    <ComingSoon
      icon={BarChart2}
      title="T/S Ratio Calculator"
      description="Calculate your Time-Space percentage — the key multiplier for home daycare deductions under the IRS standard."
    />
  )
}

export function FamiliesPage() {
  return (
    <ComingSoon
      icon={Users}
      title="Family Management"
      description="Track enrolled children, billing, attendance, and communication with the families you serve."
    />
  )
}

export function ReportsPage() {
  return (
    <ComingSoon
      icon={FileText}
      title="Tax Reports"
      description="Generate a clean, organized PDF report of all your deductions — ready to hand to your tax preparer."
    />
  )
}

export function SettingsPage() {
  return (
    <ComingSoon
      icon={Settings}
      title="Settings"
      description="Manage your profile, daycare details, notification preferences, and subscription."
    />
  )
}
