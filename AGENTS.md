# markoto: agent guide

markoto is a collaborative markdown editor. A Nuxt 4 app on Bun (SSR, Nitro API, sign-in, MCP server) serves the UI; documents are Y.js CRDTs synced by a separate Hocuspocus container and stored in PostgreSQL (append-only `yjs_updates` log), with pgvector for the workspace knowledge base. Valkey holds rate limits, locks and per-document sync state. Sidecars: a Playwright renderer (PDF/PNG), markitdown (imports), LiteLLM (every AI call), a backup job. Login is optional; anonymous users can edit public documents. Billing is off unless `NUXT_BILLING_ENABLED=true`. The system overview is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); read it before changing anything cross-cutting.

## Commands

| Task | Command |
|---|---|
| First setup (`.env` with generated secrets, all installs) | `make setup` |
| Dev infra (Postgres, Valkey, SeaweedFS, sync, markitdown, renderer, LiteLLM) | `make dev`, then `bun run dev --host 0.0.0.0` (the sync container reaches the app via `host.docker.internal`) |
| Lint | `bun run lint` |
| Type-check app + server | `bun run typecheck` and `bun run typecheck:guard`. Run under Node: never `bun --bun run typecheck` (vue-tsc then skips every `.vue` file and still exits 0). `sync-server/` and `renderer/`: `bun run typecheck:services`. |
| Type-check tests / scripts | `bun run typecheck:tests`, `bun run typecheck:scripts` |
| Unused code and dependencies | `bun run knip` |
| Import layering and cycles | `bun run depcruise` |
| Repo checks | `bun run check:env` (generated env files current), `check:md-paths`, `check:vocab`, `check:em-dash` (no U+2014 anywhere), `check:i18n-unused`, `check:links`, `check:shell`, `check:docker`, `check:py` |
| New migration from `server/db/schema/` | `bun run db:generate` (applied at app boot) |

Tests (details: [`docs/contributing/testing.md`](docs/contributing/testing.md)):

| Tier | Command | Needs |
|---|---|---|
| unit, dom, nuxt | `bun run test` (or `test:unit`, `test:dom`, `test:nuxt`) | nothing |
| repos (DB-backed) | `bun run test:repos` | test stack: `bun run test:integration:up` |
| integration (REST + sync) | `bun run test:integration` | test stack; builds and starts the app itself |
| e2e flows (Playwright, also the user docs) | `bun run flows:test` | Docker; brings up its own stack |
| billing-sandbox (real Stripe test mode) | `bun run test:billing-sandbox` | test stack; `STRIPE_SANDBOX_SECRET_KEY` (skipped without) |

The test stack runs through `scripts/test-compose.sh` (detects rootless Podman). Run the tiers your change touches before you finish.

## Repository map

| Path | Contents |
|---|---|
| `app/` | Vue frontend: `components/`, `composables/<domain>/`, `pages/`, `utils/<domain>/`, `layouts/`, `plugins/`, `middleware/` |
| `server/` | Nitro: `api/`, `routes/` (OAuth, SSO, SCIM, published pages), `middleware/`, `plugins/` (migrations, sweepers, workers), `db/`, `repos/`, `utils/<domain>/`, `mcp/`, `legal/`, `error.ts` |
| `shared/` | Client + server code: `config/`, `contracts/`, `types/`, `utils/<domain>/`, `templates/`, `audiences/`, `languages/`, `legal/`. Workspace package `@markoto/shared` (TypeScript source, imported by path) |
| `sync-server/` | Hocuspocus container (workspace package) |
| `renderer/`, `markitdown-server/`, `backup-server/` | Sidecars |
| `modules/` | Nuxt modules (copies vendored browser assets to `/vendor/`) |
| `drizzle/` | Generated migrations + snapshots |
| `content/` | User docs (`/docs`), legal texts, marketing pages |
| `i18n/locales/` | UI strings (en is the source) |
| `deploy/` | `compose/` (every stack: `compose.dev.yml`, `compose.prod.yml`, …), `config/` (what they mount: LiteLLM, Postgres, Traefik, SeaweedFS, the renderer's seccomp profile) |
| `infra/` | Ansible, hosted `.env` rendering (`render-env.sh`, both deploy paths) |
| `scripts/` | Standalone Bun scripts and repo checks |
| `tests/` | `unit/<domain>/`, `dom/`, `nuxt/`, `repos/`, `integration/`, `e2e/` |
| `docs/` | Architecture, self-hosting, AI models, hardening, `contributing/`, `reference/` |

## Rules an agent gets wrong

Runtime and build
- Configuration: every environment variable is declared once in `shared/env/vars/` (then `bun run env:gen`); read it with `useEnv()` / `syncEnv()` / the renderer's `env`, never `process.env` (ESLint `markoto/no-raw-env`). Invalid values fail boot. Guide: `docs/contributing/configuration.md`.
- Logging: backend code logs through `useLogger('component')` (JSON lines in production, `LOG_LEVEL`, built-in redaction of tokens / emails / URL queries / bodies), never `console.*` (ESLint `no-console`). Guide: `docs/contributing/logging.md`.
- `nitro.preset` stays `bun`: lib0 and others ship Bun conditional exports that the `node-server` preset traces wrongly.
- `server/runtime/bunEntry.ts` is a copy of nitropack's bun preset entry. When `tests/unit/platform/bunEntryUpstream.test.ts` fails, re-derive the file from the new upstream entry; never just refresh the snapshot.
- OAuth handlers live in `server/routes/auth/`; there is no `server/auth/` route directory.

Database
- Drizzle uses `node-postgres`: no `.get()` / `.all()`; use `(await db.select()...limit(1))[0]`. Raw `tx.execute(sql\`…\`)` returns timestamps as strings.
- drizzle-kit does not emit `CREATE EXTENSION`; hand-prepend it to a generated migration that needs one (see `drizzle/0000_baseline.sql`).
- Enums are `text('col', { enum: [...] })`, not `pgEnum`. Migrations are forward-only.
- Document Y.js state is the `yjs_updates` log (in the schema). Read it only through `server/repos/yjsLog.ts` (app) / `sync-server/src/yjs-store.ts` (sync); never delete its rows by hand (pruning keeps the history floor consistent, `docs/contributing/sync-server.md`).
- The knowledge embedding column's dimension is set at boot (`server/plugins/02-embeddings-dimension.ts`). Do not change `vector(768)` in `server/db/schema/knowledge.ts` and never migrate that column's type.
- Sweepers take `pg_try_advisory_lock` on a dedicated, checked-out client held for the whole sweep (`server/repos/sweepLocks.ts`); the `_xact_` variant releases at commit and is wrong here.

Security
- Never read `X-Forwarded-For` / `X-Real-IP` in an endpoint: use `getClientIp(event)`, and `getClientRateLimitKey(event)` for limits (`server/utils/platform/clientIp.ts`).
- Browser-facing presigned S3 URLs use `usePresignS3Client()`, not `useS3Client()` (SigV4 signs the host the browser sees).
- One authorization helper per concern: `canEditDoc` (content), `canManageDoc` (sharing, delete), `canManageWorkspace` (admin). `workspaces.ownerId` is provenance, never authorization.
- Never return `passwordHash`; project columns explicitly on public endpoints.
- Never sign a usable document JWT for a forbidden or password-gated document: return `token: null`.
- Every route declares who may call it: `defineApiHandler({ access: allow.*(), … })` (`server/utils/api/`, guide: `docs/contributing/api-handlers.md`). The only raw handler is the dictation WebSocket (`tests/unit/platform/apiRoutes.exceptions.ts`); never add to that list without a reason the wrapper can't express.
- A route reachable without a session (a sessionless `allow.*` policy) needs an entry in `server/utils/auth/publicRoutes.ts` with a comment saying why; the middleware requires a session for every other `/api` route, and `tests/unit/platform/apiRoutes.test.ts` keeps the two in step.
- Internal routes (`/api/internal/**`, sync `/internal/**`, render routes) are reached container-to-container only; requests carrying edge-proxy forwarding headers get 404.

Frontend
- No hard-coded user-facing strings: add keys to `i18n/locales/en.json` and use `t()`.
- `useColorMode()` at template top level causes a hydration mismatch: defer to `onMounted`, use `<ClientOnly>`, or render both variants and toggle with CSS.
- `data-testid` on `UModal` (and on `UDropdownMenu` item configs) never reaches the DOM: put it on an element inside the slot.
- Logout is a hard reload (`useLogout`, `location.href = '/'`), never `navigateTo()`.

AI
- An AI tool declaration's schema field is `parameters`, not `parametersJsonSchema` (written by `server/utils/ai/tools/toolDefinition.ts`; pinned by `tests/unit/ai/aiToolSchemas.test.ts`).
- Adding processing of personal data requires an entry in `server/legal/lawfulBasis.ts` (see `server/legal/AGENTS.md`).

Infrastructure
- One Bun workspace (root app, `shared`, `sync-server`, `renderer`), one `bun.lock`, hoisted `node_modules` (`bunfig.toml`). Add a dependency to the package that imports it; `shared/package.json` must list what `shared/` imports, or the sync / renderer image fails at start (they install with `--filter`).
- Compose files live in `deploy/compose/` and `include:` `compose.base.yml` (Compose ≥ 5 required). Compose reads `.env` from the compose file's directory: by hand, pass `--env-file .env` (make targets and `scripts/test-compose.sh` do). The app's plain passthrough env in `compose.prod.yml` / `compose.selfhost.yml` is generated between `# BEGIN env:gen` markers (`bun run env:gen`); hand-write only values that are not a plain `${NAME}`. An override of an included service replaces `command:` (and other scalars and plain lists); `environment:` merges per key, `volumes:` per target, `depends_on:`, `networks:` and `ports:` add to the base entries (Compose 5.7). To drop inherited entries, use `!override` / `!reset`. An included file is interpolated on its own, so its `${VAR:?}` must be satisfiable. There is no way to drop an included service, so env-specific services (SeaweedFS) are defined per env.
- LiteLLM fails at startup on an `os.environ/VAR` in `deploy/config/litellm/config.yaml` that is undefined: give each a compose default. It reads the config once; deploy paths export `LITELLM_CONFIG_HASH` so a changed config recreates the container. A new deploy path must too.

Tests
- `vi.mock` paths resolve relative to the test file, not the source file.
- Tests set configuration with `vi.stubEnv` / `stubEnv()` (`tests/helpers/env.ts`) in `beforeEach`, never by mocking `useRuntimeConfig`; stubs are undone before every test.
- The sync server debounces stores for 2 s: tests that need distinct activity rows must wait out the debounce window between edits.
- Rate limits are bypassed in test mode; `TEST_ENFORCE_RATE_LIMITS` turns chosen namespaces back on.

## Conventions

- Comments say why, not what. No milestone or ticket labels, no history ("previously…"); the lint rule `markoto/no-milestone-vocabulary` and `check:vocab` flag them.
- Errors: `throw apiError('area/reason', params)`. Every code is registered in `shared/api/errors/<area>.ts` (status + params) with its text in all six `i18n/locales/errors/<locale>.json`; the client translates it by code. 4xx pass through with `data.code`; 5xx are replaced by a generic message (`server/error.ts`).
- New database access goes in `server/repos/`; endpoints and utils call repos (`bun run depcruise` reports the files that still query directly).
- Put new server helpers in the matching `server/utils/<domain>/` folder (auto-imported recursively).
- Keep this file and nested `AGENTS.md` files to rules that are not derivable from the code (budgets in `tests/unit/repoHygiene/agentsMd.test.ts`). Human documentation goes to `docs/`.

## Index

Nested agent guides (read the one for the folder you work in):

| File | Scope |
|---|---|
| `app/AGENTS.md` | Frontend conventions |
| `app/utils/AGENTS.md` | Markdown rendering and preview |
| `app/composables/AGENTS.md` | Document composables |
| `app/components/collab/AGENTS.md` | Activity log UI |
| `app/components/document/AGENTS.md` | Document context fields |
| `app/components/legal/AGENTS.md` | Privacy surfaces |
| `server/AGENTS.md` | Auth, access control, middleware, sweepers |
| `server/db/AGENTS.md` | Schema and migrations |
| `server/repos/AGENTS.md` | Repository layer |
| `server/utils/AGENTS.md` | Server utilities |
| `server/utils/agentic/AGENTS.md` | AI agentic loop and tools |
| `server/utils/sso/AGENTS.md` | Workspace single sign-on |
| `server/mcp/AGENTS.md` | MCP server |
| `server/legal/AGENTS.md` | Privacy and legal registries |
| `sync-server/AGENTS.md` | Hocuspocus server |
| `shared/templates/AGENTS.md` | Document templates |
| `tests/e2e/AGENTS.md` | Playwright flows |
| `tests/integration/AGENTS.md` | Integration tests |

Docs (humans first, but read the relevant one before a larger change):

| Doc | Topic |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System overview, security model, data stores, design decisions |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, checks, coding rules, PR conventions |
| [`docs/contributing/`](docs/contributing/) | `testing`, `logging`, `flow-docs`, `server`, `api-handlers`, `database`, `billing`, `knowledge-base`, `ai-tools`, `mcp`, `privacy-registries`, `sync-server`, `activity-log`, `preview-pipeline`, `design-system`, `templates`, `marketing-site`, `admin-metrics` (admin product stats), `TEMPLATE-WORKFLOW` (design templates), `LOCAL`, `CONTAINER-ENGINES`, `CHEATSHEET` |
| [`docs/reference/rate-limits.md`](docs/reference/rate-limits.md) | Request limits with their source files |
| [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) | Install, configuration reference, upgrades, backups |
| [`docs/AI-MODELS.md`](docs/AI-MODELS.md), [`docs/SECURITY-HARDENING.md`](docs/SECURITY-HARDENING.md), [`docs/S3-SETUP.md`](docs/S3-SETUP.md) | AI models, hardening, external S3 |
