import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import {
  loadMessages,
  sendMessage,
  notifyParentsOfMessage,  // we'll re-use this; the API is generalized
  getSignedPhotoUrls,
} from '@/lib/messages'
import { ArrowLeft, ImagePlus, Send, X, Loader, Lock } from 'lucide-react'
import '@/styles/parent.css'
import '@/styles/messages.css'

const MAX_PHOTOS = 5

function formatTimestamp(iso) {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export default function ParentMessageThreadPage() {
  const navigate = useNavigate()
  const { childId } = useParams()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [child, setChild] = useState(null)
  const [thread, setThread] = useState(null)
  const [providerName, setProviderName] = useState('Your provider')
  const [messages, setMessages] = useState([])
  const [signedUrls, setSignedUrls] = useState({})
  const [body, setBody] = useState('')
  const [pendingPhotos, setPendingPhotos] = useState([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
  }, [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setSession(session)
      if (!session) { setLoading(false); return }
      await bootstrap(session.user.id)
    }
    init()

    return () => {
      pendingPhotos.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId])

  async function bootstrap(parentId) {
    setLoading(true)
    setError(null)

    // 1. Verify the parent has access to this child via parent_family_links
    const { data: childData } = await supabase
      .from('children')
      .select('id, first_name, last_name, family_id, families(family_name, user_id)')
      .eq('id', childId)
      .maybeSingle()

    if (!childData) {
      setError('Child not found or you do not have access.')
      setLoading(false)
      return
    }

    // Confirm linkage
    const { data: link } = await supabase
      .from('parent_family_links')
      .select('id')
      .eq('parent_id', parentId)
      .eq('family_id', childData.family_id)
      .eq('status', 'active')
      .maybeSingle()

    if (!link) {
      setError('You do not have access to this child.')
      setLoading(false)
      return
    }

    setChild(childData)

    // 2. Get provider name
    if (childData.families?.user_id) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name, daycare_name')
        .eq('id', childData.families.user_id)
        .maybeSingle()
      setProviderName(prof?.daycare_name || prof?.full_name || 'Your provider')
    }

    // 3. Load thread (if any)
    const { data: threadData } = await supabase
      .from('message_threads')
      .select('*')
      .eq('child_id', childId)
      .maybeSingle()

    setThread(threadData)

    if (threadData) {
      const msgs = await loadMessages(threadData.id)
      setMessages(msgs)
      await refreshSignedUrls(msgs)
      // Mark provider messages as read
      const now = new Date().toISOString()
      await supabase
        .from('messages')
        .update({ read_by_other_at: now })
        .eq('thread_id', threadData.id)
        .eq('sender_type', 'provider')
        .is('read_by_other_at', null)
    }

    setLoading(false)
    setTimeout(scrollToBottom, 50)
  }

  async function refreshSignedUrls(msgs) {
    const paths = []
    msgs.forEach(m => {
      (m.message_attachments || []).forEach(a => paths.push(a.storage_path))
    })
    if (paths.length === 0) return
    const urls = await getSignedPhotoUrls(paths)
    setSignedUrls(prev => ({ ...prev, ...urls }))
  }

  function handlePickPhotos(e) {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const slotsLeft = MAX_PHOTOS - pendingPhotos.length
    const accepted = files.slice(0, slotsLeft)
    const newPending = accepted.map(file => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    setPendingPhotos(prev => [...prev, ...newPending])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removePendingPhoto(index) {
    setPendingPhotos(prev => {
      const removed = prev[index]
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  async function handleSend() {
    if (sending || !thread) {
      // Parents can't create threads — providers do that. If no thread exists,
      // we just don't allow parent to send (rare edge case: provider hasn't
      // posted yet but parent navigated to this thread somehow).
      if (!thread) {
        setError("Your provider hasn't started a conversation yet. They'll need to send the first message.")
        return
      }
      return
    }
    if (!body.trim() && pendingPhotos.length === 0) return
    setSending(true)
    setError(null)

    try {
      const photoFiles = pendingPhotos.map(p => p.file)
      const { message: newMsg, failedPhotos } = await sendMessage({
        threadId: thread.id,
        senderUserId: session.user.id,
        senderType: 'parent',
        body: body.trim() || null,
        photoFiles,
      })

      pendingPhotos.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
      setBody('')
      setPendingPhotos([])

      const msgs = await loadMessages(thread.id)
      setMessages(msgs)
      await refreshSignedUrls(msgs)
      setTimeout(scrollToBottom, 50)

      // Notify provider via existing API (it's generalized to send to "the other party")
      notifyParentsOfMessage({
        threadId: thread.id,
        messageId: newMsg.id,
        hasPhotos: photoFiles.length > 0,
        bodyPreview: body.trim() || '',
      })

      if (failedPhotos.length > 0) {
        setError(`${failedPhotos.length} photo${failedPhotos.length > 1 ? 's' : ''} couldn't be uploaded.`)
      }
    } catch (err) {
      setError(err.message || 'Failed to send message')
    }

    setSending(false)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

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
          <button className="parent-cta" onClick={() => navigate('/login')} style={{ marginTop: 16 }}>
            Go to sign in
          </button>
        </div>
      </div>
    )
  }

  if (error && !child) {
    return (
      <div className="parent-shell">
        <div className="parent-card">
          <h2>{error}</h2>
          <button className="parent-secondary" onClick={() => navigate('/parent/messages')}>
            <ArrowLeft size={14} /> Back to messages
          </button>
        </div>
      </div>
    )
  }

  const canSend = !sending && (body.trim().length > 0 || pendingPhotos.length > 0)

  return (
    <div className="parent-shell">
      <div className="thread-view" style={{ margin: '0 auto', maxWidth: 720 }}>
        <div className="thread-view-header">
          <button className="thread-view-back" onClick={() => navigate('/parent/messages')} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="thread-view-title">
              {child?.first_name} {child?.last_name || ''}
            </div>
            <div className="thread-view-subtitle">with {providerName}</div>
          </div>
        </div>

        <div className="thread-view-messages">
          {!thread ? (
            <div className="thread-view-empty">
              {providerName} hasn't started a conversation yet. When they post an update, you'll see it here and can reply.
            </div>
          ) : messages.length === 0 ? (
            <div className="thread-view-empty">No messages yet.</div>
          ) : (
            messages.map(msg => {
              const fromMe = msg.sender_type === 'parent'
              const attachments = msg.message_attachments || []
              return (
                <div key={msg.id} className={`msg-row ${fromMe ? 'from-me' : 'from-them'}`}>
                  <div className="msg-bubble">
                    {attachments.length > 0 && (
                      <div className={`msg-photos count-${Math.min(attachments.length, 5)}`}>
                        {attachments.map(a => {
                          const url = signedUrls[a.storage_path]
                          return (
                            <div
                              key={a.id}
                              className="msg-photo"
                              onClick={() => url && setLightboxUrl(url)}
                            >
                              {url ? <img src={url} alt="" loading="lazy" /> : null}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {msg.body && (
                      <div className="msg-content">{msg.body}</div>
                    )}
                    <div className="msg-time">{formatTimestamp(msg.created_at)}</div>
                  </div>
                </div>
              )
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {thread && (
          <div className="thread-compose">
            {error && (
              <div style={{ color: 'var(--clr-error)', fontSize: '0.8125rem', padding: '0 4px 8px' }}>
                ⚠ {error}
              </div>
            )}
            {pendingPhotos.length > 0 && (
              <div className="thread-compose-photos">
                {pendingPhotos.map((p, i) => (
                  <div key={i} className="compose-photo-thumb">
                    <img src={p.previewUrl} alt="" />
                    <button
                      className="compose-photo-remove"
                      onClick={() => removePendingPhoto(i)}
                      aria-label="Remove photo"
                      type="button"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="thread-compose-row">
              <button
                className="thread-compose-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending || pendingPhotos.length >= MAX_PHOTOS}
                title="Add photos"
                type="button"
              >
                <ImagePlus size={18} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handlePickPhotos}
              />
              <textarea
                className="thread-compose-input"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Write a reply…"
                rows={1}
                disabled={sending}
              />
              <button
                className="thread-compose-btn thread-compose-send"
                onClick={handleSend}
                disabled={!canSend}
                type="button"
                title="Send"
              >
                <Send size={16} />
              </button>
            </div>
            {pendingPhotos.length > 0 && (
              <div className="thread-compose-helper">
                {pendingPhotos.length} of {MAX_PHOTOS} photos selected
              </div>
            )}
          </div>
        )}

        {lightboxUrl && (
          <div className="photo-lightbox" onClick={() => setLightboxUrl(null)}>
            <button className="photo-lightbox-close" onClick={() => setLightboxUrl(null)} aria-label="Close">
              <X size={20} />
            </button>
            <img src={lightboxUrl} alt="" onClick={(e) => e.stopPropagation()} />
          </div>
        )}
      </div>
    </div>
  )
}
