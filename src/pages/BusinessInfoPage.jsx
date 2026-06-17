import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/lib/supabase'
import { notifyStateChange } from '@/lib/notifications'
import {
  Clock, Calendar, DollarSign, Phone, AlertTriangle,
  Plus, X, Save, Trash2, ChevronDown, ChevronRight, Check,
  MessageCircle, Info, ScrollText, Shield, ClipboardCheck,
  Home,
} from 'lucide-react'
import ApplicabilityQuestionsSection from '@/components/compliance/ApplicabilityQuestionsSection'
import ComplianceDocumentSlot from '@/components/documents/ComplianceDocumentSlot'
import '@/styles/business-info.css'

// Valid ?section= deep-link targets — must stay in sync with the
// `sections` tab array inside BusinessInfoPage. An unknown or absent
// ?section= falls back to the default tab ('hours'), never errors.
// Mirrors FamiliesPage's KNOWN_TABS validation (Finding #5 precedent).
const KNOWN_SECTIONS = Object.freeze(new Set([
  // 2026-06-15 — provider-facing edit surface for profiles.daycare_name.
  // Closes the "no writable input anywhere" gap surfaced after the
  // parent-portal-branding PR (the column is read by 12+ surfaces —
  // parent-portal header, invitation emails, tax/billing exports — and
  // had no UI writer prior to this).
  'business_name',
  'hours',
  'closures',
  'policies',
  'emergency',
  'messaging',
  'licensing',
  'premises',
  'compliance_applicability',
  // 2026-06-14 batch — property document slots (radon, heating,
  // licensing-notebook), backed by migration 039 +
  // ComplianceDocumentSlot.
  'property',
]))

const DAYS = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
]

// ─── Floating holiday calculation ──────────────────────────
function nthWeekdayOfMonth(year, month, weekday, n) {
  const firstOfMonth = new Date(year, month - 1, 1)
  const firstWeekday = firstOfMonth.getDay()
  const offset = (weekday - firstWeekday + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return new Date(year, month - 1, day)
}

function lastWeekdayOfMonth(year, month, weekday) {
  const lastOfMonth = new Date(year, month, 0)
  const lastWeekday = lastOfMonth.getDay()
  const offset = (lastWeekday - weekday + 7) % 7
  return new Date(year, month - 1, lastOfMonth.getDate() - offset)
}

function getHolidayDate(holiday, year) {
  if (holiday.type === 'fixed') return new Date(year, holiday.month - 1, holiday.day)
  if (holiday.type === 'nth-weekday') return nthWeekdayOfMonth(year, holiday.month, holiday.weekday, holiday.n)
  if (holiday.type === 'last-weekday') return lastWeekdayOfMonth(year, holiday.month, holiday.weekday)
  return null
}

function getNextHolidayDate(holiday) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const thisYear = today.getFullYear()
  const thisYearDate = getHolidayDate(holiday, thisYear)
  if (thisYearDate >= today) return thisYearDate
  return getHolidayDate(holiday, thisYear + 1)
}

function dateToYMD(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const COMMON_HOLIDAYS = [
  { name: "New Year's Day",   type: 'fixed',         month: 1,  day: 1 },
  { name: 'Memorial Day',     type: 'last-weekday',  month: 5,  weekday: 1 },
  { name: 'Independence Day', type: 'fixed',         month: 7,  day: 4 },
  { name: 'Labor Day',        type: 'nth-weekday',   month: 9,  weekday: 1, n: 1 },
  { name: 'Thanksgiving',     type: 'nth-weekday',   month: 11, weekday: 4, n: 4 },
  { name: 'Christmas Eve',    type: 'fixed',         month: 12, day: 24 },
  { name: 'Christmas Day',    type: 'fixed',         month: 12, day: 25 },
  { name: "New Year's Eve",   type: 'fixed',         month: 12, day: 31 },
]

// ─── Payment method definitions ─────────────────────────────
const PAYMENT_METHODS_CONFIG = [
  {
    key: 'stripe',
    label: 'Stripe (online card)',
    emoji: '💳',
    tracked: true,
    needsDetails: false,
    helpText: 'Parents pay invoices through this app. Charges are automatic for autopay families. Counts toward FSA tax statements automatically.',
  },
  {
    key: 'venmo',
    label: 'Venmo',
    emoji: '💚',
    tracked: false,
    needsDetails: true,
    placeholder: '@your-venmo-handle',
    helpText: 'Parents see your Venmo handle and pay you outside this app.',
  },
  {
    key: 'zelle',
    label: 'Zelle',
    emoji: '🏦',
    tracked: false,
    needsDetails: true,
    placeholder: 'Email or phone number',
    helpText: 'Parents see your Zelle contact and send through their bank.',
  },
  {
    key: 'cash',
    label: 'Cash',
    emoji: '💵',
    tracked: false,
    needsDetails: true,
    placeholder: 'e.g., Drop off at pickup',
    helpText: 'Parents see your instructions for cash payments.',
  },
  {
    key: 'check',
    label: 'Check',
    emoji: '✉️',
    tracked: false,
    needsDetails: true,
    placeholder: 'e.g., Make out to "Your Name", give at pickup',
    helpText: 'Parents see who to make the check out to and how to deliver it.',
  },
]

function formatDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

function shortDate(d) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function BusinessInfoPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [activeSection, setActiveSection] = useState(() => {
    const requested = searchParams.get('section')
    return KNOWN_SECTIONS.has(requested) ? requested : 'hours'
  })
  const [hours, setHours] = useState({})
  const [closures, setClosures] = useState([])
  const [policies, setPolicies] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  // profiles row — the Licensing tab is the first surface on this page to
  // read/write profiles. It is the intended home for future
  // provider-identity / compliance fields (miregistry_id,
  // michigan_license_number, michigan_provider_id) when those need edit
  // surfaces — see docs/license_status_prompt_spec.md § 9 decision 1.
  const [profile, setProfile] = useState(null)
  // 2026-06-15 — controlled draft for the Business name input
  // (profiles.daycare_name). Seeded from `profile.daycare_name` inside
  // loadAll; empty string → write NULL on save (see saveBusinessName).
  const [businessNameDraft, setBusinessNameDraft] = useState('')

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    if (!user) return
    setLoading(true)
    const [hoursResp, closuresResp, policyResp, profileResp] = await Promise.all([
      supabase.from('business_hours').select('*').eq('user_id', user.id),
      supabase.from('closures').select('*').eq('user_id', user.id).order('start_date'),
      supabase.from('business_policies').select('*').eq('user_id', user.id).maybeSingle(),
      // PR #14: license_type is the compliance source of truth (migration 022);
      // is_license_exempt is the mirrored legacy column.
      // 2026-06-15: daycare_name added to the projection so the Business
      // name input (new section, this PR) renders the current value.
      supabase.from('profiles')
        .select('license_type, license_type_review_needed, is_license_exempt, home_built_before_1978, firearms_on_premises, daycare_name')
        .eq('id', user.id).maybeSingle(),
    ])

    const hoursMap = {}
    DAYS.forEach(d => {
      const existing = (hoursResp.data || []).find(h => h.day_of_week === d.value)
      hoursMap[d.value] = existing || {
        day_of_week: d.value,
        is_open: d.value >= 1 && d.value <= 5,
        open_time: '07:00',
        close_time: '18:00',
        notes: '',
      }
    })
    setHours(hoursMap)
    setClosures(closuresResp.data || [])
    setPolicies(policyResp.data || { user_id: user.id, payment_methods: {} })
    setProfile(profileResp.data || null)
    // 2026-06-15 — seed the Business name draft from the loaded value.
    // After a successful save the page calls loadAll() again, so this
    // line is both the initial hydration AND the post-save re-hydration.
    setBusinessNameDraft(profileResp.data?.daycare_name ?? '')
    setLoading(false)
  }

  const updateHour = (day, field, value) => {
    setHours(h => ({ ...h, [day]: { ...h[day], [field]: value } }))
  }

  const saveHours = async () => {
    setSaving(true)
    setMessage(null)
    try {
      for (const day of DAYS) {
        const h = hours[day.value]
        await supabase.from('business_hours').upsert({
          user_id: user.id,
          day_of_week: day.value,
          is_open: h.is_open,
          open_time: h.is_open ? h.open_time : null,
          close_time: h.is_open ? h.close_time : null,
          notes: h.notes || null,
        }, { onConflict: 'user_id,day_of_week' })
      }
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        hours_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Business hours saved' })

      const { data: families } = await supabase.from('families').select('id, family_name').eq('user_id', user.id)
      const provider = user.user_metadata?.full_name || user.email
      const summary = DAYS
        .map(d => {
          const h = hours[d.value]
          return h.is_open ? `${d.short}: ${h.open_time}-${h.close_time}` : `${d.short}: Closed`
        })
        .join(' · ')
      for (const f of families || []) {
        notifyStateChange('hours_changed', f.id, { providerName: provider, summary })
      }

      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const addClosure = async (closure) => {
    setSaving(true)
    setMessage(null)
    try {
      await supabase.from('closures').insert({
        user_id: user.id,
        ...closure,
        created_by_user_id: user.id,
      })
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        closures_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Closure added' })

      if (closure.notify_parents !== false) {
        const { data: families } = await supabase.from('families').select('id').eq('user_id', user.id)
        const provider = user.user_metadata?.full_name || user.email
        const formatD = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        const dateRange = closure.start_date === closure.end_date
          ? formatD(closure.start_date)
          : `${formatD(closure.start_date)} – ${formatD(closure.end_date)}`
        for (const f of families || []) {
          notifyStateChange('closure_added', f.id, { providerName: provider, dateRange, reason: closure.reason || '' })
        }
      }

      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const deleteClosure = async (id) => {
    if (!window.confirm('Delete this closure?')) return
    await supabase.from('closures').delete().eq('id', id)
    await loadAll()
  }

  const updatePolicy = (field, value) => {
    setPolicies(p => ({ ...p, [field]: value }))
  }

  const updatePaymentMethod = (key, patch) => {
    setPolicies(p => ({
      ...p,
      payment_methods: {
        ...(p.payment_methods || {}),
        [key]: { ...((p.payment_methods || {})[key] || {}), ...patch },
      },
    }))
  }

  const savePolicies = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        policies_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Policies saved' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const saveEmergency = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        emergency_set: true,
      }, { onConflict: 'user_id' })
      setMessage({ type: 'success', text: '✓ Emergency info saved' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  const toggleMessaging = async (enabled) => {
    setSaving(true)
    setMessage(null)
    try {
      const { user_id, created_at, updated_at, ...rest } = policies
      await supabase.from('business_policies').upsert({
        user_id: user.id,
        ...rest,
        messaging_enabled: enabled,
      }, { onConflict: 'user_id' })
      setMessage({
        type: 'success',
        text: enabled
          ? '✓ Parent messaging enabled — refresh the page to see the Messages tab in your sidebar'
          : '✓ Parent messaging disabled',
      })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  // First profiles write on this page. Switching an already-set value
  // shows a window.confirm spelling out the consequences (PR #14 ternary).
  // PR #14: writes license_type (source of truth) + mirrors is_license_exempt
  // + clears review_needed.
  const saveLicenseStatus = async (licenseType) => {
    const previous = profile?.license_type
    const previousSet = previous === 'family_home' || previous === 'group_home' || previous === 'license_exempt'
    const isSwitch = previousSet && previous !== licenseType
    if (isSwitch) {
      // Two transitions need a heads-up: switching INTO license_exempt
      // turns on MiRegistry; switching OUT OF license_exempt hides it.
      // Family ↔ Group is a quiet rename.
      const becomingExempt = licenseType === 'license_exempt'
      const leavingExempt = previous === 'license_exempt' && licenseType !== 'license_exempt'
      let confirmMsg = null
      if (leavingExempt) confirmMsg = LICENSE_SWITCH_CONFIRM.exemptToLicensed
      else if (becomingExempt) confirmMsg = LICENSE_SWITCH_CONFIRM.licensedToExempt
      if (confirmMsg && !window.confirm(confirmMsg)) return
    }
    setSaving(true)
    setMessage(null)
    try {
      const isLicenseExempt = licenseType === 'license_exempt'
      const { error } = await supabase
        .from('profiles')
        .update({
          license_type: licenseType,
          is_license_exempt: isLicenseExempt,
          license_type_review_needed: false,
        })
        .eq('id', user.id)
      if (error) throw error
      setMessage({
        type: 'success',
        text: isLicenseExempt
          ? '✓ Saved. Refresh your browser to see the MiRegistry tracker in your sidebar.'
          : '✓ Saved.',
      })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  // 2026-06-15 — Business name writer. Matches the same shape as
  // saveLicenseStatus / savePremises (the canonical profile-write pattern
  // on this page): one .update().eq('id', user.id), .error checked
  // (Rule 2), wrapped in setSaving / try / catch / loadAll.
  //
  // Empty → NULL: an empty or whitespace-only input becomes NULL in the
  // database, not ''. Reason: the read-side fallback chain
  // (`daycare_name → full_name → 'Your provider'`) at
  // `resolveParentPortalProviderName` + every other read site depends on
  // the value being null/missing for the fallback to fire. Storing '' is
  // technically truthy-as-a-trimmed-string only if we DIDN'T trim — but
  // we do. Storing whitespace would be even worse: `'   ' || x === '   '`
  // would pin the header to whitespace. Trim then nullify-if-empty fixes
  // both.
  const saveBusinessName = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const trimmed = businessNameDraft.trim()
      const valueToWrite = trimmed.length === 0 ? null : trimmed
      const { error } = await supabase
        .from('profiles')
        .update({ daycare_name: valueToWrite })
        .eq('id', user.id)
      if (error) throw error
      setMessage({ type: 'success', text: '✓ Business name saved.' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  // PR #16: save the two property disclosures together. When either
  // toggles from false -> true, any existing child intakes that did not
  // include the corresponding sub-row drift to "intake incomplete" via
  // getChildFileCompleteness (no DB-side cascade needed).
  const savePremises = async ({ home_built_before_1978, firearms_on_premises }) => {
    setSaving(true)
    setMessage(null)
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ home_built_before_1978, firearms_on_premises })
        .eq('id', user.id)
      if (error) throw error
      setMessage({ type: 'success', text: '✓ Saved.' })
      await loadAll()
    } catch (err) {
      setMessage({ type: 'error', text: err.message })
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-12)', textAlign: 'center' }}>
        <div className="loading-spinner" style={{ margin: '0 auto' }} />
      </div>
    )
  }

  const sections = [
    // 2026-06-15 — Business name first. It's the identity field every
    // parent-facing surface reads (portal header, invitation email
    // greeting, tax / billing PDFs). Putting it at position 0 makes the
    // "Set this once" framing of the page header land first on the
    // single field every parent sees by name.
    {
      id: 'business_name',
      label: 'Business name',
      icon: Home,
      done: !!(profile?.daycare_name && profile.daycare_name.trim().length > 0),
    },
    { id: 'hours', label: 'Hours', icon: Clock, done: policies.hours_set },
    { id: 'closures', label: 'Holidays & Closures', icon: Calendar, done: policies.closures_set },
    { id: 'policies', label: 'Payment & Fees', icon: DollarSign, done: policies.policies_set },
    { id: 'emergency', label: 'Emergency Info', icon: AlertTriangle, done: policies.emergency_set },
    { id: 'messaging', label: 'Parent Messages', icon: MessageCircle, done: !!policies.messaging_enabled },
    {
      id: 'licensing',
      label: 'Licensing',
      icon: ScrollText,
      // "Done" once the provider has answered AND the backfill isn't
      // flagging the row for human review (PR #14).
      done:
        (profile?.license_type === 'family_home' ||
         profile?.license_type === 'group_home' ||
         profile?.license_type === 'license_exempt') &&
        profile?.license_type_review_needed !== true,
    },
    {
      // PR #16: Premises disclosures that gate the child-intake bundle
      // (lead-based-paint for pre-1978 homes, firearms on premises).
      id: 'premises',
      label: 'Premises',
      icon: Shield,
      done: profile?.home_built_before_1978 != null && profile?.firearms_on_premises != null,
    },
    // PR Phase 3 — Compliance Engine: applicability questions for the
    // 'auto: unknown' registry rows (routine transport, water on
    // premises, animals). Gated to licensed homes only — LEPs see no
    // compliance UI per modules.js + CLAUDE.md.
    ...(profile?.license_type === 'family_home' || profile?.license_type === 'group_home'
      ? [{
          id: 'compliance_applicability',
          label: 'What applies?',
          icon: ClipboardCheck,
          // "Done" semantics here are intentionally loose. The section
          // is informational — every question can legitimately be in
          // "Skip — ask me later" indefinitely; that's not a failure
          // state. So the section never shows the green check (no
          // false-completion signal). The Compliance checklist surfaces
          // any remaining unknown rows directly.
          done: false,
        }]
      : []),
    // 2026-06-14 batch — property record uploads (radon, heating,
    // licensing-notebook). Licensed homes only; LEPs see no
    // compliance UI per modules.js / CLAUDE.md. "Done" semantics
    // tracked at the row level by each ComplianceDocumentSlot
    // (the page-level chip stays neutral — the checklist is the
    // canonical signal).
    ...(profile?.license_type === 'family_home' || profile?.license_type === 'group_home'
      ? [{ id: 'property', label: 'Property', icon: ScrollText, done: false }]
      : []),
  ]

  const paymentMethods = policies.payment_methods || {}

  return (
    <>
      <div style={{
        marginBottom: 'var(--space-5)',
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-5)',
      }}>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.25rem',
          fontWeight: 400,
          color: 'var(--clr-ink)',
          letterSpacing: '-0.02em',
          marginBottom: 'var(--space-2)',
        }}>
          Set this once. Stop answering it forever.
        </h2>
        <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.9375rem', lineHeight: 1.5, margin: 0 }}>
          Information you enter here shows up automatically on every parent's portal. No more "what time do you open?" texts.
        </p>
      </div>

      <div className="bi-tabs">
        {sections.map(s => (
          <button
            key={s.id}
            className={`bi-tab ${activeSection === s.id ? 'active' : ''}`}
            onClick={() => setActiveSection(s.id)}
          >
            <s.icon size={15} />
            <span>{s.label}</span>
            {s.done && <span className="bi-check"><Check size={11} /></span>}
          </button>
        ))}
      </div>

      {message && (
        <div className={`bi-message ${message.type}`}>
          {message.text}
        </div>
      )}

      {activeSection === 'business_name' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Business name</h3>
            <p>
              This is the name parents see in their MILittleCare parent portal
              and on the invitation emails you send them. If left blank, parents
              see your full name instead.
            </p>
          </div>

          <div style={{ maxWidth: 480 }}>
            <label
              htmlFor="business-name-input"
              className="bi-label"
              style={{
                display: 'block',
                fontFamily: 'var(--font-display)',
                fontSize: '0.9375rem',
                color: 'var(--clr-ink)',
                marginBottom: 6,
              }}
            >
              Daycare / business name
            </label>
            <input
              id="business-name-input"
              type="text"
              className="bi-text-input"
              value={businessNameDraft}
              onChange={(e) => setBusinessNameDraft(e.target.value)}
              placeholder="e.g. Bright Beginnings Daycare"
              maxLength={120}
              aria-describedby="business-name-help"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                fontFamily: 'var(--font-body)',
                fontSize: '0.9375rem',
                color: 'var(--clr-ink)',
                background: 'white',
                boxSizing: 'border-box',
              }}
            />
            <p
              id="business-name-help"
              style={{
                marginTop: 6,
                fontSize: '0.8125rem',
                color: 'var(--clr-ink-soft)',
                lineHeight: 1.4,
              }}
            >
              Parents see this in the portal header and on the invitation email
              we send them. Leave blank to fall back to your full name.
            </p>
          </div>

          <button
            className="bi-save-btn"
            onClick={saveBusinessName}
            disabled={saving}
            style={{ marginTop: 16 }}
          >
            <Save size={14} /> {saving ? 'Saving…' : 'Save business name'}
          </button>
        </div>
      )}

      {activeSection === 'hours' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Operating Hours</h3>
            <p>Set your hours for each day. Days marked closed will show as closed on the parent portal.</p>
          </div>

          <div className="bi-hours-list">
            {DAYS.map(day => {
              const h = hours[day.value] || {}
              return (
                <div key={day.value} className={`bi-hour-row ${!h.is_open ? 'closed' : ''}`}>
                  <div className="bi-day-toggle">
                    <label className="bi-switch">
                      <input
                        type="checkbox"
                        checked={h.is_open}
                        onChange={(e) => updateHour(day.value, 'is_open', e.target.checked)}
                      />
                      <span className="bi-switch-slider"></span>
                    </label>
                    <span className="bi-day-label">{day.label}</span>
                  </div>
                  {h.is_open ? (
                    <div className="bi-time-row">
                      <input
                        type="time"
                        value={h.open_time || '07:00'}
                        onChange={(e) => updateHour(day.value, 'open_time', e.target.value)}
                        className="bi-time-input"
                      />
                      <span style={{ color: 'var(--clr-ink-soft)' }}>–</span>
                      <input
                        type="time"
                        value={h.close_time || '18:00'}
                        onChange={(e) => updateHour(day.value, 'close_time', e.target.value)}
                        className="bi-time-input"
                      />
                    </div>
                  ) : (
                    <span className="bi-closed-tag">Closed</span>
                  )}
                </div>
              )
            })}
          </div>

          <button className="bi-save-btn" onClick={saveHours} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save hours'}
          </button>
        </div>
      )}

      {activeSection === 'closures' && (
        <ClosuresSection
          closures={closures}
          onAdd={addClosure}
          onDelete={deleteClosure}
          saving={saving}
        />
      )}

      {activeSection === 'policies' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Payment Policies</h3>
            <p>Set how and when families pay. Parents will see this info in their portal.</p>
          </div>

          <div className="bi-form">
            <div className="bi-field">
              <label>Payment due day</label>
              <select
                value={policies.payment_due_day || 'monday'}
                onChange={(e) => updatePolicy('payment_due_day', e.target.value)}
                className="bi-input"
              >
                <option value="monday">Monday (recommended for autopay)</option>
                <option value="tuesday">Tuesday</option>
                <option value="wednesday">Wednesday</option>
                <option value="thursday">Thursday</option>
                <option value="friday">Friday</option>
                <option value="sunday">Sunday</option>
              </select>
            </div>

            <div className="bi-fieldset">
              <label style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 8 }}>
                Payment methods you accept
              </label>

              <div style={{
                background: 'var(--clr-cream)',
                border: '1px solid var(--clr-warm-mid)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3) var(--space-4)',
                marginBottom: 'var(--space-4)',
                fontSize: '0.8125rem',
                color: 'var(--clr-ink-mid)',
                lineHeight: 1.55,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <Info size={14} style={{ color: 'var(--clr-sage-dark)', marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <strong style={{ color: 'var(--clr-ink)' }}>About off-app payments (Venmo, Zelle, Cash, Check):</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem' }}>
                      <li>You'll need to <strong>manually mark invoices as paid</strong> when you receive these payments.</li>
                      <li>They <strong>won't appear on parents' year-end FSA statements automatically</strong> — only Stripe payments do.</li>
                      <li>Autopay only works with Stripe — parents will need to remember to send payment each week.</li>
                    </ul>
                    <p style={{ margin: '8px 0 0' }}>
                      Stripe handles all of this automatically and gives parents downloadable receipts for FSA, taxes, and reimbursement.
                    </p>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {PAYMENT_METHODS_CONFIG.map(method => {
                  const config = paymentMethods[method.key] || { enabled: false, details: '' }
                  const enabled = !!config.enabled
                  return (
                    <div
                      key={method.key}
                      style={{
                        border: enabled ? '1px solid var(--clr-sage)' : '1px solid var(--clr-warm-mid)',
                        background: enabled ? 'white' : 'var(--clr-cream)',
                        borderRadius: 'var(--radius-md)',
                        padding: 'var(--space-3) var(--space-4)',
                        transition: 'border-color 0.15s, background 0.15s',
                      }}
                    >
                      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => updatePaymentMethod(method.key, { enabled: e.target.checked })}
                        />
                        <span style={{ fontSize: '1.125rem' }}>{method.emoji}</span>
                        <span style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>{method.label}</span>
                        {method.tracked && (
                          <span style={{
                            fontSize: '0.6875rem',
                            background: 'var(--clr-sage-pale)',
                            color: 'var(--clr-sage-dark)',
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-full)',
                            fontWeight: 600,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                          }}>
                            Auto-tracked
                          </span>
                        )}
                      </label>

                      {enabled && method.needsDetails && (
                        <div style={{ marginTop: 10, marginLeft: 26 }}>
                          <input
                            type="text"
                            value={config.details || ''}
                            onChange={(e) => updatePaymentMethod(method.key, { details: e.target.value })}
                            placeholder={method.placeholder}
                            className="bi-input"
                            style={{ marginBottom: 4 }}
                          />
                          <p style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', margin: 0, lineHeight: 1.45 }}>
                            {method.helpText}
                          </p>
                        </div>
                      )}

                      {enabled && !method.needsDetails && (
                        <p style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', margin: '8px 0 0 26px', lineHeight: 1.45 }}>
                          {method.helpText}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="bi-fieldset">
              <label className="bi-toggle">
                <input
                  type="checkbox"
                  checked={!!policies.late_fee_enabled}
                  onChange={(e) => updatePolicy('late_fee_enabled', e.target.checked)}
                />
                <strong>Charge late fees on overdue invoices</strong>
              </label>
              {policies.late_fee_enabled && (
                <div className="bi-form-row">
                  <div className="bi-field">
                    <label>Fee amount</label>
                    <div className="bi-input-prefix">
                      <span>$</span>
                      <input
                        type="number"
                        step="0.01"
                        value={policies.late_fee_amount || ''}
                        onChange={(e) => updatePolicy('late_fee_amount', parseFloat(e.target.value) || null)}
                        className="bi-input"
                        placeholder="25.00"
                      />
                    </div>
                  </div>
                  <div className="bi-field">
                    <label>After how many days late?</label>
                    <input
                      type="number"
                      value={policies.late_fee_after_days || 7}
                      onChange={(e) => updatePolicy('late_fee_after_days', parseInt(e.target.value) || 7)}
                      className="bi-input"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="bi-fieldset">
              <label className="bi-toggle">
                <input
                  type="checkbox"
                  checked={!!policies.late_pickup_fee_enabled}
                  onChange={(e) => updatePolicy('late_pickup_fee_enabled', e.target.checked)}
                />
                <strong>Charge late pickup fees</strong>
              </label>
              {policies.late_pickup_fee_enabled && (
                <div className="bi-form-row">
                  <div className="bi-field">
                    <label>Fee per minute late</label>
                    <div className="bi-input-prefix">
                      <span>$</span>
                      <input
                        type="number"
                        step="0.25"
                        value={policies.late_pickup_fee_per_minute || ''}
                        onChange={(e) => updatePolicy('late_pickup_fee_per_minute', parseFloat(e.target.value) || null)}
                        className="bi-input"
                        placeholder="1.00"
                      />
                    </div>
                  </div>
                  <div className="bi-field">
                    <label>Grace period (minutes)</label>
                    <input
                      type="number"
                      value={policies.late_pickup_grace_minutes || 5}
                      onChange={(e) => updatePolicy('late_pickup_grace_minutes', parseInt(e.target.value) || 5)}
                      className="bi-input"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* ─── NEW: Invoice due date defaults ─── */}
            <div className="bi-fieldset">
              <label style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontWeight: 500, color: 'var(--clr-ink)', display: 'block', marginBottom: 8 }}>
                Invoice due date
              </label>
              <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-mid)', marginTop: 0, marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
                When should new invoices be due? This is used as the default when invoices are generated.
              </p>
              <div className="bi-form-row">
                <div className="bi-field">
                  <label>Days until due</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={policies.default_invoice_due_offset_days ?? 7}
                    onChange={(e) => updatePolicy('default_invoice_due_offset_days', parseInt(e.target.value) || 0)}
                    className="bi-input"
                  />
                </div>
                <div className="bi-field">
                  <label>Counted from</label>
                  <select
                    value={policies.default_invoice_due_anchor || 'generate_date'}
                    onChange={(e) => updatePolicy('default_invoice_due_anchor', e.target.value)}
                    className="bi-input"
                  >
                    <option value="generate_date">When I generate the invoice</option>
                    <option value="period_start">Start of the billing period</option>
                    <option value="period_end">End of the billing period</option>
                  </select>
                </div>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--clr-ink-soft)', margin: '8px 0 0', lineHeight: 1.5 }}>
                Examples: "7 days from when I generate" → bill on Monday, due next Monday. "0 days from period end" → due on the last day of the billing period.
              </p>
            </div>

            <div className="bi-field">
              <label>Drop-off notes (optional)</label>
              <textarea
                value={policies.drop_off_notes || ''}
                onChange={(e) => updatePolicy('drop_off_notes', e.target.value)}
                className="bi-textarea"
                placeholder="e.g., Please ring the doorbell. Children must be signed in by an authorized adult."
                rows={2}
              />
            </div>

            <div className="bi-field">
              <label>Pickup notes (optional)</label>
              <textarea
                value={policies.pickup_notes || ''}
                onChange={(e) => updatePolicy('pickup_notes', e.target.value)}
                className="bi-textarea"
                placeholder="e.g., Please notify me by 4 PM if someone other than the usual person will pick up."
                rows={2}
              />
            </div>
          </div>

          <button className="bi-save-btn" onClick={savePolicies} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save policies'}
          </button>
        </div>
      )}

      {activeSection === 'emergency' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Emergency Procedures</h3>
            <p>What should parents do or know in an emergency? This will appear prominently on their portal.</p>
          </div>

          <div className="bi-field">
            <label>Emergency procedures</label>
            <textarea
              value={policies.emergency_procedures || ''}
              onChange={(e) => updatePolicy('emergency_procedures', e.target.value)}
              className="bi-textarea"
              placeholder="e.g., In case of fire or other emergency, we evacuate to [location] and contact parents immediately. The home address is XXX. Our emergency contact is XXX. Local emergency: 911."
              rows={6}
            />
            <p className="bi-helper">
              Include: evacuation location, your address (for emergency services), your emergency contact, and any specific procedures for your home.
            </p>
          </div>

          <button className="bi-save-btn" onClick={saveEmergency} disabled={saving}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save emergency info'}
          </button>
        </div>
      )}

      {activeSection === 'messaging' && (
        <div className="bi-section">
          <div className="bi-section-header">
            <h3>Parent Messages</h3>
            <p>Two-way messaging with parents, including photo sharing. Optional and easy to turn off.</p>
          </div>

          <div className="bi-fieldset">
            <label className="bi-toggle">
              <input
                type="checkbox"
                checked={!!policies.messaging_enabled}
                onChange={(e) => toggleMessaging(e.target.checked)}
                disabled={saving}
              />
              <strong>Enable parent messaging</strong>
            </label>
            <p style={{ color: 'var(--clr-ink-mid)', fontSize: '0.875rem', lineHeight: 1.55, marginTop: 'var(--space-2)', marginBottom: 0 }}>
              When enabled, you'll see a <strong>Messages</strong> tab in your sidebar where you can post text and photos
              for each child. Parents can post and reply too. Some providers love this — others prefer keeping
              communication off-app. Turn it on or off anytime, and your existing messages are preserved either way.
            </p>
          </div>

          {policies.messaging_enabled && (
            <div style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-4)',
              background: 'var(--clr-cream)',
              border: '1px solid var(--clr-warm-mid)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.875rem',
              color: 'var(--clr-ink-mid)',
              lineHeight: 1.55,
            }}>
              <strong style={{ color: 'var(--clr-ink)' }}>A few things to know:</strong>
              <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.25rem' }}>
                <li>Each child gets their own thread, so updates stay organized.</li>
                <li>Photos are compressed automatically and stored privately — only you and the linked parents can see them.</li>
                <li>Parents are emailed when you post, with a 10-minute throttle so they don't get flooded.</li>
                <li>If you turn this off later, the Messages tab disappears but nothing is deleted.</li>
              </ul>
            </div>
          )}
        </div>
      )}

      {activeSection === 'licensing' && (
        <>
          <LicensingSection
            currentValue={profile?.license_type ?? null}
            reviewNeeded={profile?.license_type_review_needed === true}
            onSave={saveLicenseStatus}
            saving={saving}
          />
          {/*
            G4 fingerprint-reprint upload slot (2026-06-14). The
            audit's NO-WRITER classification (commit 345b284) flagged
            cdc_fingerprint_reprint_currency as a row where the
            engine guidance promised a field update no UI delivered;
            this slot replaces the promise with an actual upload
            surface. The slot covers the LICENSEE's own records —
            staff and household-member fingerprinting still live on
            paper (no per-person model yet, per the same audit). The
            checklist guidance updated alongside this commit points
            at /business-info?section=licensing.
          */}
          <div className="bi-section" style={{ marginTop: 'var(--space-4)' }}>
            <div className="bi-section-header">
              <h3>Fingerprint reprint records</h3>
              <p>
                The licensing rule is a 5-year cycle. Keep your most recent
                fingerprint reprint receipt or notice here so an auditor
                can see it without rummaging through paper. This slot
                covers YOU (the licensee); staff and household-member
                fingerprint records still stay on paper for now.
              </p>
            </div>
            <ComplianceDocumentSlot documentType="fingerprint_reprint" />
          </div>
        </>
      )}

      {activeSection === 'premises' && (
        <PremisesSection
          homeBuiltBefore1978={profile?.home_built_before_1978 ?? null}
          firearmsOnPremises={profile?.firearms_on_premises ?? null}
          onSave={savePremises}
          saving={saving}
        />
      )}

      {activeSection === 'compliance_applicability' && (
        <ApplicabilityQuestionsSection providerId={user?.id} />
      )}

      {activeSection === 'property' && (
        <PropertyRecordsSection />
      )}
    </>
  )
}

// PropertyRecordsSection — 2026-06-14 batch (radon, heating, notebook)
// plus 2026-06-17 PR #21 inventory batch (CO detectors, smoke detectors,
// fire extinguishers, animal notification, smoking prohibition). All
// rows use the same ComplianceDocumentSlot substrate — provider-level
// by construction (no parent FK on compliance_documents); the slot
// writes a row whose user_id is the licensee and whose document_type
// discriminates the upload. Gated to licensed homes by the same parent
// check that gates the compliance_applicability tab.
//
// Order on the page mirrors the auditor's natural walkthrough sequence:
// recurring inspections first, then life-safety devices floor-by-floor,
// then parent notifications, then the licensing notebook last. The
// What-applies questionnaire gates the animal notification's
// applicability — the slot still renders regardless so a provider who
// later answers "yes" doesn't have to navigate back here to find it.
function PropertyRecordsSection() {
  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>Property records</h3>
        <p>
          The records an auditor will ask to see during a walkthrough.
          For each row, upload a photo, attestation, or report into the
          slot; the Replace button rotates the upload after the next
          inspection, photo, or change, keeping the prior copy in
          archive for retention.
        </p>
      </div>
      <ComplianceDocumentSlot documentType="property_radon_test" />
      <ComplianceDocumentSlot documentType="property_heating_inspection" />
      <ComplianceDocumentSlot documentType="property_co_detectors_per_level" />
      <ComplianceDocumentSlot documentType="property_smoke_detectors_per_floor" />
      <ComplianceDocumentSlot documentType="property_fire_extinguishers_per_floor" />
      <ComplianceDocumentSlot documentType="property_animal_notification" />
      <ComplianceDocumentSlot documentType="property_smoking_prohibition_posted" />
      <ComplianceDocumentSlot documentType="property_licensing_notebook" />
    </div>
  )
}

// PR #16: Premises disclosures section. Two boolean prompts that gate
// the per-child intake bundle (lead-based-paint for pre-1978 homes;
// firearms-on-premises is always required at intake, copy varies on
// yes/no).
function PremisesSection({ homeBuiltBefore1978, firearmsOnPremises, onSave, saving }) {
  const [lead, setLead] = useState(homeBuiltBefore1978)
  const [firearms, setFirearms] = useState(firearmsOnPremises)

  const dirty = lead !== homeBuiltBefore1978 || firearms !== firearmsOnPremises
  const answered = lead != null && firearms != null

  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>Premises disclosures</h3>
        <p>
          These two facts decide which acknowledgments parents must sign
          at intake under Michigan Rule 7 (R 400.1907). Changing either
          one later will flag any existing intakes as incomplete until
          re-acknowledged.
        </p>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px 0' }}>
        <legend style={{ fontWeight: 500, marginBottom: 8 }}>
          Was your home built before 1978?
        </legend>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            name="lead"
            checked={lead === true}
            onChange={() => setLead(true)}
            disabled={saving}
          /> Yes
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            name="lead"
            checked={lead === false}
            onChange={() => setLead(false)}
            disabled={saving}
          /> No
        </label>
        <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', margin: '6px 0 0 0' }}>
          If yes, a lead-based-paint disclosure acknowledgment is required at every child intake.
        </p>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px 0' }}>
        <legend style={{ fontWeight: 500, marginBottom: 8 }}>
          Are firearms kept on the premises?
        </legend>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            name="firearms"
            checked={firearms === true}
            onChange={() => setFirearms(true)}
            disabled={saving}
          /> Yes
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            name="firearms"
            checked={firearms === false}
            onChange={() => setFirearms(false)}
            disabled={saving}
          /> No
        </label>
        <p style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', margin: '6px 0 0 0' }}>
          A firearms disclosure is required at intake regardless of yes/no. The disclosure copy adjusts to whichever you pick.
        </p>
      </fieldset>

      <button
        className="bi-save-btn"
        onClick={() => onSave({ home_built_before_1978: lead, firearms_on_premises: firearms })}
        disabled={!answered || !dirty || saving}
      >
        <Save size={14} /> {saving ? 'Saving...' : 'Save premises disclosures'}
      </button>
    </div>
  )
}

function ClosuresSection({ closures, onAdd, onDelete, saving }) {
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    closure_type: 'holiday',
    is_recurring: true,
    start_date: '',
    end_date: '',
    reason: '',
  })

  const submit = async () => {
    if (!form.start_date) return
    await onAdd({ ...form, end_date: form.end_date || form.start_date })
    setForm({ closure_type: 'holiday', is_recurring: true, start_date: '', end_date: '', reason: '' })
    setShowForm(false)
  }

  const addCommonHoliday = async (h) => {
    const nextDate = getNextHolidayDate(h)
    const dateStr = dateToYMD(nextDate)
    await onAdd({
      closure_type: 'holiday',
      is_recurring: true,
      start_date: dateStr,
      end_date: dateStr,
      reason: h.name,
      notify_parents: true,
    })
  }

  const today = new Date().toISOString().split('T')[0]
  const upcoming = closures.filter(c => c.end_date >= today && !c.is_recurring)
  const recurring = closures.filter(c => c.is_recurring)
  const past = closures.filter(c => c.end_date < today && !c.is_recurring)

  const isHolidayAdded = (holiday) => {
    return closures.some(c => c.is_recurring && c.reason === holiday.name)
  }

  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>Holidays & Closures</h3>
        <p>Recurring holidays auto-renew every year. One-off closures (vacation, sick days) are added as you need them.</p>
      </div>

      <div className="bi-quick-add">
        <div className="bi-quick-add-label">Common holidays — tap to add as recurring:</div>
        <div className="bi-quick-add-row">
          {COMMON_HOLIDAYS.map(h => {
            const exists = isHolidayAdded(h)
            const nextDate = getNextHolidayDate(h)
            const tooltip = `Next: ${nextDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
            return (
              <button
                key={h.name}
                className={`bi-quick-chip ${exists ? 'added' : ''}`}
                onClick={() => !exists && addCommonHoliday(h)}
                disabled={exists || saving}
                title={tooltip}
              >
                {exists && <Check size={11} />}
                {h.name}
              </button>
            )
          })}
        </div>
      </div>

      <button className="bi-add-btn" onClick={() => setShowForm(!showForm)}>
        <Plus size={14} /> Add custom closure
      </button>

      {showForm && (
        <div className="bi-form-card">
          <div className="bi-form-row">
            <div className="bi-field">
              <label>Type</label>
              <select
                value={form.closure_type}
                onChange={(e) => setForm(f => ({ ...f, closure_type: e.target.value, is_recurring: e.target.value === 'holiday' }))}
                className="bi-input"
              >
                <option value="holiday">Holiday (recurring annually)</option>
                <option value="vacation">Vacation</option>
                <option value="sick">Sick day</option>
                <option value="personal">Personal day</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="bi-field">
              <label>Reason / name</label>
              <input
                type="text"
                value={form.reason}
                onChange={(e) => setForm(f => ({ ...f, reason: e.target.value }))}
                className="bi-input"
                placeholder="e.g., Provider vacation"
              />
            </div>
          </div>
          <div className="bi-form-row">
            <div className="bi-field">
              <label>Start date</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="bi-input"
              />
            </div>
            <div className="bi-field">
              <label>End date (optional)</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="bi-input"
                placeholder="Same as start for single day"
              />
            </div>
          </div>
          {form.closure_type !== 'holiday' && (
            <label className="bi-toggle">
              <input
                type="checkbox"
                checked={form.is_recurring}
                onChange={(e) => setForm(f => ({ ...f, is_recurring: e.target.checked }))}
              />
              Repeat every year
            </label>
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-3)' }}>
            <button className="bi-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="bi-save-btn" onClick={submit} disabled={saving || !form.start_date} style={{ padding: '0.5rem var(--space-4)' }}>
              <Save size={14} /> Add closure
            </button>
          </div>
        </div>
      )}

      {recurring.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">🔁 Recurring annually ({recurring.length})</div>
          {recurring.map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} recurring />)}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📅 Upcoming closures ({upcoming.length})</div>
          {upcoming.map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} />)}
        </div>
      )}

      {past.length > 0 && (
        <div className="bi-closures-group">
          <div className="bi-closures-group-title">📜 Past closures ({past.length})</div>
          {past.slice(0, 5).map(c => <ClosureItem key={c.id} closure={c} onDelete={onDelete} muted />)}
        </div>
      )}

      {closures.length === 0 && (
        <div className="bi-empty">
          <Calendar size={32} style={{ color: 'var(--clr-warm-mid)' }} />
          <p>No closures yet. Add common holidays above or create a custom closure.</p>
        </div>
      )}
    </div>
  )
}

function ClosureItem({ closure, onDelete, recurring, muted }) {
  const isRange = closure.start_date !== closure.end_date

  return (
    <div className={`bi-closure-item ${muted ? 'muted' : ''}`}>
      <div className="bi-closure-info">
        <div className="bi-closure-name">{closure.reason || 'Closed'}</div>
        <div className="bi-closure-meta">
          {recurring && <span>Annually · </span>}
          {isRange ? (
            <>{shortDate(closure.start_date)} – {shortDate(closure.end_date)}</>
          ) : (
            <>{formatDate(closure.start_date)}</>
          )}
        </div>
      </div>
      <button onClick={() => onDelete(closure.id)} className="bi-delete-btn" title="Delete">
        <Trash2 size={13} />
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Licensing tab — license_type control (profiles.license_type, PR #14 / mig 022)
//
// PR #14 renamed this section header from the misleading "Provider Type"
// (which was easily confused with the unrelated profiles.provider_type CDC-
// billing column) to "License Type" — the compliance source of truth.
// Writes go through saveLicenseStatus, which mirrors is_license_exempt and
// clears license_type_review_needed alongside the license_type write.
// -----------------------------------------------------------------------------

const LICENSE_SWITCH_CONFIRM = {
  exemptToLicensed:
    'Switching to licensed will hide the MiRegistry tracker. Any MiRegistry ' +
    'trainings you’ve logged will be kept — not deleted — but they won’t ' +
    'appear in your sidebar unless you switch back or add a MiRegistry ID. ' +
    'Continue?',
  licensedToExempt:
    'Switching to license-exempt will turn on the MiRegistry tracker — ' +
    'you’ll find it in the Compliance section of your sidebar. Continue?',
}

// The three answer values — match profiles.license_type 1:1 (migration 022).
const LT_CHOICE = Object.freeze({
  FAMILY_HOME:    'family_home',
  GROUP_HOME:     'group_home',
  LICENSE_EXEMPT: 'license_exempt',
})

// Presentational — copy intentionally identical to LicenseStatusPromptModal
// so the provider sees the same wording on both surfaces.
function LicensingSection({ currentValue, reviewNeeded, onSave, saving }) {
  // currentValue: 'family_home' | 'group_home' | 'license_exempt' | null
  const [choice, setChoice] = useState(currentValue)

  const answered =
    choice === LT_CHOICE.FAMILY_HOME ||
    choice === LT_CHOICE.GROUP_HOME ||
    choice === LT_CHOICE.LICENSE_EXEMPT
  const dirty = choice !== currentValue

  return (
    <div className="bi-section">
      <div className="bi-section-header">
        <h3>License Type</h3>
        <p>
          Whether you’re a Family Home, Group Home, or license-exempt
          provider shapes which Michigan compliance tools MILittleCare shows
          you. Update this here if your status ever changes.
        </p>
        {reviewNeeded && (
          <div
            role="alert"
            style={{
              marginTop: 10,
              padding: '8px 12px',
              background: 'var(--clr-warn-pale, #fdf3d8)',
              border: '1px solid var(--clr-warn-mid, #e8d196)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--clr-warn-ink, #8a6a1a)',
              fontSize: '0.875rem',
              lineHeight: 1.5,
            }}
          >
            <strong>Please confirm your license type.</strong> We weren’t
            able to determine Family vs Group Home from your existing data —
            pick the one that applies and save.
          </div>
        )}
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend
          style={{
            padding: 0,
            marginBottom: 8,
            fontWeight: 500,
            color: 'var(--clr-ink)',
          }}
        >
          Which describes your child care?
        </legend>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={licenseRadioStyle(choice === LT_CHOICE.FAMILY_HOME)}>
            <input
              type="radio"
              name="license_type"
              checked={choice === LT_CHOICE.FAMILY_HOME}
              onChange={() => setChoice(LT_CHOICE.FAMILY_HOME)}
              disabled={saving}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <span>
              <strong>I hold a Michigan Family Child Care Home license</strong>{' '}
              <span style={licenseParenStyle}>(up to 6 children)</span>
              <span style={licenseSubStyle}>
                Licensed by the State of Michigan. Family homes care for up
                to 6 children at a time.
              </span>
            </span>
          </label>
          <label style={licenseRadioStyle(choice === LT_CHOICE.GROUP_HOME)}>
            <input
              type="radio"
              name="license_type"
              checked={choice === LT_CHOICE.GROUP_HOME}
              onChange={() => setChoice(LT_CHOICE.GROUP_HOME)}
              disabled={saving}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <span>
              <strong>I hold a Michigan Group Child Care Home license</strong>{' '}
              <span style={licenseParenStyle}>(up to 12 children)</span>
              <span style={licenseSubStyle}>
                Licensed by the State of Michigan. Group homes care for up
                to 12 children at a time.
              </span>
            </span>
          </label>
          <label style={licenseRadioStyle(choice === LT_CHOICE.LICENSE_EXEMPT)}>
            <input
              type="radio"
              name="license_type"
              checked={choice === LT_CHOICE.LICENSE_EXEMPT}
              onChange={() => setChoice(LT_CHOICE.LICENSE_EXEMPT)}
              disabled={saving}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <span>
              <strong>
                I care for children I’m related to or already know,
                registered with MDHHS
              </strong>{' '}
              <span style={licenseParenStyle}>(license-exempt provider)</span>
              <span style={licenseSubStyle}>
                Not licensed by the State of Michigan. This is the most
                common setup for in-home CDC providers.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      <button
        className="bi-save-btn"
        onClick={() => onSave(choice)}
        disabled={!answered || !dirty || saving}
      >
        <Save size={14} /> {saving ? 'Saving…' : 'Save license type'}
      </button>
    </div>
  )
}

function licenseRadioStyle(selected) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 12px',
    border: `1px solid ${selected ? 'var(--clr-sage)' : 'var(--clr-warm-mid)'}`,
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    background: selected ? 'var(--clr-cream)' : 'transparent',
  }
}

const licenseSubStyle = {
  display: 'block',
  marginTop: 2,
  fontSize: '0.8125rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.45,
  fontWeight: 400,
}

const licenseParenStyle = {
  fontWeight: 400,
  color: 'var(--clr-ink-soft)',
}
