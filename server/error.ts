import * as Sentry from '@sentry/nuxt'
import type { NitroErrorHandler } from 'nitropack/types'
import { dropUnusedSessionCookie } from './utils/auth/sessionCookie'

// Global server-side error handler. Wired via `nitro.errorHandler`
// in nuxt.config.ts. EVERY uncaught error from any /api/* endpoint
// flows through here before the response is sent — this is the
// belt-and-braces guard that prevents raw pg errors, drizzle
// statement strings, or stack traces from leaking to the client
// when a per-endpoint try/catch is missing.
//
// Policy:
//   - 4xx errors are mostly INTENTIONAL (the endpoint called
//     `createError({ statusCode: 400, message: '...' })` deliberately).
//     We pass the message + data through, but ALWAYS strip `stack`.
//   - 5xx errors are unintentional escapes — pg errors, network
//     blips, bugs. We Sentry-capture the full thing, log to the
//     server console, and return ONLY `{ statusCode, statusMessage,
//     data: { code: 'internal' } }` to the client. NO message, NO
//     stack, NO underlying SQL.
//
// Why not also strip 4xx messages: those messages are the
// user-facing text our UI shows in toasts ("You've reached the
// workspace limit", "Already scheduled for deletion"). Stripping
// them would gut the UX. The risk surface is lower because we
// authored those strings.

export interface SanitizedErrorPayload {
  statusCode: number
  statusMessage: string
  message?: string
  url?: string
  data?: unknown
}

/**
 * Pure function that builds the sanitized payload from any thrown
 * error. Extracted so the unit tests can verify the policy
 * without mocking h3's response helpers. The handler below wraps
 * this in the I/O.
 *
 * Policy:
 *   - 4xx (client errors): pass `message` and `data` through —
 *     these are author-controlled strings (`createError(...)`)
 *     safe to render in toasts.
 *   - 5xx (server errors): strip `message` and `data`, replace
 *     with a generic line + `data: { code: 'internal' }`. The
 *     original error could carry SQL / paths / env values.
 *   - `stack` is NEVER included in the payload regardless of
 *     status code.
 */
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

  // Always log server-side. Dev console + Sentry both. The full
  // error (incl. stack + cause) lands in our observability stack;
  // it just doesn't leave the server.
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

  const payload = buildSanitizedErrorPayload(error, url)
  setResponseStatus(event, payload.statusCode, payload.statusMessage)
  setResponseHeader(event, 'content-type', 'application/json')
  // Error answers skip `beforeResponse`; same rule as plugins/session-cookie.ts.
  dropUnusedSessionCookie(event)
  await send(event, JSON.stringify(payload))
}

export default handler
