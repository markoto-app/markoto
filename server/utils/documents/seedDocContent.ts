import * as Y from 'yjs'
import { appendYjsUpdate } from '../../repos/yjsLog'
import type { DocAccess } from '../../repos/proofs'
import { isValidMetaValue } from '~~/shared/utils/documents/ymetaValidation'

// Server-side seeding of a brand-new document's Markdown body
// (`POST /api/docs` with `content`, used by the marketing `::try-it`
// block, and the bulk import). Writes ONE `yjs_updates` row, the same shape
// `cloneYjsStateWithUrlRewrite` writes for a duplicate, so:
//   - the sync server loads it like any stored history on first open, and
//   - the server PDF render (`render-bootstrap` replays the Y.js log)
//     sees the text right away, without a browser ever connecting.
// Only called for a docId minted a moment ago (its documents row exists),
// so there is no existing history to merge with.
//
// `meta`: document properties to put into ymeta (the `meta` map) as well (an import that
// sets them on the row too, so the row and the live document agree, as a
// duplicate's do). Each value must pass the sync server's ymeta rules;
// one that does not is left out (the row value then applies).
export async function seedDocContent(doc: DocAccess<'write'>, content: string, meta?: Record<string, unknown>): Promise<number | null> {
  const entries = Object.entries(meta ?? {}).filter(([key, value]) => value !== undefined && isValidMetaValue(key, value))
  if (content.length === 0 && entries.length === 0) return null
  const ydoc = new Y.Doc()
  ydoc.transact(() => {
    if (content.length > 0) ydoc.getText('content').insert(0, content)
    const ymeta = ydoc.getMap('meta')
    for (const [key, value] of entries) ymeta.set(key, value)
  })
  const update = Y.encodeStateAsUpdate(ydoc)
  ydoc.destroy()
  return appendYjsUpdate(doc, update)
}
