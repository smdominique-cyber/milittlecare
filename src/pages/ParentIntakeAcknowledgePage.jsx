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

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CheckCircle2, ArrowLeft, AlertCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  ACK_TYPES,
  computeAckHash,
  computeEnvelopeHash,
} from '@/lib/acknowledgments'
import '@/styles/parent.css'

const SUB_TYPE_LABEL = Object.freeze({
  [ACK_TYPES.CHILD_IN_CARE_STATEMENT]:    'Child-in-care statement (envelope)',
  [ACK_TYPES.LEAD_DISCLOSURE]:            'Lead-based paint disclosure',
  [ACK_TYPES.FIREARMS_DISCLOSURE]:        'Firearms on premises disclosure',
  [ACK_TYPES.FOOD_PROVIDER_AGREEMENT]:    'Who provides food',
  [ACK_TYPES.LICENSING_NOTEBOOK_OFFERED]: 'Licensing notebook offered',
  [ACK_TYPES.INFANT_SAFE_SLEEP]:          'Infant safe sleep practices',
  [ACK_TYPES.HEALTH_CONDITION]:           'Child health acknowledgment',
  [ACK_TYPES.DISCIPLINE_POLICY_RECEIPT]:  'Discipline policy received',
})

export default function ParentIntakeAcknowledgePage() {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [children, setChildren] = useState([])
  const [acksByChild, setAcksByChild] = useState({})
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
        const kidsResp = await supabase
          .from('children')
          .select('id, first_name, last_name, family_id, date_of_birth')
          .in('family_id', familyIds)
          .is('archived_at', null)
        if (kidsResp.error) throw kidsResp.error
        const kids = Array.isArray(kidsResp.data) ? kidsResp.data : []
        if (kids.length === 0) {
          if (!cancelled) { setChildren([]); setLoading(false) }
          return
        }

        // Active acknowledgments for those children.
        const ackResp = await supabase
          .from('acknowledgments')
          .select('id, provider_id, type, subject_id, snapshot_hash, snapshot_version, acknowledged_via, acknowledged_at, archived_at')
          .eq('subject_type', 'child')
          .in('subject_id', kids.map(k => k.id))
          .is('archived_at', null)
        if (ackResp.error) throw ackResp.error
        const acks = Array.isArray(ackResp.data) ? ackResp.data : []

        const byChild = {}
        for (const a of acks) {
          (byChild[a.subject_id] = byChild[a.subject_id] || []).push(a)
        }

        if (!cancelled) {
          setChildren(kids)
          setAcksByChild(byChild)
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
      const providerId = existing[0] ? existing[0].provider_id : null
      if (!providerId) throw new Error('No provider on file for this child.')

      // Archive every existing active row for the child.
      const archiveIds = existing.map(a => a.id)
      if (archiveIds.length > 0) {
        const { error: archiveErr } = await supabase
          .from('acknowledgments')
          .update({ archived_at: new Date().toISOString() })
          .in('id', archiveIds)
        if (archiveErr) throw archiveErr
      }

      // Write parent_portal rows for the same sub-types. We do not have
      // the provider's premises payload from the parent side, so each
      // sub-row's snapshot_hash is computed from { type, parentConfirmedAt }
      // — a minimal but deterministic representation. The envelope hash
      // is the composition of the sub-row hashes.
      const parentTimestamp = new Date().toISOString()
      const subPayloads = subRows.map(r => ({ type: r.type, parentConfirmedAt: parentTimestamp }))
      const subHashes = subPayloads.map(p => computeAckHash({ type: p.type, payload: p }))
      const envelopeHash = computeEnvelopeHash(subHashes)

      const sharedFields = {
        provider_id: providerId,
        subject_type: 'child',
        subject_id: child.id,
        acknowledged_via: 'parent_portal',
        acknowledged_by_user_id: user.id,
        provider_override_reason: null,
      }

      const newRows = [
        {
          ...sharedFields,
          type: ACK_TYPES.CHILD_IN_CARE_STATEMENT,
          snapshot_hash: envelopeHash,
          snapshot_version: null,
        },
        ...subRows.map((r, i) => ({
          ...sharedFields,
          type: r.type,
          snapshot_hash: subHashes[i],
          snapshot_version: r.snapshot_version || null,
        })),
      ]

      const { error: insertErr } = await supabase
        .from('acknowledgments')
        .insert(newRows)
      if (insertErr) throw insertErr

      // Optimistic: clear this child's acks so the card disappears.
      setAcksByChild(prev => {
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

  if (loading) {
    return (
      <div className="parent-portal" style={{ padding: 24, textAlign: 'center' }}>
        Loading your child files…
      </div>
    )
  }

  const pending = children.filter(c => (acksByChild[c.id] || []).length > 0)

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
              <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', margin: '0 0 12px 0' }}>
                Your provider recorded the following on file. Confirming below stamps your acknowledgment.
              </p>
              <ul style={{ listStyle: 'disc', paddingLeft: 20, margin: '0 0 12px 0', fontSize: '0.875rem' }}>
                {acks
                  .filter(a => a.type !== ACK_TYPES.CHILD_IN_CARE_STATEMENT)
                  .map(a => (
                    <li key={a.id}>{SUB_TYPE_LABEL[a.type] || a.type}</li>
                  ))}
              </ul>
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
