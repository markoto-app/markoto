import type { FunctionCall } from '@google/genai'

/**
 * Turns Gemini stream chunks + emitted function calls into live status strings
 * shown to clients via Y.js awareness. Kept separate from the loop so
 * `describeToolInput` is a pure function — easy to test with fixtures, and
 * the main loop can focus on SDK mechanics.
 *
 * Granularity note: Gemini's streaming typically surfaces a function call as a
 * complete unit (args arrive as one chunk, not progressively like Gemini's
 * `input_json_delta`). We get one status announcement per tool call rather
 * than per-character streaming — acceptable: users perceive tool-call-level
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
 * across chunks (Gemini can re-emit a function_call in multiple chunks as the
 * args fill in); we only announce on *new* call identities.
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
 * we don't announce "speaking" for them (matches Gemini behaviour).
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
    const key = `${call.name}:${JSON.stringify(call.args ?? {})}`
    if (state.announced.has(key)) continue
    state.announced.add(key)

    const msg = describeToolInput(call.name, call.args ?? {})
    if (msg) opts.setStatus('tool', msg)
  }
}

/**
 * Pure derivation: tool name + args → user-facing status string.
 * Exported so it can be unit-tested.
 *
 * Returns null if the inputs don't carry a field we can speak to — callers
 * should leave the previous status in place rather than flash something
 * generic (same philosophy as the Gemini implementation).
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
      const sections = Object.entries(args)
        .filter(([, v]) => v && typeof v === 'object' && Object.keys(v as object).length > 0)
        .map(([k]) => k)
      if (sections.length === 0) return 'Updating theme…'
      if (sections.length <= 2) return `Updating theme (${sections.join(', ')})…`
      return `Updating theme (${sections.length} sections)…`
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
    default:
      // Unknown function — don't spam awareness; the loop will still fire
      // an "unsupported tool" error response back to the model.
      return null
  }
}
