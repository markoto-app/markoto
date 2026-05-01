// https://nuxt.com/docs/api/configuration/nuxt-config
import { TIERS, KNOWLEDGE_PLATFORM_LIMITS, STRIPE_CONFIG_DEFAULTS } from './shared/config/tiers'

export default defineNuxtConfig({
  // Dev proxy: mirror production Traefik routing through localhost:3000
  // so the browser only talks to one origin (no CORS issues).
  // In production, Traefik handles these routes to the correct containers.

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxt/content',
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
    head: { title: 'markoto — Collaborative Markdown' }
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
      maxAge: 60 * 60 * 24 * 7, // 7 days
      cookie: {
        // Default `Secure: true` blocks cookie acceptance over plain HTTP
        // on non-localhost origins (e.g. LAN IP `192.168.x.x` for browser
        // testing). In dev we accept HTTP-only cookies; in prod, Traefik
        // terminates TLS and the upstream session cookie is set with
        // Secure via the response anyway.
        secure: process.env.NODE_ENV === 'production'
      }
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
      // Two keys because Gemini and Cloud Speech-to-Text bill separately
      // and we restrict each key to a single API in GCP for blast-radius
      // containment.
      geminiApiKey: '', // NUXT_GOOGLE_GEMINI_API_KEY
      speechToTextApiKey: '', // NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY
      // Separate JWT secret for the dictation WS token. Falls back to
      // the top-level `jwtSecret` (Hocuspocus) if unset, but you want
      // this set in prod so a compromised Hocuspocus secret doesn't
      // also forge dictation tokens (and vice versa).
      dictateJwtSecret: '', // NUXT_GOOGLE_DICTATE_JWT_SECRET
      model: 'gemini-3.1-flash-lite-preview', // NUXT_GOOGLE_MODEL — agentic prompt loop (tool use, grounding via sub-call). Also handles selection-scoped rewrites through the unified agentic flow.
      imageModel: 'gemini-3.1-flash-image-preview', // NUXT_GOOGLE_IMAGE_MODEL — image generation for the `generate_image` tool. Alternatives: `gemini-2.5-flash-image` (stable, older), `gemini-3-pro-image-preview` (higher quality, slower, more expensive).
      // 0.5K is the cheapest tier ($0.045/image vs $0.067 at 1K).
      // Sharp enough for inline paged.js render + PDF export at normal
      // zoom. Don't expose as a user option — every bump up the ladder
      // is a direct cost hit. See §15 in AGENTS.md.
      imageResolution: '0.5K', // NUXT_GOOGLE_IMAGE_RESOLUTION — values: '0.5K', '1K', '2K', '4K'
      // Embedding model for workspace knowledge. `gemini-embedding-2-preview`
      // is the latest multimodal embedding model (text/image/video/audio/
      // documents into a unified space). We use it text-only today.
      // `outputDimensionality: 768` via MRL — fits pgvector HNSW (2000-dim
      // cap) and is measurably cheaper than 1536/3072 with little recall
      // cost at typical corpus sizes. Bump via NUXT_GOOGLE_EMBEDDING_MODEL;
      // if you change dimensions you must also bump `embeddingVersion`
      // in the processing pipeline to trigger a re-embed.
      embeddingModel: 'gemini-embedding-2-preview', // NUXT_GOOGLE_EMBEDDING_MODEL
      embeddingDims: 768, // NUXT_GOOGLE_EMBEDDING_DIMS
      // Google Cloud Speech-to-Text model for live dictation. v1 accepts
      // API-key auth without needing a project id in the path (unlike v2),
      // which keeps the server code simple. `latest_long` is the default
      // streaming model tuned for dictation-length audio; `chirp_2` is
      // v2-only so we can't use it via API-key auth here.
      speechModel: 'latest_long', // NUXT_GOOGLE_SPEECH_MODEL
      // NUXT_GOOGLE_THINKING_BUDGET — tokens the model may spend on internal
      // reasoning before producing its response. 0 disables thinking entirely
      // (cheapest + fastest, recommended default). Typical "minimal" budgets
      // are 128–512 for noticeable-but-bounded gains on multi-step edits.
      // Applied only to the main agentic loop — rewrites and sub-calls stay
      // thinking-free. Nitro parses env-var strings with `destr`, so bare
      // numbers come through as numbers.
      thinkingBudget: 0
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
    // Internal HTTP URL of the Playwright renderer container (PDF + per-page
    // PNGs). Same network shape as syncInternalUrl: dev = host:9000, compose
    // = http://renderer:9000. Empty disables the user-facing /api/docs/:id/pdf
    // endpoint and the AI's view_pages tool — useful for tests that don't
    // spin up the renderer container.
    rendererInternalUrl: 'http://localhost:9000',
    // Anonymous-doc auto-cleanup threshold (in days). Only docs with no
    // owner AND no workspace are reaped once last_active is past this
    // many days — owned docs (any age) and workspace-attached docs are
    // never auto-reaped. 0 disables sweeping entirely. Override via
    // NUXT_INACTIVE_DOC_TTL_DAYS.
    inactiveDocTtlDays: 180,
    // Per-tier caps. Single source of truth in
    // `shared/config/tiers.ts`; enforcement sites resolve via plan
    // lookup (`TIERS[plan].*`). Numbers documented in AGENTS.md §15.
    tiers: TIERS,
    // Knowledge-upload platform limits that don't vary by plan
    // (single-file size, chunker ceiling, failed-row TTL). Tier-
    // varying caps (file count, bytes, etc.) live inside TIERS.
    knowledge: KNOWLEDGE_PLATFORM_LIMITS,
    // Stripe config — all empty in dev, set via NUXT_STRIPE_* in prod.
    stripe: STRIPE_CONFIG_DEFAULTS,
    public: {
      syncUrl: '',
      sentry: {
        // sentry.io DSN for browser error reporting. Empty in dev;
        // set via NUXT_PUBLIC_SENTRY_DSN in prod .env.
        dsn: ''
      },
      docs: {
        // Cosmetic domain shown in the fake browser-bar above embedded
        // flow screenshots. Override per-environment via
        // NUXT_PUBLIC_DOCS_CHROME_DOMAIN if the docs subdomain differs
        // from the app subdomain. The <Flow> component reads this as
        // its default; individual flow embeds can still pass their own
        // chrome-domain prop.
        chromeDomain: 'markoto.app'
      }
    }
  },

  compatibilityDate: '2025-01-15',
  nitro: {
    // Native WebSocket route support for `/api/ai/dictate` (voice
    // dictation relay to Google Cloud Speech-to-Text). Other WS traffic
    // (Hocuspocus Y.js sync) flows through its own standalone container,
    // not Nitro.
    experimental: {
      websocket: true
    },
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
      name: 'markoto',
      short_name: 'markoto',
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
