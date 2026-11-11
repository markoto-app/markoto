# Contributing to markoto

Thanks for your interest in markoto. This guide covers how to set up a development environment, how the test suites work, and the conventions CI enforces. Reading it first saves a review round-trip.

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Repository map](#repository-map)
- [Tests](#tests)
- [Flow tests, docs screenshots and the demo](#flow-tests-docs-screenshots-and-the-demo)
- [Coding rules](#coding-rules)
- [Pull requests](#pull-requests)
- [Database migrations](#database-migrations)
- [Documentation](#documentation)
- [License and contributor agreement](#license-and-contributor-agreement)
- [Security issues](#security-issues)

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or propose a feature** with an [issue](https://github.com/joelbarmettlerUZH/markoto.app/issues/new/choose). For a larger change, open an issue (or discussion) before writing code so we can agree on the approach first.
- **Ask a question** in GitHub Discussions rather than an issue.
- **Improve the docs**: user guides live in `content/docs/`, self-hosting in [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md). Typos and clarity fixes are welcome without prior discussion.
- **Send a pull request.** Small, focused changes are reviewed fastest.

## Development setup

Prerequisites:

| Tool | Version | Why |
|---|---|---|
| [Bun](https://bun.sh) | **1.4 or newer** | Runtime and package manager. The lockfile format needs Bun 1.4+ (`bun --version`). |
| Docker or rootless Podman, with Docker Compose | **5.0 or newer** | Postgres, Valkey, S3 (SeaweedFS), LiteLLM, the sync server and sidecars. The compose files redefine services they `include:`, which Compose 2.x rejects (`docker compose version`). Podman needs a few `.env` lines and an overlay file: [docs/CONTAINER-ENGINES.md](docs/CONTAINER-ENGINES.md). |
| `make` and `openssl` | any | `make` for the shortcuts (every target wraps a documented command); `openssl` generates the local secrets. |

No external accounts or API keys are needed to run the app.

```sh
make setup      # first run only, see below
make dev        # infra containers: Postgres (pgvector), Valkey, SeaweedFS, LiteLLM, sync, markitdown, renderer
make dev-app    # the Nuxt app on the host with HMR (bun run dev --host 0.0.0.0)
```

`make setup` runs `scripts/setup-env.sh`, then `bun install` in the repository root, `sync-server/` and `renderer/` (each is its own package; some unit tests and the type check import them). The script copies `.env.example` to `.env` and fills the secrets the stack refuses to start without (session, JWT, internal API, ALTCHA and LiteLLM keys) with fresh random values. It is idempotent: an existing `.env` is kept and secrets that already have a value are never changed. The Postgres, Valkey and S3 values in `.env.example` are throwaway development credentials that match `docker-compose.dev.yml`; the dev ports bind to `127.0.0.1` only.

Open the URL Nuxt prints (usually `http://localhost:3000`). Anonymous editing works without any further configuration; to test sign-in or AI, add the OAuth and provider keys to `.env` (see the comments in [`.env.example`](./.env.example) and [`docs/AI-MODELS.md`](./docs/AI-MODELS.md)). The host app must listen on `0.0.0.0` so the sync container can reach it through `host.docker.internal`.

Useful commands:

| Goal | Command |
|---|---|
| Stop dev infra / wipe its volumes | `make dev-down` / `make dev-clean` |
| Tail infra logs | `make dev-logs` |
| Lint, type-check | `bun run lint && bun run typecheck` |
| Everything `make` offers | `make help` |
| Full-stack local run with TLS (to verify Traefik/compose changes) | [`docs/LOCAL.md`](./docs/LOCAL.md) |
| Flat command reference | [`docs/CHEATSHEET.md`](./docs/CHEATSHEET.md) |

If you change `renderer/` or `sync-server/`, rebuild the container (`docker compose -f docker-compose.dev.yml up -d --build renderer`); `restart` does not rebuild.

## Repository map

The architecture overview is [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The authoritative per-area detail is in `AGENTS.md` at the repository root and in the `AGENTS.md` files next to the code (`app/`, `server/`, `sync-server/`, ...). They double as context for AI coding agents, but they are the canonical, human-readable engineering notes, including the gotchas that cost us time.

## Tests

| Tier | Command | Needs Docker | What it covers |
|---|---|---|---|
| unit | `bun run test:unit` | no | Pure functions, no Nuxt, no DB |
| dom | `bun run test:dom` | no | Components and utilities under happy-dom |
| nuxt | `bun run test:nuxt` | no | Composables and components in the Nuxt environment |
| **all fast tiers** | `bun run test` | no | unit + dom + nuxt (needs only `make setup`) |
| repos | `bun run test:repos` | yes (test stack) | DB-backed repositories against real Postgres |
| integration | `bun run test:integration` | yes (test stack) | REST API + sync server, full stack (several minutes) |
| everything | `bun run test:all` | yes | All vitest projects |
| coverage | `bun run test:coverage:fast` | yes | unit, dom, nuxt and repos with coverage |
| flows | `bun run flows:test` | yes (spins up its own) | Playwright user flows (see below); first run: `bunx playwright install chromium` |

**The docker test stack.** `repos` and `integration` need the disposable infrastructure in `docker-compose.test.yml` (Postgres on 5433, Valkey on 6380, SeaweedFS, LiteLLM, ...), isolated from the dev stack's ports and data:

```sh
bun run test:integration:up      # or: make test-stack-up
bun run test:repos
bun run test:integration
bun run test:integration:down    # or: make test-stack-down
```

On Podman the test-stack scripts add `docker-compose.test.podman.yml` themselves (`scripts/test-compose.sh`); set `TEST_FAKE_OPENAI_HOST` first ([docs/CONTAINER-ENGINES.md](docs/CONTAINER-ENGINES.md)).

The test database is `ypad_test`; the suites refuse to run against any other database name. Only one person (or agent) should use the test stack on a machine at a time.

Run the tiers that your change touches before you push; CI runs them all on every ready-for-review PR. A one-liner for the fast checks, no Docker needed: `bun run lint && bun run typecheck && bun run test`. (`make test` is a different mix: lint, typecheck, unit, dom and repos, so it needs the test stack and skips the nuxt tier.) CI also runs `ansible-lint`, `yamllint`, `actionlint`, `shellcheck` on `install.sh`, a secret scan and `docker compose config` for every compose combination; `make lint` runs the same linters locally when the tools are installed.

Notes for writing tests:

- `vi.mock` paths resolve relative to the **test file**, not the source file.
- DOMPurify tests run under jsdom (happy-dom breaks DOMPurify 3.4.8+).
- Valkey-backed rate limits are bypassed under `TEST_MODE=1`, which the test stacks set.
- `bun run test:coverage` undercounts API routes (they run in a separate server process during integration tests); don't chase that number.

## Flow tests, docs screenshots and the demo

The Playwright flow tests in `tests/e2e/flows/` are the user documentation: each flow is a real test and also records screenshots and captions that the docs site (`content/docs/`, `/docs`) embeds. Read [`tests/e2e/AGENTS.md`](./tests/e2e/AGENTS.md) before writing one (captioning rules, fixture API).

You do **not** need to regenerate screenshots in your PR. The published flow assets (`public/flows/`) and the demo/docs screenshots are regenerated only at **release time** by `release.yml`, which runs the full flow suite (including live-AI flows with provider keys). The PR gate runs no flow suite. Run a single flow locally with `bun run flows:test:changed` or `bun run flows:test` when you changed one.

## Coding rules

Project conventions are in `AGENTS.md`. The ones that matter most in review:

- **Don't silence tooling.** No `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, non-null `!` or blanket casts to make a linter, the type checker or SonarCloud pass. Fix the cause. If you believe a rule is wrong for a case, say so in the PR and let a maintainer decide.
- **No hacky test fixes.** Don't mask flakiness with retries, longer sleeps or looser assertions, and don't weaken an assertion to force green. Find the real cause in the test or in the code under test.
- **Test locally before you push.** Pre-existing failures in the tiers you ran get fixed (or raised in the PR), not pushed past.
- **Match the surrounding code**: comment density, naming, idiom. TypeScript everywhere, Drizzle for database access, Zod for AI tool schemas.
- **Authorization goes through the central helpers** (`canEditDoc`, `canManageDoc`, `canManageWorkspace`); never mix concerns or read `workspaces.ownerId` for authorization.
- **Never ship `passwordHash`**; always project explicitly on public endpoints.
- **New personal-data processing** needs an entry in `server/legal/lawfulBasis.ts` (and the sub-processor registry if a new vendor is involved).
- **New periodic sweepers** must acquire `acquireSweepLock(name)` and release it in a `finally`.
- **Keep EU data residency** in mind when adding a provider; see `docs/AI-MODELS.md` and the sub-processor registry.

## Pull requests

- **Branch from `main`**, keep the PR focused, and open it as a draft while it is in progress. Heavy CI jobs skip draft and docs-only PRs.
- **The PR title must be a conventional commit**: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `refactor: ...`, `test: ...`, `build: ...` or `ci: ...` (optional scope, e.g. `fix(sync): ...`). CI rejects anything else. If you retitle a PR, close and reopen it so the title check re-runs.
- **The PR title and body are the release notes, verbatim.** One merged PR becomes one GitHub Release if it is labelled for release ([`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md)). Write the description for the person reading the release page: what changed, why, how to verify, and anything an operator must do on upgrade.
- **Maintainers apply the release labels, not contributors.** Releases are opt-in: a maintainer applies `release:patch`, `release:minor` or `release:major` to the PR that should ship (usually the last of a batch). Unlabeled merges simply accumulate on `main`.
- Update the docs your change touches: user docs in `content/docs/`, [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md) for new configuration, and the relevant `AGENTS.md` for internals.
- Link the issue the PR resolves.

## Database migrations

Migrations are forward-only and applied at app start.

1. Edit `server/db/schema.ts` (enums are `text(..., { enum: [...] })`, not `pgEnum`).
2. `bun run db:generate` (or `make db-generate`) and commit both the SQL and the `drizzle/meta/` snapshot.
3. Indexes on large, populated tables need a hand-edited `CREATE INDEX CONCURRENTLY`; see `server/AGENTS.md`.
4. CI's `migration-guard` job blocks destructive migrations (`bun run db:check-migrations` runs the same check locally); call out anything that needs an operator action in the PR body.

## Documentation

- **User docs** (`content/docs/**`, rendered at `/docs`) are Nuxt Content pages. Front matter: `title`, `description`, `category`, `order`, optional `icon`, `featured`, `navHidden`. A page embeds a flow with `::flow{id="<slug>" hide-title}` followed by `::`. Write in the user's voice: no internals, no table names. Do not hand-write screenshots.
- **Self-hosting** lives in `docs/SELF-HOSTING.md`; every variable and command there must match `install.sh`, `docker-compose.selfhost.yml` and `.env.example`.
- Files in `docs/` that start with "Operator docs for the hosted markoto.app deployment" describe how we run the hosted service; they are published for transparency, not required reading.

## License and contributor agreement

markoto is licensed under [FSL-1.1-ALv2](./LICENSE) (source-available; each release converts to Apache-2.0 two years after it ships).

Contributions need a signed Contributor License Agreement (CLA). You keep the copyright in your contribution. The CLA is a licence grant, not an assignment: it grants LatentSpace Labs GmbH, the project owner, the rights needed to distribute your contribution under the project licence (FSL-1.1-ALv2, converting to Apache-2.0) and under other licence terms.

You sign once, through CLA Assistant: the bot comments on your first pull request with a link to the agreement text and a button to sign. Later pull requests need nothing more, and the check turns green once you have signed.

## Security issues

Never open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
