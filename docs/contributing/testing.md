# Testing

markoto has six test tiers. Five run under Vitest (`vitest.config.ts` defines one Vitest project per tier); the browser flows run under Playwright.

| Tier | Location | Runs in | Needs | Command |
|---|---|---|---|---|
| unit | `tests/unit/` | Node | nothing | `bun run test:unit` |
| dom | `tests/dom/` | happy-dom | nothing | `bun run test:dom` |
| nuxt | `tests/nuxt/` | full Nuxt environment (`@nuxt/test-utils`) | nothing | `bun run test:nuxt` |
| repos | `tests/repos/` | Node, serial | test Postgres + Valkey | `bun run test:repos` |
| integration | `tests/integration/` | Node, serial, against a production build | full test stack | `bun run test:integration` |
| e2e flows | `tests/e2e/flows/` | Playwright (Chromium) | full test stack (started for you) | `bun run flows:test` |

`bun run test` runs unit + dom + nuxt (no Docker needed). `bun run test:all` runs every Vitest project. `make test` runs lint, typecheck, unit, dom and repos; `make test-all` adds integration and flows.

## Choosing a tier

- **unit**: pure functions, validators, state machines, helpers with mocked dependencies. Sub-second feedback.
- **dom**: utilities that need a DOM but not Nuxt (for example DOMPurify on rendered Markdown). A file that needs jsdom instead of happy-dom switches with a `// @vitest-environment jsdom` comment (for example `tests/dom/documentStructure.test.ts`).
- **nuxt**: composables and components that need auto-imports, `mockNuxtImport`, `registerEndpoint` or `mountSuspended`. Heavier boot; do not use it for pure functions.
- **repos**: one repository module against a real database: Drizzle queries, foreign-key cascades, advisory locks. No HTTP.
- **integration**: the full HTTP and WebSocket stack: authentication, middleware, access control, sweepers, Stripe webhooks, MCP, sync. Most access-control tests belong here, because a unit test with mocks cannot catch a missing guard.
- **e2e flows**: real browser behaviour, two-browser collaboration, and the end-user documentation (see [flow-docs.md](flow-docs.md)).

Rule of thumb: "the right rows land in the right table" is a repos test; "this request with this cookie gets this status" is an integration test; "the user sees this" is a flow.

## The test stack

`docker-compose.test.yml` holds the infrastructure for repos, integration and flow tests. It runs next to the dev stack: ports are shifted (Postgres 5433, Valkey 6380, SeaweedFS 8334, sync 4002, markitdown 8081, LiteLLM 4100, stripe-mock 12111, renderer 9101, fake OpenAI provider 4120, OIDC provider 4130, Traefik TLS 8443, DNS test server 8053/8055) and every port is published on `127.0.0.1` only. Storage is disposable.

Always drive it through `scripts/test-compose.sh`, which adds `docker-compose.test.podman.yml` on rootless Podman (see [CONTAINER-ENGINES.md](CONTAINER-ENGINES.md)):

```bash
bun run test:integration:up      # start and wait for health checks
bun run test:repos
bun run test:integration
bun run test:integration:down    # stop and delete volumes
```

`bun run flows:up` / `flows:down` do the same with `--profile flows`. Never pass `--remove-orphans` to a teardown: the test and dev compose files share a project namespace, and the flag removes the other stack's containers.

Notable services:

- `fake-openai-test` (`tests/fixtures/fake-openai/server.py`) is a fake OpenAI-compatible provider for bring-your-own-key tests. The app (on the host) and `litellm-test` (in a container) both have to reach it at one non-loopback address, so the stack's network has the fixed subnet `10.213.47.0/24` and the service is also published on the gateway `10.213.47.1`. Override with `TEST_NETWORK_SUBNET` / `TEST_NETWORK_GATEWAY` (set them for `up` as well) or `TEST_FAKE_OPENAI_BASE_URL`. Its `/_test/requests` endpoint shows what reached it. The model `obedient-chat` calls whatever tool a `FAKE_DIRECTIVE <tool> <json>` line in the latest tool result names, to simulate a prompt-injected model.
- `litellm-test` uses its own database role, created by `infra/postgres/db-init.sh`.
- `challtestsrv-test`, `pebble-test` and `traefik-test` (Let's Encrypt's DNS test server and test CA, plus a Traefik that polls the app for custom domains) back the custom-domain tests in `tests/integration/endpoints/customDomains.test.ts`.
- `oidc-test` is an OpenID Connect provider for the generic OIDC and workspace single sign-on tests.

## Repos tests

`tests/repos/setup/globalSetup.ts` waits for the test Postgres, applies the test environment (`tests/integration/setup/testEnv.ts`), and runs the Drizzle migrations. No app server is started. Files run serially and share the database.

## Integration tests

`tests/integration/setup/globalSetup.ts` builds the app (`bun run build`; set `INTEGRATION_SKIP_BUILD=1` to reuse an existing `.output/`) and `tests/integration/setup/server.ts` starts two servers from that build:

| Server | Port | Shape |
|---|---|---|
| primary (`TEST_BASE_URL`) | 3101 | billing on (stripe-mock), self-hosted AI shape: `NUXT_AI_DEFAULT_*` set to the bundled LiteLLM aliases, any BYOK URL, private URLs allowed |
| billing-off twin (`TEST_BILLING_OFF_BASE_URL`) | 3102 | billing off, paid plans "coming soon", every `NUXT_STRIPE_*` and `NUXT_AI_DEFAULT_*` removed, the recommended BYOK allowlist, no private URLs; enforces the MCP and anonymous rate limits despite test mode |

Both wait up to 90 s for `/api/health` and share the test Postgres and Valkey. Talk to the twin with `anonClient(TEST_BILLING_OFF_BASE_URL)` or `loggedInClient(id, name, TEST_BILLING_OFF_BASE_URL)` (see `tests/integration/endpoints/billingOff.test.ts`). Ports and credentials live in `tests/integration/setup/env.ts`; BYOK helpers in `tests/integration/setup/byok.ts`.

The tests use a production build because the dev server does not wire WebSocket upgrades reliably under Bun, and because a production bundle catches build-only problems.

Isolation: call `resetDb()` (`tests/integration/setup/db.ts`) in `beforeEach`. It truncates an explicit list of tables with `RESTART IDENTITY CASCADE`, so ids are predictable; add every new table to that list. `yjs_documents` is created by the sync server at startup, so `resetDb()` truncates it only if it exists. `testDb()` refuses any database URL whose name is not the test database.

## Flows

See [flow-docs.md](flow-docs.md). `bun run flows:test` starts the test stack itself, builds, serves on port 3001 and tears down afterwards.

## Smoke tests

`tests/smoke/` (`playwright.smoke.config.ts`, `bun run smoke`) runs against a deployed instance, by default `https://staging.markoto.app`; set `PLAYWRIGHT_BASE_URL` for another. `staging-gate.yml` runs it after each staging deploy.

## Coverage

`bun run test:coverage` measures only code that runs inside the Vitest process. Integration tests exercise `server/api`, `server/middleware`, `server/plugins` and `server/routes` in a separate server process, so `vitest.config.ts` excludes those directories from the report rather than counting them as zero. Bun does not support `NODE_V8_COVERAGE`, so that gap cannot currently be closed.

## In CI

The pull-request gate (`.github/workflows/ci.yml`) runs unit and dom tests, then unit + dom + nuxt + repos with coverage (`test:coverage:fast`), then the integration tests. Flows run only in `release.yml`, for `release:*`-labelled merges.
