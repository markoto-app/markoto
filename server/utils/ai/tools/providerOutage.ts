import { APIConnectionError, APIError } from 'openai'

// "The upstream provider is down", as opposed to every other failure of a
// provider call (4xx, bad arguments, budget, our own bug). Only these are
// worth telling the user "try again later" about, and only these let the
// release's flow suite skip instead of fail.

const OUTAGE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * LiteLLM wraps a provider 5xx or a refused connection as a 500 whose text
 * carries the cause, so the text is matched too: "Server error '503 …'",
 * "APIConnectionError", gateway errors and socket-level failures.
 */
const OUTAGE_TEXT = /APIConnectionError|Server error '5\d\d|Service (?:Temporarily )?Unavailable|Bad Gateway|Gateway Time-?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|timed out/i

export function isProviderUnavailableError(e: unknown): boolean {
  if (e instanceof APIConnectionError) return true
  if (e instanceof APIError && typeof e.status === 'number' && OUTAGE_STATUSES.has(e.status)) return true
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return OUTAGE_TEXT.test(msg)
}
