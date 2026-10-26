// https://nuxt.com/docs/api/configuration/nuxt-config
import { KNOWLEDGE_PLATFORM_LIMITS, STRIPE_CONFIG_DEFAULTS } from './shared/config/tiers'

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
    '@sentry/nuxt/module',
    // MCP server: exposes our AI tools to external clients (Claude Desktop,
    // Cursor, ChatGPT app store) at /mcp via JSON-RPC. Tools live in
    // server/mcp/tools/*; auth is PAT-based in v1 (mcp_personal_tokens).
    // See server/mcp/AGENTS.md.
    '@nuxtjs/mcp-toolkit'
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
        secure: process.env.NODE_ENV === 'production',
        // Defaults are already these — make them explicit so they survive
        // future h3 / nuxt-auth-utils default churn.
        httpOnly: true,
        path: '/',
        // `strict` is what we want: the only same-site flow is the OAuth
        // callback (GitHub/Google → /auth/<provider> on our own domain),
        // which IS same-site, so strict allows the cookie to be set on
        // the redirect. `strict` blocks cookie attachment on cross-site
        // top-level navigations into the app, which means a deep-link
        // shared from another origin won't carry the session — but the
        // OAuth flow + normal app usage are unaffected. Tightening from
        // the implicit `lax` default also prevents leakage into the
        // `sync.${DOMAIN}` subdomain context: although we don't set
        // `domain`, browsers gate `lax` cookies on top-level navigation
        // schemes that `strict` rejects outright.
        sameSite: 'strict'
        // Intentionally NO `domain` — the cookie defaults to the exact
        // host that set it, which means it will never be auto-included
        // on requests to `sync.${DOMAIN}` (the Hocuspocus subdomain).
        // Hocuspocus auth rides on a JWT, not the session cookie, so a
        // host-only cookie is the right boundary here.
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
    // Phase 5: every Google API surface (Gemini text/image/embeddings,
    // Cloud STT) is gone. Only the dictation-WS JWT secret survives,
    // moved from `config.google.dictateJwtSecret` → `config.aiDictateJwtSecret`.
    // The env var renamed accordingly: NUXT_GOOGLE_DICTATE_JWT_SECRET
    // → NUXT_AI_DICTATE_JWT_SECRET.
    aiDictateJwtSecret: '', // NUXT_AI_DICTATE_JWT_SECRET — falls back to `jwtSecret` if unset
    // LiteLLM proxy — vendor-agnostic gateway for Phase-1+ migration.
    // Phase 1A only routes embeddings; Phase 4 adds chat, Phase 3 image
    // gen, Phase 5 voice metering. The proxy enforces per-key budgets
    // and unifies cost tracking across providers (Mistral / Jina / BFL).
    litellm: {
      url: '', // NUXT_LITELLM_URL — internal HTTP URL, e.g. http://litellm:4000 (prod) / http://localhost:4000 (dev with host bun)
      masterKey: '', // NUXT_LITELLM_MASTER_KEY — admin key; per-user virtual keys arrive in Phase 6
      // Embedding model + dims used when the knowledge pipeline routes
      // through LiteLLM. jina-embeddings-v5-text-nano is natively 768-d
      // (perfect fit for the existing pgvector(768) HNSW index — zero
      // DDL needed). Smallest in Jina's v5 family = fastest + cheapest;
      // quality is sufficient for writing-doc retrieval. Bumping to
      // jina-embeddings-v5-text-small (1024-d native, MRL-truncate to
      // 768) is a config-only change if quality becomes the bottleneck.
      embeddingsModel: 'jina-embeddings-v5-text-nano', // NUXT_LITELLM_EMBEDDINGS_MODEL
      embeddingsDims: 768, // NUXT_LITELLM_EMBEDDINGS_DIMS
      // Self-hosters: swap the model/size via env. The pgvector column is
      // re-typed to match at boot when empty (server/utils/embeddingColumn.ts);
      // max 2000 dims (HNSW). See docs/AI-MODELS.md#embeddings.
      embeddingsSendDimensions: 'auto', // NUXT_LITELLM_EMBEDDINGS_SEND_DIMENSIONS — auto|true|false (auto = Jina only)
      embeddingsTaskHints: 'auto', // NUXT_LITELLM_EMBEDDINGS_TASK_HINTS — Jina `task` param; auto|true|false (auto = Jina only)
      embeddingsUpstreamModel: '', // NUXT_LITELLM_EMBEDDINGS_UPSTREAM_MODEL — label only (version tag); mirrors the proxy's EMBEDDINGS_UPSTREAM_MODEL
      // Phase 2 transcribe model (Voxtral Mini Transcribe 2, $0.003/min).
      // Wrapped as a fake chat completion via custom_handlers.py to fix
      // LiteLLM's transcription cost-tracking gap with Mistral's response
      // shape. The voice-prompt button hits this when
      // NUXT_AI_TRANSCRIBE_PROVIDER=voxtral.
      transcribeModel: 'voxtral-mini-transcribe', // NUXT_LITELLM_TRANSCRIBE_MODEL
      // Phase 3 image model (BFL FLUX.2 [pro], $0.030/1024² image,
      // EU-pinned). Wrapped as a fake chat completion via
      // custom_handlers.py so OSS LiteLLM tracks spend properly (the
      // /v1/images/generations cost path doesn't fire spend-logger
      // callbacks for custom providers). Caller sends prompt + width +
      // height in the message content.
      imageModel: 'flux-2-pro', // NUXT_LITELLM_IMAGE_MODEL
      imageDefaultWidth: 1024, // NUXT_LITELLM_IMAGE_DEFAULT_WIDTH
      imageDefaultHeight: 1024, // NUXT_LITELLM_IMAGE_DEFAULT_HEIGHT
      // Phase 4 text + vision model (Mistral Small 4.0). Cheaper than
      // the pre-Phase-5 Gemini Flash-Lite path (-45%), 256k context,
      // native vision input, OpenAI-compatible streaming tool calls.
      // Same model handles view_image / view_pages — no two-model split.
      textModel: 'mistral-small-2603', // NUXT_LITELLM_TEXT_MODEL
      // Phase 5 voice-tick metering stub. Each "call" against this fake
      // chat model bills $0.006 (1 minute of Voxtral Realtime audio) —
      // see infra/litellm/custom_handlers.py:VoxtralTickProvider. The
      // dictate WS orchestrator hits this once per minute of audio.
      // Real Voxtral Realtime transcription stays direct from our backend
      // via @mistralai/mistralai/extra/realtime SDK — this stub exists
      // only so spend lands in the same per-key budget as everything else.
      realtimeTickModel: 'voxtral-realtime-tick' // NUXT_LITELLM_REALTIME_TICK_MODEL
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
    // Per-tier caps are NOT mirrored here: enforcement resolves them
    // via `server/utils/tierConfig.ts#getTiers()` (committed defaults
    // in `shared/config/tiers.ts` + TIER_* env overrides), and the
    // client fetches the resolved map from GET /api/billing/tiers.
    // Knowledge-upload platform limits that don't vary by plan
    // (single-file size, chunker ceiling, failed-row TTL). Tier-
    // varying caps (file count, bytes, etc.) live in the tier caps (see shared/config/tiers.ts).
    knowledge: KNOWLEDGE_PLATFORM_LIMITS,
    // Stripe config — all empty in dev, set via NUXT_STRIPE_* in prod.
    // Only read when NUXT_BILLING_ENABLED=true. The billing-mode flags
    // themselves (NUXT_BILLING_ENABLED / NUXT_PLANS_COMING_SOON) are NOT
    // runtimeConfig keys: they're parsed from the environment by
    // `shared/config/billingMode.ts` (server guards + SSR-hydrated
    // `useBillingMode()`), so enforcement utils that run outside Nitro
    // (repos tests) see the same value. See server/utils/billingMode.ts.
    stripe: STRIPE_CONFIG_DEFAULTS,
    // Public origin of this deployment (e.g. https://markoto.app), used
    // to build absolute links in emails (waitlist confirm/unsubscribe).
    // Set via NUXT_SITE_URL in prod. Empty → derived from the request's
    // Host header, which is only trustworthy behind a host-matching
    // proxy rule (as in docker-compose.prod.yml's Traefik router).
    siteUrl: '',
    // Transactional email. All empty in dev (the helper falls back
    // to a console log via `[email-stub]`); set via NUXT_EMAIL_* in
    // prod to enable real delivery. See `server/utils/email/sendEmail.ts`
    // for the dispatch shape. Today supports `provider: 'resend'`;
    // adding a second provider is one branch in that file.
    email: {
      // Empty = stub mode. Set to 'resend' to enable real delivery
      // (requires apiKey + fromAddress to also be set).
      provider: '',
      // Provider API key. Resend keys start `re_…`.
      apiKey: '',
      // Verified sending address — must be on a domain whose SPF +
      // DKIM DNS records are set in the provider. Format: `Name
      // <address@domain>`. NEVER set this to an unverified domain;
      // the provider will silently bounce.
      fromAddress: ''
    },
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
      },
      // Test-only: when true, useDocument.ts exposes the active
      // ydoc + ytext on `window.__DEBUG_*` so e2e specs can assert
      // against authoritative Y.Doc state instead of CM6's
      // viewport-virtualised .cm-content. ALWAYS false in prod
      // builds; flipped to true via NUXT_PUBLIC_EXPOSE_TEST_HANDLES=
      // 1 in the flow-test stack (see scripts/flows-ephemeral.ts +
      // tests/integration/setup/server.ts). Without this gate the
      // handles ship in production bundles too — minor surface-area
      // leak but a leak nonetheless.
      exposeTestHandles: false
    }
  },

  compatibilityDate: '2025-01-15',
  nitro: {
    // Global error sanitiser. Every uncaught error from any /api/*
    // endpoint flows through `server/error.ts` before the response
    // is sent. 5xx errors are stripped of their original message +
    // stack (only `{ statusCode, statusMessage, message:'Something
    // went wrong on our side', data:{code:'internal'} }` reaches
    // the client); 4xx errors keep their author-controlled message
    // (toast copy). The full error is Sentry-captured + console-
    // logged server-side regardless. Belt-and-braces against pg
    // errors / drizzle queries leaking to the wire.
    errorHandler: '~~/server/error.ts',
    // Native WebSocket route support for `/api/ai/dictate` (voice
    // dictation relay to Mistral Voxtral Realtime). Other WS traffic
    // (Hocuspocus Y.js sync) flows through its own standalone container,
    // not Nitro.
    experimental: {
      websocket: true,
      // Required by @nuxtjs/mcp-toolkit composables (useEvent, useMcpServer,
      // useMcpSession, useMcpLogger) — they read the current event from
      // Nitro's async-local storage. Without this they throw at runtime.
      asyncContext: true
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
    // `ws` is a transitive dep (originally pulled in by `@google/genai`
    // pre-Phase-5; now by `@mistralai/mistralai`'s realtime sub-export
    // for live dictation) that Nitro's NFT tracer doesn't follow
    // through the SDK's dist bundle — the output emits `import 'ws'`
    // but omits the package. `traceInclude` takes glob patterns (not
    // bare package names); `ws` itself has no deps so one glob is
    // enough. Tracked upstream in nitrojs/nitro#2923.
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

  // MCP server config. Tools, resources, and prompts auto-discovered from
  // server/mcp/{tools,resources,prompts}/. Sessions on so external clients
  // can stash a docId index across calls; defaultHandlerStrategy: 'orphans'
  // means /mcp exposes everything not attached to a named handler.
  mcp: {
    name: 'markoto',
    description: 'Collaborative markdown editor — read, search, and edit your docs from any MCP client.',
    sessions: true,
    defaultHandlerStrategy: 'orphans'
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
  },

  // @sentry/nuxt source-map upload integration. The module reads
  // `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` from the BUILD-
  // TIME environment (the `bun run build` step in the Docker builder
  // stage). When missing, the build still succeeds but stack traces
  // captured in prod stay minified — investigations have to map line
  // numbers by hand. Set those three vars in CI / build env (NOT in
  // the runtime `app` container — they're not needed at runtime).
  // See docs/DEPLOY.md.
  sentry: {
    sourceMapsUploadOptions: {
      // `org` + `project` come from env. Empty / undefined disables
      // upload — dev / forks / contributors don't need a Sentry account
      // to build. authToken is read directly from `SENTRY_AUTH_TOKEN`
      // by the underlying @sentry/vite-plugin — no need to thread it.
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT
    }
  }
})
