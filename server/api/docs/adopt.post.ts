import { adoptBrowserDocuments } from '../../utils/documents/adoptAnonymous'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/docs/adopt: after a sign-in (the callback marks the page with
// `signed_in=1`), the anonymous documents this browser created become the
// signed-in account's. The browser proves it created them with the
// creator-key cookie, which is scoped to `/api/docs` and never leaves it.
// Answers how many changed hands (0 when none, or no cookie).
export default defineApiHandler({
  access: allow.user(),
  body: 'none',
  rateLimit: { namespace: 'docs-adopt', max: 20, windowMs: 10 * MINUTE_MS, key: 'user', error: 'docs/rate-limited' },
  handler: async ({ event, self }) => adoptBrowserDocuments(event, self)
})
