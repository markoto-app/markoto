import { bytes, durationMs, int, port, positiveInt, string, url } from '../coerce'
import { defineNamespace, v } from '../define'
import { MIB } from '../../config/units'

export const sync = defineNamespace({
  name: 'sync',
  title: 'Sync server (Hocuspocus)',
  intro: 'Real-time collaboration. NUXT_* values are read by the app; the rest by the sync server.',
  vars: {
    internalUrl: v({
      name: 'NUXT_SYNC_INTERNAL_URL',
      type: url(),
      default: 'http://localhost:4001',
      example: 'http://localhost:4001',
      doc: 'Internal HTTP URL the app calls the sync server on.',
      services: ['app'],
      scope: 'both'
    }),
    publicUrl: v({
      name: 'NUXT_PUBLIC_SYNC_URL',
      type: url(['ws', 'wss']),
      required: 'always',
      example: 'ws://localhost:4001',
      doc: 'WebSocket URL browsers connect to (runtimeConfig.public.syncUrl).',
      services: ['app'],
      scope: 'both'
    }),
    port: v({
      name: 'PORT',
      internal: true,
      type: port,
      default: 4001,
      doc: 'Port the sync server listens on.',
      services: ['sync'],
      scope: 'both'
    }),
    appUrl: v({
      name: 'APP_URL',
      internal: true,
      type: url(),
      doc: 'Internal URL of the app for activity / comment snapshots; empty = those calls are skipped (dev).',
      services: ['sync'],
      scope: 'both'
    }),
    maxMessageBytes: v({
      name: 'SYNC_MAX_MESSAGE_BYTES',
      type: bytes,
      default: 17 * MIB,
      doc: 'Largest WebSocket frame (closed with 1009 above it).',
      services: ['sync'],
      scope: 'both'
    }),
    maxUpdateBytes: v({
      name: 'SYNC_MAX_UPDATE_BYTES',
      type: bytes,
      default: 16 * MIB,
      doc: 'Largest single Y.js update.',
      services: ['sync'],
      scope: 'both'
    }),
    maxDocumentBytes: v({
      name: 'SYNC_MAX_DOCUMENT_BYTES',
      type: bytes,
      default: 16 * MIB,
      doc: 'Largest encoded document after an update (deletions always pass).',
      services: ['sync'],
      scope: 'both'
    }),
    maxPreauthBytes: v({
      name: 'SYNC_MAX_PREAUTH_BYTES',
      type: bytes,
      default: 32 * MIB,
      doc: 'Bytes one connection may queue before its document authenticates.',
      services: ['sync'],
      scope: 'both'
    }),
    maxPreauthTotalBytes: v({
      name: 'SYNC_MAX_PREAUTH_TOTAL_BYTES',
      type: bytes,
      default: 256 * MIB,
      doc: 'Bytes all connections together may queue before authenticating.',
      services: ['sync'],
      scope: 'both'
    }),
    authTimeoutMs: v({
      name: 'SYNC_AUTH_TIMEOUT_MS',
      type: durationMs,
      default: 15000,
      doc: 'A connection that sends for a document without its token within this time is closed.',
      services: ['sync'],
      scope: 'both'
    }),
    maxConnectionsPerIp: v({
      name: 'SYNC_MAX_CONNECTIONS_PER_IP',
      type: positiveInt,
      defaultDoc: '20 with NODE_ENV=production, 200 otherwise',
      doc: 'Open sync connections per client IP.',
      services: ['sync'],
      scope: 'both'
    }),
    compactThreshold: v({
      name: 'COMPACT_THRESHOLD',
      type: positiveInt,
      default: 500,
      doc: 'A document is compacted once it has more stored update rows than this.',
      services: ['sync'],
      scope: 'both'
    }),
    compactIntervalMs: v({
      name: 'COMPACT_INTERVAL_MS',
      type: int(),
      default: 900000,
      doc: 'How often the compaction sweep runs (ms); ≤ 0 = off.',
      services: ['sync'],
      scope: 'both'
    }),
    compactMaxDocsPerRun: v({
      name: 'COMPACT_MAX_DOCS_PER_RUN',
      type: positiveInt,
      default: 50,
      doc: 'Most documents compacted per sweep.',
      services: ['sync'],
      scope: 'both'
    })
  }
})

export const observability = defineNamespace({
  name: 'observability',
  title: 'Error reporting (Sentry)',
  intro: 'Optional. Empty keeps telemetry off.',
  vars: {
    publicDsn: v({
      name: 'NUXT_PUBLIC_SENTRY_DSN',
      example: '',
      type: url(),
      doc: 'Browser DSN (runtimeConfig.public.sentry.dsn); also the server DSN when SENTRY_DSN is empty.',
      services: ['app'],
      scope: 'both'
    }),
    dsn: v({
      name: 'SENTRY_DSN',
      example: '',
      type: url(),
      doc: 'Server-side DSN of the app, sync server and renderer.',
      services: ['app', 'sync', 'renderer'],
      scope: 'both'
    }),
    authToken: v({
      name: 'SENTRY_AUTH_TOKEN',
      type: string,
      secret: true,
      doc: 'Build time only: uploads source maps during `bun run build`.',
      services: ['build'],
      scope: 'hosted'
    }),
    org: v({
      name: 'SENTRY_ORG',
      type: string,
      doc: 'Build time only: Sentry organisation for the source-map upload.',
      services: ['build'],
      scope: 'hosted'
    }),
    project: v({
      name: 'SENTRY_PROJECT',
      type: string,
      doc: 'Build time only: Sentry project for the source-map upload.',
      services: ['build'],
      scope: 'hosted'
    }),
    docsChromeDomain: v({
      name: 'NUXT_PUBLIC_DOCS_CHROME_DOMAIN',
      type: string,
      default: 'markoto.app',
      doc: 'Domain shown in the fake browser bar above the docs\' flow screenshots (runtimeConfig.public.docs.chromeDomain).',
      services: ['app'],
      scope: 'both',
      notPassed: 'cosmetic; the default is right for the bundled docs'
    })
  }
})
