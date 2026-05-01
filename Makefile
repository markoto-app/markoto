.PHONY: help certs mkcert-install \
        local-up local-down local-logs local-clean local-build \
        dev-up dev-down dev-logs dev-clean \
        prod-up prod-down prod-logs prod-pull

# Each env file pulls in docker-compose.base.yml via Compose's `include:`
# directive (Compose v2.20+). Single -f flag is enough; the merge is
# transparent. See AGENTS.md §5.
LOCAL := docker compose -f docker-compose.local.yml
DEV   := docker compose -f docker-compose.dev.yml
PROD  := docker compose -f docker-compose.prod.yml

CERT_DIR  := traefik/local
CERT_NAME := ypad.127.0.0.1.nip.io
CERT      := $(CERT_DIR)/$(CERT_NAME).pem
KEY       := $(CERT_DIR)/$(CERT_NAME)-key.pem

help:
	@echo "Local full stack (Traefik + mkcert, built from source):"
	@echo "  make local-up        start (generates cert if missing)"
	@echo "  make local-down      stop"
	@echo "  make local-clean     stop + wipe volumes"
	@echo "  make local-logs      tail logs"
	@echo ""
	@echo "Dev infra only (Nuxt runs on host via 'bun run dev'):"
	@echo "  make dev-up          start"
	@echo "  make dev-down        stop"
	@echo "  make dev-clean       stop + wipe volumes"
	@echo "  make dev-logs        tail logs"
	@echo ""
	@echo "Prod (GHCR images, Let's Encrypt):"
	@echo "  make prod-pull       pull latest images"
	@echo "  make prod-up         start"
	@echo "  make prod-down       stop"
	@echo "  make prod-logs       tail logs"
	@echo ""
	@echo "mkcert:"
	@echo "  make mkcert-install  install the local CA into OS/browser trust stores"
	@echo "  make certs           generate traefik/local/$(CERT_NAME)*.pem (re-run to rotate)"

mkcert-install:
	mkcert -install

$(CERT) $(KEY):
	@mkdir -p $(CERT_DIR)
	cd $(CERT_DIR) && mkcert \
	  -cert-file $(CERT_NAME).pem \
	  -key-file  $(CERT_NAME)-key.pem \
	  "$(CERT_NAME)" "*.$(CERT_NAME)"
	@echo "Generated $(CERT) and $(KEY) (gitignored)"

certs: $(CERT) $(KEY)

local-build:
	$(LOCAL) build

local-up: $(CERT) $(KEY)
	$(LOCAL) up -d --build

local-down:
	$(LOCAL) down

local-clean:
	$(LOCAL) down -v

local-logs:
	$(LOCAL) logs -f --tail=200

dev-up:
	$(DEV) up -d

dev-down:
	$(DEV) down

dev-clean:
	$(DEV) down -v

dev-logs:
	$(DEV) logs -f --tail=200

prod-pull:
	$(PROD) pull

prod-up:
	$(PROD) up -d

prod-down:
	$(PROD) down

prod-logs:
	$(PROD) logs -f --tail=200
