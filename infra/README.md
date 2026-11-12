# markoto — Ansible deploy

Agentless, GPL-3.0, OVH-targeted automation. From "fresh VPS IP + clicked
managed Postgres + clicked S3 bucket" to a running stack in ~25 minutes.

For the click-by-click walkthrough see [`../docs/operations/DEPLOY-OVH.md`](../docs/operations/DEPLOY-OVH.md).
For the manual runbook (no Ansible) see [`../docs/operations/DEPLOY.md`](../docs/operations/DEPLOY.md).

## Why Ansible (vs Terraform / Pulumi / OpenTofu)

- **Agentless** — SSH only. No daemon on the VPS, no state file to lose.
- **OSS, GPL-3.0** — no enterprise tier behind a paywall, no telemetry.
- **Configures-not-provisions** — the user clicks the OVH/Cloudflare buttons
  once; Ansible only configures the box. Matches the "single VPS, not a
  fleet" reality of this project.
- **Disaster recovery is one inventory edit** — VPS dead → spin a new one →
  update IP → re-run `make provision && make deploy`.

## Layout

```
infra/
├── Makefile                # convenience targets (provision/deploy/rollback/logs/ssh/status/backup-test/lint)
├── README.md               # this file
├── ansible.cfg             # roles_path, ssh args, stdout callback
├── .ansible-lint           # production profile, offline by default
├── .yamllint               # 120-col, octal-strict (matches ansible-lint reqs)
├── requirements.yml        # Galaxy collections + roles (see §Galaxy deps)
├── inventory.example.ini   # template — fill in VPS IP
├── group_vars/
│   ├── all.yml             # non-secret defaults (domain, image tag, paths)
│   └── all.vault.example.yml  # secret template — encrypt before commit
├── playbooks/
│   ├── provision.yml       # one-time: base + os_hardening + docker + ssh_hardening
│   ├── deploy.yml          # idempotent: markoto + backup_cron
│   ├── rollback.yml        # set target_image_tag, re-deploy
│   └── backup-test.yml     # restore drill: newest backup into a throwaway DB, then drop it
├── roles/                  # roles WE wrote — see §What's hand-rolled below
│   ├── base/               # ufw, fail2ban, journald, timezone, markoto user, LUKS check
│   ├── ssh_hardening/      # PasswordAuth no, root login no, validate before reload
│   ├── markoto/            # compose+env sync, pull, up -d, /api/health probe, deploys.log
│   └── backup_cron/        # 03:00 UTC daily belt-and-braces backup with failure log
├── collections/            # Galaxy-installed deps (gitignored)
│   ├── ansible_collections/
│   └── ansible_roles/
├── files/                  # ovh-pg-ca.pem (drop here if pinning OVH managed PG)
├── litellm/                # LiteLLM proxy config.yaml + custom_handlers.py (bind-mounted)
├── postgres/               # db-init.sh (per-service DB roles) + init SQL
├── render-env.sh           # CI: renders .env from GitHub Environment secrets/variables
├── render-env-parity-test.sh  # asserts render-env.sh and env.j2 produce the same .env
└── templates/
    └── env.j2              # renders /opt/markoto/.env from group_vars + vault
```

## Quick start

```bash
cd infra/
make requirements                            # install Galaxy collections + roles (once)
cp inventory.example.ini inventory.ini       # set ansible_host=<VPS_IP>
cp group_vars/all.vault.example.yml group_vars/all.vault.yml
# edit group_vars/all.vault.yml — fill in every REPLACE_ME
ansible-vault encrypt group_vars/all.vault.yml
echo "<your vault passphrase>" > .vault-password && chmod 600 .vault-password
# Optional: drop the OVH managed-PG CA at files/ovh-pg-ca.pem

make provision                               # ~5–10 min
make deploy                                  # ~5 min
make status                                  # curl /api/health
```

## Galaxy dependencies (and why)

`requirements.yml` pins the roles and `devsec.hardening` to an exact version (the other collections have a minimum version). Surprise upgrades on
Docker apt-key handling or CIS sysctl baselines are exactly what we want
to NOT absorb silently — bumps land via PR after manual review.

| Dep | Version | Why |
|---|---|---|
| `community.general` | `>=8.0.0` | `ufw`, `timezone` modules. |
| `community.docker` | `>=3.10.0` | `docker_compose_v2*` modules used by `markoto/`. |
| `ansible.posix` | `>=1.5.4` | `authorized_key` module. |
| `devsec.hardening` | `10.5.2` | CIS-aligned `os_hardening` role — replaces ~50 lines of hand-rolled sysctl/PAM/perm tuning we'd have to chase as CIS evolves. |
| `geerlingguy.docker` | `8.0.0` | Docker apt-repo handling is the single most fragile piece of any Ansible role — Geerling's gets patched within days when a distro changes things. |
| `geerlingguy.security` | `3.0.0` | Unattended upgrades + reboot window. |

## Apprise notification wrapper (`/usr/local/bin/markoto-notify`)

A single entry point for "something noteworthy happened on the box, ping me." Dropped onto the VPS by `roles/base/`; reads its config from `/etc/markoto/apprise.env` (mode `0600`, owned by root) which contains semicolon-separated Apprise URLs (`apprise_urls` from the vault). Supports any of Apprise's 100+ services — Telegram is the working default, but the env variable is the only thing that pins it to one provider.

**Call sites:**

- **APT post-invoke hook** (`/etc/apt/apt.conf.d/99-markoto-notify`, written by `roles/base/tasks/main.yml`) — after an apt run it sends the tail of the unattended-upgrades log, so OS updates surface in the operator's notifications without a `mail` setup.
- **Backup cron failure path** (`roles/backup_cron/tasks/main.yml`) — runs `/usr/local/bin/backup.sh --once` in the sidecar (non-zero exit on a failed dump/upload; `scripts/selfhost-check.sh` asserts that path exists in the built image), appends to `backup-cron-failures.log` AND fires `markoto-notify "Backup failed on <host>"`. Soft-fails if Apprise isn't configured (the wrapper exits 0 with no URLs set), so the cron doesn't go red on a misconfigured host.

The wrapper is intentionally tiny: it sources `/etc/markoto/apprise.env` and runs the `apprise` CLI installed under `/opt/markoto-tools/` with `markoto-notify "<title>" "<body>"`. Adding a new call site = `markoto-notify "<title>" "<body>"`. Don't shell out to `apprise` directly anywhere else; the wrapper centralises the env lookup + soft-fail behaviour.

## `group_vars` / vault structure

- **`group_vars/all.yml`** — non-secret defaults. Domain, image tag, paths, OS-hardening overrides, anything safe to commit in plaintext. Source of truth for "what version of markoto is deployed."
- **`group_vars/all.vault.example.yml`** — the secret template. Every `*_password` / `*_secret` / `*_key` from `.env.example` lives here, plus Apprise URLs and the GHCR pull token. The example file has REPLACE_ME placeholders and IS committed.
- **`group_vars/all.vault.yml`** — the encrypted secret bundle, encrypted with `ansible-vault encrypt` and gitignored: never commit it, encrypted or not (ciphertext in a public repo is an offline brute-force target). The vault password lives in `.vault-password` (mode `0600`, gitignored) so the Makefile can run unattended. CI does not use the vault: `deploy.yml` renders `.env` from GitHub Environment secrets via `render-env.sh`.

Editing the vault: `ansible-vault edit group_vars/all.vault.yml` opens `$EDITOR` against the decrypted contents and re-encrypts on save. Don't `cat` it then re-encrypt — that loses the per-line encryption that vault uses for diffability.

## Lint workflow

`make lint` runs ansible-lint (production profile, strict) and yamllint.

```bash
# One-time install (no system pip on Ubuntu — use --user or pipx):
pip install --user ansible-lint yamllint
# Or:
pipx install ansible-lint && pipx install yamllint

cd infra/
make lint
```

`.ansible-lint` is set to `offline: true` so the linter doesn't try to
re-fetch Galaxy deps on every run; CI is expected to run `make requirements`
first. `.yamllint` ships an `ignore:` list for `.ansible/` and `collections/`
so we're not linting Geerling's role files.

## What's hand-rolled and why

We deliberately did NOT replace these with Galaxy roles:

- **`roles/base/`** — application-specific OS bits (ufw rules tuned for our
  ports, fail2ban jail tuned to our maxretry/findtime, journald sized for our
  log volume, the markoto service account, OVH-specific LUKS warning). No
  Galaxy role covers this collection cleanly.
- **`roles/ssh_hardening/`** — `devsec.hardening.ssh_hardening` exists, but
  ours has a load-bearing safety check: it refuses to disable password auth
  if the markoto user has no `authorized_keys` yet, and it forces a handler
  flush + `meta: reset_connection` between sshd reload and the next play.
  devsec's flow is not tested against our "fresh OVH VPS, no user keys"
  path, so we keep our safer wrapper.
- **`roles/markoto/`** — entirely app-specific (compose file sync from the
  same git repo, `.env` render from our jinja template, `/api/health`
  retry-loop, `deploys.log` audit trail). Nothing to outsource.
- **`roles/backup_cron/`** — 30-line cron wrapper. `ansible.builtin.cron`
  IS the Galaxy answer; the role's just a tiny consumer.

## Deviations from `devsec.hardening.os_hardening` defaults

Documented in `playbooks/provision.yml`; reproduced here for visibility:

| Var | Default | Override | Why |
|---|---|---|---|
| `sysctl_overwrite.net.ipv4.ip_forward` | (CIS sets 0) | `1` | Docker bridge networking REQUIRES forwarding. CIS's "non-router default" silently breaks compose networking. |
| `os_auditd_enabled` | `true` | `false` | auditd is heavy (own log volume, separate forwarding pipeline). Audit signal already covered via Sentry (app) + journald/OVH (host). Reconsider when we have a SIEM that ingests auditd events. |
| `os_security_init_single` | `false` | `false` (pinned) | Single-user mode is part of the OVH rescue path. Keep available. Pinned explicitly so a future `os_hardening` bump can't flip it. |
| `os_security_init_prompt` | `true` | `false` | `/etc/issue` banner is cosmetic; SSH gates already cover us. |
| `os_ignore_users` | `[vagrant, kitchen]` | `+ markoto` | Otherwise password-ageing checks could lock out the daemon service account. |

## Idempotency

`make deploy` is safe to re-run any time:

- `.env` rendered atomically via the `template` module — diff-only updates.
- Compose files synced via `copy` — only changed files trigger compose re-eval.
- `docker_compose_v2` recreates only services whose config changed.
- `/api/health` probe with retry; soft-fail prints diagnostics on miss.

## Rollback

```bash
make rollback TAG=v1.2.3
```

Runs `playbooks/rollback.yml` with `target_image_tag=v1.2.3`: the `markoto` role re-renders `.env` with that `IMAGE_TAG`, pulls and runs `compose up -d`.
Logged as `ROLLBACK` in `/opt/markoto/deploys.log`.

## Disaster recovery

Same recipe as initial deploy:

1. Provision a new OVH VPS (note new IP), keep the same managed-PG + S3.
2. Edit `inventory.ini` → new IP.
3. `make provision && make deploy`.
4. Restore from latest gpg backup via the runbook in `docs/operations/DEPLOY.md` §6.

The managed Postgres holds all user data, so as long as it survives the
new VPS picks up the existing dataset on first boot.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ssh: connection refused` after provision | ssh hardening locked you out — pubkey path was wrong | OVH rescue console → restore a backed-up `~/.ssh/authorized_keys` |
| `/api/health` non-200 | DNS not propagated, ACME still in progress, or app crashed on boot | `make logs` → grep for `Invalid configuration` and `db-migrate` |
| `acme.json permission denied` | mode drifted | `chmod 600 /opt/markoto/traefik/acme.json` (the role enforces this on every run) |
| `IMAGE_TAG required` | image_tag missing from `group_vars/all.yml` | re-edit, re-deploy |
| Backup cron FAIL log growing | in-stack `backup` container down | `docker compose ps backup`, `docker compose logs backup`, restart |
| `the role 'devsec.hardening.os_hardening' was not found` | `make requirements` not run yet | `make requirements` |
| `docker bridge networking broken after provision` | os_hardening sysctl overrode `ip_forward` | confirm `sysctl_overwrite.net.ipv4.ip_forward: 1` is set in `provision.yml` |

## Secrets-in-vault (what's encrypted)

Every `_password`, `_secret`, `_key` from `.env.example` lives in
`group_vars/all.vault.yml`, encrypted with `ansible-vault encrypt` and
gitignored (see above). The vault password lives in `.vault-password`
(also gitignored).
