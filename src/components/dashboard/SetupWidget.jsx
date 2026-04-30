import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronRight, X, Sparkles } from 'lucide-react'

const STORAGE_KEY = 'mlc_setup_widget_dismissed'

export default function SetupWidget({ stats }) {
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
  })

  const items = [
    {
      id: 'family',
      label: 'Add your first family',
      done: stats.has_family,
      action: () => navigate('/families'),
    },
    {
      id: 'invite',
      label: 'Send your first parent invitation',
      done: stats.has_invitation,
      action: () => navigate('/families'),
    },
    {
      id: 'invoice',
      label: 'Generate your first invoice',
      done: stats.has_invoice,
      action: () => navigate('/billing'),
    },
    {
      id: 'autopay',
      label: 'Get a family on autopay',
      done: stats.has_autopay,
      action: () => navigate('/families'),
    },
    {
      id: 'hours',
      label: 'Set your business hours',
      done: stats.hours_set,
      action: () => navigate('/business-info'),
    },
    {
      id: 'closures',
      label: 'Add holidays & closures',
      done: stats.closures_set,
      action: () => navigate('/business-info'),
    },
    {
      id: 'tsratio',
      label: 'Set your T/S ratio',
      done: stats.has_tsratio,
      action: () => navigate('/ts-ratio'),
    },
  ]

  const completed = items.filter(i => i.done).length
  const total = items.length
  const pct = Math.round((completed / total) * 100)

  // Auto-hide once 5 of 7 are done
  if (completed >= 5 || dismissed) return null

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch {}
    setDismissed(true)
  }

  return (
    <div className="setup-widget">
      <div className="setup-widget-header">
        <div className="setup-widget-title">
          <Sparkles size={16} style={{ color: 'var(--clr-accent)' }} /> Get the most out of MI Little Care
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="setup-widget-progress">{completed} of {total}</span>
          <button className="setup-widget-dismiss" onClick={dismiss} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="setup-widget-bar">
        <div className="setup-widget-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="setup-widget-list">
        {items.map(item => (
          <button
            key={item.id}
            className={`setup-widget-item ${item.done ? 'done' : ''}`}
            onClick={() => !item.done && item.action()}
            disabled={item.done}
          >
            <div className="setup-widget-check">
              {item.done && <Check size={13} />}
            </div>
            <span className="setup-widget-label">{item.label}</span>
            {!item.done && <ChevronRight size={14} className="setup-widget-arrow" />}
          </button>
        ))}
      </div>
    </div>
  )
}
