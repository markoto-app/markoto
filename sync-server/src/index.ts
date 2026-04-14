import { Server } from '@hocuspocus/server'
import { ypgPersistence } from './persistence'
import { auth } from './auth'
import { rateLimiter } from './rate-limiter'
import { logActivity, mostRecentEditorFromAwareness, countWords, lineDiff } from './activity-logger'
import { handleInternalRequest } from './internal-http'

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
    return doc
  },

  async onChange(data) {
    // Record the authenticated user who just made a change. `context` carries
    // what we returned from onAuthenticate (readOnly, userId, userName).
    const ctx = (data as any).context as { userId?: string; userName?: string | null } | undefined
    if (ctx?.userId) {
      lastEditorByDoc.set(data.documentName, {
        userName: ctx.userName ?? null,
        userId: ctx.userId,
        at: Date.now()
      })
    }
  },

  async onStoreDocument(data) {
    await ypgPersistence.onStoreDocument(data)

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
        console.warn(`[hocuspocus] Attribution fallback for doc ${data.documentName}: no onChange tracked, using awareness heuristic`)
      }
      if (!userName) {
        const awareness = (data.document as any).awareness
        userName = mostRecentEditorFromAwareness(awareness)
      }

      // Line-level diff against the previous snapshot — what changed during
      // this debounce window.
      const prev = previousTextByDoc.get(data.documentName) ?? ''
      const { added, removed } = lineDiff(prev, currentText)
      previousTextByDoc.set(data.documentName, currentText)

      // Skip the entry entirely if nothing actually changed line-wise (this
      // happens on join/leave-driven stores or no-op saves).
      if (added === 0 && removed === 0) return

      logActivity({
        docId: data.documentName,
        userName,
        action: 'edit',
        wordCount,
        linesAdded: added,
        linesRemoved: removed
      })
    } catch (e: any) {
      console.warn('[hocuspocus] activity log failed:', e.message)
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

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
