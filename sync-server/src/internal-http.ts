import type { IncomingMessage, ServerResponse } from 'node:http'
import { ypgPersistence } from './persistence'
import { matchesCurrentOrPrevious } from '../../shared/utils/secrets'
import { performKickUser, type HocuspocusInstance } from './kickUser'
import { flushPendingStore } from './flushDocument'
import { Sentry } from './sentry'

export type { HocuspocusConnection, HocuspocusDocument, HocuspocusInstance } from './kickUser'

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
const INTERNAL_SECRET_PREVIOUS = process.env.INTERNAL_API_SECRET_PREVIOUS || undefined

// TEST_MODE-only ring buffer for kick-user observation. Lets integration
// tests assert "the workspace mutation actually dispatched a kick" — the
// dispatch shape is unit-tested in `tests/unit/syncNotify.test.ts`, but
// without this buffer there's no way to confirm the call SITES (every
// /api/workspaces/:wsId/members/* mutation handler) didn't silently drop
// the dispatch in a refactor. Test/prod drift guard.
//
// Gated on TEST_MODE so the prod sync-server never accumulates this
// state. Capped at 100 entries (LRU) — tests assert against recent
// state and clear between cases. Both endpoints require the same
// X-Internal-Secret as the rest of /internal/*; they are NOT a public
// surface even in test.
const TEST_MODE = process.env.TEST_MODE === '1'
const RECENT_KICKS_CAP = 100
interface RecordedKick { userId: string, docIds: string[], at: number }
const recentKicks: RecordedKick[] = []
function recordKick(userId: string, docIds: string[]) {
  if (!TEST_MODE) return
  recentKicks.push({ userId, docIds, at: Date.now() })
  if (recentKicks.length > RECENT_KICKS_CAP) recentKicks.splice(0, recentKicks.length - RECENT_KICKS_CAP)
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((n, c) => n + c.length, 0) > 10_000) {
      throw new Error('Body too large')
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

/**
 * Handles internal HTTP requests from the Nuxt app.
 * Called by Hocuspocus's `onRequest` hook. Returns `true` if the request
 * was handled (caller should not fall through); `false` otherwise.
 *
 * Distributed tracing: the app injects sentry-trace + baggage on every
 * outbound POST to the sync-server (server/utils/traceHeaders.ts). We
 * pull those headers off and feed them into Sentry.continueTrace +
 * startSpan so the sync-server's work shows up as a child of the app's
 * transaction in Sentry's Trace Explorer.
 */
export async function handleInternalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  instance: HocuspocusInstance
): Promise<boolean> {
  const url = request.url || ''

  if (!url.startsWith('/internal/')) return false

  // Extract upstream trace context. Both headers are case-insensitive on
  // node:http's headers object, so we read via the lowercase form.
  const sentryTrace = typeof request.headers['sentry-trace'] === 'string'
    ? request.headers['sentry-trace']
    : undefined
  const rawBaggage = request.headers['baggage']
  const baggage = typeof rawBaggage === 'string' ? rawBaggage : undefined

  return await Sentry.continueTrace({ sentryTrace, baggage }, () =>
    Sentry.startSpan(
      { name: `${request.method} ${url}`, op: 'http.server' },
      () => handleInternalRequestInner(request, response, instance, url)
    )
  )
}

async function handleInternalRequestInner(
  request: IncomingMessage,
  response: ServerResponse,
  instance: HocuspocusInstance,
  url: string
): Promise<boolean> {
  if (!authenticateInternalRequest(request, response)) return true
  try {
    if (url === '/internal/notify-deleted' && request.method === 'POST') {
      return await handleNotifyDeleted(request, response, instance)
    }
    if (url === '/internal/kick-user' && request.method === 'POST') {
      return await handleKickUser(request, response, instance)
    }
    if (url === '/internal/flush-document' && request.method === 'POST') {
      return await handleFlushDocument(request, response, instance)
    }
    // TEST_MODE-only inspection endpoints. The path includes `_test`
    // so it's grep-distinguishable from production paths in any audit.
    if (TEST_MODE && url === '/internal/_test/recent-kicks' && request.method === 'GET') {
      sendJson(response, 200, { kicks: recentKicks })
      return true
    }
    if (TEST_MODE && url === '/internal/_test/recent-kicks' && request.method === 'DELETE') {
      recentKicks.length = 0
      sendJson(response, 200, { cleared: true })
      return true
    }
    sendJson(response, 404, { error: 'Not found' })
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[internal-http]', msg)
    sendJson(response, 500, { error: msg })
    return true
  }
}

/** Verify the `X-Internal-Secret` header against current + previous secret (rotation grace). Returns false (and writes the error response) on failure. */
function authenticateInternalRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (!INTERNAL_SECRET) {
    sendJson(response, 500, { error: 'Internal secret not configured' })
    return false
  }
  const providedSecret = request.headers['x-internal-secret']
  if (typeof providedSecret !== 'string' || !matchesCurrentOrPrevious(
    providedSecret,
    INTERNAL_SECRET,
    INTERNAL_SECRET_PREVIOUS
  )) {
    sendJson(response, 401, { error: 'Invalid internal secret' })
    return false
  }
  return true
}

/**
 * Flag the in-memory Y.Doc as deleted — connected clients observe via
 * ymeta and handle redirect/toast on their end. After a short delay
 * we unload the doc + clear its persisted Y.js rows so it can't be
 * revived from disk.
 */
async function handleNotifyDeleted(
  request: IncomingMessage,
  response: ServerResponse,
  instance: HocuspocusInstance
): Promise<boolean> {
  const body = await readJsonBody(request) as { docId?: unknown }
  const docId = body?.docId
  if (typeof docId !== 'string') {
    sendJson(response, 400, { error: 'Missing docId' })
    return true
  }
  const doc = instance.documents?.get(docId)
  if (doc) {
    doc.getMap('meta').set('_deleted', Date.now())
    // Let Hocuspocus broadcast the update, then unload after a short
    // delay so clients receive the message before the room closes.
    setTimeout(() => {
      try {
        instance.unloadDocument?.(doc)
      } catch { /* ignore */ }
    }, 2000)
  }
  // Wait briefly so any in-flight broadcast persists `_deleted` first.
  setTimeout(() => {
    ypgPersistence.clearDocument(docId).catch((e) => {
      console.warn(`[internal-http] clearDocument(${docId}) failed:`, e instanceof Error ? e.message : e)
    })
  }, 3000)

  sendJson(response, 200, { success: true, notified: !!doc })
  return true
}

/**
 * Persist a loaded document's pending edits NOW instead of after the
 * store debounce, so the caller can read complete `yjs_documents` rows
 * (duplicate clones them). Answers once the store finished; `outcome`
 * says whether there was anything to store (see flushDocument.ts).
 */
async function handleFlushDocument(
  request: IncomingMessage,
  response: ServerResponse,
  instance: HocuspocusInstance
): Promise<boolean> {
  const body: unknown = await readJsonBody(request)
  const docId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).docId : undefined
  if (typeof docId !== 'string' || docId.length === 0) {
    sendJson(response, 400, { error: 'Missing docId' })
    return true
  }
  const outcome = await flushPendingStore(instance, docId)
  sendJson(response, 200, { success: true, outcome })
  return true
}

/**
 * Force-close every live WS connection for a given user across a
 * given set of docs. Called by the app when a workspace membership
 * changes (role reduced, member removed, workspace deleted). The
 * client's Hocuspocus provider auto-reconnects, re-hits the token
 * endpoint, and picks up the new access level — so "kick" here
 * really means "refresh". Fire-and-forget from the app; we never
 * fail the caller's mutation on a kick failure.
 */
async function handleKickUser(
  request: IncomingMessage,
  response: ServerResponse,
  instance: HocuspocusInstance
): Promise<boolean> {
  const body = await readJsonBody(request) as { userId?: unknown, docIds?: unknown }
  const rawUserId = body?.userId
  const rawDocIds = body?.docIds
  if ((typeof rawUserId !== 'string' && typeof rawUserId !== 'number')
    || !Array.isArray(rawDocIds)) {
    sendJson(response, 400, { error: 'userId (string|number) and docIds (string[]) required' })
    return true
  }
  // JWT payloads may carry userId as number (logged-in) or string
  // ('anonymous'). Compare as strings to cover both shapes without
  // a silent skip on number/string mismatch.
  const targetUserId = String(rawUserId)
  const targetDocIds = rawDocIds.filter((d): d is string => typeof d === 'string')

  const { kicked, missing } = performKickUser(instance, targetUserId, targetDocIds)
  // Record for TEST_MODE inspection — no-op in prod.
  recordKick(targetUserId, targetDocIds)
  sendJson(response, 200, { success: true, kicked, docsNotLoaded: missing })
  return true
}
