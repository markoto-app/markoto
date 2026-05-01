// Centralised test environment constants. Imported by every integration
// piece (server boot, fixtures, test clients) so a port bump only needs
// editing one place.
//
// Ports are shifted from the dev stack so both can run concurrently:
//   Nuxt:      3000 (dev)     → 3101 (test)
//   Postgres:  5432 (dev)     → 5433 (test)
//   Valkey:    6379 (dev)     → 6380 (test)
//   SeaweedFS: 8333 (dev)     → 8334 (test)
//   Sync stub: 4001 (dev)     → 4010 (test, in-process Node stub)

export const TEST_PORT = 3101
export const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`

// The DB name guard — fixtures.ts and resetDb refuse to run unless the
// connection string points at exactly this name. Belt and braces so a
// misconfigured DATABASE_URL can't TRUNCATE the dev database.
export const TEST_DB_NAME = 'ypad_test'
export const TEST_DB_USER = 'ypad'
export const TEST_DB_PASSWORD = 'testpassword'
export const TEST_DB_HOST = '127.0.0.1'
export const TEST_DB_PORT = '5433'
export const TEST_DB_URL = `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_NAME}`

// Valkey atomic parts — `postgresUrlFromEnv` / `valkeyUrlFromEnv` in
// shared/utils/connectionStrings.ts now read these instead of the
// composed URLs, so we have to set both for the Nuxt subprocess.
export const TEST_VALKEY_HOST = '127.0.0.1'
export const TEST_VALKEY_PORT = '6380'
// Hardcoded weak password mirroring `--requirepass testpassword` in
// docker-compose.test.yml. Test infra is throwaway / tmpfs and the
// container only listens on localhost; the password exists to exercise
// the same auth code path prod uses.
export const TEST_VALKEY_PASSWORD = 'testpassword'

// Kick-user / notify-deleted target. The global setup boots a tiny Node
// HTTP stub on this port and points Nuxt's runtime config at it. Stub
// records calls so assertions can verify membership-change endpoints
// actually dispatched the expected kick.
export const TEST_SYNC_PORT = 4010
export const TEST_SYNC_URL = `http://127.0.0.1:${TEST_SYNC_PORT}`

// Deterministic secrets. Fixtures sign JWTs with TEST_JWT_SECRET and seal
// cookies using TEST_SESSION_PASSWORD; both have to match the values the
// Nuxt subprocess boots with.
export const TEST_JWT_SECRET = 'test-jwt-secret-' + 'x'.repeat(64)
export const TEST_SESSION_PASSWORD = 'test-session-password-' + 'y'.repeat(64)
export const TEST_INTERNAL_SECRET = 'test-internal-secret-' + 'z'.repeat(32)

// Valkey-compatible endpoint for the test stack. Rate limits and session
// locks fall open/closed per `server/utils/rateLimit.ts` semantics when
// Valkey is unreachable — tests that exercise those paths need a live
// Valkey. The docker-compose.test.yml stack maps Valkey to localhost:6380
// with `--requirepass testpassword`.
export const TEST_VALKEY_URL = `redis://:${TEST_VALKEY_PASSWORD}@127.0.0.1:6380/0`
