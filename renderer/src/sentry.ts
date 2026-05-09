import * as Sentry from '@sentry/bun'

// Renderer Sentry init. Must be imported BEFORE any handler so Sentry's
// Bun instrumentation patches stdlib targets (fetch / http / s3) before
// renderDocument / Bun.serve grabs references to them. Init is a no-op
// when SENTRY_DSN is empty — dev/local stay silent.
//
// Cross-service trace continuation: the app injects sentry-trace + baggage
// on the POST /render call (server/utils/traceHeaders.ts). The handler in
// index.ts pulls those headers off req.headers and feeds them into
// Sentry.continueTrace, which wires this renderer's transaction up as a
// child of the app-side transaction. End result: one trace in Sentry's
// Trace Explorer covers browser → app → renderer → S3.

const dsn = process.env.SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    // Same prod/dev split as the app — keeps the bill sane in prod,
    // makes every distributed trace visible while debugging locally.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1
  })
}

export { Sentry }
export const captureException = Sentry.captureException.bind(Sentry)
