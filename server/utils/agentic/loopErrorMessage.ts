import { AiProviderUrlRefused } from '../aiProviders/urlPolicy'
import { AiProviderCallError, errorStatus, providerErrorMessage } from '../aiProviders/requestFields'
import { aiStatus, type AiStatusLine } from '~~/shared/ai/statusSteps'

/** Shown when a platform-provided model call fails for any reason we
 *  don't have a more specific sentence for. */
export const AI_UNAVAILABLE_MESSAGE = 'The AI is not available right now. Please try again in a moment.'

/** Shown when the proxy answers 429 (the per-user rpm limit). */
export const AI_RATE_LIMITED_MESSAGE = 'Too many AI requests in a short time. Please wait a minute and try again.'

/**
 * User-facing sentence for an error that ended an AI session.
 *
 * Upstream text (LiteLLM router messages, provider response bodies) never
 * reaches the user: it names internal model groups and deployments, and on
 * BYOK paths it is text an arbitrary provider URL controls. Callers log the
 * raw error server-side.
 */
export function loopErrorMessage(e: unknown): string {
  // Our own policy text: it says what to fix.
  if (e instanceof AiProviderUrlRefused) return e.message
  // BYOK failure: fixed sentence per code (a stream-consumption error
  // carries the redacted upstream text, so re-derive it from the code).
  if (e instanceof AiProviderCallError) return providerErrorMessage(e.code, e)
  if (errorStatus(e) === 429) return AI_RATE_LIMITED_MESSAGE
  return AI_UNAVAILABLE_MESSAGE
}

/**
 * `loopErrorMessage` as a status line: the fixed sentences carry their
 * step code (translated in the prompt bar); policy and provider texts
 * stay English.
 */
export function loopErrorStatus(e: unknown): AiStatusLine {
  const text = loopErrorMessage(e)
  if (text === AI_UNAVAILABLE_MESSAGE) return aiStatus('aiUnavailable')
  if (text === AI_RATE_LIMITED_MESSAGE) return aiStatus('aiRateLimited')
  return { text, step: null }
}
