import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { useDatabasePool } from './database'
import { useS3Client } from './s3'
import * as Sentry from '@sentry/nuxt'

// Render orchestrator. Nuxt-side counterpart to renderer/src/render.ts:
//   1. Compute the doc's current snapshotId (latest yjs_documents row id).
//   2. HEAD s3://renders/{docId}/{snap}/manifest.json — cache hit short-
//      circuits everything else.
//   3. POST the renderer container with the docId + snapshotId + format,
//      gated by INTERNAL_API_SECRET. The renderer materializes the doc
//      via the internal print page (which boots its own Hocuspocus client),
//      runs paged.js, captures PDF + per-page PNGs, uploads to S3, and
//      writes the manifest LAST as the readiness sentinel.
//   4. Singleflight: dedupe concurrent calls for the same (docId, snap,
//      format) so a thundering herd of "Download PDF" clicks only triggers
//      one render.
//
// Caching is keyed on snapshotId (latest yjs_documents.id), which changes
// any time the Y.Doc is updated — including theme changes pushed via
// ymeta. So no separate themeHash is needed.

export interface RenderManifest {
  snapshotId: number
  pageCount: number
  format: 'pdf' | 'png' | 'both'
  renderedAt: string
  pdfKey: string | null
  pageKeys: string[]
}

export interface RenderResult {
  cached: boolean
  manifest: RenderManifest
}

interface RendererSuccess {
  pageCount: number
  pdfKey?: string
  pageKeys: string[]
}

const RENDER_TIMEOUT_MS = 90_000

// In-process singleflight map. Key: `${docId}:${snapshotId}:${format}`.
// Concurrent calls for the same key share a single Promise.
const inflight = new Map<string, Promise<RenderResult>>()

/**
 * Latest yjs_documents.id for the doc. Returns 0 when no rows exist —
 * a doc that was created but never saw a single Y.js update. Note: 0
 * is also what `reconstructDocAtYjsId` treats as "empty doc".
 */
async function getLatestSnapshotId(docId: string): Promise<number> {
  const pool = useDatabasePool()
  const res = await pool.query<{ id: number | null }>(
    `SELECT MAX(id) AS id FROM yjs_documents WHERE docname = $1`,
    [docId]
  )
  return Number(res.rows[0]?.id ?? 0)
}

/**
 * HEAD the manifest. Returns the parsed manifest if present, null on 404
 * or any error (we re-render rather than fail closed — the renderer is
 * idempotent so a wasteful re-render is preferable to a confusing 500).
 */
async function readManifest(docId: string, snapshotId: number): Promise<RenderManifest | null> {
  const config = useRuntimeConfig()
  const s3 = useS3Client()
  const key = `renders/${docId}/${snapshotId}/manifest.json`
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }))
  } catch {
    return null
  }
  // Manifest exists — fetch + parse.
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }))
    const text = await got.Body!.transformToString()
    return JSON.parse(text) as RenderManifest
  } catch (e) {
    console.warn(`[renderClient] manifest GET failed for ${docId}@${snapshotId}:`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * POST the renderer container. Throws on 4xx/5xx so callers can surface
 * the error to the user / AI tool. On success, returns the renderer's
 * `{ pageCount, pdfKey?, pageKeys[] }`. The manifest is written by the
 * renderer itself (so partial renders show as no manifest).
 */
async function callRenderer(
  docId: string,
  snapshotId: number,
  format: 'pdf' | 'png' | 'both'
): Promise<RendererSuccess> {
  const config = useRuntimeConfig()
  if (!config.rendererInternalUrl) {
    throw new Error('Renderer not configured (NUXT_RENDERER_INTERNAL_URL missing)')
  }
  if (!config.internalApiSecret) {
    throw new Error('Renderer call requires internalApiSecret')
  }

  const res = await fetch(`${config.rendererInternalUrl}/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalApiSecret
    },
    body: JSON.stringify({ docId, snapshotId, format }),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { error?: string }
      detail = body.error || ''
    } catch { /* non-JSON body */ }
    throw new Error(`Renderer ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  return await res.json() as RendererSuccess
}

/**
 * Get (or generate) a render of `docId` for the requested format. Cache
 * hits short-circuit before talking to the renderer. Concurrent calls for
 * the same key share one Promise via the singleflight Map.
 */
export async function renderDocument(
  docId: string,
  opts: { format: 'pdf' | 'png' | 'both' }
): Promise<RenderResult> {
  const snapshotId = await getLatestSnapshotId(docId)

  // First, check the cache. If a usable manifest exists for the requested
  // format (or a superset 'both'), reuse it. e.g. asking for PNG can
  // reuse a 'both' render.
  const cached = await readManifest(docId, snapshotId)
  if (cached && manifestSatisfies(cached, opts.format)) {
    return { cached: true, manifest: cached }
  }

  const key = `${docId}:${snapshotId}:${opts.format}`
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = (async () => {
    try {
      const out = await callRenderer(docId, snapshotId, opts.format)
      const manifest: RenderManifest = {
        snapshotId,
        pageCount: out.pageCount,
        format: opts.format,
        renderedAt: new Date().toISOString(),
        pdfKey: out.pdfKey ?? null,
        pageKeys: out.pageKeys
      }
      return { cached: false, manifest }
    } catch (e) {
      // Surface for ops; the calling endpoint shapes the user-facing error.
      Sentry.captureException(e, {
        tags: { component: 'renderClient', event: 'render_failed', docId },
        extra: { snapshotId, format: opts.format }
      })
      throw e
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

function manifestSatisfies(m: RenderManifest, want: 'pdf' | 'png' | 'both'): boolean {
  if (m.format === 'both') return true
  return m.format === want
}

/**
 * Wipe `renders/{docId}/...` from S3. Called from deleteDocument's S3
 * cleanup phase so a deleted doc doesn't leave stale renders behind.
 * Mirrors `cleanupDocS3` in documentLifecycle.ts.
 */
export async function cleanupRendersForDoc(docId: string): Promise<number> {
  const config = useRuntimeConfig()
  const s3 = useS3Client()
  const prefix = `renders/${docId}/`
  try {
    const keysToDelete: { Key: string }[] = []
    let continuationToken: string | undefined
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: config.s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }))
      for (const obj of list.Contents || []) {
        if (obj.Key) keysToDelete.push({ Key: obj.Key })
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (continuationToken)
    for (let i = 0; i < keysToDelete.length; i += 1000) {
      const batch = keysToDelete.slice(i, i + 1000)
      await s3.send(new DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    }
    return keysToDelete.length
  } catch (e) {
    console.warn(`[renderClient] renders cleanup failed for ${docId}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'renderClient', event: 'renders_cleanup_failed', docId }
    })
    return 0
  }
}

// Re-export for tests that want to clear the inflight map between cases.
// Not part of the production API.
export const __testing = {
  inflight,
  getLatestSnapshotId,
  readManifest
}
