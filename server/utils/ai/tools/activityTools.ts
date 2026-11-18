import { z } from 'zod'
import { defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { historyCutoff, resolveDocPlan } from '../../billing/entitlements'
import { searchActivity, type ActivityEntry } from '../../../repos/activity'
import type { AiToolActivityMetadata } from '~~/shared/contracts/activity'

// search_activity_log: long-term memory tier. The agentic loop's in-prompt
// `<conversation_history>` block holds the last 60 minutes (capped at
// 40 rows) of *this user's* prompts + AI tool calls + AI replies. Past
// that window, the AI must opt in to recall. `search_activity_log`
// gives it filtered access to the doc's activity log: every edit,
// comment, theme/title change, AI tool call, and restore, all users
// of the doc, not just this initiator.
//
// Use cases (from the user-facing prompt):
//   - "what did you base that table on?" → search for ai.tool rows
//     with web_search / fetch_url / search_knowledge / generate_image
//     near the time of the table edit.
//   - "revert what we did yesterday" → search for `edit` rows with
//     since=yesterday-start, before=yesterday-end.
//   - "did anyone change the title last week?" → action='title.changed'.
//
// Doc-scoped: the AI only sees activity for the current `aiSession.docId`.
// No cross-doc surface: for that, the model uses `view_other_document`
// + the destination doc's own activity.

const ACTIVITY_ACTION_NAMES = [
  'edit',
  'join',
  'leave',
  'comment.added',
  'comment.replied',
  'comment.resolved',
  'comment.reopened',
  'comment.deleted',
  'theme.changed',
  'title.changed',
  'ai.tool',
  'restore'
] as const

const SearchActivityLogArgs = z.object({
  query: z.string().trim().max(200).optional()
    .describe('Substring match against row metadata + author name (case-insensitive). Use this when the user references a specific topic ("the pricing table", "the intro") and you want to find when it was edited or commented on. Omit to search by action / time only.'),
  actions: z.array(z.enum(ACTIVITY_ACTION_NAMES)).max(12).optional()
    .describe('Restrict to specific action types. Common picks: ["edit"] (content changes), ["ai.tool"] (your own past tool calls, useful for "what did you base that on?"), ["title.changed", "theme.changed"] (metadata changes), ["restore"] (rollbacks), ["comment.added","comment.replied","comment.resolved","comment.reopened","comment.deleted"] (any comment activity). Omit for all action types.'),
  // Plain `z.string()` instead of `.datetime()`, Zod's draft-7 emit
  // for `.datetime()` includes a 600-char leap-year-aware regex that
  // some providers reject as an invalid schema. The handler re-validates with
  // `new Date(s)` + `isFinite` so a malformed string round-trips back
  // to the model as a clean tool error.
  since: z.string().min(1).max(40).optional()
    .describe('ISO-8601 timestamp lower bound (inclusive), UTC. Example: "2026-04-30T00:00:00Z" for "yesterday onwards" relative to a 2026-05-01 query date.'),
  before: z.string().min(1).max(40).optional()
    .describe('ISO-8601 timestamp upper bound (inclusive), UTC. Pair with `since` to window a specific day or range.'),
  limit: z.number().int().min(1).max(50).optional()
    .describe('Maximum rows to return. Default 20. Bump to 50 for survey-style queries; drop to 5–10 for "find the most recent X" lookups.')
}).strict()
  .describe('Search the document\'s long-term activity log: every edit, comment, theme/title change, AI tool call, and restore from this and prior sessions. Use when the user references something OUTSIDE the loaded `<conversation_history>` block, yesterday, last week, "what did you base X on", "find when the intro was last rewritten". Doc-scoped (current document only). Returns most-recent-first; each row carries action, author, ISO timestamp, and a brief summary. Cheap (DB query, no LLM sub-call). Don\'t use for current-state lookups, call view_document / read_comments for that.')

/**
 * Render an `ActivityEntry` row into a single human-/model-readable line.
 * Format: `[#id YYYY-MM-DDTHH:MM:SSZ action by Author] summary`. The
 * `id` is exposed so the model can chain into `replay`/`/restore`/diff
 * endpoints downstream if it needs to (those still go through their
 * own auth-checked HTTP routes, the AI doesn't get a direct restore
 * tool yet).
 *
 * Compaction rules per action:
 *   - edit: lines ±, word count
 *   - comment.*: short body preview
 *   - title.changed: from → to
 *   - ai.tool: the per-tool key (query / url / prompt / src / id)
 *   - restore: anchor activity id + frozen timestamp
 *   - join / leave / theme.changed: just the action label
 *
 * Exported for unit testing, every action branch + metadata shape
 * has rendering quirks and is the kind of code that silently
 * regresses without per-branch coverage.
 */
export function formatActivityRow(row: ActivityEntry): string {
  const ts = row.createdAt.toISOString()
  const who = row.userName ?? '(anonymous)'
  const head = `[#${row.id} ${ts} ${row.action} by ${who}]`
  return `${head} ${ACTIVITY_SUMMARIES[row.action](row)}`
}

// Rows can predate the current metadata shapes, so every field read
// tolerates a missing value (the line still renders).
function trim(s: string | undefined, n: number): string {
  return typeof s === 'string' ? s.slice(0, n) : ''
}

function editSummary(row: ActivityEntry): string {
  const parts: string[] = []
  if (typeof row.linesAdded === 'number' || typeof row.linesRemoved === 'number') {
    parts.push(`+${row.linesAdded ?? 0}/-${row.linesRemoved ?? 0} lines`)
  }
  if (typeof row.wordCount === 'number') parts.push(`${row.wordCount} words`)
  return parts.join(', ') || 'edit'
}

function commentSummary({ metadata: m }: ActivityEntry): string {
  const c = m && 'commentId' in m ? m : null
  const preview = trim(c?.bodyPreview, 120)
  const id = trim(c?.commentId, 32)
  const idPart = id ? `comment_id=${id} ` : ''
  return `${idPart}body≈"${preview}"`
}

function titleSummary({ metadata: m }: ActivityEntry): string {
  const t = m?.kind === 'title.changed' ? m : null
  return `from "${trim(t?.from, 80)}" → "${trim(t?.to, 80)}"`
}

function restoreSummary({ metadata: m }: ActivityEntry): string {
  const r = m?.kind === 'restore' ? m : null
  const fromId = typeof r?.restoredFromActivityId === 'number' ? r.restoredFromActivityId : null
  const fromTime = trim(r?.restoredFromTime, 32)
  const tail = fromTime ? ` (${fromTime})` : ''
  return `restored to row #${fromId ?? '?'}${tail}`
}

/** The part of an activity line after its `[#id time action by author]` head, per action. */
const ACTIVITY_SUMMARIES: Readonly<Record<ActivityEntry['action'], (row: ActivityEntry) => string>> = {
  'edit': editSummary,
  'comment.added': commentSummary,
  'comment.replied': commentSummary,
  'comment.resolved': commentSummary,
  'comment.reopened': commentSummary,
  'comment.deleted': commentSummary,
  'title.changed': titleSummary,
  'theme.changed': () => 'theme updated',
  'ai.tool': ({ metadata: m }) => formatAiToolMetadata(m?.kind === 'ai.tool' ? m : null),
  'restore': restoreSummary,
  'ai.job': ({ metadata: m }) => (m?.kind === 'ai.job'
    ? `AI job ${m.jobId} (${m.mode}) ${m.phase}: ${m.done}/${m.unitsTotal} done, ${m.skipped} skipped, ${m.flagged} flagged`
    : 'AI job'),
  'ai.job.reverted': ({ metadata: m }) => (m?.kind === 'ai.job.reverted'
    ? `AI job ${m.jobId} undone: ${m.reverted} parts restored, ${m.skipped} kept`
    : 'AI job undone'),
  'join': row => row.action,
  'leave': row => row.action
}

function formatAiToolMetadata(m: AiToolActivityMetadata | null): string {
  const toolName: string | undefined = m?.tool
  switch (m?.tool) {
    case 'web_search':
      return `web_search query="${trim(m.query, 120)}"`
    case 'fetch_url':
      return `fetch_url url="${trim(m.url, 200)}"`
    case 'generate_image':
      return `generate_image prompt="${trim(m.prompt, 120)}"`
    case 'view_image':
      return `view_image src="${trim(m.src, 200)}"`
    case 'search_knowledge':
      return `search_knowledge query="${trim(m.query, 120)}"`
    case 'get_knowledge_file':
      return `get_knowledge_file knowledge_id=${trim(m.knowledgeId, 64)}`
    case 'replace_all':
      return `replace_all ${m.count}x "${trim(m.query, 80)}" -> "${trim(m.replacement, 80)}"`
    case undefined:
    default:
      // No metadata, or a tool written by newer code than this formatter:
      // show its bare name.
      return `ai.tool ${trim(toolName, 40)}`
  }
}

/** The answer when nothing matched, naming the filters that were applied. */
function noMatchMessage(input: z.output<typeof SearchActivityLogArgs>, since: Date | undefined, before: Date | undefined): string {
  const filterDesc: string[] = []
  if (input.query) filterDesc.push(`query="${input.query}"`)
  if (input.actions?.length) filterDesc.push(`actions=[${input.actions.join(',')}]`)
  if (since) filterDesc.push(`since=${since.toISOString()}`)
  if (before) filterDesc.push(`before=${before.toISOString()}`)
  return `No activity rows matched. Filters: ${filterDesc.join(', ') || '(none)'}.`
}

async function handleSearchActivityLog(
  session: MetaToolContext,
  input: z.output<typeof SearchActivityLogArgs>
): Promise<ToolResult> {
  // Parse + validate the optional ISO timestamps. Zod's `.datetime()`
  // already accepts only RFC 3339 / ISO 8601, we still wrap in `new
  // Date` and check `isFinite` to reject anything pathological that
  // sneaks past the schema (e.g. year 0000).
  const parseTime = (s: string | undefined): Date | undefined => {
    if (!s) return undefined
    const d = new Date(s)
    if (!Number.isFinite(d.getTime())) return undefined
    return d
  }
  // The document's plan may limit how far back history goes
  // (`historyDays`); never search past that window.
  const cutoff = historyCutoff(await resolveDocPlan(session.docId))
  const requestedSince = parseTime(input.since)
  const since = cutoff && (!requestedSince || requestedSince < cutoff) ? cutoff : requestedSince
  const before = parseTime(input.before)

  if (!session.docAccess) return toolError('Error: search_activity_log needs a document.')
  let rows: ActivityEntry[]
  try {
    rows = await searchActivity(session.docAccess, {
      query: input.query,
      actions: input.actions,
      since,
      before,
      limit: input.limit ?? 20
    })
  } catch (e) {
    return toolError(`Error: search_activity_log failed: ${e instanceof Error ? e.message : 'unknown'}`)
  }

  if (rows.length === 0) return toolOk(noMatchMessage(input, since, before))

  // Returned in DESC-by-time order from the repo. Render preserves that
  // order so the model reads newest first, usually what it wants when
  // answering "the most recent / last X" style questions. The model can
  // re-issue with a tighter window if the first hit isn't the right one.
  const lines = rows.map(formatActivityRow)
  return toolOk(`Found ${rows.length} activity row${rows.length === 1 ? '' : 's'} (most recent first):\n${lines.join('\n')}`)
}

export const searchActivityLogTool = defineMetaTool({
  name: 'search_activity_log',
  description: 'Search the document\'s activity log, every edit, comment, theme/title change, AI tool call, and restore across ALL users and ALL prior sessions, not just the current conversation. Use when the user references something OUTSIDE the in-prompt `<conversation_history>` window: "what did you base that table on yesterday", "revert the changes from last week", "when did we last rewrite the intro", "did anyone change the title". Doc-scoped to the current document. Returns most-recent-first with author, ISO timestamp, and a one-line summary per row. Pure read; no LLM sub-call.',
  schema: SearchActivityLogArgs,
  // Pure-DB tool, but bounded so the model can't loop on "search again
  // with slightly different filters". 8 covers its use cases (recall a
  // past edit, audit a restore, find the ai.tool rows behind a claim).
  sessionCallCap: 8,
  handler: handleSearchActivityLog
})
