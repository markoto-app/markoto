import { deletePublishedPage, getPublishedPageById, getPublishedPageBySlug } from '../../repos/publishedPages'
import { prunePublishedObjects } from './publishDocument'
import { liveCustomDomainForHost } from '../customDomains/routing'
import { normalizeCustomHostname } from '~~/shared/config/customDomains'
import type { DocAccess } from '../../repos/proofs'

/** Take a document's web page down: the row (the address 404s at once), then its files. */
export async function takeDownPublishedPage(doc: DocAccess<'manage'> | DocAccess<'delete'>): Promise<{ id: string } | null> {
  const removed = await deletePublishedPage(doc)
  if (removed) await prunePublishedObjects(removed.id)
  return removed
}

const PUBLISHED_PATH_RE = /^\/p\/([^/?#]+)\/?$/

/**
 * The document behind a reported published-page address: a
 * `/p/<slug>` URL on any host, or the root of a live custom domain. Lets an
 * abuse report filed from a page's Report link reach the moderation flow.
 */
export async function docIdForPublishedUrl(raw: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const slug = PUBLISHED_PATH_RE.exec(url.pathname)?.[1]
  if (slug) return (await getPublishedPageBySlug(decodeURIComponent(slug)))?.docId ?? null
  if (url.pathname !== '/' && url.pathname !== '') return null
  const host = normalizeCustomHostname(url.hostname, { allowTestNames: true })
  const domain = host ? await liveCustomDomainForHost(host) : null
  if (!domain?.pageId) return null
  return (await getPublishedPageById(domain.pageId))?.docId ?? null
}
