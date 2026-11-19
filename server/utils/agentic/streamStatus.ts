import type { AgenticFunctionCall as FunctionCall } from './aiTypes'
import { aiStatus, type AiStatusInput, type AiStatusLine, type AiStatusStepKey } from '~~/shared/ai/statusSteps'

/**
 * Turns provider stream chunks + emitted function calls into live status
 * lines for the initiator (session channel): a step code the client
 * renders in the UI language, plus its English text. Kept separate from the
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
  setStatus: (phase: StreamStatusPhase, status?: AiStatusInput) => void
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

    const line = describeToolInput(call.name, args)
    if (line) opts.setStatus('tool', line)
  }
}

// Per-tool formatter helpers. Each formatter takes the validated args (typed `Record<string, unknown>`
// so unknown shapes are handled defensively) and returns a status line
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
 * Common shape: extract a string field, fall back to a generic step
 * when absent, otherwise the named step with a truncated preview.
 */
function fieldStatus(
  args: Record<string, unknown>,
  field: string,
  fallback: AiStatusStepKey,
  step: AiStatusStepKey,
  param: string,
  max: number
): AiStatusLine {
  const value = strField(args, field)
  if (!value) return aiStatus(fallback)
  return aiStatus(step, { [param]: truncate(value, max) })
}

function describeWebSearch(args: Record<string, unknown>): AiStatusLine {
  const q = strField(args, 'query')
  return q ? aiStatus('webSearch', { query: q }) : aiStatus('webSearchAny')
}

function describeReplaceText(args: Record<string, unknown>): AiStatusLine {
  const oldStr = typeof args.old_str === 'string' ? args.old_str : ''
  if (!oldStr) return aiStatus('editDocument')
  const preview = oldStr.slice(0, 40).replace(/\s+/g, ' ').trim()
  // Ellipsis is keyed on the ORIGINAL length, `preview` is always
  // ≤40 after the slice, so checking its length post-slice would never
  // signal truncation.
  return aiStatus('editPassage', { passage: `${preview}${oldStr.length > 40 ? '…' : ''}` })
}

function describeUpdateTheme(args: Record<string, unknown>): AiStatusLine {
  // Prefer surfacing a NAMED base source over the field-section count,
  // it's what the user typed ("apply my Brand red") and reads like a
  // status not a diagnostic.
  if (typeof args.preset === 'string') return aiStatus('applyPreset', { preset: args.preset })
  if (typeof args.theme_id === 'string') return aiStatus('applySavedTheme')
  if (args.from_workspace_default === true) return aiStatus('applyWorkspaceTheme')
  const sections = Object.entries(args)
    .filter(([, v]) => v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k)
  if (sections.length === 0) return aiStatus('updateTheme')
  if (sections.length <= 2) return aiStatus('updateThemeSections', { sections: sections.join(', ') })
  return aiStatus('updateThemeCount', { count: String(sections.length) })
}

function describeViewOtherDocument(args: Record<string, unknown>): AiStatusLine {
  const raw = strField(args, 'doc_id')
  if (!raw) return aiStatus('readOtherDocumentAny')
  // Mirror the parser: extract `/d/<id>` shape if present, else treat
  // as a bare id. We don't import the parser here to keep streamStatus
  // dependency-free; the regex is simple enough.
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)/.exec(raw)
  const id = urlMatch?.[1] ?? raw
  return aiStatus('readOtherDocument', { id: truncate(id, 24) })
}

function describeViewImage(args: Record<string, unknown>): AiStatusLine {
  const src = typeof args.src === 'string' ? args.src : ''
  if (!src) return aiStatus('viewImageAny')
  const leaf = src.split('/').pop() || src
  return aiStatus('viewImage', { name: truncate(leaf, 40) })
}

function describeFetchUrl(args: Record<string, unknown>): AiStatusLine {
  const url = strField(args, 'url')
  if (!url) return aiStatus('fetchUrlAny')
  // Strip scheme + trailing slash for a tidier display.
  const display = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return aiStatus('fetchUrl', { url: truncate(display, 50) })
}

function describeReplyToComment(args: Record<string, unknown>): AiStatusLine {
  const id = typeof args.comment_id === 'string' ? args.comment_id : ''
  return id ? aiStatus('replyComment', { id }) : aiStatus('replyCommentAny')
}

function describeResolveComment(args: Record<string, unknown>): AiStatusLine {
  return aiStatus(args.resolved === true ? 'resolveComment' : 'reopenComment')
}

function describeDelegateRewrite(args: Record<string, unknown>): AiStatusLine {
  switch (args.action) {
    case 'start':
    case 'resume':
    case 'rerun':
      return aiStatus('startJob')
    case 'status':
    case 'cancel':
      return aiStatus('jobStatus')
    default:
      return aiStatus('previewJob')
  }
}

/**
 * Tool-name → formatter registry. The few cases that don't fit the
 * shared `fieldStatus` shape (update_theme, replace_text, view_other_document,
 * view_image, fetch_url, reply_to_comment, resolve_comment) get bespoke
 * helpers above; everything else is one line of registry data.
 *
 * Static steps without args go straight in via a returns-constant
 * arrow.
 */
const FORMATTERS: Record<string, (args: Record<string, unknown>) => AiStatusLine | null> = {
  web_search: describeWebSearch,
  view_document: () => aiStatus('readDocument'),
  outline: () => aiStatus('readDocument'),
  read_section: () => aiStatus('readDocument'),
  search_document: () => aiStatus('readDocument'),
  replace_text: describeReplaceText,
  insert_text: () => aiStatus('insertText'),
  replace_section: () => aiStatus('editDocument'),
  insert_markdown: () => aiStatus('insertText'),
  move_section: () => aiStatus('editDocument'),
  swap_sections: () => aiStatus('editDocument'),
  delete_section: () => aiStatus('editDocument'),
  set_heading: () => aiStatus('editDocument'),
  renumber_headings: a => (a.preview === true ? aiStatus('readDocument') : aiStatus('editDocument')),
  replace_all: a => (a.preview === false ? fieldStatus(a, 'query', 'editDocument', 'editPassage', 'passage', 40) : aiStatus('readDocument')),
  edit_lines: () => aiStatus('editDocument'),
  list_references: () => aiStatus('readReferences'),
  add_reference_by_doi: a => fieldStatus(a, 'doi', 'addReferenceAny', 'addReference', 'doi', 60),
  check_citations: () => aiStatus('checkCitations'),
  load_skill: () => aiStatus('thinking'),
  update_theme: describeUpdateTheme,
  get_theme: () => aiStatus('readTheme'),
  list_themes: () => aiStatus('listThemes'),
  save_theme_as_preset: a => fieldStatus(a, 'name', 'saveThemeAny', 'saveTheme', 'name', 40),
  list_workspace_documents: () => aiStatus('listWorkspaceDocuments'),
  list_my_documents: () => aiStatus('listMyDocuments'),
  search_documents: a => fieldStatus(a, 'query', 'listMyDocuments', 'searchDocuments', 'query', 60),
  list_folders: () => aiStatus('listFolders'),
  move_document: () => aiStatus('moveDocument'),
  create_folder: a => fieldStatus(a, 'name', 'listFolders', 'createFolder', 'name', 40),
  view_other_document: describeViewOtherDocument,
  set_title: a => fieldStatus(a, 'title', 'setTitleAny', 'setTitle', 'title', 40),
  view_image: describeViewImage,
  generate_image: a => fieldStatus(a, 'prompt', 'generateImageAny', 'generateImage', 'prompt', 50),
  fetch_url: describeFetchUrl,
  search_knowledge: a => fieldStatus(a, 'query', 'searchKnowledgeAny', 'searchKnowledge', 'query', 60),
  get_knowledge_file: a => fieldStatus(a, 'knowledge_id', 'openKnowledgeFileAny', 'openKnowledgeFile', 'id', 64),
  read_comments: () => aiStatus('readComments'),
  create_comment: () => aiStatus('addComment'),
  reply_to_comment: describeReplyToComment,
  resolve_comment: describeResolveComment,
  delete_comment: () => aiStatus('deleteComment'),
  delegate_scan: () => aiStatus('scanDocument'),
  delegate_rewrite: describeDelegateRewrite
}

/**
 * Pure derivation: tool name + args → user-facing status line.
 * Exported so it can be unit-tested.
 *
 * Returns null if the tool isn't recognised, callers should leave the
 * previous status in place rather than flash something generic
 * (a generic status would only flash and then be replaced).
 */
export function describeToolInput(name: string, args: Record<string, unknown>): AiStatusLine | null {
  const formatter = FORMATTERS[name]
  return formatter ? formatter(args) : null
}
