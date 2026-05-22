import { useState, useEffect } from 'react' 
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { Loader, RefreshCw, AlertCircle, Shield } from 'lucide-react'

const ADMIN_EMAIL = 'smdominique@gmail.com'
const REFRESH_INTERVAL_MS = 120000  // 2 minutes

function formatDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatCurrency(n) {
  if (n == null) return '—'
  return '$' + parseFloat(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Color the activity column based on days since action
function activityColor(days) {
  if (days == null) return 'var(--clr-ink-soft)'
  if (days === 0) return 'var(--clr-success)'
  if (days <= 3) return 'var(--clr-sage-dark)'
  if (days <= 7) return 'var(--clr-ink-mid)'
  if (days <= 14) return '#a8854a'
  return 'var(--clr-error)'
}

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL

  useEffect(() => {
    if (!isAdmin) return
    loadData()
    const interval = setInterval(loadData, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  async function loadData() {
    setError(null)
    const { data, error } = await supabase.rpc('admin_user_progress')
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setRows(data || [])
    setLastRefresh(new Date())
    setLoading(false)
  }

  if (authLoading) {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <Loader size={28} className="spin" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div style={{
        background: 'white',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 60,
        textAlign: 'center',
        maxWidth: 480,
        margin: '40px auto',
      }}>
        <Shield size={32} style={{ color: 'var(--clr-error)', marginBottom: 12 }} />
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', color: 'var(--clr-ink)', margin: '0 0 8px' }}>
          Not authorized
        </h2>
        <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', margin: 0 }}>
          This page is restricted.
        </p>
      </div>
    )
  }

  return (
    <div style={{ padding: '0' }}>
      <div style={{
        background: 'white',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.5rem',
              fontWeight: 400,
              color: 'var(--clr-ink)',
              margin: '0 0 4px',
              letterSpacing: '-0.02em',
            }}>
              Admin · User Progress
            </h2>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.875rem', margin: 0 }}>
              {rows.length} {rows.length === 1 ? 'user' : 'users'}
              {lastRefresh && (
                <span style={{ marginLeft: 8, color: 'var(--clr-ink-soft)' }}>
                  · Last refreshed {formatDateTime(lastRefresh)}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--clr-sage-dark)',
              color: 'white',
              border: 'none',
              padding: '8px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.8125rem',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-body)',
            }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: 14,
          background: 'var(--clr-error-pale)',
          color: 'var(--clr-error)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div style={{
          background: 'white',
          border: '1px solid var(--clr-warm-mid)',
          borderRadius: 'var(--radius-lg)',
          padding: 60,
          textAlign: 'center',
        }}>
          <Loader size={28} className="spin" style={{ color: 'var(--clr-sage-dark)' }} />
          <div style={{ marginTop: 12, color: 'var(--clr-ink-soft)' }}>Loading user data…</div>
        </div>
      ) : (
        <div style={{
          background: 'white',
          border: '1px solid var(--clr-warm-mid)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.8125rem',
              fontFamily: 'var(--font-body)',
            }}>
              <thead>
                <tr style={{ background: 'var(--clr-cream)', borderBottom: '1px solid var(--clr-warm-mid)' }}>
                  <th style={th}>User</th>
                  <th style={th}>Status</th>
                  <th style={th}>Signed up</th>
                  <th style={th}>Last action</th>
                  <th style={th}>Session refresh</th>
                  <th style={thNum}>Families</th>
                  <th style={thNum}>Kids</th>
                  <th style={thNum}>Invoices</th>
                  <th style={thNum}>Paid</th>
                  <th style={thNum}>Collected</th>
                  <th style={thNum}>Attendance</th>
                  <th style={thNum}>Receipts</th>
                  <th style={thNum}>Messages</th>
                  <th style={thNum}>Staff</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--clr-warm-mid)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>
                        {r.full_name || '(no name)'}
                      </div>
                      <div style={{ color: 'var(--clr-ink-soft)', fontSize: '0.75rem' }}>
                        {r.email}
                      </div>
                    </td>
                    <td style={td}>
                      <span style={{
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        background: r.status?.includes('comped') ? '#f4e7fd'
                          : r.status === 'paying' ? 'var(--clr-success-pale)'
                          : r.status?.includes('trial') ? 'var(--clr-warm)'
                          : r.status === 'TRIAL EXPIRED' ? 'var(--clr-error-pale)'
                          : 'var(--clr-cream)',
                        color: r.status?.includes('comped') ? '#7a4ab8'
                          : r.status === 'paying' ? 'var(--clr-success)'
                          : r.status === 'TRIAL EXPIRED' ? 'var(--clr-error)'
                          : 'var(--clr-ink-mid)',
                        whiteSpace: 'nowrap',
                      }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={td}>
                      <div>{formatDate(r.signed_up)}</div>
                      <div style={{ color: 'var(--clr-ink-soft)', fontSize: '0.75rem' }}>
                        {r.days_since_signup}d ago
                      </div>
                    </td>
                    <td style={{ ...td, color: activityColor(r.days_since_action) }}>
                      <div style={{ fontWeight: 500 }}>
                        {r.days_since_action === 0 ? 'Today'
                          : r.days_since_action === 1 ? 'Yesterday'
                          : r.days_since_action != null ? `${r.days_since_action}d ago`
                          : '—'}
                      </div>
                      <div style={{ fontSize: '0.6875rem', opacity: 0.75 }}>
                        {formatDateTime(r.last_action_at)}
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--clr-ink-mid)' }}>
                        {formatDateTime(r.last_session_refresh)}
                      </div>
                    </td>
                    <td style={tdNum}>{r.families}</td>
                    <td style={tdNum}>{r.children}</td>
                    <td style={tdNum}>{r.invoices_total}</td>
                    <td style={tdNum}>{r.invoices_paid}</td>
                    <td style={tdNum}>{formatCurrency(r.total_collected)}</td>
                    <td style={tdNum}>{r.attendance_records}</td>
                    <td style={tdNum}>{r.receipts}</td>
                    <td style={tdNum}>{r.messages_sent}</td>
                    <td style={tdNum}>{r.active_staff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{
        marginTop: 16,
        fontSize: '0.75rem',
        color: 'var(--clr-ink-soft)',
        textAlign: 'center',
      }}>
        Auto-refreshes every 2 minutes. "Last action" = newest record across all activity tables. "Session refresh" = Supabase access token refresh (every ~1hr while active).
      </div>
    </div>
  )
}

// ─── Cell styles ─────
const th = {
  padding: '12px 14px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '0.6875rem',
  color: 'var(--clr-ink-mid)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
}

const thNum = {
  ...th,
  textAlign: 'right',
}

const td = {
  padding: '12px 14px',
  verticalAlign: 'top',
  color: 'var(--clr-ink)',
}

const tdNum = {
  ...td,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}
