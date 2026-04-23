import { useAuth } from '@/hooks/useAuth'
import { Receipt, TrendingUp, Clock, DollarSign, ScanLine, FileText, Calculator } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// Placeholder data — will be replaced with real Supabase queries in Phase 2
const MOCK_STATS = [
  {
    label: 'Total Deductions',
    value: '$3,240',
    change: '+$420',
    changeType: 'up',
    icon: DollarSign,
    iconVariant: 'sage',
  },
  {
    label: 'Receipts Scanned',
    value: '47',
    change: '+8 this month',
    changeType: 'up',
    icon: Receipt,
    iconVariant: 'accent',
  },
  {
    label: 'T/S Ratio',
    value: '38%',
    change: 'Estimated',
    changeType: 'neutral',
    icon: TrendingUp,
    iconVariant: 'success',
  },
  {
    label: 'Hours Logged',
    value: '312',
    change: 'YTD',
    changeType: 'neutral',
    icon: Clock,
    iconVariant: 'warning',
  },
]

const MOCK_RECEIPTS = [
  { id: 1, merchant: "Costco", amount: "$187.43", category: "Grocery", date: "Apr 18", emoji: "🛒", type: "grocery" },
  { id: 2, merchant: "Staples", amount: "$54.99", category: "Office", date: "Apr 15", emoji: "📎", type: "office" },
  { id: 3, merchant: "Panera Bread", amount: "$23.10", category: "Meals", date: "Apr 14", emoji: "🍞", type: "meal" },
  { id: 4, merchant: "Shell Gas Station", amount: "$68.00", category: "Vehicle", date: "Apr 12", emoji: "⛽", type: "vehicle" },
  { id: 5, merchant: "Target", amount: "$91.22", category: "Supplies", date: "Apr 10", emoji: "🏷️", type: "misc" },
]

const QUICK_ACTIONS = [
  {
    label: 'Scan a receipt',
    desc: 'AI will extract details automatically',
    icon: ScanLine,
    variant: 'primary',
    path: '/receipts',
  },
  {
    label: 'Calculate T/S ratio',
    desc: 'Time-space percentage for your home',
    icon: Calculator,
    variant: 'accent',
    path: '/ts-ratio',
  },
  {
    label: 'Export tax report',
    desc: 'PDF summary for your tax preparer',
    icon: FileText,
    variant: 'neutral',
    path: '/reports',
  },
]

function getGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const firstName = user?.user_metadata?.full_name?.split(' ')[0] || 'there'
  const greeting = getGreeting()

  return (
    <>
      {/* Welcome banner */}
      <div className="welcome-banner">
        <div className="welcome-text">
          <h2>
            {greeting}, <em>{firstName}</em> 👋
          </h2>
          <p>
            You're on track for a great tax year. You have 47 receipts tracked
            and an estimated $3,240 in deductions so far.
          </p>
        </div>
        <button className="welcome-cta" onClick={() => navigate('/receipts')}>
          <ScanLine size={16} />
          Scan a receipt
        </button>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        {MOCK_STATS.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-header">
              <div className={`stat-icon ${stat.iconVariant}`}>
                <stat.icon />
              </div>
              <span className={`stat-change ${stat.changeType}`}>{stat.change}</span>
            </div>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Content grid */}
      <div className="content-grid">
        {/* Recent receipts */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Receipts</span>
            <span className="card-action" onClick={() => navigate('/receipts')}>
              View all →
            </span>
          </div>
          <div className="card-body">
            <ul className="receipt-list">
              {MOCK_RECEIPTS.map((r) => (
                <li key={r.id}>
                  <div className="receipt-item">
                    <div className={`receipt-thumb ${r.type}`}>{r.emoji}</div>
                    <div className="receipt-info">
                      <div className="receipt-merchant">{r.merchant}</div>
                      <div className="receipt-meta">
                        <span>{r.date}</span>
                        <span className="receipt-category">{r.category}</span>
                      </div>
                    </div>
                    <span className="receipt-amount">{r.amount}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {/* Deduction progress */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">2025 Progress</span>
            </div>
            <div className="card-body">
              <div className="deduction-progress">
                <div className="progress-ring-container">
                  <svg className="progress-ring" width="120" height="120" viewBox="0 0 120 120">
                    <circle className="progress-ring-bg" cx="60" cy="60" r="54" />
                    <circle className="progress-ring-fill" cx="60" cy="60" r="54" />
                  </svg>
                  <div className="progress-ring-center">
                    <span className="progress-pct">75%</span>
                    <span className="progress-label-sm">of goal</span>
                  </div>
                </div>
                <div className="progress-stats">
                  <div className="progress-stat">
                    <div className="progress-stat-value">$3,240</div>
                    <div className="progress-stat-label">Tracked</div>
                  </div>
                  <div className="progress-stat">
                    <div className="progress-stat-value">$4,300</div>
                    <div className="progress-stat-label">Goal</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Quick Actions</span>
            </div>
            <div className="card-body">
              <div className="quick-actions">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.label}
                    className="quick-action-btn"
                    onClick={() => navigate(qa.path)}
                  >
                    <div className={`qa-icon ${qa.variant}`}>
                      <qa.icon />
                    </div>
                    <div>
                      <div className="qa-label">{qa.label}</div>
                      <div className="qa-desc">{qa.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
