import { must } from '~~/shared/utils/must'
import type { Pool } from 'pg'
import {
  KNOWLEDGE_EMBEDDING_COLUMN,
  countStoredEmbeddings,
  ensureEmbeddingIndex,
  readEmbeddingColumnDims,
  retypeEmbeddingColumn,
  withEmbeddingDimensionLock
} from './embeddingColumn'

/**
 * Re-embed the whole workspace knowledge base with the currently configured
 * model (driver for `scripts/reembed-knowledge.ts`; kept here, free of Nuxt
 * auto-imports, so repos tests can run it against a fake embedder).
 *
 * Procedure, all under the embedding-dimension advisory lock:
 *   1. If the column's dimension differs from the target: drop the HNSW
 *      index, retype the column (discarding the old vectors) and mark every
 *      ready file `pending-reembed`: one transaction.
 *   2. For every ready file whose `embedding_version` is not the target tag:
 *      embed all its chunks from stored `content`, then write the vectors and
 *      the new version tag in one transaction. File granularity makes the
 *      run resumable: re-running picks up exactly the files still stale.
 *   3. Recreate the HNSW index (IF NOT EXISTS) once everything is embedded.
 *
 * While it runs, knowledge search is degraded: files not yet processed have
 * no vectors (dimension change) or vectors from the old model (same-size
 * model switch), and the index is absent. The editor is unaffected.
 */

export const PENDING_VERSION = 'pending-reembed'

export interface ReembedOptions {
  pool: Pool
  /** Target vector dimension (already validated). */
  dims: number
  /** Value stored in `workspace_knowledge.embedding_version` when done. */
  versionTag: string
  /** Embeds texts; must return one `dims`-long vector per text, in order. */
  embed: (texts: string[]) => Promise<number[][]>
  /** Chunks sent to `embed` per call. */
  batchSize: number
  /** Pause between embed calls (crude rate limiting). */
  pauseMs?: number
  dryRun?: boolean
  /** Re-embed every ready file regardless of its version tag. Use once; a
   *  resumed run must not pass it again (it would restart from scratch). */
  force?: boolean
  log?: (line: string) => void
}

export interface ReembedSummary {
  dryRun: boolean
  retyped: boolean
  filesTotal: number
  filesDone: number
  chunksDone: number
}

interface StaleFile {
  knowledge_id: string
  filename: string
  chunk_count: number
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`
}

export async function runReembed(opts: ReembedOptions): Promise<ReembedSummary> {
  const log = opts.log ?? (() => {})
  const locked = await withEmbeddingDimensionLock(opts.pool, { waitMs: 0 }, async (client): Promise<ReembedSummary> => {
    const currentDims = await readEmbeddingColumnDims(client)
    const needsRetype = currentDims !== opts.dims
    // A retype invalidates every vector; `force` re-embeds everything even
    // when the version tag already matches (e.g. a same-size model swap
    // whose tag could not tell the models apart).
    const resetAll = needsRetype || opts.force === true

    const staleSql = `SELECT knowledge_id, filename, chunk_count FROM workspace_knowledge
                       WHERE status = 'ready' AND embedding_version <> $1
                       ORDER BY knowledge_id`
    const countRes = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_knowledge WHERE status = 'ready' AND ($2::boolean OR embedding_version <> $1)`,
      [opts.versionTag, resetAll]
    )
    const filesTotal = countRes.rows[0]?.n ?? 0
    log(`column: ${currentDims ?? 'unsized'} dims -> target ${opts.dims}${needsRetype ? ' (will be retyped, stored vectors discarded)' : ''}`)
    log(`${filesTotal} knowledge file(s) to re-embed with tag ${opts.versionTag}`)

    if (opts.dryRun) {
      log('dry run: nothing changed')
      return { dryRun: true, retyped: false, filesTotal, filesDone: 0, chunksDone: 0 }
    }

    if (resetAll) {
      await client.query('BEGIN')
      try {
        if (needsRetype) {
          await client.query('LOCK TABLE workspace_knowledge_chunks IN ACCESS EXCLUSIVE MODE')
          const stored = await countStoredEmbeddings(client)
          await retypeEmbeddingColumn(client, opts.dims, { recreateIndex: false })
          log(`column retyped to ${opts.dims} dims; ${stored} old vector(s) discarded`)
        }
        await client.query(`UPDATE workspace_knowledge SET embedding_version = $1 WHERE status = 'ready'`, [PENDING_VERSION])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      }
    }

    let filesDone = 0
    let chunksDone = 0
    const started = Date.now()
    const stale = (await client.query<StaleFile>(staleSql, [opts.versionTag])).rows
    for (const file of stale) {
      const chunks = (await client.query<{ id: number, content: string }>(
        'SELECT id, content FROM workspace_knowledge_chunks WHERE knowledge_id = $1 ORDER BY chunk_index',
        [file.knowledge_id]
      )).rows

      const vectors: number[][] = []
      for (let i = 0; i < chunks.length; i += opts.batchSize) {
        const batch = chunks.slice(i, i + opts.batchSize)
        const out = await opts.embed(batch.map(c => c.content))
        if (out.length !== batch.length) {
          throw new Error(`embedder returned ${out.length} vectors for ${batch.length} chunks (file ${file.knowledge_id})`)
        }
        for (const v of out) {
          if (v.length !== opts.dims) throw new Error(`embedder returned a ${v.length}-dim vector, expected ${opts.dims}`)
          vectors.push(v)
        }
        if (opts.pauseMs) await new Promise(resolve => setTimeout(resolve, opts.pauseMs))
      }

      await client.query('BEGIN')
      try {
        for (const [i, chunk] of chunks.entries()) {
          await client.query('UPDATE workspace_knowledge_chunks SET embedding = $1::vector WHERE id = $2', [vectorLiteral(must(vectors[i], `vector of chunk ${chunk.id}`)), chunk.id])
        }
        await client.query('UPDATE workspace_knowledge SET embedding_version = $1 WHERE knowledge_id = $2', [opts.versionTag, file.knowledge_id])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      }
      filesDone++
      chunksDone += chunks.length
      log(`${filesDone}/${stale.length} files, ${chunksDone} chunks, ${Math.round((Date.now() - started) / 1000)}s: ${file.filename}`)
    }

    log('recreating HNSW index (can take a while on large corpora)')
    await ensureEmbeddingIndex(client, KNOWLEDGE_EMBEDDING_COLUMN)
    return { dryRun: false, retyped: needsRetype, filesTotal, filesDone, chunksDone }
  })

  if (!locked.acquired) {
    throw new Error('Another process holds the embedding-dimension lock (an app instance reconciling at boot, or another re-embed run). Retry in a minute.')
  }
  return locked.value
}
