// Outbound GET to a user/AI-supplied URL, for cases where the app itself opens
// the connection (`view_image`'s external-image fetch, which also serves image
// URLs from `fetch_url` extraction and BYOK `generate_image` responses).
//
// Three rules on top of the URL guard (`agentic/urlGuard.ts`):
//
//   1. Connect to the address that was checked. The host is resolved
//      once, every answer must be public, and the request goes to that IP
//      with the original `Host` header and TLS server name (SNI +
//      certificate check against the hostname). A DNS answer that changes
//      between check and connect is never used. Bun supports exactly this
//      shape (`tls.serverName`, `proxy: false`, see its fetch docs on
//      "connecting to a specific address").
//   2. Redirects are followed by hand, at most `maxRedirects` hops, and
//      every hop goes through rule 1 again, a public URL that redirects
//      to an internal one is refused before the internal one is contacted.
//   3. The body is read with a byte cap, so a lying or missing
//      `Content-Length` can't make us buffer more than the limit.

import { isIP } from 'node:net'
import { resolvePublicAddresses, systemHostResolver, type HostResolver } from '../agentic/urlGuard'
import { readStreamWithCap } from './streamCap'

/** `RequestInit` plus the Bun-specific fields used for a pinned connection. */
export interface PinnedRequestInit extends RequestInit {
  /** Bun: TLS options; `serverName` sets SNI and the certificate hostname. */
  tls?: { serverName?: string }
  /** Bun: `false` = never route through `HTTP(S)_PROXY`. */
  proxy?: false
}

export type PinnedFetch = (url: string, init: PinnedRequestInit) => Promise<Response>

export interface SafeFetchOptions {
  /** Redirect hops to follow (each re-checked). Default 3. */
  maxRedirects?: number
  signal?: AbortSignal
  /** Extra request headers (`Host` is always set by this module). */
  headers?: Record<string, string>
  /** Test seams. */
  resolve?: HostResolver
  fetchImpl?: PinnedFetch
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const defaultFetch: PinnedFetch = (url, init) => fetch(url, init)

/** The URL with its host replaced by `address` (brackets for IPv6). */
function addressUrl(target: URL, address: string): string {
  const pinned = new URL(target.href)
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
  return pinned.href
}

/** One request to the checked address of `target`, no redirect handling. */
async function fetchPinned(target: URL, opts: SafeFetchOptions): Promise<Response> {
  const addresses = await resolvePublicAddresses(target, opts.resolve ?? systemHostResolver)
  const address = addresses[0]
  if (address === undefined) throw new Error('URL refused: hostname returned no DNS records.')
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const init: PinnedRequestInit = {
    method: 'GET',
    headers: { ...opts.headers, Host: target.host },
    redirect: 'manual',
    signal: opts.signal,
    proxy: false
  }
  // SNI + certificate verification against the NAME, while dialling the IP.
  if (target.protocol === 'https:' && isIP(hostname) === 0) init.tls = { serverName: hostname }
  return (opts.fetchImpl ?? defaultFetch)(addressUrl(target, address), init)
}

/**
 * GET `rawUrl`, re-checking and pinning every redirect hop. Throws on a
 * refused URL (any hop), on too many redirects, and on a redirect without
 * a usable `Location`. Returns the final non-redirect response.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<{ response: Response, url: string }> {
  const maxRedirects = opts.maxRedirects ?? 3
  let target = new URL(rawUrl)
  for (let hop = 0; ; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`URL refused: scheme "${target.protocol}" not allowed. Use http:// or https://.`)
    }
    if (target.username || target.password) throw new Error('URL refused: credentials in the URL are not allowed.')
    const response = await fetchPinned(target, opts)
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url: target.href }
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error(`Remote answered HTTP ${response.status} without a Location header.`)
    if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}).`)
    // Resolve against the hostname URL, not the pinned IP URL.
    try {
      target = new URL(location, target)
    } catch {
      throw new Error('Remote answered with a malformed redirect Location.')
    }
  }
}

/**
 * Read a response body, failing as soon as it exceeds `maxBytes` (the
 * stream is cancelled; nothing beyond the cap is buffered).
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return new Uint8Array(0)
  return readStreamWithCap(response.body, maxBytes)
}
