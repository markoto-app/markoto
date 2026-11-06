SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# Each env file pulls in docker-compose.base.yml via Compose's `include:`
# directive (Compose v2.20+). Single -f flag is enough; the merge is
# transparent. See AGENTS.md §5.
LOCAL := docker compose -f docker-compose.local.yml
DEV   := docker compose -f docker-compose.dev.yml
PROD  := docker compose -f docker-compose.prod.yml
TEST  := docker compose -f docker-compose.test.yml

CERT_DIR  := traefik/local
CERT_NAME := ypad.127.0.0.1.nip.io
CERT      := $(CERT_DIR)/$(CERT_NAME).pem
KEY       := $(CERT_DIR)/$(CERT_NAME)-key.pem

.PHONY: help
help: ## Show this help
	@printf "markoto — task runner. Run \033[1mmake <target>\033[0m or see \033[1mdocs/CHEATSHEET.md\033[0m for a use-case-keyed index.\n\n"
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@printf "\nAnsible/deploy subcommands: \033[1mcd infra && make help\033[0m\n"
	@printf "All bun scripts:            \033[1mbun run\033[0m\n"

# === Local development ===
.PHONY: dev
dev: ## Start dev infra (Postgres, Valkey, etc) — Nuxt runs on host
	$(DEV) up -d
	@echo ""
	@echo "Dev infra up. In another terminal: bun run dev --host 0.0.0.0"
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
test-unit: ## Run unit tests only (fast — no DB, no Docker)
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
test-integration: ## Run integration tests (slow — full stack)
	bun run test:integration

.PHONY: test-flows
test-flows: ## Run Playwright e2e flow tests
	bun run flows:test

.PHONY: test-all
test-all: ## Run EVERY test suite (slow — ~15min)
	$(MAKE) test
	$(MAKE) test-integration
	$(MAKE) test-flows

# === Linters ===
.PHONY: lint
lint: ## Run all lint+typecheck (eslint + tsc incl. sync-server + renderer + ansible-lint + yamllint + actionlint)
	bun run lint
	bun run typecheck
	cd sync-server && bun --bun run typecheck
	cd renderer && bun --bun run typecheck
	$(MAKE) -C infra lint
	$(MAKE) lint-actions

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

.PHONY: prod-logs
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
ssh: ## SSH into the VPS as the markoto user
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

.PHONY: theme-shots
theme-shots: ## PNG per page + contact sheet per theme preset from a running app with NUXT_ANON_GATE_ENABLED=false (URL=… SHOTS_OUT=… SHOTS_MD=… PRESETS="markoto tech")
	bun scripts/render-theme-shots.ts --base $(URL) --out $(SHOTS_OUT) --md $(SHOTS_MD) $(PRESETS)

# === Reference ===
.PHONY: cheatsheet
cheatsheet: ## Print docs/CHEATSHEET.md
	@cat docs/CHEATSHEET.md 2>/dev/null || echo "See docs/CHEATSHEET.md"

.PHONY: runbook
runbook: ## Print docs/RUNBOOK.md
	@cat docs/RUNBOOK.md 2>/dev/null || echo "See docs/RUNBOOK.md"
