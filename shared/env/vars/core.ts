import { bool, int, nonNegativeInt, oneOf, positiveInt, port, string, url } from '../coerce'
import { defineNamespace, v } from '../define'

export const core = defineNamespace({
  name: 'core',
  title: 'Instance',
  intro: 'Public address and runtime mode of this instance.',
  vars: {
    nodeEnv: v({
      name: 'NODE_ENV',
      type: string,
      doc: '`production` turns on production checks (required NUXT_SITE_URL, Postgres TLS, Secure cookies); the images set it.',
      services: ['app', 'sync', 'renderer'],
      scope: 'both',
      notPassed: 'set by each image / the dev command; compose overrides it only on some services'
    }),
    logLevel: v({
      name: 'LOG_LEVEL',
      type: oneOf(['debug', 'info', 'warn', 'error']),
      default: 'info',
      doc: 'Minimum level the app, the sync server and the renderer log (`debug`, `info`, `warn`, `error`). Production writes one JSON object per line.',
      services: ['app', 'sync', 'renderer'],
      scope: 'both',
      notPassed: 'code default is enough; an operator who wants debug output adds it to the container environment'
    }),
    siteUrl: v({
      name: 'NUXT_SITE_URL',
      type: url(),
      doc: 'Public origin of this instance (https://docs.example.org). Email links are built only from it, never from the request Host.',
      services: ['app', 'sync'],
      scope: 'both',
      required: 'production'
    }),
    canonicalSiteUrl: v({
      name: 'NUXT_CANONICAL_SITE_URL',
      type: url(),
      doc: 'Origin named by canonical / og:url / JSON-LD / sitemap. Empty = NUXT_SITE_URL (staging renders https://markoto.app).',
      services: ['app'],
      scope: 'hosted'
    }),
    docsCanonicalBase: v({
      name: 'NUXT_DOCS_CANONICAL_BASE',
      type: url(),
      doc: 'Origin the /docs pages\' canonical links point to off the marketing site. Unset = https://markoto.app; set but empty = this instance.',
      services: ['app'],
      scope: 'self-host',
      emptyIsValue: true,
      notPassed: 'self-host compose only; the hosted instance is the marketing site and always self-canonical'
    }),
    siteIndexable: v({
      name: 'NUXT_SITE_INDEXABLE',
      type: bool,
      default: true,
      doc: 'false keeps the instance out of search engines (robots.txt Disallow: / + X-Robots-Tag: noindex everywhere). Staging renders false.',
      services: ['app'],
      scope: 'both'
    }),
    marketingSite: v({
      name: 'NUXT_MARKETING_SITE_ENABLED',
      type: bool,
      default: false,
      doc: '"This instance is markoto.app": product tour at /, sitemap, JSON-LD, hosted-only marketing pages.',
      services: ['app'],
      scope: 'hosted',
      deprecatedNames: ['NUXT_PRODUCT_TOUR_ENABLED']
    }),
    trustedProxyHops: v({
      name: 'NUXT_TRUSTED_PROXY_HOPS',
      type: nonNegativeInt,
      default: 1,
      doc: 'Reverse proxies in front of the app and sync server; the client IP is the N-th X-Forwarded-For entry from the right (0 = socket address).',
      services: ['app', 'sync'],
      scope: 'both',
      aliases: { sync: 'TRUSTED_PROXY_HOPS' }
    }),
    adminUserEmails: v({
      name: 'NUXT_ADMIN_USER_EMAILS',
      type: string,
      default: '',
      doc: 'Comma-separated emails promoted to admin at their next sign-in with a VERIFIED address (case-insensitive).',
      services: ['app'],
      scope: 'both'
    })
  }
})

export const server = defineNamespace({
  name: 'server',
  title: 'App server',
  intro: 'Bun HTTP server of the app container (server/runtime/bunEntry.ts reads these before Nitro starts).',
  vars: {
    port: v({
      name: 'PORT',
      type: port,
      default: 3000,
      doc: 'Port the app listens on (NITRO_PORT wins when set).',
      services: ['app'],
      scope: 'both',
      notPassed: 'the image listens on 3000'
    }),
    nitroPort: v({
      name: 'NITRO_PORT',
      type: port,
      doc: 'Overrides PORT for the app server.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the image listens on 3000'
    }),
    host: v({
      name: 'NITRO_HOST',
      type: string,
      doc: 'Address the app server binds (HOST is read as a fallback). Default: all interfaces.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the image binds all interfaces'
    }),
    hostFallback: v({
      name: 'HOST',
      type: string,
      doc: 'Fallback for NITRO_HOST.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the image binds all interfaces'
    }),
    idleTimeoutSeconds: v({
      name: 'NITRO_BUN_IDLE_TIMEOUT',
      type: int({ min: 1, max: 255 }),
      default: 120,
      doc: 'Seconds an HTTP connection may stay silent, including while a slow request (PDF render, import) is still working. Must stay above the 100 s PDF render deadline.',
      services: ['app'],
      scope: 'both',
      notPassed: 'the default covers the slowest route'
    }),
    maxRequestBodyBytes: v({
      name: 'NITRO_MAX_REQUEST_BODY_BYTES',
      type: positiveInt,
      default: 53477376,
      doc: 'Largest request body on any route, enforced by Bun before buffering (51 MiB = a 50 MB import plus form framing).',
      services: ['app'],
      scope: 'both',
      notPassed: 'default fits the 50 MB import limit'
    }),
    migrationsDir: v({
      name: 'DRIZZLE_MIGRATIONS_DIR',
      type: string,
      default: './drizzle',
      doc: 'Directory the boot migration reads (the image ships ./drizzle).',
      services: ['app'],
      scope: 'both',
      notPassed: 'the image ships ./drizzle'
    }),
    slowQueryMs: v({
      name: 'NUXT_DB_SLOW_QUERY_MS',
      type: positiveInt,
      default: 200,
      doc: 'Queries slower than this (ms) raise a warning-level Sentry event.',
      services: ['app'],
      scope: 'both',
      notPassed: 'tuning knob, default is fine'
    })
  }
})

export const test = defineNamespace({
  name: 'test',
  title: 'Test harness',
  intro: 'Test-only switches. Ignored on an instance whose NUXT_SITE_URL is a real (non-loopback) host; TEST_MODE=1 there refuses to boot.',
  vars: {
    testBuild: v({
      name: 'MARKOTO_TEST_BUILD',
      type: bool,
      default: false,
      doc: 'Build time only: include the test-only routes (server/api/_test/**) in the build. Set by the integration and flow test harnesses; release images are built without it, so those routes do not exist there.',
      services: ['build'],
      scope: 'test',
      notPassed: 'set by the test harness for its own build only'
    }),
    testMode: v({
      name: 'TEST_MODE',
      type: oneOf(['1', '0']),
      doc: '1 = test login shim, rate-limit bypass, in-process fakes, relaxed required-variable checks. Test harness only.',
      services: ['app', 'sync'],
      scope: 'test',
      notPassed: 'set by the test harness only'
    }),
    enforceRateLimits: v({
      name: 'TEST_ENFORCE_RATE_LIMITS',
      type: string,
      default: '',
      doc: 'Comma-separated rate-limit namespaces (or *) enforced despite TEST_MODE.',
      services: ['app'],
      scope: 'test',
      notPassed: 'set by the test harness only'
    }),
    litellmStub: v({
      name: 'LITELLM_TEST_STUB',
      type: bool,
      default: false,
      doc: 'Skip LiteLLM key/team calls (unit/repos test tiers).',
      services: ['app'],
      scope: 'test',
      notPassed: 'set by the test harness only'
    }),
    voxtralRealtimeMock: v({
      name: 'NUXT_VOXTRAL_REALTIME_MOCK',
      type: bool,
      default: false,
      doc: 'With TEST_MODE: canned live-dictation transcripts instead of Mistral.',
      services: ['app'],
      scope: 'test',
      notPassed: 'set by the test harness only'
    }),
    exposeTestHandles: v({
      name: 'NUXT_PUBLIC_EXPOSE_TEST_HANDLES',
      type: bool,
      default: false,
      doc: 'Expose the editor\'s Y.Doc on window for end-to-end tests (runtimeConfig.public).',
      services: ['app'],
      scope: 'test',
      notPassed: 'set by the flow-test stack only'
    })
  }
})
