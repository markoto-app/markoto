import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { useDatabasePool } from './database'
import { useS3Client } from './s3'
import { useValkey } from './valkey'
import { injectTraceHeaders } from './traceHeaders'
import { flushSyncDocument } from './syncNotify'
import { resolveDocBrand } from './brandKit/docBrand'
import { getDoc } from '../repos/documents'
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
//   4. Two-tier singleflight: in-process Map (same-instance dedup) +
//      Valkey SET NX lock (cross-instance dedup). Without the Valkey lock
//      a thundering herd across N app instances would trigger N renders;
//      with it only one wins, the others poll for the manifest the winner
//      writes. Valkey-down failure path: in-process Map still helps; the
//      worst case is one duplicate render per instance, which is wasteful
//      but not corrupt (renderer is idempotent, manifest writes are
//      last-writer-wins on S3).
//
// Caching is keyed on snapshotId (latest yjs_documents.id), which changes
// any time the Y.Doc is updated — including theme changes pushed via
// ymeta. So no separate themeHash is needed.

export type RenderFormat = 'pdf' | 'png' | 'both'

export interface RenderManifest {
  snapshotId: number
  pageCount: number
  format: RenderFormat
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
// Lock TTL is set comfortably above RENDER_TIMEOUT_MS so the lock outlives
// the maximum legal render — without that buffer a slow render risks
// having its lock expire mid-flight, letting a second instance start a
// duplicate. The buffer also covers the S3 manifest write that runs
// after the renderer's HTTP response.
const RENDER_LOCK_TTL_MS = RENDER_TIMEOUT_MS + 30_000
// Loser-side polling cadence + ceiling. Poll until the winner's manifest
// shows up in S3, or until we exceed the lock TTL (after which the lock
// is gone and either the winner crashed or it's safe for us to render).
const RENDER_POLL_INTERVAL_MS = 750
const RENDER_POLL_CEILING_MS = RENDER_LOCK_TTL_MS

// In-process singleflight map. Key: `${docId}:${snapshotId}:${format}`.
// Concurrent calls for the same key share a single Promise. Cheaper than
// the Valkey lock — avoids one round-trip per duplicate same-process call
// (e.g. an AI tool batching `view_pages([1,2,3])` may issue parallel
// renderClient calls in the same Nitro worker).
const inflight = new Map<string, Promise<RenderResult>>()

/**
 * Try to acquire the cross-instance render lock. Returns true if we got
 * it (proceed to call the renderer); false if another instance holds it
 * (caller should poll for the manifest).
 *
 * Fails OPEN on Valkey error: if Valkey is unreachable we fall back to
 * single-instance dedup via the in-process Map. The cost is potential
 * duplicate renders (one per instance) which is wasteful but correct —
 * the renderer is idempotent and the manifest write is atomic. We'd
 * rather render twice than refuse all renders during a Valkey blip.
 */
async function tryAcquireRenderLock(key: string): Promise<boolean> {
  const lockKey = `lock:render:${key}`
  try {
    const valkey = useValkey()
    const res = await valkey.set(lockKey, '1', 'PX', RENDER_LOCK_TTL_MS, 'NX')
    return res === 'OK'
  } catch (e) {
    console.warn('[renderClient] valkey error on lock acquire, falling back to in-process dedup:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'renderClient', event: 'valkey_unavailable' }
    })
    // Fail open — see header comment.
    return true
  }
}

/**
 * Release the render lock. Best-effort: if Valkey is unreachable, the
 * lock self-expires via TTL.
 *
 * NOTE: no fencing token — if our render runs past `RENDER_LOCK_TTL_MS`
 * and another instance acquires the lock, our DEL would step on theirs.
 * The window is huge (≥120s, while typical renders are <15s) and the
 * worst-case consequence is one extra duplicate render. Adding a Lua
 * compare-and-delete isn't worth the friction at this scale; revisit
 * if telemetry shows the race actually happening.
 */
async function releaseRenderLock(key: string): Promise<void> {
  const lockKey = `lock:render:${key}`
  try {
    const valkey = useValkey()
    await valkey.del(lockKey)
  } catch { /* TTL will reclaim it */ }
}

/**
 * Loser-side wait: poll S3 manifest until the winner's render lands.
 * Returns the manifest if it shows up before the ceiling, null otherwise.
 *
 * Why poll instead of pub/sub: pub/sub would require the renderer (in a
 * separate container) to publish on completion, doubling the failure
 * surface — a missed publish would hang the loser forever. Polling
 * costs one S3 HEAD per `RENDER_POLL_INTERVAL_MS` (~80 HEADs/min at 750ms),
 * trivially cheap, and self-heals if the winner crashes silently.
 */
async function pollManifestUntilReady(
  docId: string,
  snapshotId: number,
  wantFormat: RenderFormat,
  variant: string | null = null
): Promise<RenderManifest | null> {
  const deadline = Date.now() + RENDER_POLL_CEILING_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, RENDER_POLL_INTERVAL_MS))
    const m = await readManifest(docId, snapshotId, variant)
    if (m && manifestSatisfies(m, wantFormat)) return m
  }
  return null
}

/** `renders/<docId>/<folder>/`: the snapshot id, plus the brand fingerprint when there is one. */
function renderFolder(snapshotId: number, variant: string | null): string {
  return variant ? `${snapshotId}-${variant}` : String(snapshotId)
}

/** The document's brand-kit fingerprint (null outside a workspace / without brand inputs). */
async function brandRenderVariant(docId: string): Promise<string | null> {
  try {
    const doc = await getDoc(docId)
    return (await resolveDocBrand(doc?.workspaceId ?? null)).fingerprint
  } catch {
    return null
  }
}

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
async function readManifest(docId: string, snapshotId: number, variant: string | null = null): Promise<RenderManifest | null> {
  const config = useRuntimeConfig()
  const s3 = useS3Client()
  const key = `renders/${docId}/${renderFolder(snapshotId, variant)}/manifest.json`
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
  format: RenderFormat,
  variant: string | null = null
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
    headers: injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': config.internalApiSecret
    }),
    body: JSON.stringify(variant ? { docId, snapshotId, format, variant } : { docId, snapshotId, format }),
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS)
  })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { error?: string }
      detail = body.error || ''
    } catch { /* non-JSON body */ }
    const tail = detail ? `: ${detail}` : ''
    throw new Error(`Renderer ${res.status}${tail}`)
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
  // The render reads the persisted Y.js rows (snapshot id + the print
  // page's bootstrap). Edits from the last 2–10 s may still sit in the
  // sync-server's debounced store — a PDF exported right after typing
  // came out with only the cover page (v0.2.4 release flow run). Persist
  // them first; on failure render what is stored, as before.
  await flushSyncDocument(docId)
  const snapshotId = await getLatestSnapshotId(docId)
  // Brand kit (WP10): a change to the workspace's fonts or locked design
  // writes no Y.js row, so the snapshot id alone would serve a stale
  // render — the brand fingerprint is part of the cache folder.
  const variant = await brandRenderVariant(docId)

  // First, check the cache. If a usable manifest exists for the requested
  // format (or a superset 'both'), reuse it. e.g. asking for PNG can
  // reuse a 'both' render.
  const cached = await readManifest(docId, snapshotId, variant)
  if (cached && manifestSatisfies(cached, opts.format)) {
    return { cached: true, manifest: cached }
  }

  const key = `${docId}:${renderFolder(snapshotId, variant)}:${opts.format}`
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = (async () => {
    let acquired = false
    try {
      // Cross-instance singleflight: try to claim the Valkey lock. Loser
      // path waits for the winner's manifest; winner path proceeds to
      // call the renderer.
      acquired = await tryAcquireRenderLock(key)
      if (!acquired) {
        const polled = await pollManifestUntilReady(docId, snapshotId, opts.format, variant)
        if (polled) return { cached: true, manifest: polled }
        // Polling timed out without a manifest. The lock has either
        // expired (winner crashed) or is still held by a slow render
        // we've stopped waiting on. Either way, attempting our own
        // render here is the correct recovery — better one extra
        // render than an opaque timeout to the user.
        console.warn(`[renderClient] poll timeout for ${key}, attempting own render`)
      }
      const out = await callRenderer(docId, snapshotId, opts.format, variant)
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
      if (acquired) await releaseRenderLock(key)
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

/**
 * One uncached PNG render of a render-bootstrap id that is not a stored
 * document — the design-import sample (`designImport/sampleRender.ts`),
 * whose content lives in Valkey for the render's duration. No snapshot,
 * no cache, no singleflight: every call is a different proposal. The
 * caller deletes `renders/{id}/` afterwards (`cleanupRendersForDoc`).
 */
export async function renderPngUncached(id: string, round: number): Promise<{ pageCount: number, pageKeys: string[] }> {
  const out = await callRenderer(id, round, 'png')
  return { pageCount: out.pageCount, pageKeys: out.pageKeys }
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
