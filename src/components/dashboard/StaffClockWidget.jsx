import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Clock, LogIn, LogOut, AlertCircle, MapPin, Loader, Check } from 'lucide-react'

function formatDateTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000)
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours === 0) return `${mins}m`
  return `${hours}h ${String(mins).padStart(2, '0')}m`
}

/**
 * StaffClockWidget — shown on the dashboard for users with staff_membership rows.
 * Allows them to clock in / clock out for their licensee.
 *
 * Behavior:
 * - If no open shift: shows "Clock In" button
 * - If open shift exists: shows "Clock Out" button + live elapsed time
 * - If location_required is true on the membership: tries to get GPS at clock in/out
 *   - Permission granted: saves coords with the entry
 *   - Permission denied: still saves entry, flagged as denied
 *   - Permission unavailable: still saves entry, flagged as unavailable
 * - If location_required is false: skips GPS entirely
 */
export default function StaffClockWidget({ userId, membership }) {
  const [openShift, setOpenShift] = useState(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState(null)
  const [elapsed, setElapsed] = useState(0)

  // Load open shift
  useEffect(() => {
    if (!userId) return
    loadOpenShift()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Live update elapsed time while shift is open
  useEffect(() => {
    if (!openShift) {
      setElapsed(0)
      return
    }
    const startMs = new Date(openShift.clock_in).getTime()
    const tick = () => setElapsed(Date.now() - startMs)
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [openShift])

  async function loadOpenShift() {
    setLoading(true)
    const { data, error } = await supabase
      .from('staff_time_entries')
      .select('*')
      .eq('staff_user_id', userId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!error) setOpenShift(data)
    setLoading(false)
  }

  // Try to get GPS, but never block the action
  async function tryGetLocation() {
    if (!('geolocation' in navigator)) {
      return { status: 'unavailable', lat: null, lng: null }
    }
    return new Promise(resolve => {
      const timeoutId = setTimeout(() => {
        resolve({ status: 'timeout', lat: null, lng: null })
      }, 5000)
      navigator.geolocation.getCurrentPosition(
        pos => {
          clearTimeout(timeoutId)
          resolve({
            status: 'granted',
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          })
        },
        err => {
          clearTimeout(timeoutId)
          resolve({
            status: err.code === 1 ? 'denied' : 'error',
            lat: null,
            lng: null,
          })
        },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
      )
    })
  }

  async function handleClockIn() {
    setWorking(true)
    setMessage(null)
    let locationData = { status: 'not_required', lat: null, lng: null }
    if (membership.location_required) {
      locationData = await tryGetLocation()
    }
    const { data, error } = await supabase
      .from('staff_time_entries')
      .insert({
        staff_user_id: userId,
        licensee_id: membership.licensee_id,
        clock_in: new Date().toISOString(),
        clock_in_latitude: locationData.lat,
        clock_in_longitude: locationData.lng,
        clock_in_location_status: locationData.status,
      })
      .select()
      .single()
    setWorking(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      setOpenShift(data)
      setMessage({ type: 'success', text: '✓ Clocked in' })
    }
  }

  async function handleClockOut() {
    if (!openShift) return
    setWorking(true)
    setMessage(null)
    let locationData = { status: 'not_required', lat: null, lng: null }
    if (membership.location_required) {
      locationData = await tryGetLocation()
    }
    const { error } = await supabase
      .from('staff_time_entries')
      .update({
        clock_out: new Date().toISOString(),
        clock_out_latitude: locationData.lat,
        clock_out_longitude: locationData.lng,
        clock_out_location_status: locationData.status,
      })
      .eq('id', openShift.id)
    setWorking(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      setOpenShift(null)
      setMessage({ type: 'success', text: '✓ Clocked out — great work today' })
    }
  }

  if (loading) {
    return (
      <div style={{
        background: 'white',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        color: 'var(--clr-ink-soft)',
        fontSize: '0.875rem',
      }}>
        <Loader size={14} className="spin" />
        Loading your time entry…
      </div>
    )
  }

  // ─── Open shift (clocked in) ───
  if (openShift) {
    return (
      <div style={{
        background: 'linear-gradient(135deg, #dde8d9 0%, #c8d9c2 100%)',
        border: '1px solid var(--clr-sage)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(255,255,255,0.7)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              color: 'var(--clr-sage-dark)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
            }}>
              <Clock size={11} /> On the clock
            </div>
            <div style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.625rem',
              color: 'var(--clr-ink)',
              fontWeight: 500,
              letterSpacing: '-0.02em',
            }}>
              {formatDuration(elapsed)}
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', marginTop: 2 }}>
              Started {formatDateTime(openShift.clock_in)}
            </div>
            {openShift.clock_in_location_status === 'denied' && (
              <div style={{
                fontSize: '0.75rem',
                color: 'var(--clr-ink-soft)',
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}>
                <MapPin size={11} /> Location was not shared
              </div>
            )}
            {openShift.clock_in_location_status === 'granted' && (
              <div style={{
                fontSize: '0.75rem',
                color: 'var(--clr-sage-dark)',
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}>
                <MapPin size={11} /> Location recorded
              </div>
            )}
          </div>
          <button
            onClick={handleClockOut}
            disabled={working}
            style={{
              background: 'var(--clr-sage-dark)',
              color: 'white',
              border: 'none',
              padding: '14px 24px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.9375rem',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {working ? <><Loader size={16} className="spin" /> Saving…</> : <><LogOut size={16} /> Clock Out</>}
          </button>
        </div>
        {message && (
          <div style={{
            marginTop: 12,
            padding: '8px 12px',
            background: message.type === 'error' ? 'var(--clr-error-pale)' : 'rgba(255,255,255,0.6)',
            color: message.type === 'error' ? 'var(--clr-error)' : 'var(--clr-ink-mid)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.8125rem',
          }}>
            {message.type === 'error' ? <AlertCircle size={12} style={{ verticalAlign: '-2px' }} /> : null} {message.text}
          </div>
        )}
      </div>
    )
  }

  // ─── No open shift (clocked out) ───
  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-5)',
      marginBottom: 'var(--space-4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.125rem',
            color: 'var(--clr-ink)',
            fontWeight: 500,
            letterSpacing: '-0.01em',
            marginBottom: 4,
          }}>
            Ready to start your shift?
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)' }}>
            {membership.location_required
              ? 'We\'ll log your location when you clock in.'
              : 'Tap below to clock in.'}
          </div>
        </div>
        <button
          onClick={handleClockIn}
          disabled={working}
          style={{
            background: 'var(--clr-sage-dark)',
            color: 'white',
            border: 'none',
            padding: '14px 24px',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.9375rem',
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            whiteSpace: 'nowrap',
          }}
        >
          {working ? <><Loader size={16} className="spin" /> Working…</> : <><LogIn size={16} /> Clock In</>}
        </button>
      </div>
      {message && (
        <div style={{
          marginTop: 12,
          padding: '8px 12px',
          background: message.type === 'error' ? 'var(--clr-error-pale)' : 'var(--clr-success-pale)',
          color: message.type === 'error' ? 'var(--clr-error)' : 'var(--clr-success)',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.8125rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}>
          {message.type === 'error' ? <AlertCircle size={12} /> : <Check size={12} />}
          {message.text}
        </div>
      )}
    </div>
  )
}
