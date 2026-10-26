// Centralised test environment constants. Imported by every integration
// piece (server boot, fixtures, test clients) so a port bump only needs
// editing one place.
//
// Ports are shifted from the dev stack so both can run concurrently:
//   Nuxt:      3000 (dev)     → 3101 (test), 3102 (test, billing off)
//   Postgres:  5432 (dev)     → 5433 (test)
//   Valkey:    6379 (dev)     → 6380 (test)
//   SeaweedFS: 8333 (dev)     → 8334 (test)
//   Sync:      4001 (dev)     → 4002 (test, real sync-test container)

export const TEST_PORT = 3101
export const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`

// Second Nitro subprocess from the SAME build, booted with billing OFF
// (NUXT_BILLING_ENABLED unset, NUXT_PLANS_COMING_SOON=true, and no
// NUXT_STRIPE_* vars at all) so the billing-off surface — 404s on the
// billing endpoints, the waitlist, free-only limits — is covered over
// real HTTP. The primary server above runs with billing ON because the
// Stripe checkout / portal / webhook suites need it. Shares the test
// Postgres + Valkey; boots after the primary so migrations are no-ops.
export const TEST_BILLING_OFF_PORT = 3102
export const TEST_BILLING_OFF_BASE_URL = `http://127.0.0.1:${TEST_BILLING_OFF_PORT}`

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

// Sync-server target — the real `sync-test` Hocuspocus container under
// docker-compose.test.yml, host-mapped on 4002. Both internal HTTP
// endpoints (/internal/kick-user, /internal/notify-deleted) AND the
// WebSocket Y.js sync protocol are served by the same process, so
// pointing Nuxt's `syncInternalUrl` here unlocks live-sync coverage
// (MCP doc-bound tools, AI agentic loop, real Hocuspocus auth flow).
//
// Previously this pointed at an in-process Node HTTP stub on port 4010
// that recorded /internal/kick-user calls for assertion. Removed: the
// stub couldn't speak Hocuspocus protocol, which gated every Y.js-
// touching tool out of integration coverage. The kick-user dispatch
// shape is now pinned by `tests/unit/syncNotify.test.ts`.
export const TEST_SYNC_PORT = 4002
export const TEST_SYNC_URL = `http://127.0.0.1:${TEST_SYNC_PORT}`

// Deterministic secrets. Fixtures sign JWTs with TEST_JWT_SECRET and seal
// cookies using TEST_SESSION_PASSWORD; both have to match the values the
// Nuxt subprocess boots with. JWT_SECRET + INTERNAL_API_SECRET ALSO have
// to match the sync-test container's build-time env vars (same compose
// file) — otherwise Nuxt → sync /internal calls 403 and Hocuspocus
// rejects every WS connection. If you bump these, mirror the change in
// docker-compose.test.yml's sync-test environment.
export const TEST_JWT_SECRET = 'test-jwt-secret-isolated-from-dev-and-prod-stacks-64char'
export const TEST_SESSION_PASSWORD = 'test-session-password-' + 'y'.repeat(64)
export const TEST_INTERNAL_SECRET = 'test-internal-api-secret-isolated'

// Valkey-compatible endpoint for the test stack. Rate limits and session
// locks fall open/closed per `server/utils/rateLimit.ts` semantics when
// Valkey is unreachable — tests that exercise those paths need a live
// Valkey. The docker-compose.test.yml stack maps Valkey to localhost:6380
// with `--requirepass testpassword`.
export const TEST_VALKEY_URL = `redis://:${TEST_VALKEY_PASSWORD}@127.0.0.1:6380/0`
