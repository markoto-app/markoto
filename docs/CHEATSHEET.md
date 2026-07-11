# markoto Cheatsheet

If lost: start here.

- For interactive command discovery: `make help` (or `cd infra && make help` for deploy commands).
- For 3 AM symptom -> diagnosis -> fix: `docs/RUNBOOK.md`.
- For "how does the release pipeline work": `docs/RELEASE-PROCESS.md`.
- For "what each secret is and when to rotate it": `docs/SECRETS-ROTATION.md`.

Below is a flat reference grouped by what you are trying to do.

## I want to develop locally

| Goal | Command |
|---|---|
| Start dev infra (Postgres, Valkey, SeaweedFS, sync, markitdown) | `make dev` |
| Run the Nuxt dev server (assumes infra up) | `make dev-app` |
| Stop dev infra | `make dev-down` |
| Stop dev infra and wipe volumes | `make dev-clean` |
| Tail dev infra logs | `make dev-logs` |
| Generate a new migration after editing `server/db/schema.ts` | `make db-generate` |
| Apply pending migrations manually | `make db-migrate` |

See `docs/LOCAL.md` for the pre-push full-stack verification flow (`make local-up`).

## I want to test something

| Goal | Command | Speed |
|---|---|---|
| Quick check before commit (lint + typecheck + unit + dom + repos) | `make test` | ~1m |
| Unit tests only | `make test-unit` | ~10s |
| DOM tests (happy-dom) | `make test-dom` | ~10s |
| Nuxt-env composable/component tests | `make test-nuxt` | ~30s |
| Repos tests (DB-backed) | `make test-repos` | ~30s |
| Integration tests (REST + sync, full stack) | `make test-integration` | ~5m |
| Playwright e2e flow tests | `make test-flows` | ~10m |
| Everything | `make test-all` | ~15m |

For repos / integration / flows: bring up the test stack first if it is not already: `make test-stack-up` (and `make test-stack-down` to tear down).

## I want to lint everything

| Goal | Command |
|---|---|
| All linters at once (eslint + tsc + ansible-lint + yamllint + actionlint) | `make lint` |
| Just ESLint + TypeScript | `bun run lint && bun run typecheck` |
| Just Ansible (ansible-lint + yamllint) | `cd infra && make lint` |
| Just GitHub Actions workflows | `make lint-actions` |

## I want to bring up a compose stack

| Goal | Command |
|---|---|
| Dev infra (services only — Nuxt on host) | `make dev` / `make dev-down` |
| Local full stack (Traefik + mkcert TLS at https://ypad.127.0.0.1.nip.io) | `make local-up` / `make local-down` / `make local-clean` |
| Test stack (Postgres + Valkey + SeaweedFS + sync) | `make test-stack-up` / `make test-stack-down` |
| Prod stack locally (GHCR images, ACME) | `make prod-pull && make prod-up` / `make prod-down` |

First-time only for the local stack: `make mkcert-install` then `make certs` (wired into `local-up`).

## I want to deploy

| Goal | Command |
|---|---|
| First-time VPS provisioning | `make provision` |
| Deploy current image_tag | `make deploy` |
| Roll back to a specific tag | `make rollback TAG=v1.2.3` |
| SSH to the VPS | `make ssh` |
| Check production health | `make prod-status` |
| Tail production logs | `make prod-logs` |
| Verify backups are restorable | `cd infra && make backup-test` |

See `docs/DEPLOY-OVH.md` for the OVH walkthrough and `docs/DEPLOY.md` for the generic deploy notes.

## I want to investigate a problem

(Cross-link `docs/RUNBOOK.md`. SQL queries here are quick reference, not exhaustive.)

| Goal | Command or query |
|---|---|
| 3 AM "what's wrong" | grep `docs/RUNBOOK.md` for the symptom |
| Show production health | `make prod-status` |
| Tail production logs | `make prod-logs` |
| SSH into the VPS | `make ssh` |
| Recent audit-log entries for a doc | `SELECT * FROM audit_log WHERE scope='doc' AND scope_id='<docId>' ORDER BY ts DESC LIMIT 50;` |
| Recent audit-log entries by an actor | `SELECT * FROM audit_log WHERE actor_user_id=<userId> ORDER BY ts DESC LIMIT 50;` |
| Pending Stripe webhook events (out-of-order stash) | `SELECT * FROM pending_stripe_events WHERE processed=false;` |
| Already-processed Stripe webhook events (idempotency) | `SELECT * FROM processed_webhook_events ORDER BY processed_at DESC LIMIT 50;` |
| AI budget/spend for a user | `SELECT litellm_key_id FROM users WHERE id=<userId>;` then LiteLLM `/key/info` — see `docs/RUNBOOK.md` "budget-exhausted" |
| Sentry tag table for filtering | See `docs/RUNBOOK.md` and `docs/OBSERVABILITY.md` |

## I want to release a new version

(See `docs/RELEASE-PROCESS.md` for the full flow.)

| Goal | Command |
|---|---|
| Open a PR | `gh pr create` (or via the GitHub UI). Add exactly ONE `release:*` label. |
| Manually trigger a deploy workflow | `gh workflow run deploy.yml -f tag=v1.2.3` |
| List recent releases | `gh release list --limit 10` |
| List recent runs of a workflow | `gh run list --workflow deploy.yml --limit 10` |

## I want to manage secrets

(See `docs/SECRETS-ROTATION.md` for the per-secret rotation procedure.)

| Goal | Command |
|---|---|
| Edit the Ansible vault | `cd infra && ansible-vault edit group_vars/all.vault.yml` |
| Generate a strong hex secret (JWT-style) | `openssl rand -hex 64` |
| Generate a strong base64 secret (session/passphrase-style) | `openssl rand -base64 48` |
| Scan full git history for leaked secrets (gitleaks) | `make secrets-scan` |

## I want to read documentation

| What | Where |
|---|---|
| Architecture overview | `AGENTS.md` (per-area sub-AGENTS.md files in respective dirs) |
| 3 AM runbook | `docs/RUNBOOK.md` |
| Release pipeline | `docs/RELEASE-PROCESS.md` |
| Deploy walkthrough (OVH) | `docs/DEPLOY-OVH.md` |
| Generic deploy walkthrough | `docs/DEPLOY.md` |
| Local pre-push verification | `docs/LOCAL.md` |
| S3 setup | `docs/S3-SETUP.md` |
| Secrets rotation | `docs/SECRETS-ROTATION.md` |
| Security hardening | `docs/SECURITY-HARDENING.md` |
| Observability (Sentry, logs, metrics) | `docs/OBSERVABILITY.md` |
| GitHub repo configuration | `docs/GITHUB-CONFIG.md` |
| GitHub Actions iteration | `.github/workflows/README.md` |
| Changelog | `CHANGELOG.md` |

## I want to know what command exists

- `make` (or `make help`) — interactive root menu.
- `cd infra && make help` — Ansible-specific subcommands.
- `bun run` — list every npm-style script.
- This file — use-case-keyed flat reference.
