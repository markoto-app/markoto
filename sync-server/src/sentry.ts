import * as Sentry from '@sentry/bun'

// Sync-server Sentry init. Must be imported before anything else in
// index.ts so Sentry's Bun instrumentation patches the global fetch / ws /
// stdlib targets before they're referenced. Init is a no-op when
// SENTRY_DSN is empty — dev/local don't need a telemetry sink.

const dsn = process.env.SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Dev: full sampling so distributed traces (browser → app → sync-server
    // for activity logs / comments mirror) are visible while debugging.
    // Prod: 10% to keep the Sentry bill sane.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1
  })
}

// Re-export the captureException/captureMessage helpers so callers can
// import from `./sentry` without pulling @sentry/bun directly. These are
// safe no-ops when Sentry wasn't initialised (SDK handles the unset DSN).
export const captureException = Sentry.captureException.bind(Sentry)
export const captureMessage = Sentry.captureMessage.bind(Sentry)
export { Sentry }

/**
 * Outbound trace propagation helper. Mirrors `server/utils/traceHeaders.ts`
 * on the app side — the sync-server doesn't share that file because it's
 * a standalone Bun container with its own `node_modules`. When the
 * sync-server POSTs to the app's `/api/internal/activity` or
 * `/api/internal/comments-snapshot`, the headers carry the active span
 * context so Sentry stitches the spans into one trace covering the user
 * edit that triggered them (Hocuspocus onStoreDocument → activity log →
 * app side row insert).
 *
 * Returns the headers unchanged when no span is active (e.g. the activity
 * logger fired from a periodic flush, not an HTTP-rooted span) or when
 * Sentry isn't initialised — degrades gracefully.
 */
export function injectTraceHeaders(
  headers: Record<string, string>
): Record<string, string> {
  try {
    const trace = (Sentry as { getTraceData?: () => Record<string, string> }).getTraceData?.() ?? {}
    return { ...headers, ...trace }
  } catch {
    return headers
  }
}
