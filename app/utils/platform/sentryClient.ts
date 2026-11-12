import { browserTracingIntegration, captureException, init, setUser } from '@sentry/nuxt'
import type { Router } from 'vue-router'
import { sentryScrubOptions } from '~~/shared/utils/security/sentryScrub'

// The browser Sentry SDK, loaded on demand by `plugins/sentry.client.ts`
// (after the page is idle, or at once when an error happens first), so the
// SDK (~40 KB gzip) stays out of the entry chunk and off the first paint
// of marketing pages. Only that plugin may import this module.

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
    // A small slice of transactions spots hot paths without burning the
    // Sentry quota. Dev samples everything so distributed traces
    // (browser → app → renderer / sync-server) are always visible.
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
    // Errors, sampled transactions and breadcrumbs share the server's
    // scrubber. Breadcrumbs matter most here: fetch ones carry presigned
    // S3 URLs and navigation ones `?token=` invite links and render tokens.
    // `sendDefaultPii` is false. No session replay or feedback integration
    // is configured: only errors and the sampled traces above leave the browser.
    ...sentryScrubOptions
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
