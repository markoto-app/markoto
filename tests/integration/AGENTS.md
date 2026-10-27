# Integration Tests

REST + WebSocket tests that hit a real Nitro production build against a real Postgres + Valkey + sync stack. The "is the wiring right" tier — between unit tests (pure functions / mocks) and e2e flow tests (Playwright + headless browser).

## Stack lifecycle

The shared infra lives in `docker-compose.test.yml`. Bringing it up is a one-time per test run:

```bash
docker compose -f docker-compose.test.yml up -d --wait
bun run test:integration
docker compose -f docker-compose.test.yml down -v
```

`bun run test:integration` does NOT manage docker — it expects the stack to already be up. CI handles up + down separately so the same compose file can serve both `test:integration` and `flows:test` (the flow stack adds `--profile flows`; `sync-test` and `markitdown-test` always run — `endpoints/importLimits.test.ts` calls markitdown-test on host port 8081 directly).

The Nitro subprocess is managed by `tests/integration/setup/server.ts`:

1. `globalSetup.ts` runs `bun run build` (skip with `INTEGRATION_SKIP_BUILD=1` if the bundle is fresh).
2. Spawns `.output/server/index.mjs` on `PORT=3001`, polls `/api/health` for up to 90s.
3. All tests share that one subprocess. Teardown kills it on exit.
4. A **second subprocess from the same build** boots on `TEST_BILLING_OFF_PORT` (3102) once the primary is healthy: `NUXT_BILLING_ENABLED` off, `NUXT_PLANS_COMING_SOON=true`, and every `NUXT_STRIPE_*` var stripped. The primary runs with billing ON (Stripe suites need it). Talk to the billing-off twin with `anonClient(TEST_BILLING_OFF_BASE_URL)` / `loggedInClient(id, name, TEST_BILLING_OFF_BASE_URL)` — see `endpoints/billingOff.test.ts`. Both share the test Postgres + Valkey, so `resetDb()` isolation is unchanged.

5. **AI provider shapes (WP4).** The primary server is shaped like a SELF-HOSTED instance: `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_MODEL` = the bundled LiteLLM aliases, free-form BYOK URLs, `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`, a stub `MISTRAL_API_KEY`. The billing-off twin is shaped like the hosted SaaS: no `NUXT_AI_DEFAULT_*`, the recommended provider allowlist, no private URLs. BYOK tests use the **`fake-openai-test`** container (stdlib Python fake OpenAI-compatible provider, `tests/fixtures/fake-openai/server.py`, host port 4120) at the test network's gateway address (`fakeOpenAiBaseUrl()` in `setup/env.ts`: `docker-compose.test.yml` pins the default network to `10.213.47.0/24` and publishes 4120 on `127.0.0.1` + the gateway `10.213.47.1` only; override with `TEST_NETWORK_GATEWAY` — set it for `docker compose up` too — or `TEST_FAKE_OPENAI_BASE_URL`) — the only kind of address both the app (on the host, runs the SSRF policy, refuses loopback) and `litellm-test` (in a container) can reach. Every other test-stack port is published on `127.0.0.1` only. `litellm-test` connects to `litellm_test` as its own role (`litellm_test`, created by `infra/postgres/db-init.sh`), and the app's spend-log paths use that role too (`NUXT_LITELLM_DB_USER`). Its `/_test/requests` endpoint shows which key suffix / model / tools / tool results reached it. See `endpoints/aiProviders.test.ts`. Model **`obedient-chat`** plays a prompt-injected model: it calls `view_document`, then whatever tool a `FAKE_DIRECTIVE <tool> <json>` line in the latest tool result names — `endpoints/aiCrossBoundary.test.ts` uses it to drive the taint + confirm gate, the initiator-only session channel and the `@ai` trigger checks through the real loop. Shared helpers (BYOK user with a real virtual key, fake-provider record, a Hocuspocus client that writes as a given identity): `setup/byok.ts`.

**Why prod build, not `bun run dev`:** dev's WS upgrade handler doesn't reliably wire under Bun + crossws — `/api/ai/dictate` hangs on handshake instead of firing `open`. Prod binds the upgrade handler directly via `crossws/adapters/node`. Tests against the prod bundle also catch prod-only bugs that dev's SSR transform papers over (lib0 conditional exports, missing `traceInclude` deps, `nitro.preset: 'bun'`-specific edges).

Cost: a one-time ~30–60s `bun run build` at the start of the run. The rest is fast.

## Per-test isolation: `resetDb()`

Every test file calls `resetDb()` in `beforeEach`. It TRUNCATEs every app table with `RESTART IDENTITY CASCADE` so user/doc serial ids are predictable across tests:

```ts
beforeEach(async () => {
  await resetDb()
})
```

The truncate list is a hand-maintained allowlist in `tests/integration/setup/db.ts` — every new app table needs to be added there. Why the explicit list rather than `information_schema`-driven discovery: a table that's added but NOT mirrored in `resetDb()` produces non-deterministic test bleed between cases, and an explicit list flags "did we think about test isolation?" on every new schema migration.

`yjs_documents` is special — it's created lazily by y-postgresql at sync-server startup, not by drizzle. `resetDb()` probes `pg_tables` first and only TRUNCATEs if it exists. Without the probe, tests that boot cleanly (no sync server contacted) would 42P01 on a missing table.

**Belt-and-braces guard:** `testDb()` refuses to connect if the DB URL doesn't end in `/${TEST_DB_NAME}`. Test code that accidentally points at dev/prod DB throws on first call rather than truncating the wrong database.

## When to use repos vs integration vs e2e

| Tier | What it covers | What it CAN'T cover | Where it lives |
|---|---|---|---|
| Unit | Pure functions, mocked deps. State-machine logic, validators, helpers. | The wiring between things. | `tests/unit/` |
| Repos | A single repo + a real DB. Drizzle queries, FK cascades, advisory locks. | HTTP, middleware, auth. | `tests/repos/` |
| Integration | Full HTTP/WS stack. Auth, middleware, repos, sweepers, Stripe webhooks. | Browser behaviour, Y.js mutation across two clients. | `tests/integration/` |
| e2e (Flow) | A real browser, real-WS Y.js sync, multi-context flows. | Performance / load. Anything that needs >1 simultaneous test. | `tests/e2e/` |

If a test asserts "the right data lands in the right table" → repos. If it asserts "the right HTTP status comes back from the right URL with the right cookie" → integration. If it asserts "the right thing renders in a real browser" → e2e.

**The integration tier is where most authz lives.** Middleware, central auth guards, role-based access — all the shapes that mock-heavy unit tests miss because the mock IS the test. Don't be afraid to write a 30-line integration test that asserts "X cookie + Y request body + Z URL = 403". They catch regressions that unit tests structurally cannot.

## The GAP-test pattern (Phase 8)

A GAP test is a failing test that documents *expected-but-not-yet-implemented* behaviour. We use it for:

- Stripe webhook out-of-order events that should be stashed in `pending_stripe_events` but aren't yet.
- Audit-log entries we want to write for new event types before the writer lands.
- Race conditions we know exist but haven't fixed yet.

Format: the test is `.skip`-ped or `it.fails`-marked with a `// GAP:` comment explaining the gap, the expected behaviour, and the tracking issue. When the implementation lands, flip the skip and the test passes — no new test needed because it was already written.

Why this beats a TODO comment: it forces the spec to be testable before the code is written. A TODO comment can rot into "I forgot what I meant"; a GAP test can't, because the test body literally is the spec.

Don't use GAP tests as a substitute for actually implementing the behaviour — they're for "we know we want this; it's tracked; here's the contract" not "we'll never get to this." If you find a stale GAP test more than a sprint old, either ship the implementation or close the gap as won't-fix.

## Coverage caveat

`bun run test:coverage` undercounts by a lot — `@vitest/coverage-v8` only measures code that runs *in the vitest process*, but integration tests spawn a separate `bun run dev` (well, `bun .output/server/index.mjs`) subprocess. Every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*` runs there — invisible to coverage.

Three dead ends so we don't try again:
1. Bun doesn't honor `NODE_V8_COVERAGE` (oven-sh/bun#17867).
2. Spawning with `node` + NODE_V8_COVERAGE produces files but Nitro's Vite SSR transform records URLs as `evalmachine.<anonymous>` which c8 can't map.
3. `@nuxt/test-utils/e2e` `setup()` would work but our `nitro.preset: 'bun'` build traces Bun-specific paths and Stripe's ESM entry doesn't resolve under Node's ESM resolver.

**Net: the API-route coverage gap is architectural.** When reviewing coverage numbers, mentally overlay every `server/{api,middleware,plugins,routes}/*` plus orchestrators like `processKnowledge.ts` and `aiClient.ts` as covered by the 300+ integration tests but not visible in the percentage.

## Privacy / abuse / admin tests

Privacy-surface tests (Workstream B) live alongside the rest of the integration suite. Notable shapes:

- `tests/integration/endpoints/abuseReports.test.ts` — 14 HTTP-level tests covering the full lifecycle: rate-limit, missing-body validation, oversized body, free-form `docId` (NOT FK), reporter-IP truncation, audit-row presence, admin-only `GET /api/admin/abuse-reports`, status-PATCH transitions with audit-and-update atomicity. Pin the doc-id-as-text invariant — the original FK exploded on first invalid input.
- `tests/repos/abuseReports.test.ts` — DB-level shape + the `aliasedTable` join shape that the admin endpoint depends on (reporter + actioner are both FKs into `users`; misnaming the alias produces silent column collision in Drizzle's row mapper).
- `tests/unit/legal/registries.test.ts` — uniqueness + cross-registry referential integrity (every `PROCESSING_PURPOSES.subProcessors` ref resolves; no audit-action collisions). Cheap and load-bearing — adds zero runtime overhead and catches every "I added a row but didn't wire the cross-ref" mistake.
- `tests/unit/legal/i18nKeys.test.ts` — pins the 110 i18n keys consumed by privacy + profile-page surfaces. A typo in `t('legal.consent.banner.title')` would otherwise render the literal key string in the UI; this test fails at unit-time instead of waiting for QA.
- `tests/unit/errorSanitizer.test.ts` — 14 tests on the framework-level error policy: 4xx pass through (preserve `message` + `data`), 5xx strip to generic + `code: 'internal'`, stack never appears. Wired against the pure `buildSanitizedErrorPayload(error, url)` export — hits the function directly, not through the Nitro runtime.
- `tests/unit/adminAccess.test.ts` — 14 tests on `isAdminEmail` (env-list parser): case-insensitive on both sides, comma-separated with whitespace + empty-segment tolerance, no module-scope cache (env reads on every call). Drift here silently locks ops out of `/admin/*`.

When you add a privacy / lifecycle endpoint, default to the integration tier — middleware + repo + audit + email-out are exactly what unit-with-mocks misses.

## Gotchas

- **`vi.mock` paths resolve relative to the test file, not the source file.** Use `vi.mock('../../server/utils/database', ...)` from a test in `tests/integration/`. Symptom is opaque: tests "passing" but with phantom assertions because the mock never engaged.
- **Don't share state via module-level `let` between tests.** `resetDb()` truncates rows, not module memory. Use `beforeEach` to reseed any in-memory caches (rate-limit Valkey state, sweep-lock holders, etc.).
- **WS tests must close their clients in `afterEach`.** Leaking sockets across tests will eventually trip the Hocuspocus per-IP connection limit and produce non-deterministic failures.
- **`docker-compose.test.yml` shares the project namespace with `docker-compose.dev.yml`.** Don't `--remove-orphans` in either teardown — it nukes the other.
