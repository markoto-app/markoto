import { browserTracingIntegration, captureException, init, setUser } from '@sentry/nuxt'
import type { Router } from 'vue-router'

// The browser Sentry SDK, loaded on demand by `plugins/sentry.client.ts`
// (after the page is idle, or at once when an error happens first). It was
// in the entry chunk of every page through @sentry/nuxt's client plugins
// (~40 KB gzip) — a cost the marketing pages paid before their first
// paint. Only that plugin may import this module.

export interface SentryErrorReport {
  error: unknown
  /** Vue's lifecycle hint (`vue:error`), e.g. "setup function". */
  info?: string
  /** Where it was caught: a Vue component, the Nuxt app, or the window. */
  source: 'vue' | 'app' | 'window'
}

export interface SentryClient {
  report: (r: SentryErrorReport) => void
  setUserId: (id: string | null) => void
}

export function startSentry(options: { dsn: string, router: Router, production: boolean }): SentryClient {
  init({
    dsn: options.dsn,
    environment: options.production ? 'production' : 'development',
    // Sample a small slice of transactions — enough to spot hot paths
    // without burning the Sentry quota. Bump to 1.0 briefly if
    // investigating an incident. Dev gets full sampling so distributed
    // traces (browser → app → renderer / sync-server) are always
    // visible while debugging.
    tracesSampleRate: options.production ? 0.1 : 1.0,
    // Page-load + navigation spans (the page-load span still starts at
    // navigation start: it reads the browser's performance timeline).
    // Without the SDK's own window `error` / `unhandledrejection` handlers:
    // plugins/sentry.client.ts listens from app start and forwards them
    // (`report`), so errors from before the SDK loaded aren't lost and
    // none is sent twice.
    integrations: defaults => [
      ...defaults.filter(i => i.name !== 'GlobalHandlers'),
      browserTracingIntegration({ router: options.router, routeLabel: 'path' })
    ],
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

  return {
    // Same shape as @sentry/nuxt's own client plugin (reportNuxtError):
    // unhandled, tagged with where it was caught.
    report({ error, info, source }) {
      captureException(error, {
        captureContext: info ? { contexts: { nuxt: { info } } } : undefined,
        mechanism: { handled: false, type: `auto.function.nuxt.${source}-error` }
      })
    },
    // ID only — no email, name, or avatar. PII reduction: a Sentry breach
    // should leak as little user-correlatable info as possible, and `id`
    // is enough to join with our DB for triage.
    setUserId(id) {
      setUser(id === null ? null : { id })
    }
  }
}
