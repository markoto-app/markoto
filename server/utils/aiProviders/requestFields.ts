// Turns a resolved provider into the fields of a LiteLLM request body,
// re-checking the base URL against the SSRF policy on EVERY call, and
// keeps provider API keys out of every error message we surface, log or
// send to Sentry.

import { OPERATOR_URL_POLICY, resolveByokUrlPolicy } from './config'
import { AiProviderUrlRefused, checkProviderBaseUrl } from './urlPolicy'
import { litellmModelFor, type ResolvedAiProvider } from './resolve'
import type { VerifyCode } from '~~/shared/ai/providers'
import { useLogger } from '../platform/logger'

const log = useLogger('ai-provider')

/**
 * LiteLLM's clientside-credential fields. Only ever sent together with a
 * `byok/*` model: a bare `api_key` on a platform deployment would REPLACE
 * the operator's provider key for that request (verified on v1.106.4).
 */
export interface ByokRequestFields {
  model: string
  api_key?: string
  api_base?: string
}

export async function providerRequestFields(provider: ResolvedAiProvider): Promise<ByokRequestFields> {
  const model = litellmModelFor(provider)
  if (!provider.credentials) return { model }
  const policy = provider.source === 'user' ? resolveByokUrlPolicy() : OPERATOR_URL_POLICY
  const check = await checkProviderBaseUrl(provider.credentials.baseUrl, policy)
  if (!check.ok) throw new AiProviderUrlRefused(check.code, check.message)
  return { model, api_key: provider.credentials.apiKey, api_base: check.normalized }
}

const REDACTED = '[redacted]'

/**
 * Remove an API key (and any 8+ character prefix/suffix of it that a
 * provider might echo, e.g. "Incorrect API key provided: sk-abc…") from
 * a message.
 */
export function redactSecret(message: string, secret: string | null | undefined): string {
  const key = (secret ?? '').trim()
  if (key.length < 4) return message
  let out = message.split(key).join(REDACTED)
  if (key.length >= 8) {
    for (let len = key.length - 1; len >= 8; len--) {
      const head = key.slice(0, len)
      const tail = key.slice(key.length - len)
      if (out.includes(head)) out = out.split(head).join(REDACTED)
      if (out.includes(tail)) out = out.split(tail).join(REDACTED)
    }
  }
  return out
}

/** Error raised by a BYOK call. Its message is already key-free. */
export class AiProviderCallError extends Error {
  readonly code: VerifyCode
  readonly status: number | null
  constructor(code: VerifyCode, message: string, status: number | null) {
    super(message)
    this.name = 'AiProviderCallError'
    this.code = code
    this.status = status
  }
}

export function errorStatus(e: unknown): number | null {
  if (typeof e === 'object' && e !== null && 'status' in e) {
    const status = (e as Record<string, unknown>).status
    if (typeof status === 'number') return status
  }
  return null
}

/** Map a provider/LiteLLM failure to a stable code. */
export function classifyProviderError(e: unknown): VerifyCode {
  if (e instanceof AiProviderUrlRefused) return 'url-refused'
  if (e instanceof AiProviderCallError) return e.code
  const status = errorStatus(e)
  const msg = e instanceof Error ? e.message : String(e)
  if (status === 401 || status === 403 || /authentication|api key|unauthori[sz]ed|invalid_api_key/i.test(msg)) return 'auth-failed'
  if (status === 404 || /model_not_found|does not exist|not found|NotFoundError/i.test(msg)) return 'model-not-found'
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|connection|APIConnectionError/i.test(msg)) return 'unreachable'
  return 'unexpected-response'
}

/**
 * Fixed, user-facing sentence per failure code. Upstream response bodies
 * never reach the user: a provider URL that redirects (or otherwise
 * misbehaves) could otherwise turn the error text into a way to read
 * whatever the request ended up hitting. The raw (key-redacted) detail
 * goes to the server log only.
 */
export const PROVIDER_ERROR_MESSAGES: Record<VerifyCode, string> = {
  'ok': 'The provider answered.',
  'auth-failed': 'The provider rejected the API key.',
  'model-not-found': 'The provider does not know this model id.',
  'no-tool-support': 'The model answered without calling a tool.',
  'url-refused': 'This provider URL is not allowed on this instance.',
  'unreachable': 'The provider could not be reached.',
  'unexpected-response': 'The provider returned an unexpected response.'
}

const REDIRECT_PATTERN = /\bError code: 3\d\d\b|\bstatus(?: code)?:? 3\d\d\b/i

/** User-facing message for a failed provider call — never includes upstream text. */
export function providerErrorMessage(code: VerifyCode, e: unknown): string {
  // Our own policy text (no upstream content) — keep it, it says what to fix.
  if (e instanceof AiProviderUrlRefused) return e.message
  const status = errorStatus(e)
  const msg = e instanceof Error ? e.message : String(e)
  if ((status !== null && status >= 300 && status < 400) || REDIRECT_PATTERN.test(msg)) {
    return 'The provider answered with a redirect, which is not followed. Use the provider\'s final API URL.'
  }
  return PROVIDER_ERROR_MESSAGES[code]
}

/**
 * Wrap a provider call so any thrown error is re-thrown as an
 * `AiProviderCallError` carrying a stable code and a fixed message (see
 * `providerErrorMessage`); the key-redacted upstream detail is logged
 * server-side only. Budget-exceeded errors are not wrapped — they only
 * occur on platform-billed calls, which carry no user key, and the
 * callers' `isBudgetExceededError` checks match on their message.
 */
/**
 * Wrap a provider stream so errors raised while it is CONSUMED (an SSE
 * error event, a dropped connection) get the same key redaction as
 * `withProviderErrors` gives errors raised while opening it. No-op for
 * platform aliases (no user key to redact).
 */
export async function* redactProviderStream<T>(provider: ResolvedAiProvider, stream: AsyncIterable<T>): AsyncGenerator<T, void, unknown> {
  try {
    for await (const item of stream) yield item
  } catch (e) {
    if (!provider.credentials || e instanceof AiProviderUrlRefused) throw e
    const message = redactSecret(e instanceof Error ? e.message : String(e), provider.credentials.apiKey)
    throw new AiProviderCallError(classifyProviderError(e), message, errorStatus(e))
  }
}

export async function withProviderErrors<T>(provider: ResolvedAiProvider, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!provider.credentials || e instanceof AiProviderUrlRefused) throw e
    const code = classifyProviderError(e)
    logProviderFailure(code, e, provider.credentials.apiKey)
    throw new AiProviderCallError(code, providerErrorMessage(code, e), errorStatus(e))
  }
}

/** Server-log line for a failed provider call (key redacted, bounded). */
export function logProviderFailure(code: VerifyCode, e: unknown, apiKey: string | null | undefined): void {
  // The user's key is removed from the message before the logger sees it; the
  // logger then masks key-shaped strings and bounds the length on top.
  const detail = redactSecret(e instanceof Error ? e.message : String(e), apiKey).slice(0, 300)
  log.warn('provider call failed', { code, detail })
}
