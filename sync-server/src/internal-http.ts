import type { IncomingMessage, ServerResponse } from 'node:http'
import { ypgPersistence } from './persistence'
import { matchesCurrentOrPrevious } from '../../shared/utils/secrets'
import { performKickUser, type HocuspocusInstance } from './kickUser'
import { Sentry } from './sentry'

export type { HocuspocusConnection, HocuspocusDocument, HocuspocusInstance } from './kickUser'

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
const INTERNAL_SECRET_PREVIOUS = process.env.INTERNAL_API_SECRET_PREVIOUS || undefined

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
  if (!INTERNAL_SECRET) {
    sendJson(response, 500, { error: 'Internal secret not configured' })
    return true
  }
  const providedSecret = request.headers['x-internal-secret']
  if (typeof providedSecret !== 'string' || !matchesCurrentOrPrevious(
    providedSecret,
    INTERNAL_SECRET,
    INTERNAL_SECRET_PREVIOUS
  )) {
    sendJson(response, 401, { error: 'Invalid internal secret' })
    return true
  }

  try {
    if (url === '/internal/notify-deleted' && request.method === 'POST') {
      const body = await readJsonBody(request) as { docId?: unknown }
      const docId = body?.docId
      if (typeof docId !== 'string') {
        sendJson(response, 400, { error: 'Missing docId' })
        return true
      }

      // Flag the in-memory Y.Doc as deleted — connected clients observe this
      // via ymeta and handle redirect/toast on their end.
      const doc = instance.documents?.get(docId)
      if (doc) {
        const ymeta = doc.getMap('meta')
        ymeta.set('_deleted', Date.now())
        // Let Hocuspocus broadcast the update, then unload after a short
        // delay so clients receive the message before the room closes.
        setTimeout(() => {
          try {
            instance.unloadDocument?.(doc)
          } catch { /* ignore */ }
        }, 2000)
      }

      // Clear the persisted Y.js rows so the doc can't be revived from disk.
      // Wait briefly so any in-flight broadcast persists `_deleted` first.
      setTimeout(() => {
        ypgPersistence.clearDocument(docId).catch((e) => {
          console.warn(`[internal-http] clearDocument(${docId}) failed:`, e instanceof Error ? e.message : e)
        })
      }, 3000)

      sendJson(response, 200, { success: true, notified: !!doc })
      return true
    }

    if (url === '/internal/kick-user' && request.method === 'POST') {
      // Force-close every live WS connection for a given user across a
      // given set of docs. Called by the app when a workspace membership
      // changes (role reduced, member removed, workspace deleted). The
      // client's Hocuspocus provider auto-reconnects, re-hits the token
      // endpoint, and picks up the new access level — so "kick" here
      // really means "refresh". Fire-and-forget from the app; we never
      // fail the caller's mutation on a kick failure.
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
      sendJson(response, 200, { success: true, kicked, docsNotLoaded: missing })
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
