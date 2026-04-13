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
    sessionPassword: '',
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
    anthropic: {
      apiKey: '',                         // NUXT_ANTHROPIC_API_KEY
      model: 'claude-sonnet-4-6',         // NUXT_ANTHROPIC_MODEL — agentic prompt loop (tool orchestration, web_search, multi-edit)
      rewriteModel: 'claude-haiku-4-5'    // NUXT_ANTHROPIC_REWRITE_MODEL — one-shot selection rewrites (Haiku: cheap + fast, no tools)
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
    lazy: true,
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
