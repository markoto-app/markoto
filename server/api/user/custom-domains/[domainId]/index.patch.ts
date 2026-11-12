import { customDomainContext, customDomainView } from '../../../../utils/customDomains/manage'
import { invalidateCustomDomainCache } from '../../../../utils/customDomains/routing'
import { getCustomDomainForUser, listCustomDomainsForUser, setCustomDomainPage } from '../../../../repos/customDomains'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'
import { customDomainParams, setCustomDomainPageBody } from '~~/shared/api/account'

// PATCH /api/user/custom-domains/:domainId — {docId | null}: which
// published page the domain shows. The caller must be able to
// manage that document (owner / workspace admin) — a domain can't be
// pointed at somebody else's page.
export default defineApiHandler({
  access: allow.user(),
  instance: 'customDomains',
  params: customDomainParams,
  body: setCustomDomainPageBody,
  invalidCode: 'custom-domain/invalid',
  handler: async ({ event, user, self, prove, params, body }) => {
    const userId = user.id
    const { settings } = await customDomainContext(userId)
    const domain = await getCustomDomainForUser(self, params.domainId)
    if (!domain) throw apiError('custom-domain/not-found')
    let pageId: string | null = null
    if (body.docId !== null) {
      const managed = await prove.doc(body.docId, 'manage')
      if (!managed) throw apiError('custom-domain/page-not-allowed')
      const page = await getPublishedPageSummary(managed)
      if (!page) throw apiError('custom-domain/page-not-published')
      pageId = page.id
    }
    await setCustomDomainPage(self, domain.id, pageId)
    invalidateCustomDomainCache()
    const row = (await listCustomDomainsForUser(self)).find(d => d.id === domain.id)
    if (!row) throw apiError('custom-domain/not-found')
    return customDomainView(event, row, settings)
  }
})
