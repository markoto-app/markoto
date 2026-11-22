import { getContextScope } from '../../../../repos/projectContext'
import { listProjectContext, listReadableContextLinks } from '../../../../utils/documents/projectContext'
import { MAX_CONTEXT_LINKS } from '~~/shared/config/projectContext'

// GET /api/docs/:docId/context: the document panel's "AI context" section.
// Whether this document is itself marked as project context, the context
// documents that reach the caller's AI prompts in it (only those the caller
// may open), and the documents attached to it. Anyone who may open the
// document and is signed in (AI needs a sign-in); changing it needs edit.
export default defineApiHandler({
  access: allow.doc('file'),
  handler: async ({ user, doc, docAccess, authz }) => {
    const [scope, applied, attached] = await Promise.all([
      getContextScope(docAccess),
      listProjectContext(docAccess, user.id),
      listReadableContextLinks(docAccess, user.id)
    ])
    return {
      contextScope: scope,
      inWorkspace: doc.workspaceId !== null,
      canEdit: authz.canEdit,
      applied: applied.entries.map(e => ({ docId: e.docId, title: e.title, source: e.source })),
      omitted: applied.omitted,
      attached: attached.links,
      hiddenAttached: attached.hidden,
      maxAttached: MAX_CONTEXT_LINKS
    }
  }
})
