import * as Y from 'yjs'
import { appendYjsUpdate, latestYjsId, readYjsUpdatesAt } from '../../repos/yjsLog'
import { withThemeDocId } from '~~/shared/utils/theme/customCss'
import { withThemeImagesDocId } from '~~/shared/utils/theme/themeImages'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import type { DocAccess } from '../../repos/proofs'

// Clones Y.js state from one docId to another, rewriting image URLs so the
// target's markdown references its own `/api/files/{targetDocId}/...` paths.
//
// A raw `INSERT ... SELECT` of the `yjs_updates` rows is not enough: the
// update blobs hold image URLs as literal strings, and /api/files gates
// access by the URL's docId, so members of the duplicate (but not the
// source) would get 403s, and deleting the source would break the
// duplicate's images.
//
// Steps: replay the source's current state into a Y.Doc (as the sync server
// does on load), rewrite the image URL prefix in ytext, build a FRESH Y.Doc
// with the rewritten text and the ymeta entries except `_deleted`, then store
// its full state as the target's first row (its documents row exists by now).
//
// Caveat: if the source is being edited right now, the last seconds of
// writes may only live in the sync-server's in-memory Y.Doc (Hocuspocus
// debounces onStoreDocument) and are missing from the clone. A flush
// endpoint on the sync-server would close that gap.
export async function cloneYjsStateWithUrlRewrite(
  source: DocAccess<'view'>,
  target: DocAccess<'write'>,
  /** `title`: the copy's live title (ymeta) — used when a document is made from a template. */
  overrides?: { title?: string }
): Promise<void> {
  const sourceDocId = source.docId
  const targetDocId = target.docId
  // No rows → source hasn't been opened / persisted yet. Nothing to
  // clone; the duplicate will start empty on first open, which is the
  // correct behavior (the documents row already has title + theme).
  const latest = await latestYjsId(source)
  if (latest === null) return

  const sourceDoc = new Y.Doc()
  for (const update of await readYjsUpdatesAt(source, latest)) {
    Y.applyUpdate(sourceDoc, update)
  }

  const sourceText = sourceDoc.getText('content').toJSON()
  const rewritten = sourceText.replaceAll(
    `/api/files/${sourceDocId}/`,
    `/api/files/${targetDocId}/`
  )

  const targetDoc = new Y.Doc()
  if (rewritten.length > 0) {
    targetDoc.getText('content').insert(0, rewritten)
  }

  // Mirror ymeta (title, theme, custom client fields) minus transient
  // control flags. Duplicates should never carry the source's
  // `_deleted` marker or other session-scoped flags.
  const sourceMeta = sourceDoc.getMap('meta')
  const targetMeta = targetDoc.getMap('meta')
  sourceMeta.forEach((value, key) => {
    if (key === '_deleted') return
    if (key === 'theme' && value && typeof value === 'object' && !Array.isArray(value)) {
      const cssMoved = withThemeDocId(value, sourceDocId, targetDocId)
      // Theme images move with the uploads too; only touched on a
      // well-formed theme (a malformed one is left for the renderers'
      // fallback rather than half-rewritten).
      targetMeta.set(key, isValidTheme(cssMoved) ? withThemeImagesDocId(cssMoved, sourceDocId, targetDocId) : cssMoved)
      return
    }
    targetMeta.set(key, value)
  })

  if (overrides?.title !== undefined && targetMeta.has('title')) targetMeta.set('title', overrides.title)

  await appendYjsUpdate(target, Y.encodeStateAsUpdate(targetDoc))
}
