import * as Y from 'yjs'
import { useDatabasePool } from '../platform/database'
import { withThemeDocId } from '~~/shared/utils/theme/customCss'
import { withThemeImagesDocId } from '~~/shared/utils/theme/themeImages'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// Clones Y.js state from one docId to another, rewriting image URLs so the
// target's markdown references its own `/api/files/{targetDocId}/...` paths.
//
// A raw `INSERT ... SELECT` of the yjs_documents rows is not enough: the
// update blobs hold image URLs as literal strings, and /api/files gates
// access by the URL's docId, so members of the duplicate (but not the
// source) would get 403s, and deleting the source would break the
// duplicate's images.
//
// Steps: replay every stored update into a Y.Doc (as y-postgresql does on
// load), rewrite the image URL prefix in ytext, build a FRESH Y.Doc with
// the rewritten text and the ymeta entries except `_deleted`, then store
// its full state as a single row under the target docname. y-postgresql
// treats that row as the whole history.
//
// Caveat: if the source is being edited right now, the last seconds of
// writes may only live in the sync-server's in-memory Y.Doc (Hocuspocus
// debounces onStoreDocument) and are missing from the clone. A flush
// endpoint on the sync-server would close that gap.
export async function cloneYjsStateWithUrlRewrite(
  sourceDocId: string,
  targetDocId: string,
  /** `title`: the copy's live title (ymeta) — used when a document is made from a template. */
  overrides?: { title?: string }
): Promise<void> {
  const pool = useDatabasePool()

  // Pull every v1 (update) row for the source. Ordered by id so the
  // replay is deterministic. v1_sv (state vector) rows are derived data
  // — y-postgresql will recompute them on the target after first write.
  const res = await pool.query<{ value: Buffer }>(
    `SELECT value FROM yjs_documents WHERE docname = $1 AND version = 'v1' ORDER BY id ASC`,
    [sourceDocId]
  )

  // No rows → source hasn't been opened / persisted yet. Nothing to
  // clone; the duplicate will start empty on first open, which is the
  // correct behavior (the documents row already has title + theme).
  if (res.rowCount === 0) return

  const sourceDoc = new Y.Doc()
  for (const row of res.rows) {
    Y.applyUpdate(sourceDoc, new Uint8Array(row.value.buffer, row.value.byteOffset, row.value.byteLength))
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

  const update = Buffer.from(Y.encodeStateAsUpdate(targetDoc))
  await pool.query(
    `INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`,
    [targetDocId, update]
  )
}
