import * as Sentry from '@sentry/nuxt'

// Injects `sentry-trace` + `baggage` on outbound fetches so the renderer,
// sync-server and markitdown calls continue the inbound request's trace.
//
// `Sentry.getTraceData()` returns `{}` without an active span (e.g. a sweeper
// outside an HTTP request); the headers then pass through unchanged. SDK
// errors are swallowed: a missing trace header only loses the distributed
// trace, while throwing would fail the originating mutation.

export function injectTraceHeaders(
  headers: Record<string, string>
): Record<string, string> {
  try {
    const trace = (Sentry as unknown as { getTraceData?: () => Record<string, string> }).getTraceData?.() ?? {}
    return { ...headers, ...trace }
  } catch {
    return headers
  }
}
