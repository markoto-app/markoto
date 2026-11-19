import { lookupDoiBody } from '~~/shared/api/citations'
import { MINUTE_MS } from '~~/shared/config/units'
import { DoiLookupError, lookupDoi } from '../../utils/citations/crossref'

/**
 * Bibliography entry for a DOI (References panel → "Add by DOI"). The
 * lookup goes to Crossref (server/utils/citations/crossref.ts); the
 * editor adds the entry to the document's bibliography over Y.js.
 * Signed-in users only: every call is an outbound request.
 */

export default defineApiHandler({
  access: allow.user(),
  body: lookupDoiBody,
  invalidCode: 'citations/doi-invalid',
  rateLimit: { namespace: 'citations-doi', max: 30, windowMs: 10 * MINUTE_MS, key: 'user', error: 'citations/rate-limited' },
  handler: async ({ body }) => {
    try {
      return { item: await lookupDoi(body.doi) }
    } catch (e) {
      if (!(e instanceof DoiLookupError)) throw e
      if (e.reason === 'invalid') throw apiError('citations/doi-invalid')
      if (e.reason === 'not-found') throw apiError('citations/doi-not-found')
      throw apiError('citations/doi-lookup-failed')
    }
  }
})
