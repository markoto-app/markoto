#!/usr/bin/env bun
/**
 * Re-embed the workspace knowledge base after switching embedding model or
 * dimension (self-hosting). `bun run knowledge:reembed`.
 *
 * The app image ships this script bundled (Dockerfile: `bun build` →
 * /app/cli/reembed-knowledge.js), so on a compose deployment run it inside
 * the app container, which already has every variable below:
 *   docker compose exec app bun cli/reembed-knowledge.js --dry-run
 * Keep it free of Nitro auto-imports so the bundle runs standalone.
 *
 *   bun run knowledge:reembed -- --dry-run     # report only, change nothing
 *   bun run knowledge:reembed                  # do it
 *   bun run knowledge:reembed -- --batch-size 20 --concurrency 3 --pause-ms 500
 *   bun run knowledge:reembed -- --force       # re-embed even files already tagged with the
 *                                              # target (same-size model swap with an unchanged tag);
 *                                              # pass once, never when resuming
 *
 * Steps (see server/utils/knowledge/reembedKnowledge.ts): take the embedding-dimension
 * advisory lock; if NUXT_LITELLM_EMBEDDINGS_DIMS differs from the column's
 * dimension, drop the HNSW index and retype the column (old vectors are
 * discarded); re-embed every chunk from its stored text, file by file;
 * recreate the index. Resumable: if interrupted, run it again and it picks up
 * the files still stale. Knowledge search is degraded until it finishes; the
 * editor is unaffected.
 *
 * Environment (the same names the app uses; a repo-root .env is loaded by bun):
 *   POSTGRES_USER/PASSWORD/HOST/PORT/DB   (+ PGSSL / PGSSLROOTCERT like the app)
 *   NUXT_LITELLM_URL, NUXT_LITELLM_MASTER_KEY
 *   NUXT_LITELLM_EMBEDDINGS_MODEL / _DIMS / _SEND_DIMENSIONS / _TASK_HINTS
 *   EMBEDDINGS_UPSTREAM_MODEL (optional; only labels the stored version tag)
 *
 * Cost: one embeddings request per chunk (~800 characters, roughly 200 tokens;
 * a 25 MB-file corpus is a few thousand chunks). Time is roughly
 * chunks / (concurrency x requests-per-second of your provider).
 */

import { Pool } from 'pg'
import OpenAI from 'openai'
import { buildEmbeddingsConfig, embedDocuments, embeddingVersionTag } from '../server/utils/knowledge/embeddings'
import { runReembed } from '../server/db/reembedKnowledge'
import { postgresUrlFromEnv } from '../shared/utils/runtime/connectionStrings'
import { resolvePostgresSsl } from '../shared/utils/runtime/postgresSsl'
import { useEnv } from '../shared/env/load'
import { isProduction } from '../shared/env/runtime'
import { trimTrailingSlashes } from '../shared/utils/trimTrailingSlashes'

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`)
  return n
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const env = useEnv()

  const cfg = buildEmbeddingsConfig({
    model: env.litellm.embeddingsModel,
    upstreamModel: env.litellm.embeddingsUpstreamModel || process.env.EMBEDDINGS_UPSTREAM_MODEL,
    dims: env.litellm.embeddingsDims,
    sendDimensions: env.litellm.embeddingsSendDimensions,
    taskHints: env.litellm.embeddingsTaskHints,
    apiKey: env.litellm.masterKey
  })
  if (!env.litellm.url) throw new Error('NUXT_LITELLM_URL is required')

  const litellm = new OpenAI({ apiKey: cfg.apiKey, baseURL: trimTrailingSlashes(env.litellm.url) + '/v1' })
  const concurrency = positiveInt(flag(argv, 'concurrency'), 5, 'concurrency')
  // DATABASE_URL: a full URL for a run outside the stack (otherwise the POSTGRES_* parts).
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || postgresUrlFromEnv(env.database),
    ssl: resolvePostgresSsl(env.database, isProduction())
  })

  console.log(`[reembed] model=${cfg.model} dims=${cfg.dimensions} tag=${embeddingVersionTag(cfg)}`)
  try {
    const summary = await runReembed({
      pool,
      dims: cfg.dimensions,
      versionTag: embeddingVersionTag(cfg),
      embed: texts => embedDocuments(texts, { config: cfg, litellm, concurrency }),
      batchSize: Math.max(1, positiveInt(flag(argv, 'batch-size'), 50, 'batch-size')),
      pauseMs: positiveInt(flag(argv, 'pause-ms'), 0, 'pause-ms'),
      dryRun: argv.includes('--dry-run'),
      force: argv.includes('--force'),
      log: line => console.log(`[reembed] ${line}`)
    })
    console.log(`[reembed] done: ${summary.filesDone}/${summary.filesTotal} files, ${summary.chunksDone} chunks${summary.retyped ? ', column retyped' : ''}`)
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (e) {
  console.error('[reembed] FAILED (safe to re-run; progress is kept):', e instanceof Error ? e.message : e)
  process.exit(1)
}
