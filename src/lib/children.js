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
