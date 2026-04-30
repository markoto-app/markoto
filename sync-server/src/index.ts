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

// Auth singleton — wired from env here (not inside auth.ts) so unit tests
// can import `createAuth` without tripping a top-level env guard.
const auth = authFromEnv()

const port = parseInt(process.env.PORT || '4001')

// Attribution state: per-doc, who made the last change and when. Populated in
// onChange (authoritative — comes from the authenticated connection context) and
// read in onStoreDocument. Bypasses the old awareness.meta.lastUpdated heuristic,
// which mis-attributed AI edits to whichever human most recently moved their cursor.
//
// Both maps below are intentionally process-local with bootstrap-on-demand:
//   - `lastEditorByDoc` is populated by onChange BEFORE the debounced store fires,
//     so a sync-server restart only loses attribution for the first store after
//     restart IF a stored update arrives before any onChange (vanishingly rare,
//     since stores fire on debounce of edits — no edits, no store). The fallback
//     to the awareness heuristic logs a warning so we can spot drift in prod.
//   - `previousTextByDoc` is re-seeded from disk in onLoadDocument, so the diff
//     baseline is always correct after a restart.
// Persisting either map across restarts would cost more than the corner case
// is worth at our scale.
interface LastEditor {
  userName: string | null
  userId: string | null
  at: number
}
const lastEditorByDoc = new Map<string, LastEditor>()

// Previous-text snapshot per doc — used to compute line-level add/remove counts
// for the activity feed. Wiped when no one is connected (see onDisconnect cleanup).
const previousTextByDoc = new Map<string, string>()

// Previous title + theme JSON per doc — used to detect rename / theme
// changes since the last store and emit specific activity events for
// them (instead of letting them disappear into the generic 'edit' row).
// Theme is stored as a stringified JSON for cheap equality.
interface PreviousMeta { title: string | null, themeJson: string | null }
const previousMetaByDoc = new Map<string, PreviousMeta>()

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
    previousTextByDoc.set(data.documentName, ytext.toString())
    // Same for title + theme: seed against current state so the first
    // store after load doesn't emit a spurious "title changed" with a
    // null `from` value.
    previousMetaByDoc.set(data.documentName, readMetaSnapshot(doc))
    return doc
  },

  async onChange(data) {
    // Record the authenticated user who just made a change. `context` carries
    // what we returned from onAuthenticate (readOnly, userId, userName).
    const ctx = (data as { context?: { userId?: string, userName?: string | null } }).context
    if (ctx?.userId) {
      lastEditorByDoc.set(data.documentName, {
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
    const yjsDocIdBefore = await ypgPersistence.getMaxYjsDocId(data.documentName)
    await ypgPersistence.onStoreDocument(data)
    const yjsDocIdAfter = await ypgPersistence.getMaxYjsDocId(data.documentName)

    // Log an 'edit' activity entry per store event (debounced 2-10s by Hocuspocus).
    // Fire-and-forget so sync is never blocked by activity logging.
    try {
      const ytext = data.document.getText('content')
      const currentText = ytext.toString()
      const wordCount = countWords(currentText)

      // Attribution: prefer the onChange-tracked authenticated user. Fall back
      // to the awareness heuristic only if nothing has been tracked yet
      // (e.g. an anonymous client whose JWT had no userName, or — rarely —
      // a store firing before any onChange after a sync-server restart).
      const tracked = lastEditorByDoc.get(data.documentName)
      let userName: string | null = tracked?.userName ?? null
      if (!tracked) {
        // Log so we can see in prod logs whether the fallback path is hit
        // often. If it is, the bootstrap-on-demand design needs revisiting.
        // Also surfaced to Sentry — drift canary for prod attribution.
        console.warn(`[hocuspocus] Attribution fallback for doc ${data.documentName}: no onChange tracked, using awareness heuristic`)
        captureMessage(`[hocuspocus] Attribution fallback for doc ${data.documentName}`, {
          level: 'warning',
          tags: { component: 'hocuspocus', event: 'attribution_fallback' }
        })
      }
      if (!userName) {
        const awareness = (data.document as unknown as { awareness?: Parameters<typeof mostRecentEditorFromAwareness>[0] }).awareness
        userName = mostRecentEditorFromAwareness(awareness)
      }

      // Line-level diff against the previous snapshot — what changed during
      // this debounce window.
      const prev = previousTextByDoc.get(data.documentName) ?? ''
      const { added, removed } = lineDiff(prev, currentText)
      previousTextByDoc.set(data.documentName, currentText)

      // Skip the edit entry if nothing changed line-wise (this happens
      // on join/leave-driven stores or no-op saves) — but DO NOT bail
      // from the whole hook. Title-only / theme-only / comment-only
      // updates produce a store with zero text-line delta, and the
      // diff blocks below need to run to log them.
      // Resolve userId for avatar JOIN on the read endpoint.
      // `lastEditorByDoc.userId` is the JWT's userId — string. Real
      // users get a numeric id (parsed below); AI sessions use the
      // synthetic `ai:assistant:{sessionId}` form which is non-numeric
      // and resolves to null, exactly what we want (no users.id row).
      const userIdFromTracked = tracked?.userId
        ? (Number.isFinite(Number(tracked.userId)) ? Number(tracked.userId) : null)
        : null

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
      const tracked = lastEditorByDoc.get(data.documentName)
      const userName: string | null = tracked?.userName ?? null
      const userId = tracked?.userId
        ? (Number.isFinite(Number(tracked.userId)) ? Number(tracked.userId) : null)
        : null
      const prevMeta = previousMetaByDoc.get(data.documentName)
      const currMeta = readMetaSnapshot(data.document)
      previousMetaByDoc.set(data.documentName, currMeta)
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
    // Free attribution/diff memory when the last client leaves the room.
    // `clientsCount` in onDisconnect reflects the count AFTER this disconnect;
    // 0 means we just lost the last collaborator. onLoadDocument re-seeds the
    // caches if someone reconnects.
    if (data.clientsCount === 0 && data.documentName) {
      lastEditorByDoc.delete(data.documentName)
      previousTextByDoc.delete(data.documentName)
      previousMetaByDoc.delete(data.documentName)
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
