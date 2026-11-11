// Atomic env vars → connection strings. Single place that owns the
// mapping, so .env never needs to carry a composed URL alongside the
// parts it was built from (which always drift). Used by the Nuxt app
// (server/utils/{database,valkey}.ts), the sync-server
// (sync-server/src/persistence.ts), and the boot-time validator.

export interface PostgresParts {
  user: string
  password: string
  host: string
  port: string | number
  database: string
}

export interface ValkeyParts {
  host: string
  port: string | number
  /** Empty / unset = no auth (fine in dev/test). Required in prod/local. */
  password?: string
  /** Logical DB index (0–15 by default in Redis/Valkey). Defaults to 0. */
  db?: string | number
  /**
   * TLS opt-in. Default false for self-hosted single-VPS deploys where the
   * docker network is the trust boundary. Flip true if Valkey is on a
   * different host or behind a managed-Redis provider (Infomaniak managed
   * Valkey, AWS ElastiCache, OVH Redis-as-a-service, etc.).
   */
  tlsEnabled?: boolean
  /**
   * Optional path to a provider-supplied CA PEM. When unset, ioredis uses
   * the system CA store (sufficient for any provider that issues certs
   * from a public CA — most of them).
   */
  tlsCaPath?: string
}

/**
 * Shape compatible with `new Redis(url, options)`. Splitting the URL from
 * the options means the callers that need to pass `tls: { ca }` (rare —
 * only managed-Redis deployments) can do so without us encoding TLS hints
 * into the URL string. Common case (no TLS) returns options=undefined and
 * callers can pass it through unchanged.
 */
export interface ValkeyClientConfig {
  url: string
  options?: { tls?: { ca?: Buffer } }
}

function buildPostgresUrl(p: PostgresParts): string {
  const user = encodeURIComponent(p.user)
  const password = encodeURIComponent(p.password)
  return `postgres://${user}:${password}@${p.host}:${p.port}/${p.database}`
}

function buildValkeyUrl(p: ValkeyParts): string {
  const auth = p.password ? `:${encodeURIComponent(p.password)}@` : ''
  const db = p.db ?? '0'
  // `rediss://` (double-s) is the standard scheme for TLS-wrapped Redis;
  // ioredis recognises it and starts a TLS connection. The `tls` options
  // bag still has to be passed alongside if a custom CA is required.
  const scheme = p.tlsEnabled ? 'rediss' : 'redis'
  return `${scheme}://${auth}${p.host}:${p.port}/${db}`
}

const POSTGRES_REQUIRED_VARS = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB'
] as const

const VALKEY_REQUIRED_VARS = ['VALKEY_HOST', 'VALKEY_PORT'] as const

export function postgresUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const missing = POSTGRES_REQUIRED_VARS.filter(k => !env[k])
  if (missing.length > 0) {
    throw new Error(`[postgres] missing required env vars: ${missing.join(', ')}`)
  }
  // The integration test setup (tests/integration/setup/server.ts)
  // owns its own boot guard that refuses to spawn the test subprocess
  // when env still points at the dev DB. We deliberately don't repeat
  // a `TEST_MODE=1`-gated guard here: TEST_MODE has dual use (enables
  // `_test/login` AND signals integration runs), so this layer would
  // false-positive on interactive dev testing with the test-login
  // bypass.
  return buildPostgresUrl({
    user: env.POSTGRES_USER!,
    password: env.POSTGRES_PASSWORD!,
    host: env.POSTGRES_HOST!,
    port: env.POSTGRES_PORT!,
    database: env.POSTGRES_DB!
  })
}

function valkeyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const missing = VALKEY_REQUIRED_VARS.filter(k => !env[k])
  if (missing.length > 0) {
    throw new Error(`[valkey] missing required env vars: ${missing.join(', ')}`)
  }
  return buildValkeyUrl({
    host: env.VALKEY_HOST!,
    port: env.VALKEY_PORT!,
    password: env.VALKEY_PASSWORD,
    db: env.VALKEY_DB,
    tlsEnabled: env.VALKEY_TLS_ENABLED === 'true'
  })
}

/**
 * Returns the URL plus an optional ioredis options bag carrying TLS config
 * (custom CA, etc.) — pass both to `new Redis(url, options)`. For deploys
 * without TLS this returns `{ url, options: undefined }` so callers can use
 * a single shape regardless of TLS state.
 *
 * The CA file is loaded synchronously at first call. We do this in the
 * shared helper rather than at each call site because the file IO is
 * one-shot at boot and the throw-on-missing surface should match the
 * existing fail-fast posture for env vars.
 */
export function valkeyClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fs: { readFileSync: (path: string) => Buffer } | null = null
): ValkeyClientConfig {
  const url = valkeyUrlFromEnv(env)
  const tlsEnabled = env.VALKEY_TLS_ENABLED === 'true'
  if (!tlsEnabled) return { url }

  const caPath = env.VALKEY_TLS_CA_PATH
  if (!caPath) {
    // Default cert validation against the system CA store. ioredis sees
    // `rediss://` in the URL and starts TLS; an empty `tls: {}` is the
    // documented way to opt into TLS without overriding defaults.
    return { url, options: { tls: {} } }
  }

  // Lazy-require to avoid pulling node:fs into client bundles. Tests can
  // inject a fake; runtime callers pass null and we resolve via require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const reader = fs ?? (require('node:fs') as { readFileSync: (path: string) => Buffer })
  const ca = reader.readFileSync(caPath)
  return { url, options: { tls: { ca } } }
}
