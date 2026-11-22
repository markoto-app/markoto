// Pure helpers for `ActivityFeed.vue`, kept out of the SFC so unit tests
// can cover every action variant without mounting Vue. Every new action
// kind has to be handled in both `categoryOf` and `isExpandable`.

export type ActivityAction
  = | 'edit' | 'join' | 'leave'
    | 'comment.added' | 'comment.replied'
    | 'comment.resolved' | 'comment.reopened' | 'comment.deleted'
    | 'theme.changed' | 'title.changed' | 'ai.tool'
    | 'restore'
    | 'ai.job' | 'ai.job.reverted'
    | 'suggestion.accepted' | 'suggestion.rejected'

export interface ActivityLike {
  action: ActivityAction
  userName: string | null
  metadata?: { kind?: string } | null
}

export type FilterKey = 'all' | 'edits' | 'comments' | 'ai' | 'meta'

/**
 * Filter chip (`All` | `Edits` | `Comments` | `AI` | `Meta`) a row falls
 * into.
 *
 * Any row authored by AI Assistant lands in `ai` regardless of action, so
 * the AI chip is the one place to review what the AI did (an AI
 * comment.added counts toward AI, not Comments).
 *
 * `join` / `leave` rows return `'all'`: they only show under the All chip
 * (noisy, no bucket of their own).
 */
export function categoryOf(entry: ActivityLike): FilterKey {
  if (entry.userName === 'AI Assistant') return 'ai'
  // Delegated AI jobs (started / finished, undone).
  if (entry.action === 'ai.job' || entry.action === 'ai.job.reverted') return 'ai'
  if (entry.action === 'edit') return 'edits'
  if (entry.action.startsWith('comment.')) return 'comments'
  if (entry.action === 'title.changed' || entry.action === 'theme.changed') return 'meta'
  // Deciding suggestions changes the text: with the edits.
  if (entry.action === 'suggestion.accepted' || entry.action === 'suggestion.rejected') return 'edits'
  // Restores are rare document-level changes, like title/theme.
  if (entry.action === 'restore') return 'meta'
  return 'all'
}

/**
 * Whether the row card expands on click (the "View change" / "View
 * thread" / "View details" affordance).
 *
 * - `edit`: diff drawer, always offered (rows without a stored diff show
 *   "diff unavailable" inside).
 * - `comment.*`: thread context drawer.
 * - `ai.tool`: only when metadata.kind === 'ai.tool', so rows whose
 *   metadata was lost get no empty drawer.
 * - `restore`: the diff drawer too.
 *
 * Other kinds (theme.changed, title.changed, join, leave) have nothing
 * useful to expand.
 */
export function isExpandable(entry: ActivityLike): boolean {
  if (entry.action === 'edit') return true
  if (entry.action.startsWith('comment.')) return true
  if (entry.action === 'ai.tool' && entry.metadata?.kind === 'ai.tool') return true
  // Restore rows carry boundary ids (set by the endpoint), so the diff
  // drawer shows what the restore added back / removed.
  if (entry.action === 'restore') return true
  // Accepted suggestions: the diff drawer shows the accepted change.
  if (entry.action === 'suggestion.accepted') return true
  return false
}

/** i18n KEY (not the resolved string, so the helper stays Vue-free) of the expand toggle's label. */
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
  // Expanding a restore shows the diff between live and restored text.
  if (entry.action === 'restore' || entry.action === 'suggestion.accepted') {
    return expanded ? 'activity.diff.hideChange' : 'activity.diff.viewChange'
  }
  return null
}

/**
 * A URL from activity metadata that may be bound to `href` / `src`, or
 * `undefined`. AI-tool rows carry URLs from tool inputs and fetched
 * pages, so only absolute http(s) URLs and same-origin relative paths
 * pass: no `javascript:`/`data:`/other schemes, no protocol-relative
 * `//host`.
 */
export function safeLinkUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  // Browsers strip leading/trailing C0 + space and drop tab/newline
  // inside a URL, so judge the scheme on that normalised form.
  let start = 0
  while (start < raw.length && raw.charCodeAt(start) <= 0x20) start++
  const normalised = raw.slice(start).replaceAll(/[\t\n\r]/g, '')
  // `//host`, `\\host`, `/\host`: protocol-relative, i.e. another origin.
  if (/^[/\\]{2}/.test(normalised)) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalised)
  if (scheme) return /^https?$/i.test(scheme[1] ?? '') ? raw : undefined
  // No scheme: a path. Anything with a `:` before the first `/` would
  // be read as a scheme by a browser.
  return /^[^:]*(?:[/?#]|$)/.test(normalised) ? raw : undefined
}
