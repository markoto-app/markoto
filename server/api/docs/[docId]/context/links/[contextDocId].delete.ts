import { removeContextLink } from '../../../../../repos/projectContext'
import { deleteContextLinkParams } from '~~/shared/api/docs'

// DELETE /api/docs/:docId/context/links/:contextDocId: detach an extra
// context document. Edit rights on this document; the other document need
// not be readable any more (a link to something since unshared can still
// be removed).
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  params: deleteContextLinkParams,
  handler: async ({ docAccess, params }) => {
    if (!(await removeContextLink(docAccess, params.contextDocId))) throw apiError('context/not-attached')
    return { ok: true }
  }
})
