// Assign a caregiver's regulatory roles (docs/staff_training_tracking_spec.md
// § 6.1). Modal; licensee-only. Writes public.caregiver_regulatory_roles
// (migration 012) — a person may hold several roles, and obligations roll
// up strictest-wins (§ 6.3).
//
// TODO(testing): render tests pending React Testing Library install.

import { useEffect, useMemo, useState } from 'react'
import { Info, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { REGULATORY_ROLE, REGULATORY_ROLE_META } from '@/lib/staffTraining'

const ROLE_ORDER = [
  REGULATORY_ROLE.LICENSEE,
  REGULATORY_ROLE.CHILD_CARE_STAFF_MEMBER,
  REGULATORY_ROLE.CHILD_CARE_ASSISTANT,
  REGULATORY_ROLE.UNSUPERVISED_VOLUNTEER,
  REGULATORY_ROLE.SUPERVISED_VOLUNTEER,
  REGULATORY_ROLE.DRIVER,
]

const ROLE_HELP = {
  [REGULATORY_ROLE.LICENSEE]: 'The license holder. Carries every personnel obligation (R 400.1901(1)(ff)).',
  [REGULATORY_ROLE.CHILD_CARE_STAFF_MEMBER]: 'A paid caregiver aged 16 or older (R 400.1920(1)).',
  [REGULATORY_ROLE.CHILD_CARE_ASSISTANT]: 'A caregiver aged 14–15, supervised at all times (R 400.1921).',
  [REGULATORY_ROLE.UNSUPERVISED_VOLUNTEER]: 'A volunteer who may be alone with children — counts as "staff" (R 400.1901(1)(pp)).',
  [REGULATORY_ROLE.SUPERVISED_VOLUNTEER]: 'A volunteer supervised at all times — not "staff"; only the registry clearance applies (R 400.1903(1)(r)).',
  [REGULATORY_ROLE.DRIVER]: 'Transports children. Obligations depend on whether the driver is ratio-counted or has unsupervised access (R 400.1951).',
}

const SAVE_ERROR =
  'Couldn’t save the role assignment. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

export default function RegulatoryRoleAssignment({ caregiver, onClose, onSaved }) {
  const existing = useMemo(
    () => caregiver?.regulatory_roles || [],
    [caregiver]
  )
  const driverRow = existing.find(r => r.regulatory_role === REGULATORY_ROLE.DRIVER)

  const [selected, setSelected] = useState(() => {
    const set = {}
    for (const r of existing) set[r.regulatory_role] = true
    return set
  })
  const [ratioCounted, setRatioCounted] = useState(driverRow?.driver_ratio_counted ?? false)
  const [unsupAccess, setUnsupAccess] = useState(driverRow?.driver_has_unsupervised_access ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = role => setSelected(s => ({ ...s, [role]: !s[role] }))

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      // Tiny per-caregiver set — replace wholesale: clear then insert.
      const { error: delErr } = await supabase
        .from('caregiver_regulatory_roles')
        .delete()
        .eq('caregiver_id', caregiver.id)
      if (delErr) throw delErr

      const rows = ROLE_ORDER.filter(r => selected[r]).map(role => {
        // The migration-012 CHECK requires the driver attributes to be
        // non-null for a driver row and null for every other role.
        if (role === REGULATORY_ROLE.DRIVER) {
          return {
            caregiver_id: caregiver.id,
            regulatory_role: role,
            driver_ratio_counted: ratioCounted,
            driver_has_unsupervised_access: unsupAccess,
          }
        }
        return { caregiver_id: caregiver.id, regulatory_role: role }
      })

      if (rows.length > 0) {
        const { error: insErr } = await supabase
          .from('caregiver_regulatory_roles')
          .insert(rows)
        if (insErr) throw insErr
      }
      onSaved?.()
      onClose?.()
    } catch (err) {
      console.error('RegulatoryRoleAssignment: save failed', err)
      setError(SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={() => onClose?.()}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, width: '95%' }}>
        <div className="modal-header">
          <span className="modal-title">Regulatory roles — {caregiver?.full_name}</span>
          <button className="modal-close" onClick={() => onClose?.()} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--clr-ink-soft)', lineHeight: 1.5 }}>
            Pick every regulatory role this person holds. Training
            requirements roll up across all of their roles, at the
            strictest threshold (spec § 6.3).
          </p>

          {ROLE_ORDER.map(role => {
            const isOn = !!selected[role]
            return (
              <div key={role}>
                <label className={`st-role-option${isOn ? ' selected' : ''}`}>
                  <input type="checkbox" checked={isOn} onChange={() => toggle(role)}
                    style={{ marginTop: 3, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 500, color: 'var(--clr-ink)' }}>
                      {REGULATORY_ROLE_META[role].label}
                    </span>
                    <span style={{ display: 'block', marginTop: 2, fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', lineHeight: 1.45 }}>
                      {ROLE_HELP[role]}
                    </span>
                  </span>
                </label>

                {role === REGULATORY_ROLE.DRIVER && isOn && (
                  <div className="st-role-driver-attrs">
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={ratioCounted}
                        onChange={e => setRatioCounted(e.target.checked)} />
                      <span>Counted in child-to-staff ratios</span>
                      <HelpTooltip
                        text="A ratio-counted driver also takes on new-hire training and professional development (R 400.1951(10))."
                        label="Help: ratio-counted">
                        <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
                      </HelpTooltip>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input type="checkbox" checked={unsupAccess}
                        onChange={e => setUnsupAccess(e.target.checked)} />
                      <span>Has unsupervised access to children</span>
                      <HelpTooltip
                        text="A driver with unsupervised access OR who is ratio-counted needs a background-check eligibility determination (R 400.1951(4))."
                        label="Help: unsupervised access">
                        <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
                      </HelpTooltip>
                    </label>
                  </div>
                )}
              </div>
            )
          })}

          {error && <div role="alert" style={{ color: 'var(--clr-danger, #b00020)', fontSize: '0.875rem' }}>{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn-discard" onClick={() => onClose?.()} disabled={saving}>Cancel</button>
          <button className="btn-save" onClick={handleSave} disabled={saving}
            style={{ flex: 'initial', padding: '0.625rem var(--space-5)' }}>
            {saving ? 'Saving…' : 'Save roles'}
          </button>
        </div>
      </div>
    </div>
  )
}
