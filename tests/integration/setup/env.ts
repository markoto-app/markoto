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
//   Fake OpenAI-compatible provider (BYOK): 4120 (test only)

import { MCP_RATE_LIMITS } from '../../../server/mcp/lib/mcpGate'
import { ANON_ABUSE_REPORT_LIMITS, ANON_DOC_CREATE_LIMITS } from '../../../shared/config/anonLimits'

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

// Rate-limit namespaces the billing-off server enforces despite test mode
// (`TEST_ENFORCE_RATE_LIMITS`, shared/utils/testMode.ts): every MCP limit,
// so tests/integration/mcp/rateLimits.test.ts can exercise them.
export const TEST_ENFORCED_MCP_RATE_LIMITS: readonly string[] = Object.values(MCP_RATE_LIMITS).map(rule => rule.namespace)
// ...and the anonymous-visitor limits (shared/config/anonLimits.ts), driven by
// endpoints/anonGate.test.ts + abuseReportsAnon.test.ts with a fresh
// X-Forwarded-For address per test (the bucket key).
export const TEST_ENFORCED_ANON_RATE_LIMITS: readonly string[] = [...ANON_DOC_CREATE_LIMITS, ...ANON_ABUSE_REPORT_LIMITS].map(rule => rule.namespace)

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
// Generic OIDC (WP7b): the `oidc-test` mock IdP (navikt mock-oauth2-server)
// in docker-compose.test.yml. Every path is its own issuer with its own
// signing key; the app trusts exactly TEST_OIDC_ISSUER.
export const TEST_OIDC_PORT = 4130
export const TEST_OIDC_BASE_URL = `http://127.0.0.1:${TEST_OIDC_PORT}`
export const TEST_OIDC_ISSUER = `${TEST_OIDC_BASE_URL}/markoto`
export const TEST_OIDC_CLIENT_ID = 'markoto-test-client'
export const TEST_OIDC_CLIENT_SECRET = 'markoto-test-client-secret'
/** In NUXT_ADMIN_USER_EMAILS of the test server (admin bootstrap on sign-in). */
export const TEST_OIDC_ADMIN_EMAIL = 'oidc-admin@test.local'

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
/** ALTCHA master key of the test servers (anonymous gate); tests derive the same sub-keys. */
export const TEST_ALTCHA_HMAC_KEY = 'test-altcha-hmac-key-isolated-from-dev-and-prod-x'

// Valkey-compatible endpoint for the test stack. Rate limits and session
// locks fall open/closed per `server/utils/rateLimit.ts` semantics when
// Valkey is unreachable — tests that exercise those paths need a live
// Valkey. The docker-compose.test.yml stack maps Valkey to localhost:6380
// with `--requirepass testpassword`.
export const TEST_VALKEY_URL = `redis://:${TEST_VALKEY_PASSWORD}@127.0.0.1:6380/0`

// ─── Fake OpenAI-compatible provider (BYOK) ──────────────────────────
// `fake-openai-test` in docker-compose.test.yml, published on host port
// 4120. The BYOK base URL must be reachable from BOTH the app (on the
// host, which runs the SSRF policy incl. DNS — loopback is refused) and
// litellm-test (in a container, which connects). The gateway address of
// the test stack's network is one both sides share: it is a local
// interface on the host, and from inside a container it reaches the host.
// docker-compose.test.yml pins that network's subnet so the gateway is
// known up front, and publishes the port on that address (plus loopback)
// only — never on all interfaces. Override with TEST_NETWORK_GATEWAY
// (set it for `docker compose up` too) or TEST_FAKE_OPENAI_BASE_URL.
/**
 * Stripe price catalogue for the test stack (stripe-mock has no lookup
 * keys): every plan / interval / currency → a fixed test price id. The
 * monthly EUR Pro price stays `price_test_pro`, the id the webhook
 * fixtures carry. Annual CHF Pro is stripe-mock's canned price
 * (`STRIPE_MOCK_PRICE_ID`, what every subscription retrieve answers), so
 * the checkout's "already on this price" 409 is reachable.
 * server/utils/stripePrices.ts reads it from NUXT_STRIPE_PRICE_IDS.
 */
export const STRIPE_MOCK_PRICE_ID = 'price_1PgafmB7WZ01zgkW6dKueIc5'
export const TEST_STRIPE_PRICE_IDS = 'markoto_pro_month_eur=price_test_pro,markoto_pro_year_eur=price_test_pro_year,markoto_team_month_eur=price_test_team,markoto_team_year_eur=price_test_team_year,markoto_business_month_eur=price_test_business,markoto_business_year_eur=price_test_business_year,markoto_pro_month_chf=price_test_pro_chf,markoto_pro_year_chf=price_1PgafmB7WZ01zgkW6dKueIc5,markoto_team_month_chf=price_test_team_chf,markoto_team_year_chf=price_test_team_year_chf,markoto_business_month_chf=price_test_business_chf,markoto_business_year_chf=price_test_business_year_chf'

export const TEST_FAKE_OPENAI_PORT = 4120
export const TEST_FAKE_OPENAI_HOST_URL = `http://127.0.0.1:${TEST_FAKE_OPENAI_PORT}`
/** MUST match the `networks.default` gateway default in docker-compose.test.yml. */
export const TEST_NETWORK_GATEWAY_DEFAULT = '10.213.47.1'

export function fakeOpenAiBaseUrl(): string {
  const override = process.env.TEST_FAKE_OPENAI_BASE_URL
  if (override) return override
  // TEST_FAKE_OPENAI_HOST: where the stack published it (rootless Podman:
  // a private host address — the bridge gateway isn't on the host there).
  const host = process.env.TEST_FAKE_OPENAI_HOST || process.env.TEST_NETWORK_GATEWAY || TEST_NETWORK_GATEWAY_DEFAULT
  return `http://${host}:${TEST_FAKE_OPENAI_PORT}/v1`
}

/**
 * The mock IdP (oidc-test) on the private address — what per-workspace
 * SSO connections use (WP14): the SSRF policy refuses loopback, and the
 * test server allows private IdPs (`NUXT_SSO_ALLOW_PRIVATE_URLS`).
 * Every path below it is a separate issuer.
 */
export function ssoMockIdpBase(): string {
  const host = process.env.TEST_FAKE_OPENAI_HOST || process.env.TEST_NETWORK_GATEWAY || TEST_NETWORK_GATEWAY_DEFAULT
  return `http://${host}:${TEST_OIDC_PORT}`
}

// LiteLLM's own Postgres role in the test stack (litellm-test-db-init in
// docker-compose.test.yml). The app's spend-log paths connect with it, as
// in a deployment with separate roles (server/utils/litellm/litellmDb.ts).
export const TEST_LITELLM_DB_USER = 'litellm_test'
export const TEST_LITELLM_DB_PASSWORD = 'litellmtestpassword'
