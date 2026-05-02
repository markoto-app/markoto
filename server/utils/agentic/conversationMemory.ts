import type { AiMessageRow } from '../../repos/aiSessionMessages'

// ---------------------------------------------------------------------------
// Conversation memory — compaction + prompt-block construction
// ---------------------------------------------------------------------------
//
// The bet behind this file: the AI needs to remember WHAT happened in
// past turns ("you built a complex table", "the user asked you to
// translate the intro") so phrases like "now put it on the first page"
// resolve correctly. It does NOT need to re-see the FULL PAYLOADS of
// past tool results (the actual fetched chunks, the entire viewed
// document slice, the base64 image bytes). Those are reproducible —
// the model can re-issue the call if it wants the data back.
//
// So compaction keeps three things verbatim and drops the rest:
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
// rows stay in the DB (the activity log is the long-term memory tier
// and a future `search_activity_log` tool will let the model pull them
// up explicitly), they just don't load into the prompt context anymore.
//
// Picked 60 min as the breakpoint between "same coffee", "same writing
// session" and "different working session". Shorter would split a
// natural pause-to-think; longer would let yesterday's context bleed
// into today's prompt. Tunable per-deployment if it shakes out wrong.
export const CONVERSATION_IDLE_GAP_MS = 60 * 60 * 1000

// Hard ceiling on how many historical rows the prompt block will hold.
// At ~50 chars/row average compacted form (~12 tokens), 40 rows ≈ 480
// tokens — bounded enough to keep the prefix cache friendly across
// follow-up prompts. Older rows are silently truncated; the model
// sees a "(N earlier turns omitted)" sentinel so it knows the window
// is incomplete.
export const CONVERSATION_MAX_ROWS = 40

// Tools that are pure noise from a memory perspective. The model calls
// these every turn just to read the world; recording them would bloat
// the history block without aiding context resolution. Mirrors the
// skip set in runLoop's `logAiTool` for the same reason.
const MEMORY_SKIP_TOOLS: ReadonlySet<string> = new Set([
  'view_document',
  'read_comments',
  'get_theme',
  'list_themes',
  'list_workspace_documents',
  'get_page_count',
  // Long-term memory query tool — recording it would create a
  // cycle ("you asked about your past, now your past contains the
  // asking") that bloats the history block without aiding context.
  'search_activity_log'
])

/**
 * True when this tool is worth recording in conversation memory.
 * Non-recorded calls still execute normally — they just don't appear
 * in the next prompt's `<conversation_history>` block.
 */
export function shouldRecordToolInMemory(name: string): boolean {
  return !MEMORY_SKIP_TOOLS.has(name)
}

/**
 * Build the short arg summary that lands in the memory row's body.
 * Per-tool: pick the ONE field that conveys what the call did + cap it
 * tight. The model needs "you called X for Y", not the full JSON.
 *
 * Unknown tools fall back to "args=<keys>" so we still leave a trace.
 */
export function summarizeToolCall(name: string, args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const a = args as Record<string, unknown>
  const trim = (s: unknown, n = 80) => (typeof s === 'string' ? s.slice(0, n) : '')

  switch (name) {
    case 'replace_text':
      return `old≈"${trim(a.old_str, 60)}"`
    case 'insert_text':
      return `at_line=${a.insert_line ?? '?'} text≈"${trim(a.insert_text, 60)}"`
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
      // Theme patches are too varied to summarise meaningfully — just
      // record which top-level surfaces were touched. "preset=X" is
      // the most informative single fact.
      if (typeof a.preset === 'string') return `preset=${a.preset}`
      if (a.theme_id) return `theme_id=${trim(a.theme_id, 32)}`
      if (a.from_workspace_default) return 'from_workspace_default=true'
      return `fields=${Object.keys(a).slice(0, 5).join(',')}`
    case 'save_theme_as_preset':
      return `name="${trim(a.name, 60)}"`
    case 'create_comment':
      return `lines=${a.start_line ?? '?'}-${a.end_line ?? '?'} body≈"${trim(a.body, 60)}"`
    case 'reply_to_comment':
      return `comment_id=${trim(a.comment_id, 32)} body≈"${trim(a.body, 60)}"`
    case 'resolve_comment':
      return `comment_id=${trim(a.comment_id, 32)} resolved=${a.resolved}`
    case 'delete_comment':
      return `comment_id=${trim(a.comment_id, 32)}${a.reply_id ? ` reply_id=${trim(a.reply_id, 32)}` : ''}`
    default:
      return `args=${Object.keys(a).slice(0, 5).join(',')}`
  }
}

/**
 * Render a single memory row into one line of the history block.
 * Format chosen for token efficiency + model readability — leading
 * dash + bracketed kind + content.
 */
function renderRow(row: AiMessageRow): string {
  const body = row.body as Record<string, unknown> | null
  switch (row.kind) {
    case 'user_prompt': {
      const text = typeof body?.text === 'string' ? body.text : ''
      // Cap at 800 chars — anything longer is already a doc paste, not
      // a conversational turn, and the user's intent was to land it
      // INTO the doc rather than re-surface it as memory.
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
 * compacted memory rows. Returns the empty string when there's nothing
 * to show — the prompt builder concatenates raw, so absence means the
 * block doesn't render at all.
 *
 * Truncation behaviour: if there are more than `CONVERSATION_MAX_ROWS`,
 * we keep the most recent and prepend a sentinel telling the model
 * older context exists but isn't loaded — that's the cue for it to
 * reach for the (future) `search_activity_log` tool when the user
 * references something further back.
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
  lines.push('<conversation_history>')
  lines.push('Prior turns from your conversation with THIS user on THIS document, oldest first. Use this for context resolution ("now put it on the first page" → "it" = whatever you just built). DO NOT repeat their content back in your reply — just refer to it. If the user asks about something you did but you cannot find it here, say so plainly via message_to_user; do not fabricate a memory.')
  lines.push('')

  if (omittedCount > 0) {
    lines.push(`(${omittedCount} earlier turn${omittedCount === 1 ? '' : 's'} omitted — older context is in the document activity log; ask the user if they need you to recall further back than what is shown here)`)
  }

  for (const row of kept) {
    const line = renderRow(row)
    if (line) lines.push(line)
  }

  lines.push('</conversation_history>')
  lines.push('')
  return lines.join('\n')
}

/**
 * Convenience: load the prompt-relevant slice of memory + render it
 * directly. The endpoint just calls this with `(docId, userId)` and
 * gets the block ready to prepend.
 *
 * Idle-gap rule: if the most recent row is older than
 * `CONVERSATION_IDLE_GAP_MS`, we treat the new prompt as the start of
 * a fresh conversation and return an empty block. Long pauses signal
 * "different working session" and stale context bleeding in is worse
 * than missing context (the user would feel surveilled rather than
 * remembered).
 *
 * Returns the block + the cutoff Date used (for logging / diagnostics).
 */
export async function buildConversationContextForPrompt(
  loadFn: (since: Date | undefined) => Promise<AiMessageRow[]>,
  lastActivity: Date | null,
  now: Date = new Date()
): Promise<{ block: string, since: Date | null, idleReset: boolean }> {
  // Idle reset: if the last row is past the gap, do not load anything.
  if (lastActivity && now.getTime() - lastActivity.getTime() > CONVERSATION_IDLE_GAP_MS) {
    return { block: '', since: null, idleReset: true }
  }

  // Window the read to the idle gap so a once-active doc with
  // hundreds of stale rows doesn't pay the cost of reading them all.
  // The repo also caps at CONVERSATION_MAX_ROWS regardless.
  const since = new Date(now.getTime() - CONVERSATION_IDLE_GAP_MS)
  const rows = await loadFn(since)
  return {
    block: buildConversationHistoryBlock(rows),
    since,
    idleReset: false
  }
}
