SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# The stacks live in deploy/compose/; each pulls in compose.base.yml via
# Compose's `include:` directive. Compose 5.0 or newer is required (the files
# redefine included services, which older versions reject). Single -f flag is
# enough; the merge is transparent. See docs/ARCHITECTURE.md ("Design decisions").
# Compose reads `.env` from the compose file's directory, so the repository's
# is handed over explicitly (when there is one).
ENV_FILE := $(if $(wildcard .env),--env-file .env)
LOCAL := docker compose $(ENV_FILE) -f deploy/compose/compose.local.yml
DEV   := docker compose $(ENV_FILE) -f deploy/compose/compose.dev.yml
PROD  := docker compose $(ENV_FILE) -f deploy/compose/compose.prod.yml
# The test stack goes through a helper that adds the Podman overlay when
# the engine is Podman (docs/contributing/CONTAINER-ENGINES.md).
TEST  := bash scripts/test-compose.sh

CERT_DIR  := deploy/config/traefik/local
CERT_NAME := ypad.127.0.0.1.nip.io
CERT      := $(CERT_DIR)/$(CERT_NAME).pem
KEY       := $(CERT_DIR)/$(CERT_NAME)-key.pem

.PHONY: help
help: ## Show this help
	@printf "markoto: task runner. Run \033[1mmake <target>\033[0m or see \033[1mdocs/contributing/CHEATSHEET.md\033[0m for a use-case-keyed index.\n\n"
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@printf "\nAnsible/deploy subcommands: \033[1mcd infra && make help\033[0m\n"
	@printf "All bun scripts:            \033[1mbun run\033[0m\n"

# === Local development ===
.PHONY: setup
setup: ## First run: create .env with generated secrets, install deps (one Bun workspace: app, shared, sync-server, renderer)
	bash scripts/setup-env.sh
	bun install

.PHONY: dev
dev: ## Start dev infra (Postgres, Valkey, etc), Nuxt runs on host
	COMPOSE="$(DEV)" sh deploy/config/postgres/pg-major-upgrade.sh upgrade
	$(DEV) up -d
	@echo ""
	@echo "Dev infra up (first run? 'make setup' creates .env). In another terminal: bun run dev --host 0.0.0.0"
	@echo "Or: make dev-app"

.PHONY: dev-app
dev-app: ## Run `bun run dev` (assumes dev infra already up)
	bun run dev --host 0.0.0.0

.PHONY: dev-down
dev-down: ## Stop dev infra
	$(DEV) down

.PHONY: dev-clean
dev-clean: ## Stop dev infra and wipe volumes
	$(DEV) down -v

.PHONY: dev-logs
dev-logs: ## Tail dev infra logs
	$(DEV) logs -f --tail=200

# === Test suites ===
.PHONY: test
test: ## Run lint + typecheck + unit + dom + repos (no integration / flows)
	bun run lint
	bun run typecheck
	bun run test:unit
	bun run test:dom
	bun run test:repos

.PHONY: test-unit
test-unit: ## Run unit tests only (fast, no DB, no Docker)
	bun run test:unit

.PHONY: test-dom
test-dom: ## Run DOM tests (happy-dom)
	bun run test:dom

.PHONY: test-nuxt
test-nuxt: ## Run Nuxt-env composable/component tests
	bun run test:nuxt

.PHONY: test-repos
test-repos: ## Run repos tests (DB-backed; uses test stack)
	bun run test:repos

.PHONY: test-integration
test-integration: ## Run integration tests (slow, full stack)
	bun run test:integration

.PHONY: test-flows
test-flows: ## Run Playwright e2e flow tests
	bun run flows:test

.PHONY: test-all
test-all: ## Run EVERY test suite (slow, ~15min)
	$(MAKE) test
	$(MAKE) test-integration
	$(MAKE) test-flows

# === Linters ===
.PHONY: lint
lint: ## Run all lint+typecheck (eslint + tsc incl. sync-server + renderer + ansible-lint + yamllint + actionlint)
	bun run lint
	bun run typecheck
	bun run typecheck:services
	$(MAKE) -C infra lint
	$(MAKE) lint-actions

.PHONY: check
check: ## The one-command local gate: generated files, graph checks, fast lint, every typecheck, unit tests
	bun run check

.PHONY: check-full
check-full: ## `make check` + the type-aware lint rules + the checks that need external tools (shellcheck, hadolint, lychee, uv)
	bun run check:full

.PHONY: lint-actions
lint-actions: ## Lint .github/workflows/*.yml via actionlint
	@which actionlint > /dev/null || (echo "actionlint not installed. Install: https://github.com/rhysd/actionlint/blob/main/docs/install.md"; exit 1)
	actionlint

.PHONY: lint-all
lint-all: ## Alias for `make lint` (kept for backward compat)
	$(MAKE) lint

.PHONY: secrets-scan
secrets-scan: ## Scan git history for leaked secrets via gitleaks
	@which gitleaks > /dev/null || (echo "gitleaks not installed: https://github.com/gitleaks/gitleaks#installing"; exit 1)
	gitleaks detect --redact --no-banner --log-level error

# === Compose stacks ===
.PHONY: local-up
local-up: $(CERT) $(KEY) ## Bring up the LOCAL stack (Traefik + mkcert TLS)
	COMPOSE="$(LOCAL)" sh deploy/config/postgres/pg-major-upgrade.sh upgrade
	$(LOCAL) up -d --build

.PHONY: local-down
local-down: ## Tear down the LOCAL stack
	$(LOCAL) down

.PHONY: local-clean
local-clean: ## Tear down the LOCAL stack and wipe volumes
	$(LOCAL) down -v

.PHONY: local-logs
local-logs: ## Tail LOCAL stack logs
	$(LOCAL) logs -f --tail=200

.PHONY: local-build
local-build: ## Build LOCAL stack images without starting
	$(LOCAL) build

.PHONY: test-stack-up
test-stack-up: ## Bring up the TEST stack (used by test-integration + test-flows)
	$(TEST) up -d --wait

.PHONY: test-stack-down
test-stack-down: ## Tear down the TEST stack
	$(TEST) down

.PHONY: prod-pull
prod-pull: ## Pull latest prod images
	$(PROD) pull

.PHONY: prod-up
prod-up: ## Start the PROD stack (GHCR images, Let's Encrypt)
	$(PROD) up -d

.PHONY: prod-down
prod-down: ## Stop the PROD stack
	$(PROD) down

.PHONY: prod-logs-local
prod-logs-local: ## Tail PROD stack logs (local invocation)
	$(PROD) logs -f --tail=200

# === DB ===
.PHONY: db-generate
db-generate: ## Generate Drizzle migration from schema.ts changes
	bun run db:generate

.PHONY: db-migrate
db-migrate: ## Apply pending Drizzle migrations
	bun run db:migrate

# === mkcert ===
.PHONY: mkcert-install
mkcert-install: ## Install the mkcert local CA into OS/browser trust stores
	mkcert -install

$(CERT) $(KEY):
	@mkdir -p $(CERT_DIR)
	cd $(CERT_DIR) && mkcert \
	  -cert-file $(CERT_NAME).pem \
	  -key-file  $(CERT_NAME)-key.pem \
	  "$(CERT_NAME)" "*.$(CERT_NAME)"
	@echo "Generated $(CERT) and $(KEY) (gitignored)"

.PHONY: certs
certs: $(CERT) $(KEY) ## Generate mkcert TLS cert for the LOCAL stack

# === Deploy (delegates to infra/Makefile) ===
.PHONY: provision
provision: ## One-time: provision a fresh OVH VPS via Ansible
	$(MAKE) -C infra provision

.PHONY: deploy
deploy: ## Deploy current image_tag to the VPS via Ansible
	$(MAKE) -C infra deploy

.PHONY: rollback
rollback: ## Roll back to a specific image tag (TAG=v1.2.3)
	$(MAKE) -C infra rollback TAG=$(TAG)

.PHONY: ssh
ssh: ## SSH into the VPS as the admin user (debian)
	$(MAKE) -C infra ssh

.PHONY: prod-status
prod-status: ## Curl /api/health on the deployed instance
	$(MAKE) -C infra status

.PHONY: prod-logs
prod-logs: ## Tail compose logs from the deployed instance
	$(MAKE) -C infra logs

# === SEO + page speed (advisory, against a running production build) ===
URL ?= http://127.0.0.1:3000

.PHONY: seo-audit
seo-audit: ## SEO audit of every sitemap URL of a running instance (URL=http://127.0.0.1:3000)
	bun scripts/seo-audit.ts $(URL)

.PHONY: check-overflow
check-overflow: ## No horizontal scroll at 375/390 px on any sitemap URL of a running instance (URL=…)
	bun scripts/check-overflow.ts $(URL)

.PHONY: og-images
og-images: ## Rebuild the 1200×630 social cards in public/og/ (Playwright + ffmpeg)
	bun scripts/build-og-images.ts

.PHONY: lighthouse
lighthouse: ## Lighthouse (mobile) on the marketing pages of a running instance (URL=…)
	bun scripts/lighthouse-marketing.ts $(URL)

# === Theme review ===
SHOTS_OUT ?= /tmp/theme-shots
SHOTS_MD ?= tests/fixtures/theme-shots/kitchen-sink.md

.PHONY: theme-thumbs
theme-thumbs: ## Re-render the new-doc design-picker thumbnails (public/theme-thumbs) from a TEST_MODE app with NUXT_ANON_GATE_ENABLED=false (URL=… PRESETS="arxiv tech-docs")
	bun scripts/render-theme-thumbs.ts --base $(URL) $(PRESETS)

.PHONY: template-gallery
template-gallery: ## Re-render the SEO template-gallery pictures (public/templates) from a TEST_MODE app with NUXT_ANON_GATE_ENABLED=false (URL=… IDS="resume report")
	bun scripts/render-theme-thumbs.ts --base $(URL) --gallery $(IDS)

.PHONY: template-thumbs
template-thumbs: ## Re-render the new-doc template pictures (public/template-thumbs) from a TEST_MODE app with NUXT_ANON_GATE_ENABLED=false (URL=… IDS="runbook arxiv")
	bun scripts/render-theme-thumbs.ts --base $(URL) --templates $(IDS)

.PHONY: theme-shots
theme-shots: ## PNG per page + contact sheet per theme preset from a running app with NUXT_ANON_GATE_ENABLED=false (URL=… SHOTS_OUT=… SHOTS_MD=… PRESETS="markoto tech")
	bun scripts/render-theme-shots.ts --base $(URL) --out $(SHOTS_OUT) --md $(SHOTS_MD) $(PRESETS)

# === Reference ===
.PHONY: cheatsheet
cheatsheet: ## Print docs/contributing/CHEATSHEET.md
	@cat docs/contributing/CHEATSHEET.md 2>/dev/null || echo "See docs/contributing/CHEATSHEET.md"

