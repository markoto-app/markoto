import { getRequestHeader, getRequestIP, type H3Event } from 'h3'
import { parseTrustedProxyHops, rateLimitIpKey, resolveClientIp } from '../../../shared/utils/security/clientIp'

/**
 * The requesting client's IP address, or `null` when it can't be told.
 *
 * The ONE place an endpoint may read a client address — rate-limit keys
 * and the (truncated) IP on audit / consent / abuse rows both come from
 * here. Never read `X-Forwarded-For` / `X-Real-IP` directly: the leftmost
 * XFF entry is whatever the client sent. See `shared/utils/security/clientIp.ts`
 * for the trusted-hop rule.
 *
 * `NUXT_TRUSTED_PROXY_HOPS` (default 1 = the Traefik in every shipped
 * compose file) is read from `process.env` on every call, not via
 * `useRuntimeConfig()`, so unit tests can flip it per case and the helper
 * works outside a Nitro context.
 */
export function getClientIp(event: H3Event): string | null {
  return resolveClientIp({
    forwardedFor: getRequestHeader(event, 'x-forwarded-for'),
    // Without `xForwardedFor`, h3 returns the socket peer address.
    remoteAddress: getRequestIP(event),
    trustedHops: parseTrustedProxyHops(process.env.NUXT_TRUSTED_PROXY_HOPS)
  })
}

/**
 * Rate-limit key for the requesting client: the IPv4 address, or the
 * IPv6 /64 prefix (see `rateLimitIpKey`). Use this — never the raw
 * `getClientIp` value — whenever a limit is keyed on the client address.
 */
export function getClientRateLimitKey(event: H3Event): string {
  return rateLimitIpKey(getClientIp(event))
}
