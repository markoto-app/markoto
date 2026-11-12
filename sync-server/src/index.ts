// Validate the environment first so a misconfigured deploy fails with a
// clear message before any other module reads its configuration.
import './boot-env'
// Sentry must be imported early so its Bun instrumentation patches stdlib
// targets before any other module grabs references to them. Importing a
// name from the module also satisfies the side-effect import.
import { captureMessage } from './sentry'
import { Server } from '@hocuspocus/server'
import { ypgPersistence } from './persistence'
import { authFromEnv } from './auth'
import { rateLimiter } from './rate-limiter'
import { logActivity, mostRecentVerifiedEditor, countWords, lineDiff, type VerifiedIdentity } from './activity-logger'
import { parseSyncLimits } from './limits'
import { createUpdateGuard, SyncRejection } from './update-guard'
import { createPreAuthGuard, parsePreAuthLimits } from './pre-auth-guard'
import { attachAwarenessGuard, awarenessIdentities, anonAvatarSeedForSocket, ANONYMOUS_USER_ID } from './awareness-guard'
import { normalizeAvatarSeed } from '../../shared/utils/documents/awarenessUser'
import { readMetaSnapshot } from './meta-snapshot'
import { SYNC_CLOSE_REASONS } from '../../shared/contracts/syncClose'
import { handleInternalRequest } from './internal-http'
import { startCompactionSweeper, stopCompactionSweeper } from './compaction'
import { shipCommentsSnapshot, dropSnapshotCache } from './comments-snapshot'
import {
  getLastEditor,
  setLastEditor,
  getPrevText,
  setPrevText,
  getPrevMeta,
  setPrevMeta,
  dropDocState
} from './sync-state'
import { closeValkey } from './valkey'
import { createConnectionExpiry, type ReauthConnection } from './connection-expiry'
import { syncEnv } from './env'

// Auth singleton — wired from env here (not inside auth.ts) so unit tests
// can import `createAuth` without tripping a top-level env guard.
const auth = authFromEnv()

const port = syncEnv().sync.port

// Per-doc attribution + diff baseline state lives in Valkey (`sync-state.ts`).
//   - last-editor: populated in onChange (authoritative — JWT payload from
//     authenticated connection context); read in onStoreDocument. Falls back
//     to the awareness heuristic on miss (cold doc / restart) or error
//     (Valkey down). Sentry tag distinguishes the two.
//   - prev-text: re-seeded from disk in onLoadDocument so the first diff
//     after load is measured against persisted state, not "".
//   - prev-meta: same — seeded against current title/theme so the first
//     store doesn't emit a spurious "title changed" with null `from`.
// 24 h TTL on every key — a doc untouched for 24 h is "cold" and the next
// edit can rebuild attribution from awareness without harm. Keeping all
// state externalised lets multiple sync-server containers share the view.

// Size limits (SYNC_MAX_{MESSAGE,UPDATE,DOCUMENT}_BYTES) + pre-apply
// validation of every client update. See limits.ts / update-guard.ts.
const syncLimits = parseSyncLimits(syncEnv())
const updateGuard = createUpdateGuard(syncLimits)

// Memory cap for messages queued before a document authenticates
// (SYNC_MAX_PREAUTH_BYTES / SYNC_MAX_PREAUTH_TOTAL_BYTES /
// SYNC_AUTH_TIMEOUT_MS). See pre-auth-guard.ts.
// Closes connections whose token expired without being renewed in place.
// See connection-expiry.ts.
const connectionExpiry = createConnectionExpiry({
  onExpired: (conn) => {
    console.warn(`[hocuspocus] closing connection with an expired token (user ${String(conn.context?.userId ?? '?')})`)
  }
})

const preAuthGuard = createPreAuthGuard(parsePreAuthLimits(syncEnv()), {
  onReject: (reason, detail) => {
    console.warn(`[hocuspocus] closing socket before authentication: ${reason} (${detail})`)
    captureMessage('[hocuspocus] pre-auth socket closed', {
      level: 'warning',
      tags: { component: 'hocuspocus', event: 'preauth_rejected', reason }
    })
  }
})

const server = new Server({
  port,
  debounce: 2000,
  maxDebounce: 10000,

  async onLoadDocument(data) {
    const doc = await ypgPersistence.onLoadDocument(data)
    // Seeding the diff baselines is best-effort: a failure here must never
    // reject the load (Hocuspocus would refuse every connection to the
    // document — a corrupted value in it would make it unloadable and
    // therefore unrepairable).
    try {
      // Seed the previous-text cache so the FIRST diff after load is measured
      // against what was on disk, not against an empty string (which would
      // otherwise report a huge "+N lines" on the next store).
      // Y.Text exposes the doc body via toString(); prefer the equivalent
      // toJSON() which TS can verify returns string (Sonar can't see Y.Text's
      // toString override otherwise — S6551).
      const ytext = doc.getText('content')
      await setPrevText(data.documentName, ytext.toJSON())
      // Same for title + theme: seed against current state so the first
      // store after load doesn't emit a spurious "title changed" with a
      // null `from` value.
      await setPrevMeta(data.documentName, readMetaSnapshot(doc))
    } catch (e) {
      console.warn(`[hocuspocus] baseline seed failed for ${data.documentName}:`, e instanceof Error ? e.message : e)
    }
    return doc
  },

  async afterLoadDocument(data) {
    attachAwarenessGuard(data.document)
  },

  async beforeHandleMessage(data) {
    try {
      updateGuard.check(data.document, data.update, data.connection.readOnly)
    } catch (e) {
      // Anything unexpected inside the guard fails closed too, with a
      // reason the editor recognises (so it stops resending the update).
      const rejection = e instanceof SyncRejection
        ? e
        : new SyncRejection(SYNC_CLOSE_REASONS.invalidUpdate, e instanceof Error ? e.message : 'guard error')
      console.warn(`[hocuspocus] ${rejection.message} on ${data.documentName} (socket ${data.socketId})`)
      captureMessage('[hocuspocus] update rejected', {
        level: 'warning',
        tags: { component: 'hocuspocus', event: 'update_rejected', reason: rejection.reason }
      })
      throw rejection
    }
  },

  async onChange(data) {
    // Record the authenticated user who just made a change. `context` carries
    // what we returned from onAuthenticate (readOnly, userId, userName).
    const ctx = (data as { context?: { userId?: string, userName?: string | null } }).context
    if (ctx?.userId) {
      // An anonymous editor's activity rows carry the avatar token its
      // awareness announced over this same connection (the transaction
      // origin is the Hocuspocus Connection), so the feed shows the
      // face the presence bar shows.
      const avatarSeed = ctx.userId === ANONYMOUS_USER_ID
        ? anonAvatarSeedForSocket(data.document, connectionSocket(data.transactionOrigin))
        : null
      await setLastEditor(data.documentName, {
        userName: ctx.userName ?? null,
        userId: ctx.userId,
        avatarSeed,
        at: Date.now()
      })
    }
  },

  async onStoreDocument(data) {
    // Capture the y-postgresql row id BEFORE the store so the activity
    // log can stamp boundary ids around this event. After the store,
    // we'll capture the id again — together they bracket the operations
    // that produced this debounce window's changes, so the diff
    // endpoint can replay the doc on either side.
    // BEFORE: capture the latest persisted row for this doc prior to
    // our store. Null on a brand-new doc with no rows yet — the first
    // edit is intentionally not restorable (no prior state to roll
    // back to).
    const yjsDocIdBefore = await ypgPersistence.getMaxYjsDocId(data.documentName)
    // AFTER: use the row id returned by the store itself rather than a
    // follow-up MAX query, which can return null across separate pg pools
    // (suspected snapshot timing). The returned id is also the correct one:
    // it's the id WE wrote, not whatever the latest
    // row happens to be by the time we re-query (which under
    // multi-instance concurrency could be a row a different instance
    // wrote).
    const yjsDocIdAfter = await ypgPersistence.onStoreDocument(
      data,
      bytes => updateGuard.noteDocumentSize(data.document, bytes)
    )

    // Read the tracked editor ONCE for the whole hook so the edit-row and
    // meta-diff blocks below see consistent attribution. Valkey miss vs
    // error are tagged separately for ops visibility (miss is normal —
    // cold doc / restart; error is operationally interesting — Valkey down).
    const trackedFetch = await getLastEditor(data.documentName)
    const tracked = trackedFetch.value

    await logEditActivity(data, trackedFetch, yjsDocIdBefore, yjsDocIdAfter)
    await logMetaDiffActivity(data, tracked, yjsDocIdBefore, yjsDocIdAfter)

    // Postgres mirror of the comments Y.Array — fire-and-forget so a
    // mirror failure can't take down activity logging or sync. Internal
    // dedup ensures the round-trip is skipped when the comments array
    // didn't change since the last store. Async errors land on the
    // explicit `.catch()` — a bare try/catch wouldn't catch them since
    // `shipCommentsSnapshot` returns a Promise (typescript:S4822).
    shipCommentsSnapshot(data.documentName, data.document, { yjsDocIdBefore, yjsDocIdAfter })
      .catch((e) => {
        console.warn('[hocuspocus] comments-snapshot ship failed:', e instanceof Error ? e.message : e)
      })
  },

  async onAuthenticate(data) {
    return auth.onAuthenticate(data)
  },

  async onTokenSync(data) {
    // The client's answer to a token request from connectionExpiry.
    await connectionExpiry.renew(data.connection, data.token, data.documentName, auth.verifyDocToken)
  },

  async connected(data) {
    // The document's pre-auth queue has been replayed: stop counting it.
    preAuthGuard.documentEstablished(data.request, data.socketId, data.documentName)
    const conn = data.connection as ReauthConnection
    const expiresAt = (data.context as { tokenExpiresAt?: unknown } | undefined)?.tokenExpiresAt
    // Already gone (socket dropped while the queue replayed): its close
    // callbacks have run, so a timer set now would never be cleared.
    if (!data.connection.document.hasConnection(data.connection)) return
    if (typeof expiresAt === 'number') {
      connectionExpiry.track(conn, expiresAt)
      data.connection.onClose(() => connectionExpiry.untrack(conn))
    } else {
      // onAuthenticate always sets it; a connection without one would
      // never expire, so refuse it.
      data.connection.close()
    }
  },

  async onConnect(data) {
    rateLimiter.onConnect(data)
  },

  async onDisconnect(data) {
    rateLimiter.onDisconnect(data)
    preAuthGuard.documentClosed(data.socketId, data.documentName)
    // Free attribution/diff state when the last client leaves the room.
    // `clientsCount` in onDisconnect reflects the count AFTER this disconnect;
    // 0 means we just lost the last collaborator. onLoadDocument re-seeds the
    // caches if someone reconnects.
    //
    // CAVEAT (multi-instance): with 2+ sync containers, this only knows
    // about clients on the SAME container. Another container may still
    // have active clients on this doc — clearing Valkey here would erase
    // their diff baseline. We accept the "leak" (state lingers under the
    // 24h TTL) over a multi-container DELETE-storm. Valkey TTL handles
    // long-tail cleanup.
    if (data.clientsCount === 0 && data.documentName) {
      await dropDocState(data.documentName)
      dropSnapshotCache(data.documentName)
    }
  },

  async onRequest(data) {
    // Public unauthenticated probe for Docker HEALTHCHECK. Must come before any
    // secret-checked routes so the healthcheck doesn't need to know secrets.
    if (data.request.url === '/health' && data.request.method === 'GET') {
      data.response.writeHead(200, { 'Content-Type': 'text/plain' })
      data.response.end('ok')
      throw null
    }

    // Handle internal HTTP endpoints (secret-auth'd); if handled, throw a
    // special sentinel to stop Hocuspocus from processing the request further.
    const handled = await handleInternalRequest(data.request, data.response, data.instance)
    if (handled) {
      // Hocuspocus checks for written response and skips default handling
      throw null
    }
  }
}, {
  // Frames above this are refused by `ws` itself (close 1009) before they
  // are buffered further or reach Hocuspocus.
  maxPayload: syncLimits.maxMessageBytes
})

// Release the socket's rate-limit slots on EVERY teardown. Hocuspocus's
// onDisconnect only fires for connections that authenticated, so failed
// handshakes would leak their slot for good (see rate-limiter.ts).
// Registered after Hocuspocus's own `connection` listener (set up in the
// Server constructor), so the pre-auth guard's `message` listener runs
// after Hocuspocus has queued each frame.
server.webSocketServer.on('connection', (socket, request) => {
  rateLimiter.trackSocket(socket, request)
  preAuthGuard.trackSocket(socket, request)
})

server.listen(port, () => {
  console.log(`[hocuspocus] Sync server listening on port ${port}`)
})

// Background compaction of the yjs_documents append-log. y-postgresql only
// merges granular update rows on document LOAD, so an always-loaded (never
// re-loaded) doc grows unbounded — this sweep bounds it. See compaction.ts
// for the race-safety design.
startCompactionSweeper()

// onStoreDocument helpers

type StoreDocumentData = Parameters<NonNullable<NonNullable<ConstructorParameters<typeof Server>[0]>['onStoreDocument']>>[0]

/** The raw WebSocket of a Hocuspocus `Connection` transaction origin. */
function connectionSocket(origin: unknown): unknown {
  if (typeof origin !== 'object' || origin === null) return null
  return (origin as Record<string, unknown>).webSocket ?? null
}

/** Avatar token for an anonymous editor's activity row, else null. */
function anonActivitySeed(editor: { userId: string | null, avatarSeed?: string | null } | null): string | null {
  if (editor?.userId !== ANONYMOUS_USER_ID) return null
  return normalizeAvatarSeed(editor.avatarSeed)
}

/**
 * Resolve the user attribution for an activity row. Prefers the
 * onChange-tracked authenticated user (JWT payload). Falls back to the
 * awareness heuristic when nothing has been tracked (cold doc /
 * restart, or Valkey down). Logs a Sentry warning on the fallback path
 * so prod drift is visible.
 *
 * Every name here comes from a JWT, never from the client-controlled
 * awareness payload: a tracked anonymous editor stays anonymous
 * (`userName: null`, principal `anonymous`), and the fallback names the
 * JWT identity of the connection whose awareness moved last.
 */
function resolveAttribution(
  data: StoreDocumentData,
  trackedFetch: Awaited<ReturnType<typeof getLastEditor>>
): { userName: string | null, userId: number | null, actorPrincipal: string | null, actorAvatarSeed: string | null } {
  const tracked = trackedFetch.value
  let fallback: VerifiedIdentity | null = null
  if (!tracked) {
    const cause = trackedFetch.cause === 'error' ? 'valkey-error' : 'valkey-miss'
    const errMsg = trackedFetch.error ? ` (${trackedFetch.error.message})` : ''
    console.warn(`[hocuspocus] Attribution fallback for doc ${data.documentName}: cause=${cause}${errMsg}, using awareness heuristic`)
    captureMessage(`[hocuspocus] Attribution fallback for doc ${data.documentName}`, {
      level: 'warning',
      tags: { component: 'hocuspocus', event: 'attribution_fallback', cause }
    })
    fallback = mostRecentVerifiedEditor(awarenessIdentities(data.document))
  }
  const editor = tracked ?? fallback
  // The JWT userId is a string. Real users get a numeric id (parsed →
  // integer for activity_log.user_id); synthetic principals
  // (`ai:assistant:{sid}`, `mcp:{sid}`, `anonymous`) are non-numeric and
  // resolve to null on `parseTrackedUserId`. We pass the RAW string
  // through `actorPrincipal` so the app-side activity row can join back
  // to ai_sessions / mcp_sessions and resolve the human initiator.
  return {
    userName: editor?.userName ?? null,
    userId: parseTrackedUserId(editor?.userId),
    actorPrincipal: parseActorPrincipal(editor?.userId),
    actorAvatarSeed: anonActivitySeed(editor)
  }
}

function parseTrackedUserId(rawUserId: string | null | undefined): number | null {
  if (!rawUserId) return null
  const n = Number(rawUserId)
  return Number.isFinite(n) ? n : null
}

/** Returns the raw JWT.userId when it's a synthetic-principal string
 *  (non-numeric), null otherwise. The verifier list lives in
 *  `shared/contracts/jwt.ts` (`SYNTHETIC_USER_ID_PREFIXES`); we
 *  duplicate the prefix check here to keep the sync-server free of
 *  shared/-folder imports (it has its own minimal dep tree). */
function parseActorPrincipal(rawUserId: string | null | undefined): string | null {
  if (!rawUserId) return null
  if (Number.isFinite(Number(rawUserId))) return null // numeric → real user
  return rawUserId
}

/**
 * Log an `edit` activity entry per store event (debounced 2-10s by
 * Hocuspocus). On a Valkey miss (cold doc / restart) or Valkey error,
 * we skip emitting an edit row but DO write the new baseline so the
 * next store has something to diff against — better than emitting a
 * spurious "+N lines whole doc" row.
 *
 * Fire-and-forget: errors are logged so sync is never blocked.
 */
async function logEditActivity(
  data: StoreDocumentData,
  trackedFetch: Awaited<ReturnType<typeof getLastEditor>>,
  yjsDocIdBefore: number | null,
  yjsDocIdAfter: number | null
): Promise<void> {
  try {
    const ytext = data.document.getText('content')
    const currentText = ytext.toJSON()
    const wordCount = countWords(currentText)
    const { userName, userId, actorPrincipal, actorAvatarSeed } = resolveAttribution(data, trackedFetch)

    const prevFetch = await getPrevText(data.documentName)
    await setPrevText(data.documentName, currentText)

    if (prevFetch.value == null) return
    const { added, removed } = lineDiff(prevFetch.value, currentText)
    // Skip the edit entry if nothing changed line-wise (this happens
    // on join/leave-driven stores or no-op saves) — but DO NOT bail
    // from the whole hook. Title-only / theme-only / comment-only
    // updates produce a store with zero text-line delta, and the
    // diff blocks below need to run to log them.
    if (added === 0 && removed === 0) return

    logActivity({
      docId: data.documentName,
      userId,
      userName,
      actorPrincipal,
      actorAvatarSeed,
      action: 'edit',
      wordCount,
      linesAdded: added,
      linesRemoved: removed,
      yjsDocIdBefore,
      yjsDocIdAfter
    })
  } catch (e) {
    console.warn('[hocuspocus] activity log failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Title / theme diff — same debounce window as the edit row, but
 * emitted as separate activity events so the UI can render them
 * distinctly. We DON'T attribute these to a specific user via
 * ymeta.observe (which doesn't carry transaction origin in this hook),
 * so the activity row inherits whoever was tracked as the last editor —
 * accurate in practice because rename / theme tweaks come from the
 * same active session.
 */
async function logMetaDiffActivity(
  data: StoreDocumentData,
  tracked: Awaited<ReturnType<typeof getLastEditor>>['value'],
  yjsDocIdBefore: number | null,
  yjsDocIdAfter: number | null
): Promise<void> {
  try {
    const userName: string | null = tracked?.userName ?? null
    const userId = parseTrackedUserId(tracked?.userId)
    const actorPrincipal = parseActorPrincipal(tracked?.userId)
    const actorAvatarSeed = anonActivitySeed(tracked)
    const prevMetaFetch = await getPrevMeta(data.documentName)
    const prevMeta = prevMetaFetch.value
    const currMeta = readMetaSnapshot(data.document)
    await setPrevMeta(data.documentName, currMeta)
    if (!prevMeta) return

    if ((prevMeta.title ?? '') !== (currMeta.title ?? '')) {
      logActivity({
        docId: data.documentName,
        userId,
        userName,
        actorPrincipal,
        actorAvatarSeed,
        action: 'title.changed',
        metadata: {
          kind: 'title.changed',
          from: prevMeta.title ?? '',
          to: currMeta.title ?? ''
        },
        yjsDocIdBefore,
        yjsDocIdAfter
      })
    }
    if (prevMeta.themeHash !== currMeta.themeHash) {
      logActivity({
        docId: data.documentName,
        userId,
        userName,
        actorPrincipal,
        actorAvatarSeed,
        action: 'theme.changed',
        metadata: { kind: 'theme.changed' },
        yjsDocIdBefore,
        yjsDocIdAfter
      })
    }
  } catch (e) {
    console.warn('[hocuspocus] meta diff failed:', e instanceof Error ? e.message : e)
  }
}

// Graceful shutdown — drains WS connections, awaits pending Y.js stores via
// Hocuspocus's own destroy(), then closes the persistence pool. Without this
// a deploy SIGTERM would kill connections mid-debounce and lose the last
// 2-10 s of edits per active document.
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[hocuspocus] Received ${signal}, draining…`)
  // Hard cap so a stuck connection can't block the process forever; SIGKILL
  // arrives after `stop_grace_period` (compose) anyway, but explicit is nicer.
  const killTimer = setTimeout(() => {
    console.error('[hocuspocus] Drain timed out after 25s, forcing exit.')
    process.exit(1)
  }, 25_000)
  try {
    await stopCompactionSweeper()
    await server.destroy()
    await ypgPersistence.destroy()
    await closeValkey()
    console.log('[hocuspocus] Shutdown complete.')
    clearTimeout(killTimer)
    process.exit(0)
  } catch (e) {
    console.error('[hocuspocus] Shutdown error:', e)
    clearTimeout(killTimer)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
