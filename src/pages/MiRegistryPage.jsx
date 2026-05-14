// MiRegistry tracker page. See docs/miregistry_tracker_spec.md § 3.2
// for the layout this implements.
//
// Conditional rendering:
//   - profile.miregistry_id missing               → ID-prompt empty state
//   - has ID + is_license_exempt === true         → full view (3 cards + list + settings)
//   - has ID + is_license_exempt !== true         → stripped view (list + settings only)
//
// Data ownership: this page fetches profile + entries on mount. Cards
// derive their values from `entries` via the pure helpers in
// src/lib/miregistry. The list (TrainingEntryList) does its own fetch
// — accepted minor duplication; refresh is coordinated via refreshTick
// and the onChanged callback so cards and list stay in sync after any
// mutation.

import { useEffect, useId, useMemo, useState } from 'react'
import { Edit2, Info, Plus, AlertCircle, CheckCircle, Calendar } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import {
  getAnnualDeadlineStatus,
  getLoggedHoursThisYear,
  todayYMD,
} from '@/lib/miregistry'
import TrainingEntryList from '@/components/miregistry/TrainingEntryList'
import TrainingEntryForm from '@/components/miregistry/TrainingEntryForm'
import UpdateLevelModal from '@/components/miregistry/UpdateLevelModal'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIREGISTRY_HELP_URL = 'https://miregistry.org'

const ID_PROMPT_HELP =
  'Sign in to MiRegistry, click your name in the top-right, then ' +
  'open Profile. Your ID is the number labeled “MiRegistry ID” at ' +
  'the top of the page.'

const LEVEL_HELP_BUBBLE =
  'Every license-exempt provider starts at Level 1 after completing ' +
  'LEPPT. To reach Level 2, complete 10 hours of MiRegistry-approved ' +
  'training (each session ≥ 1 hour); LEPPT itself doesn’t count. ' +
  'Level 2 raises your hourly pay rate from $2.95 to $4.40–$4.95 ' +
  'depending on the child’s age band.'

const HOURS_RENEWAL_HELP =
  'Your Level 2 renewal cycle starts from your current expiration ' +
  'date, not January 1, and MiRegistry applies its own counting ' +
  'rules (1-hour-minimum sessions, 2-hour cap on Annual Ongoing). ' +
  'We don’t mirror that math. Check your MiRegistry transcript for ' +
  'the authoritative Level 2 renewal number.'

const PAGE_FETCH_ERROR =
  'Couldn’t load your MiRegistry data. Refresh the page, or email ' +
  'support@milittlecare.com if it keeps happening.'

const ID_SAVE_ERROR =
  'Couldn’t save the MiRegistry ID. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function formatLongDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = String(ymd).split('-').map(Number)
  if (!y || !m || !d) return String(ymd)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

function formatTimestampLong(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function MiRegistryPage() {
  const { user } = useAuth()
  const [profile, setProfile] = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Modal state
  const [editingEntry, setEditingEntry] = useState(null)
  const [adding, setAdding] = useState(false)
  const [updatingLevel, setUpdatingLevel] = useState(false)

  // Refresh signal for the list (it owns its own fetch).
  const [refreshTick, setRefreshTick] = useState(0)

  // -- Fetch ----------------------------------------------------------------

  const fetchPageData = async () => {
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [profResp, entriesResp] = await Promise.all([
        supabase
          .from('profiles')
          .select('id, miregistry_id, is_license_exempt, miregistry_current_level, miregistry_level_2_expires_on, miregistry_level_last_updated_at')
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('miregistry_training_entries')
          .select('*')
          .eq('user_id', user.id),
      ])
      if (profResp.error) throw profResp.error
      if (entriesResp.error) throw entriesResp.error
      setProfile(profResp.data || null)
      setEntries(entriesResp.data || [])
    } catch (err) {
      console.error('MiRegistryPage: fetch failed', err)
      setError(PAGE_FETCH_ERROR)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPageData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // -- Derived state --------------------------------------------------------

  const currentYear = new Date().getFullYear()

  const annualStatus = useMemo(
    () => getAnnualDeadlineStatus({ year: currentYear, entries, today: todayYMD() }),
    [entries, currentYear]
  )
  const totalHoursThisYear = useMemo(
    () => getLoggedHoursThisYear({ year: currentYear, entries }),
    [entries, currentYear]
  )

  // -- Mutation callbacks ---------------------------------------------------

  // Triggered when an entry is added/edited/archived/restored.
  // Refetch page data (cards) AND bump refreshTick (list).
  const handleDataChanged = () => {
    setRefreshTick(t => t + 1)
    fetchPageData()
  }

  const closeForm = () => {
    setAdding(false)
    setEditingEntry(null)
  }
  const handleEntrySaved = () => {
    closeForm()
    handleDataChanged()
  }

  const closeLevelModal = () => setUpdatingLevel(false)
  const handleLevelSaved = () => {
    closeLevelModal()
    fetchPageData()  // level lives on profile, list doesn't need refresh
  }

  // -- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div style={pageShellStyle}>
        <p style={loadingStyle}>Loading MiRegistry data…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={pageShellStyle}>
        <div role="alert" style={errorBannerStyle}>
          <AlertCircle size={14} style={{ marginRight: 6 }} />
          {error}
        </div>
      </div>
    )
  }

  const hasMiregistryId = !!profile?.miregistry_id
  const isLicenseExempt = profile?.is_license_exempt === true

  return (
    <div style={pageShellStyle}>
      <h2 style={pageTitleStyle}>MiRegistry Training</h2>

      {!hasMiregistryId ? (
        <IDPromptCard onSaved={handleDataChanged} />
      ) : (
        <>
          {isLicenseExempt && (
            <>
              <div style={cardsRowStyle}>
                <AnnualOngoingCard status={annualStatus} year={currentYear} />
                <TrainingLevelCard
                  profile={profile}
                  onUpdate={() => setUpdatingLevel(true)}
                />
              </div>
              <TrainingHoursCard year={currentYear} totalHours={totalHoursThisYear} />
            </>
          )}

          <TrainingEntryList
            onLogNew={() => setAdding(true)}
            onEditEntry={(entry) => setEditingEntry(entry)}
            onChanged={handleDataChanged}
            refreshTick={refreshTick}
          />

          <IDSettingsRow profile={profile} onSaved={handleDataChanged} />
        </>
      )}

      {(adding || editingEntry) && (
        <TrainingEntryForm
          existingEntry={editingEntry}
          onClose={closeForm}
          onSaved={handleEntrySaved}
        />
      )}

      {updatingLevel && (
        <UpdateLevelModal
          profile={profile}
          onClose={closeLevelModal}
          onSaved={handleLevelSaved}
        />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Card components (page-specific, no reuse expected — kept inline)
// -----------------------------------------------------------------------------

function AnnualOngoingCard({ status, year }) {
  const isOverdue = !status.completed && status.isPastDeadline

  return (
    <div style={{ ...cardStyle, ...(isOverdue ? cardAlertStyle : {}) }}>
      <div style={cardTitleRowStyle}>
        <Calendar size={14} style={{ color: 'var(--clr-ink-soft)' }} />
        <span style={cardTitleStyle}>Annual Ongoing Training</span>
      </div>

      {status.completed ? (
        <>
          <div style={cardBigValueStyle}>
            <CheckCircle size={18} style={{ color: 'var(--clr-success, #4a6957)', marginRight: 6 }} />
            Done for {year}
          </div>
          <div style={cardSubStyle}>
            Completed {formatLongDate(status.completionDate)}
          </div>
          <div style={{ ...cardSubStyle, marginTop: 8 }}>
            Next deadline: <strong>{formatLongDate(status.deadlineDate)}</strong>
            {' '}({status.daysUntilDeadline} days)
          </div>
        </>
      ) : isOverdue ? (
        <>
          <div style={{ ...cardBigValueStyle, color: 'var(--clr-danger, #b00020)' }}>
            <AlertCircle size={18} style={{ marginRight: 6 }} />
            Overdue
          </div>
          <div style={cardSubStyle}>
            Annual training was due {formatLongDate(status.deadlineDate)}.
            Per MDHHS, your provider account may be closed and you’ll
            need to reapply before resuming CDC billing. Call MDHHS
            Child Development and Care at 866-990-3227 for next steps.
          </div>
        </>
      ) : (
        <>
          <div style={cardBigValueStyle}>Not yet completed for {year}</div>
          <div style={cardSubStyle}>
            Deadline: <strong>{formatLongDate(status.deadlineDate)}</strong>
            {' '}({status.daysUntilDeadline} days remaining)
          </div>
        </>
      )}
    </div>
  )
}

function TrainingLevelCard({ profile, onUpdate }) {
  const level = profile?.miregistry_current_level
  const expires = profile?.miregistry_level_2_expires_on
  const lastUpdated = profile?.miregistry_level_last_updated_at

  return (
    <div style={cardStyle}>
      <div style={cardTitleRowStyle}>
        <span style={cardTitleStyle}>Training Level</span>
        <HelpTooltip text={LEVEL_HELP_BUBBLE} label="Help: Training Level">
          <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
        </HelpTooltip>
      </div>

      {!level ? (
        <>
          <div style={cardBigValueStyle}>Not set</div>
          <div style={cardSubStyle}>
            Update from MiRegistry to record your current level.
          </div>
        </>
      ) : level === 'level_1' ? (
        <>
          <div style={cardBigValueStyle}>Level 1</div>
          <div style={cardSubStyle}>
            Default after LEPPT. Complete 10 MiRegistry-approved hours
            to advance to Level 2.
          </div>
        </>
      ) : (
        <>
          <div style={cardBigValueStyle}>Level 2</div>
          <div style={cardSubStyle}>
            Expires <strong>{formatLongDate(expires) || '—'}</strong>
          </div>
        </>
      )}

      <div style={{ ...cardSubStyle, marginTop: 12, fontStyle: 'italic' }}>
        {lastUpdated
          ? `Last updated by you on ${formatTimestampLong(lastUpdated)}`
          : 'Never updated'}
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={onUpdate} className="btn-discard" style={cardActionBtnStyle}>
          <Edit2 size={12} /> Update from MiRegistry
        </button>
      </div>
    </div>
  )
}

function TrainingHoursCard({ year, totalHours }) {
  return (
    <div style={{ ...cardStyle, gridColumn: '1 / -1' }}>
      <div style={cardTitleRowStyle}>
        <span style={cardTitleStyle}>Training Hours ({year})</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        <div>
          <span style={cardLabelInline}>Hours logged this calendar year:</span>
          <strong style={{ marginLeft: 8, fontSize: '1.125rem', color: 'var(--clr-ink)' }}>
            {totalHours.toFixed(1)}
          </strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={cardLabelInline}>Hours toward your next Level 2 renewal:</span>
          <span style={{ color: 'var(--clr-ink-soft)' }}>
            check your MiRegistry transcript
          </span>
          <HelpTooltip text={HOURS_RENEWAL_HELP} label="Why we don't compute Level 2 renewal hours">
            <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
          </HelpTooltip>
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// ID prompt + settings (small, page-specific)
// -----------------------------------------------------------------------------

function IDPromptCard({ onSaved }) {
  const { user } = useAuth()
  const inputId = useId()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('MiRegistry ID is required.')
      return
    }
    if (trimmed.length > 30) {
      setError('MiRegistry ID looks too long (over 30 characters). Double-check before saving.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await supabase
        .from('profiles')
        .update({ miregistry_id: trimmed })
        .eq('id', user.id)
      if (e) throw e
      onSaved?.()
    } catch (err) {
      console.error('IDPromptCard: save failed', err)
      setError(ID_SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ ...cardStyle, gridColumn: '1 / -1', maxWidth: 560 }}>
      <div style={cardTitleRowStyle}>
        <span style={cardTitleStyle}>Add your MiRegistry ID</span>
        <HelpTooltip text={ID_PROMPT_HELP} label="Help: where to find your MiRegistry ID">
          <Info size={12} style={{ color: 'var(--clr-ink-soft)' }} />
        </HelpTooltip>
      </div>
      <p style={{ ...cardSubStyle, marginTop: 4, marginBottom: 12 }}>
        Your MiRegistry ID is how MDHHS verifies completed training and
        authorizes CDC payments. Enter it once and we’ll surface your
        annual deadline and Level 1/2 status here. Find it on{' '}
        <a href={MIREGISTRY_HELP_URL} target="_blank" rel="noopener noreferrer">
          miregistry.org
        </a>{' '}
        under your profile.
      </p>

      <label htmlFor={inputId} className="field-label">MiRegistry ID</label>
      <input
        id={inputId}
        className="field-input"
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="e.g. 1234567"
        disabled={saving}
        aria-invalid={!!error}
      />
      {error && (
        <div role="alert" style={{ color: 'var(--clr-danger, #b00020)', fontSize: '0.8125rem', marginTop: 6 }}>
          {error}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button
          onClick={submit}
          disabled={saving}
          className="btn-save"
          style={{ flex: 'initial', padding: '0.5rem 0.875rem' }}
        >
          {saving ? 'Saving…' : 'Save MiRegistry ID'}
        </button>
      </div>
    </div>
  )
}

function IDSettingsRow({ profile, onSaved }) {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(profile?.miregistry_id || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const inputId = useId()

  const startEdit = () => {
    setValue(profile?.miregistry_id || '')
    setError(null)
    setEditing(true)
  }
  const cancel = () => {
    setEditing(false)
    setError(null)
  }
  const submit = async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('MiRegistry ID is required.')
      return
    }
    if (trimmed.length > 30) {
      setError('MiRegistry ID looks too long (over 30 characters). Double-check before saving.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { error: e } = await supabase
        .from('profiles')
        .update({ miregistry_id: trimmed })
        .eq('id', user.id)
      if (e) throw e
      setEditing(false)
      onSaved?.()
    } catch (err) {
      console.error('IDSettingsRow: save failed', err)
      setError(ID_SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section style={{ ...settingsSectionStyle }}>
      <h3 style={settingsTitleStyle}>Settings</h3>
      <div style={settingsRowStyle}>
        <span style={{ color: 'var(--clr-ink-soft)' }}>MiRegistry ID:</span>
        {editing ? (
          <>
            <input
              id={inputId}
              className="field-input"
              type="text"
              value={value}
              onChange={e => setValue(e.target.value)}
              disabled={saving}
              style={{ maxWidth: 220 }}
              aria-invalid={!!error}
            />
            <button onClick={submit} disabled={saving} className="btn-save" style={inlineBtnStyle}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancel} disabled={saving} className="btn-discard" style={inlineBtnStyle}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <strong>{profile?.miregistry_id}</strong>
            <button onClick={startEdit} className="btn-discard" style={inlineBtnStyle}>
              <Edit2 size={12} /> Edit
            </button>
          </>
        )}
      </div>
      {error && (
        <div role="alert" style={{ color: 'var(--clr-danger, #b00020)', fontSize: '0.8125rem', marginTop: 6 }}>
          {error}
        </div>
      )}
    </section>
  )
}

// -----------------------------------------------------------------------------
// Inline styles
// -----------------------------------------------------------------------------

const pageShellStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-5)',
  padding: 'var(--space-5)',
  maxWidth: 960,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
}

const pageTitleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.5rem',
  color: 'var(--clr-ink)',
  margin: 0,
}

const cardsRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 'var(--space-4)',
}

const cardStyle = {
  background: 'white',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const cardAlertStyle = {
  borderColor: 'var(--clr-danger, #b00020)',
  background: 'var(--clr-danger-pale, #fbe9eb)',
}

const cardTitleRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 4,
}

const cardTitleStyle = {
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--clr-ink-soft)',
  fontWeight: 500,
}

const cardBigValueStyle = {
  display: 'flex',
  alignItems: 'center',
  fontFamily: 'var(--font-display)',
  fontSize: '1.25rem',
  color: 'var(--clr-ink)',
  marginTop: 2,
}

const cardSubStyle = {
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
  lineHeight: 1.5,
  margin: 0,
}

const cardLabelInline = {
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const cardActionBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0.5rem 0.875rem',
  fontSize: '0.8125rem',
}

const settingsSectionStyle = {
  borderTop: '1px solid var(--clr-warm-mid)',
  paddingTop: 'var(--space-4)',
}

const settingsTitleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.0625rem',
  color: 'var(--clr-ink)',
  margin: '0 0 var(--space-3)',
}

const settingsRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
  fontSize: '0.9375rem',
  color: 'var(--clr-ink)',
}

const inlineBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0.375rem 0.75rem',
  fontSize: '0.8125rem',
  flex: 'initial',
}

const loadingStyle = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const errorBannerStyle = {
  display: 'flex',
  alignItems: 'center',
  background: 'var(--clr-danger-pale, #fbe9eb)',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-3) var(--space-4)',
  color: 'var(--clr-danger, #b00020)',
  fontSize: '0.875rem',
  lineHeight: 1.45,
}
