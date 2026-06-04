// PR #16 V1 — Parent intake acknowledgment portal.
//
// Per the scope's OQ1 resolution, parent self-sign ships in PR #16.
// V1 ships this as a sibling page to PR #12's
// /parent/acknowledge (attendance acks) at /parent/intake-acknowledge,
// linked from there. A future consolidation may merge them into a
// single tabbed surface; for V1 the two flows are distinct routes so
// the existing attendance portal stays untouched.
//
// Flow:
//   1. Load parent's children via parent_family_links -> families ->
//      children (active only).
//   2. Load active acknowledgments rows for each child.
//   3. Group rows by child. Each child's card shows the active ack
//      types + a single "I confirm these" button.
//   4. On confirm, archive the existing active rows for that child and
//      insert new parent_portal rows for the same types, keyed to
//      auth.uid(). The envelope row's snapshot_hash is recomputed from
//      the new sub-row hashes.
//
// Channel-shape CHECK (migration 024): parent_portal requires
// acknowledged_by_user_id IS NOT NULL and provider_override_reason IS NULL.

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, ArrowLeft, AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  ACK_TYPES,
  computeAckHash,
  computeEnvelopeHash,
} from '@/lib/acknowledgments'
// Phase X (2026-06-03) — the three parent-view bug fixes:
//   - Bug 1 (raw type strings): pull labels from the engine via
//     `labelForAckType` — the engine's REQUIREMENT_REGISTRY is the
//     single source of truth for friendly labels.
//   - Bug 2 (per-occurrence leak into intake bundle): use
//     `isIntakeBundleAckType` to filter the ack fetch to only
//     intake-bundle types. Per-occurrence consents now structurally
//     can't reach the confirm bundle.
// See docs/pr-parent-self-service-scope.md §4.
import {
  INTAKE_BUNDLE_ACK_TYPES,
  isIntakeBundleAckType,
  labelForAckType,
} from '@/lib/parentComplianceProjections'
// PR #16 follow-up (parent-confirm bug, 2026-05-29): `listPendingForParent`
// is still used to populate the pending-card UI; `resolvePendingForChild`
// is GONE because intake_confirm_for_parent (migration 025) now resolves
// the reminder inline as part of the same atomic transaction that writes
// the parent_portal acks.
import { listPendingForParent } from '@/lib/parentIntakeReminders'
import '@/styles/parent.css'

export default function ParentIntakeAcknowledgePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // PR #16 UPDATE: the dispatcher's CTA link is
  // /parent/intake-acknowledge?child=<id>; this prefocuses the matching
  // card. Loading still pulls every pending child so the parent can
  // confirm siblings in one sitting.
  const focusChildId = searchParams.get('child')
  const [user, setUser] = useState(null)
  const [children, setChildren] = useState([])
  const [acksByChild, setAcksByChild] = useState({})
  // PR #16 UPDATE: pending intake_acknowledgment_pending reminder
  // instances per child, indexed by subject_id. On parent confirm we
  // call reminder_instance_resolve_for_parent for each so the
  // dispatcher stops re-firing.
  const [pendingReminders, setPendingReminders] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyChildId, setBusyChildId] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      const { data: { user: u } } = await supabase.auth.getUser()
      if (cancelled) return
      if (!u) {
        navigate('/login', { replace: true })
        return
      }
      setUser(u)

      try {
        // Parent's active family links.
        const linksResp = await supabase
          .from('parent_family_links')
          .select('family_id')
          .eq('parent_id', u.id)
          .eq('status', 'active')
        if (linksResp.error) throw linksResp.error
        const familyIds = (linksResp.data || []).map(r => r.family_id)
        if (familyIds.length === 0) {
          if (!cancelled) { setChildren([]); setLoading(false) }
          return
        }

        // Children in those families. PR #13 active filter.
        //
        // PR #16 follow-up (parent-confirm bug, 2026-05-29): include
        // `user_id` — the canonical provider id for the child. The
        // earlier confirm path resolved provider_id only from the first
        // existing acknowledgment row, which is empty when the provider
        // used the "Send to parent's portal" channel (that channel
        // inserts a reminder_instances row but never pre-writes acks).
        // children.user_id is on the same row as the columns we already
        // SELECT here, so RLS allows the read whenever the row itself is
        // readable (i.e., whenever the child appears in the page at all).
        const kidsResp = await supabase
          .from('children')
          .select('id, first_name, last_name, family_id, date_of_birth, user_id')
          .in('family_id', familyIds)
          .is('archived_at', null)
        if (kidsResp.error) throw kidsResp.error
        const kids = Array.isArray(kidsResp.data) ? kidsResp.data : []
        if (kids.length === 0) {
          if (!cancelled) { setChildren([]); setLoading(false) }
          return
        }

        // Active acknowledgments for those children. Phase X (Bug 2
        // fix): restrict to ack-types that compose the R 400.1907
        // intake bundle so per-occurrence consent rows (which share
        // subject_type='child') can't leak into the parent confirm
        // bundle. The engine's intake-bundle set is the source of
        // truth — see `parentComplianceProjections.js`.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('id, provider_id, type, subject_id, snapshot_hash, snapshot_version, acknowledged_via, acknowledged_at, archived_at')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .in('type', INTAKE_BUNDLE_ACK_TYPES)
          .is('archived_at', null)
        if (ackResp.error) throw ackResp.error
        // Defense-in-depth: client-side filter too, in case a future
        // ack-type accidentally lands in the result.
        const acks = (Array.isArray(ackResp.data) ? ackResp.data : [])
          .filter(a => isIntakeBundleAckType(a.type))

        // PR #16 third pass: fetch the parent's pending intake-ack
        // reminders via the SECURITY DEFINER RPC
        // `reminder_instance_list_for_parent` (wrapped in
        // src/lib/parentIntakeReminders.js). The direct SELECT path
        // was dead under RLS — parents have no SELECT policy on
        // `reminder_instances`, so `pendingByChild` was always empty
        // and the confirm-time resolve loop never ran. The RPC is
        // scoped server-side to the same guard as
        // `reminder_instance_resolve_for_parent`. A failed list is
        // non-fatal — acks still land; the dispatcher is fire-once
        // (api/cron-dispatch-reminders.js:252) so the worst case is
        // stale-row hygiene, not re-fire.
        const { pendingByChild, error: listErr } = await listPendingForParent(supabase)
        if (listErr) {
          console.warn('listPendingForParent failed', listErr)
        }
        const reminderById = pendingByChild

        const byChild = {}
        for (const a of acks) {
          (byChild[a.subject_id] = byChild[a.subject_id] || []).push(a)
        }

        if (!cancelled) {
          setChildren(kids)
          setAcksByChild(byChild)
          setPendingReminders(reminderById)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err)
          setLoading(false)
        }
      }
    }
    run()
    return () => { cancelled = true }
  }, [navigate])

  async function confirmChild(child) {
    if (!user) return
    setBusyChildId(child.id)
    setError(null)
    try {
      const existing = acksByChild[child.id] || []
      const subRows = existing.filter(a => a.type !== ACK_TYPES.CHILD_IN_CARE_STATEMENT)

      // PR #16 follow-up (parent-confirm bug, 2026-05-29). Build the
      // bundle the parent is confirming. The RPC overrides every
      // security-critical field server-side — provider_id (from
      // children.user_id), acknowledged_via='parent_portal',
      // acknowledged_by_user_id=auth.uid(), acknowledged_at=now(),
      // subject_type/subject_id — so the parent's JS contributes
      // ONLY the bundle shape (`type`, `snapshot_hash`,
      // `snapshot_version` per row). Anything else included here is
      // ignored by the RPC.
      const parentTimestamp = new Date().toISOString()
      const subPayloads = subRows.map(r => ({ type: r.type, parentConfirmedAt: parentTimestamp }))
      const subHashes = subPayloads.map(p => computeAckHash({ type: p.type, payload: p }))
      const envelopeHash = computeEnvelopeHash(subHashes)

      const rowsForRpc = [
        {
          type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
          snapshot_hash: envelopeHash,
          snapshot_version: null,
        },
        ...subRows.map((r, i) => ({
          type: r.type,
          snapshot_hash: subHashes[i],
          snapshot_version: r.snapshot_version || null,
        })),
      ]

      // ── The single atomic call ─────────────────────────────────
      //
      // intake_confirm_for_parent (migration 025) is a SECURITY
      // DEFINER RPC that does archive + insert + resolve in one
      // transaction. The pre-fix JS issued the archive UPDATE and the
      // parent_portal INSERT as two separate HTTP requests. The
      // archive ran under the parent's session and was silently
      // filtered to zero rows by RLS — the only UPDATE policy on
      // acknowledgments is provider-scoped (`provider_id =
      // auth.uid()`), and the parent isn't the provider. The INSERT
      // then collided with the still-active provider_override rows on
      // the `acknowledgments_active_unique` partial index. See
      // migration 025's header for the root-cause writeup.
      //
      // The RPC also resolves any pending
      // intake_acknowledgment_pending reminder for this child inline,
      // so we no longer need the separate resolvePendingForChild call
      // that confirmChild used to make.
      const { error: rpcErr } = await supabase.rpc(
        'intake_confirm_for_parent',
        { p_child_id: child.id, p_rows: rowsForRpc },
      )
      if (rpcErr) throw rpcErr

      // Optimistic: clear this child's acks + pending reminders so the
      // card disappears.
      setAcksByChild(prev => {
        const next = { ...prev }
        delete next[child.id]
        return next
      })
      setPendingReminders(prev => {
        const next = { ...prev }
        delete next[child.id]
        return next
      })
    } catch (err) {
      setError(err)
    } finally {
      setBusyChildId(null)
    }
  }

  // Pending cards: any child the provider has either already started
  // (existing acks) OR explicitly requested portal review for (pending
  // reminder). Must run on every render to satisfy Rules of Hooks; the
  // `if (loading)` early-return below MUST stay below this hook. A
  // previous pass placed this useMemo below the early-return, which
  // produced a different hook count between the first render
  // (loading=true → early-return, useMemo never reached) and the
  // post-fetch render (loading=false → useMemo ran), tripping React
  // error #310 "Rendered more hooks than during the previous render"
  // in production. Any future early-return must remain below all hook
  // calls in this component.
  const pending = useMemo(() => {
    const list = children.filter(c =>
      (acksByChild[c.id] || []).length > 0 ||
      (pendingReminders[c.id] || []).length > 0
    )
    if (!focusChildId) return list
    // Pre-focus: sort the focus child first.
    return list.slice().sort((a, b) =>
      a.id === focusChildId ? -1 : b.id === focusChildId ? 1 : 0
    )
  }, [children, acksByChild, pendingReminders, focusChildId])

  if (loading) {
    return (
      <div className="parent-portal" style={{ padding: 24, textAlign: 'center' }}>
        Loading your child files…
      </div>
    )
  }

  return (
    <div className="parent-portal" style={{ padding: 16, maxWidth: 720, margin: '0 auto' }}>
      <Link to="/parent" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--clr-ink-mid)', textDecoration: 'none', fontSize: '0.875rem' }}>
        <ArrowLeft size={14} /> Back to dashboard
      </Link>

      <h1 style={{ fontSize: '1.5rem', margin: '12px 0 8px 0' }}>Confirm intake acknowledgments</h1>
      <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.5 }}>
        Your child's provider has captured Michigan-required intake disclosures
        on your behalf. Review and confirm each child's acknowledgments below.
      </p>

      {error && (
        <div role="alert" style={{ background: 'var(--clr-danger-pale)', color: 'var(--clr-danger)', padding: 12, borderRadius: 8, margin: '12px 0' }}>
          <AlertCircle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {error.message || String(error)}
        </div>
      )}

      {pending.length === 0 ? (
        <div style={{ background: 'var(--clr-cream)', padding: 24, borderRadius: 12, textAlign: 'center', marginTop: 16 }}>
          <CheckCircle2 size={28} style={{ color: 'var(--clr-sage-dark)' }} />
          <p style={{ margin: '8px 0 0 0' }}>Nothing to confirm right now.</p>
        </div>
      ) : (
        pending.map(child => {
          const acks = acksByChild[child.id] || []
          const subTypeAcks = acks.filter(a => a.type !== ACK_TYPES.CHILD_IN_CARE_STATEMENT)
          // Portal-trigger normal state: the provider sent a request but
          // has not pre-written sub-row acknowledgments. The card shows
          // a different copy block in that case so the parent isn't
          // staring at an empty bullet list — flagging this is the
          // copy-only half of the fix; the deeper sub-row population
          // question is in the halt review.
          const portalTriggeredWithoutAcks = subTypeAcks.length === 0
          return (
            <section
              key={child.id}
              style={{
                background: 'white',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 12,
                padding: 16,
                marginTop: 16,
              }}
            >
              <h2 style={{ fontSize: '1.125rem', margin: '0 0 8px 0' }}>
                {child.first_name} {child.last_name}
              </h2>
              {portalTriggeredWithoutAcks ? (
                <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', margin: '0 0 12px 0' }}>
                  Your provider asked you to confirm the intake acknowledgment
                  on file for {child.first_name || 'your child'}. Tap below to
                  record your confirmation.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', margin: '0 0 12px 0' }}>
                    Your provider recorded the following on file. Confirming below stamps your acknowledgment.
                  </p>
                  <ul style={{ listStyle: 'disc', paddingLeft: 20, margin: '0 0 12px 0', fontSize: '0.875rem' }}>
                    {subTypeAcks.map(a => (
                      // Phase X (Bug 1 fix): friendly label sourced
                      // from the engine's REQUIREMENT_REGISTRY via
                      // `labelForAckType`. The raw `a.type` fallback
                      // is replaced with a placeholder — raw type
                      // strings should never reach the parent.
                      <li key={a.id}>{labelForAckType(a.type) || 'Acknowledgment on file'}</li>
                    ))}
                  </ul>
                </>
              )}
              <button
                onClick={() => confirmChild(child)}
                disabled={busyChildId === child.id}
                style={{
                  background: 'var(--clr-sage-dark)',
                  color: 'white',
                  border: 'none',
                  padding: '10px 16px',
                  borderRadius: 8,
                  fontSize: '0.9375rem',
                  cursor: 'pointer',
                }}
              >
                {busyChildId === child.id ? 'Saving…' : 'I confirm these acknowledgments'}
              </button>
            </section>
          )
        })
      )}
    </div>
  )
}
