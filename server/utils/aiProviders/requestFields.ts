// Turns a resolved provider into the fields of a LiteLLM request body,
// re-checking the base URL against the SSRF policy on EVERY call, and
// keeps provider API keys out of every error message we surface, log or
// send to Sentry.

import { OPERATOR_URL_POLICY, resolveByokUrlPolicy } from './config'
import { AiProviderUrlRefused, checkProviderBaseUrl } from './urlPolicy'
import { litellmModelFor, type ResolvedAiProvider } from './resolve'
import type { VerifyCode } from '~~/shared/ai/providers'

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

function errorStatus(e: unknown): number | null {
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
 * Wrap a provider call so any thrown error is re-thrown with the key
 * redacted. Budget-exceeded errors keep their message shape (the
 * callers' `isBudgetExceededError` checks match on it) — they only occur
 * on platform-billed calls, which carry no user key anyway.
 */
export async function withProviderErrors<T>(provider: ResolvedAiProvider, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!provider.credentials || e instanceof AiProviderUrlRefused) throw e
    const message = redactSecret(e instanceof Error ? e.message : String(e), provider.credentials.apiKey)
    throw new AiProviderCallError(classifyProviderError(e), message, errorStatus(e))
  }
}
