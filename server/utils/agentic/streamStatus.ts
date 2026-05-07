import type { AgenticFunctionCall as FunctionCall } from './aiTypes'

/**
 * Turns provider stream chunks + emitted function calls into live status
 * strings shown to clients via Y.js awareness. Kept separate from the
 * loop so `describeToolInput` is a pure function — easy to test with
 * fixtures, and the main loop can focus on SDK mechanics.
 *
 * Granularity note: Mistral's streaming surfaces a function call's args
 * progressively across `tool_calls[].function.arguments` chunks; the
 * translator in `messageTranslation.ts` accumulates them and yields one
 * synthesised internal-shape chunk with the complete call on stream
 * end. So we still announce one status per tool call rather than
 * per-character streaming — acceptable: users perceive tool-call-level
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
 * Text parts are ignored for status — they land in the final response but
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
    // `call.args` is typed `unknown` upstream; coerce once to the
    // `Record` shape `describeToolInput` expects + the JSON.stringify
    // call accepts.
    const args = (call.args ?? {}) as Record<string, unknown>
    const key = `${call.name}:${JSON.stringify(args)}`
    if (state.announced.has(key)) continue
    state.announced.add(key)

    const msg = describeToolInput(call.name, args)
    if (msg) opts.setStatus('tool', msg)
  }
}

/**
 * Pure derivation: tool name + args → user-facing status string.
 * Exported so it can be unit-tested.
 *
 * Returns null if the inputs don't carry a field we can speak to — callers
 * should leave the previous status in place rather than flash something
 * generic (philosophy carried over from pre-Phase-5: Gemini-era).
 */
export function describeToolInput(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case 'web_search': {
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      return q ? `Searching the web for "${q}"` : 'Searching the web…'
    }
    case 'view_document':
      return 'Reading the document…'
    case 'replace_text': {
      const oldStr = typeof args.old_str === 'string' ? args.old_str : ''
      if (!oldStr) return 'Editing the document…'
      const preview = oldStr.slice(0, 40).replace(/\s+/g, ' ').trim()
      return `Editing "${preview}${oldStr.length > 40 ? '…' : ''}"`
    }
    case 'insert_text':
      return 'Inserting text…'
    case 'update_theme': {
      // Prefer surfacing a NAMED base source over the field-section
      // count — it's what the user typed ("apply my Brand red") and
      // reads like a status not a diagnostic.
      if (typeof args.preset === 'string') return `Applying preset "${args.preset}"…`
      if (typeof args.theme_id === 'string') return 'Applying a saved theme…'
      if (args.from_workspace_default === true) return 'Applying workspace default theme…'
      const sections = Object.entries(args)
        .filter(([, v]) => v && typeof v === 'object' && Object.keys(v as object).length > 0)
        .map(([k]) => k)
      if (sections.length === 0) return 'Updating theme…'
      if (sections.length <= 2) return `Updating theme (${sections.join(', ')})…`
      return `Updating theme (${sections.length} sections)…`
    }
    case 'get_theme':
      return 'Reading current theme…'
    case 'list_themes':
      return 'Listing your saved themes…'
    case 'save_theme_as_preset': {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) return 'Saving theme as preset…'
      const preview = name.length > 40 ? name.slice(0, 40) + '…' : name
      return `Saving theme as "${preview}"`
    }
    case 'list_workspace_documents':
      return 'Browsing workspace documents…'
    case 'view_other_document': {
      const raw = typeof args.doc_id === 'string' ? args.doc_id.trim() : ''
      if (!raw) return 'Reading another document…'
      // Mirror the parser: extract `/d/<id>` shape if present, else
      // treat as a bare id. We don't import the parser here to keep
      // streamStatus dependency-free; the regex is simple enough.
      const urlMatch = raw.match(/\/d\/([A-Za-z0-9_-]+)/)
      const id = urlMatch?.[1] ?? raw
      const preview = id.length > 24 ? id.slice(0, 24) + '…' : id
      return `Reading document ${preview}`
    }
    case 'set_title': {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return 'Updating title…'
      const preview = title.length > 40 ? title.slice(0, 40) + '…' : title
      return `Setting title to "${preview}"`
    }
    case 'view_image': {
      const src = typeof args.src === 'string' ? args.src : ''
      if (!src) return 'Looking at an image…'
      const leaf = src.split('/').pop() || src
      const preview = leaf.length > 40 ? leaf.slice(0, 40) + '…' : leaf
      return `Looking at "${preview}"`
    }
    case 'generate_image': {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) return 'Generating image…'
      const preview = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt
      return `Generating image: "${preview}"`
    }
    case 'fetch_url': {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!url) return 'Fetching URL…'
      // Strip scheme + trailing slash for a tidier display.
      const display = url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
      const preview = display.length > 50 ? display.slice(0, 50) + '…' : display
      return `Fetching ${preview}`
    }
    case 'search_knowledge': {
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      if (!q) return 'Searching workspace knowledge…'
      const preview = q.length > 60 ? q.slice(0, 60) + '…' : q
      return `Searching workspace knowledge for "${preview}"`
    }
    case 'get_knowledge_file': {
      const id = typeof args.knowledge_id === 'string' ? args.knowledge_id : ''
      if (!id) return 'Opening a workspace knowledge file…'
      return `Opening workspace knowledge file ${id}`
    }
    case 'read_comments':
      return 'Reading document comments…'
    case 'create_comment':
      return 'Adding a comment…'
    case 'reply_to_comment': {
      const id = typeof args.comment_id === 'string' ? args.comment_id : ''
      return id ? `Replying to comment ${id}…` : 'Replying to a comment…'
    }
    case 'resolve_comment': {
      const resolved = args.resolved === true
      return resolved ? 'Resolving a comment…' : 'Reopening a comment…'
    }
    case 'delete_comment':
      return 'Deleting a comment…'
    default:
      // Unknown function — don't spam awareness; the loop will still fire
      // an "unsupported tool" error response back to the model.
      return null
  }
}
