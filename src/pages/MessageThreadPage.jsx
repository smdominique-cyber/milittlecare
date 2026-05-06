import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useRole } from '@/hooks/useRole'
import { supabase } from '@/lib/supabase'
import {
  loadThreadByChildId,
  loadMessages,
  markParentMessagesRead,
  getOrCreateThread,
  sendMessage,
  notifyParentsOfMessage,
  getSignedPhotoUrls,
} from '@/lib/messages'
import { ChevronLeft, ImagePlus, Send, X } from 'lucide-react'
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

export default function MessageThreadPage() {
  const navigate = useNavigate()
  const { childId } = useParams()
  const { user } = useAuth()
  const { licenseeId } = useRole()

  const [enabled, setEnabled] = useState(null)
  const [child, setChild] = useState(null)
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [signedUrls, setSignedUrls] = useState({})
  const [body, setBody] = useState('')
  const [pendingPhotos, setPendingPhotos] = useState([])  // {file, previewUrl}
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [lightboxUrl, setLightboxUrl] = useState(null)

  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
  }, [])

  useEffect(() => {
    if (!licenseeId || !childId) return
    bootstrap()
    return () => {
      // Clean up object URLs from pending photos
      pendingPhotos.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseeId, childId])

  async function bootstrap() {
    setLoading(true)
    setError(null)

    // Check messaging_enabled
    const { data: policy } = await supabase
      .from('business_policies')
      .select('messaging_enabled')
      .eq('user_id', licenseeId)
      .maybeSingle()
    if (!policy?.messaging_enabled) {
      setEnabled(false)
      setLoading(false)
      return
    }
    setEnabled(true)

    const { child: c, thread: t } = await loadThreadByChildId(licenseeId, childId)
    if (!c) {
      setError('Child not found')
      setLoading(false)
      return
    }
    setChild(c)
    setThread(t)
    if (t) {
      const msgs = await loadMessages(t.id)
      setMessages(msgs)
      await refreshSignedUrls(msgs)
      // Mark parent messages read
      await markParentMessagesRead(t.id)
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
    // Reset input so the same file could be picked again later
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
    if (sending) return
    if (!body.trim() && pendingPhotos.length === 0) return
    setSending(true)
    setError(null)

    try {
      // Ensure thread exists
      let activeThread = thread
      if (!activeThread) {
        activeThread = await getOrCreateThread({
          providerUserId: licenseeId,
          familyId: child.family_id,
          childId: child.id,
        })
        setThread(activeThread)
      }

      const photoFiles = pendingPhotos.map(p => p.file)
      const { message: newMsg, failedPhotos } = await sendMessage({
        threadId: activeThread.id,
        senderUserId: user.id,
        senderType: 'provider',
        body: body.trim() || null,
        photoFiles,
      })

      // Clear compose
      pendingPhotos.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
      setBody('')
      setPendingPhotos([])

      // Reload messages (includes new attachments)
      const msgs = await loadMessages(activeThread.id)
      setMessages(msgs)
      await refreshSignedUrls(msgs)
      setTimeout(scrollToBottom, 50)

      // Fire-and-forget notification
      notifyParentsOfMessage({
        threadId: activeThread.id,
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
    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (loading || enabled === null) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  if (enabled === false) {
    return (
      <div className="messages-page">
        <div className="messaging-disabled-notice">
          <h3>Messaging is turned off</h3>
          <p>Enable it in Business Info to send messages and photos to parents.</p>
          <button className="btn-add-family" onClick={() => navigate('/business-info')}>
            Open Business Info
          </button>
        </div>
      </div>
    )
  }

  if (error && !child) {
    return (
      <div className="messages-page">
        <div className="messages-empty">
          <div className="messages-empty-title">{error}</div>
          <button className="btn-add-family" onClick={() => navigate('/messages')}>
            Back to Messages
          </button>
        </div>
      </div>
    )
  }

  const familyName = child?.families?.family_name || ''
  const canSend = !sending && (body.trim().length > 0 || pendingPhotos.length > 0)

  return (
    <div className="thread-view">
      <div className="thread-view-header">
        <button className="thread-view-back" onClick={() => navigate('/messages')} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="thread-view-title">
            {child?.first_name} {child?.last_name || ''}
          </div>
          {familyName && (
            <div className="thread-view-subtitle">{familyName}</div>
          )}
        </div>
      </div>

      <div className="thread-view-messages">
        {messages.length === 0 ? (
          <div className="thread-view-empty">
            No messages yet. Send the first update — a quick "had a great morning!" goes a long way.
          </div>
        ) : (
          messages.map(msg => {
            const fromMe = msg.sender_type === 'provider'
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
            placeholder="Write a message…"
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

      {lightboxUrl && (
        <div className="photo-lightbox" onClick={() => setLightboxUrl(null)}>
          <button className="photo-lightbox-close" onClick={() => setLightboxUrl(null)} aria-label="Close">
            <X size={20} />
          </button>
          <img src={lightboxUrl} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
