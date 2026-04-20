// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // Dev proxy: mirror production Traefik routing through localhost:3000
  // so the browser only talks to one origin (no CORS issues).
  // In production, Traefik handles these routes to the correct containers.

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    'nuxt-auth-utils',
    '@nuxtjs/i18n',
    '@vueuse/nuxt',
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vite-pwa/nuxt',
    'nuxt-codemirror',
    '@sentry/nuxt/module'
  ],

  devtools: {
    enabled: true
  },

  app: {
    head: { title: 'YPad — Collaborative Markdown' }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    // nuxt-auth-utils reads `runtimeConfig.session` (shape = h3's SessionConfig,
    // which requires `password`). `NUXT_SESSION_PASSWORD` env var populates
    // `session.password` via Nuxt's nested env→runtimeConfig resolution. The
    // old top-level `sessionPassword` was stale — left over from an earlier
    // config shape and never read by the runtime.
    session: {
      password: '',
      maxAge: 60 * 60 * 24 * 7 // 7 days
    },
    oauth: {
      github: {
        clientId: '',
        clientSecret: ''
      },
      google: {
        clientId: '',
        clientSecret: ''
      }
    },
    s3: {
      endpoint: '',
      accessKey: '',
      secretKey: '',
      bucket: 'ypad'
    },
    google: {
      apiKey: '', // NUXT_GOOGLE_API_KEY
      model: 'gemini-3.1-flash-lite-preview', // NUXT_GOOGLE_MODEL — agentic prompt loop (tool use, grounding via sub-call)
      rewriteModel: 'gemini-2.5-flash-lite' // NUXT_GOOGLE_REWRITE_MODEL — one-shot selection rewrites (cheapest tier)
    },
    jwtSecret: '',
    // Optional: previous JWT_SECRET, accepted by verifiers during rotation.
    // See docs/SECRETS-ROTATION.md.
    jwtSecretPrevious: '',
    internalApiSecret: '',
    // Optional: previous INTERNAL_API_SECRET, accepted during rotation.
    internalApiSecretPrevious: '',
    markitdownUrl: '',
    // Internal HTTP URL of the Hocuspocus sync-server (for server→server calls).
    // In Docker Compose: http://sync:4001. In dev: http://localhost:4001.
    syncInternalUrl: 'http://localhost:4001',
    // Inactive-doc auto-cleanup thresholds (in days). Anonymous docs age
    // out at the shorter TTL; owner-owned docs get the longer grace.
    // Workspace-attached docs are never auto-reaped. 0 disables the sweep
    // entirely. Override via NUXT_INACTIVE_DOC_TTL_DAYS / _OWNED_TTL_DAYS.
    inactiveDocTtlDays: 180,
    inactiveDocOwnedTtlDays: 365,
    public: {
      syncUrl: '',
      sentry: {
        // GlitchTip / Sentry DSN for browser error reporting. Empty in dev;
        // set via NUXT_PUBLIC_SENTRY_DSN in prod .env.
        dsn: ''
      }
    }
  },

  compatibilityDate: '2025-01-15',
  nitro: {
    // Match the runtime: the Dockerfile's runtime stage runs the output with
    // `bun`, and packages like lib0 have `bun` conditional exports that
    // resolve to different files than the `node` condition. The default
    // node-server preset traces via the `node` condition and ships a
    // module graph that Bun then fails to execute. See
    // https://bun.com/docs/guides/ecosystem/nuxt.
    preset: 'bun',
    // Dev proxy: forward S3 requests through localhost:3000 to avoid CORS.
    // WebSocket (Hocuspocus) connects directly — no same-origin restriction.
    // In production, Traefik handles routing for all subdomains.
    devProxy: {
      '/_s3': {
        target: 'http://localhost:8333',
        changeOrigin: true
      }
    },
    // `ws` is a transitive dep of `@google/genai` that Nitro's NFT tracer
    // doesn't follow through the SDK's dist bundle — the output emits
    // `import 'ws'` but omits the package. `traceInclude` takes glob
    // patterns (not bare package names); `ws` itself has no deps so one
    // glob is enough. Tracked upstream in nitrojs/nitro#2923.
    externals: {
      // Point the tracer at ws's real entry — NFT then follows its imports
      // and copies the whole package (lib/*.js, browser.js, etc.). Pointing
      // at just package.json only copies that one file.
      traceInclude: ['node_modules/ws/index.js']
    }
  },

  // Vite's dev server has DNS-rebinding protection that 403s any request whose
  // Host header isn't in an allowlist. The sync-server container reaches the
  // Nuxt dev server via `host.docker.internal`, so without this entry every
  // activity-logger POST silently gets rejected before our middleware sees it.
  // Production doesn't care — Traefik terminates TLS and forwards the right Host.
  vite: {
    server: {
      allowedHosts: ['host.docker.internal', 'localhost']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  i18n: {
    locales: [
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
      { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
      { code: 'es', language: 'es-ES', name: 'Español', file: 'es.json' },
      { code: 'ja', language: 'ja-JP', name: '日本語', file: 'ja.json' },
      { code: 'zh', language: 'zh-CN', name: '中文', file: 'zh.json' }
    ],
    defaultLocale: 'en',
    // `lazy` was removed in @nuxtjs/i18n v10 — lazy loading is now the default
    // whenever `locales[].file` is set (which it is for us, via langDir).
    langDir: 'locales/',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'ypad_locale',
      fallbackLocale: 'en'
    }
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'YPad',
      short_name: 'YPad',
      description: 'Collaborative Markdown Editor',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      display: 'standalone',
      start_url: '/',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      ]
    },
    workbox: {
      // SPA fallback: any navigation miss serves the app shell so deep links
      // (e.g. /d/abc123) work offline. Denylist keeps API and OAuth flows on
      // the network — a cached 401 or stale token response would be worse
      // than an offline error page.
      navigateFallback: '/',
      navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
      cleanupOutdatedCaches: true,
      // Runtime caching: static CDN assets only. Docs, doc tokens, AI, and
      // upload endpoints intentionally bypass the SW — freshness beats
      // offline for collaborative state.
      runtimeCaching: [{
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
        handler: 'CacheFirst',
        options: { cacheName: 'cdn-cache', expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 } }
      }]
    },
    client: {
      // Lets us hook into the browser's `beforeinstallprompt` via `$pwa.install()`.
      installPrompt: true,
      // Hourly check for a fresh SW in the background — complements the
      // /api/version polling in version-check.client.ts, which covers the
      // non-PWA SSR path.
      periodicSyncForUpdates: 3600
    },
    // `autoUpdate` defaults to registering the SW in prod only. The dev
    // option lets us smoke-test PWA flows against docker-compose.local
    // without shipping a prod build.
    devOptions: {
      enabled: false,
      type: 'module'
    }
  }
})
