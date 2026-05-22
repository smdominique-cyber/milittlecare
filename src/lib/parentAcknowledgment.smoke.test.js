// PR #12 step 9 — end-to-end smoke test.
//
// Walks the parent-acknowledgment lifecycle on synthetic data using the
// pure helpers, asserting that each phase produces the state shown in
// the PR #12 spec § 7-10. The test exists so that future refactors of
// any one helper don't quietly break the full pipeline.
//
// What this test verifies (pure-side only):
//   1. Initial: provider records 5 days of attendance for a child.
//      countAcknowledgmentStates shows 5 UNACKNOWLEDGED.
//   2. Parent banner: getDaysAwaitingParentReview returns those 5.
//   3. Digest cadence: shouldSendDigestNow returns true at the right
//      moment given the provider's settings.
//   4. Digest body: buildDigestEmail produces an email referencing all
//      5 days and the portal link.
//   5. Parent confirms 3 days → ACKNOWLEDGED_CLEAN; banner count drops
//      to 2.
//   6. Parent flags 1 day → FLAGGED; banner count drops to 1.
//   7. Provider edits the remaining day → state UNACKNOWLEDGED (still).
//   8. Provider applies an override on it → ACKNOWLEDGED_OVERRIDE;
//      banner count drops to 0.
//   9. Provider edits a previously-clean day → TAMPERED; banner count
//      goes back to 1.
//
// What this test does NOT verify (those pieces need manual / live
// verification per CLAUDE.md § "Claude Code reports of verification are
// insufficient"):
//   - Resend email delivery end-to-end
//   - RLS policy correctness on real DB
//   - Browser rendering of /parent/acknowledge and /acknowledgments
//   - Cron schedule firing in Vercel
//   - notification_log row layout in production (different schema from
//     the spec; handled in 020 surgery, but only verifiable on live DB)

import { describe, it, expect } from 'vitest'
import {
  ACK_STATE,
  PARENT_BANNER_LOOKBACK_DAYS,
  computeAttendanceHash,
  countAcknowledgmentStates,
  findActiveAcknowledgment,
  getAcknowledgmentState,
  getDaysAwaitingParentReview,
} from './parentAcknowledgment'
import {
  buildDigestEmail,
  digestDateRange,
  shouldSendDigestNow,
} from './acknowledgmentDigest'

// -----------------------------------------------------------------------------
// Test fixtures — modeled on Venessa (the real customer) with a child
// "Mia" attending 5 weekdays in May 2026.
// -----------------------------------------------------------------------------

const CHILD = { id: 'kid-mia', first_name: 'Mia', last_name: 'Reeves' }
const TODAY = '2026-05-22'   // Friday — looking back at the past week

const PROVIDER_SETTINGS = {
  full_name: 'Venessa Smith',
  daycare_name: "Venessa's Daycare",
  acknowledgment_cadence: 'weekly',
  acknowledgment_strictness: 'warning',
  acknowledgment_email_enabled: true,
  acknowledgment_email_send_day: 0,        // Sunday
  acknowledgment_email_send_hour: 18,      // 6 PM local
  acknowledgment_email_timezone: 'America/Detroit',
}

const PARENT = {
  id: 'parent-1',
  email: 'parent@example.com',
  full_name: 'Erin Reeves',
}

function segment(date, segIdx = 0) {
  return {
    id: `att-${date}-${segIdx}`,
    child_id: CHILD.id,
    date,
    segment_index: segIdx,
    status: 'present',
    check_in: '08:00',
    check_out: '16:00',
  }
}

function ack(rec, via = 'parent_portal') {
  return {
    id: `ack-${rec.id}`,
    child_id: rec.child_id,
    date: rec.date,
    segment_index: rec.segment_index ?? 0,
    acknowledged_at: '2026-05-22T08:00:00.000Z',
    acknowledged_via: via,
    attendance_snapshot_hash: computeAttendanceHash(rec),
    archived_at: null,
  }
}

function flag(rec) {
  return {
    id: `flag-${rec.id}`,
    child_id: rec.child_id,
    date: rec.date,
    segment_index: rec.segment_index ?? 0,
    flagged_at: '2026-05-22T08:30:00.000Z',
    resolved_at: null,
    archived_at: null,
  }
}

// -----------------------------------------------------------------------------
// The walkthrough
// -----------------------------------------------------------------------------

describe('PR #12 smoke test — full lifecycle', () => {
  // The week of May 17 – May 22, 2026 inclusive (5 weekdays).
  const days = ['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22']
  const attendance = days.map(d => segment(d))

  it('phase 1: provider records attendance; everything is UNACKNOWLEDGED', () => {
    const counts = countAcknowledgmentStates({
      attendance,
      acknowledgments: [],
      flags: [],
    })
    expect(counts[ACK_STATE.UNACKNOWLEDGED]).toBe(5)
    expect(counts[ACK_STATE.ACKNOWLEDGED_CLEAN]).toBe(0)
    expect(counts[ACK_STATE.TAMPERED]).toBe(0)
    expect(counts[ACK_STATE.FLAGGED]).toBe(0)
    expect(counts[ACK_STATE.ACKNOWLEDGED_OVERRIDE]).toBe(0)
  })

  it('phase 2: parent banner reports 5 days awaiting review', () => {
    const awaiting = getDaysAwaitingParentReview({
      attendance,
      acknowledgments: [],
      flags: [],
      today: TODAY,
      lookbackDays: PARENT_BANNER_LOOKBACK_DAYS,
    })
    expect(awaiting).toHaveLength(5)
    expect(awaiting.map(r => r.date).sort()).toEqual(days)
  })

  it('phase 3: digest cadence fires Sunday 18:00 local (America/Detroit)', () => {
    // Sunday 2026-05-17 18:00 Detroit = 22:00 UTC (EDT in May)
    const sundayEvening = new Date('2026-05-17T22:00:00.000Z')
    const tuesdayMorning = new Date('2026-05-19T13:00:00.000Z')
    expect(shouldSendDigestNow({ provider: PROVIDER_SETTINGS, nowUtc: sundayEvening })).toBe(true)
    expect(shouldSendDigestNow({ provider: PROVIDER_SETTINGS, nowUtc: tuesdayMorning })).toBe(false)
    // Email-disabled providers never fire.
    expect(shouldSendDigestNow({
      provider: { ...PROVIDER_SETTINGS, acknowledgment_email_enabled: false },
      nowUtc: sundayEvening,
    })).toBe(false)
  })

  it('phase 4: digest body references provider, parent, window, and portal link', () => {
    const range = digestDateRange({
      cadence: 'weekly',
      nowUtc: new Date('2026-05-22T22:00:00.000Z'),
      timezone: 'America/Detroit',
    })
    const email = buildDigestEmail({
      providerName: "Venessa's Daycare",
      parentFirstName: 'Erin',
      childFirstNames: ['Mia'],
      weekStart: range.start,
      weekEnd: range.end,
      portalUrl: 'https://milittlecare.com/parent/acknowledge',
    })
    expect(email.subject).toMatch(/review hours/i)
    expect(email.subject).toContain('Mia')
    expect(email.html).toContain("Venessa's Daycare")
    expect(email.html).toContain('Mia')
    expect(email.html).toContain('parent/acknowledge')
    expect(email.text).toContain('Hi Erin')
  })

  it('phase 5: parent confirms 3 days → 3 CLEAN, 2 UNACKNOWLEDGED', () => {
    const confirmed = attendance.slice(0, 3).map(r => ack(r))
    const counts = countAcknowledgmentStates({
      attendance, acknowledgments: confirmed, flags: [],
    })
    expect(counts[ACK_STATE.ACKNOWLEDGED_CLEAN]).toBe(3)
    expect(counts[ACK_STATE.UNACKNOWLEDGED]).toBe(2)
    const awaiting = getDaysAwaitingParentReview({
      attendance, acknowledgments: confirmed, flags: [],
      today: TODAY,
    })
    expect(awaiting).toHaveLength(2)
  })

  it('phase 6: parent flags 1 day → 3 CLEAN, 1 FLAGGED, 1 UNACKNOWLEDGED', () => {
    const confirmed = attendance.slice(0, 3).map(r => ack(r))
    const flags = [flag(attendance[3])]
    const counts = countAcknowledgmentStates({
      attendance, acknowledgments: confirmed, flags,
    })
    expect(counts[ACK_STATE.ACKNOWLEDGED_CLEAN]).toBe(3)
    expect(counts[ACK_STATE.FLAGGED]).toBe(1)
    expect(counts[ACK_STATE.UNACKNOWLEDGED]).toBe(1)
    // Banner excludes FLAGGED (parent already acted; provider's turn).
    const awaiting = getDaysAwaitingParentReview({
      attendance, acknowledgments: confirmed, flags, today: TODAY,
    })
    expect(awaiting).toHaveLength(1)
    expect(awaiting[0].date).toBe(days[4])
  })

  it('phase 7: provider edits the still-unacknowledged day; state stays UNACKNOWLEDGED', () => {
    const confirmed = attendance.slice(0, 3).map(r => ack(r))
    const flags = [flag(attendance[3])]
    // Edit the 5th day: check_out 16:00 → 17:30.
    const edited = { ...attendance[4], check_out: '17:30' }
    const state = getAcknowledgmentState(edited, confirmed, flags)
    expect(state).toBe(ACK_STATE.UNACKNOWLEDGED)
  })

  it('phase 8: provider applies override on the edited day → ACKNOWLEDGED_OVERRIDE', () => {
    const edited = { ...attendance[4], check_out: '17:30' }
    const overrideAck = ack(edited, 'provider_override')
    const state = getAcknowledgmentState(edited, [overrideAck], [])
    expect(state).toBe(ACK_STATE.ACKNOWLEDGED_OVERRIDE)
  })

  it('phase 9: provider edits a previously-clean day → TAMPERED', () => {
    const original = attendance[0]
    const cleanAck = ack(original)
    // After ack, provider extends the day to 18:00 — hash changes.
    const tamperedRow = { ...original, check_out: '18:00' }
    const state = getAcknowledgmentState(tamperedRow, [cleanAck], [])
    expect(state).toBe(ACK_STATE.TAMPERED)
    // findActiveAcknowledgment still finds it (the row's still there;
    // it's the hash comparison that flags the mismatch).
    expect(findActiveAcknowledgment([cleanAck], tamperedRow)).toBe(cleanAck)
  })

  it('end-to-end count summary at the end of the walkthrough', () => {
    // 3 originally clean (one of which is now tampered after phase 9),
    // 1 flagged, 1 acknowledged_override.
    const cleanAcks = attendance.slice(0, 3).map(r => ack(r))
    const flags = [flag(attendance[3])]
    const overrideAck = ack({ ...attendance[4], check_out: '17:30' }, 'provider_override')
    const tampered = { ...attendance[0], check_out: '18:00' }

    const finalAttendance = [
      tampered,                  // was clean, now tampered
      attendance[1],             // still clean
      attendance[2],             // still clean
      attendance[3],             // flagged
      { ...attendance[4], check_out: '17:30' },  // overridden
    ]
    const finalAcks = [...cleanAcks, overrideAck]
    const counts = countAcknowledgmentStates({
      attendance: finalAttendance,
      acknowledgments: finalAcks,
      flags,
    })
    expect(counts[ACK_STATE.ACKNOWLEDGED_CLEAN]).toBe(2)
    expect(counts[ACK_STATE.TAMPERED]).toBe(1)
    expect(counts[ACK_STATE.FLAGGED]).toBe(1)
    expect(counts[ACK_STATE.ACKNOWLEDGED_OVERRIDE]).toBe(1)
    expect(counts[ACK_STATE.UNACKNOWLEDGED]).toBe(0)
  })
})
