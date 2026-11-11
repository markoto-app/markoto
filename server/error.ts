import * as Sentry from '@sentry/nuxt'
import type { NitroErrorHandler } from 'nitropack/types'
import { dropUnusedSessionCookie } from './utils/auth/sessionCookie'
import { isApiErrorCode } from '../shared/api/errors'
import { isTestModeEnabled } from '../shared/utils/security/testMode'

// Global error handler, wired via `nitro.errorHandler` in nuxt.config.ts.
// Every uncaught error flows through here, so raw pg errors, SQL strings
// or stack traces can't reach the client when an endpoint forgets a
// try/catch.
//
// 4xx: the endpoint threw `createError(...)` on purpose; `message` and
// `data` pass through (the UI shows them in toasts), `stack` never does.
// 5xx: unintended escapes. Captured in Sentry and logged, but the client
// gets only a generic message and `data: { code: 'internal' }`.

export interface SanitizedErrorPayload {
  statusCode: number
  statusMessage: string
  message?: string
  url?: string
  data?: unknown
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
    statusMessage: error.statusMessage || (isServerError ? 'Server Error' : 'Bad Request'),
    url
  }

  if (isServerError) {
    // 5xx — strip everything, generic message only.
    payload.message = 'Something went wrong on our side. Please try again — we\'ve been notified.'
    payload.data = { code: 'internal' }
  } else {
    // 4xx pass-through — author-controlled strings.
    if (error.message) payload.message = error.message
    if (error.data !== undefined) payload.data = error.data
  }

  return payload
}

const handler: NitroErrorHandler = async (error, event) => {
  const url = event.path
  const statusCode = error.statusCode || 500
  const isServerError = statusCode >= 500

  // Full error (stack + cause) goes to console and Sentry, never the response.
  if (isServerError) {
    console.error(`[error] ${statusCode} ${url}:`, error.message ?? error, error.cause)
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
    if (typeof code === 'string' && !isApiErrorCode(code)) console.warn(`[api-error] unregistered code ${code} (${statusCode} ${url})`)
  }

  const payload = buildSanitizedErrorPayload(error, url)
  setResponseStatus(event, payload.statusCode, payload.statusMessage)
  setResponseHeader(event, 'content-type', 'application/json')
  // Error answers skip `beforeResponse`; same rule as plugins/session-cookie.ts.
  dropUnusedSessionCookie(event)
  await send(event, JSON.stringify(payload))
}

export default handler
