import { customDomainContext, customDomainView } from '../../../../utils/customDomains/manage'
import { invalidateCustomDomainCache } from '../../../../utils/customDomains/routing'
import { getCustomDomainForUser, listCustomDomainsForUser, setCustomDomainPage } from '../../../../repos/customDomains'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'
import { getDocAuthz } from '../../../../utils/workspaces/workspaceAccess'
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
  handler: async ({ event, user, params, body }) => {
    const userId = user.id
    const { settings } = await customDomainContext(userId)
    const domain = await getCustomDomainForUser(params.domainId, userId)
    if (!domain) throw apiError('custom-domain/not-found')
    let pageId: string | null = null
    if (body.docId !== null) {
      const authz = await getDocAuthz(userId, body.docId)
      if (!authz.exists || !authz.canManage) throw apiError('custom-domain/page-not-allowed')
      const page = await getPublishedPageSummary(body.docId)
      if (!page) throw apiError('custom-domain/page-not-published')
      pageId = page.id
    }
    await setCustomDomainPage(domain.id, userId, pageId)
    invalidateCustomDomainCache()
    const row = (await listCustomDomainsForUser(userId)).find(d => d.id === domain.id)
    if (!row) throw apiError('custom-domain/not-found')
    return customDomainView(event, row, settings)
  }
})
