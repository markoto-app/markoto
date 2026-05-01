import * as Sentry from '@sentry/nuxt'

// Browser Sentry init — picked up automatically by @sentry/nuxt's module.
//
// Only initialises when `NUXT_PUBLIC_SENTRY_DSN` is set, so dev / local
// environments stay silent with no config. The DSN comes from the
// project's Client Keys page in sentry.io.

const dsn = useRuntimeConfig().public.sentry?.dsn

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Sample a small slice of transactions — enough to spot hot paths
    // without burning the Sentry quota. Bump to 1.0 briefly if
    // investigating an incident. Dev gets full sampling so distributed
    // traces (browser → app → renderer / sync-server) are always
    // visible while debugging.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Scrub bearer tokens from captured request data before they leave the
    // browser. `sendDefaultPii: false` is already the SDK default.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization
        delete event.request.headers.cookie
      }
      return event
    }
  })
}
