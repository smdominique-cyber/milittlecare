import { useNavigate, useLocation } from 'react-router-dom'
import { useSubscription } from '@/hooks/useSubscription'
import { Sparkles, AlertCircle } from 'lucide-react'

export default function TrialBanner() {
  const sub = useSubscription()
  const navigate = useNavigate()
  const location = useLocation()

  // Don't show on the subscription page itself
  if (location.pathname === '/subscription') return null

  // Don't show if active
  if (sub.isActive) return null
  if (sub.loading) return null

  // Past due — urgent
  if (sub.isPastDue) {
    return (
      <div className="trial-banner urgent">
        <AlertCircle size={16} className="trial-banner-icon" />
        <div className="trial-banner-text">
          <strong>Payment failed.</strong> Update your payment method to keep your subscription active.
        </div>
        <button className="trial-banner-cta" onClick={() => navigate('/subscription')}>
          Update payment
        </button>
      </div>
    )
  }

  // In trial
  if (sub.isTrialing && !sub.isTrialExpired) {
    const urgent = sub.daysLeft <= 5
    return (
      <div className={`trial-banner${urgent ? ' urgent' : ''}`}>
        <Sparkles size={16} className="trial-banner-icon" />
        <div className="trial-banner-text">
          {urgent ? (
            <><strong>{sub.daysLeft} {sub.daysLeft === 1 ? 'day' : 'days'} left</strong> in your free trial. Add a payment method to keep your access.</>
          ) : (
            <>You have <strong>{sub.daysLeft} days</strong> left in your free trial.</>
          )}
        </div>
        <button className="trial-banner-cta" onClick={() => navigate('/subscription')}>
          {urgent ? 'Subscribe' : 'Add payment'}
        </button>
      </div>
    )
  }

  return null
}
