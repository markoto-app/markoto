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
  /** Empty / unset = no auth (fine in dev). */
  password?: string
  /** Logical DB index (0–15 by default in Redis/Valkey). Defaults to 0. */
  db?: string | number
}

export function buildPostgresUrl(p: PostgresParts): string {
  const user = encodeURIComponent(p.user)
  const password = encodeURIComponent(p.password)
  return `postgres://${user}:${password}@${p.host}:${p.port}/${p.database}`
}

export function buildValkeyUrl(p: ValkeyParts): string {
  const auth = p.password ? `:${encodeURIComponent(p.password)}@` : ''
  const db = p.db ?? '0'
  return `redis://${auth}${p.host}:${p.port}/${db}`
}

export const POSTGRES_REQUIRED_VARS = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB'
] as const

export const VALKEY_REQUIRED_VARS = ['VALKEY_HOST', 'VALKEY_PORT'] as const

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

export function valkeyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const missing = VALKEY_REQUIRED_VARS.filter(k => !env[k])
  if (missing.length > 0) {
    throw new Error(`[valkey] missing required env vars: ${missing.join(', ')}`)
  }
  return buildValkeyUrl({
    host: env.VALKEY_HOST!,
    port: env.VALKEY_PORT!,
    password: env.VALKEY_PASSWORD,
    db: env.VALKEY_DB
  })
}
