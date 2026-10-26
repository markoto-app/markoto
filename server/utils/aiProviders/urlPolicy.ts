// SSRF policy for bring-your-own-key provider base URLs.
//
// The LiteLLM proxy will open connections to whatever `api_base` we hand
// it, so a user-supplied base URL is an SSRF primitive unless we gate it.
// Verified against LiteLLM v1.106.4: with
// `configurable_clientside_auth_params` on a deployment, the proxy does
// NOT run its own `user_url_validation` DNS check on a clientside
// `api_base` (a request to `http://169.254.169.254/...` was attempted, and
// a private docker address was accepted). This module is therefore the
// authoritative gate; the regex in `infra/litellm/config.yaml` is
// defence-in-depth for obvious literal internal targets.
//
// Checked at SAVE time (settings API) AND at REQUEST time (every LLM
// call, see `requestFields.ts`), so a hostname whose DNS later flips to a
// private address is refused on the next call.
//
// Rules, in order:
//   1. Absolute http(s) URL, no userinfo, no query/fragment.
//   2. Hostname is not an internal service name (`litellm`, `postgres`,
//      `valkey`, ...) — always, even with the private-network opt-in.
//   3. If an allowlist is configured (the SaaS), the URL must sit at or
//      under one of the allowlisted base URLs.
//   4. Every resolved address must not be "always forbidden" (loopback,
//      link-local / cloud metadata, multicast, unspecified).
//   5. Private addresses (RFC 1918, CGNAT, ULA) only with the operator
//      opt-in `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`.
//   6. Plain http only with the opt-in AND only to private addresses —
//      an API key never crosses the public internet unencrypted.
//
// Residual risk (documented in docs/AI-MODELS.md): LiteLLM resolves the
// hostname again when it connects, so a DNS answer that flips between our
// check and LiteLLM's connect (rebinding with a ~0s TTL) is not caught
// here. In the SaaS the allowlist pins hostnames to major providers, which
// closes it; self-hosters accept it with free-form URLs.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isAlwaysForbiddenIp, isPrivateIp } from '../agentic/urlGuard'
import { normalizeBaseUrl, type UrlRefusalCode } from '~~/shared/ai/providers'

export interface ByokUrlPolicy {
  /** Normalised allowlisted base URLs. Empty = any public URL (self-host). */
  allowedBaseUrls: string[]
  /** Operator opt-in for private-network endpoints (Ollama, vLLM on the LAN). */
  allowPrivate: boolean
}

/**
 * Hostnames of markoto's own services (prod compose names, their `-test`
 * twins, and cloud metadata aliases). Refused unconditionally: even a
 * self-hoster who opted into private URLs never wants the proxy to POST
 * an API request at its own database.
 */
const INTERNAL_HOSTNAMES = new Set([
  'localhost',
  'litellm', 'postgres', 'valkey', 'redis', 'sync', 'renderer', 'markitdown', 'app', 'traefik', 'backup', 'seaweedfs',
  'litellm-test', 'postgres-test', 'valkey-test', 'sync-test', 'renderer-test', 'markitdown-test', 'seaweedfs-test',
  'stripe-mock',
  'metadata', 'metadata.google.internal'
])

export type Resolver = (host: string) => Promise<string[]>

export const systemResolver: Resolver = async (host) => {
  const rows = await lookup(host, { all: true })
  return rows.map(r => r.address)
}

export type UrlPolicyResult
  = | { ok: true, normalized: string }
    | { ok: false, code: UrlRefusalCode, message: string }

function refuse(code: UrlRefusalCode, message: string): UrlPolicyResult {
  return { ok: false, code, message }
}

function isUnderAllowlist(normalized: string, allowlist: string[]): boolean {
  return allowlist.some(entry => normalized === entry || normalized.startsWith(`${entry}/`))
}

/** Structural checks (rules 1-3) that need no DNS. */
function checkStructure(raw: string, policy: ByokUrlPolicy): UrlPolicyResult & { host?: string, protocol?: string } {
  const normalized = normalizeBaseUrl(raw)
  if (!normalized) return refuse('invalid', 'Enter an absolute URL such as https://api.mistral.ai/v1.')
  const parsed = new URL(raw.trim())
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return refuse('scheme', 'Only http(s) URLs are supported.')
  }
  if (parsed.username || parsed.password) {
    return refuse('credentials-in-url', 'Do not put credentials in the URL; use the API key field.')
  }
  if (parsed.search || parsed.hash) {
    return refuse('invalid', 'The base URL must not contain a query string or fragment.')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return refuse('invalid', 'The URL has no hostname.')
  if (INTERNAL_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    return refuse('internal-host', 'This host is an internal service and cannot be used as an AI provider.')
  }
  if (policy.allowedBaseUrls.length > 0 && !isUnderAllowlist(normalized, policy.allowedBaseUrls)) {
    return refuse('not-allowlisted', 'This provider is not on the list of providers allowed on this instance.')
  }
  return { ok: true, normalized, host, protocol: parsed.protocol }
}

/**
 * Full policy check (structure + DNS). Pure apart from the injected
 * resolver, so unit tests drive DNS-rebinding-shaped cases without a
 * network.
 */
export async function checkProviderBaseUrl(
  raw: string,
  policy: ByokUrlPolicy,
  resolve: Resolver = systemResolver
): Promise<UrlPolicyResult> {
  const structural = checkStructure(raw, policy)
  if (!structural.ok) return structural
  const host = structural.host ?? ''

  let addresses: string[]
  if (isIP(host) !== 0) {
    addresses = [host]
  } else {
    try {
      addresses = await resolve(host)
    } catch {
      return refuse('unresolvable', `The hostname "${host}" could not be resolved.`)
    }
    if (addresses.length === 0) return refuse('unresolvable', `The hostname "${host}" has no DNS records.`)
  }

  let anyPublic = false
  for (const address of addresses) {
    if (isAlwaysForbiddenIp(address)) {
      return refuse('private-address', 'This URL points at a loopback, link-local or metadata address.')
    }
    if (isPrivateIp(address)) {
      if (!policy.allowPrivate) {
        return refuse('private-address', 'This URL points at a private network address, which this instance does not allow.')
      }
    } else {
      anyPublic = true
    }
  }

  if (structural.protocol === 'http:' && (!policy.allowPrivate || anyPublic)) {
    return refuse('https-required', 'Use https:// — plain http is only allowed for private-network endpoints on self-hosted instances.')
  }
  return { ok: true, normalized: structural.normalized }
}

/** Thrown at request time when a stored base URL no longer passes the policy. */
export class AiProviderUrlRefused extends Error {
  readonly code: UrlRefusalCode
  constructor(code: UrlRefusalCode, message: string) {
    super(message)
    this.name = 'AiProviderUrlRefused'
    this.code = code
  }
}
