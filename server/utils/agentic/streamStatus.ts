import type { AgenticFunctionCall as FunctionCall } from './aiTypes'

/**
 * Turns provider stream chunks + emitted function calls into live status
 * strings shown to clients via Y.js awareness. Kept separate from the
 * loop so `describeToolInput` is a pure function, easy to test with
 * fixtures, and the main loop can focus on SDK mechanics.
 *
 * Granularity note: Mistral's streaming surfaces a function call's args
 * progressively across `tool_calls[].function.arguments` chunks; the
 * translator in `messageTranslation.ts` accumulates them and yields one
 * synthesised internal-shape chunk with the complete call on stream
 * end. So we still announce one status per tool call rather than
 * per-character streaming: acceptable: users perceive tool-call-level
 * granularity, not token-level.
 */

export type StreamStatusPhase = 'thinking' | 'tool' | 'editing' | 'done' | 'error'

export interface StreamStatusOptions {
  setStatus: (phase: StreamStatusPhase, message?: string) => void
  /** Optional logger for observability. Defaults to no-op. */
  logger?: (msg: string) => void
}

/**
 * Stateful accumulator. One per agentic turn. Dedupes repeated status strings
 * across chunks (the provider can re-emit a function_call in multiple chunks
 * as the args fill in); we only announce on *new* call identities.
 */
export interface StreamState {
  /** Set of `${name}:${stringified-args}` we've already announced this turn. */
  announced: Set<string>
}

export function newStreamState(): StreamState {
  return { announced: new Set() }
}

/**
 * Process one stream chunk. For every function call visible in the chunk,
 * decide whether to update the awareness status.
 *
 * Text parts are ignored for status, they land in the final response but
 * we don't announce "speaking" for them.
 */
export function processChunk(
  chunk: { functionCalls?: FunctionCall[], text?: string },
  state: StreamState,
  opts: StreamStatusOptions
): void {
  const calls = chunk.functionCalls
  if (!calls?.length) return

  for (const call of calls) {
    if (!call.name) continue
    // Identity = name + args fingerprint. Prevents re-announcing on chunks
    // that simply repeat the same complete call.
    const args = (call.args ?? {}) as Record<string, unknown>
    const key = `${call.name}:${JSON.stringify(args)}`
    if (state.announced.has(key)) continue
    state.announced.add(key)

    const msg = describeToolInput(call.name, args)
    if (msg) opts.setStatus('tool', msg)
  }
}

// Per-tool formatter helpers. Each formatter takes the validated args (typed `Record<string, unknown>`
// so unknown shapes are handled defensively) and returns a status string
// or null. Splitting one-per-tool keeps `describeToolInput` flat (a map
// lookup) and pushes per-shape extraction logic into 1-3 line helpers.

/** Coerce + trim a possibly-missing string field. Returns '' on miss. */
function strField(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** Truncate a label with an ellipsis when it exceeds `max` chars. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Common shape: extract a string field, fall back to a generic message
 * when absent, otherwise render the template with a truncated preview.
 */
function fieldStatus(
  args: Record<string, unknown>,
  field: string,
  fallback: string,
  template: (preview: string) => string,
  max: number
): string {
  const value = strField(args, field)
  if (!value) return fallback
  return template(truncate(value, max))
}

function describeWebSearch(args: Record<string, unknown>): string {
  const q = strField(args, 'query')
  return q ? `Searching the web for "${q}"` : 'Searching the web…'
}

function describeReplaceText(args: Record<string, unknown>): string {
  const oldStr = typeof args.old_str === 'string' ? args.old_str : ''
  if (!oldStr) return 'Editing the document…'
  const preview = oldStr.slice(0, 40).replace(/\s+/g, ' ').trim()
  // Ellipsis is keyed on the ORIGINAL length, `preview` is always
  // ≤40 after the slice, so checking its length post-slice would never
  // signal truncation.
  return `Editing "${preview}${oldStr.length > 40 ? '…' : ''}"`
}

function describeUpdateTheme(args: Record<string, unknown>): string {
  // Prefer surfacing a NAMED base source over the field-section count,
  // it's what the user typed ("apply my Brand red") and reads like a
  // status not a diagnostic.
  if (typeof args.preset === 'string') return `Applying preset "${args.preset}"…`
  if (typeof args.theme_id === 'string') return 'Applying a saved theme…'
  if (args.from_workspace_default === true) return 'Applying workspace default theme…'
  const sections = Object.entries(args)
    .filter(([, v]) => v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k)
  if (sections.length === 0) return 'Updating theme…'
  if (sections.length <= 2) return `Updating theme (${sections.join(', ')})…`
  return `Updating theme (${sections.length} sections)…`
}

function describeViewOtherDocument(args: Record<string, unknown>): string {
  const raw = strField(args, 'doc_id')
  if (!raw) return 'Reading another document…'
  // Mirror the parser: extract `/d/<id>` shape if present, else treat
  // as a bare id. We don't import the parser here to keep streamStatus
  // dependency-free; the regex is simple enough.
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)/.exec(raw)
  const id = urlMatch?.[1] ?? raw
  return `Reading document ${truncate(id, 24)}`
}

function describeViewImage(args: Record<string, unknown>): string {
  const src = typeof args.src === 'string' ? args.src : ''
  if (!src) return 'Looking at an image…'
  const leaf = src.split('/').pop() || src
  return `Looking at "${truncate(leaf, 40)}"`
}

function describeFetchUrl(args: Record<string, unknown>): string {
  const url = strField(args, 'url')
  if (!url) return 'Fetching URL…'
  // Strip scheme + trailing slash for a tidier display.
  const display = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return `Fetching ${truncate(display, 50)}`
}

function describeReplyToComment(args: Record<string, unknown>): string {
  const id = typeof args.comment_id === 'string' ? args.comment_id : ''
  return id ? `Replying to comment ${id}…` : 'Replying to a comment…'
}

function describeResolveComment(args: Record<string, unknown>): string {
  return args.resolved === true ? 'Resolving a comment…' : 'Reopening a comment…'
}

/**
 * Tool-name → formatter registry. The few cases that don't fit the
 * shared `fieldStatus` shape (update_theme, replace_text, view_other_document,
 * view_image, fetch_url, reply_to_comment, resolve_comment) get bespoke
 * helpers above; everything else is one line of registry data.
 *
 * Static-string tools without args go straight in via a returns-constant
 * arrow.
 */
const FORMATTERS: Record<string, (args: Record<string, unknown>) => string | null> = {
  web_search: describeWebSearch,
  view_document: () => 'Reading the document…',
  replace_text: describeReplaceText,
  insert_text: () => 'Inserting text…',
  update_theme: describeUpdateTheme,
  get_theme: () => 'Reading current theme…',
  list_themes: () => 'Listing your saved themes…',
  save_theme_as_preset: a => fieldStatus(a, 'name', 'Saving theme as preset…', p => `Saving theme as "${p}"`, 40),
  list_workspace_documents: () => 'Browsing workspace documents…',
  view_other_document: describeViewOtherDocument,
  set_title: a => fieldStatus(a, 'title', 'Updating title…', p => `Setting title to "${p}"`, 40),
  view_image: describeViewImage,
  generate_image: a => fieldStatus(a, 'prompt', 'Generating image…', p => `Generating image: "${p}"`, 50),
  fetch_url: describeFetchUrl,
  search_knowledge: a => fieldStatus(a, 'query', 'Searching workspace knowledge…', p => `Searching workspace knowledge for "${p}"`, 60),
  get_knowledge_file: a => fieldStatus(a, 'knowledge_id', 'Opening a workspace knowledge file…', p => `Opening workspace knowledge file ${p}`, 64),
  read_comments: () => 'Reading document comments…',
  create_comment: () => 'Adding a comment…',
  reply_to_comment: describeReplyToComment,
  resolve_comment: describeResolveComment,
  delete_comment: () => 'Deleting a comment…'
}

/**
 * Pure derivation: tool name + args → user-facing status string.
 * Exported so it can be unit-tested.
 *
 * Returns null if the tool isn't recognised, callers should leave the
 * previous status in place rather than flash something generic
 * (a generic status would only flash and then be replaced).
 */
export function describeToolInput(name: string, args: Record<string, unknown>): string | null {
  const formatter = FORMATTERS[name]
  return formatter ? formatter(args) : null
}
