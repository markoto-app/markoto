# Contributing to markoto

Thanks for your interest in contributing! This document covers the practical
conventions this repo enforces — most of them are checked by CI, so reading
this first will save you a round-trip.

## Getting a dev environment running

Prerequisites: [Bun](https://bun.sh), Docker with Compose v2.20+, and `make`.

```sh
bun install
make dev        # starts the infra containers (Postgres, Valkey, S3, sync, …)
make dev-app    # runs the Nuxt app on the host with HMR
```

`make help` lists every common workflow. `docs/LOCAL.md` covers the full-stack
local setup (TLS via mkcert), and `docs/CHEATSHEET.md` is the use-case-keyed
command reference.

Architecture documentation lives in `AGENTS.md` at the repo root, with
per-area deep-dives in sub-`AGENTS.md` files (`app/`, `server/`,
`sync-server/`, etc.). These files double as context for AI coding agents,
but they are the canonical human-readable architecture docs too — start there.

## Tests

```sh
bun run test               # unit + dom + nuxt (fast, no Docker needed)
bun run test:integration:up && bun run test:repos       # DB-backed tier
bun run test:integration   # full REST + sync integration tier (~5 min)
bun run flows:test         # Playwright flow tests (ephemeral Docker stack)
```

Please run the tiers relevant to your change locally before pushing. CI runs
all of them on every ready-for-review PR. Two hard rules:

- **Don't silence tooling.** No `eslint-disable`, `as any`, `!`, or weakened
  assertions to force green — fix the cause, or raise the problem in the PR.
- **Don't mask flakiness.** If a test is flaky, the fix is in the test or the
  code under test, not in retries or looser matchers.

## Pull requests

- **PR titles must be conventional**: `feat: …`, `fix: …`, `docs: …`,
  `chore: …`, `refactor: …`, `test: …`, `build: …`, or `ci: …`. CI rejects
  anything else. (Note: if you retitle a PR, close and reopen it to re-run
  the title check.)
- **Your PR title + body become the release notes verbatim.** One merged PR =
  one release (see `docs/RELEASE-PROCESS.md`). Write the description for the
  person reading the release page: what changed, why, how to verify.
- **Releases are opt-in.** An unlabeled merge does NOT release — label a
  PR `release:patch`, `release:minor`, or `release:major` to ship a
  release (typically the last PR of a batch carries the label for the
  accumulated work). The release chain (image builds + full live-AI flow
  suite + staging deploy) is expensive, so it runs deliberately, not on
  every merge.
- Migrations are forward-only. `bun run db:generate` after schema changes;
  the CI `migration-guard` job blocks destructive migrations.

## Code style

- Match the surrounding code — comment density, naming, idiom.
- TypeScript everywhere; Drizzle for DB access; Zod for AI tool schemas.
- Lint + typecheck: `bun run lint && bun run typecheck`.

## License of contributions

markoto is licensed under [FSL-1.1-ALv2](./LICENSE). By contributing, you
agree that your contributions are licensed under the same terms.

## Security issues

Never open a public issue for a vulnerability — see [SECURITY.md](./SECURITY.md).
