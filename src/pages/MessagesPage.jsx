import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'
import { loadProviderThreadsWithChildren } from '@/lib/messages'
import { MessageCircle, Settings } from 'lucide-react'
import '@/styles/messages.css'

function getInitials(first, last) {
  const f = (first || '?').charAt(0)
  const l = (last || '').charAt(0)
  return (f + l).toUpperCase()
}

function relativeTime(iso) {
  if (!iso) return ''
  const now = Date.now()
  const t = new Date(iso).getTime()
  const diff = Math.max(0, now - t)
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function previewText(message) {
  if (!message) return ''
  if (message.body) return message.body
  return '📷 Photo'
}

export default function MessagesPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { licenseeId } = useRole()
  const [enabled, setEnabled] = useState(null)  // null = loading
  const [data, setData] = useState({ children: [], threads: [], unreadByThread: {}, lastMessageByThread: {} })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!licenseeId) return
    loadAll()
  }, [licenseeId])

  async function loadAll() {
    setLoading(true)

    // Check messaging_enabled toggle
    const { data: policy } = await supabase
      .from('business_policies')
      .select('messaging_enabled')
      .eq('user_id', licenseeId)
      .maybeSingle()
    const isEnabled = !!policy?.messaging_enabled
    setEnabled(isEnabled)

    if (isEnabled) {
      const result = await loadProviderThreadsWithChildren(licenseeId)
      setData(result)
    }
    setLoading(false)
  }

  // Build a sorted list: each child gets a row, sorted by last_message_at desc
  // Children with no thread go to the bottom alphabetically
  const rows = useMemo(() => {
    const threadByChild = {}
    data.threads.forEach(t => { threadByChild[t.child_id] = t })

    const withThread = []
    const withoutThread = []
    data.children.forEach(child => {
      const thread = threadByChild[child.id]
      if (thread) {
        withThread.push({ child, thread })
      } else {
        withoutThread.push({ child, thread: null })
      }
    })

    withThread.sort((a, b) => {
      const at = new Date(a.thread.last_message_at).getTime()
      const bt = new Date(b.thread.last_message_at).getTime()
      return bt - at
    })
    withoutThread.sort((a, b) => (a.child.first_name || '').localeCompare(b.child.first_name || ''))

    return [...withThread, ...withoutThread]
  }, [data])

  if (loading || enabled === null) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  if (!enabled) {
    return (
      <div className="messages-page">
        <div className="messaging-disabled-notice">
          <h3>Parent Messages</h3>
          <p>
            Two-way messaging with parents is currently turned off. You can enable it
            anytime from Business Info — and turn it off just as easily. Your existing
            messages are always preserved.
          </p>
          <button
            className="btn-add-family"
            onClick={() => navigate('/business-info')}
            style={{ display: 'inline-flex' }}
          >
            <Settings size={14} /> Enable in Business Info
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="messages-page">
      <div className="messages-header">
        <h2>Messages</h2>
      </div>

      {rows.length === 0 ? (
        <div className="messages-empty">
          <div className="messages-empty-icon">💬</div>
          <div className="messages-empty-title">No children to message yet</div>
          <div className="messages-empty-desc">
            Add families and children first, then come back here to send updates and photos.
          </div>
        </div>
      ) : (
        <div className="thread-list">
          {rows.map(({ child, thread }) => {
            const last = thread ? data.lastMessageByThread[thread.id] : null
            const unread = thread ? (data.unreadByThread[thread.id] || 0) : 0
            const familyName = child.families?.family_name || ''
            return (
              <button
                key={child.id}
                className="thread-row"
                onClick={() => navigate(`/messages/${child.id}`)}
              >
                <div className="thread-avatar">
                  {getInitials(child.first_name, child.last_name)}
                </div>
                <div className="thread-info">
                  <div className="thread-name-row">
                    <div className="thread-name">
                      {child.first_name}
                      {child.last_name && ` ${child.last_name.charAt(0)}.`}
                      {familyName && (
                        <span style={{ color: 'var(--clr-ink-soft)', fontWeight: 400, fontSize: '0.8125rem' }}>
                          {' '}· {familyName}
                        </span>
                      )}
                    </div>
                    <div className="thread-time">
                      {last ? relativeTime(last.created_at) : ''}
                    </div>
                  </div>
                  <div className={`thread-preview ${!last ? 'empty' : ''}`}>
                    {last
                      ? `${last.sender_type === 'provider' ? 'You: ' : ''}${previewText(last)}`
                      : 'No messages yet — say hi!'}
                  </div>
                </div>
                {unread > 0 && (
                  <div className="thread-unread">{unread}</div>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
