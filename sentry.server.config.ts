import * as Sentry from '@sentry/nuxt'
import { sentryScrubOptions } from './shared/utils/security/sentryScrub'

// Server-side Sentry init: picked up automatically by @sentry/nuxt.
//
// Dev stays silent when DSN is empty, so local work doesn't need a
// telemetry sink running.
//
// Server prefers `SENTRY_DSN` (lets you point at a separate backend-only
// Sentry project), falls back to the browser DSN so small setups can run
// with one value.
const dsn = process.env.SENTRY_DSN || process.env.NUXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Dev: full sampling so distributed traces are visible end-to-end.
    // Prod: 10% to keep the Sentry bill sane. Sentry's auto-instrumentation
    // reads inbound `sentry-trace` + `baggage` headers via the default
    // httpIntegration, so cross-service traces stitch together when the
    // upstream parent kept the trace.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Errors, sampled transactions and breadcrumbs all pass the same
    // scrubber: URL queries (presigned S3 signatures, render tokens),
    // bodies, cookies, non-allowlisted headers, secrets by key, emails.
    ...sentryScrubOptions
  })
}
