import { bytes, durationMs, int, nonNegativeInt, port, positiveInt, string, url } from '../coerce'
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
    maxRooms: v({
      name: 'SYNC_MAX_ROOMS',
      type: positiveInt,
      default: 10000,
      doc: 'Documents one sync server keeps open at once; a new document beyond it is refused as busy (joining an open one never is). Size it from the container memory: about 80 MiB plus 60 KiB per open document of typical size (one tab on it; add its text for larger ones), at most about 80 % of the memory guard line. 10000 fits the default 1 GiB; give 2 GiB for 20000.',
      services: ['sync'],
      scope: 'both'
    }),
    memoryGuardPercent: v({
      name: 'SYNC_MEMORY_GUARD_PERCENT',
      type: int({ min: 0, max: 100 }),
      default: 85,
      doc: 'Refuse to open new documents (busy) while the sync server uses more than this share of its memory limit; 0 = off.',
      services: ['sync'],
      scope: 'both'
    }),
    memoryLimitBytes: v({
      name: 'SYNC_MEMORY_LIMIT_BYTES',
      type: bytes,
      defaultDoc: 'the container memory limit (cgroup); none = memory guard off',
      doc: 'Memory limit the memory guard measures against.',
      services: ['sync'],
      scope: 'both'
    }),
    unloadGraceMs: v({
      name: 'SYNC_UNLOAD_GRACE_MS',
      type: nonNegativeInt,
      default: 30000,
      doc: 'How long a document stays open after its last tab left (ms), so reloads and quick switches skip the database; edits are still stored at once. 0 = unload immediately.',
      services: ['sync'],
      scope: 'both'
    }),
    hiddenDisconnectMs: v({
      name: 'NUXT_PUBLIC_SYNC_HIDDEN_DISCONNECT_MS',
      type: nonNegativeInt,
      default: 240000,
      doc: 'The editor disconnects from the sync server after its tab has been hidden this long (ms) and reconnects when it is shown again (runtimeConfig.public). 0 = stay connected.',
      services: ['app'],
      scope: 'both'
    }),
    compactThreshold: v({
      name: 'COMPACT_THRESHOLD',
      type: positiveInt,
      default: 500,
      doc: 'A snapshot of a document is written once it has more stored updates than this since its last snapshot (loading then starts from the snapshot; no history is removed).',
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
    }),
    compactRetainHistoryDays: v({
      name: 'COMPACT_RETAIN_HISTORY_DAYS',
      type: nonNegativeInt,
      default: 0,
      doc: 'Days of edit history that stay restorable. Older Y.js rows are deleted below a snapshot, and Activity Log restores/diffs from before then answer 410. 0 = keep all history. Must be at least the longest plan history window (TIER_*_HISTORY_DAYS).',
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
