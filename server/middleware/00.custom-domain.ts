import { customDomainSettings } from '../utils/customDomains/config'
import { isKnownCustomHostname, liveCustomDomainForHost } from '../utils/customDomains/routing'
import { getPublishedPageById } from '../repos/publishedPages'
import { sendPublishedPage } from '../utils/publish/servePage'
import { emailLinkBaseUrl } from '../utils/siteUrl'
import { NOINDEX_VALUE } from '../utils/robots'

// Requests on a custom domain (WP13). Traefik routes every live custom
// domain to the app; on such a host ONLY the published page (at `/`), its
// files (`/api/published/…`), the vendored fonts / stylesheets
// (`/vendor/…`) and robots.txt exist — no app, no API, no sign-in, so a
// customer's domain can never act as a second origin of the editor (no
// session cookies are scoped to it anyway). Runs first (`00.`).

const PASS_THROUGH = [/^\/vendor\//, /^\/favicon\.ico$/]
// Only the files of the page bound to this domain: another page's files
// on a customer's domain would let anyone serve their uploads under it.
const PUBLISHED_FILE_PATH = /^\/api\/published\/([^/]+)\/(?:files|brand)\/[^/]+$/

function notFound(event: Parameters<typeof setResponseStatus>[0], text = 'Not found'): string {
  setResponseStatus(event, 404)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'x-robots-tag', NOINDEX_VALUE)
  setHeader(event, 'content-security-policy', `default-src 'none'; frame-ancestors 'none'`)
  return text
}

export default defineEventHandler(async (event) => {
  if (!customDomainSettings()) return
  const host = (getRequestHeader(event, 'host') ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return
  const site = emailLinkBaseUrl(useRuntimeConfig(event).siteUrl)
  if (site && new URL(site).hostname === host) return
  const domain = await liveCustomDomainForHost(host)
  if (!domain) {
    // A customer's domain that isn't live (pending, dropped, plan lapsed —
    // Traefik may still route it for a few seconds, and on plain-HTTP
    // self-host any Host reaches the app): never serve the editor on it.
    if (await isKnownCustomHostname(host)) return notFound(event)
    return
  }

  const path = (event.path.split('?')[0] ?? '/')
  if (event.method !== 'GET' && event.method !== 'HEAD') return notFound(event)
  if (PASS_THROUGH.some(re => re.test(path))) return
  const fileOf = PUBLISHED_FILE_PATH.exec(path)
  if (fileOf) return fileOf[1] === domain.pageId ? undefined : notFound(event)

  const page = domain.pageId ? await getPublishedPageById(domain.pageId) : null
  if (path === '/robots.txt') {
    setHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return page?.indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n'
  }
  if (path !== '/') return notFound(event)
  if (!page) return notFound(event, 'Nothing is published on this domain yet.')
  return sendPublishedPage(event, page, `https://${host}/`)
})
