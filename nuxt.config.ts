// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // Dev proxy: mirror production Traefik routing through localhost:3000
  // so the browser only talks to one origin (no CORS issues).
  // In production, Traefik handles these routes to the correct containers.
  nitro: {
    // Dev proxy: forward S3 requests through localhost:3000 to avoid CORS.
    // WebSocket (Hocuspocus) connects directly — no same-origin restriction.
    // In production, Traefik handles routing for all subdomains.
    devProxy: {
      '/_s3': {
        target: 'http://localhost:8333',
        changeOrigin: true
      }
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

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    'nuxt-auth-utils',
    '@nuxtjs/i18n',
    '@vueuse/nuxt',
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vite-pwa/nuxt',
    'nuxt-codemirror'
  ],

  devtools: {
    enabled: true
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
      maxAge: 60 * 60 * 24 * 7   // 7 days
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
      apiKey: '',                                  // NUXT_GOOGLE_API_KEY
      model: 'gemini-3.1-flash-lite-preview',      // NUXT_GOOGLE_MODEL — agentic prompt loop (tool use, grounding via sub-call)
      rewriteModel: 'gemini-2.5-flash-lite'        // NUXT_GOOGLE_REWRITE_MODEL — one-shot selection rewrites (cheapest tier)
    },
    jwtSecret: '',
    internalApiSecret: '',
    pandocUrl: '',
    // Internal HTTP URL of the Hocuspocus sync-server (for server→server calls).
    // In Docker Compose: http://sync:4001. In dev: http://localhost:4001.
    syncInternalUrl: 'http://localhost:4001',
    public: {
      syncUrl: ''
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
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    },
    workbox: {
      navigateFallback: undefined,
      runtimeCaching: [{
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
        handler: 'CacheFirst',
        options: { cacheName: 'cdn-cache', expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 } }
      }]
    }
  },

  app: {
    head: { title: 'YPad — Collaborative Markdown' }
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
