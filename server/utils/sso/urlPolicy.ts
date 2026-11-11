// Per-workspace SSO (WP14) — the outbound policy for a customer's identity
// provider. A workspace admin types the OIDC issuer; the APP then fetches
// its discovery document, JWKS, token and UserInfo endpoints. Without a
// policy that is a server-side request forgery primitive, so every request
// goes through `ssoFetch`:
//
//   - https only; plain http only to a private address on an instance that
//     allows private IdPs (`NUXT_SSO_ALLOW_PRIVATE_URLS=true`: self-hosters
//     whose IdP sits on the office network, and the test stack).
//   - Never an internal service hostname (`postgres`, `litellm`, …), never
//     loopback / link-local / metadata / reserved addresses.
//   - The host is resolved once and the request dials THAT address with
//     the original `Host` and TLS server name (no DNS rebinding between
//     check and connect), no proxy, redirects never followed (an IdP
//     endpoint that redirects is refused, not chased).
//   - Responses are capped at 1 MiB, requests time out after 10 s.
//
// SAML needs none of this: the admin pastes the IdP's certificate and SSO
// URL; the browser, not the server, talks to the IdP.

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { isAlwaysForbiddenIp, isPrivateIp } from '../agentic/urlGuard'
import { isInternalHostname } from '../aiProviders/urlPolicy'
import { readStreamWithCap } from '../streamCap'
import type { PinnedRequestInit } from '../safeFetch'
import { parseBooleanFlag } from '~~/shared/config/billingMode'

export const SSO_FETCH_MAX_BYTES = 1024 * 1024
export const SSO_FETCH_TIMEOUT_MS = 10_000

export type SsoResolver = (host: string) => Promise<string[]>

export const systemSsoResolver: SsoResolver = async (host) => {
  const answers = await lookup(host, { all: true, verbatim: true })
  return answers.map(a => a.address)
}

/** Read per call so tests and self-hosters can switch it without a restart. */
export function ssoAllowsPrivateUrls(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanFlag(env.NUXT_SSO_ALLOW_PRIVATE_URLS)
}

export class SsoUrlRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsoUrlRefused'
  }
}

export interface CheckedTarget {
  url: URL
  /** The addresses the host resolved to, all allowed. */
  addresses: string[]
}

/**
 * Check a URL against the SSO policy and return the addresses to dial.
 * Throws `SsoUrlRefused` with a sentence fit for the admin.
 */
export async function checkSsoUrl(
  raw: string | URL,
  opts: { allowPrivate?: boolean, resolve?: SsoResolver } = {}
): Promise<CheckedTarget> {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new SsoUrlRefused('This is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsoUrlRefused('Use an https:// URL.')
  if (url.username || url.password) throw new SsoUrlRefused('The URL must not contain a user name or password.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new SsoUrlRefused('The URL has no host name.')
  if (isInternalHostname(host)) throw new SsoUrlRefused('This URL points at a service inside markoto.')

  const allowPrivate = opts.allowPrivate ?? ssoAllowsPrivateUrls()
  let addresses: string[]
  if (isIP(host) !== 0) {
    addresses = [host]
  } else {
    try {
      addresses = await (opts.resolve ?? systemSsoResolver)(host)
    } catch {
      throw new SsoUrlRefused(`The host name "${host}" could not be resolved.`)
    }
    if (addresses.length === 0) throw new SsoUrlRefused(`The host name "${host}" has no DNS records.`)
  }
  let anyPublic = false
  for (const address of addresses) {
    if (isAlwaysForbiddenIp(address)) throw new SsoUrlRefused('This URL points at a loopback, link-local or metadata address.')
    if (isPrivateIp(address)) {
      if (!allowPrivate) throw new SsoUrlRefused('This URL points at a private network address, which this instance does not allow.')
    } else {
      anyPublic = true
    }
  }
  if (url.protocol === 'http:' && (!allowPrivate || anyPublic)) {
    throw new SsoUrlRefused('Use https:// — plain http is only allowed for an identity provider on a private network of a self-hosted instance.')
  }
  return { url, addresses }
}

export type RawFetch = (url: string, init: PinnedRequestInit) => Promise<Response>

/**
 * A `fetch` for openid-client's `customFetch`: every request is checked
 * and pinned as described above. The response body is buffered with the
 * byte cap so a hostile IdP can't stream gigabytes into the app.
 */
export function createSsoFetch(opts: { allowPrivate?: boolean, resolve?: SsoResolver, fetchImpl?: RawFetch } = {}) {
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { url, addresses } = await checkSsoUrl(href, opts)
    const address = addresses[0] as string
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const pinned = new URL(url.href)
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address

    const headers = new Headers(init.headers)
    headers.set('Host', url.host)
    const pinnedInit: PinnedRequestInit = {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      redirect: 'manual',
      proxy: false,
      signal: AbortSignal.any([AbortSignal.timeout(SSO_FETCH_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])])
    }
    if (url.protocol === 'https:' && isIP(host) === 0) pinnedInit.tls = { serverName: host }

    const response = await (opts.fetchImpl ?? ((u, i) => fetch(u, i)))(pinned.href, pinnedInit)
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new SsoUrlRefused('The identity provider answered with a redirect, which is not followed.')
    }
    const body = response.body ? await readStreamWithCap(response.body, SSO_FETCH_MAX_BYTES) : new Uint8Array(0)
    if (body === null) throw new SsoUrlRefused('The identity provider answered with more than 1 MiB.')
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
