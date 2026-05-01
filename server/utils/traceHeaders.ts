import * as Sentry from '@sentry/nuxt'

// Outbound trace propagation helper. Sentry's auto-instrumentation
// captures the inbound HTTP request as a transaction; this is the
// counterpart that injects `sentry-trace` + `baggage` on outbound
// fetches so the renderer / sync-server / future-internal-service
// containers can continue the same trace.
//
// `Sentry.getTraceData()` returns `{}` when no span is active (e.g. a
// scheduled sweeper firing outside an HTTP request) — in that case we
// just pass the caller's headers through unchanged. SDK errors are
// swallowed: a missing trace header degrades gracefully (no
// distributed trace, but the request still succeeds), whereas throwing
// would take down the originating mutation. Threading uses cases that
// matter:
//   - server/utils/renderClient.ts → renderer container
//   - server/utils/processKnowledge.ts → markitdown (Python; downstream
//     ignores the headers today, but we still emit them so an upstream
//     trace shows the markitdown call as an outgoing HTTP span).
//   - server/utils/syncNotify.ts → sync-server `/internal/kick-user`
//   - server/utils/documentLifecycle.ts → sync-server
//     `/internal/notify-deleted`

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
