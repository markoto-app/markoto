SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

VAULT_PASSWORD_FILE ?= .vault-password
INVENTORY ?= inventory.ini
ANSIBLE_OPTS = -i $(INVENTORY) --vault-password-file=$(VAULT_PASSWORD_FILE)

.PHONY: help provision deploy rollback logs ssh status backup-test syntax-check lint requirements

help: ## Show this help
	@printf "markoto/infra: Ansible deploy commands. Root task runner: \033[1mcd .. && make help\033[0m\n\n"
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

requirements: ## Install Galaxy collections + roles into ./collections (run once)
	ansible-galaxy collection install -r requirements.yml -p collections
	ansible-galaxy role install -r requirements.yml -p collections/ansible_roles

provision: ## One-time setup of a fresh VPS (~5–10 min)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/provision.yml

deploy: ## Idempotent deploy, pulls latest images and restarts (~5 min)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/deploy.yml

rollback: ## Roll back to a specific IMAGE_TAG: make rollback TAG=v1.2.3
	@test -n "$(TAG)" || (echo "Usage: make rollback TAG=<image-tag>" && exit 1)
	ansible-playbook $(ANSIBLE_OPTS) playbooks/rollback.yml -e target_image_tag=$(TAG)

logs: ## Tail compose logs from the remote
	ansible -i $(INVENTORY) markoto -m shell -a "cd /opt/markoto && docker compose logs --tail=200" --become

ssh: ## SSH into the VPS as the markoto user
	ssh markoto@$$(awk -F= '/ansible_host/{gsub(/ /,"",$$2); print $$2}' $(INVENTORY) | head -1 | awk '{print $$1}')

status: ## Health check the deployed instance
	@HOST=$$(awk -F= '/ansible_host/{gsub(/ /,"",$$2); print $$2}' $(INVENTORY) | head -1 | awk '{print $$1}'); \
	DOMAIN=$$(awk '/^domain:/{print $$2}' group_vars/all.yml); \
	echo "Host: $$HOST  Domain: $$DOMAIN"; \
	curl -fsS "https://$$DOMAIN/api/health" | jq . || echo "health probe failed"

backup-test: ## Verify the latest gpg dump is restorable
	ansible-playbook $(ANSIBLE_OPTS) playbooks/backup-test.yml

syntax-check: ## Validate playbook syntax (no execution)
	ansible-playbook -i inventory.example.ini --syntax-check playbooks/provision.yml
	ansible-playbook -i inventory.example.ini --syntax-check playbooks/deploy.yml
	ansible-playbook -i inventory.example.ini --syntax-check playbooks/rollback.yml
	ansible-playbook -i inventory.example.ini --syntax-check playbooks/backup-test.yml

lint: ## Run ansible-lint and yamllint
	@command -v ansible-lint >/dev/null 2>&1 || (echo "ansible-lint not installed: pip install --user ansible-lint"; exit 1)
	@command -v yamllint >/dev/null 2>&1 || (echo "yamllint not installed: pip install --user yamllint"; exit 1)
	ansible-lint
	yamllint .
