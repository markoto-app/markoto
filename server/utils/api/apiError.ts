import { createError, type H3Error } from 'h3'
import { API_ERRORS, apiErrorMessageKey, type ApiErrorCode, type ApiErrorParams, type ApiErrorStatus } from '~~/shared/api/errors'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import enCatalog from '~~/i18n/locales/errors/en.json'

// The one way a handler refuses a request: a registered code, its params
// type-checked against the registry, the status fixed by the registry, and the
// English text from the same catalog the client translates. `data` stays flat
// (`{ code, ...params }`), so clients and tests that read `data.code`,
// `data.field` or `data.feature` keep working.

/** Optional second-level choices; `status` only among the code's registered statuses. */
export interface ApiErrorOptions<C extends ApiErrorCode> {
  status?: ApiErrorStatus<C>
  cause?: unknown
}

type Args<C extends ApiErrorCode> = ApiErrorParams<C> extends undefined
  ? [params?: undefined, options?: ApiErrorOptions<C>]
  : Partial<ApiErrorParams<C>> extends ApiErrorParams<C>
    ? [params?: ApiErrorParams<C>, options?: ApiErrorOptions<C>]
    : [params: ApiErrorParams<C>, options?: ApiErrorOptions<C>]

const catalog = (enCatalog as { apiErrors: Record<string, Record<string, string>> }).apiErrors

/** The English text of a code with its `{placeholders}` filled in. */
function renderApiErrorMessage(code: string, params?: Record<string, unknown>): string {
  const [, ns = '', slug = ''] = apiErrorMessageKey(code).split('.')
  const template = catalog[ns]?.[slug] ?? code
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = params?.[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

export function apiError<C extends ApiErrorCode>(code: C, ...[params, options]: Args<C>): H3Error {
  const spec = API_ERRORS[code] as { status: number, statuses?: readonly number[], params?: { safeParse: (v: unknown) => { success: boolean, error?: unknown } } }
  const status = options?.status ?? spec.status
  // Test mode: a wrong params object or an unregistered status is a bug in the
  // calling handler; fail loudly so the integration suite catches it.
  if (isTestModeEnabled()) {
    if (status !== spec.status && !spec.statuses?.includes(status)) {
      throw new Error(`[api-error] ${code} is not registered with status ${status}`)
    }
    if (spec.params) {
      const parsed = spec.params.safeParse(params ?? {})
      if (!parsed.success) throw new Error(`[api-error] ${code}: params do not match the registry: ${String(parsed.error)}`)
    }
  }
  const data = { code, ...(params as Record<string, unknown> | undefined) }
  return createError({
    statusCode: status,
    message: renderApiErrorMessage(code, params as Record<string, unknown> | undefined),
    data,
    cause: options?.cause
  })
}

/** A 403 code without params: what `allow.doc` / `allow.workspace` accept as `deny`. */
export type DenyCode = {
  [C in ApiErrorCode]: ApiErrorParams<C> extends undefined ? ((typeof API_ERRORS)[C]['status'] extends 403 ? C : never) : never
}[ApiErrorCode]

export function denyError(code: DenyCode): H3Error {
  return (apiError as (c: ApiErrorCode) => H3Error)(code)
}
