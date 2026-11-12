import { Pool } from 'pg'
import { postgresUrlFromEnv } from '../../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../../shared/utils/runtime/postgresSsl'
import { captureException } from './sentry'
import { syncEnv } from './env'
import { useLogger } from './logger'
import { parseSyncLimits } from './limits'
import { createYjsStore } from './yjs-store'
import { createDocumentPersistence } from './persistence'
import { createCompactionSweeper } from './compaction'

// The process-wide persistence wired from env: one Postgres pool for loads,
// stores and compaction (same TLS posture as the app's pool,
// server/db/client.ts).

const env = syncEnv()
const log = useLogger('persistence')

const pool = new Pool({
  connectionString: postgresUrlFromEnv(env.database),
  ssl: resolvePostgresSsl(env.database, process.env.NODE_ENV === 'production'),
  max: 10
})
// An idle client losing its connection must not crash the process; the next
// query gets a fresh client.
pool.on('error', (e) => {
  log.warn('idle Postgres client error', { err: e })
})

function capture(e: unknown, tags: Record<string, string>): void {
  captureException(e, { tags })
}

const limits = parseSyncLimits(env)
const store = createYjsStore(pool, {
  // A stored row is at most a whole document; the update guard keeps a
  // document under SYNC_MAX_DOCUMENT_BYTES, the margin covers encoding slack.
  maxRowBytes: limits.maxDocumentBytes + limits.maxUpdateBytes
})

export const compaction = createCompactionSweeper({
  store,
  pool,
  log: useLogger('compaction'),
  capture,
  intervalMs: env.sync.compactIntervalMs,
  maxDocsPerRun: env.sync.compactMaxDocsPerRun,
  retainHistoryDays: env.sync.compactRetainHistoryDays,
  afterSweep: () => {
    const s = persistence.takeStats()
    if (s.loads === 0 && s.stores === 0 && s.storeFailures === 0) return
    log.info('persistence stats', {
      loads: s.loads,
      loadAvgMs: s.loads ? Math.round(s.loadMs / s.loads) : 0,
      loadBytes: s.loadBytes,
      stores: s.stores,
      storeAvgMs: s.stores ? Math.round(s.storeMs / s.stores) : 0,
      storeMaxMs: Math.round(s.maxStoreMs),
      storeBytes: s.storeBytes,
      storeFailures: s.storeFailures,
      unsavedDocuments: persistence.unsavedDocumentIds().length
    })
  }
})

export const persistence = createDocumentPersistence({
  store,
  log,
  capture,
  snapshotThreshold: env.sync.compactThreshold,
  onSnapshotDue: docId => compaction.enqueue(docId)
})

export async function closePersistencePool(): Promise<void> {
  await pool.end()
}
