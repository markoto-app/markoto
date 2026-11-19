import { moveDocsToFolder } from '../../../utils/explorer/bulkActions'
import { moveDocFolderBody } from '~~/shared/api/explorer'

// File one document into a folder of its own scope (null = the root). Moving
// between folders is organisation, not access: edit rights are enough.
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  body: moveDocFolderBody,
  handler: async ({ event, user, docId, body }) => {
    const [result] = await moveDocsToFolder({ userId: user.id, ip: getClientIp(event) }, [docId], body.folderId)
    if (!result?.ok) throw apiError(result?.code === 'folder/not-found' ? 'folder/not-found' : 'docs/edit-forbidden')
    return { success: true, folderId: body.folderId }
  }
})
