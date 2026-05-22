// Parent-dashboard banner: "You have N days awaiting your review."
// Self-loading — pass in the parent_id and the component handles its
// own data fetch. Renders nothing when count = 0 (or while loading)
// so the dashboard layout doesn't flicker.
//
// Spec § 10.1: 30-day lookback cap, counts unacknowledged + tampered
// segments only (FLAGGED and OVERRIDE are excluded — parent has acted
// or provider has attested).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  getDaysAwaitingParentReview,
  PARENT_BANNER_LOOKBACK_DAYS,
} from '@/lib/parentAcknowledgment'

function todayYMD() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

export default function AcknowledgmentBanner({ parentId }) {
  const navigate = useNavigate()
  const [count, setCount] = useState(0)
  const [childNames, setChildNames] = useState([])

  useEffect(() => {
    if (!parentId) return
    let cancelled = false

    const run = async () => {
      try {
        const startDate = addDaysYMD(todayYMD(), -PARENT_BANNER_LOOKBACK_DAYS)
        const endDate = todayYMD()

        // Family → children for this parent.
        const { data: links } = await supabase
          .from('parent_family_links')
          .select('family_id')
          .eq('parent_id', parentId)
          .eq('status', 'active')
        const familyIds = (links || []).map(l => l.family_id)
        if (familyIds.length === 0) return

        const { data: kids } = await supabase
          .from('children')
          .select('id, first_name, last_name')
          .in('family_id', familyIds)
        const kidsList = kids || []
        const childIds = kidsList.map(k => k.id)
        if (childIds.length === 0) return

        // Attendance + acks + flags in the lookback window.
        const [att, acks, fl] = await Promise.all([
          supabase
            .from('attendance')
            .select('id, child_id, date, segment_index, status, check_in, check_out')
            .in('child_id', childIds)
            .gte('date', startDate)
            .lte('date', endDate)
            .eq('status', 'present'),
          supabase
            .from('attendance_acknowledgments')
            .select('child_id, date, segment_index, acknowledged_via, attendance_snapshot_hash, archived_at')
            .in('child_id', childIds)
            .gte('date', startDate)
            .lte('date', endDate)
            .is('archived_at', null),
          supabase
            .from('acknowledgment_flags')
            .select('child_id, date, segment_index, resolved_at, archived_at')
            .in('child_id', childIds)
            .gte('date', startDate)
            .lte('date', endDate)
            .is('archived_at', null)
            .is('resolved_at', null),
        ])

        const awaiting = getDaysAwaitingParentReview({
          attendance: att.data || [],
          acknowledgments: acks.data || [],
          flags: fl.data || [],
          today: endDate,
        })

        if (cancelled) return
        setCount(awaiting.length)

        // Distinct child first-names appearing in the awaiting set, in
        // roster order, for the banner copy.
        const awaitingChildIds = new Set(awaiting.map(a => a.child_id))
        const names = kidsList
          .filter(k => awaitingChildIds.has(k.id))
          .map(k => k.first_name)
        setChildNames(names)
      } catch (err) {
        // Defensive: a missing table (migration 020 not yet applied) or
        // permission failure (RLS) makes this query fail. Banner
        // silently doesn't render rather than crashing the dashboard.
        console.warn('AcknowledgmentBanner: load skipped', err?.message || err)
      }
    }
    run()
    return () => { cancelled = true }
  }, [parentId])

  if (count === 0) return null

  return (
    <div style={{
      background: 'linear-gradient(135deg, #faf6ec 0%, #f4eee2 100%)',
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-lg)',
      padding: 14,
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <ClipboardCheck size={20} style={{ color: 'var(--clr-sage-dark)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.9375rem',
          color: 'var(--clr-ink)',
          marginBottom: 2,
        }}>
          You have {count} {count === 1 ? 'day' : 'days'} awaiting your review
          {childNames.length > 0 && (
            <> for {childNames.length <= 2
              ? childNames.join(' and ')
              : `${childNames.slice(0, -1).join(', ')}, and ${childNames[childNames.length - 1]}`}</>
          )}
        </div>
        <div style={{
          fontSize: '0.8125rem',
          color: 'var(--clr-ink-mid)',
          lineHeight: 1.4,
        }}>
          Confirm the hours your provider logged, or flag any day that needs a closer look.
        </div>
      </div>
      <button
        onClick={() => navigate('/parent/acknowledge')}
        style={{
          background: 'var(--clr-sage-dark)',
          border: 'none',
          color: 'white',
          padding: '8px 14px',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.8125rem',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        Review now
      </button>
    </div>
  )
}
