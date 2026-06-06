// Pure helpers for the children roster. No React, no Supabase, no I/O —
// callers pass rows in, get partitioned/derived results out (the testable
// seam for the soft-delete UI introduced in PR #13).

/**
 * Split a list of children into active vs archived by the archived_at
 * soft-delete marker (PR #13 / migration 021). A row is archived iff it
 * carries a truthy `archived_at`; everything else (including a null/absent
 * marker) is active.
 *
 * @param {Array<{archived_at?: string|null}>} [children]
 * @returns {{ active: object[], archived: object[] }}
 */
export function partitionChildren(children = []) {
  const active = []
  const archived = []
  for (const c of children || []) {
    if (!c) continue
    if (c.archived_at) archived.push(c)
    else active.push(c)
  }
  return { active, archived }
}

/** Active rows only — convenience for surfaces that never show archived. */
export function activeChildren(children = []) {
  return partitionChildren(children).active
}

/**
 * Display name for a child row. Mirrors the convention used across
 * the app (FamiliesPage cards, family summary, etc.):
 * `first_name last_name`, trimmed, falling back to whichever piece
 * exists. Returns null when no name fields are populated.
 *
 * Used by the Phase 3 Compliance Checklist surfaces so the per-child
 * rollup renders names instead of UUIDs. Pure.
 *
 * @param {{ first_name?: string|null, last_name?: string|null }|null} child
 * @returns {string|null}
 */
export function displayChildName(child) {
  if (!child) return null
  const parts = [child.first_name, child.last_name]
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  if (parts.length === 0) return null
  return parts.join(' ')
}

/**
 * Find a child row by id within a list, then return its display
 * name (or null when no match / no name fields). Defensive against
 * loading/empty-list cases.
 *
 * @param {Array} children
 * @param {string} childId
 * @returns {string|null}
 */
export function findChildDisplayName(children, childId) {
  if (!Array.isArray(children) || !childId) return null
  const c = children.find(row => row && row.id === childId)
  return displayChildName(c)
}
