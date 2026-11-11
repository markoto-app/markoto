## What changed

<!-- The PR title and this description become the release notes verbatim (when a maintainer labels the PR for release). Write for the person reading the release page. -->

## Why

<!-- Motivation. Link the issue: "Closes #123". -->

## How to verify

<!-- What a reviewer should run or click. Include commands and expected results. -->

## Upgrade notes

<!-- New or renamed environment variables, destructive or slow migrations, anything a self-hoster must do. Write "None" if there is nothing. -->

## Checklist

- [ ] The PR title is a conventional commit with a lower-case subject (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:` or `revert:`).
- [ ] I ran the relevant test tiers locally (`bun run lint && bun run typecheck && bun run test`, plus `test:repos` / `test:integration` when touching server code).
- [ ] No lint or type suppressions (`eslint-disable`, `@ts-ignore`, `as any`, `!`) and no weakened assertions.
- [ ] Docs updated where behaviour or configuration changed (`content/docs/`, `docs/SELF-HOSTING.md`, `docs/contributing/`, the nearest `AGENTS.md`).
- [ ] Schema changes include the generated migration and `drizzle/meta/` snapshot.

<!-- Do not add a `release:*` label yourself. Releases are opt-in; a maintainer labels the PR that should ship (docs/operations/RELEASE-PROCESS.md). -->
