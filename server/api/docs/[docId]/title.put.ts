import { renameDocument } from '../../../utils/documents/liveTitle'
import { renameDocBody } from '~~/shared/api/explorer'

// Rename a document from outside its editor (explorer F2, context menu).
// Anyone who may edit the title in the editor may (owner, workspace admin or
// editor). Also sets the live title of open editors (utils/documents/liveTitle.ts).
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  body: renameDocBody,
  rateLimit: { namespace: 'doc-rename', max: 60, windowMs: 60_000, key: 'user' },
  handler: async ({ user, docAccess, body }) => {
    const { live } = await renameDocument(docAccess, body.title, { userId: user.id, userName: user.name })
    return { success: true, title: body.title, live }
  }
})
