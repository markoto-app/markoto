import * as Y from 'yjs'
import { appendYjsUpdate } from './yjsLog'

// Server-side seeding of a brand-new document's Markdown body
// (`POST /api/docs` with `content`, used by the marketing `::try-it`
// block). Writes ONE `yjs_updates` row — the same shape
// `cloneYjsStateWithUrlRewrite` writes for a duplicate — so:
//   - the sync server loads it like any stored history on first open, and
//   - the server PDF render (`render-bootstrap` replays the Y.js log)
//     sees the text right away, without a browser ever connecting.
// Only called for a docId minted a moment ago (its documents row exists),
// so there is no existing history to merge with.
export async function seedDocContent(docId: string, content: string): Promise<void> {
  if (content.length === 0) return
  const doc = new Y.Doc()
  doc.getText('content').insert(0, content)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  await appendYjsUpdate(docId, update)
}
