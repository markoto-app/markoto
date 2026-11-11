import { customDomainView, requireCustomDomainUser } from '../../../../utils/customDomains/manage'
import { invalidateCustomDomainCache } from '../../../../utils/customDomains/routing'
import { getCustomDomainForUser, listCustomDomainsForUser, setCustomDomainPage } from '../../../../repos/customDomains'
import { getPublishedPageSummary } from '../../../../repos/publishedPages'
import { getDocAuthz } from '../../../../utils/workspaces/workspaceAccess'
import { CUSTOM_DOMAIN_ERROR_CODES } from '~~/shared/config/customDomains'

// PATCH /api/user/custom-domains/:domainId — {docId | null}: which
// published page the domain shows (WP13). The caller must be able to
// manage that document (owner / workspace admin) — a domain can't be
// pointed at somebody else's page.
export default defineEventHandler(async (event) => {
  const { userId, settings } = await requireCustomDomainUser(event)
  const domain = await getCustomDomainForUser(getRouterParam(event, 'domainId') ?? '', userId)
  if (!domain) throw createError({ statusCode: 404, message: 'Domain not found' })
  const body = await readBody<{ docId?: unknown }>(event).catch(() => ({})) as { docId?: unknown }
  let pageId: string | null = null
  if (body.docId !== null) {
    if (typeof body.docId !== 'string' || body.docId.length > 64) {
      throw createError({ statusCode: 400, message: 'docId must be a document id or null.', data: { code: CUSTOM_DOMAIN_ERROR_CODES.invalid, field: 'docId' } })
    }
    const authz = await getDocAuthz(userId, body.docId)
    if (!authz.exists || !authz.canManage) throw createError({ statusCode: 403, message: 'Only the owner and workspace admins can show this document on a domain.', data: { code: 'publish/not-allowed' } })
    const page = await getPublishedPageSummary(body.docId)
    if (!page) throw createError({ statusCode: 409, message: 'Publish the document as a web page first.', data: { code: CUSTOM_DOMAIN_ERROR_CODES.pageNotPublished } })
    pageId = page.id
  }
  await setCustomDomainPage(domain.id, userId, pageId)
  invalidateCustomDomainCache()
  const row = (await listCustomDomainsForUser(userId)).find(d => d.id === domain.id)!
  return customDomainView(event, row, settings)
})
