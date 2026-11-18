import { bulkMove } from '../../utils/explorer/bulkActions'
import { bulkMoveBody } from '~~/shared/api/explorer'

// Move several folders (with their subtrees) and documents of one scope into
// a folder or the scope's root: drag of a mixed selection, cut and paste,
// undo. Each item is decided on its own (partial success, one result each).
export default defineApiHandler({
  access: allow.user(),
  body: bulkMoveBody,
  rateLimit: { namespace: 'bulk', max: 30, windowMs: 60_000, key: 'user' },
  handler: async ({ event, user, body }) => {
    const results = await bulkMove({ userId: user.id, ip: getClientIp(event) }, body)
    return { results, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }
  }
})
