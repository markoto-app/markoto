# Integration tests — agent rules

REST + WebSocket tests against a production build of the app, backed by the real test stack. How the tiers, the stack and the two test servers work: [`docs/contributing/testing.md`](../../docs/contributing/testing.md).

## Running

- `bun run test:integration` does not start Docker. Start the stack first with `bun run test:integration:up` (always through `scripts/test-compose.sh`, never a bare `docker compose`), stop it with `bun run test:integration:down`.
- Never add `--remove-orphans` to a test-stack teardown: the test and dev compose files share a project namespace and the flag removes the other stack.
- `INTEGRATION_SKIP_BUILD=1` reuses `.output/`; only set it when the build is current, or you test stale code.

## Writing tests

- Call `resetDb()` in `beforeEach`. When you add a table to `server/db/schema.ts`, add it to the truncate list in `tests/integration/setup/db.ts`; the list is explicit on purpose, a missing table leaks state between tests.
- `resetDb()` clears rows, not module memory or Valkey. Don't share state through module-level `let`; reseed in-memory and Valkey state in `beforeEach`.
- Close every WebSocket / Hocuspocus client in `afterEach`. Leaked sockets hit the sync server's per-IP connection limit and cause random failures.
- `vi.mock` paths resolve relative to the test file, not the source file. A wrong path silently mocks nothing.
- The primary server (port 3101) has billing on and the self-hosted AI shape. Billing-off, hosted-SaaS behaviour and enforced MCP / anonymous rate limits need the twin: `anonClient(TEST_BILLING_OFF_BASE_URL)` / `loggedInClient(id, name, TEST_BILLING_OFF_BASE_URL)` / `new McpClient({ baseUrl: TEST_BILLING_OFF_BASE_URL })`.
- BYOK tests point providers at `fakeOpenAiBaseUrl()` (`setup/env.ts`), never at `127.0.0.1`: the SSRF policy refuses loopback. Use the helpers in `setup/byok.ts`.
- Custom-domain tests: use a fresh hostname per test; the DNS test server keeps its records across `resetDb()`. Its `/add-a` appends, so call `/clear-a` first to replace a record.
- Default to this tier for access control, middleware and privacy / lifecycle endpoints: a unit test with mocks cannot catch a missing guard.
