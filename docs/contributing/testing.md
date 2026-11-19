# Testing

markoto has seven test tiers plus a manual benchmark project. Six tiers run under Vitest (`vitest.config.ts` defines one Vitest project per tier); the browser flows run under Playwright.

| Tier | Location | Runs in | Needs | Command |
|---|---|---|---|---|
| unit | `tests/unit/` | Node | nothing | `bun run test:unit` |
| dom | `tests/dom/` | happy-dom | nothing | `bun run test:dom` |
| nuxt | `tests/nuxt/` | full Nuxt environment (`@nuxt/test-utils`) | nothing | `bun run test:nuxt` |
| repos | `tests/repos/` | Node, serial | test Postgres + Valkey | `bun run test:repos` |
| integration | `tests/integration/` | Node, serial, against a production build | full test stack | `bun run test:integration` |
| e2e flows | `tests/e2e/flows/` | Playwright (Chromium) | full test stack (started for you) | `bun run flows:test` |
| bench | `tests/bench/` | Node, offline AI benchmarks, manual only | `AI_BENCH=1` and provider keys | `bun run bench:ai` |
| billing-sandbox | `tests/billing-sandbox/` | Node, against a production build and Stripe's test-mode API | test Postgres + Valkey + LiteLLM, `STRIPE_SANDBOX_SECRET_KEY` | `bun run test:billing-sandbox` |

`bun run test` runs unit + dom + nuxt (no Docker needed). `bun run test:all` runs every Vitest project; the billing-sandbox project reports its tests as skipped unless `STRIPE_SANDBOX_SECRET_KEY` is set. `make test` runs lint, typecheck, unit, dom and repos; `make test-all` adds integration and flows.

## Choosing a tier

- **unit**: pure functions, validators, state machines, helpers with mocked dependencies. Sub-second feedback.
- **dom**: utilities that need a DOM but not Nuxt (for example DOMPurify on rendered Markdown). A file that needs jsdom instead of happy-dom switches with a `// @vitest-environment jsdom` comment (for example `tests/dom/documentStructure.test.ts`).
- **nuxt**: composables and components that need auto-imports, `mockNuxtImport`, `registerEndpoint` or `mountSuspended`. Heavier boot; do not use it for pure functions.
- **repos**: one repository module against a real database: Drizzle queries, foreign-key cascades, advisory locks. No HTTP.
- **integration**: the full HTTP and WebSocket stack: authentication, middleware, access control, sweepers, Stripe webhooks, MCP, sync. Most access-control tests belong here, because a unit test with mocks cannot catch a missing guard.
- **e2e flows**: real browser behaviour, two-browser collaboration, and the end-user documentation (see [flow-docs.md](flow-docs.md)).
- **billing-sandbox**: what the app shows after a real Stripe subscription changed: purchases, plan and seat changes, renewals, failed payments, cancellations over time. Only for behaviour that depends on what Stripe really does; a rule about our own code belongs in a unit test (`tests/unit/billing/subscriptionTransitions.test.ts` is the table of every change request).

Rule of thumb: "the right rows land in the right table" is a repos test; "this request with this cookie gets this status" is an integration test; "the user sees this" is a flow.

## Configuration in tests

Code reads its configuration through the typed env (`shared/env`, [configuration.md](configuration.md)). Under Vitest the runtime accessors (`useEnv()`, `syncEnv()`) parse `process.env` on every call, so a test sets configuration the way an operator does, by variable name:

```ts
import { stubEnv } from '../../helpers/env'

beforeEach(() => {
  stubEnv({ NUXT_LITELLM_URL: 'http://litellm:4000', NUXT_LITELLM_MASTER_KEY: 'sk-test' })
})

it('…', () => {
  stubEnv({ NUXT_LITELLM_MASTER_KEY: undefined }) // unset for this test
})
```

`unstubEnvs` in `vitest.config.ts` undoes every `vi.stubEnv` before the next test, so stub in `beforeEach` (or in the test), not in `beforeAll` or at module level. Don't mock `useRuntimeConfig` for server configuration; it only carries the session, OAuth and public keys. Values are parsed like at boot: a secret shorter than 32 characters or a malformed number throws, so use realistic values. Helpers that take an env-shaped record (`resolveInstanceConfig({...})`, `resolveTiersFromEnv({...})`) get the record directly. Boot validation itself is tested through `bootProblems()` in `tests/unit/env/fixtures.ts`.

## The test stack

`deploy/compose/compose.test.yml` holds the infrastructure for repos, integration and flow tests. It runs next to the dev stack: ports are shifted (Postgres 5433, Valkey 6380, SeaweedFS 8334, sync 4002, markitdown 8081, LiteLLM 4100, stripe-mock 12111, renderer 9101, fake OpenAI provider 4120, OIDC provider 4130, Traefik TLS 8443, DNS test server 8053/8055) and every port is published on `127.0.0.1` only. Storage is disposable.

Always drive it through `scripts/test-compose.sh`, which adds `deploy/compose/compose.test.podman.yml` on rootless Podman (see [CONTAINER-ENGINES.md](CONTAINER-ENGINES.md)):

```bash
bun run test:integration:up      # start and wait for health checks
bun run test:repos
bun run test:integration
bun run test:integration:down    # stop and delete volumes
```

`bun run flows:up` / `flows:down` do the same with `--profile flows`. Never pass `--remove-orphans` to a teardown: the test and dev compose files share a project namespace, and the flag removes the other stack's containers.

Notable services:

- `fake-openai-test` (`tests/fixtures/fake-openai/server.py`) is a fake OpenAI-compatible provider for bring-your-own-key tests. The app (on the host) and `litellm-test` (in a container) both have to reach it at one non-loopback address, so the stack's network has the fixed subnet `10.213.47.0/24` and the service is also published on the gateway `10.213.47.1`. Override with `TEST_NETWORK_SUBNET` / `TEST_NETWORK_GATEWAY` (set them for `up` as well) or `TEST_FAKE_OPENAI_BASE_URL`. Its `/_test/requests` endpoint shows what reached it. The model `obedient-chat` calls whatever tool a `FAKE_DIRECTIVE <tool> <json>` line in the latest tool result names, to simulate a prompt-injected model.
- `litellm-test` uses its own database role, created by `deploy/config/postgres/db-init.sh`.
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

Isolation: call `resetDb()` (`tests/integration/setup/db.ts`) in `beforeEach`. It truncates an explicit list of tables with `RESTART IDENTITY CASCADE`, so ids are predictable; add every new table to that list. `yjs_updates` is in that list too; `insertYjsUpdate` / `readYjsRows` in the same file write and read Y.js rows. `testDb()` refuses any database URL whose name is not the test database.

## Billing sandbox

The integration tier's Stripe is `stripe-mock`: canned objects, no state, webhooks replayed from fixture files. It cannot show that a plan switch kept the billing period, or what a subscription looks like a month later. `tests/billing-sandbox/` runs the same production build against Stripe's real test-mode API.

```bash
bun run test:integration:up                      # or only: scripts/test-compose.sh up -d --wait postgres-test valkey-test litellm-test
export STRIPE_SANDBOX_SECRET_KEY=sk_test_...     # a TEST-mode key of an account that has the price catalogue
bun run test:billing-sandbox                     # about two minutes
```

Without the variable every test of the tier is reported as skipped. A key that does not start with `sk_test_` or `rk_test_` is refused before anything runs. The account needs the catalogue the app looks up: prices with the lookup keys `markoto_<pro|team|business>_<month|year>_<eur|chf>` and `markoto_topup_<10|25|50>_<eur|chf>`.

How it works (`tests/billing-sandbox/setup/`):

- **One server.** `globalSetup.ts` starts one app server on port 3103 from the integration tier's build (`primaryServerEnv` in `tests/integration/setup/server.ts` takes the Stripe target: stripe-mock for the integration tier, the real API here), with the real `litellm-test` proxy instead of the LiteLLM stub. The tier never truncates the database: each file works on users, workspaces and Stripe customers it created, so the files run in parallel. Do not run it while the integration tier runs (that one truncates).
- **Purchases without a browser.** The app's own checkout endpoint opens the Checkout Session, which the test asserts (mode, price, quantity, `client_reference_id`, metadata). Stripe has no API to complete a Checkout Session, so the test then does what the hosted page would do: a customer with a test card (`pm_card_visa`, `pm_card_chargeCustomerFail`), and the subscription or payment for the session's price (`setup/flows.ts`). The same holds for the customer portal: its "Cancel plan" is `cancel_at_period_end` set by API.
- **Real webhooks.** Stripe cannot reach a local server. After each operation the test reads the events Stripe produced for its customer from the Events API (`EventFeed` in `setup/stripe.ts`) and POSTs each one to `/api/webhooks/stripe` with a valid signature. One event is built by hand: `checkout.session.completed`, from the real session object, because no API can cause the real one.
- **Time.** Customers live on a Stripe test clock; the test advances it (a renewal, the end of a cancelled period, the retry schedule of a failed payment), waits until the clock is ready and delivers what Stripe produced. The app's own clock does not move: AI credit expiry is checked by calling `runCreditSettlement` with a later "now".
- **API version.** The Events API renders an event in the account's default API version, whatever version the request names. The deployed webhook endpoint is pinned to `STRIPE_API_VERSION` and receives that rendering instead. The events here are therefore real but possibly in a newer shape; the handlers read the version-dependent fields from both places (`stripeEvents/stripeObjects.ts`). The acacia shape stays covered by the fixtures of the unit and integration tiers.
- **Clean-up.** Every object carries the metadata `markoto_test_run=<run id>` (test clocks: the name prefix `markoto-test-run`). Each file deletes its clocks and customers, the global teardown deletes whatever is left of the run, and the next run removes tagged objects older than three hours that a killed run left behind. Nothing without the tag is touched: the sandbox is shared with the staging server, whose webhook endpoint also receives these events and ignores customers it does not know.

Writing a scenario: assert what the app reports through its own endpoints (`/api/user/billing`, `/api/ai/credits`, `/api/workspaces/:wsId/billing`), once right after the app's own call and before any webhook is delivered, and again after the events. When a scenario exposes a bug that is not fixed in the same change, keep it as `it.fails` with a comment that names the bug.

## Flows

See [flow-docs.md](flow-docs.md). `bun run flows:test` starts the test stack itself, builds, serves on port 3001 and tears down afterwards.

## Smoke tests

`tests/smoke/` (`tests/smoke/playwright.config.ts`, `bun run smoke`) runs against a deployed instance, against the instance named by `PLAYWRIGHT_BASE_URL` (the hosted project's staging host by default). If the target sits behind a basic-auth login at the edge, set `EDGE_BASIC_AUTH_USER` and `EDGE_BASIC_AUTH_PASSWORD`. `staging-gate.yml` runs it after each staging deploy.

## Coverage

`bun run test:coverage` measures only code that runs inside the Vitest process. Integration tests exercise `server/api`, `server/middleware`, `server/plugins` and `server/routes` in a separate server process, so `vitest.config.ts` excludes those directories from the report rather than counting them as zero. Bun does not support `NODE_V8_COVERAGE`, so that gap cannot currently be closed.

SonarCloud reads the same lcov. It counts every source file that is missing from the report as 0 % covered, so `sonar.coverage.exclusions` in `sonar-project.properties` mirrors the Vitest coverage scope: a directory added to or removed from `coverage.include` / `coverage.exclude` in `vitest.config.ts` needs the matching change there. The pull-request gate asks for 80 % coverage on new code; a change to code that only the integration tier reaches (for example a request schema in `shared/api/`) needs a unit test to pass it. Shell, YAML, Dockerfiles and Ansible carry no coverage metric and never count.

## In CI

The pull-request gate (`.github/workflows/ci.yml`) runs unit and dom tests, then unit + dom + nuxt + repos with coverage (`test:coverage:fast`), then the integration tests. Flows run only in `release.yml`, for `release:*`-labelled merges. The `billing-sandbox` job runs the billing-sandbox tier when a pull request changes billing code; it is not a required check, needs the repository secret `STRIPE_SANDBOX_SECRET_KEY` and skips itself (green, with a notice) where the secret is not available, as on forks.
