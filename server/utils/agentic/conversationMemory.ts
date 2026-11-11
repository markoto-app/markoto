import type { AiMessageRow } from '../../repos/aiSessionMessages'
import { HOUR_MS } from '~~/shared/config/units'

// Conversation memory: compaction + prompt-block construction.
//
// The AI needs to remember WHAT happened in past turns ("you built a
// complex table", "the user asked you to translate the intro") so phrases
// like "now put it on the first page" resolve correctly. It does not need
// the full payloads of past tool results (fetched chunks, viewed document
// slices, base64 image bytes); they are reproducible by re-issuing the
// call.
//
// So compaction keeps three things and drops the rest:
//
//   1. user_prompt   — every word the user typed (small, conversational glue)
//   2. message_to_user — what the AI said back (the user-visible reply
//                        surface; preserves "you said X earlier")
//   3. tool_call     — name + a SHORT arg summary, NOT the result
//                        ("[generate_image: a portrait of …]")
//
// Tool RESULT payloads are never recorded in the first place (see
// `aiSessionMessages.ts`). The fact-of-the-call IS the memory.
//
// The block is wrapped as `<conversation_history>...</conversation_history>`
// and prepended to the system prompt. The system prompt teaches the
// model to read it for context but not to repeat its content back.

// Idle-gap rotation: a 60-minute silence resets the conversation. Older
// rows stay in the DB (the activity log is the long-term memory tier),
// they just don't load into the prompt context anymore.
//
// 60 min separates "same writing session" from "different working
// session". Shorter would split a natural pause-to-think; longer would let
// yesterday's context bleed into today's prompt.
export const CONVERSATION_IDLE_GAP_MS = HOUR_MS

// Hard ceiling on historical rows in the prompt block. At ~12 tokens per
// compacted row, 40 rows ≈ 480 tokens, small enough to keep the prefix
// cache friendly across follow-up prompts. Older rows are truncated; the
// model sees a "(N earlier turns omitted)" sentinel.
export const CONVERSATION_MAX_ROWS = 40

// Read-only tools the model calls every turn; recording them would bloat
// the history block without aiding context resolution. Mirrors the skip
// set in runLoop's `logAiTool`.
const MEMORY_SKIP_TOOLS: ReadonlySet<string> = new Set([
  'view_document',
  'read_comments',
  'get_theme',
  'list_themes',
  'list_workspace_documents',
  'get_page_count',
  // Recording the memory query tool would make the history contain its own
  // lookups.
  'search_activity_log'
])

// Non-recorded calls still execute; they just don't appear in the next
// prompt's `<conversation_history>` block.
export function shouldRecordToolInMemory(name: string): boolean {
  return !MEMORY_SKIP_TOOLS.has(name)
}

/**
 * Short arg summary for the memory row's body: the one field that conveys
 * what the call did, capped tight. Unknown tools fall back to
 * "args=<keys>" so a trace remains.
 */
export function summarizeToolCall(name: string, args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const a = args as Record<string, unknown>
  const trim = (s: unknown, n = 80) => (typeof s === 'string' ? s.slice(0, n) : '')
  const numOrQ = (v: unknown): string => typeof v === 'number' ? String(v) : '?'

  switch (name) {
    case 'replace_text':
      return `old≈"${trim(a.old_str, 60)}"`
    case 'insert_text':
      return `at_line=${numOrQ(a.insert_line)} text≈"${trim(a.insert_text, 60)}"`
    case 'set_title':
      return `title="${trim(a.title, 80)}"`
    case 'web_search':
      return `query="${trim(a.query, 100)}"`
    case 'fetch_url':
      return `url="${trim(a.url, 120)}"`
    case 'view_image':
      return `src="${trim(a.src, 120)}"`
    case 'generate_image':
      return `prompt="${trim(a.prompt, 100)}"`
    case 'view_pages':
      return `pages=${Array.isArray(a.pages) ? JSON.stringify(a.pages.slice(0, 5)) : '?'}`
    case 'search_knowledge':
      return `query="${trim(a.query, 100)}"`
    case 'get_knowledge_file':
      return `knowledge_id=${trim(a.knowledge_id, 64)}`
    case 'view_other_document':
      return `doc=${trim(a.doc_id, 80)}`
    case 'update_theme':
      // Theme patches are too varied to summarise; "preset=X" is the most
      // informative single fact, else just the touched keys.
      if (typeof a.preset === 'string') return `preset=${a.preset}`
      if (a.theme_id) return `theme_id=${trim(a.theme_id, 32)}`
      if (a.from_workspace_default) return 'from_workspace_default=true'
      return `fields=${Object.keys(a).slice(0, 5).join(',')}`
    case 'save_theme_as_preset':
      return `name="${trim(a.name, 60)}"`
    case 'create_comment':
      return `lines=${numOrQ(a.start_line)}-${numOrQ(a.end_line)} body≈"${trim(a.body, 60)}"`
    case 'reply_to_comment':
      return `comment_id=${trim(a.comment_id, 32)} body≈"${trim(a.body, 60)}"`
    case 'resolve_comment':
      return `comment_id=${trim(a.comment_id, 32)} resolved=${a.resolved}`
    case 'delete_comment': {
      const replyPart = a.reply_id ? ` reply_id=${trim(a.reply_id, 32)}` : ''
      return `comment_id=${trim(a.comment_id, 32)}${replyPart}`
    }
    default:
      return `args=${Object.keys(a).slice(0, 5).join(',')}`
  }
}

// One line per row: leading dash + bracketed kind + content.
function renderRow(row: AiMessageRow): string {
  const body = row.body as Record<string, unknown> | null
  switch (row.kind) {
    case 'user_prompt': {
      const text = typeof body?.text === 'string' ? body.text : ''
      // Anything over 800 chars is a doc paste, not a conversational turn;
      // the user meant it for the document, not as memory.
      const trimmed = text.length > 800 ? text.slice(0, 800) + '…' : text
      return `- user: ${trimmed}`
    }
    case 'message_to_user': {
      const message = typeof body?.message === 'string' ? body.message : ''
      const isQuestion = body?.isQuestion === true
      const tag = isQuestion ? 'AI asked' : 'AI replied'
      return `- ${tag}: ${message}`
    }
    case 'tool_call': {
      const name = typeof body?.name === 'string' ? body.name : '<unknown>'
      const summary = typeof body?.summary === 'string' ? body.summary : ''
      return summary ? `- AI used ${name} (${summary})` : `- AI used ${name}`
    }
    default:
      return ''
  }
}

/**
 * Build the `<conversation_history>` system-prompt block from the
 * compacted memory rows. Returns the empty string when there is nothing
 * to show (the prompt builder concatenates raw).
 *
 * Beyond `CONVERSATION_MAX_ROWS` the most recent rows are kept and a
 * sentinel tells the model older context exists but isn't loaded, its
 * cue to use `search_activity_log` when the user references something
 * further back.
 */
export function buildConversationHistoryBlock(rows: AiMessageRow[]): string {
  if (rows.length === 0) return ''

  let kept = rows
  let omittedCount = 0
  if (rows.length > CONVERSATION_MAX_ROWS) {
    omittedCount = rows.length - CONVERSATION_MAX_ROWS
    kept = rows.slice(rows.length - CONVERSATION_MAX_ROWS)
  }

  const lines: string[] = []
  lines.push(
    '<conversation_history>',
    'Prior turns from your conversation with THIS user on THIS document, oldest first. Use this for context resolution ("now put it on the first page" → "it" = whatever you just built). DO NOT repeat their content back in your reply — just refer to it. If the user asks about something you did but you cannot find it here, say so plainly via message_to_user; do not fabricate a memory.',
    ''
  )

  if (omittedCount > 0) {
    lines.push(`(${omittedCount} earlier turn${omittedCount === 1 ? '' : 's'} omitted — older context is in the document activity log; ask the user if they need you to recall further back than what is shown here)`)
  }

  for (const row of kept) {
    const line = renderRow(row)
    if (line) lines.push(line)
  }

  lines.push('</conversation_history>', '')
  return lines.join('\n')
}

/**
 * Load the prompt-relevant slice of memory and render it.
 *
 * Idle-gap rule: if the most recent row is older than
 * `CONVERSATION_IDLE_GAP_MS`, the new prompt starts a fresh conversation
 * and the block is empty. Stale context bleeding in is worse than
 * missing context (the user would feel surveilled rather than
 * remembered).
 *
 * Returns the block + the cutoff Date used (for logging / diagnostics).
 */
export async function buildConversationContextForPrompt(
  loadFn: (since: Date | undefined) => Promise<AiMessageRow[]>,
  lastActivity: Date | null,
  now: Date = new Date()
): Promise<{ block: string, since: Date | null, idleReset: boolean }> {
  if (lastActivity && now.getTime() - lastActivity.getTime() > CONVERSATION_IDLE_GAP_MS) {
    return { block: '', since: null, idleReset: true }
  }

  // Window the read to the idle gap so a doc with hundreds of stale rows
  // doesn't read them all (the repo also caps at CONVERSATION_MAX_ROWS).
  const since = new Date(now.getTime() - CONVERSATION_IDLE_GAP_MS)
  const rows = await loadFn(since)
  return {
    block: buildConversationHistoryBlock(rows),
    since,
    idleReset: false
  }
}
