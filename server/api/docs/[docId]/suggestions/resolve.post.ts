import { isError } from 'h3'
import { findUserName } from '../../../../repos/users'
import { resolveSuggestions } from '../../../../utils/suggestions/resolveSuggestions'
import { suggestionAccessOf } from '../../../../utils/suggestions/suggestionAccess'
import { MINUTE_MS } from '~~/shared/config/units'
import { resolveSuggestionsBody } from '~~/shared/api/docs'
import { useLogger } from '../../../../utils/platform/logger'

const log = useLogger('suggestions')

// POST /api/docs/:docId/suggestions/resolve: {action: 'accept' | 'reject',
// ids?, authorKey?}. Accept or reject the listed suggestions, one author's
// ("accept all from Bea") or all of them.
//
// Who: everyone who edits the document directly (owner, workspace admins
// and editors, open-edit visitors who are signed in), not those limited to
// suggesting. A suggester withdraws their own suggestion in the editor
// (a Y.js write the sync server allows for their own records).
//
// Accepted text is applied as an edit of each suggester (see
// resolveSuggestions.ts); the reviewer gets a `suggestion.accepted` /
// `suggestion.rejected` row whose restore undoes the decision.
export default defineApiHandler({
  access: allow.doc('write-content', { deny: 'suggestion/review-not-allowed' }),
  body: resolveSuggestionsBody,
  invalidCode: 'suggestion/invalid',
  rateLimit: { namespace: 'suggestions-resolve', max: 120, windowMs: MINUTE_MS, key: 'user', error: 'suggestion/rate-limited' },
  handler: async ({ self, user, doc, state, actor, docAccess, body }) => {
    if (suggestionAccessOf(doc, state, actor).suggestOnly) throw apiError('suggestion/review-not-allowed')
    const name = (await findUserName(self)) ?? user.name ?? 'User'
    try {
      const result = await resolveSuggestions({
        doc: docAccess,
        reviewer: { userId: user.id, name },
        action: body.action,
        select: { ids: body.ids, authorKey: body.authorKey }
      })
      if (body.ids && result.resolved === 0 && result.missing > 0) throw apiError('suggestion/not-found')
      return result
    } catch (e) {
      if (isError(e) && e.statusCode < 500) throw e
      log.error('resolving suggestions failed', { docId: docAccess.docId, action: body.action, err: e })
      throw apiError('internal', undefined, { cause: e })
    }
  }
})
