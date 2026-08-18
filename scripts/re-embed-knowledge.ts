#!/usr/bin/env bun
/**
 * One-shot re-embed script for the workspace knowledge base.
 *
 * Walks `workspace_knowledge_chunks`, re-embeds each chunk's `.content`
 * via the currently-configured provider (defaults to Jina v5-text-nano),
 * UPDATEs the `embedding` vector + bumps the parent `workspace_knowledge.embedding_version`.
 *
 * Idempotent: filters by parent's `embedding_version` so chunks already
 * carrying the target version are skipped. Re-running is safe.
 *
 * Run modes:
 *   bun scripts/re-embed-knowledge.ts --dry-run    # log what would change, no writes
 *   bun scripts/re-embed-knowledge.ts              # apply
 *   bun scripts/re-embed-knowledge.ts --batch-size 50
 *
 * Env requirements (read from .env or shell):
 *   - DATABASE_URL or POSTGRES_* parts
 *   - NUXT_LITELLM_URL + NUXT_LITELLM_MASTER_KEY (when provider=jina)
 *   - NUXT_KNOWLEDGE_EMBEDDINGS_PROVIDER (defaults to jina here)
 *
 * Throttling: bounded concurrency = 5 by default (matches the in-app
 * embedding pipeline's CONCURRENCY constant). Override with --concurrency.
 *
 * Historical (Phase 1A cutover, completed): originally drove the
 * one-direction migration off the legacy Gemini embeddings path:
 *   1. Deploy with NUXT_KNOWLEDGE_EMBEDDINGS_PROVIDER=gemini still default.
 *      The new Jina path was dormant.
 *   2. Run this script (it picks up provider=jina from the script's env or
 *      flag, NOT the app's runtime config). Re-embeds with Jina vectors.
 *   3. Flip NUXT_KNOWLEDGE_EMBEDDINGS_PROVIDER=jina globally → reads use
 *      the new vectors.
 * The two-step (re-embed first, flip flag second) was safer than flipping
 * the flag first: while re-embed ran, the read path kept using the old
 * (Gemini) vectors; once every row was jina-versioned, the flip was atomic.
 *
 * Post-migration: kept on hand for any future re-embed (model bump, dim
 * change, vendor swap) — the same flow applies regardless of source/target.
 */

import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, ne, sql } from 'drizzle-orm'
import OpenAI from 'openai'

import { workspaceKnowledge, workspaceKnowledgeChunks } from '../server/db/schema'
import { trimTrailingSlashes } from '../shared/utils/trimTrailingSlashes'

// ─── CLI args ─────────────────────────────────────────────────────────────

interface CliOpts {
  dryRun: boolean
  batchSize: number
  concurrency: number
  model: string
  dimensions: number
  targetVersion: string
}

function parseArgs(argv: string[]): CliOpts {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`)
    return idx >= 0 ? argv[idx + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  // Single provider since Phase 6: Jina v5-text-nano via LiteLLM.
  // The pre-Phase-5 Gemini path is gone.
  const model = get('model') || 'jina-embeddings-v5-text-nano'
  const dimensions = Number(get('dimensions') || '768')

  return {
    dryRun: has('dry-run'),
    batchSize: Number(get('batch-size') || '50'),
    concurrency: Number(get('concurrency') || '5'),
    model,
    dimensions,
    // Tag persisted to workspace_knowledge.embedding_version. Matches
    // the format produced by `embeddingVersionTag` in server/utils/embeddings.ts.
    targetVersion: `jina/${model}:${dimensions}`
  }
}

// ─── DB ──────────────────────────────────────────────────────────────────

function buildPool(): Pool {
  const url = process.env.DATABASE_URL
  if (url) return new Pool({ connectionString: url })
  const { POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env
  if (!POSTGRES_HOST || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    throw new Error('Either DATABASE_URL or POSTGRES_HOST/USER/PASSWORD/DB must be set')
  }
  return new Pool({
    host: POSTGRES_HOST,
    port: Number(POSTGRES_PORT || '5432'),
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB
  })
}

// ─── Embedding provider (mirrors server/utils/embeddings.ts logic) ────────

interface Embedder {
  embed(text: string): Promise<number[]>
}

function makeEmbedder(opts: CliOpts): Embedder {
  const url = process.env.NUXT_LITELLM_URL
  const key = process.env.NUXT_LITELLM_MASTER_KEY
  if (!url || !key) {
    throw new Error('NUXT_LITELLM_URL and NUXT_LITELLM_MASTER_KEY required')
  }
  const client = new OpenAI({
    apiKey: key,
    baseURL: trimTrailingSlashes(url) + '/v1'
  })
  return {
    async embed(text: string): Promise<number[]> {
      const truncated = text.length > 8000 ? text.slice(0, 8000) : text
      const r = await client.embeddings.create({
        model: opts.model,
        input: truncated,
        dimensions: opts.dimensions,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ task: 'retrieval.passage' } as any)
      })
      const v = r.data?.[0]?.embedding
      if (v?.length !== opts.dimensions) {
        throw new Error(`vector shape ${v?.length ?? 0} != ${opts.dimensions}`)
      }
      return v
    }
  }
}

// ─── Bounded concurrency ──────────────────────────────────────────────────

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  console.log('[re-embed] config:')
  console.log(`  dry-run:    ${opts.dryRun}`)
  console.log(`  provider:   ${opts.provider}`)
  console.log(`  model:      ${opts.model}`)
  console.log(`  dimensions: ${opts.dimensions}`)
  console.log(`  target_ver: ${opts.targetVersion}`)
  console.log(`  batch:      ${opts.batchSize}`)
  console.log(`  concurrent: ${opts.concurrency}`)

  const pool = buildPool()
  const db = drizzle(pool)

  try {
    // Find files whose embedding_version is NOT already the target.
    // Status filter: only `ready` rows have chunks. `processing`/`failed`
    // have no embeddings to re-embed; those run through the regular
    // pipeline once unstuck.
    const stale = await db.select({
      knowledgeId: workspaceKnowledge.knowledgeId,
      filename: workspaceKnowledge.filename,
      embeddingVersion: workspaceKnowledge.embeddingVersion,
      chunkCount: workspaceKnowledge.chunkCount
    }).from(workspaceKnowledge)
      .where(and(
        eq(workspaceKnowledge.status, 'ready' as const),
        ne(workspaceKnowledge.embeddingVersion, opts.targetVersion)
      ))

    console.log(`[re-embed] ${stale.length} knowledge files need re-embedding`)
    if (stale.length === 0) return

    if (opts.dryRun) {
      for (const f of stale.slice(0, 20)) {
        console.log(`  - ${f.knowledgeId}  "${f.filename}"  current=${f.embeddingVersion}  chunks=${f.chunkCount}`)
      }
      if (stale.length > 20) console.log(`  ... and ${stale.length - 20} more`)
      console.log('[re-embed] dry-run; no writes performed.')
      return
    }

    const embedder = makeEmbedder(opts)
    let filesDone = 0
    let chunksDone = 0
    const startedAt = Date.now()

    for (let i = 0; i < stale.length; i += opts.batchSize) {
      const batch = stale.slice(i, i + opts.batchSize)
      // Per-knowledge-file: re-embed all its chunks, then atomically
      // update the parent's embedding_version. If the script crashes
      // mid-file, the parent's version stays old and the next run
      // re-does the chunks (idempotent).
      for (const file of batch) {
        const chunks = await db.select({
          id: workspaceKnowledgeChunks.id,
          content: workspaceKnowledgeChunks.content
        }).from(workspaceKnowledgeChunks)
          .where(eq(workspaceKnowledgeChunks.knowledgeId, file.knowledgeId))

        if (chunks.length === 0) {
          console.warn(`[re-embed]   ${file.knowledgeId} ready but has 0 chunks; flipping version anyway`)
          await db.update(workspaceKnowledge)
            .set({ embeddingVersion: opts.targetVersion })
            .where(eq(workspaceKnowledge.knowledgeId, file.knowledgeId))
          filesDone++
          continue
        }

        // Embed in bounded-concurrency pool.
        const updates: Array<{ id: number, vec: number[] }> = []
        await runPool(chunks, opts.concurrency, async (c) => {
          const vec = await embedder.embed(c.content)
          updates.push({ id: c.id, vec })
        })

        // Bulk UPDATE — one round-trip per chunk via parameterized SQL.
        // pgvector accepts the array literal '[v1,v2,...]'::vector.
        for (const u of updates) {
          await db.update(workspaceKnowledgeChunks)
            .set({ embedding: u.vec })
            .where(eq(workspaceKnowledgeChunks.id, u.id))
        }

        await db.update(workspaceKnowledge)
          .set({ embeddingVersion: opts.targetVersion })
          .where(eq(workspaceKnowledge.knowledgeId, file.knowledgeId))

        filesDone++
        chunksDone += chunks.length
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        console.log(`[re-embed] ${filesDone}/${stale.length} files (${chunksDone} chunks total, ${elapsed}s) — last: "${file.filename}" (${chunks.length} chunks)`)
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    console.log(`[re-embed] DONE: ${filesDone} files, ${chunksDone} chunks in ${elapsed}s`)
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (e) {
  console.error('[re-embed] FAILED:', e instanceof Error ? e.stack || e.message : e)
  process.exit(1)
}

// Silence Drizzle's "unused" warning for the helper import in some bun versions.
// Reference at module level — bun lint counts this as a use.
const _sqlRef = sql
export { _sqlRef }
