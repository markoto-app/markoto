// Pure helpers shared by `ActivityFeed.vue`. Extracted out of the SFC
// because the categorisation + expansion-eligibility branching is
// the most likely place for a bug to slip in (every new action kind
// touches both functions), and pulling them out lets unit tests
// cover every action variant without mounting Vue.

export type ActivityAction
  = | 'edit' | 'join' | 'leave'
    | 'comment.added' | 'comment.replied'
    | 'comment.resolved' | 'comment.reopened' | 'comment.deleted'
    | 'theme.changed' | 'title.changed' | 'ai.tool'
    | 'restore'

export interface ActivityLike {
  action: ActivityAction
  userName: string | null
  metadata?: { kind?: string } | null
}

export type FilterKey = 'all' | 'edits' | 'comments' | 'ai' | 'meta'

/**
 * Category each row falls into for the filter chips. Matches the
 * filter UI: `All` | `Edits` | `Comments` | `AI` | `Meta`.
 *
 * Cross-cutting rule: ANY row authored by AI Assistant lands in
 * `ai`, regardless of action — keeps the AI chip a single
 * convergence point for "what did the AI do" review. So an AI's
 * comment.added counts toward AI, not Comments.
 *
 * `join` / `leave` rows return `'all'` because they only show up
 * when the All chip is active; they don't deserve their own bucket
 * (rare and noisy if surfaced).
 */
export function categoryOf(entry: ActivityLike): FilterKey {
  if (entry.userName === 'AI Assistant') return 'ai'
  if (entry.action === 'edit') return 'edits'
  if (entry.action.startsWith('comment.')) return 'comments'
  if (entry.action === 'title.changed' || entry.action === 'theme.changed') return 'meta'
  // restore rows live under the meta filter — they're rare per-doc
  // events that don't deserve their own chip but DO conceptually
  // belong with title/theme as "doc-level changes."
  if (entry.action === 'restore') return 'meta'
  return 'all'
}

/**
 * Whether the row card should expand on click — drives the
 * "View change" / "View thread" / "View details" affordance.
 *
 * Expansion-eligible kinds:
 *   - `edit`  — diff drawer (always shown; pre-feature rows show
 *               "diff unavailable" inside)
 *   - `comment.*` — thread context drawer
 *   - `ai.tool` — only when metadata.kind === 'ai.tool', so we
 *                 don't show an empty drawer on legacy rows where
 *                 metadata was lost
 *
 * Other kinds (theme.changed, title.changed, join, leave) don't
 * have a useful expansion yet — Phase G + future work.
 */
export function isExpandable(entry: ActivityLike): boolean {
  if (entry.action === 'edit') return true
  if (entry.action.startsWith('comment.')) return true
  if (entry.action === 'ai.tool' && entry.metadata?.kind === 'ai.tool') return true
  // restore rows carry boundary ids (set by the endpoint) so the
  // existing diff-drawer machinery from Tier 1 just works on them —
  // shows exactly what content the restore added back / removed.
  if (entry.action === 'restore') return true
  return false
}

/**
 * Per-kind affordance label — communicates what the click reveals.
 * Returns the i18n KEY (not the resolved string) so callers can
 * pass through to `t()` themselves and the helper stays Vue-free.
 */
export function expansionToggleLabelKey(entry: ActivityLike, expanded: boolean): string | null {
  if (entry.action === 'edit') {
    return expanded ? 'activity.diff.hideChange' : 'activity.diff.viewChange'
  }
  if (entry.action.startsWith('comment.')) {
    return expanded ? 'activity.commentContext.hide' : 'activity.commentContext.view'
  }
  if (entry.action === 'ai.tool') {
    return expanded ? 'activity.aiTool.hide' : 'activity.aiTool.view'
  }
  // restore rows reuse the diff-drawer terminology — "view change"
  // accurately describes what the user sees on expand: the textual
  // diff between live state and the restored state.
  if (entry.action === 'restore') {
    return expanded ? 'activity.diff.hideChange' : 'activity.diff.viewChange'
  }
  return null
}
