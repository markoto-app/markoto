// `TEST_MODE=1` switches on test-only behaviour: the `/api/_test/*`
// endpoints (incl. a login shim that seals a session for any user id),
// the boot-time secret validation skip, the rate-limit bypass and a few
// in-process fakes. That is a full authentication bypass, so the flag is
// only honoured when the instance does NOT look like a real deployment.
//
// The production signal is `NUXT_SITE_URL`: every shipped deployment
// shape sets it (prod compose pins `https://${DOMAIN}`, the self-host
// compose requires `MARKOTO_PUBLIC_URL`, and production boot refuses to
// start without it), while the test harnesses (integration subprocess,
// flow stack, CI) leave it empty or point it at a loopback host. A
// stray `TEST_MODE=1` on a real instance therefore never activates the
// test surface, and `plugins/01-validate-secrets.ts` refuses to boot so
// the misconfiguration is loud rather than silently ignored.

type Env = Record<string, string | undefined>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(host)) return true
  if (host.endsWith('.localhost')) return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Reasons this environment looks like a real deployment. Empty = the
 * environment is a local / test one where `TEST_MODE=1` may apply.
 */
export function productionSignals(env: Env): string[] {
  const reasons: string[] = []
  const siteUrl = env.NUXT_SITE_URL?.trim() ?? ''
  if (siteUrl) {
    let hostname: string | null = null
    try {
      hostname = new URL(siteUrl).hostname
    } catch {
      reasons.push('NUXT_SITE_URL is set but not a valid URL')
    }
    if (hostname !== null && !isLoopbackHost(hostname)) {
      reasons.push(`NUXT_SITE_URL points at a non-local host (${hostname})`)
    }
  }
  return reasons
}

/** True when `TEST_MODE=1` is set AND the environment is not a real deployment. */
export function isTestModeEnabled(env: Env = process.env): boolean {
  return env.TEST_MODE === '1' && productionSignals(env).length === 0
}

/**
 * True when the Valkey-backed rate limits of `namespace` are skipped:
 * test mode is active and the namespace isn't listed in
 * `TEST_ENFORCE_RATE_LIMITS` (comma-separated namespaces, or `*` for
 * all). The list lets one integration server exercise real limits (the
 * MCP limits) while the rest of the suite keeps the bypass. Outside test
 * mode nothing is bypassed in the first place, so the switch can only
 * make an instance stricter, never looser.
 */
export function isRateLimitBypassed(namespace: string, env: Env = process.env): boolean {
  if (!isTestModeEnabled(env)) return false
  const enforced = new Set((env.TEST_ENFORCE_RATE_LIMITS ?? '').split(',').map(s => s.trim()).filter(Boolean))
  return !enforced.has('*') && !enforced.has(namespace)
}

/**
 * Boot-time error when `TEST_MODE=1` is set on an instance that looks
 * like a real deployment; null otherwise.
 */
export function testModeBootError(env: Env = process.env): string | null {
  if (env.TEST_MODE !== '1') return null
  const reasons = productionSignals(env)
  if (reasons.length === 0) return null
  return `TEST_MODE=1 is set on an instance that looks like a real deployment (${reasons.join('; ')}). `
    + 'TEST_MODE disables authentication and rate limits and must only be used by the test harness. Remove it.'
}
