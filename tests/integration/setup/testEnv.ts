import {
  TEST_BASE_URL,
  TEST_DB_URL,
  TEST_DB_HOST,
  TEST_DB_PORT,
  TEST_DB_NAME,
  TEST_DB_USER,
  TEST_DB_PASSWORD,
  TEST_INTERNAL_SECRET,
  TEST_JWT_SECRET,
  TEST_PORT,
  TEST_SESSION_PASSWORD,
  TEST_SYNC_URL,
  TEST_VALKEY_URL,
  TEST_VALKEY_HOST,
  TEST_VALKEY_PORT,
  TEST_VALKEY_PASSWORD
} from './env'

// Single source of truth for the env vars every test surface (repo
// tests, integration subprocess) needs.
//
// Why this exists: `useDatabase()` and `useValkey()` resolve their
// connection strings via `postgresUrlFromEnv` / `valkeyUrlFromEnv` in
// `shared/utils/runtime/connectionStrings.ts`, which read atomic POSTGRES_* /
// VALKEY_* vars rather than the composed *_URL ones. We ALSO need to
// set DATABASE_URL / VALKEY_URL because some legacy boot paths read
// the composed forms directly. Forgetting any of them produces
// confusing failures deep inside a test run (FK violations, "missing
// env var" boot errors). Centralising the list means a future
// connection-string refactor breaks ONE place loudly instead of
// leaking through the suite.
//
// Two consumption modes:
//   - `applyTestEnv()`  — mutates `process.env` for in-process suites
//                         (repo tests run repos directly under vitest).
//   - `buildTestEnv()`  — returns the canonical map for callers that
//                         build their own env (e.g. the integration
//                         subprocess spawn, which mixes these vars
//                         with NUXT_* runtime config).

/**
 * The canonical map. Every var any test surface might need to point
 * at the test stack belongs here. Don't add NUXT_* runtime config
 * (that's owned by `server.ts`'s subprocess env builder); this map is
 * for "talk to the test infra" only.
 */
export function buildTestEnv(): Record<string, string> {
  return {
    // Composed URLs — kept for backward-compat with any code path that
    // still reads them directly.
    DATABASE_URL: TEST_DB_URL,
    VALKEY_URL: TEST_VALKEY_URL,
    // Atomic Postgres parts — `postgresUrlFromEnv` reads these.
    POSTGRES_USER: TEST_DB_USER,
    POSTGRES_PASSWORD: TEST_DB_PASSWORD,
    POSTGRES_HOST: TEST_DB_HOST,
    POSTGRES_PORT: TEST_DB_PORT,
    POSTGRES_DB: TEST_DB_NAME,
    // Atomic Valkey parts — `valkeyUrlFromEnv` reads these. Password
    // mirrors `--requirepass testpassword` in docker-compose.test.yml.
    VALKEY_HOST: TEST_VALKEY_HOST,
    VALKEY_PORT: TEST_VALKEY_PORT,
    VALKEY_PASSWORD: TEST_VALKEY_PASSWORD,
    VALKEY_DB: '0',
    // Test-deterministic secrets.
    NUXT_SESSION_PASSWORD: TEST_SESSION_PASSWORD,
    NUXT_JWT_SECRET: TEST_JWT_SECRET,
    NUXT_INTERNAL_API_SECRET: TEST_INTERNAL_SECRET,
    NUXT_SYNC_INTERNAL_URL: TEST_SYNC_URL,
    // Boot signals. TEST_MODE gates in-process fakes (Speech mock, the
    // /_test/login bypass) — repo tests don't usually need these but
    // setting it here keeps the env shape uniform.
    TEST_MODE: '1',
    // Repo-tier tests don't bring up the LiteLLM proxy (no
    // Nuxt subprocess, no LiteLLM URL). Stub the per-user key
    // path so `resolveBillingContext` can run without hitting the
    // network. Integration tests do NOT set this — they exercise the
    // real proxy.
    LITELLM_TEST_STUB: '1',
    LITELLM_SALT_KEY: 'sk-test-litellm-salt-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    TEST_BASE_URL,
    NITRO_PORT: String(TEST_PORT),
    PORT: String(TEST_PORT)
  }
}

/**
 * Mutate `process.env` with `buildTestEnv()`. Call from globalSetup
 * BEFORE any code that reads connection strings runs (migrations, db
 * pool init, fixture imports). Idempotent — safe to call twice.
 */
export function applyTestEnv(): void {
  const map = buildTestEnv()
  for (const [k, v] of Object.entries(map)) {
    process.env[k] = v
  }
}
