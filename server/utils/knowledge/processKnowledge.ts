import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { eq } from 'drizzle-orm'
import { workspaceKnowledge, workspaceKnowledgeChunks } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { chunkMarkdown } from './chunkMarkdown'
import { embedDocuments, embeddingVersionTag, resolveEmbeddingsConfig } from './embeddings'
import { assertKnowledgeEmbeddingsReady } from './knowledgeEmbeddingsStatus'
import { tryAcquireSessionLock, releaseSessionLock } from '../platform/rateLimit'
import { injectTraceHeaders } from '../platform/traceHeaders'
import { markitdownAuthHeaders } from '../platform/markitdownAuth'
import { MINUTE_MS } from '~~/shared/config/units'
import { MARKITDOWN_KNOWLEDGE_TIMEOUT_MS } from '../../config/markitdown'
import { useEnv } from '~~/shared/env/load'
import { KNOWLEDGE_PLATFORM_LIMITS } from '~~/shared/config/tiers'
import { useLogger } from '../platform/logger'

const log = useLogger('knowledge-processing')

/**
 * End-to-end ingestion for one knowledge file:
 *   1. Fetch the original file bytes from S3.
 *   2. POST to the markitdown service — same endpoint the user-facing
 *      /api/import uses, so we share all format support for free.
 *   3. Chunk the returned markdown.
 *   4. Embed each chunk (batched) via LiteLLM → Jina v5-text-nano.
 *   5. Persist chunks + flip the parent row to status='ready'.
 *
 * This runs fire-and-forget from the confirm endpoint. A sweep plugin
 * (`knowledge-sweep`) re-kicks rows stuck in `processing` past the
 * deadline — crash-safe in case the worker dies between step 2 and
 * step 5.
 *
 * Errors are caught at every phase and flip the row to `status='failed'`
 * with a short `errorMessage`. The original S3 object is left in place;
 * failed rows are shown with a red badge and a Delete action (no retry).
 */

// Cap the Valkey lock TTL well above any legitimate pipeline duration.
// Worst case: 300-chunk document (ceiling), 60s markitdown timeout, ~5
// chunks/sec embedding throughput = ~2 min. 10 min gives generous headroom
// + self-healing if a worker crashes without releasing the lock.
const PROCESS_LOCK_TTL_MS = 10 * MINUTE_MS

export async function processKnowledge(knowledgeId: string): Promise<void> {
  // Claim-check lock: the `status !== 'processing'` guard below is a
  // TOCTOU — two callers (e.g. the sweep plugin racing with the confirm
  // endpoint's fire-and-forget kick) can both read processing before
  // either writes. Without a claim, both proceed through the full
  // pipeline: double embedding cost and a chunks DELETE-then-INSERT race
  // that can clobber one run's output.
  //
  // We serialize with the Valkey session-lock primitive (same as
  // dictation's one-per-user cap). Second call fails to acquire → no-op.
  // TTL self-heals if a worker crashes mid-pipeline.
  const lockAcquired = await tryAcquireSessionLock('knowledge-process', knowledgeId, PROCESS_LOCK_TTL_MS)
  if (!lockAcquired) {
    log.info('already being processed by another worker, skipping', { knowledgeId })
    return
  }

  try {
    await runPipeline(knowledgeId)
  } finally {
    await releaseSessionLock('knowledge-process', knowledgeId)
  }
}

async function runPipeline(knowledgeId: string): Promise<void> {
  const db = useDatabase()

  const rows = await db.select().from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1)
  const row = rows[0]
  if (!row) {
    log.warn('knowledge row not found', { knowledgeId })
    return
  }
  if (row.status !== 'processing') {
    log.info('already past processing, skipping', { knowledgeId, status: row.status })
    return
  }

  try {
    // A misconfigured or mismatched embeddings setup disables knowledge
    // only: fail the row with the actionable reason before spending
    // conversion effort.
    await assertKnowledgeEmbeddingsReady()
    const markdown = await runConversion(row.s3Key, row.sourceExt)

    // Row may have been deleted by the user mid-conversion. Bail out
    // before we spend money on embeddings for a row nobody needs.
    if (!(await rowStillExists(knowledgeId))) {
      log.info('deleted during conversion, aborting', { knowledgeId })
      return
    }

    if (!markdown.trim()) {
      await markFailed(knowledgeId, 'markitdown produced empty markdown')
      return
    }

    const chunks = chunkMarkdown(markdown, { maxChunks: KNOWLEDGE_PLATFORM_LIMITS.maxChunksPerFile })
    if (chunks.length === 0) {
      await markFailed(knowledgeId, 'no chunks produced from parsed content')
      return
    }

    const embedCfg = resolveEmbeddingsConfig()
    const embeddings = await embedDocuments(
      chunks.map(c => c.content),
      { config: embedCfg }
    )

    // Retry layers can drop elements silently. Fail here rather than
    // inserting an `undefined` vector, which would crash later with a
    // confusing drizzle-encoding error.
    if (embeddings.length !== chunks.length) {
      await markFailed(knowledgeId,
        `embed returned ${embeddings.length} vectors for ${chunks.length} chunks`)
      return
    }

    // Final existence check before the write-heavy phase — embeddings
    // are the expensive step, but chunks insert + status flip still
    // waste FK-failed round trips if the row is gone.
    if (!(await rowStillExists(knowledgeId))) {
      log.info('deleted during embedding, aborting', { knowledgeId })
      return
    }

    const tokenCount = chunks.reduce((n, c) => n + c.tokens, 0)

    // Insert chunks + flip status in one logical step. The chunks insert
    // is a single round-trip (multi-row VALUES); the update is a single
    // UPDATE. We intentionally don't wrap in a transaction — pg+HNSW
    // writes don't play great inside long txns and partial inserts are
    // recoverable (a re-process deletes by knowledgeId first).
    await db.delete(workspaceKnowledgeChunks)
      .where(eq(workspaceKnowledgeChunks.knowledgeId, knowledgeId))

    if (chunks.length > 0) {
      await db.insert(workspaceKnowledgeChunks).values(
        chunks.map((c, i) => ({
          knowledgeId,
          workspaceId: row.workspaceId,
          chunkIndex: c.index,
          content: c.content,
          tokens: c.tokens,
          embedding: embeddings[i]!
        }))
      )
    }

    await db.update(workspaceKnowledge).set({
      status: 'ready' as const,
      chunkCount: chunks.length,
      tokenCount,
      markdownCache: markdown,
      embeddingVersion: embeddingVersionTag(embedCfg),
      processedAt: new Date(),
      errorMessage: null
    }).where(eq(workspaceKnowledge.knowledgeId, knowledgeId))

    // Original upload is no longer needed — we never serve it back and
    // `markdown_cache` has the parsed content the AI retrieves. Deleting
    // halves storage and removes the "stored an unvalidated binary
    // forever" concern. Best-effort: the delete on the row later will
    // try again if this fails (ignored 404s).
    try {
      const s3 = useS3Client()
      await s3.send(new DeleteObjectCommand({ Bucket: useEnv().storage.bucket, Key: row.s3Key }))
    } catch (e) {
      log.warn('original S3 delete failed (keeping row)', { knowledgeId, err: e })
      Sentry.captureException(e, {
        tags: { component: 'processKnowledge', event: 'post_success_s3_delete_failed', knowledgeId }
      })
    }

    log.info('ready', { knowledgeId, chunks: chunks.length, tokens: tokenCount })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('processing failed', { knowledgeId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'processKnowledge', event: 'pipeline_failed', knowledgeId }
    })
    await markFailed(knowledgeId, msg.slice(0, 500))
  }
}

async function markFailed(knowledgeId: string, message: string): Promise<void> {
  const db = useDatabase()
  await db.update(workspaceKnowledge).set({
    status: 'failed' as const,
    errorMessage: message,
    processedAt: new Date()
  }).where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
}

async function rowStillExists(knowledgeId: string): Promise<boolean> {
  const db = useDatabase()
  const rows = await db.select({ id: workspaceKnowledge.knowledgeId })
    .from(workspaceKnowledge)
    .where(eq(workspaceKnowledge.knowledgeId, knowledgeId))
    .limit(1)
  return rows.length > 0
}

async function runConversion(s3Key: string, ext: string): Promise<string> {
  const env = useEnv()
  if (!env.markitdown.url) {
    throw new Error('markitdown service not configured')
  }

  const s3 = useS3Client()
  const object = await s3.send(new GetObjectCommand({
    Bucket: env.storage.bucket,
    Key: s3Key
  }))
  const bytes = await object.Body!.transformToByteArray()

  const url = `${env.markitdown.url}/convert?ext=${encodeURIComponent(ext)}`
  // Markitdown doesn't parse sentry-trace headers, but they are still sent
  // so the app-side transaction shows this call as an outbound HTTP span.
  const response = await fetch(url, {
    method: 'POST',
    headers: injectTraceHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      ...markitdownAuthHeaders()
    }),
    body: bytes as BodyInit,
    signal: AbortSignal.timeout(MARKITDOWN_KNOWLEDGE_TIMEOUT_MS)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`markitdown returned ${response.status}: ${text.slice(0, 200)}`)
  }
  return await response.text()
}
