import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, MessageCircle, Loader, Lock } from 'lucide-react'
import { getSignedPhotoUrl } from '@/lib/messages'
import '@/styles/parent.css'
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

export default function ParentMessagesPage() {
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [families, setFamilies] = useState([])  // families this parent is linked to
  const [children, setChildren] = useState([])
  const [threads, setThreads] = useState([])
  const [unreadByThread, setUnreadByThread] = useState({})
  const [lastMessageByThread, setLastMessageByThread] = useState({})
  const [providerNames, setProviderNames] = useState({})  // {family_id: provider name}

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) { setLoading(false); return }
      await loadAll(session.user.id)
    }
    init()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadAll(session.user.id)
    })
    return () => authListener?.subscription?.unsubscribe()
  }, [])

  async function loadAll(parentId) {
    setLoading(true)

    // 1. Get linked families
    const { data: links } = await supabase
      .from('parent_family_links')
      .select('*, families(*)')
      .eq('parent_id', parentId)
      .eq('status', 'active')

    const familiesData = (links || []).map(l => l.families).filter(Boolean)
    setFamilies(familiesData)

    if (familiesData.length === 0) {
      setLoading(false)
      return
    }

    const familyIds = familiesData.map(f => f.id)

    // 2. Get children in those families
    const { data: childrenData } = await supabase
      .from('children')
      .select('id, first_name, last_name, family_id')
      .in('family_id', familyIds)
    setChildren(childrenData || [])

    // 3. Get threads for those families (RLS handles the parent-side access)
    const { data: threadsData } = await supabase
      .from('message_threads')
      .select('*')
      .in('family_id', familyIds)
      .order('last_message_at', { ascending: false })
    setThreads(threadsData || [])

    // 4. Get unread counts (provider messages without read_by_other_at)
    if (threadsData && threadsData.length > 0) {
      const threadIds = threadsData.map(t => t.id)
      const { data: unread } = await supabase
        .from('messages')
        .select('thread_id')
        .in('thread_id', threadIds)
        .eq('sender_type', 'provider')
        .is('read_by_other_at', null)
      const unreadMap = {}
      ;(unread || []).forEach(m => {
        unreadMap[m.thread_id] = (unreadMap[m.thread_id] || 0) + 1
      })
      setUnreadByThread(unreadMap)

      // 5. Last message per thread
      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('thread_id, body, created_at, sender_type')
        .in('thread_id', threadIds)
        .order('created_at', { ascending: false })
      const lastMap = {}
      ;(lastMsgs || []).forEach(m => {
        if (!lastMap[m.thread_id]) lastMap[m.thread_id] = m
      })
      setLastMessageByThread(lastMap)
    }

    // 6. Provider name per family (for display)
    const providerIds = [...new Set((links || []).map(l => l.provider_user_id))]
    const nameMap = {}
    for (const pid of providerIds) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name, daycare_name')
        .eq('id', pid)
        .maybeSingle()
      const name = prof?.daycare_name || prof?.full_name || 'Your provider'
      // Map by family_id
      ;(links || [])
        .filter(l => l.provider_user_id === pid)
        .forEach(l => { nameMap[l.family_id] = name })
    }
    setProviderNames(nameMap)

    setLoading(false)
  }

  // Build display rows: one row per child, with their thread (if any)
  const rows = useMemo(() => {
    const threadByChild = {}
    threads.forEach(t => { threadByChild[t.child_id] = t })

    const withThread = []
    const withoutThread = []
    children.forEach(child => {
      const thread = threadByChild[child.id]
      if (thread) withThread.push({ child, thread })
      else withoutThread.push({ child, thread: null })
    })

    withThread.sort((a, b) => {
      const at = new Date(a.thread.last_message_at).getTime()
      const bt = new Date(b.thread.last_message_at).getTime()
      return bt - at
    })
    withoutThread.sort((a, b) => (a.child.first_name || '').localeCompare(b.child.first_name || ''))

    return [...withThread, ...withoutThread]
  }, [children, threads])

  if (loading) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)', marginBottom: 12 }} />
          <div>Loading…</div>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <div className="parent-icon error"><Lock size={28} /></div>
          <h2>Sign in required</h2>
          <p>Please sign in to view your messages.</p>
          <button className="parent-cta" onClick={() => navigate('/login')} style={{ marginTop: 16 }}>
            Go to sign in
          </button>
        </div>
      </div>
    )
  }

  if (families.length === 0) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <h2>No family linked</h2>
          <p>Your provider hasn't linked you to a family yet.</p>
          <button className="parent-secondary" onClick={() => navigate('/parent')}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="parent-shell">
      <div className="parent-container">
        <header className="parent-topbar">
          <button className="parent-back-btn" onClick={() => navigate('/parent')}>
            <ArrowLeft size={16} />
            <span>Back</span>
          </button>
          <div className="parent-brand-name" style={{ fontSize: '1rem' }}>
            Messages
          </div>
          <div style={{ width: 60 }} />
        </header>

        {rows.length === 0 ? (
          <div className="messages-empty">
            <div className="messages-empty-icon">💬</div>
            <div className="messages-empty-title">No messages yet</div>
            <div className="messages-empty-desc">
              When your provider sends an update or photo, it will appear here.
            </div>
          </div>
        ) : (
          <div className="thread-list">
            {rows.map(({ child, thread }) => {
              const last = thread ? lastMessageByThread[thread.id] : null
              const unread = thread ? (unreadByThread[thread.id] || 0) : 0
              const providerName = providerNames[child.family_id] || 'Your provider'
              return (
                <button
                  key={child.id}
                  className="thread-row"
                  onClick={() => navigate(`/parent/messages/${child.id}`)}
                >
                  <div className="thread-avatar">
                    {getInitials(child.first_name, child.last_name)}
                  </div>
                  <div className="thread-info">
                    <div className="thread-name-row">
                      <div className="thread-name">
                        {child.first_name}
                        {child.last_name && ` ${child.last_name.charAt(0)}.`}
                        <span style={{ color: 'var(--clr-ink-soft)', fontWeight: 400, fontSize: '0.8125rem' }}>
                          {' '}· {providerName}
                        </span>
                      </div>
                      <div className="thread-time">
                        {last ? relativeTime(last.created_at) : ''}
                      </div>
                    </div>
                    <div className={`thread-preview ${!last ? 'empty' : ''}`}>
                      {last
                        ? `${last.sender_type === 'parent' ? 'You: ' : ''}${previewText(last)}`
                        : 'No messages yet'}
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
    </div>
  )
}
