// Messaging helpers — DB queries and photo upload utilities.
// All operations rely on RLS for authorization; queries are scoped by auth.uid() server-side.

import { supabase } from '@/lib/supabase'
import imageCompression from 'browser-image-compression'

const PHOTO_BUCKET = 'message-photos'
const SIGNED_URL_TTL_SECONDS = 60 * 60  // 1 hour

const COMPRESSION_OPTIONS = {
  maxSizeMB: 0.3,
  maxWidthOrHeight: 1600,
  useWebWorker: true,
  fileType: 'image/jpeg',
}

// ─── Threads ─────────────────────────────────────────────

export async function loadProviderThreadsWithChildren(providerUserId) {
  // Returns { children: [...], threads: [...], unreadByThread: {threadId: count} }
  // We hydrate by joining client-side since RLS makes joins through the API tricky.
  const [childrenResp, threadsResp] = await Promise.all([
    supabase
      .from('children')
      .select('id, first_name, last_name, family_id, families(family_name)')
      .eq('user_id', providerUserId),
    supabase
      .from('message_threads')
      .select('*')
      .eq('provider_user_id', providerUserId)
      .order('last_message_at', { ascending: false }),
  ])

  const children = childrenResp.data || []
  const threads = threadsResp.data || []

  // Get unread counts per thread (parent messages without read_by_other_at)
  let unreadByThread = {}
  if (threads.length > 0) {
    const threadIds = threads.map(t => t.id)
    const { data: unread } = await supabase
      .from('messages')
      .select('thread_id')
      .in('thread_id', threadIds)
      .eq('sender_type', 'parent')
      .is('read_by_other_at', null)
    if (unread) {
      unread.forEach(m => {
        unreadByThread[m.thread_id] = (unreadByThread[m.thread_id] || 0) + 1
      })
    }
  }

  // Get last message preview per thread
  let lastMessageByThread = {}
  if (threads.length > 0) {
    const threadIds = threads.map(t => t.id)
    const { data: lastMsgs } = await supabase
      .from('messages')
      .select('thread_id, body, created_at, sender_type')
      .in('thread_id', threadIds)
      .order('created_at', { ascending: false })
    if (lastMsgs) {
      lastMsgs.forEach(m => {
        if (!lastMessageByThread[m.thread_id]) {
          lastMessageByThread[m.thread_id] = m
        }
      })
    }
  }

  return { children, threads, unreadByThread, lastMessageByThread }
}

export async function getOrCreateThread({ providerUserId, familyId, childId }) {
  // Try to find existing thread
  const { data: existing } = await supabase
    .from('message_threads')
    .select('*')
    .eq('provider_user_id', providerUserId)
    .eq('child_id', childId)
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('message_threads')
    .insert({
      provider_user_id: providerUserId,
      family_id: familyId,
      child_id: childId,
    })
    .select()
    .single()

  if (error) throw error
  return created
}

export async function loadThreadByChildId(providerUserId, childId) {
  // Returns the thread (or null) and the child + family info
  const { data: child } = await supabase
    .from('children')
    .select('id, first_name, last_name, family_id, families(family_name)')
    .eq('user_id', providerUserId)
    .eq('id', childId)
    .maybeSingle()

  if (!child) return { child: null, thread: null }

  const { data: thread } = await supabase
    .from('message_threads')
    .select('*')
    .eq('provider_user_id', providerUserId)
    .eq('child_id', childId)
    .maybeSingle()

  return { child, thread }
}

// ─── Messages ─────────────────────────────────────────────

export async function loadMessages(threadId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*, message_attachments(*)')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function markParentMessagesRead(threadId) {
  const now = new Date().toISOString()
  await supabase
    .from('messages')
    .update({ read_by_other_at: now })
    .eq('thread_id', threadId)
    .eq('sender_type', 'parent')
    .is('read_by_other_at', null)
}

export async function sendMessage({ threadId, senderUserId, senderType, body, photoFiles }) {
  // 1. Insert the message row first so we have a message_id for photo paths
  const { data: messageRow, error: msgErr } = await supabase
    .from('messages')
    .insert({
      thread_id: threadId,
      sender_type: senderType,
      sender_user_id: senderUserId,
      body: body || null,
    })
    .select()
    .single()
  if (msgErr) throw msgErr

  // 2. Compress + upload each photo, then insert attachment rows
  const failedPhotos = []
  if (photoFiles && photoFiles.length > 0) {
    for (const file of photoFiles) {
      try {
        const compressed = await compressPhoto(file)
        const safeName = sanitizeFilename(file.name || 'photo.jpg')
        const path = `${threadId}/${messageRow.id}/${safeName}`
        const { error: uploadErr } = await supabase
          .storage
          .from(PHOTO_BUCKET)
          .upload(path, compressed, {
            cacheControl: '3600',
            upsert: false,
            contentType: 'image/jpeg',
          })
        if (uploadErr) throw uploadErr

        // Get dimensions for layout decisions on render
        const dimensions = await getImageDimensions(compressed).catch(() => ({ width: null, height: null }))

        const { error: attachErr } = await supabase
          .from('message_attachments')
          .insert({
            message_id: messageRow.id,
            storage_path: path,
            width: dimensions.width,
            height: dimensions.height,
          })
        if (attachErr) throw attachErr
      } catch (err) {
        failedPhotos.push({ filename: file.name, error: err.message })
      }
    }
  }

  return { message: messageRow, failedPhotos }
}

// ─── Notifications ────────────────────────────────────────

export async function notifyParentsOfMessage({ threadId, messageId, hasPhotos, bodyPreview }) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { ok: false, error: 'No session' }
    const resp = await fetch('/api/send-message-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        thread_id: threadId,
        message_id: messageId,
        has_photos: hasPhotos,
        body_preview: bodyPreview || '',
      }),
    })
    const data = await resp.json()
    return { ok: resp.ok, ...data }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ─── Photos ─────────────────────────────────────────────

export async function getSignedPhotoUrl(storagePath) {
  const { data, error } = await supabase
    .storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
  if (error) return null
  return data?.signedUrl || null
}

export async function getSignedPhotoUrls(storagePaths) {
  // Returns object { storagePath: url }
  const result = {}
  await Promise.all(storagePaths.map(async (p) => {
    const url = await getSignedPhotoUrl(p)
    if (url) result[p] = url
  }))
  return result
}

async function compressPhoto(file) {
  // Returns a File blob ~300kb max, max 1600px on longest side, JPEG
  if (!file.type.startsWith('image/')) {
    throw new Error('Not an image file')
  }
  return await imageCompression(file, COMPRESSION_OPTIONS)
}

async function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}

function sanitizeFilename(name) {
  // Strip path segments, keep only ASCII letters/digits/dot/dash/underscore
  const base = name.split(/[\\/]/).pop() || 'photo'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_')
  // Ensure there's an extension
  if (!/\.[a-zA-Z0-9]+$/.test(cleaned)) return cleaned + '.jpg'
  return cleaned
}
