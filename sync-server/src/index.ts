import { Server } from '@hocuspocus/server'
import { s3Persistence } from './persistence'
import { auth } from './auth'
import { rateLimiter } from './rate-limiter'
import { logActivity, mostRecentEditorFromAwareness, countWords, lineDiff } from './activity-logger'
import { handleInternalRequest } from './internal-http'

const port = parseInt(process.env.PORT || '4001')

// Attribution state: per-doc, who made the last change and when. Populated in
// onChange (authoritative — comes from the authenticated connection context) and
// read in onStoreDocument. Bypasses the old awareness.meta.lastUpdated heuristic,
// which mis-attributed AI edits to whichever human most recently moved their cursor.
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
    const doc = await s3Persistence.onLoadDocument(data)
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
    await s3Persistence.onStoreDocument(data)

    // Log an 'edit' activity entry per store event (debounced 2-10s by Hocuspocus).
    // Fire-and-forget so sync is never blocked by activity logging.
    try {
      const ytext = data.document.getText('content')
      const currentText = ytext.toString()
      const wordCount = countWords(currentText)

      // Attribution: prefer the onChange-tracked authenticated user. Fall back
      // to the awareness heuristic only if nothing has been tracked yet
      // (e.g. an anonymous client whose JWT had no userName).
      const tracked = lastEditorByDoc.get(data.documentName)
      let userName: string | null = tracked?.userName ?? null
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
