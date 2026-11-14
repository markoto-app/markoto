import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { latestYjsId } from '../../repos/yjsLog'
import { useS3Client } from '../storage/s3'
import { useValkey } from '../platform/valkey'
import { injectTraceHeaders } from '../platform/traceHeaders'
import { flushSyncDocument } from '../documents/syncNotify'
import { resolveDocBrand } from '../brandKit/docBrand'
import type { DocAccess } from '../../repos/proofs'
import * as Sentry from '@sentry/nuxt'
import type { RenderFormat, RenderManifest, RenderRequest, RenderResponse, WebSnapshot } from '~~/shared/contracts/render'
import { renderErrorSchema, renderManifestSchema, renderResponseSchema } from '~~/shared/contracts/renderSchemas'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('render-client')

// Render orchestrator. Nuxt-side counterpart to renderer/src/render.ts:
//   1. Compute the doc's current snapshotId (newest yjs_updates row id).
//   2. HEAD s3://renders/{docId}/{snap}/manifest.json: cache hit short-
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
// Caching is keyed on snapshotId (newest yjs_updates.id), which changes
// any time the Y.Doc is updated, including theme changes pushed via
// ymeta. So no separate themeHash is needed.

export type { RenderFormat, RenderManifest, WebSnapshot } from '~~/shared/contracts/render'

export interface RenderResult {
  cached: boolean
  manifest: RenderManifest
}

const RENDER_TIMEOUT_MS = 90_000
/**
 * Longest one `renderDocument` call may take, waiting for another
 * instance's render included. Below the app server's idle timeout
 * (`server/runtime/bunEntry.ts`), so a too-slow render answers with a
 * 504 instead of a connection dropped without a reply.
 */
export const RENDER_DEADLINE_MS = 100_000
/** Time kept for our own render when another instance's render never showed up. */
const MIN_RENDER_BUDGET_MS = 15_000

/**
 * The render did not finish in time: the renderer's queue stayed full
 * (it answers 503 after its pool wait) or the deadline ran out. Callers
 * answer 504 `docs/render-timeout`; anything else is `docs/render-failed`.
 */
export class RenderTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RenderTimeoutError'
  }
}
// Lock TTL is set comfortably above RENDER_TIMEOUT_MS so the lock outlives
// the maximum legal render, without that buffer a slow render risks
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
// the Valkey lock: avoids one round-trip per duplicate same-process call
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
 * duplicate renders (one per instance) which is wasteful but correct,
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
    log.warn('valkey error on lock acquire, falling back to in-process dedup', { err: e })
    Sentry.captureException(e, {
      tags: { component: 'renderClient', event: 'valkey_unavailable' }
    })
    // Fail open: see header comment.
    return true
  }
}

/**
 * Release the render lock. Best-effort: if Valkey is unreachable, the
 * lock self-expires via TTL.
 *
 * NOTE: no fencing token, if our render runs past `RENDER_LOCK_TTL_MS`
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
 * surface: a missed publish would hang the loser forever. Polling
 * costs one S3 HEAD per `RENDER_POLL_INTERVAL_MS` (~80 HEADs/min at 750ms),
 * trivially cheap, and self-heals if the winner crashes silently.
 */
async function pollManifestUntilReady(
  docId: string,
  snapshotId: number,
  wantFormat: RenderFormat,
  variant: string | null,
  callDeadline: number
): Promise<RenderManifest | null> {
  const deadline = Math.min(Date.now() + RENDER_POLL_CEILING_MS, callDeadline - MIN_RENDER_BUDGET_MS)
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
async function brandRenderVariant(doc: DocAccess<'view'>): Promise<string | null> {
  try {
    return (await resolveDocBrand(doc)).fingerprint
  } catch {
    return null
  }
}

/**
 * Newest `yjs_updates` id for the doc. Returns 0 when no rows exist,
 * a doc that was created but never saw a single Y.js update. Note: 0
 * is also what `reconstructDocAtYjsId` treats as "empty doc".
 */
async function getLatestSnapshotId(doc: DocAccess<'view'>): Promise<number> {
  return (await latestYjsId(doc)) ?? 0
}

/**
 * HEAD the manifest. Returns the parsed manifest if present, null on 404
 * or any error (we re-render rather than fail closed, the renderer is
 * idempotent so a wasteful re-render is preferable to a confusing 500).
 */
async function readManifest(docId: string, snapshotId: number, variant: string | null = null): Promise<RenderManifest | null> {
  const env = useEnv()
  const s3 = useS3Client()
  const key = `renders/${docId}/${renderFolder(snapshotId, variant)}/manifest.json`
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.storage.bucket, Key: key }))
  } catch {
    return null
  }
  // Manifest exists: fetch + parse.
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: env.storage.bucket, Key: key }))
    if (!got.Body) return null
    return renderManifestSchema.parse(JSON.parse(await got.Body.transformToString()))
  } catch (e) {
    log.warn('manifest GET failed', { docId, snapshotId, err: e })
    return null
  }
}

/** `fetch` with a timeout that surfaces as RenderTimeoutError. */
async function postWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new RenderTimeoutError(`Renderer gave no answer within ${timeoutMs} ms`, { cause: e })
    }
    throw e
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
  format: RenderFormat | 'html',
  variant: string | null = null,
  timeoutMs = RENDER_TIMEOUT_MS
): Promise<RenderResponse> {
  const env = useEnv()
  if (!env.renderer.internalUrl) {
    throw new Error('Renderer not configured (NUXT_RENDERER_INTERNAL_URL missing)')
  }
  if (!env.auth.internalApiSecret) {
    throw new Error('Renderer call requires internalApiSecret')
  }

  const res = await postWithTimeout(`${env.renderer.internalUrl}/render`, {
    method: 'POST',
    headers: injectTraceHeaders({
      'Content-Type': 'application/json',
      'X-Internal-Secret': env.auth.internalApiSecret
    }),
    body: JSON.stringify(variant ? { docId, snapshotId, format, variant } satisfies RenderRequest : { docId, snapshotId, format } satisfies RenderRequest)
  }, timeoutMs)

  if (!res.ok) {
    let detail = ''
    try {
      const body = renderErrorSchema.safeParse(await res.json())
      detail = body.success ? body.data.error || '' : ''
    } catch { /* non-JSON body */ }
    const tail = detail ? `: ${detail}` : ''
    // 503: the renderer's page pool stayed full for its whole queue wait.
    if (res.status === 503) throw new RenderTimeoutError(`Renderer ${res.status}${tail}`)
    throw new Error(`Renderer ${res.status}${tail}`)
  }

  return renderResponseSchema.parse(await res.json())
}

interface RenderJob {
  docId: string
  snapshotId: number
  format: 'pdf' | 'png' | 'both'
  variant: string | null
  /** Singleflight / lock key. */
  key: string
  /** Epoch ms the caller gives up at (RENDER_DEADLINE_MS). */
  deadline: number
}

/**
 * Render, or (without the cross-instance lock) wait for the instance that
 * holds it and render ourselves if its manifest never shows up.
 */
async function renderOrAwait(job: RenderJob, lockHeld: boolean): Promise<RenderResult> {
  const { docId, snapshotId, format, variant, key, deadline } = job
  if (!lockHeld) {
    const polled = await pollManifestUntilReady(docId, snapshotId, format, variant, deadline)
    if (polled) return { cached: true, manifest: polled }
    // Polling timed out without a manifest. The lock has either
    // expired (winner crashed) or is still held by a slow render
    // we've stopped waiting on. Either way, attempting our own
    // render here is the correct recovery, better one extra
    // render than an opaque timeout to the user.
    log.warn('poll timeout, attempting own render', { key })
  }
  const budget = deadline - Date.now()
  if (budget < MIN_RENDER_BUDGET_MS) {
    throw new RenderTimeoutError(`No time left to render ${key} (${budget} ms)`)
  }
  const out = await callRenderer(docId, snapshotId, format, variant, Math.min(RENDER_TIMEOUT_MS, budget))
  const manifest: RenderManifest = {
    snapshotId,
    pageCount: out.pageCount,
    format,
    renderedAt: new Date().toISOString(),
    pdfKey: out.pdfKey ?? null,
    pageKeys: out.pageKeys
  }
  return { cached: false, manifest }
}

/**
 * Get (or generate) a render of `docId` for the requested format. Cache
 * hits short-circuit before talking to the renderer. Concurrent calls for
 * the same key share one Promise via the singleflight Map.
 */
export async function renderDocument(
  doc: DocAccess<'view'>,
  opts: { format: 'pdf' | 'png' | 'both' }
): Promise<RenderResult> {
  const docId = doc.docId
  // Every wait below (the sync flush, another instance's render, our own
  // render) shares this budget. Throws RenderTimeoutError when it runs out.
  const deadline = Date.now() + RENDER_DEADLINE_MS
  // The render reads the persisted Y.js rows (snapshot id + the print
  // page's bootstrap). Edits from the last 2–10 s may still sit in the
  // sync-server's debounced store, so a PDF exported right after typing
  // would miss them. Persist them first; on failure render what is stored.
  await flushSyncDocument(docId)
  const snapshotId = await getLatestSnapshotId(doc)
  // Brand kit: a change to the workspace's fonts or locked design
  // writes no Y.js row, so the snapshot id alone would serve a stale
  // render: the brand fingerprint is part of the cache folder.
  const variant = await brandRenderVariant(doc)

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

  const job: RenderJob = { docId, snapshotId, format: opts.format, variant, key, deadline }
  const promise = (async () => {
    let acquired = false
    try {
      // Cross-instance singleflight: try to claim the Valkey lock. Loser
      // path waits for the winner's manifest; winner path proceeds to
      // call the renderer.
      acquired = await tryAcquireRenderLock(key)
      return await renderOrAwait(job, acquired)
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
 * document: the design-import sample (`designImport/sampleRender.ts`),
 * whose content lives in Valkey for the render's duration. No snapshot,
 * no cache, no singleflight: every call is a different proposal. The
 * caller deletes `renders/{id}/` afterwards (`cleanupRendersForDoc`).
 */
export async function renderPngUncached(id: string, round: number): Promise<{ pageCount: number, pageKeys: string[] }> {
  const out = await callRenderer(id, round, 'png')
  return { pageCount: out.pageCount, pageKeys: out.pageKeys }
}

/**
 * The document's current state as a web snapshot (publish): the
 * print page's sanitised HTML + theme CSS without pagination or cover.
 * Uncached: publishing is an explicit, rate-limited action and the
 * result is stored in `published_pages` by the caller.
 */
export async function renderWebSnapshot(doc: DocAccess<'view'>): Promise<WebSnapshot> {
  const docId = doc.docId
  await flushSyncDocument(docId)
  const snapshotId = await getLatestSnapshotId(doc)
  const out = await callRenderer(docId, snapshotId, 'html')
  if (!out.web) throw new Error('Renderer returned no web snapshot')
  return out.web
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
  const env = useEnv()
  const s3 = useS3Client()
  const prefix = `renders/${docId}/`
  try {
    const keysToDelete: { Key: string }[] = []
    let continuationToken: string | undefined
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: env.storage.bucket,
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
        Bucket: env.storage.bucket,
        Delete: { Objects: batch, Quiet: true }
      }))
    }
    return keysToDelete.length
  } catch (e) {
    log.warn('renders cleanup failed', { docId, err: e })
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
