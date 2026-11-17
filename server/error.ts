import * as Sentry from '@sentry/nuxt'
import type { NitroErrorHandler } from 'nitropack/types'
import type { H3Event } from 'h3'
import { dropUnusedSessionCookie } from './utils/auth/sessionCookie'
import { API_ERRORS, isApiErrorCode } from '../shared/api/errors'
import { isTestModeEnabled } from '../shared/utils/security/testMode'
import { useLogger } from './utils/platform/logger'

const log = useLogger('api-error')

// Global error handler, wired via `nitro.errorHandler` in nuxt.config.ts.
// Every uncaught error flows through here, so raw pg errors, SQL strings
// or stack traces can't reach the client when an endpoint forgets a
// try/catch.
//
// 4xx: the endpoint threw `createError(...)` on purpose; `message` and
// `data` pass through (the UI shows them in toasts), `stack` never does.
// 5xx: captured in Sentry and logged, but the client gets only a generic
// message and `data: { code: 'internal' }`. Exception: a 5xx a route threw on
// purpose with a registered code that carries no params (`apiError('ai/
// image-provider-unavailable')`) keeps `data: { code }` and nothing else, so
// the UI can say what failed ("the image provider is down") from its own
// translated text. The code is a fixed registry string; message, params and
// any other data are still dropped.

export interface SanitizedErrorPayload {
  statusCode: number
  statusMessage: string
  message?: string
  url?: string
  data?: unknown
}

// The reason phrase of the 4xx statuses our routes answer with. Errors are
// thrown with a status code only (`apiError`), so the phrase is derived
// here; it must match the code (a 403 that says "Bad Request" misleads
// whoever reads a network trace or a log).
const CLIENT_ERROR_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  426: 'Upgrade Required',
  429: 'Too Many Requests'
}

function defaultStatusMessage(statusCode: number): string {
  if (statusCode >= 500) return 'Server Error'
  return CLIENT_ERROR_PHRASES[statusCode] ?? 'Client Error'
}

/** A registered 5xx code without params, from a route's `apiError(...)`; null for anything else. */
function passThroughServerErrorCode(data: unknown): string | null {
  const code = (data as { code?: unknown } | null | undefined)?.code
  if (!isApiErrorCode(code)) return null
  const spec: { status: number, params?: unknown } = API_ERRORS[code]
  return spec.status >= 500 && spec.params === undefined ? code : null
}

/** Pure payload builder (no h3 I/O, so the policy is unit-testable). `stack` is never included. */
export function buildSanitizedErrorPayload(error: {
  statusCode?: number
  statusMessage?: string
  message?: string
  data?: unknown
}, url?: string): SanitizedErrorPayload {
  const statusCode = error.statusCode || 500
  const isServerError = statusCode >= 500

  const payload: SanitizedErrorPayload = {
    statusCode,
    statusMessage: error.statusMessage || defaultStatusMessage(statusCode),
    url
  }

  if (isServerError) {
    // 5xx: strip everything, generic message only (a registered code survives).
    payload.message = 'Something went wrong on our side. Please try again. We\'ve been notified.'
    payload.data = { code: passThroughServerErrorCode(error.data) ?? 'internal' }
  } else {
    // 4xx pass-through: author-controlled strings.
    if (error.message) payload.message = error.message
    if (error.data !== undefined) payload.data = error.data
  }

  return payload
}

/** A browser navigating to a page, as opposed to an API or asset request. */
function wantsErrorPage(event: H3Event): boolean {
  if (event.context.nuxt?.['~rendering-error']) return false
  const path = event.path
  if (/^\/(api|mcp|scim|internal|_nuxt|__nuxt_error)(\/|$|\?)/.test(path)) return false
  return (getRequestHeader(event, 'accept') ?? '').includes('text/html')
}

/**
 * Render `app/error.vue` for a failed page request. A custom Nitro error
 * handler replaces Nuxt's own, which is what renders that page, so an unknown
 * URL would otherwise show the JSON payload. Only the status travels in a
 * way the page uses: it picks its text by status, never from `message`.
 * Returns false when the page itself cannot render; the caller then answers
 * with the JSON payload.
 */
async function sendErrorPage(event: H3Event, payload: SanitizedErrorPayload): Promise<boolean> {
  event.context.nuxt = { ...event.context.nuxt, '~rendering-error': true }
  const target = `/__nuxt_error?${new URLSearchParams({
    url: payload.url ?? '/',
    statusCode: String(payload.statusCode),
    statusMessage: payload.statusMessage,
    message: payload.statusMessage
  }).toString()}`
  const res = await useNitroApp().localFetch(target, {
    headers: event.headers,
    redirect: 'manual',
    context: { nuxt: { '~rendering-error': true } }
  }).catch(() => null)
  if (!res || event.handled) return false
  const html = await res.text()
  for (const [header, value] of res.headers.entries()) {
    if (header === 'set-cookie') continue
    setResponseHeader(event, header, value)
  }
  setResponseStatus(event, payload.statusCode, payload.statusMessage)
  dropUnusedSessionCookie(event)
  await send(event, html)
  return true
}

const handler: NitroErrorHandler = async (error, event) => {
  const url = event.path
  const statusCode = error.statusCode || 500
  const isServerError = statusCode >= 500

  // Full error (stack + cause) goes to console and Sentry, never the response.
  if (isServerError) {
    log.error('request failed', { statusCode, path: url, err: error })
    try {
      Sentry.captureException(error, {
        tags: {
          component: 'errorHandler',
          statusCode: String(statusCode),
          path: url
        }
      })
    } catch {
      // Sentry init may not be ready in test mode; ignore.
    }
  }

  // Every 4xx code belongs in the registry (shared/api/errors/). In dev and
  // test runs, flag one that isn't, so a route conversion that invents a code
  // without registering it shows up in the integration logs.
  if (!isServerError && (isTestModeEnabled() || process.env.NODE_ENV === 'development')) {
    const code = (error.data as { code?: unknown } | undefined)?.code
    if (typeof code === 'string' && !isApiErrorCode(code)) log.warn('unregistered api error code', { code, statusCode, path: url })
  }

  const payload = buildSanitizedErrorPayload(error, url)
  if (wantsErrorPage(event) && await sendErrorPage(event, payload)) return
  setResponseStatus(event, payload.statusCode, payload.statusMessage)
  setResponseHeader(event, 'content-type', 'application/json')
  // Error answers skip `beforeResponse`; same rule as plugins/session-cookie.ts.
  dropUnusedSessionCookie(event)
  await send(event, JSON.stringify(payload))
}

export default handler
