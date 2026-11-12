import type { Pool, PoolClient } from 'pg'

/**
 * Keeps the pgvector column behind the workspace knowledge base in step with
 * `NUXT_LITELLM_EMBEDDINGS_DIMS`.
 *
 * Drizzle's schema (and therefore the migrations) pin `vector(768)`: that is
 * the hosted default (Jina v5-text-nano). A self-hoster who configures a model
 * with a different output size gets the column re-typed here, outside the
 * migration chain, because the target depends on runtime configuration:
 *
 *   - column already has the configured size  -> no-op
 *   - no stored vectors yet                   -> drop HNSW index, retype the
 *                                                column, recreate the index
 *                                                (one transaction)
 *   - stored vectors of another size          -> REFUSE. Existing vectors
 *                                                cannot be converted; the
 *                                                operator must run the
 *                                                re-embed command.
 *
 * Everything runs under a Postgres advisory lock so several app instances
 * booting at once (or the re-embed script running) never race.
 */

export interface EmbeddingColumnTarget {
  table: string
  column: string
  index: string
}

export const KNOWLEDGE_EMBEDDING_COLUMN: EmbeddingColumnTarget = {
  table: 'workspace_knowledge_chunks',
  column: 'embedding',
  index: 'idx_wkc_embedding'
}

/** Name hashed into the advisory-lock key; shared by boot + re-embed script. */
export const EMBEDDING_DIMENSION_LOCK = 'knowledge-embedding-dimension'

// Both spellings of the same command: from a source checkout, and inside
// the shipped app image (the Dockerfile bundles scripts/reembed-knowledge.ts
// into /app/cli/: the runtime image has no scripts/ dir or dev deps).
const REEMBED_COMMAND = '`bun run knowledge:reembed` (source checkout) or `docker compose exec app bun cli/reembed-knowledge.js` (container)'

const IDENT = /^[a-z_][a-z0-9_]*$/

// Identifiers are internal constants (or test fixtures), never user input,
// but they are interpolated into DDL, so refuse anything unusual.
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`[embedding-column] unsafe identifier: ${name}`)
  return `"${name}"`
}

/** Current dimension of the vector column, or null when it has no fixed size. */
export async function readEmbeddingColumnDims(
  q: Pick<Pool, 'query'>,
  target: EmbeddingColumnTarget = KNOWLEDGE_EMBEDDING_COLUMN
): Promise<number | null> {
  const res = await q.query<{ type: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attname = $2 AND NOT a.attisdropped`,
    [target.table, target.column]
  )
  const type = res.rows[0]?.type
  if (!type) throw new Error(`[embedding-column] column ${target.table}.${target.column} not found`)
  const m = /^vector\((\d+)\)$/.exec(type)
  return m?.[1] ? Number(m[1]) : null
}

/** Rows that actually hold a vector (NULLs carry nothing to lose). */
export async function countStoredEmbeddings(
  q: Pick<Pool, 'query'>,
  target: EmbeddingColumnTarget = KNOWLEDGE_EMBEDDING_COLUMN
): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${ident(target.table)} WHERE ${ident(target.column)} IS NOT NULL`
  )
  return res.rows[0]?.n ?? 0
}

export async function ensureEmbeddingIndex(
  q: Pick<PoolClient, 'query'>,
  target: EmbeddingColumnTarget = KNOWLEDGE_EMBEDDING_COLUMN
): Promise<void> {
  await q.query(
    `CREATE INDEX IF NOT EXISTS ${ident(target.index)} ON ${ident(target.table)} USING hnsw (${ident(target.column)} vector_cosine_ops)`
  )
}

/**
 * Retype the column to `vector(dims)`. Existing values are DISCARDED (set to
 * NULL), so callers must have established that this is safe. The HNSW index
 * is dropped first (its operator class is bound to the old type) and is only
 * recreated when `recreateIndex` is true: the re-embed script builds it after
 * the bulk load, which is much faster.
 *
 * Caller owns the transaction.
 */
export async function retypeEmbeddingColumn(
  client: Pick<PoolClient, 'query'>,
  dims: number,
  opts: { target?: EmbeddingColumnTarget, recreateIndex: boolean }
): Promise<void> {
  const target = opts.target ?? KNOWLEDGE_EMBEDDING_COLUMN
  if (!Number.isInteger(dims) || dims < 1) throw new Error(`[embedding-column] invalid dims ${dims}`)
  await client.query(`DROP INDEX IF EXISTS ${ident(target.index)}`)
  await client.query(
    `ALTER TABLE ${ident(target.table)} ALTER COLUMN ${ident(target.column)} TYPE vector(${dims}) USING NULL`
  )
  if (opts.recreateIndex) await ensureEmbeddingIndex(client, target)
}

export interface LockOptions {
  /** How long to keep trying to take the lock. 0 = single attempt. */
  waitMs: number
  pollMs?: number
}

/**
 * Run `fn` while holding the (session-level) advisory lock on a pinned
 * connection. Returns `{ acquired: false }` when the lock stayed taken for
 * `waitMs`. Session-level, not xact-level: the re-embed script holds it
 * across many transactions.
 */
export async function withEmbeddingDimensionLock<T>(
  pool: Pool,
  opts: LockOptions,
  fn: (client: PoolClient) => Promise<T>
): Promise<{ acquired: true, value: T } | { acquired: false }> {
  const client = await pool.connect()
  let locked = false
  try {
    const deadline = Date.now() + opts.waitMs
    while (true) {
      const res = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [EMBEDDING_DIMENSION_LOCK]
      )
      if (res.rows[0]?.ok) {
        locked = true
        break
      }
      if (Date.now() >= deadline) return { acquired: false }
      await new Promise(resolve => setTimeout(resolve, opts.pollMs ?? 250))
    }
    return { acquired: true, value: await fn(client) }
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [EMBEDDING_DIMENSION_LOCK])
    } finally {
      client.release()
    }
  }
}

export type ReconcileResult
  = | { action: 'noop', currentDims: number }
    | { action: 'altered', previousDims: number | null, currentDims: number }
    | { action: 'refused', currentDims: number | null, targetDims: number, storedVectors: number, message: string }
    | { action: 'busy', targetDims: number, message: string }

export function mismatchMessage(current: number | null, target: number, stored: number): string {
  return `The knowledge-base vector column is ${current ?? 'unsized'}-dimensional but NUXT_LITELLM_EMBEDDINGS_DIMS=${target}, `
    + `and ${stored} stored vector${stored === 1 ? '' : 's'} cannot be converted. Knowledge search and uploads are disabled `
    + `(the editor is unaffected). Either set NUXT_LITELLM_EMBEDDINGS_DIMS back to ${current ?? 'the old value'}, or run ${REEMBED_COMMAND} to re-embed every chunk with the new model.`
}

/**
 * Boot-time reconciliation. Never throws for the expected cases; returns what
 * it did so the caller can log and publish status.
 */
export async function reconcileEmbeddingColumn(
  pool: Pool,
  targetDims: number,
  opts: { target?: EmbeddingColumnTarget, lockWaitMs?: number } = {}
): Promise<ReconcileResult> {
  const target = opts.target ?? KNOWLEDGE_EMBEDDING_COLUMN

  // Fast path without the lock: the overwhelmingly common boot.
  const quick = await readEmbeddingColumnDims(pool, target)
  if (quick === targetDims) return { action: 'noop', currentDims: quick }

  const locked = await withEmbeddingDimensionLock(pool, { waitMs: opts.lockWaitMs ?? 60_000 }, async (client): Promise<ReconcileResult> => {
    // Re-read under the lock: another instance (or the re-embed script) may
    // have fixed it while we waited.
    const current = await readEmbeddingColumnDims(client, target)
    if (current === targetDims) return { action: 'noop', currentDims: current }

    await client.query('BEGIN')
    try {
      // Block writers for the check + DDL so no vector can slip in between.
      await client.query(`LOCK TABLE ${ident(target.table)} IN ACCESS EXCLUSIVE MODE`)
      const stored = await countStoredEmbeddings(client, target)
      if (stored > 0) {
        await client.query('ROLLBACK')
        return { action: 'refused', currentDims: current, targetDims, storedVectors: stored, message: mismatchMessage(current, targetDims, stored) }
      }
      await retypeEmbeddingColumn(client, targetDims, { target, recreateIndex: true })
      await client.query('COMMIT')
      return { action: 'altered', previousDims: current, currentDims: targetDims }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    }
  })

  if (!locked.acquired) {
    return {
      action: 'busy',
      targetDims,
      message: `Another process (a re-embed run or another instance) holds the embedding-dimension lock; knowledge features stay disabled until the column matches NUXT_LITELLM_EMBEDDINGS_DIMS=${targetDims}.`
    }
  }
  return locked.value
}
