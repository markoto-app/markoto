import { normalizeCustomHostname } from '~~/shared/config/customDomains'
import { PUBLISHED_PAGE_PREFIX, PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { isInternalHostname } from '../aiProviders/urlPolicy'

// The separate hostname published pages are served from
// (`NUXT_PUBLISH_PAGES_HOST`, e.g. `pages.markoto.app`).
//
// A published page is HTML a user wrote. On the app's own origin it would
// sit under the trusted app hostname (phishing), its `<img src="/…">`
// would reach the app with the visitor's cookies, and any future gap in
// the sanitiser or the page CSP would be same-origin with the editor. On
// its own hostname none of that holds: the session cookie is host-only
// (nuxt.config.ts, no `domain`), so the browser never sends it there, and
// the pages host serves nothing of the app (server/middleware/00.custom-domain.ts).
//
// Unset (the self-host default) keeps one origin: pages at
// `<app>/p/<slug>`. Read per call so tests can stub the environment.

type Env = NodeJS.ProcessEnv

export interface PublishPagesSettings {
  /** Lowercase hostname without port — what the Host header is compared to. */
  hostname: string
  /** Origin page links are built from (`https://<hostname>` unless a port / http was configured). */
  origin: string
}

interface Parsed {
  settings: PublishPagesSettings | null
  error: string | null
}

function siteUrlOf(env: Env): URL | null {
  const raw = (env.NUXT_SITE_URL ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

const NAME = 'NUXT_PUBLISH_PAGES_HOST'

/** Scheme, port and hostname part of a value given as an origin (`https://host[:port]`). */
function splitOrigin(raw: string, env: Env, site: URL | null): { scheme: string, port: string, hostPart: string } | string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${NAME} is not a hostname or an https:// origin: "${raw.slice(0, 80)}"`
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    return `${NAME} must be a bare hostname or an origin without a path: "${raw.slice(0, 80)}"`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${NAME} must use https:// (got "${url.protocol}")`
  // Plain http only where the app itself runs on plain http (a LAN
  // self-host without TLS, the test stacks): a published page must
  // never be the one insecure origin of an https instance.
  if (url.protocol === 'http:' && site?.protocol !== 'http:' && !isTestModeEnabled(env)) {
    return `${NAME} uses http://, but the app (NUXT_SITE_URL) is not served over plain http — use https:// or a bare hostname`
  }
  return { scheme: url.protocol, port: url.port, hostPart: url.hostname }
}

function parse(env: Env): Parsed {
  const raw = (env[NAME] ?? '').trim()
  if (!raw) return { settings: null, error: null }
  const site = siteUrlOf(env)
  const parts = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? splitOrigin(raw, env, site) : { scheme: 'https:', port: '', hostPart: raw }
  if (typeof parts === 'string') return { settings: null, error: parts }
  const hostname = normalizeCustomHostname(parts.hostPart, { allowTestNames: isTestModeEnabled(env) })
  if (!hostname || hostname !== parts.hostPart.toLowerCase().replace(/\.$/, '')) {
    return { settings: null, error: `${NAME} must be a public DNS name such as pages.example.com (no IP address, no single label, no .local / .internal / .localhost): "${raw.slice(0, 80)}"` }
  }
  if (isInternalHostname(hostname)) {
    return { settings: null, error: `${NAME} names an internal service hostname: "${hostname}"` }
  }
  if (site?.hostname.toLowerCase() === hostname) {
    return { settings: null, error: `${NAME} must differ from the app's own hostname (NUXT_SITE_URL): published pages need an origin of their own` }
  }
  return { settings: { hostname, origin: `${parts.scheme}//${hostname}${parts.port ? `:${parts.port}` : ''}` }, error: null }
}

/** The configured pages host, or null (unset or invalid — boot validation reports invalid values). */
export function publishPagesSettings(env: Env = process.env): PublishPagesSettings | null {
  return parse(env).settings
}

/**
 * Boot-time errors. The hosted shape (`NUXT_LEGAL_SURFACES_ENABLED=true`)
 * must serve pages from their own host — publishing is open to every
 * account there — and that host is routed by Traefik's HTTP provider,
 * which only polls with the provider token.
 */
export function publishPagesErrors(env: Env, hostedShape: boolean): string[] {
  const { settings, error } = parse(env)
  if (error) return [error]
  const errors: string[] = []
  if (settings && !siteUrlOf(env)) {
    errors.push('NUXT_PUBLISH_PAGES_HOST is set but NUXT_SITE_URL is not: links from a published page back to the app (report form, redirects) are built from it')
  }
  if (hostedShape) {
    if (!settings) {
      errors.push('NUXT_PUBLISH_PAGES_HOST is empty, but this instance runs the hosted shape (NUXT_LEGAL_SURFACES_ENABLED=true): published pages must be served from their own hostname (e.g. pages.<your domain>), never the app\'s origin — see docs/LAUNCH-CHECKLIST.md')
    } else if ((env.NUXT_PUBLISH_TRAEFIK_TOKEN ?? '').trim().length < 32) {
      errors.push('NUXT_PUBLISH_PAGES_HOST is set but NUXT_PUBLISH_TRAEFIK_TOKEN is missing or shorter than 32 characters: Traefik learns the pages host\'s router and certificate from the app\'s HTTP provider, which only answers with the token')
    }
  }
  return errors
}

/** Lowercase request hostname without port or trailing dot. */
export function requestHostname(hostHeader: string | undefined): string {
  return (hostHeader ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

/** Is this request addressed to the pages host? */
export function isPagesHostRequest(hostHeader: string | undefined, settings: PublishPagesSettings | null = publishPagesSettings()): boolean {
  return !!settings && requestHostname(hostHeader) === settings.hostname
}

/** Absolute address of a page on the pages host (or on `fallbackBase` when there is none). */
export function publishedPageAddress(slug: string, fallbackBase: string, settings: PublishPagesSettings | null = publishPagesSettings()): string {
  let base = settings ? settings.origin : fallbackBase
  while (base.endsWith('/')) base = base.slice(0, -1)
  return `${base}${PUBLISHED_PAGE_PREFIX}${slug}`
}

/**
 * Where an app-origin request for a published page or one of its files
 * goes once pages have their own host, or null (not such a path).
 * `/p/<slug>` keeps old links working; the file paths keep images that
 * other sites embedded from the old address working. The query string is
 * dropped — pages take none.
 */
export function pagesHostRedirect(path: string, settings: PublishPagesSettings): string | null {
  const pathname = path.split('?')[0] ?? ''
  const slug = /^\/p\/([^/]+)\/?$/.exec(pathname)?.[1]
  if (slug !== undefined) return PUBLISH_SLUG_RE.test(slug) ? `${settings.origin}${PUBLISHED_PAGE_PREFIX}${slug}` : null
  if (PUBLISHED_FILE_PATH.test(pathname)) return `${settings.origin}${pathname}`
  return null
}

/** A published page's copied file (`/api/published/<pageId>/(files|brand)/<file>`). */
export const PUBLISHED_FILE_PATH = /^\/api\/published\/([^/]+)\/(?:files|brand)\/[^/]+$/
