import * as Y from 'yjs'
import { useDatabasePool } from '../platform/database'

// Server-side seeding of a brand-new document's Markdown body
// (`POST /api/docs` with `content`, used by the marketing `::try-it`
// block). Writes ONE `yjs_documents` update row — the same shape
// `cloneYjsStateWithUrlRewrite` writes for a duplicate — so:
//   - the sync server loads it like any stored history on first open, and
//   - the server PDF render (`render-bootstrap` replays `yjs_documents`)
//     sees the text right away, without a browser ever connecting.
// Only called for a docId minted a moment ago, so there is no existing
// history to merge with.
export async function seedDocContent(docId: string, content: string): Promise<void> {
  if (content.length === 0) return
  const doc = new Y.Doc()
  doc.getText('content').insert(0, content)
  const update = Buffer.from(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  await useDatabasePool().query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [docId, update]
  )
}
