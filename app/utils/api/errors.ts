// Which translated text an API error shows. The registry (shared/api/errors/)
// names every code; its text is `apiErrors.<ns>.<slug>` in
// i18n/locales/errors/<locale>.json, interpolated with the error's `data`.
import { API_ERRORS, apiErrorMessageKey, isApiErrorCode } from '~~/shared/api/errors'
import { PLAN_FEATURE_UNAVAILABLE_CODE, PLAN_LIMIT_REACHED_CODE } from '~~/shared/config/planErrors'

export interface ApiErrorData {
  code?: string
  messageKey?: string
  message?: string
  [key: string]: unknown
}

/**
 * Our fields of a thrown API error, whatever wrapped them. A `$fetch` error
 * carries the response body in `.data`, and the body carries our fields in
 * its own `.data` (`{ statusCode, message, data: { code, … } }`); callers
 * that already unwrapped pass `{ data: { code, … } }`. The body's `message`
 * (the English text) comes along for codes the client can't translate.
 */
export function apiErrorData(err: unknown): ApiErrorData | undefined {
  const outer = (err as { data?: unknown } | null | undefined)?.data
  if (typeof outer !== 'object' || outer === null) return undefined
  const body = outer as Record<string, unknown>
  const inner = body.data
  if (typeof inner === 'object' && inner !== null && !Array.isArray(inner) && typeof body.code !== 'string') {
    return { ...(inner as Record<string, unknown>), ...(typeof body.message === 'string' ? { message: body.message } : {}) }
  }
  return body as ApiErrorData
}

export interface ErrorText {
  key: string
  params: Record<string, unknown>
}

/**
 * Codes whose text is chosen per occurrence (the feature or limit concerned,
 * a provider refusal reason): the route's `messageKey` (or the per-feature
 * plan key) is more precise than the code's generic text.
 */
const PER_OCCURRENCE: Record<string, (data: ApiErrorData) => string | undefined> = {
  [PLAN_FEATURE_UNAVAILABLE_CODE]: d => d.messageKey ?? (typeof d.feature === 'string' ? `plan.feature.${d.feature}` : undefined),
  [PLAN_LIMIT_REACHED_CODE]: d => d.messageKey ?? (typeof d.field === 'string' ? `plan.limit.${d.field}` : undefined),
  'ai-provider/url-refused': d => d.messageKey,
  'ai-provider/verify-failed': d => d.messageKey,
  'ai/provider-missing': d => d.messageKey,
  'ai/budget-exhausted': d => d.messageKey,
  'ai/free-allowance-exhausted': d => d.messageKey,
  'ai/web-tools-rate-limited': d => d.messageKey,
  'brand/font-refused': d => d.messageKey
}

/** The registry text of `data.code`, when the error carries every param its text needs. */
function registryText(data: ApiErrorData): ErrorText | null {
  if (!isApiErrorCode(data.code)) return null
  const spec = API_ERRORS[data.code] as { params?: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } }
  // An error built outside `apiError` may carry a registered code without the
  // params the text interpolates; then its messageKey / message is the better text.
  const shape = spec.params?.shape ?? {}
  const missing = Object.entries(shape).some(([name, field]) => !field.safeParse(undefined).success && data[name] === undefined)
  if (missing) return null
  return { key: apiErrorMessageKey(data.code), params: data }
}

/** Candidate texts, most precise first; the caller takes the first one its locale has. */
function apiErrorTexts(data: ApiErrorData | undefined): ErrorText[] {
  if (!data) return []
  const out: ErrorText[] = []
  // Own keys only: a code like "constructor" must not reach Object.prototype.
  const perOccurrence = data.code && Object.hasOwn(PER_OCCURRENCE, data.code) ? PER_OCCURRENCE[data.code]!(data) : undefined
  if (perOccurrence) out.push({ key: perOccurrence, params: data })
  const registered = registryText(data)
  if (registered) out.push(registered)
  if (data.messageKey) out.push({ key: data.messageKey, params: {} })
  return out
}

/** One failed field of a validation error, as an i18n key (`apiErrors.validation.<issue>`). */
export interface FieldErrorText extends ErrorText {
  path: string
}

export function fieldErrors(data: ApiErrorData | undefined): FieldErrorText[] {
  const fields = data?.fields
  if (!Array.isArray(fields)) return []
  return fields
    .filter((f): f is { path: string, issue: string } & Record<string, unknown> => typeof f?.path === 'string' && typeof f?.issue === 'string')
    .map(f => ({ path: f.path, key: `apiErrors.validation.${f.issue}`, params: f }))
}

// Status-based texts for an error whose code the client has no text for (or
// that has no code): short common phrases, never the server's English message.
const STATUS_KEYS: Record<number, string> = {
  400: 'error.badRequest',
  401: 'error.unauthorized',
  403: 'error.forbidden',
  404: 'error.notFound',
  409: 'error.conflict',
  413: 'error.payloadTooLarge',
  429: 'error.rateLimited'
}

/** The status-based text key of an HTTP status (any 5xx is the server-side one). */
function statusErrorKey(status: number | null): string | undefined {
  if (status === null) return undefined
  if (status >= 500) return 'error.serverError'
  return STATUS_KEYS[status]
}

interface StatusShape {
  statusCode?: unknown
  status?: unknown
  name?: unknown
  data?: { statusCode?: unknown }
}

/** HTTP status of a thrown error, whatever wrapped it (`$fetch`, `useFetch`, a Nuxt error). */
export function errorStatus(err: unknown): number | null {
  const e = (err ?? {}) as StatusShape
  for (const candidate of [e.statusCode, e.status, e.data?.statusCode]) {
    if (typeof candidate === 'number') return candidate
  }
  return null
}

export interface ErrorTranslator {
  t: (key: string, params?: Record<string, unknown>) => string
  /** Whether the locale (or its fallback) has the key; avoids missing-key warnings. */
  te: (key: string) => boolean
}

/**
 * The translated text of any thrown error, most precise first: a
 * per-occurrence key, the registered code's text, the route's `messageKey`,
 * the status-based text, a network text for a request that never got an
 * answer, `error.generic`. The server's English `message` is never shown.
 */
export function resolveErrorMessage(err: unknown, i18n: ErrorTranslator): string {
  const known = apiErrorTexts(apiErrorData(err)).find(c => i18n.te(c.key))
  if (known) return i18n.t(known.key, known.params)
  const status = errorStatus(err)
  const isNetwork = status === null && (err as StatusShape | null)?.name === 'FetchError'
  const key = isNetwork ? 'error.network' : statusErrorKey(status)
  return i18n.t(key && i18n.te(key) ? key : 'error.generic')
}
