import type { H3Event } from 'h3'
import { customDomainSettings } from '../utils/customDomains/config'
import { isKnownCustomHostname, liveCustomDomainForHost, type LiveCustomDomain } from '../utils/customDomains/routing'
import { getPublishedPageById, getPublishedPageBySlug } from '../repos/publishedPages'
import { sendPublishedPage } from '../utils/publish/servePage'
import { PUBLISHED_FILE_PATH, isPagesHostRequest, pagesHostRedirect, publishPagesSettings, requestHostname } from '../utils/publish/pagesHost'
import { emailLinkBaseUrl } from '../utils/siteUrl'
import { NOINDEX_VALUE } from '../utils/robots'
import { PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { resolveSiteIndexable } from '~~/shared/config/instance'

// Hosts that serve published pages and nothing else: the instance's pages
// host (`NUXT_PUBLISH_PAGES_HOST`, pages at `/p/<slug>`) and every live
// custom domain (its one page at `/`). On such a host only the page, its
// files (`/api/published/…`), the vendored fonts / stylesheets
// (`/vendor/…`) and robots.txt exist — no app, no API, no sign-in, GET /
// HEAD only — so user-written HTML never shares an origin with the editor.
// No session cookie is scoped to these hosts, and none is set on them
// (`event.context.publicPageHost`, utils/sessionCookie.ts). Runs first (`00.`).
//
// With a pages host configured, the app's own origin answers `/p/<slug>`
// and the published files with a permanent redirect there.

declare module 'h3' {
  interface H3EventContext {
    /** Set when the request is for the pages host or a custom domain. */
    publicPageHost?: 'pages' | 'custom-domain'
  }
}

const PASS_THROUGH = [/^\/vendor\//, /^\/favicon\.ico$/]

function notFound(event: H3Event, text = 'Not found'): string {
  setResponseStatus(event, 404)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  setHeader(event, 'x-robots-tag', NOINDEX_VALUE)
  setHeader(event, 'content-security-policy', `default-src 'none'; frame-ancestors 'none'`)
  return text
}

function robots(event: H3Event, body: string): string {
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return body
}

async function servePagesHost(event: H3Event, path: string): Promise<string | undefined> {
  if (!isGetOrHead(event)) return notFound(event)
  if (PASS_THROUGH.some(re => re.test(path))) return
  // Every page's files: they all share this one origin.
  if (PUBLISHED_FILE_PATH.test(path)) return
  if (path === '/robots.txt') {
    // Each page says itself whether it may be indexed (meta + header).
    return robots(event, resolveSiteIndexable(process.env) ? 'User-agent: *\nDisallow: /api/\n' : 'User-agent: *\nDisallow: /\n')
  }
  const slug = /^\/p\/([^/]+)$/.exec(path)?.[1]
  if (slug === undefined) return notFound(event)
  const page = PUBLISH_SLUG_RE.test(slug) ? await getPublishedPageBySlug(slug) : null
  if (!page) return notFound(event, 'This page does not exist or is no longer published.')
  return sendPublishedPage(event, page)
}

function isGetOrHead(event: H3Event): boolean {
  return event.method === 'GET' || event.method === 'HEAD'
}

async function serveCustomDomain(event: H3Event, path: string, host: string, domain: LiveCustomDomain): Promise<string | undefined> {
  event.context.publicPageHost = 'custom-domain'
  if (!isGetOrHead(event)) return notFound(event)
  if (PASS_THROUGH.some(re => re.test(path))) return
  // Only the files of the page bound to this domain: another page's files
  // on a customer's domain would let anyone serve their uploads under it.
  const fileOf = PUBLISHED_FILE_PATH.exec(path)
  if (fileOf) return domain.pageId !== null && fileOf[1] === domain.pageId ? undefined : notFound(event)

  const page = domain.pageId ? await getPublishedPageById(domain.pageId) : null
  if (path === '/robots.txt') {
    return robots(event, page?.indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n')
  }
  if (path !== '/') return notFound(event)
  if (!page) return notFound(event, 'Nothing is published on this domain yet.')
  return sendPublishedPage(event, page, `https://${host}/`)
}

/** Is `host` one of the instance's own names (not a candidate custom domain)? */
function isInstanceHost(event: H3Event, host: string): boolean {
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return true
  const site = emailLinkBaseUrl(useRuntimeConfig(event).siteUrl)
  return site !== null && new URL(site).hostname === host
}

export default defineEventHandler(async (event) => {
  const hostHeader = getRequestHeader(event, 'host')
  const host = requestHostname(hostHeader)
  const path = (event.path.split('?')[0] ?? '/')
  const pages = publishPagesSettings()
  if (isPagesHostRequest(hostHeader, pages)) {
    event.context.publicPageHost = 'pages'
    return servePagesHost(event, path)
  }

  if (customDomainSettings() && !isInstanceHost(event, host)) {
    const domain = await liveCustomDomainForHost(host)
    if (domain) return serveCustomDomain(event, path, host, domain)
    // A customer's domain that isn't live (pending, dropped, plan lapsed —
    // Traefik may still route it for a few seconds, and on plain-HTTP
    // self-host any Host reaches the app): never serve the editor on it.
    if (await isKnownCustomHostname(host)) {
      event.context.publicPageHost = 'custom-domain'
      return notFound(event)
    }
  }

  // The app's origin: published pages and their files live on the pages host.
  const target = pages && isGetOrHead(event) ? pagesHostRedirect(path, pages) : null
  if (target) {
    setHeader(event, 'cache-control', 'public, max-age=3600')
    return sendRedirect(event, target, 301)
  }
})
