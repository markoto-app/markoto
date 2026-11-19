import * as Y from 'yjs'
import { latestYjsId, readYjsUpdatesAt } from '../../repos/yjsLog'
import { upsertDocumentSearch } from '../../repos/documentSearch'
import type { DocAccess } from '../../repos/proofs'
import { useLogger } from '../platform/logger'

const log = useLogger('search-index')

// The app's side of the document search index. The sync server indexes every
// document it stores (`sync-server/src/search-index.ts`); these helpers cover
// the content the app writes to `yjs_updates` itself (a seeded new document,
// a duplicate or template copy, an import) and the backfill of documents
// that have no index row yet.

function wordsIn(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

/**
 * Index text the caller just wrote as the document's whole content (a new
 * document: nothing else can have written it yet).
 */
export async function indexNewDocument(doc: DocAccess<'write'>, input: { title: string, body: string, yjsId: number | null }): Promise<void> {
  try {
    await upsertDocumentSearch(doc, {
      title: input.title,
      body: input.body,
      yjsId: input.yjsId,
      wordCount: wordsIn(input.body),
      sizeBytes: Buffer.byteLength(input.body, 'utf8')
    })
  } catch (e) {
    log.warn('index write failed', { docId: doc.docId, err: e })
  }
}

/**
 * Rebuild a document's index row from its stored Y.js state. The newest row
 * id is read BEFORE the state, so the row is stamped with an id no newer
 * than the text: if the sync server indexed a later store meanwhile, the
 * upsert leaves its text in place. Best effort.
 */
export async function reindexDocument(doc: DocAccess<'write'>): Promise<void> {
  try {
    const yjsId = await latestYjsId(doc)
    let body = ''
    let title = ''
    if (yjsId !== null) {
      const ydoc = new Y.Doc()
      try {
        for (const update of await readYjsUpdatesAt(doc, yjsId)) {
          try {
            Y.applyUpdate(ydoc, update)
          } catch {
            // An unreadable row is skipped, as the sync server does.
          }
        }
        body = ydoc.getText('content').toJSON()
        const t = ydoc.getMap('meta').get('title')
        title = typeof t === 'string' ? t : ''
      } finally {
        ydoc.destroy()
      }
    }
    await upsertDocumentSearch(doc, { title, body, yjsId, wordCount: wordsIn(body), sizeBytes: Buffer.byteLength(body, 'utf8') }, { touch: false })
  } catch (e) {
    log.warn('reindex failed', { docId: doc.docId, err: e })
  }
}
