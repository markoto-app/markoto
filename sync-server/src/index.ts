// Validate secrets first so a misconfigured deploy fails with a clear
// message before any other module grabs its own process.env references.
import './validate-secrets'
// Sentry must be imported early so its Bun instrumentation patches stdlib
// targets before any other module grabs references to them. Importing a
// name from the module also satisfies the side-effect import.
import { captureMessage } from './sentry'
import { Server } from '@hocuspocus/server'
import { ypgPersistence } from './persistence'
import { authFromEnv } from './auth'
import { rateLimiter } from './rate-limiter'
import { logActivity, mostRecentEditorFromAwareness, countWords, lineDiff } from './activity-logger'
import { handleInternalRequest } from './internal-http'
import { shipCommentsSnapshot, dropSnapshotCache } from './comments-snapshot'
import {
  getLastEditor,
  setLastEditor,
  getPrevText,
  setPrevText,
  getPrevMeta,
  setPrevMeta,
  dropDocState,
  type PreviousMeta
} from './sync-state'
import { closeValkey } from './valkey'

// Auth singleton — wired from env here (not inside auth.ts) so unit tests
// can import `createAuth` without tripping a top-level env guard.
const auth = authFromEnv()

const port = Number.parseInt(process.env.PORT || '4001')

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

function readMetaSnapshot(doc: { getMap: (k: string) => { get: (k: string) => unknown } }): PreviousMeta {
  const ymeta = doc.getMap('meta')
  const t = ymeta.get('title')
  const theme = ymeta.get('theme')
  return {
    title: typeof t === 'string' ? t : null,
    themeJson: theme && typeof theme === 'object' ? JSON.stringify(theme) : null
  }
}

const server = new Server({
  port,
  debounce: 2000,
  maxDebounce: 10000,

  async onLoadDocument(data) {
    const doc = await ypgPersistence.onLoadDocument(data)
    // Seed the previous-text cache so the FIRST diff after load is measured
    // against what was on disk, not against an empty string (which would
    // otherwise report a huge "+N lines" on the next store).
    const ytext = doc.getText('content')
    await setPrevText(data.documentName, ytext.toString())
    // Same for title + theme: seed against current state so the first
    // store after load doesn't emit a spurious "title changed" with a
    // null `from` value.
    await setPrevMeta(data.documentName, readMetaSnapshot(doc))
    return doc
  },

  async onChange(data) {
    // Record the authenticated user who just made a change. `context` carries
    // what we returned from onAuthenticate (readOnly, userId, userName).
    const ctx = (data as { context?: { userId?: string, userName?: string | null } }).context
    if (ctx?.userId) {
      await setLastEditor(data.documentName, {
        userName: ctx.userName ?? null,
        userId: ctx.userId,
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
    // AFTER: use the row id returned BY the store itself rather than a
    // follow-up MAX query. The follow-up query was the source of the
    // earlier NULL-boundary bug — between INSERT and the second
    // MAX(id) call, the queryPool's connection occasionally returned
    // null (suspected MVCC/snapshot timing across separate pg pools,
    // exact cause not pinned). Using the returned id is structurally
    // correct anyway: it's the id WE wrote, not whatever the latest
    // row happens to be by the time we re-query (which under
    // multi-instance concurrency could be a row a different instance
    // wrote).
    const yjsDocIdAfter = await ypgPersistence.onStoreDocument(data)

    // Read the tracked editor ONCE for the whole hook so the edit-row and
    // meta-diff blocks below see consistent attribution. Valkey miss vs
    // error are tagged separately for ops visibility (miss is normal —
    // cold doc / restart; error is operationally interesting — Valkey down).
    const trackedFetch = await getLastEditor(data.documentName)
    const tracked = trackedFetch.value

    // Log an 'edit' activity entry per store event (debounced 2-10s by Hocuspocus).
    // Fire-and-forget so sync is never blocked by activity logging.
    try {
      const ytext = data.document.getText('content')
      const currentText = ytext.toString()
      const wordCount = countWords(currentText)

      // Attribution: prefer the onChange-tracked authenticated user. Fall back
      // to the awareness heuristic only if nothing has been tracked yet
      // (e.g. an anonymous client whose JWT had no userName, or — rarely —
      // a store firing before any onChange after a sync-server restart, or
      // Valkey-down).
      let userName: string | null = tracked?.userName ?? null
      if (!tracked) {
        const cause = trackedFetch.cause === 'error' ? 'valkey-error' : 'valkey-miss'
        // Log so we can see in prod logs whether the fallback path is hit
        // often. If it is, the bootstrap-on-demand design needs revisiting.
        // Also surfaced to Sentry — drift canary for prod attribution. The
        // `cause` tag distinguishes "cold doc / restart" (normal) from
        // "Valkey down" (operationally interesting).
        const errMsg = trackedFetch.error ? ` (${trackedFetch.error.message})` : ''
        console.warn(`[hocuspocus] Attribution fallback for doc ${data.documentName}: cause=${cause}${errMsg}, using awareness heuristic`)
        captureMessage(`[hocuspocus] Attribution fallback for doc ${data.documentName}`, {
          level: 'warning',
          tags: { component: 'hocuspocus', event: 'attribution_fallback', cause }
        })
      }
      if (!userName) {
        const awareness = (data.document as unknown as { awareness?: Parameters<typeof mostRecentEditorFromAwareness>[0] }).awareness
        userName = mostRecentEditorFromAwareness(awareness)
      }

      // Line-level diff against the previous snapshot — what changed during
      // this debounce window. On a Valkey miss (cold doc / restart) or
      // Valkey error, we skip emitting an edit row but DO write the new
      // baseline so the next store has something to diff against — better
      // than emitting a spurious "+N lines whole doc" row.
      const prevFetch = await getPrevText(data.documentName)
      await setPrevText(data.documentName, currentText)

      // Resolve userId for avatar JOIN on the read endpoint.
      // The tracked.userId is the JWT's userId — string. Real users get a
      // numeric id (parsed below); AI sessions use the synthetic
      // `ai:assistant:{sessionId}` form which is non-numeric and resolves
      // to null, exactly what we want (no users.id row).
      const userIdFromTracked = tracked?.userId
        ? (Number.isFinite(Number(tracked.userId)) ? Number(tracked.userId) : null)
        : null

      if (prevFetch.value != null) {
        const { added, removed } = lineDiff(prevFetch.value, currentText)
        // Skip the edit entry if nothing changed line-wise (this happens
        // on join/leave-driven stores or no-op saves) — but DO NOT bail
        // from the whole hook. Title-only / theme-only / comment-only
        // updates produce a store with zero text-line delta, and the
        // diff blocks below need to run to log them.
        if (added > 0 || removed > 0) {
          logActivity({
            docId: data.documentName,
            userId: userIdFromTracked,
            userName,
            action: 'edit',
            wordCount,
            linesAdded: added,
            linesRemoved: removed,
            yjsDocIdBefore,
            yjsDocIdAfter
          })
        }
      }
    } catch (e) {
      console.warn('[hocuspocus] activity log failed:', e instanceof Error ? e.message : e)
    }

    // Title / theme diff — same debounce window as the edit row, but
    // emitted as separate activity events so the UI can render them
    // distinctly. We DON'T attribute these to a specific user yet
    // (ymeta.observe doesn't carry transaction origin in this hook), so
    // the activity row inherits whoever was tracked as the last editor —
    // accurate in practice because rename / theme tweaks come from the
    // same active session.
    try {
      const userName: string | null = tracked?.userName ?? null
      const userId = tracked?.userId
        ? (Number.isFinite(Number(tracked.userId)) ? Number(tracked.userId) : null)
        : null
      const prevMetaFetch = await getPrevMeta(data.documentName)
      const prevMeta = prevMetaFetch.value
      const currMeta = readMetaSnapshot(data.document)
      await setPrevMeta(data.documentName, currMeta)
      if (prevMeta) {
        if ((prevMeta.title ?? '') !== (currMeta.title ?? '')) {
          logActivity({
            docId: data.documentName,
            userId,
            userName,
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
        if (prevMeta.themeJson !== currMeta.themeJson) {
          logActivity({
            docId: data.documentName,
            userId,
            userName,
            action: 'theme.changed',
            metadata: { kind: 'theme.changed' },
            yjsDocIdBefore,
            yjsDocIdAfter
          })
        }
      }
    } catch (e) {
      console.warn('[hocuspocus] meta diff failed:', e instanceof Error ? e.message : e)
    }

    // Postgres mirror of the comments Y.Array — separate try/catch so a
    // mirror failure can't take down activity logging or sync. Internal
    // dedup ensures the round-trip is skipped when the comments array
    // didn't change since the last store.
    try {
      shipCommentsSnapshot(data.documentName, data.document, { yjsDocIdBefore, yjsDocIdAfter })
    } catch (e) {
      console.warn('[hocuspocus] comments-snapshot ship failed:', e instanceof Error ? e.message : e)
    }
  },

  async onAuthenticate(data) {
    return auth.onAuthenticate(data)
  },

  async onConnect(data) {
    rateLimiter.onConnect(data)
  },

  async onDisconnect(data) {
    rateLimiter.onDisconnect(data)
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
})

server.listen(port, () => {
  console.log(`[hocuspocus] Sync server listening on port ${port}`)
})

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
