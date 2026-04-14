import * as Sentry from '@sentry/nuxt'

// Server-side Sentry init — picked up automatically by @sentry/nuxt.
//
// `NUXT_PUBLIC_SENTRY_DSN` is used for both client and server so we don't
// run two DSNs; GlitchTip's envelope endpoint accepts both.
//
// Dev stays silent when DSN is empty, so local work doesn't need a
// telemetry sink running.

const dsn = process.env.NUXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.headers) {
        // Presigned-URL query strings carry SigV4 credentials — not headers,
        // but scrub belt-and-suspenders just in case an SDK version widens
        // what lands here.
        delete event.request.headers.authorization
        delete event.request.headers.cookie
        delete event.request.headers['x-internal-secret']
      }
      return event
    }
  })
}
