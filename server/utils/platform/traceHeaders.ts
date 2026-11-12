import * as Sentry from '@sentry/nuxt'
import { currentRequestId } from './logger'

// Injects `sentry-trace` + `baggage` on outbound fetches so the renderer,
// sync-server and markitdown calls continue the inbound request's trace.
//
// `Sentry.getTraceData()` returns `{}` without an active span (e.g. a sweeper
// outside an HTTP request); the headers then pass through unchanged. SDK
// errors are swallowed: a missing trace header only loses the distributed
// trace, while throwing would fail the originating mutation.

//
// `x-request-id` rides along so the sync server's and the renderer's log lines
// carry the id the app logged for the same request.

export function injectTraceHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const requestId = currentRequestId()
  const withId = requestId ? { ...headers, 'x-request-id': requestId } : headers
  try {
    const trace = Sentry.getTraceData()
    return { ...withId, ...trace }
  } catch {
    return withId
  }
}
