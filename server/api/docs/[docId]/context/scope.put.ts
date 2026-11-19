import { setContextScope } from '../../../../repos/projectContext'
import { updateContextScopeBody } from '~~/shared/api/docs'

// PUT /api/docs/:docId/context/scope: mark the document as project context
// for its folder (and the folders below it) or for its whole workspace
// (personal documents: all of the owner's personal documents), or unmark it.
// Edit rights on the document are enough: the text is what the AI reads,
// and whoever may edit it already decides what that text says. Readers
// only ever receive it where they may open it themselves.
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  body: updateContextScopeBody,
  rateLimit: { namespace: 'context-scope', max: 60, windowMs: 60_000, key: 'user' },
  handler: async ({ docAccess, body }) => {
    await setContextScope(docAccess, body.scope)
    return { contextScope: body.scope }
  }
})
