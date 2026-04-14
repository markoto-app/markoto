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
    tracesSampleRate: 0.1
  })
}

// Re-export the captureException/captureMessage helpers so callers can
// import from `./sentry` without pulling @sentry/bun directly. These are
// safe no-ops when Sentry wasn't initialised (SDK handles the unset DSN).
export const captureException = Sentry.captureException.bind(Sentry)
export const captureMessage = Sentry.captureMessage.bind(Sentry)
