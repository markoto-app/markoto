// Atomic env vars → connection strings. Single place that owns the
// mapping, so .env never needs to carry a composed URL alongside the
// parts it was built from (which always drift). The parts come from the
// typed env (shared/env: `database`, `valkey`), validated at boot by the
// app and the sync server.

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

/** Postgres parts as the typed env carries them (`env.database`). */
export interface DatabaseEnv {
  user: string
  password: string
  host: string
  port: number
  db: string
}

/** Valkey parts as the typed env carries them (`env.valkey`). */
export interface ValkeyEnv {
  host: string
  port: number
  password?: string
  db: number
  tlsEnabled: boolean
  tlsCaPath?: string
}

/** Connection URL from the typed env's `database` group (validated at boot). */
export function postgresUrlFromEnv(db: DatabaseEnv): string {
  // Boot validation requires these; outside a validated boot (scripts,
  // test tiers) a missing one must still fail loudly, not connect to ''.
  const missing = (['user', 'password', 'host', 'db'] as const).filter(k => !db[k])
  if (missing.length > 0) {
    const names = { user: 'POSTGRES_USER', password: 'POSTGRES_PASSWORD', host: 'POSTGRES_HOST', db: 'POSTGRES_DB' }
    throw new Error(`[postgres] missing required env vars: ${missing.map(k => names[k]).join(', ')}`)
  }
  return buildPostgresUrl({ user: db.user, password: db.password, host: db.host, port: db.port, database: db.db })
}

/**
 * Returns the URL plus an optional ioredis options bag carrying TLS config
 * (custom CA, etc.) — pass both to `new Redis(url, options)`. For deploys
 * without TLS this returns `{ url, options: undefined }` so callers can use
 * a single shape regardless of TLS state.
 *
 * The CA file is loaded synchronously at first call: the file IO is
 * one-shot at boot and a missing file should fail as loudly as a missing
 * variable.
 */
export function valkeyClientConfigFromEnv(
  valkey: ValkeyEnv,
  fs: { readFileSync: (path: string) => Buffer } | null = null
): ValkeyClientConfig {
  if (!valkey.host) throw new Error('[valkey] missing required env vars: VALKEY_HOST')
  const url = buildValkeyUrl({ host: valkey.host, port: valkey.port, password: valkey.password, db: valkey.db, tlsEnabled: valkey.tlsEnabled })
  if (!valkey.tlsEnabled) return { url }
  if (!valkey.tlsCaPath) {
    // Default cert validation against the system CA store. ioredis sees
    // `rediss://` in the URL and starts TLS; an empty `tls: {}` is the
    // documented way to opt into TLS without overriding defaults.
    return { url, options: { tls: {} } }
  }
  // Lazy-require to avoid pulling node:fs into client bundles. Tests can
  // inject a fake; runtime callers pass null and we resolve via require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const reader = fs ?? (require('node:fs') as { readFileSync: (path: string) => Buffer })
  return { url, options: { tls: { ca: reader.readFileSync(valkey.tlsCaPath) } } }
}
