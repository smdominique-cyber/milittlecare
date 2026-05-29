// PR #16 follow-up — Issue #2: tabbed parent-acknowledgment surface.
//
// The PR #16 spec called for an "Intake tab" on the existing PR #12
// parent-acknowledgment page three times (docs/pr-16-child-files-scope.md
// § B.6, § C UI surfaces, § Step 5). The original build shipped a
// standalone /parent/intake-acknowledge route with the deviation
// justified by a header comment promising "linked from there" — that
// link was never wired, so no parent could reach intake from inside the
// portal. This wrapper closes the gap.
//
// This component is mounted at BOTH /parent/acknowledge and
// /parent/intake-acknowledge:
//   - /parent/acknowledge      → default tab Attendance (Attendance first
//                                if both have pending — see below).
//   - /parent/intake-acknowledge → forces tab=intake, preserving the
//                                  email CTA built by ChildIntakeModal
//                                  (`/parent/intake-acknowledge?child=<id>`).
//   - Either URL respects `?tab=attendance|intake` as an explicit
//     override.
//
// Default-tab policy: Attendance wins ties. We surface a pending count
// badge on the Intake tab when there ARE pending intake acks, so a
// parent who lands on /parent/acknowledge with intake work waiting still
// has a visible cue to switch. Auto-switching to Intake when only Intake
// has pending (and Attendance is empty) requires an upfront attendance
// pending count that mirrors the existing ParentAcknowledgePage's
// derivation — not duplicated here. Simplification flagged in the halt.
//
// Each tab mounts the existing page component unchanged. Both pages
// manage their own session resolution, data load, and confirm flow.
// The wrapper is presentation only; no business logic moved.

import { useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import ParentAcknowledgePage from './ParentAcknowledgePage'
import ParentIntakeAcknowledgePage from './ParentIntakeAcknowledgePage'

const TAB_ATTENDANCE = 'attendance'
const TAB_INTAKE = 'intake'

export default function ParentAcknowledgmentsPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const urlTab = searchParams.get('tab')
  const isIntakeRoute = location.pathname === '/parent/intake-acknowledge'

  // Initial tab: URL hint wins, then route, then default.
  const [activeTab, setActiveTab] = useState(() => {
    if (urlTab === TAB_INTAKE || urlTab === TAB_ATTENDANCE) return urlTab
    if (isIntakeRoute) return TAB_INTAKE
    return TAB_ATTENDANCE
  })

  // Intake pending count drives the badge. Lightweight RPC call;
  // failures are non-fatal (no badge, no crash). Same RPC the intake
  // page itself uses, so the dispatcher's role + parent_family_links
  // guard apply uniformly.
  const [intakePendingCount, setIntakePendingCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function fetchCount() {
      try {
        const { data, error } = await supabase.rpc(
          'reminder_instance_list_for_parent'
        )
        if (cancelled) return
        if (error) return
        const list = Array.isArray(data) ? data : []
        // De-dupe by subject_id so the badge shows children, not rows.
        const subjects = new Set()
        for (const r of list) if (r && r.subject_id) subjects.add(r.subject_id)
        setIntakePendingCount(subjects.size)
      } catch {
        // non-fatal
      }
    }
    fetchCount()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="parent-acknowledgments-wrapper">
      <nav role="tablist" aria-label="Parent acknowledgments"
        style={tabStripStyles.strip}
      >
        <button
          role="tab"
          aria-selected={activeTab === TAB_ATTENDANCE}
          onClick={() => setActiveTab(TAB_ATTENDANCE)}
          style={tabStripStyles.tab(activeTab === TAB_ATTENDANCE)}
        >
          Attendance
        </button>
        <button
          role="tab"
          aria-selected={activeTab === TAB_INTAKE}
          onClick={() => setActiveTab(TAB_INTAKE)}
          style={tabStripStyles.tab(activeTab === TAB_INTAKE)}
        >
          Intake
          {intakePendingCount > 0 && (
            <span style={tabStripStyles.badge} aria-label={`${intakePendingCount} pending`}>
              {intakePendingCount}
            </span>
          )}
        </button>
      </nav>

      <div role="tabpanel">
        {activeTab === TAB_ATTENDANCE
          ? <ParentAcknowledgePage />
          : <ParentIntakeAcknowledgePage />}
      </div>
    </div>
  )
}

const tabStripStyles = {
  strip: {
    display: 'flex',
    gap: 4,
    padding: '8px 12px 0 12px',
    maxWidth: 720,
    margin: '0 auto',
    borderBottom: '1px solid var(--clr-warm-mid)',
  },
  tab: (active) => ({
    background: 'transparent',
    border: 'none',
    padding: '12px 16px',
    fontSize: '0.9375rem',
    fontFamily: 'var(--font-body)',
    color: active ? 'var(--clr-sage-dark)' : 'var(--clr-ink-mid)',
    fontWeight: active ? 600 : 400,
    borderBottom: active ? '2px solid var(--clr-sage-dark)' : '2px solid transparent',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: -1,
  }),
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
    height: 20,
    padding: '0 6px',
    borderRadius: 10,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: 'var(--clr-sage-dark)',
    color: 'white',
  },
}
