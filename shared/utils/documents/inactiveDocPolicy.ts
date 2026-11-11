// Policy for the inactive-doc sweeper. Pure function — no DB, no clock
// reads, no side effects — so it's fully unit-testable and the plugin
// query derives its WHERE clause from the same rules.
//
// Rules:
//
//   1. Workspace-attached docs are NEVER reaped. The workspace is the
//      user's explicit organisation signal; inactivity ≠ abandonment.
//   2. Owner-owned docs (ownerId !== null) are NEVER reaped. An
//      authenticated user is on the hook for managing their own docs,
//      even long-dormant ones (archival notes, old drafts). Auto-delete
//      would surprise them.
//   3. Anonymous docs (ownerId === null, workspaceId === null) are
//      reaped after `anonTtlDays` of inactivity. There's no stable
//      identity attached — if they're cold for months, they're almost
//      certainly abandoned.
//   4. `anonTtlDays <= 0` disables reaping entirely.

export interface SweepDocState {
  ownerId: number | null
  workspaceId: string | null
  lastActive: Date
}

/**
 * Decide whether a single document should be reaped by the sweeper.
 * Returns true iff the doc is anonymous, outside a workspace, and past
 * the inactivity cutoff. Owned and workspace-attached docs ALWAYS
 * return false regardless of age.
 */
export function shouldReapDoc(
  doc: SweepDocState,
  now: Date,
  anonTtlDays: number
): boolean {
  if (anonTtlDays <= 0) return false
  // Owned or workspace-attached → never reap.
  if (doc.ownerId !== null) return false
  if (doc.workspaceId !== null) return false

  const dayMs = 24 * 60 * 60 * 1000
  const cutoff = now.getTime() - anonTtlDays * dayMs
  return doc.lastActive.getTime() < cutoff
}
