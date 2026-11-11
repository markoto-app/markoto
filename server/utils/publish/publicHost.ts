import type { H3Event } from 'h3'
import { customDomainSettings } from '../customDomains/config'
import { isKnownCustomHostname, liveCustomDomainForHost } from '../customDomains/routing'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { isPagesHostRequest, publishPagesSettings, requestHostname } from './pagesHost'

// Which requests are for a host that serves user-written published pages
// (the pages host, a custom domain) rather than the app. Decided from the
// Host header in a Nitro `request` hook (plugins/00-public-page-host.ts),
// so it holds for EVERY response on such a host — also the ones Nitro
// answers before any route middleware runs (public assets, their 404s,
// error pages).

export type PublicPageHostKind = 'pages' | 'custom-domain'

declare module 'h3' {
  interface H3EventContext {
    /** Set when the request is for the pages host or a custom domain. */
    publicPageHost?: PublicPageHostKind
  }
}

/** Is `host` one of the instance's own names (never a custom domain)? */
export function isInstanceHost(host: string, siteUrl: unknown): boolean {
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return true
  const site = emailLinkBaseUrl(siteUrl)
  return site !== null && new URL(site).hostname === host
}

export async function publicPageHostKind(hostHeader: string | undefined, siteUrl: unknown): Promise<PublicPageHostKind | null> {
  if (isPagesHostRequest(hostHeader, publishPagesSettings())) return 'pages'
  if (!customDomainSettings()) return null
  const host = requestHostname(hostHeader)
  if (isInstanceHost(host, siteUrl)) return null
  // Known covers live ones and those that were verified once: neither
  // may ever answer as the app.
  if (await liveCustomDomainForHost(host) || await isKnownCustomHostname(host)) return 'custom-domain'
  return null
}

function withoutSetCookie(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers
  if (Array.isArray(headers)) {
    // Raw [name, value, name, value, …] form.
    const out: unknown[] = []
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() !== 'set-cookie') out.push(headers[i], headers[i + 1])
    }
    return out
  }
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([k]) => k.toLowerCase() !== 'set-cookie'))
}

/**
 * Make the response of `event` unable to carry a cookie, and its request
 * blind to the ones the browser sent: whatever answers it afterwards
 * (a handler, the static-asset server, the error handler, a session
 * read that re-seals a stale cookie), no `Set-Cookie` leaves the server.
 * The session cookie is host-only on the app, so a browser never sends
 * it here; anything that arrives is forged or stale and is ignored.
 */
export function sealAgainstCookies(event: H3Event): void {
  const req = event.node?.req
  if (req?.headers) delete req.headers.cookie
  const res = event.node?.res
  if (!res) return
  res.removeHeader('set-cookie')
  const setHeader = res.setHeader.bind(res)
  res.setHeader = (name: string, value: number | string | readonly string[]) =>
    name.toLowerCase() === 'set-cookie' ? res : setHeader(name, value)
  if (typeof res.appendHeader === 'function') {
    const appendHeader = res.appendHeader.bind(res)
    res.appendHeader = (name: string, value: string | readonly string[]) =>
      name.toLowerCase() === 'set-cookie' ? res : appendHeader(name, value)
  }
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res
  res.writeHead = (...args: unknown[]) => {
    // writeHead(status, headers) / writeHead(status, message, headers)
    const i = typeof args[1] === 'string' ? 2 : 1
    if (args.length > i) args[i] = withoutSetCookie(args[i])
    res.removeHeader('set-cookie')
    return writeHead(...args)
  }
}
