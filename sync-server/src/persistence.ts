import * as Y from 'yjs'
import { PostgresqlPersistence } from 'y-postgresql'
import { captureException } from './sentry'

if (!process.env.DATABASE_URL) {
  throw new Error('[persistence] DATABASE_URL environment variable is required')
}

// y-postgresql owns its own table (`yjs_documents`); it appends granular Y.js
// updates and merges them after every `flushSize` writes. This is far more
// durable than the previous single-blob S3 overwrite — a failed write doesn't
// destroy the prior state, and granular history is implicit in the row log.
//
// useIndex is forced to `false` because y-postgresql@1.0.1 ships a SQL bug in
// the index-creation branch (`AND indexname = $1_docname_idx` — invalid pg
// parameter syntax). At our scale, reads are still fast enough without it; we
// can revisit if the upstream fixes it or if profiling demands an index.
// flushSize: 200 — library default; merges accumulated updates into a single
//   compacted update once the row count crosses the threshold per document.
const pgdb = await PostgresqlPersistence.build(
  { connectionString: process.env.DATABASE_URL },
  { tableName: 'yjs_documents', useIndex: false, flushSize: 200 }
)

export const ypgPersistence = {
  async onLoadDocument({ documentName }: { documentName: string }) {
    try {
      const doc = await pgdb.getYDoc(documentName)
      console.log(`[persistence] Loaded document: ${documentName}`)
      return doc
    } catch (e: any) {
      console.error(`[persistence] Error loading ${documentName}:`, e?.message || e)
      captureException(e, { tags: { component: 'persistence', event: 'load_failed', docId: documentName } })
      // Hand back a fresh doc so Hocuspocus doesn't crash; subsequent edits
      // will overwrite once the persistence layer recovers.
      return new Y.Doc()
    }
  },

  async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
    try {
      const update = Y.encodeStateAsUpdate(document)
      await pgdb.storeUpdate(documentName, update)
    } catch (e: any) {
      // Log loudly. Hocuspocus will retry on the next debounce tick; in the
      // meantime the in-memory Y.Doc is still the source of truth for
      // connected clients.
      console.error(`[persistence] Error storing ${documentName}:`, e?.message || e)
      captureException(e, { tags: { component: 'persistence', event: 'store_failed', docId: documentName } })
    }
  },

  async clearDocument(documentName: string): Promise<void> {
    await pgdb.clearDocument(documentName)
  },

  async destroy(): Promise<void> {
    await pgdb.destroy()
  }
}
