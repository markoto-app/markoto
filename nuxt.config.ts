// https://nuxt.com/docs/api/configuration/nuxt-config
import { fileURLToPath } from 'node:url'
import { observability, sync } from './shared/env/vars/sync'
import { analytics } from './shared/env/vars/analytics'
import { DAY_SECONDS } from './shared/config/units'
import { scanFlowDocPages } from './scripts/lib/flowDocPagesFs'
import { bool } from './shared/env/coerce'
import { docsRedirectRouteRules } from './shared/docs/docsRedirects'

// Test-only routes (server/api/_test/**: login shim, AI-tool exec, budget
// helpers) are compiled in only when the test harness builds with
// MARKOTO_TEST_BUILD=1. A release image never contains them, so a mistake in
// the runtime TEST_MODE gate (still checked by every one of them) can't
// expose a login bypass. scripts/selfhost-check.sh + CI check a production
// build for them.
const testBuild = bool.parse(process.env.MARKOTO_TEST_BUILD || 'false')

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
    '@nuxtjs/mcp-toolkit',
    // Same-origin copies of paged.js / Mermaid / KaTeX / highlight.js and
    // the web fonts under /vendor/, see shared/utils/vendor/vendorAssets.ts.
    './modules/vendor-assets',
    // Request types of the API handlers for the typed client
    // (.nuxt/types/api-inputs.d.ts, read by app/utils/api/client.ts).
    './modules/api-contract'
  ],

  // Nuxt Content in production builds (`nuxt dev` serves from Node and
  // keeps the auto-detected settings):
  // - sqliteConnector: the server always runs under Bun (nitro preset
  //   'bun'), but Nuxt Content picks its SQLite driver from the runtime
  //   doing the BUILD. `bun run build` runs the nuxt CLI through its node
  //   shebang, so wherever a real Node is installed (CI runners, dev
  //   machines) it baked in better-sqlite3, which Bun can't load: every
  //   /docs query answered 500. The Docker build only worked because the
  //   bun image's `node` is Bun itself.
  // - database.filename: the content database is written at runtime, and
  //   the app container's root filesystem is read-only (docs/SECURITY-
  //   HARDENING.md §C), so the default `.data/` path fails with
  //   SQLITE_CANTOPEN. /tmp is the container's tmpfs.
  $production: {
    content: {
      database: {
        type: 'sqlite',
        // The container's own tmpfs (one non-root user, read-only root), not a shared host /tmp.
        filename: '/tmp/markoto-content.sqlite' // NOSONAR container-private tmpfs, see the comment above
      },
      experimental: {
        sqliteConnector: 'bun'
      }
    }
  },

  // Nuxt scans only the top level of these dirs; the domain sub-folders are
  // scanned too so the auto-imports stay the same.
  imports: {
    dirs: ['composables/**', 'utils/**', '../shared/utils/**']
  },

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    // No @nuxt/fonts: it downloads the CSS font families from Google Fonts
    // at build time. Every web font is self-hosted from pinned Fontsource
    // packages instead (shared/utils/theme/themeFonts.ts, modules/vendor-assets.ts),
    // so a build needs no network beyond the package registry.
    fonts: false
  },

  // Flow slug → docs page that embeds it (`::flow{id="…"}`), scanned from
  // content/docs at build time. The <Flow> "Try next" card resolves
  // `manifest.next.slug` through this map and hides itself when a slug has
  // no page. See shared/docs/flowDocPages.ts.
  appConfig: {
    flowDocPages: scanFlowDocPages(fileURLToPath(new URL('./content/docs', import.meta.url)))
  },

  runtimeConfig: {
    // nuxt-auth-utils reads `runtimeConfig.session` (shape = h3's SessionConfig,
    // which requires `password`). `NUXT_SESSION_PASSWORD` env var populates
    // `session.password` via Nuxt's nested env→runtimeConfig resolution. The
    // old top-level `sessionPassword` was stale, left over from an earlier
    // config shape and never read by the runtime.
    session: {
      password: '',
      maxAge: 7 * DAY_SECONDS,
      cookie: {
        // Default `Secure: true` blocks cookie acceptance over plain HTTP
        // on non-localhost origins (e.g. LAN IP `192.168.x.x` for browser
        // testing). In dev we accept HTTP-only cookies; in prod, Traefik
        // terminates TLS and the upstream session cookie is set with
        // Secure via the response anyway.
        secure: process.env.NODE_ENV === 'production',
        // Defaults are already these, make them explicit so they survive
        // future h3 / nuxt-auth-utils default churn.
        httpOnly: true,
        path: '/',
        // `lax`, NOT `strict`. The OAuth callback (/auth/<provider>) is
        // reached by a redirect from the provider's site (github.com,
        // accounts.google.com, the OIDC IdP), so the whole chain counts
        // as a cross-site navigation: with `strict` the browser withholds
        // the freshly set session cookie on the redirect to `/`, and the
        // page after sign-in renders signed out (staging, 2026-11-03;
        // Firefox: "omitted because of a cross-site redirect"). `strict`
        // also made every link into the app from another site (Slack,
        // email) open signed out, so private documents looked missing.
        // `lax` still keeps the cookie off cross-site subrequests and
        // cross-site POST/PUT/PATCH/DELETE; state-changing /api calls are
        // additionally Origin-checked (server/middleware/csrf.ts), and GET
        // handlers never change state. Pinned by
        // tests/integration/endpoints/oidcLogin.test.ts.
        sameSite: 'lax'
        // Intentionally NO `domain`: the cookie defaults to the exact
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
    // Server code reads its configuration from the typed env registry
    // (`useEnv()`, shared/env/), not from here. runtimeConfig keeps only
    // what a module or the browser reads: `session` + `oauth`
    // (nuxt-auth-utils) and `public`. Their names and defaults are declared
    // in the registry too (tests/unit/env/runtimeConfig.test.ts pins the names).
    public: {
      syncUrl: '', // NUXT_PUBLIC_SYNC_URL
      // NUXT_PUBLIC_SYNC_HIDDEN_DISCONNECT_MS: a hidden editor tab lets go
      // of its sync connection after this long (0 = never).
      syncHiddenDisconnectMs: sync.vars.hiddenDisconnectMs.default,
      sentry: {
        dsn: '' // NUXT_PUBLIC_SENTRY_DSN
      },
      docs: {
        // NUXT_PUBLIC_DOCS_CHROME_DOMAIN: fake browser bar above the docs'
        // flow screenshots; a flow embed can pass its own.
        chromeDomain: observability.vars.docsChromeDomain.default
      },
      // Cookieless page analytics + click-id conversions (docs/operations-analytics.md).
      // Empty website id = the browser sends nothing.
      analytics: {
        websiteId: '', // NUXT_PUBLIC_ANALYTICS_WEBSITE_ID
        endpoint: analytics.vars.endpoint.default, // NUXT_PUBLIC_ANALYTICS_ENDPOINT
        adsConversions: analytics.vars.adsConversions.default // NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS
      },
      // Test-only: when true, useDocument.ts exposes the active
      // ydoc + ytext on `window.__DEBUG_*` so e2e specs can assert
      // against authoritative Y.Doc state instead of CM6's
      // viewport-virtualised .cm-content. ALWAYS false in prod
      // builds; flipped to true via NUXT_PUBLIC_EXPOSE_TEST_HANDLES=
      // 1 in the flow-test stack (see scripts/flows-ephemeral.ts +
      // tests/integration/setup/server.ts). Without this gate the
      // handles ship in production bundles too, minor surface-area
      // leak but a leak nonetheless.
      exposeTestHandles: false
    }
  },

  // The explorer's drag-and-drop libraries are client-side code that SSR
  // still imports (the composables are set up in components that render on
  // the server). Their subpath entries (`adapter/element-adapter`, ...) are
  // directories with their own package.json, which Nitro's NFT tracer does
  // not copy into .output: production then failed with "Cannot find
  // package". Bundling them into the server build avoids the external
  // lookup entirely.
  build: {
    transpile: ['@atlaskit/pragmatic-drag-and-drop', '@atlaskit/pragmatic-drag-and-drop-auto-scroll']
  },

  // Old /docs addresses (before the docs were regrouped into task-based
  // sections) answer with a 301 to the new one; the query string is kept.
  // The map lives in shared/docs/docsRedirects.ts.
  routeRules: docsRedirectRouteRules(),

  compatibilityDate: '2025-01-15',
  nitro: {
    // Relative to server/. See `testBuild` above.
    ignore: testBuild ? [] : ['api/_test/**'],
    // Nitro scans only the top level of shared/utils; scan its sub-folders too.
    imports: {
      dirs: [fileURLToPath(new URL('./shared/utils/**', import.meta.url))]
    },
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
    // Ship .gz + .br siblings of every compressible public asset (JS,
    // CSS, JSON, SVG) and let Nitro's static handler serve them by
    // Accept-Encoding. Nothing in front of the app compresses (Traefik
    // has no compress middleware), so without this the ~1.5 MB of
    // client JS would go over the wire raw.
    compressPublicAssets: true,
    // Native WebSocket route support for `/api/ai/dictate` (voice
    // dictation relay to Mistral Voxtral Realtime). Other WS traffic
    // (Hocuspocus Y.js sync) flows through its own standalone container,
    // not Nitro.
    experimental: {
      websocket: true,
      // Required by @nuxtjs/mcp-toolkit composables (useEvent, useMcpServer,
      // useMcpSession, useMcpLogger): they read the current event from
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
    // WebSocket (Hocuspocus) connects directly, no same-origin restriction.
    // In production, Traefik handles routing for all subdomains.
    devProxy: {
      '/_s3': {
        target: 'http://localhost:8333',
        changeOrigin: true
      }
    },
    // `ws` is a transitive dep (pulled in by `@mistralai/mistralai`'s
    // realtime sub-export for live dictation) that Nitro's NFT tracer doesn't follow
    // through the SDK's dist bundle, the output emits `import 'ws'`
    // but omits the package. `traceInclude` takes glob patterns (not
    // bare package names); `ws` itself has no deps so one glob is
    // enough. Tracked upstream in nitrojs/nitro#2923.
    externals: {
      // Point the tracer at ws's real entry, NFT then follows its imports
      // and copies the whole package (lib/*.js, browser.js, etc.). Pointing
      // at just package.json only copies that one file.
      traceInclude: ['node_modules/ws/index.js']
    }
  },

  // Vite's dev server has DNS-rebinding protection that 403s any request whose
  // Host header isn't in an allowlist. The sync-server container reaches the
  // Nuxt dev server via `host.docker.internal`, so without this entry every
  // activity-logger POST silently gets rejected before our middleware sees it.
  // Production doesn't care: Traefik terminates TLS and forwards the right Host.
  vite: {
    server: {
      allowedHosts: ['host.docker.internal', 'localhost']
    }
  },

  // Compiler options for the generated .nuxt/tsconfig.{app,server,shared,node}.json
  // (checked by `nuxt typecheck`). strict + noUncheckedIndexedAccess are already
  // Nuxt defaults here. noUnusedLocals / noUnusedParameters are still off: they
  // report a handful of leftovers that must be cleaned up before they can be
  // enabled.
  typescript: {
    tsConfig: {
      compilerOptions: {
        noFallthroughCasesInSwitch: true,
        noImplicitReturns: true
      }
    },
    // Nuxt's server tsconfig does not set this one by default (app/shared/node do).
    serverTsConfig: {
      compilerOptions: {
        noImplicitOverride: true
      }
    }
  },

  hooks: {
    // Production server entry: the bun preset's entry plus a request-body
    // size limit enforced by Bun (the preset buffers every body before
    // routing, so handlers can't refuse an oversized one in time, see the
    // file header). Set on the built `bun` Nitro only: the prerender and dev
    // Nitro instances need their own entries.
    'nitro:init'(nitro) {
      if (nitro.options.preset === 'bun') {
        nitro.options.entry = fileURLToPath(new URL('./server/runtime/bunEntry.ts', import.meta.url))
      }
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
      { code: 'en', language: 'en-US', name: 'English', files: ['en.json', 'errors/en.json'] },
      { code: 'de', language: 'de-DE', name: 'Deutsch', files: ['de.json', 'errors/de.json'] },
      { code: 'fr', language: 'fr-FR', name: 'Français', files: ['fr.json', 'errors/fr.json'] },
      { code: 'es', language: 'es-ES', name: 'Español', files: ['es.json', 'errors/es.json'] },
      { code: 'ja', language: 'ja-JP', name: '日本語', files: ['ja.json', 'errors/ja.json'] },
      { code: 'zh', language: 'zh-CN', name: '中文', files: ['zh.json', 'errors/zh.json'] }
    ],
    defaultLocale: 'en',
    // Lazy loading is the @nuxtjs/i18n v10 default whenever `locales[].files`
    // is set (it is, via langDir). `errors/<code>.json` holds the API error
    // texts (`apiErrors.*`, shared/api/errors/), merged over the UI strings.
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
    description: 'Collaborative markdown editor, read, search, and edit your docs from any MCP client.',
    sessions: true,
    defaultHandlerStrategy: 'orphans'
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'markoto',
      short_name: 'markoto',
      description: 'Collaborative Markdown Editor',
      // Bone (sumi-50): the app icon's own frame colour.
      theme_color: '#FAF8F4',
      background_color: '#FAF8F4',
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
      // the network: a cached 401 or stale token response would be worse
      // than an offline error page.
      navigateFallback: '/',
      navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
      cleanupOutdatedCaches: true,
      // The vendored third-party assets under /vendor/ (paged.js, Mermaid,
      // KaTeX, highlight.js, web fonts, shared/utils/vendor/vendorAssets.ts) stay
      // out of the precache: ~12 MB, and a page only ever needs a few of
      // them. They're runtime-cached on first use instead (below).
      globIgnores: ['**/node_modules/**/*', 'vendor/**'],
      // Runtime caching: the vendored static assets only. Docs, doc tokens,
      // AI, and upload endpoints intentionally bypass the SW, freshness
      // beats offline for collaborative state. First match wins:
      //   - per-family font stylesheets (/vendor/fonts/<family>.css) are the
      //     one unversioned name → serve cached, refresh in the background;
      //   - everything else sits under a versioned directory and never
      //     changes → cache first.
      // (The sandboxed, opaque-origin preview iframes aren't SW clients;
      // their requests use the HTTP cache, the files are `immutable`.)
      runtimeCaching: [{
        urlPattern: /\/vendor\/fonts\/[\w-]+\.css$/,
        handler: 'StaleWhileRevalidate',
        options: { cacheName: 'vendor-font-css', expiration: { maxEntries: 50 } }
      }, {
        urlPattern: /\/vendor\//,
        handler: 'CacheFirst',
        options: { cacheName: 'vendor-assets', expiration: { maxEntries: 400, maxAgeSeconds: 365 * 24 * 3600 } }
      }]
    },
    client: {
      // Lets us hook into the browser's `beforeinstallprompt` via `$pwa.install()`.
      installPrompt: true,
      // Hourly check for a fresh SW in the background, complements the
      // /api/version polling in version-check.client.ts, which covers the
      // non-PWA SSR path.
      periodicSyncForUpdates: 3600
    },
    // `autoUpdate` defaults to registering the SW in prod only. The dev
    // option lets us smoke-test PWA flows against the local stack (deploy/compose/compose.local.yml)
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
  // captured in prod stay minified, investigations have to map line
  // numbers by hand. Set those three vars in CI / build env (NOT in
  // the runtime `app` container, they're not needed at runtime).
  // See the operator runbook, kept outside this repository.
  sentry: {
    sourceMapsUploadOptions: {
      // `org` + `project` come from env. Empty / undefined disables
      // upload: dev / forks / contributors don't need a Sentry account
      // to build. authToken is read directly from `SENTRY_AUTH_TOKEN`
      // by the underlying @sentry/vite-plugin, no need to thread it.
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT
    }
  }
})
