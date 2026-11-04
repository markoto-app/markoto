import type { SentryClient, SentryErrorReport } from '~/utils/sentryClient'

// Browser error reporting, loaded late.
//
// The browser SDK used to come in through @sentry/nuxt's client plugins
// (picked up from a root `sentry.client.config.ts`), which put ~40 KB gzip
// of Sentry into the entry chunk of every page — downloaded and run
// before a marketing page could paint its hero. The module now only does
// the server side (`sentry.server.config.ts`); this plugin starts the
// browser SDK (`utils/sentryClient.ts`) once the page is idle, or at once
// when an error comes first.
//
// Nothing is lost while it loads: errors from Vue (`vue:error`), from Nuxt
// (`app:error`) and from the window (`error` / `unhandledrejection`; this
// plugin's listeners stay the only ones — the SDK's GlobalHandlers
// integration is off) are queued and sent once it runs. Errors before the
// Nuxt app starts are missed, as before (the SDK used to start in a plugin
// too). Only initialises when `NUXT_PUBLIC_SENTRY_DSN` is set, so dev /
// local / self-hosted instances without a DSN load no Sentry code at all.
// Also binds the signed-in user's id (ID only, no PII) to the scope.

function isNuxtClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const status: unknown = Reflect.get(error, 'statusCode')
  // Same filter as @sentry/nuxt: 3xx/4xx Nuxt errors (404 pages, redirects) aren't bugs.
  return typeof status === 'number' && status >= 300 && status < 500
}

function whenIdle(fn: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(fn, { timeout: 4000 })
  } else {
    setTimeout(fn, 1500)
  }
}

export default defineNuxtPlugin({
  name: 'markoto:sentry',
  parallel: true,
  setup(nuxtApp) {
    const dsn = useRuntimeConfig().public.sentry?.dsn
    if (!dsn) return

    let client: SentryClient | null = null
    let loading: Promise<void> | null = null
    const queue: SentryErrorReport[] = []

    const onWindowError = (e: ErrorEvent) => capture({ error: e.error ?? e.message, source: 'window' })
    const onRejection = (e: PromiseRejectionEvent) => capture({ error: e.reason, source: 'window' })
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onRejection)

    function load(): Promise<void> {
      loading ??= import('~/utils/sentryClient').then((m) => {
        const started = m.startSentry({ dsn, router: nuxtApp.$router, production: !import.meta.dev })
        client = started
        for (const r of queue.splice(0)) started.report(r)
        const { loggedIn, user } = useUserSession()
        watch([loggedIn, () => user.value?.id], ([isLoggedIn, userId]) => {
          // String: Sentry's user-id field is typed string (server tags use String(userId) too).
          started.setUserId(isLoggedIn && userId != null ? String(userId) : null)
        }, { immediate: true })
      }).catch(() => {
        // Chunk failed to load (offline, deploy skew): no reporting this visit.
      })
      return loading
    }

    function capture(r: SentryErrorReport): void {
      if (client) {
        client.report(r)
        return
      }
      if (queue.length < 20) queue.push(r)
      void load()
    }

    nuxtApp.hook('vue:error', (error, _instance, info) => {
      capture({ error, info, source: 'vue' })
    })
    nuxtApp.hook('app:error', (error) => {
      if (isNuxtClientError(error)) return
      capture({ error, source: 'app' })
    })
    nuxtApp.hook('app:suspense:resolve', () => {
      whenIdle(() => {
        void load()
      })
    })
  }
})
