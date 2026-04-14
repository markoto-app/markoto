import type { FunctionCall } from '@google/genai'

/**
 * Turns Gemini stream chunks + emitted function calls into live status strings
 * shown to clients via Y.js awareness. Kept separate from the loop so
 * `describeToolInput` is a pure function — easy to test with fixtures, and
 * the main loop can focus on SDK mechanics.
 *
 * Granularity note: Gemini's streaming typically surfaces a function call as a
 * complete unit (args arrive as one chunk, not progressively like Claude's
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
 * we don't announce "speaking" for them (matches Claude behaviour).
 */
export function processChunk(
  chunk: { functionCalls?: FunctionCall[]; text?: string },
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
 * generic (same philosophy as the Claude implementation).
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
    default:
      // Unknown function — don't spam awareness; the loop will still fire
      // an "unsupported tool" error response back to the model.
      return null
  }
}
