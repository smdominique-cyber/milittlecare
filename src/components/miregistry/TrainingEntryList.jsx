// TODO(testing): Render tests pending React Testing Library install.
// Cover: loading / empty / populated / error states; show-archived
// toggle; year filter conditional render; click-row-to-edit
// propagation (action buttons must NOT trigger row click); source
// badge styles; under-1h Level 2 amber tag; archive + restore flows.

import { useEffect, useMemo, useState } from 'react'
import { Archive, AlertCircle, Edit2, FileText, Plus, RotateCcw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'
import { SOURCE, SOURCE_OPTIONS } from '@/lib/miregistry'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Per-source badge presentation. Color carries semantic weight here:
// Annual = "this one keeps you alive" (solid green); Level 2 = premium
// (sage pill); Initial = foundational/historical (cream); Other =
// neutral. Amber is intentionally NOT used for any badge — it stays
// reserved for warnings (the Under-1h tag below; future Level-2-
// expiring banners on the page).
const SOURCE_BADGE_STYLES = {
  [SOURCE.LEPPT]: {
    background: 'var(--clr-cream)',
    color: 'var(--clr-ink)',
    border: '1px solid transparent',
  },
  [SOURCE.ANNUAL_ONGOING]: {
    background: 'var(--clr-success, #4a6957)',
    color: 'white',
    border: '1px solid transparent',
  },
  [SOURCE.LEVEL_2_APPROVED]: {
    background: 'var(--clr-sage-pale, #dde8d9)',
    color: 'var(--clr-sage-dark, #3e5849)',
    border: '1px solid var(--clr-sage-dark, #3e5849)',
  },
  [SOURCE.OTHER]: {
    background: 'transparent',
    color: 'var(--clr-ink-soft)',
    border: '1px solid var(--clr-ink-soft)',
  },
}

const UNDER_1H_TOOLTIP =
  'Per the handbook (page 13), Level 2 trainings must be at least 1 ' +
  'hour to count toward your annual 10. This entry is on file for ' +
  'your records but doesn’t add to Level 2 progress.'

const NOTES_ICON_LABEL = 'This entry has notes — open it to read them.'

const ARCHIVE_CONFIRM =
  'Archive this training entry?\n\n' +
  'It stays on file in case you need it later — nothing is ' +
  'permanently deleted. You can restore it from the entries list.'

const FETCH_ERROR_GENERIC =
  'Couldn’t load training entries. Refresh the page, or email ' +
  'support@milittlecare.com if it keeps happening.'

const ARCHIVE_ERROR =
  'Couldn’t archive that entry. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

const RESTORE_ERROR =
  'Couldn’t restore that entry. Try again, or email ' +
  'support@milittlecare.com if it keeps happening.'

const EMPTY_COPY =
  'No trainings logged yet. Start with your most recent — older ' +
  'entries can be added afterward.'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function formatDate(isoOrYmd) {
  if (!isoOrYmd) return ''
  // Accept YYYY-MM-DD; rendering as MMM D, YYYY without timezone surprises.
  const [y, m, d] = isoOrYmd.split('-').map(Number)
  if (!y || !m || !d) return isoOrYmd
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

function formatHours(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  // 2.0h, 0.5h, 12.5h. Always one decimal so "1" vs "10" can't be
  // misread as "1h" looking like "10h" at a glance.
  return `${n.toFixed(1)}h`
}

function sourceMeta(source) {
  return SOURCE_OPTIONS.find(o => o.value === source) || null
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export default function TrainingEntryList({
  onLogNew,
  onEditEntry,
  onChanged,
  refreshTick = 0,
}) {
  const { user } = useAuth()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)  // archive/restore in flight
  const [showArchived, setShowArchived] = useState(false)
  const [yearFilter, setYearFilter] = useState('')

  // -- Fetch ----------------------------------------------------------------

  const fetchEntries = async () => {
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('miregistry_training_entries')
      .select('*')
      .eq('user_id', user.id)
      .order('completed_on', { ascending: false })
      .order('created_at', { ascending: false })
    if (err) {
      console.error('TrainingEntryList: fetch failed', err)
      setError(FETCH_ERROR_GENERIC)
      setLoading(false)
      return
    }
    setEntries(data || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchEntries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, refreshTick])

  // -- Derived state --------------------------------------------------------

  const availableYears = useMemo(() => {
    const years = new Set(
      entries
        .map(e => (e.completed_on || '').slice(0, 4))
        .filter(Boolean)
    )
    return Array.from(years).sort().reverse()  // newest first
  }, [entries])

  // Year filter is hidden when entries don't span 2+ years — small UX
  // win for new providers who only have one year of records.
  const showYearFilter = availableYears.length >= 2

  // If the user previously selected a year that no longer has any
  // entries (e.g., after archiving the last 2025 entry), clear the
  // filter rather than show an empty list with no signal.
  useEffect(() => {
    if (yearFilter && !availableYears.includes(yearFilter)) {
      setYearFilter('')
    }
  }, [availableYears, yearFilter])

  const visibleEntries = useMemo(() => {
    let filtered = entries
    if (!showArchived) filtered = filtered.filter(e => !e.archived_at)
    if (yearFilter) {
      filtered = filtered.filter(e => (e.completed_on || '').startsWith(yearFilter))
    }
    return filtered  // already sorted by the query
  }, [entries, showArchived, yearFilter])

  // -- Actions --------------------------------------------------------------

  const handleArchive = async (entry, e) => {
    e?.stopPropagation()
    if (!window.confirm(ARCHIVE_CONFIRM)) return
    setBusyId(entry.id)
    setError(null)
    try {
      const { error: arcErr } = await supabase
        .from('miregistry_training_entries')
        .update({
          archived_at: new Date().toISOString(),
          archived_by: user?.id || null,
        })
        .eq('id', entry.id)
      if (arcErr) throw arcErr
      await fetchEntries()
      onChanged?.()
    } catch (err) {
      console.error('TrainingEntryList: archive failed', err)
      setError(ARCHIVE_ERROR)
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = async (entry, e) => {
    e?.stopPropagation()
    setBusyId(entry.id)
    setError(null)
    try {
      const { error: resErr } = await supabase
        .from('miregistry_training_entries')
        .update({ archived_at: null, archived_by: null })
        .eq('id', entry.id)
      if (resErr) throw resErr
      await fetchEntries()
      onChanged?.()
    } catch (err) {
      console.error('TrainingEntryList: restore failed', err)
      setError(RESTORE_ERROR)
    } finally {
      setBusyId(null)
    }
  }

  const handleEdit = (entry, e) => {
    e?.stopPropagation()
    onEditEntry?.(entry)
  }

  const handleRowClick = (entry) => {
    // Click on row body opens edit. Action buttons stop propagation
    // (see handleArchive / handleRestore / handleEdit above).
    onEditEntry?.(entry)
  }

  // -- Render ---------------------------------------------------------------

  return (
    <section style={sectionStyle}>
      <div style={headerRowStyle}>
        <h3 style={sectionTitleStyle}>Logged trainings</h3>
        <div style={controlsRowStyle}>
          {showYearFilter && (
            <label style={filterLabelStyle}>
              <span style={{ marginRight: 6 }}>Show entries from:</span>
              <select
                value={yearFilter}
                onChange={e => setYearFilter(e.target.value)}
                style={selectStyle}
              >
                <option value="">All years</option>
                {availableYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          )}
          <label style={filterLabelStyle}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Show archived
          </label>
          <button
            onClick={() => onLogNew?.()}
            className="btn-save"
            style={logBtnStyle}
          >
            <Plus size={14} /> Log a training
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={errorBannerStyle}>
          <AlertCircle size={14} style={{ marginRight: 6, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={fetchEntries} style={retryBtnStyle}>Retry</button>
        </div>
      )}

      {loading ? (
        <p style={loadingStyle}>Loading trainings…</p>
      ) : visibleEntries.length === 0 ? (
        <EmptyState entries={entries} showArchived={showArchived} yearFilter={yearFilter} />
      ) : (
        <div style={listStyle}>
          {visibleEntries.map(entry => (
            <ListRow
              key={entry.id}
              entry={entry}
              busy={busyId === entry.id}
              onClick={() => handleRowClick(entry)}
              onEdit={(ev) => handleEdit(entry, ev)}
              onArchive={(ev) => handleArchive(entry, ev)}
              onRestore={(ev) => handleRestore(entry, ev)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function EmptyState({ entries, showArchived, yearFilter }) {
  // Distinguish "truly no entries" from "no entries match the current
  // filters" so the message lands accurately.
  const hasAnyEntries = entries.length > 0
  const hasAnyVisibleWithoutFilter = entries.some(e => !e.archived_at)

  if (!hasAnyEntries) {
    return <p style={emptyStyle}>{EMPTY_COPY}</p>
  }
  if (showArchived && yearFilter) {
    return (
      <p style={emptyStyle}>
        No entries from {yearFilter} (including archived). Try a different
        year or clear the filter.
      </p>
    )
  }
  if (yearFilter) {
    return (
      <p style={emptyStyle}>
        No entries from {yearFilter}. Try a different year, clear the
        filter, or toggle Show archived to see archived entries.
      </p>
    )
  }
  if (!showArchived && !hasAnyVisibleWithoutFilter) {
    return (
      <p style={emptyStyle}>
        All your entries are archived. Toggle Show archived to see them.
      </p>
    )
  }
  return <p style={emptyStyle}>{EMPTY_COPY}</p>
}

function ListRow({ entry, busy, onClick, onEdit, onArchive, onRestore }) {
  const isArchived = !!entry.archived_at
  const meta = sourceMeta(entry.source)
  const hours = Number(entry.hours)
  const showUnder1hWarning =
    entry.source === SOURCE.LEVEL_2_APPROVED &&
    Number.isFinite(hours) &&
    hours < 1

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      style={{
        ...rowStyle,
        opacity: isArchived ? 0.65 : 1,
        cursor: 'pointer',
      }}
    >
      <div style={dateCellStyle}>{formatDate(entry.completed_on)}</div>

      <div style={titleCellStyle}>
        {isArchived && <ArchivedPill />}
        <span style={titleTextStyle}>{entry.title}</span>
        {entry.notes && (
          <FileText
            size={12}
            aria-label={NOTES_ICON_LABEL}
            style={{ color: 'var(--clr-ink-soft)', marginLeft: 6, flexShrink: 0 }}
          />
        )}
      </div>

      <div style={hoursCellStyle}>
        <span>{formatHours(entry.hours)}</span>
        {showUnder1hWarning && (
          <HelpTooltip text={UNDER_1H_TOOLTIP} label="Why this doesn't count toward Level 2">
            <span style={under1hTagStyle}>Under 1h</span>
          </HelpTooltip>
        )}
      </div>

      <div style={sourceCellStyle}>
        {meta && <SourceBadge source={entry.source} />}
      </div>

      <div style={actionsCellStyle} onClick={e => e.stopPropagation()}>
        <button
          className="btn-discard"
          onClick={onEdit}
          disabled={busy}
          style={actionBtnStyle}
        >
          <Edit2 size={12} /> Edit
        </button>
        {isArchived ? (
          <button
            className="btn-discard"
            onClick={onRestore}
            disabled={busy}
            style={actionBtnStyle}
          >
            <RotateCcw size={12} /> Restore
          </button>
        ) : (
          <button
            className="btn-discard"
            onClick={onArchive}
            disabled={busy}
            style={actionBtnStyle}
          >
            <Archive size={12} /> Archive
          </button>
        )}
      </div>
    </div>
  )
}

function SourceBadge({ source }) {
  const meta = sourceMeta(source)
  if (!meta) return null
  const palette = SOURCE_BADGE_STYLES[source] || SOURCE_BADGE_STYLES[SOURCE.OTHER]
  return (
    <HelpTooltip text={meta.help} label={`Help: ${meta.label}`}>
      <span
        style={{
          ...badgeBaseStyle,
          ...palette,
        }}
      >
        {meta.badgeLabel}
      </span>
    </HelpTooltip>
  )
}

function ArchivedPill() {
  return (
    <span style={archivedPillStyle}>ARCHIVED</span>
  )
}

// -----------------------------------------------------------------------------
// Inline styles (per docs/tech_debt.md note on funding/ folder; same
// applies to miregistry/ pending the CSS extraction PR)
// -----------------------------------------------------------------------------

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
}

const headerRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
}

const sectionTitleStyle = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.0625rem',
  color: 'var(--clr-ink)',
  margin: 0,
}

const controlsRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  flexWrap: 'wrap',
}

const filterLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
  cursor: 'pointer',
}

const selectStyle = {
  padding: '4px 8px',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-sm)',
  background: 'white',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  color: 'var(--clr-ink)',
  cursor: 'pointer',
}

const logBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0.5rem 0.875rem',
  fontSize: '0.875rem',
  flex: 'initial',
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

const retryBtnStyle = {
  marginLeft: 12,
  padding: '4px 10px',
  fontSize: '0.78125rem',
  background: 'transparent',
  border: '1px solid var(--clr-danger, #b00020)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--clr-danger, #b00020)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const loadingStyle = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const emptyStyle = {
  margin: 0,
  fontSize: '0.9375rem',
  color: 'var(--clr-ink-soft)',
  padding: 'var(--space-5)',
  textAlign: 'center',
  background: 'var(--clr-cream)',
  border: '1px dashed var(--clr-warm-mid)',
  borderRadius: 'var(--radius-md)',
  lineHeight: 1.5,
}

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--clr-warm-mid)',
  borderRadius: 'var(--radius-md)',
  overflow: 'hidden',
  background: 'white',
}

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  padding: 'var(--space-3) var(--space-4)',
  borderBottom: '1px solid var(--clr-warm-mid)',
  outline: 'none',
}

const dateCellStyle = {
  width: 110,
  flexShrink: 0,
  fontSize: '0.875rem',
  color: 'var(--clr-ink-soft)',
}

const titleCellStyle = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.9375rem',
  color: 'var(--clr-ink)',
  fontWeight: 500,
}

const titleTextStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const hoursCellStyle = {
  width: 90,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  fontSize: '0.875rem',
  color: 'var(--clr-ink)',
}

const sourceCellStyle = {
  width: 100,
  flexShrink: 0,
  display: 'flex',
  justifyContent: 'flex-start',
}

const actionsCellStyle = {
  width: 160,
  flexShrink: 0,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 6,
}

const actionBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  fontSize: '0.78125rem',
  whiteSpace: 'nowrap',
}

const badgeBaseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.6875rem',
  fontWeight: 500,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  cursor: 'help',
}

const archivedPillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.625rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  background: 'var(--clr-warm-mid)',
  color: 'var(--clr-ink-soft)',
  marginRight: 6,
  flexShrink: 0,
}

const under1hTagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  fontSize: '0.625rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  background: 'var(--clr-warn-pale, #fdf3d8)',
  color: 'var(--clr-warn-ink, #8a6a1a)',
  border: '1px solid var(--clr-warn-mid, #e8d196)',
  cursor: 'help',
  whiteSpace: 'nowrap',
}
