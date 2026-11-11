import type { H3Event } from 'h3'
import { getDocAuthz } from '../workspaces/workspaceAccess'
import { getDoc } from '../../repos/documents'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { PUBLISH_ERROR_CODES, PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { publishedPageAddress } from './pagesHost'
import type { PublishedPageSummary } from '../../repos/publishedPages'

// Who may publish a document as a web page: its owner and the
// workspace's admins (`canManage`, like the access mode) — publishing
// makes the content public, whatever the document's own access mode.

export async function requirePublishManager(event: H3Event) {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) throw createError({ statusCode: 404, message: 'Document not found' })
  if (!authz.canManage) {
    throw createError({ statusCode: 403, message: 'Only the owner and workspace admins can publish this document.', data: { code: 'publish/not-allowed' } })
  }
  const doc = (await getDoc(docId))!
  return { userId: session.user.id, docId, doc }
}

/** The instance origin published-page links use: NUXT_SITE_URL, else the request's. */
export function publicBaseUrl(event: H3Event): string {
  return emailLinkBaseUrl(useRuntimeConfig(event).siteUrl) ?? getRequestURL(event).origin
}

/** Address of a page at `/p/<slug>`: on the pages host when configured, else on the instance. */
export function publishedPageUrl(event: H3Event, slug: string): string {
  return publishedPageAddress(slug, publicBaseUrl(event))
}

export function publishView(event: H3Event, page: PublishedPageSummary | null) {
  if (!page) return { published: false as const, page: null }
  return {
    published: true as const,
    page: {
      slug: page.slug,
      url: publishedPageUrl(event, page.slug),
      indexable: page.indexable,
      publishedAt: page.publishedAt.toISOString(),
      updatedAt: page.updatedAt.toISOString()
    }
  }
}

/** Body field checks shared by POST + PATCH. */
export function readPublishFields(body: unknown): { slug?: string, indexable?: boolean } {
  const b = (body && typeof body === 'object' ? body : {}) as { slug?: unknown, indexable?: unknown }
  const out: { slug?: string, indexable?: boolean } = {}
  if (b.slug !== undefined && b.slug !== null && b.slug !== '') {
    if (typeof b.slug !== 'string' || !PUBLISH_SLUG_RE.test(b.slug)) {
      throw createError({ statusCode: 400, message: 'Use 3–60 lowercase letters, digits and single hyphens.', data: { code: PUBLISH_ERROR_CODES.slugInvalid, field: 'slug' } })
    }
    out.slug = b.slug
  }
  if (b.indexable !== undefined) {
    if (typeof b.indexable !== 'boolean') throw createError({ statusCode: 400, message: 'indexable must be true or false.', data: { code: 'publish/invalid', field: 'indexable' } })
    out.indexable = b.indexable
  }
  return out
}
