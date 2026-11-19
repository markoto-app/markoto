# Command cheatsheet

A flat reference of the common commands, grouped by task. `make help` lists every root target, `cd infra && make help` the deploy targets, and `bun run` every package script.

## I want to develop locally

| Goal | Command |
|---|---|
| First run: create `.env` with generated secrets, install dependencies | `make setup` |
| Start dev infra (Postgres, Valkey, SeaweedFS, LiteLLM, sync, markitdown, renderer) | `make dev` |
| Run the Nuxt dev server (assumes infra up) | `make dev-app` |
| Stop dev infra | `make dev-down` |
| Stop dev infra and wipe volumes | `make dev-clean` |
| Tail dev infra logs | `make dev-logs` |
| Generate a new migration after editing `server/db/schema/` | `make db-generate` |
| Apply pending migrations manually | `make db-migrate` |

For the full stack in containers with TLS (`make local-up`), see `docs/contributing/LOCAL.md`.

## I want to test something

| Goal | Command |
|---|---|
| Fast tiers, no Docker (unit + dom + nuxt) | `bun run test` |
| Lint + typecheck + unit + dom + repos (the repos tier needs the test stack; the nuxt tier is not included) | `make test` |
| Unit tests only | `make test-unit` |
| DOM tests | `make test-dom` |
| Nuxt-environment tests | `make test-nuxt` |
| Repos tests (database) | `make test-repos` |
| Integration tests (REST + sync, full stack) | `make test-integration` |
| Playwright flow tests (default, `@billing` and `@marketing` passes) | `make test-flows` |
| Only the flows you changed | `bun run flows:test:changed` |
| Only the marketing-site flows | `bun run flows:test --grep @marketing` |
| Everything (`make test`, integration, flows) | `make test-all` |

Tier details: `docs/contributing/testing.md`.

Product-page videos (`public/tour/`): with a flow-stack app running in the hosted shape (see `docs/contributing/flow-docs.md`, AI keys exported, ffmpeg installed), `TOUR_OUTPUT_DIR=/tmp/tour bun run tour:capture` re-records + encodes every scene; `--encode` only re-encodes what was recorded. Afterwards `bun scripts/build-og-images.ts` (or `make og-images`) rebuilds the 1200×630 social cards in `public/og/` (default, pricing, use cases, compare, docs; pass names to build only some): each card is an HTML page in the brand fonts from `node_modules` over a poster, screenshotted by headless Chromium (Playwright; `bunx playwright install chromium` once) and saved as JPEG with ffmpeg. Card text lives in the script, the alt texts in `shared/seo/ogImages.ts`, change both together.

**SEO + page speed (marketing pages, advisory, no CI job).** Run a production build in the hosted shape (`bun run build`, then `.output/server/index.mjs` with `NUXT_MARKETING_SITE_ENABLED=true`, a loopback `NUXT_SITE_URL`, `TEST_MODE=1`, throwaway Postgres/Valkey), then:

| Goal | Command |
|---|---|
| Audit every sitemap URL: title/description, canonical, OG/Twitter, lang, hreflang, robots, one h1, heading order, img alt/size, JSON-LD, broken internal links | `make seo-audit URL=http://127.0.0.1:3000` (`bun scripts/seo-audit.ts`) |
| No horizontal page scroll on phones: every sitemap URL at 375 + 390 px, prints the elements that stick out | `make check-overflow URL=http://127.0.0.1:3000` (`bun scripts/check-overflow.ts`, Playwright) |
| Lighthouse, mobile profile, on `/`, `/pricing`, `/markdown-to-pdf`, `/compare/hackmd` (LCP, CLS, TBT, JS transferred) | `make lighthouse URL=http://127.0.0.1:3000` (`bun scripts/lighthouse-marketing.ts`; Lighthouse via `bunx`, not a repo dependency; needs Chrome, `CHROME_PATH`) |

**Theme review (presets, pagination, fonts).** `make theme-shots URL=http://127.0.0.1:3000 [SHOTS_OUT=/tmp/theme-shots] [SHOTS_MD=tests/fixtures/theme-shots/paper.md] [PRESETS="markoto academic"]` (`bun scripts/render-theme-shots.ts`, Playwright) renders a Markdown file in each preset through the real preview iframe and writes `<preset>-p<N>.png` per page, `sheet-<preset>.png` contact sheets and the paginated HTML. The app must allow anonymous documents without the terms step: start it with `NUXT_ANON_GATE_ENABLED=false`. Fixtures: `kitchen-sink.md` (every block type), `paper.md` + `--patch tests/fixtures/theme-shots/paper-patch.json` (title block with authors, affiliations and abstract; call the script directly to pass `--patch`/`--title`). One realistic document per template (tech docs, RFC, runbook, API reference, thesis, conference paper, lecture notes, report, proposal, memo, one-pager, essay, manuscript, newsletter) with its `--title` and patch: `tests/fixtures/theme-shots/README.md`.

**Building a design template (preset).** Follow `docs/contributing/TEMPLATE-WORKFLOW.md`: reference (compiled LaTeX at 144 dpi or a design brief) → Markdown fixture → theme-shots → `scripts/compare-template-reference.sh <ref-dir> <shots-dir> <preset> <pages>` (side-by-side + overlay) → classify every difference → bake into a preset → real-renderer PDF check.

Without Traefik, Lighthouse's "Enable text compression" finding is expected: production compresses at Traefik (`app-compress` middleware). Put a gzip proxy in front for production-like numbers.

For repos / integration / flows: bring up the test stack first if it is not already: `make test-stack-up` (and `make test-stack-down` to tear down).

## I want to lint everything

| Goal | Command |
|---|---|
| All linters at once (ESLint, the type checks incl. `sync-server/` + `renderer/`, ansible-lint, yamllint, actionlint) | `make lint` |
| The whole fast local gate | `bun run check` (or `make check`) |
| Just ESLint + TypeScript | `bun run lint:fast && bun run typecheck` (`bun run lint` adds the slow type-aware rules) |
| Just Ansible (ansible-lint + yamllint) | `cd infra && make lint` |
| Just GitHub Actions workflows | `make lint-actions` |

## I want to bring up a compose stack

| Goal | Command |
|---|---|
| Dev infra (services only, Nuxt on host) | `make dev` / `make dev-down` |
| Local full stack (Traefik + mkcert TLS at https://ypad.127.0.0.1.nip.io) | `make local-up` / `make local-down` / `make local-clean` |
| Test stack (`deploy/compose/compose.test.yml`: Postgres, Valkey, SeaweedFS, LiteLLM, sync, renderer, markitdown, fakes) | `make test-stack-up` / `make test-stack-down` |

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

The `infra/` targets (`provision`, `deploy`, `rollback`, `ssh`, `prod-status`, `prod-logs`) need `ENV=<staging|prod>` and an inventory under `infra/inventories/<env>/`; without it they exit with a usage message. They drive the hosted deployment; its walkthroughs are part of the operator runbook, kept outside this repository. Self-hosting: `docs/SELF-HOSTING.md`.

## I want to investigate a problem

The queries below are a quick reference; the symptom-driven playbook for the hosted service is part of the operator runbook, kept outside this repository.

| Goal | Command or query |
|---|---|
| Show production health | `make prod-status` |
| Tail production logs | `make prod-logs` |
| SSH into the VPS | `make ssh` |
| Recent audit-log entries for a doc | `SELECT * FROM audit_log WHERE scope='doc' AND scope_id='<docId>' ORDER BY ts DESC LIMIT 50;` |
| Recent audit-log entries by an actor | `SELECT * FROM audit_log WHERE actor_user_id=<userId> ORDER BY ts DESC LIMIT 50;` |
| Pending Stripe webhook events (out-of-order stash) | `SELECT * FROM pending_stripe_events WHERE processed=false;` |
| Already-processed Stripe webhook events (idempotency) | `SELECT * FROM processed_webhook_events ORDER BY processed_at DESC LIMIT 50;` |
| AI budget/spend for a user | `SELECT litellm_key_id FROM users WHERE id=<userId>;` then LiteLLM `/key/info` |

## I want to release a new version

(The release labels are described in `CONTRIBUTING.md`, the workflows in `.github/workflows/README.md`.)

| Goal | Command |
|---|---|
| Open a PR | `gh pr create`. A maintainer adds at most one `release:*` label. |
| Manually trigger a deploy | `gh workflow run deploy.yml -f environment=staging -f tag=v1.2.3` |
| List recent releases | `gh release list --limit 10` |
| List recent runs of a workflow | `gh run list --workflow deploy.yml --limit 10` |

## I want to manage secrets

(Rotating the secrets of a self-hosted instance: `docs/SELF-HOSTING.md`.)

| Goal | Command |
|---|---|
| Edit the Ansible vault (created from `infra/group_vars/all.vault.example.yml`) | `cd infra && ansible-vault edit inventories/<env>/vault.yml --vault-password-file=inventories/<env>/.vault-password` |
| Generate a strong hex secret (JWT-style) | `openssl rand -hex 64` |
| Generate a strong base64 secret (session/passphrase-style) | `openssl rand -base64 48` |
| Scan full git history for leaked secrets (gitleaks) | `make secrets-scan` |

## I want to read documentation

| What | Where |
|---|---|
| Contributing (setup, tests, PR rules) | `CONTRIBUTING.md` |
| Architecture overview | `docs/ARCHITECTURE.md` |
| Contributor topic guides | `docs/contributing/` |
| Self-hosting (install, config, upgrades, troubleshooting) | `docs/SELF-HOSTING.md` |
| AI models and bring-your-own-key | `docs/AI-MODELS.md` |
| Local full stack | `docs/contributing/LOCAL.md` |
| S3 setup | `docs/S3-SETUP.md` |
| Security hardening | `docs/SECURITY-HARDENING.md` |
| Logging | `docs/contributing/logging.md` |
| GitHub Actions workflows | `.github/workflows/README.md` |
| Changelog | `CHANGELOG.md` |
