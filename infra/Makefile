SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

# One environment per run: make provision ENV=staging (or ENV=prod). Its
# files live in inventories/$(ENV)/ (hosts.ini, env.yml, vault.yml,
# .vault-password), all git-ignored.
ENV ?=
INVENTORY ?= inventories/$(ENV)/hosts.ini
VAULT_PASSWORD_FILE ?= inventories/$(ENV)/.vault-password
ANSIBLE_OPTS = -i $(INVENTORY) --vault-password-file=$(VAULT_PASSWORD_FILE)
NEED_ENV = @test -n "$(ENV)" -a -f "$(INVENTORY)" || (echo "Usage: make $@ ENV=<staging|prod> (needs $(INVENTORY))" && exit 1)

.PHONY: help provision deploy rollback logs ps ssh status backup-test syntax-check lint requirements

help: ## Show this help
	@printf "markoto/infra: Ansible deploy commands. Root task runner: \033[1mcd .. && make help\033[0m\n\n"
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

requirements: ## Install Galaxy collections + roles into ./collections (run once)
	ansible-galaxy collection install -r requirements.yml -p collections
	ansible-galaxy role install -r requirements.yml -p collections/ansible_roles

HOST = $$(grep -v '^\s*\#' $(INVENTORY) | grep -o 'ansible_host=[^ ]*' | head -1 | cut -d= -f2)

provision: ## One-time setup of a fresh VPS (~5–10 min): make provision ENV=staging
	$(NEED_ENV)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/provision.yml

deploy: ## Idempotent deploy, pulls latest images and restarts (~5 min): ENV=...
	$(NEED_ENV)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/deploy.yml

rollback: ## Roll back to a specific IMAGE_TAG: make rollback ENV=prod TAG=v1.2.3
	$(NEED_ENV)
	@test -n "$(TAG)" || (echo "Usage: make rollback ENV=<env> TAG=<image-tag>" && exit 1)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/rollback.yml -e target_image_tag=$(TAG)

logs: ## Tail compose logs from the remote (as the markoto user): ENV=...
	$(NEED_ENV)
	ansible -i $(INVENTORY) markoto -m command -a "/usr/local/bin/markoto-compose logs --tail=200" --become --become-user markoto

ps: ## Show the stack's containers on the remote: ENV=...
	$(NEED_ENV)
	ansible -i $(INVENTORY) markoto -m command -a "/usr/local/bin/markoto-compose ps" --become --become-user markoto

ssh: ## SSH into the VPS as the admin user (then: sudo -iu markoto): ENV=...
	$(NEED_ENV)
	ssh debian@$(HOST)

status: ## Health check the deployed instance: ENV=...
	$(NEED_ENV)
	@DOMAIN=$$(awk '/^domain:/{print $$2}' inventories/$(ENV)/env.yml); \
	echo "Host: $(HOST)  Domain: $$DOMAIN"; \
	curl -fsS "https://$$DOMAIN/api/health" | jq . || echo "health probe failed"

backup-test: ## Verify the latest gpg dump is restorable: ENV=...
	$(NEED_ENV)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/backup-test.yml

syntax-check: ## Validate playbook syntax (no execution)
	ansible-playbook -i inventories/example/hosts.ini --syntax-check playbooks/provision.yml
	ansible-playbook -i inventories/example/hosts.ini --syntax-check playbooks/deploy.yml
	ansible-playbook -i inventories/example/hosts.ini --syntax-check playbooks/rollback.yml
	ansible-playbook -i inventories/example/hosts.ini --syntax-check playbooks/backup-test.yml

lint: ## Run ansible-lint and yamllint
	@command -v ansible-lint >/dev/null 2>&1 || (echo "ansible-lint not installed: pip install --user ansible-lint"; exit 1)
	@command -v yamllint >/dev/null 2>&1 || (echo "yamllint not installed: pip install --user yamllint"; exit 1)
	ansible-lint
	yamllint .
