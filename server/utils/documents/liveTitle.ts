import * as Y from 'yjs'
import jwt from 'jsonwebtoken'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import type { SessionJwtPayload } from '~~/shared/contracts/jwt'
import { clampMetaString } from '~~/shared/utils/documents/ymetaValidation'
import { useEnv } from '~~/shared/env/load'
import { renameDoc } from '../../repos/documents'
import { appendYjsUpdate, latestYjsId, readYjsUpdatesAt } from '../../repos/yjsLog'
import type { DocAccess } from '../../repos/proofs'
import { useLogger } from '../platform/logger'

const log = useLogger('live-title')

// Renaming a document from outside its editor (the explorer). The editor's
// title is the Y.Doc's `ymeta.title`: writing only the documents row would be
// overwritten by the next store of an open editor (the sync server copies the
// live title to the row). So the new title goes into the Y.Doc through a
// short connection as the renaming user: every open editor shows it at once,
// and a document nobody has open gets it in its stored log. The row is
// written first, so lists show the new name even if the sync server is
// briefly unreachable.

const SYNC_TIMEOUT_MS = 10_000
const ACK_TIMEOUT_MS = 10_000

function waitForAck(provider: HocuspocusProvider): Promise<void> {
  if (!provider.hasUnsyncedChanges) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (provider.hasUnsyncedChanges) return
      clearTimeout(timer)
      provider.off('unsyncedChanges', onChange)
      resolve()
    }
    const timer = setTimeout(() => {
      provider.off('unsyncedChanges', onChange)
      reject(new Error('title update not acknowledged'))
    }, ACK_TIMEOUT_MS)
    provider.on('unsyncedChanges', onChange)
  })
}

/** Set `ymeta.title` of the live document as `actor`. Resolves once the sync server acknowledged it. */
async function writeLiveTitle(docId: string, title: string, actor: { userId: number, userName: string }): Promise<void> {
  const env = useEnv()
  if (!env.auth.jwtSecret || !env.sync.internalUrl) throw new Error('sync not configured')
  const payload = {
    docId,
    userId: String(actor.userId),
    userName: actor.userName,
    readOnly: false
  } satisfies SessionJwtPayload
  const token = jwt.sign(payload, env.auth.jwtSecret, { expiresIn: '2m' })
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)
  let provider: HocuspocusProvider | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sync timeout')), SYNC_TIMEOUT_MS)
      provider = new HocuspocusProvider({
        url: env.sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://'),
        name: docId,
        document: ydoc,
        awareness,
        token,
        onSynced: () => {
          clearTimeout(timer)
          resolve()
        },
        onAuthenticationFailed: () => {
          clearTimeout(timer)
          reject(new Error('auth failed'))
        }
      })
    })
    ydoc.transact(() => {
      ydoc.getMap('meta').set('title', clampMetaString('title', title))
    }, `rename:${actor.userId}`)
    if (provider) await waitForAck(provider)
  } finally {
    try {
      awareness.setLocalState(null)
    } catch { /* best-effort cleanup */ }
    const p = provider as HocuspocusProvider | null
    try {
      p?.disconnect()
      p?.destroy()
    } catch { /* best-effort cleanup */ }
    ydoc.destroy()
  }
}

/**
 * Without a sync server connection: append the title change to the stored
 * log as an update that follows the stored state (so it wins over the title
 * stored before). An editor that has the document open misses it until it
 * reloads; this is the fallback, not the normal path.
 */
async function appendStoredTitle(doc: DocAccess<'edit'>, title: string): Promise<void> {
  const ydoc = new Y.Doc()
  try {
    const at = await latestYjsId(doc)
    if (at !== null) {
      for (const update of await readYjsUpdatesAt(doc, at)) {
        try {
          Y.applyUpdate(ydoc, update)
        } catch { /* unreadable rows are skipped, as on load */ }
      }
    }
    const before = Y.encodeStateVector(ydoc)
    ydoc.getMap('meta').set('title', clampMetaString('title', title))
    await appendYjsUpdate(doc, Y.encodeStateAsUpdate(ydoc, before))
  } finally {
    ydoc.destroy()
  }
}

/**
 * Rename a document: the row, then the live title (or, when the sync server
 * can't be reached, the stored log). A failure of the second part is logged,
 * not thrown: the row is renamed either way.
 */
export async function renameDocument(doc: DocAccess<'edit'>, title: string, actor: { userId: number, userName: string }): Promise<{ live: boolean }> {
  await renameDoc(doc, title)
  try {
    await writeLiveTitle(doc.docId, title, actor)
    return { live: true }
  } catch (e) {
    log.warn('live title update failed, writing the stored log', { docId: doc.docId, err: e })
    try {
      await appendStoredTitle(doc, title)
    } catch (e2) {
      log.warn('stored title update failed', { docId: doc.docId, err: e2 })
    }
    return { live: false }
  }
}
