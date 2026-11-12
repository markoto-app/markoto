# Contributing to markoto

Thanks for your interest in markoto. This guide covers the development setup, the tests and checks, the coding rules and the pull-request conventions CI enforces. Topic guides (testing, flow docs, design templates, container engines, the local full stack) live in [`docs/contributing/`](./docs/contributing/).

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Where things live](#where-things-live)
- [Tests](#tests)
- [Checks](#checks)
- [Coding rules](#coding-rules)
- [Pull requests](#pull-requests)
- [Database migrations](#database-migrations)
- [Documentation](#documentation)
- [License and contributor agreement](#license-and-contributor-agreement)
- [Security issues](#security-issues)

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or propose a feature** with an [issue](https://github.com/joelbarmettlerUZH/markoto.app/issues/new/choose). For a larger change, open an issue or discussion before writing code so we can agree on the approach.
- **Ask a question** in [GitHub Discussions](https://github.com/joelbarmettlerUZH/markoto.app/discussions) rather than an issue.
- **Improve the docs**: user guides live in `content/docs/`, self-hosting in [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md). Typo and clarity fixes are welcome without prior discussion.
- **Send a pull request.** Small, focused changes are reviewed fastest.

## Development setup

| Tool | Version | Why |
|---|---|---|
| [Bun](https://bun.sh) | **1.4 or newer** | Runtime and package manager. The lockfile format needs Bun 1.4+ (`bun --version`). |
| Docker or rootless Podman, with Docker Compose | **5.0 or newer** | Postgres, Valkey, S3 (SeaweedFS), LiteLLM, the sync server and the sidecars. The compose files redefine services they `include:`, which Compose 2.x rejects (`docker compose version`). Podman needs a few `.env` lines and an overlay file: [docs/contributing/CONTAINER-ENGINES.md](./docs/contributing/CONTAINER-ENGINES.md). |
| Node.js | 22 | The type check runs `vue-tsc` under Node (see [Checks](#checks)). |
| `make` and `openssl` | any | `make` for the shortcuts (every target wraps a documented command); `openssl` generates the local secrets. |

No external accounts or API keys are needed to run the app.

```sh
make setup      # first run only, see below
make dev        # infra containers: Postgres (pgvector), Valkey, SeaweedFS, LiteLLM, sync, markitdown, renderer
make dev-app    # the Nuxt app on the host with hot reload (bun run dev --host 0.0.0.0)
```

`make setup` runs `scripts/setup-env.sh`, then one `bun install` at the repository root. The repository is a Bun workspace with one lockfile (`bun.lock`): the app at the root, `shared/` (`@markoto/shared`, TypeScript source imported by the app, the sync server and the renderer), `sync-server/` and `renderer/`; dependencies are hoisted into the root `node_modules` (`bunfig.toml`). Add a dependency to the package that imports it: `bun add <pkg> --cwd sync-server`. The script copies `.env.example` to `.env` and fills the secrets the stack refuses to start without (session, JWT, internal API, ALTCHA and LiteLLM keys) with random values. It is idempotent: an existing `.env` is kept and secrets that already have a value are never changed. The Postgres, Valkey and S3 values in `.env.example` are throwaway development credentials that match `deploy/compose/compose.dev.yml`; the dev ports bind to `127.0.0.1` only.

Open the URL Nuxt prints (usually `http://localhost:3000`). Anonymous editing works without further configuration; to test sign-in or AI, add the OAuth and provider keys to `.env` (see the comments in [`.env.example`](./.env.example) and [`docs/AI-MODELS.md`](./docs/AI-MODELS.md)). The host app must listen on `0.0.0.0` so the sync container can reach it through `host.docker.internal`.

| Goal | Command |
|---|---|
| Stop dev infra / wipe its volumes | `make dev-down` / `make dev-clean` |
| Tail infra logs | `make dev-logs` |
| Everything `make` offers | `make help` |
| Full-stack local run with TLS (to check Traefik or compose changes) | [`docs/contributing/LOCAL.md`](./docs/contributing/LOCAL.md) |
| Flat command reference | [`docs/contributing/CHEATSHEET.md`](./docs/contributing/CHEATSHEET.md) |

If you change `renderer/` or `sync-server/`, rebuild the container (`docker compose --env-file .env -f deploy/compose/compose.dev.yml up -d --build renderer`); `restart` does not rebuild. The compose files live in `deploy/compose/`; Compose looks for `.env` next to them, so commands run by hand pass the repository's with `--env-file .env` (`make` targets and `scripts/test-compose.sh` do it for you).

## Where things live

The architecture overview is [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The main directories:

| Path | Contents |
|---|---|
| `app/` | Vue frontend (Nuxt 4): `pages/`, `components/<area>/`, `composables/<domain>/`, `utils/<domain>/` |
| `server/` | Nitro API: `api/` (routes), `repos/` (database access), `db/schema/`, `middleware/`, `plugins/`, `mcp/`, `legal/`, `utils/<domain>/` |
| `shared/` | Code used by client and server: `config/`, `types/`, `templates/`, `utils/<domain>/` |
| `sync-server/`, `renderer/`, `markitdown-server/` | The sync server (Hocuspocus), the PDF renderer (Playwright) and the import service (Python); the first two are workspace packages, each with its own image |
| `tests/` | `unit/<domain>/`, `dom/`, `nuxt/`, `repos/`, `integration/`, `e2e/` |
| `content/docs/` | User documentation, served at `/docs` |
| `infra/` | Ansible for the hosted deployment |

Domain folders group code by feature area. Put new code into the matching one:

- `server/utils/`: `agentic`, `ai`, `aiProviders`, `anonGate`, `auth`, `billing`, `brandKit`, `customDomains`, `designImport`, `documents`, `email`, `knowledge`, `litellm`, `mcp`, `oidc`, `platform`, `privacy`, `publish`, `rendering`, `sso`, `storage`, `workspaces`
- `app/utils/`: `billing`, `collab`, `comments`, `editor`, `markdown`, `marketing`, `platform`, `preview`, `workspace`
- `app/composables/`: `account`, `ai`, `billing`, `comments`, `document`, `marketing`, `platform`, `preview`
- `shared/utils/`: `documents`, `markdown`, `runtime`, `security`, `theme`, `vendor`
- `tests/unit/`: mirrors those areas (`ai`, `billing`, `documents`, `knowledge`, `theme`, `workspaces`, …)

Rules an AI coding agent (or a person) would otherwise get wrong are in `AGENTS.md` at the repository root and in the `AGENTS.md` files next to the code.

## Tests

| Tier | Command | Needs Docker | What it covers |
|---|---|---|---|
| unit | `bun run test:unit` | no | Pure functions in Node, no Nuxt, no database |
| dom | `bun run test:dom` | no | DOM code under happy-dom (some files opt into jsdom) |
| nuxt | `bun run test:nuxt` | no | Composables and components in the Nuxt environment |
| **fast tiers** | `bun run test` | no | unit + dom + nuxt |
| repos | `bun run test:repos` | yes (test stack) | Repositories against a real Postgres |
| integration | `bun run test:integration` | yes (test stack) | REST API and sync server against a running app (several minutes) |
| flows | `bun run flows:test` | yes (starts its own) | Playwright user flows, which double as the user docs; first run: `bunx playwright install chromium` |

`bun run test:integration:up` / `:down` (or `make test-stack-up` / `make test-stack-down`) start and stop the disposable test stack from `deploy/compose/compose.test.yml`. Its ports (Postgres 5433, Valkey 6380, …) do not collide with the dev stack, and the suites refuse to run against any database other than `ypad_test`. Only one person or agent should use the test stack on a machine at a time.

How the tiers are configured, the test-stack details, Podman notes and the rules for writing tests are in [`docs/contributing/testing.md`](./docs/contributing/testing.md). Writing a flow: [`docs/contributing/flow-docs.md`](./docs/contributing/flow-docs.md). You do not regenerate flow screenshots in your pull request; the release pipeline does that.

## Checks

One command runs the fast local gate, no Docker needed:

```sh
bun run check        # or: make check
```

In order: generated env files, Markdown paths, internal vocabulary, schema-vs-migrations drift, `depcruise`, `knip`, ESLint (everything except the type-aware rules), `nuxt typecheck` + the `.vue` guard, `typecheck:tests`, `typecheck:scripts`, sync-server + renderer typechecks and the unit tests. `bun run check:full` (`make check-full`) adds the type-aware lint rules and the checks that need an external tool: shellcheck, hadolint, lychee and `uv` (ruff, pyright).

| Command | What it checks | In CI job |
|---|---|---|
| `bun run lint` | The whole ESLint config (CI truth, about 4 minutes) | `lint-types` |
| `bun run lint:fast` | Everything except the type-aware rules (`no-floating-promises`, ...): seconds | `lint-typecheck` |
| `bun run lint:types` | Only the type-aware rules | covered by `lint` |
| `bun run typecheck`, `typecheck:guard` | `nuxt typecheck` (vue-tsc) over app, server and shared; the guard fails when `.vue` files are silently skipped | `lint-typecheck` |
| `bun run typecheck:tests`, `typecheck:scripts`, `typecheck:services` | Types of `tests/`, `scripts/` + root configs, `sync-server/` + `renderer/` | `lint-typecheck` |
| `bun run knip` | Unused files, exports and dependencies | `repo-checks` |
| `bun run depcruise` | Import-layer rules and cycles (`.dependency-cruiser.cjs`; no import cycle is allowed) | `repo-checks` |
| `bun run db:check-drift` | `server/db/schema/` matches the committed migrations (`bun run db:generate` would create nothing) | `repo-checks` |
| `bun run check:env` | Generated `.env.example`, config reference and renderer env are current (`bun run env:gen`) | `lint-typecheck` |
| `bun run check:vocab`, `check:md-paths`, `check:links` | Internal planning labels, dangling paths, broken relative links and anchors in Markdown | `repo-checks`, `docs-checks` |
| `bun run check:shell`, `check:docker` | shellcheck, hadolint (`.hadolint.yaml`) | `shell-docker-lint` |
| `bun run check:py`, `check:pyright` | ruff (lint + format), pyright (`ruff.toml`, `pyrightconfig.json`) | `python-checks` |
| `bun run check:i18n-unused` | Unused i18n keys (informational) | no |
| `make lint` | ESLint, the type checks incl. `sync-server/` and `renderer/`, ansible-lint, yamllint, actionlint | partly |

Every ESLint rule is an `error`, including the size and complexity limits: `max-lines` (600 per file), `max-lines-per-function` (150) and `sonarjs/cognitive-complexity` (15). When code hits one, split the file or the function. An inline `eslint-disable-next-line` for one of them is reserved for code that is clearer in one piece (a flat dispatch table, a parser) and needs a one-line reason after `--`.

**Run the type check under Node, never with `bun --bun`.** Under the Bun runtime the Vue language plugin of `vue-tsc` does not load, so every `.vue` file drops out of the check and it still exits 0. `bun run typecheck` keeps the script's Node shebang; `typecheck:guard` catches the silent case. ESLint and `depcruise` are the opposite and run under Bun (`bun --bun`).

CI additionally runs a secret scan (gitleaks), actionlint, the migration guard, `scripts/selfhost-check.sh` (shellcheck on `install.sh`, `docker compose config` for every compose combination) and, for ready-for-review pull requests that touch code, the repos and integration tiers. All of these run on fork pull requests too, except SonarCloud. The required checks are listed in [`docs/operations/GITHUB-CONFIG.md`](./docs/operations/GITHUB-CONFIG.md).

## Coding rules

The ones that matter most in review:

- **Don't silence tooling.** No `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, non-null `!` or blanket casts to make a linter, the type checker or SonarCloud pass. Fix the cause. If you believe a rule is wrong for a case, say so in the pull request.
- **No hacky test fixes.** Don't mask flakiness with retries, longer sleeps or looser assertions. Find the real cause in the test or in the code under test.
- **Comments say why**, not what the next line does. No planning labels (milestone or ticket names) in code, comments or docs; `bun run check:vocab` and an ESLint rule flag them.
- **No hard-coded user-facing strings.** Text goes into i18n keys in `i18n/locales/` (`en.json`, `de.json`, `fr.json`, `es.json`, `ja.json`, `zh.json`); add the key to every locale.
- **Errors have a stable, registered code.** Throw `apiError(code, params)` with a namespaced code such as `plan/limit-reached` or `abuse/already-closed`, registered in `shared/api/errors/` with its text in every `i18n/locales/errors/<locale>.json` ([docs/contributing/api-handlers.md](docs/contributing/api-handlers.md)). 4xx payloads reach the client as thrown; 5xx are replaced with a generic message and `code: 'internal'` (`server/error.ts`).
- **Match the surrounding code**: naming, idiom, comment density. TypeScript everywhere, Drizzle for database access (in `server/repos/`), Zod for AI tool schemas.
- **Authorization goes through the central helpers** (`canEditDoc`, `canManageDoc`, `canManageWorkspace`); never read `workspaces.ownerId` for authorization.
- **Never return `passwordHash`**; project columns explicitly on public endpoints.
- **New personal-data processing** needs an entry in `server/legal/lawfulBasis.ts` (and in `server/legal/subProcessors.ts` if a new vendor is involved).
- **New periodic sweepers** acquire `acquireSweepLock(name)` and release it with `releaseSweepLock(name)` in a `finally` (`server/repos/sweepLocks.ts`).
- **Keep EU data residency** in mind when adding a provider; see [`docs/AI-MODELS.md`](./docs/AI-MODELS.md) and the sub-processor registry.

## Pull requests

- **Branch from `main`**, keep the pull request focused, and open it as a draft while it is in progress. The heavy CI jobs skip drafts and docs-only changes.
- **The title must be a conventional commit** with a lower-case subject: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:` or `revert:`, with an optional scope (`fix(sync): close valkey on SIGTERM`). CI rejects anything else.
- **The title and body are the release notes, verbatim.** A merged pull request becomes a GitHub Release when it carries a release label ([`docs/operations/RELEASE-PROCESS.md`](./docs/operations/RELEASE-PROCESS.md)). Write the description for the person reading the release page: what changed, why, how to verify, and anything an operator must do on upgrade. The [pull-request template](./.github/PULL_REQUEST_TEMPLATE.md) has the sections.
- **Maintainers apply the release labels, not contributors.** Releases are opt-in: a maintainer applies `release:patch`, `release:minor` or `release:major` to the pull request that should ship; `release:none` or no label means no release. CI allows at most one `release:*` label.
- Update the docs your change touches: user docs in `content/docs/`, [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md) for new configuration, the relevant topic guide in `docs/contributing/`, and the nearest `AGENTS.md` when a rule changes.
- Link the issue the pull request resolves.

## Database migrations

Migrations are forward-only and applied at app start.

1. Edit the domain file in `server/db/schema/` (enums are `text(..., { enum: [...] })`, not `pgEnum`).
2. Run `bun run db:generate` (or `make db-generate`) and commit both the SQL in `drizzle/` and the `drizzle/meta/` snapshot.
3. An index on a large, populated table needs a hand-edited `CREATE INDEX CONCURRENTLY`; see `server/AGENTS.md`.
4. CI's `migration-guard` job blocks destructive migrations (`bun run db:check-migrations` runs the same check locally). Call out anything that needs an operator action in the pull-request body.

## Documentation

- **User docs** (`content/docs/**`, rendered at `/docs`) are Nuxt Content pages written in the user's voice: no internals, no table names, no hand-made screenshots (pages embed flows). See [`docs/contributing/flow-docs.md`](./docs/contributing/flow-docs.md).
- **Self-hosting** lives in `docs/SELF-HOSTING.md`; every variable and command there must match `install.sh`, `deploy/compose/compose.selfhost.yml` and `.env.example`.
- **Contributor guides** live in `docs/contributing/`.
- **`docs/operations/`** describes how the hosted markoto.app instance is run; it is published for transparency, not required reading.

## License and contributor agreement

markoto is licensed under [FSL-1.1-ALv2](./LICENSE) (source-available; each release converts to Apache-2.0 two years after it ships).

Contributions need a signed Contributor License Agreement (CLA). You keep the copyright in your contribution. The CLA is a licence grant, not an assignment: it grants LatentSpace Labs GmbH, the project owner, the rights needed to distribute your contribution under the project licence (FSL-1.1-ALv2, converting to Apache-2.0) and under other licence terms.

You sign once, through CLA Assistant: the bot comments on your first pull request with a link to the agreement text and a button to sign. Later pull requests need nothing more, and the check turns green once you have signed.

## Security issues

Never open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
