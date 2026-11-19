import { addContextLink } from '../../../../../repos/projectContext'
import { ConflictError } from '../../../../../repos/errors'
import { addContextLinkBody } from '~~/shared/api/docs'
import { MAX_CONTEXT_LINKS } from '~~/shared/config/projectContext'

// POST /api/docs/:docId/context/links: attach another document as extra
// project context of this one. Needs edit rights here and membership-level
// read access to the other document (owner or a workspace role); the link
// never grants access: every reader's prompt includes it only if they may
// open it themselves.
export default defineApiHandler({
  access: allow.doc('edit', { deny: 'docs/edit-forbidden' }),
  body: addContextLinkBody,
  rateLimit: { namespace: 'context-links', max: 60, windowMs: 60_000, key: 'user' },
  handler: async ({ user, docId, docAccess, body, prove }) => {
    if (body.contextDocId === docId) throw apiError('context/self')
    const target = await prove.doc(body.contextDocId, 'view')
    if (!target) throw apiError('context/not-found')
    try {
      await addContextLink(docAccess, target, user.id, MAX_CONTEXT_LINKS)
    } catch (e) {
      if (e instanceof ConflictError) throw apiError('context/too-many', { max: MAX_CONTEXT_LINKS })
      throw e
    }
    return { ok: true }
  }
})
