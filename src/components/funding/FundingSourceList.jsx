// TODO(testing): No component tests yet. Add render tests for loading,
// empty, error, populated, and show-archived states when FundingSourceForm
// ships in the next commit (React Testing Library install required).

import { useEffect, useState } from 'react'
import { Plus, Edit2, Archive, ArchiveRestore, Info } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/hooks/useAuth'
import HelpTooltip from '@/components/ui/HelpTooltip'

// User-facing labels. Strict adherence to CLAUDE.md "CDC compliance terminology":
// "CDC Scholarship" (not "subsidy"), "MI Tri-Share" (capital T, S, hyphen),
// "Head Start" (two words, capitalized), "GSRP" (acronym; expand on hover).
const TYPE_LABELS = {
  private_pay: 'Private Pay',
  cdc_scholarship: 'CDC Scholarship',
  tri_share: 'MI Tri-Share',
  gsrp: 'GSRP',
  head_start: 'Head Start',
  agency_other: 'Other Agency',
}

const STATUS_LABELS = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
}

// Inline help copy. Per CLAUDE.md § Documentation Conventions rule 1,
// every user-facing feature ships with inline help (no separate help doc).
// Tone: practical, plain language, no jargon-explaining-jargon.
const ADD_HELP =
  'Add a funding source for each way care is paid for. Private Pay attaches ' +
  'to the family. CDC Scholarship, MI Tri-Share, GSRP, Head Start, and other ' +
  'agency programs attach to individual children — a child can have one ' +
  'alongside Private Pay if state funding covers some hours and the family ' +
  'pays for the rest.'

const FIELD_HELP = {
  type:
    'What pays for this child’s care. Private Pay means the family pays out ' +
    'of pocket. CDC Scholarship is the State of Michigan’s childcare program ' +
    'paid by MDHHS — formerly called the childcare subsidy. MI Tri-Share ' +
    'splits cost three ways between an employer, the state, and the ' +
    'employee. GSRP is the Great Start Readiness Program for 4-year-olds. ' +
    'Head Start is the federal preschool program. Other Agency covers ' +
    'smaller funding partnerships.',
  priority:
    'When multiple funding sources cover the same hours, the lower number ' +
    'gets used first. State programs default to 1 (used first, up to their ' +
    'authorized hour cap). Private Pay defaults to 99, which means any ' +
    'leftover hours bill to the family.',
  status:
    'Active sources count toward billing and turn on related features. ' +
    'Paused sources are temporarily off — no billing, no feature gating, ' +
    'but everything is preserved. Ended sources are kept for audit history ' +
    'but don’t affect anything else.',
  needsReview:
    'This row came from the migration backfill and has no rate on file. ' +
    'Edit it and set a rate before generating an invoice — otherwise the ' +
    'invoice line will total $0.',
}

const EMPTY_STATE =
  'No funding sources yet. Every family needs at least one Private Pay ' +
  'source. Any child enrolled in CDC Scholarship, MI Tri-Share, GSRP, Head ' +
  'Start, or another agency program needs an additional source for that ' +
  'program. Click “Add funding source” above to get started.'

const FUNDING_SOURCE_COLUMNS =
  'id, type, status, start_date, end_date, priority, hours_cap_per_period, ' +
  'notes, details, archived_at, archived_by, child_id, family_id'

/**
 * Renders a family's funding sources grouped by attachment level.
 *
 * Props:
 *   familyId      uuid           required
 *   familyName    string         used in the archive/restore confirm copy
 *   childrenList  Array<{ id, first_name, last_name }>
 *   onAdd         () => void           parent opens the add-source form
 *   onEdit        (source) => void     parent opens the edit form
 *   onChanged     () => void           fires after archive/restore so parents can refetch
 */
export default function FundingSourceList({
  familyId,
  familyName,
  childrenList = [],
  refreshTick = 0,
  onAdd,
  onEdit,
  onChanged,
}) {
  const { user } = useAuth()
  const [sources, setSources] = useState([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const childIds = childrenList.map(c => c.id)
  const childIdsKey = childIds.join(',')

  const load = async () => {
    if (!familyId) return
    setLoading(true)
    setError(null)
    try {
      let familyQuery = supabase
        .from('funding_sources')
        .select(FUNDING_SOURCE_COLUMNS)
        .eq('family_id', familyId)
      if (!showArchived) familyQuery = familyQuery.is('archived_at', null)

      let childQuery
      if (childIds.length > 0) {
        childQuery = supabase
          .from('funding_sources')
          .select(FUNDING_SOURCE_COLUMNS)
          .in('child_id', childIds)
        if (!showArchived) childQuery = childQuery.is('archived_at', null)
      } else {
        childQuery = Promise.resolve({ data: [], error: null })
      }

      const [familyResp, childResp] = await Promise.all([familyQuery, childQuery])
      if (familyResp.error) throw familyResp.error
      if (childResp.error) throw childResp.error

      setSources([...(familyResp.data || []), ...(childResp.data || [])])
    } catch (err) {
      console.error('FundingSourceList: failed to load funding sources', err)
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId, childIdsKey, showArchived, refreshTick])

  const ownerLabelFor = source => {
    if (source.family_id) return familyName || 'Family'
    const child = childrenList.find(c => c.id === source.child_id)
    return child ? `${child.first_name} ${child.last_name || ''}`.trim() : 'Unknown child'
  }

  const handleArchive = async source => {
    const typeLabel = TYPE_LABELS[source.type] || source.type
    const owner = ownerLabelFor(source)
    const ok = window.confirm(
      `Archive ${owner}'s ${typeLabel} funding source?\n\n` +
        'This record is preserved for audit (4 years for licensed providers, ' +
        'longer for license-exempt) but won’t appear in active lists. You can ' +
        'view archived sources by toggling “Show archived” at the top.\n\n' +
        'You can restore it later if archived in error.'
    )
    if (!ok) return

    const { error: updateError } = await supabase
      .from('funding_sources')
      .update({
        archived_at: new Date().toISOString(),
        archived_by: user?.id || null,
        status: 'ended',
      })
      .eq('id', source.id)

    if (updateError) {
      console.error('FundingSourceList: archive failed', updateError)
      window.alert('Archive failed. Try again or contact support.')
      return
    }

    await load()
    onChanged?.()
  }

  const handleRestore = async source => {
    const typeLabel = TYPE_LABELS[source.type] || source.type
    const owner = ownerLabelFor(source)
    const ok = window.confirm(
      `Restore ${owner}'s ${typeLabel} funding source?\n\n` +
        'It will return to the active list, count toward billing again, and ' +
        're-activate any related features. You can edit it after restoring.'
    )
    if (!ok) return

    const { error: updateError } = await supabase
      .from('funding_sources')
      .update({
        archived_at: null,
        archived_by: null,
        status: 'active',
      })
      .eq('id', source.id)

    if (updateError) {
      console.error('FundingSourceList: restore failed', updateError)
      window.alert('Restore failed. Try again or contact support.')
      return
    }

    await load()
    onChanged?.()
  }

  const visibleSources = sources
  const familySources = visibleSources.filter(s => s.family_id)
  const childSources = visibleSources.filter(s => s.child_id)
  const archivedCount = visibleSources.filter(s => s.archived_at).length

  return (
    <div className="subsection">
      <div className="subsection-header">
        <span className="subsection-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          Funding sources
          <HelpTooltip text={ADD_HELP} label="What is a funding source?">
            <Info size={14} />
          </HelpTooltip>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: '0.8125rem',
              color: 'var(--clr-ink-soft)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
          <button className="btn-add-inline" onClick={onAdd}>
            <Plus size={13} /> Add funding source
          </button>
        </div>
      </div>

      {loading && <div className="empty-mini">Loading funding sources…</div>}

      {!loading && error && (
        <div className="empty-mini" role="alert" style={{ color: 'var(--clr-danger, #b00020)' }}>
          Couldn’t load funding sources. Refresh the page or contact support.
        </div>
      )}

      {!loading && !error && visibleSources.length === 0 && (
        <div className="empty-mini" style={{ textAlign: 'left', padding: 'var(--space-4)' }}>
          {EMPTY_STATE}
        </div>
      )}

      {!loading && !error && familySources.length > 0 && (
        <FundingGroup title="Family-level">
          {familySources.map(s => (
            <FundingSourceRow
              key={s.id}
              source={s}
              ownerLabel={ownerLabelFor(s)}
              onEdit={() => onEdit?.(s)}
              onArchive={() => handleArchive(s)}
              onRestore={() => handleRestore(s)}
            />
          ))}
        </FundingGroup>
      )}

      {!loading && !error && childSources.length > 0 && (
        <FundingGroup title="Child-level">
          {childSources.map(s => (
            <FundingSourceRow
              key={s.id}
              source={s}
              ownerLabel={ownerLabelFor(s)}
              onEdit={() => onEdit?.(s)}
              onArchive={() => handleArchive(s)}
              onRestore={() => handleRestore(s)}
            />
          ))}
        </FundingGroup>
      )}

      {showArchived && archivedCount === 0 && !loading && !error && (
        <div style={{ fontSize: '0.8125rem', color: 'var(--clr-ink-soft)', marginTop: 'var(--space-2)' }}>
          No archived funding sources for this family.
        </div>
      )}
    </div>
  )
}

function FundingGroup({ title, children }) {
  return (
    <div style={{ marginBottom: 'var(--space-4)' }}>
      <div
        style={{
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--clr-ink-soft)',
          marginBottom: 'var(--space-2)',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {children}
      </div>
    </div>
  )
}

function FundingSourceRow({ source, ownerLabel, onEdit, onArchive, onRestore }) {
  const typeLabel = TYPE_LABELS[source.type] || source.type
  const statusLabel = STATUS_LABELS[source.status] || source.status
  const needsReview = source.details?.needs_rate_review === true
  const isArchived = !!source.archived_at

  return (
    <div
      className="person-card"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        opacity: isArchived ? 0.65 : 1,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 500, color: 'var(--clr-ink)' }}>{ownerLabel}</span>
          <HelpTooltip text={FIELD_HELP.type} label={`Funding type: ${typeLabel}`}>
            <span
              style={{
                fontSize: '0.8125rem',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--clr-sage-pale)',
                color: 'var(--clr-sage-dark)',
              }}
            >
              {typeLabel}
            </span>
          </HelpTooltip>
          {needsReview && (
            <HelpTooltip text={FIELD_HELP.needsReview} label="This source needs a rate set">
              <span
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--clr-warning, #b86b00)',
                  color: 'white',
                  textTransform: 'uppercase',
                }}
              >
                Needs rate
              </span>
            </HelpTooltip>
          )}
          {isArchived && (
            <span
              style={{
                fontSize: '0.6875rem',
                fontWeight: 700,
                letterSpacing: '0.05em',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--clr-warm-mid)',
                color: 'var(--clr-ink)',
                textTransform: 'uppercase',
              }}
            >
              Archived
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: '0.8125rem',
            color: 'var(--clr-ink-soft)',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <HelpTooltip text={FIELD_HELP.status} label={`Status: ${statusLabel}`}>
            <span>{statusLabel}</span>
          </HelpTooltip>
          <span aria-hidden="true">·</span>
          <HelpTooltip
            text={FIELD_HELP.priority}
            label={`Priority ${source.priority}`}
          >
            <span>Priority {source.priority}</span>
          </HelpTooltip>
          {source.start_date && (
            <>
              <span aria-hidden="true">·</span>
              <span>Since {source.start_date}</span>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
        {isArchived ? (
          <button
            type="button"
            onClick={onRestore}
            aria-label="Restore funding source"
            title="Restore"
            style={iconButtonStyle}
          >
            <ArchiveRestore size={14} />
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit funding source"
              title="Edit"
              style={iconButtonStyle}
            >
              <Edit2 size={14} />
            </button>
            <button
              type="button"
              onClick={onArchive}
              aria-label="Archive funding source"
              title="Archive"
              style={{ ...iconButtonStyle, color: 'var(--clr-warning, #b86b00)' }}
            >
              <Archive size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: '1px solid var(--clr-warm-mid)',
  background: 'var(--clr-white)',
  color: 'var(--clr-ink-soft)',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
}
