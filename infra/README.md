# markoto: Ansible deploy

Agentless, GPL-3.0, OVH-targeted automation. From "fresh Debian 13 VPS +
clicked managed Postgres + clicked S3 bucket" to a running stack in ~25
minutes. The hosted stack (staging and prod) runs on **rootless Podman** as
an unprivileged user; there is no Docker daemon on the hosts.

The click-by-click OVH walkthrough and the manual runbook (no Ansible) are
part of the operator runbook, kept outside this repository.

## Why Ansible (vs Terraform / Pulumi / OpenTofu)

- **Agentless**: SSH only. No daemon on the VPS, no state file to lose.
- **OSS, GPL-3.0**: no enterprise tier behind a paywall, no telemetry.
- **Configures-not-provisions**: the user clicks the OVH/Cloudflare buttons
  once; Ansible only configures the box. Matches the "single VPS, not a
  fleet" reality of this project.
- **Disaster recovery is one inventory edit**: VPS dead → spin a new one →
  update IP → re-run `make provision ENV=prod && make deploy ENV=prod`.

## The host model

| What | Where / who |
|---|---|
| OS | Debian 13 (trixie). `provision.yml` refuses anything else, and a host that has a Docker engine (reinstall instead of converting). |
| Admin login | the image's `debian` user (sudo). Ansible connects as it (`ansible_user=debian`) and becomes root. Root login and passwords are off. |
| Stack owner | `markoto`: a normal account without sudo or password, with a subordinate uid/gid range and lingering. Its only SSH key is the GitHub deploy key, installed with `restrict` (no forwarding, no pty). |
| Engine | Debian's Podman 5.4 (netavark, pasta), rootless, in `markoto`'s user namespace. The user unit `podman.socket` serves the Docker-compatible API at `/run/user/<uid>/podman/podman.sock`. |
| Compose | Docker Compose 5.7.0, standalone binary at `/usr/local/bin/docker-compose` (pinned, checksum-verified; Debian's `docker-compose` package is 2.x). |
| How to run it | `markoto-compose <args>` as `markoto`: sets `DOCKER_HOST` / `CONTAINER_SOCKET` to the user's socket, runs in `/opt/markoto` (whose `.env` sets `COMPOSE_FILE` and `COMPOSE_PROFILES`), exports the LiteLLM config hash. |
| Stack directory | `/opt/markoto` (owned by `markoto`): `.env`, `deploy/` (the repository's compose files + mounted config), `traefik/acme.json`, `secrets/`, `deploys.log`, `.last-deploy`. |
| Container storage | `~markoto/.local/share/containers` (images, named volumes such as `markoto_pg_data` on staging). |
| Start at boot | `markoto-stack.service`, a `markoto` user unit (`markoto-compose up -d`; `ExecStop` = `markoto-compose stop`). Lingering starts the user manager at boot. |
| Logs | journald (Podman's `log_driver`), bounded by journald's `SystemMaxUse=2G`. |
| Public 80/443 | `edge-proxy` (HAProxy, host network namespace) relays TCP to Traefik on `127.0.0.1:10080/10443` with a PROXY protocol v2 header carrying the client address. See "Edge and client addresses". |

### Why this shape

- **A user unit running Compose** (not Quadlet, not `podman-restart.service`):
  the boot path uses the same compose files, `depends_on` health gates and
  `db-init` one-shot as every deploy. Quadlet would mean translating the
  stack into unit files next to the compose files that self-hosters and the
  test stacks keep using; `podman-restart.service` starts only
  `restart: always` containers, in no particular order. Containers keep
  their own `restart: unless-stopped` policy for crashes.
- **`net.ipv4.ip_unprivileged_port_start=80` on the host** (not high ports
  plus an nftables redirect): one sysctl, no second rule set for locally
  generated traffic (the health probe from the host itself), nothing that
  interacts with ufw. The host runs nothing else that an ordinary user
  could impersonate on a port between 80 and 1023.
- **`/opt/markoto`** (not the user's home): every deploy path, the compose
  files' absolute mounts (`/opt/markoto/secrets`) and
  `scripts/selfhost-check.sh` already use it.

### Edge and client addresses

Rootless Podman publishes container ports through `rootlessport`, a
userspace proxy: the container sees the proxy's address, not the client's
(Podman 5.4; Podman 6 adds an experimental pasta forwarder that keeps it,
Debian 13 does not ship it). Without a fix every visitor would look like
one address to Traefik, and the app's per-IP rate limits and audit IPs
would collapse.

So `edge-proxy` (`deploy/config/edge/haproxy.cfg`) binds 80/443 in the
host's network namespace, sees the real client, and forwards the raw TCP
stream to Traefik's loopback ports with a PROXY protocol v2 header. TLS
stays in Traefik. Traefik trusts PROXY headers only from its own two
networks (`web` 10.213.80.0/24, `docker-api` 10.213.81.0/24, pinned in
`compose.prod.yml`), because rootlessport's source address is Traefik's IP
on one of them (which one varies between starts). A header from any other
address is ignored, and the client address would silently become that
address: keep the trust list and the subnets equal
(`scripts/selfhost-check.sh` checks it). `NUXT_TRUSTED_PROXY_HOPS` stays 1:
HAProxy adds no HTTP header, Traefik is the one HTTP proxy.

### Postgres

| | staging | prod |
|---|---|---|
| `POSTGRES_HOST` | `postgres` (the bundled container) | the managed cluster's host |
| `OVH_PG_HOST` | empty | the same host (turns on cert-pinned TLS: `PGSSLROOTCERT`, `POSTGRES_SSLMODE=require`) |
| `COMPOSE_PROFILES` (rendered) | `bundled-postgres` | empty: no Postgres container at all |

Every `depends_on: postgres` is `required: false`, so Compose waits for a
healthy container where it exists and ignores it where it does not.
`db-init` runs in both shapes, against `PGHOST`. `render-env.sh` refuses an
`OVH_PG_HOST` without a matching `POSTGRES_HOST`.

## Layout

```
infra/
├── Makefile                # convenience targets (provision/deploy/rollback/logs/ps/ssh/status/backup-test/lint)
├── README.md               # this file
├── ansible.cfg             # roles_path, ssh args, stdout callback
├── .ansible-lint           # production profile, offline by default
├── .yamllint               # 120-col, octal-strict (matches ansible-lint reqs)
├── requirements.yml        # Galaxy collections + roles (see §Galaxy deps)
├── inventories/            # one directory per environment (git-ignored except example/)
│   ├── example/            # template: hosts.ini, env.yml
│   ├── staging/            # hosts.ini, env.yml, vault.yml (encrypted), .vault-password
│   └── prod/               # same files, prod values
├── group_vars/
│   ├── all.yml             # non-secret defaults shared by every environment (paths, Compose pin)
│   └── all.vault.example.yml  # secret template for inventories/<env>/vault.yml
├── playbooks/
│   ├── provision.yml       # one-time: base + os_hardening + podman_host + security + ssh_hardening
│   ├── deploy.yml          # idempotent: markoto + backup_timer
│   ├── rollback.yml        # set target_image_tag, re-deploy
│   └── backup-test.yml     # restore drill: newest backup into a throwaway DB, then drop it
├── roles/                  # roles WE wrote, see §What's hand-rolled below
│   ├── base/               # ufw, fail2ban, journald, timezone, markoto user + deploy key, Apprise, LUKS check
│   ├── podman_host/        # Podman, sysctl, subids, lingering, podman.socket, Compose, markoto-compose, stack unit
│   ├── ssh_hardening/      # PasswordAuth no, root login no, validate before reload
│   ├── markoto/            # compose+env sync, GHCR login, pull, up -d, /api/health probe, prune, deploys.log
│   └── backup_timer/       # 03:00 UTC daily belt-and-braces backup (markoto user timer), notifies on failure
├── collections/            # Galaxy-installed deps (gitignored)
│   ├── ansible_collections/
│   └── ansible_roles/
├── files/                  # ovh-pg-ca.pem (drop here if pinning OVH managed PG)
├── render-env.sh           # renders /opt/markoto/.env: deploy.yml (GitHub Environment) and the markoto role (group_vars + vault)
└── render-env-test.sh      # pins render-env.sh (passthrough, --keys, required values, quoting, Postgres profile)
```

The compose files and the config they mount (LiteLLM, Postgres init, the
edge relay, the renderer's seccomp profile) live in `../deploy/`, not
Ansible-specific: the self-host installer and the test stacks use them too.
The role copies the production subset to the same relative paths under
`/opt/markoto`, where `markoto-compose <command>` works: the rendered
`.env` sets `COMPOSE_FILE=deploy/compose/compose.prod.yml:deploy/compose/compose.podman.yml`.

## Quick start

Each environment (staging, prod) is a directory `inventories/<env>/` with
four git-ignored files; every Make target takes `ENV=<env>`.

```bash
cd infra/
make requirements                            # install Galaxy collections + roles (once)
cp -r inventories/example inventories/prod   # then edit the two files:
#   hosts.ini: ansible_host=<VPS_IP>, ansible_user=debian, your admin key,
#              markoto_deploy_pubkey (public half of DEPLOY_SSH_KEY)
#   env.yml:   domain, acme_email, ovh_pg_host (prod: the managed cluster), ...
cp group_vars/all.vault.example.yml inventories/prod/vault.yml
# edit inventories/prod/vault.yml: apprise_urls at least (provisioning);
# every REPLACE_ME only if you deploy with `make deploy` instead of the workflow
(umask 077; openssl rand -base64 32 | tr -d '\n' > inventories/prod/.vault-password)
ansible-vault encrypt inventories/prod/vault.yml --vault-password-file=inventories/prod/.vault-password
# keep the password in the password manager too (Proton Pass: <env>/ANSIBLE_VAULT_PASSWORD)
# Optional: drop the OVH managed-PG CA at files/ovh-pg-ca.pem

make provision ENV=prod                      # ~5–10 min
make deploy ENV=prod                         # ~5 min (or the GitHub deploy workflow)
make status ENV=prod                         # curl /api/health
```

Every playbook loads `group_vars/all.yml`, then `inventories/<env>/env.yml`
and `inventories/<env>/vault.yml` (later files win).

## Operating the host

Log in as the admin user, then become the stack owner:

```bash
ssh debian@<host>
sudo -iu markoto              # its ~/.profile sets XDG_RUNTIME_DIR and DOCKER_HOST
# or a full user session:   sudo machinectl shell markoto@
```

| Task | Command (as `markoto`) |
|---|---|
| Containers | `markoto-compose ps` |
| Logs of a service | `markoto-compose logs -f --tail=200 app` |
| Logs from the journal | `journalctl --user -t markoto-app-1 --since -1h` (the tag is the container name) |
| Restart one service | `markoto-compose restart app` |
| Restart the stack | `systemctl --user restart markoto-stack` (= `markoto-compose stop` + `up -d`) |
| Boot unit status | `systemctl --user status markoto-stack podman.socket` |
| Backup timer | `systemctl --user list-timers markoto-backup.timer`, `journalctl --user -u markoto-backup` |
| Run a backup now | `markoto-backup-now` |
| Disk | `podman system df`, `podman image prune -f` |

`make logs ENV=<env>` and `make ps ENV=<env>` run the first two through
Ansible from the control machine.

## Galaxy dependencies (and why)

`requirements.yml` pins the roles and `devsec.hardening` to an exact version (the other collections have a minimum version). Surprise upgrades on
apt handling or CIS sysctl baselines are exactly what we want to NOT absorb
silently, bumps land via PR after manual review.

| Dep | Version | Why |
|---|---|---|
| `community.general` | `>=8.0.0` | `ufw`, `timezone` modules. |
| `ansible.posix` | `>=1.5.4` | `authorized_key`, `sysctl` modules. |
| `devsec.hardening` | `10.5.2` | CIS-aligned `os_hardening` role, replaces ~50 lines of hand-rolled sysctl/PAM/perm tuning we'd have to chase as CIS evolves. |
| `geerlingguy.security` | `3.0.0` | Unattended upgrades + reboot window. |

Podman comes from Debian's own archive (no third-party repository); Docker
Compose is one pinned release binary (`compose_version` + `compose_sha256`
in `group_vars/all.yml`).

## Apprise notification wrapper (`/usr/local/bin/markoto-notify`)

A single entry point for "something noteworthy happened on the box, ping me." Dropped onto the VPS by `roles/base/`; reads its config from `/etc/markoto/apprise.env` (`root:markoto`, mode `0640`, so the stack owner's backup timer can notify) which contains semicolon-separated Apprise URLs (`apprise_urls` from the vault). Supports any of Apprise's 100+ services, Telegram is the working default, but the env variable is the only thing that pins it to one provider.

**Call sites:**

- **APT post-invoke hook** (`/etc/apt/apt.conf.d/99-markoto-notify` → `/usr/local/sbin/markoto-apt-notify`, written by `roles/base/tasks/main.yml`), after an apt run it sends the tail of the unattended-upgrades log, so OS updates surface in the operator's notifications without a `mail` setup.
- **Backup timer failure path** (`roles/backup_timer/tasks/main.yml`): `markoto-backup-now` runs `/usr/local/bin/backup.sh --once` in the sidecar (non-zero exit on a failed dump/upload; `scripts/selfhost-check.sh` asserts that path exists in the built image) and fires `markoto-notify "Backup failed on <host>"` with the last lines of its output. Soft-fails if Apprise isn't configured (the wrapper exits 0 with no URLs set).

The wrapper is intentionally tiny: it sources `/etc/markoto/apprise.env` and runs the `apprise` CLI installed under `/opt/markoto-tools/` with `markoto-notify "<title>" "<body>"`. Adding a new call site = `markoto-notify "<title>" "<body>"`. Don't shell out to `apprise` directly anywhere else; the wrapper centralises the env lookup + soft-fail behaviour.

## Variables and vault structure

- **`group_vars/all.yml`**: non-secret defaults shared by every environment: paths, the Compose pin, OS-hardening overrides, anything safe to commit in plaintext.
- **`inventories/<env>/env.yml`**: this environment's non-secret values (domain, ACME email, registry, image tag, managed Postgres host, the published-pages host). Git-ignored.
- **`group_vars/all.vault.example.yml`**: the secret template. Every `*_password` / `*_secret` / `*_key` from `.env.example` lives here, plus Apprise URLs and the optional GHCR pull token (`ghcr_pull_user` / `ghcr_pull_token`). The example file has REPLACE_ME placeholders and IS committed.
- **`inventories/<env>/vault.yml`**: the environment's encrypted secrets (`ansible-vault`), git-ignored: never commit it, encrypted or not (ciphertext in a public repo is an offline brute-force target). Its password is `inventories/<env>/.vault-password` (mode `0600`, git-ignored, also kept in the password manager). Provisioning needs only `apprise_urls`; the rest matters only for `make deploy`. CI does not use the vault: `deploy.yml` renders `.env` from GitHub Environment secrets via `render-env.sh`, and writes the GHCR login from `GHCR_PULL_USER` / `GHCR_PULL_TOKEN`.

Editing a vault: `ansible-vault edit inventories/<env>/vault.yml --vault-password-file=inventories/<env>/.vault-password` opens `$EDITOR` against the decrypted contents and re-encrypts on save.

## Private images (GHCR)

While `ghcr.io/markoto-app/*` is private, the host pulls with a read-only
token (`read:packages` only). It is stored for `markoto` in
`~/.docker/config.json` (0600): Docker Compose sends it with each pull, and
Podman reads the same file as a fallback. Both deploy paths write it when a
token is configured and leave the host alone when not: the GitHub workflow
from `GHCR_PULL_USER` (variable) + `GHCR_PULL_TOKEN` (secret) on every
deploy, the `markoto` role from `ghcr_pull_user` / `ghcr_pull_token`. Once
the images are public, delete the secret and the file.

## Lint workflow

`make lint` runs ansible-lint (production profile, strict) and yamllint.

```bash
# One-time install:
uv tool install ansible-core && uv tool install ansible-lint && uv tool install yamllint
# Or: pipx install ansible-lint && pipx install yamllint

cd infra/
make requirements   # ansible-lint resolves the Galaxy roles
make lint
make syntax-check
```

`.ansible-lint` is set to `offline: true` so the linter doesn't try to
re-fetch Galaxy deps on every run; CI is expected to run `make requirements`
first. `.yamllint` ships an `ignore:` list for `.ansible/` and `collections/`
so we're not linting Geerling's role files.

## What's hand-rolled and why

We deliberately did NOT replace these with Galaxy roles:

- **`roles/base/`**: application-specific OS bits (ufw rules tuned for our
  ports, fail2ban jail tuned to our maxretry/findtime, journald sized for our
  log volume, the markoto service account, OVH-specific LUKS warning). No
  Galaxy role covers this collection cleanly.
- **`roles/podman_host/`**: the rootless engine for exactly one service
  account, plus our Compose pin, wrapper and boot unit. Generic Podman roles
  target root Podman or Quadlet.
- **`roles/ssh_hardening/`**: `devsec.hardening.ssh_hardening` exists, but
  ours has a load-bearing safety check: it refuses to disable password auth
  if the admin user has no `authorized_keys` yet, and it forces a handler
  flush + `meta: reset_connection` between sshd reload and the next play.
- **`roles/markoto/`**: entirely app-specific (compose file sync from the
  same git repo, `.env` render through `infra/render-env.sh`, `/api/health`
  retry-loop, `deploys.log` audit trail). Nothing to outsource.
- **`roles/backup_timer/`**: a script and two user units.

## Deviations from `devsec.hardening.os_hardening` defaults

Documented in `playbooks/provision.yml`; reproduced here for visibility:

| Var | Default | Override | Why |
|---|---|---|---|
| `sysctl_overwrite.kernel.unprivileged_userns_clone` | `0` (devsec's Debian vars) | `1` | Rootless Podman needs unprivileged user namespaces, and so does Chromium's sandbox in the renderer. |
| `sysctl_overwrite.net.ipv4.ip_forward` | `0` | (not overridden) | Docker needed forwarding on the host; rootless Podman routes in its own network namespace (pasta, user space), so the CIS default stays. |
| `os_filesystem_whitelist` | `[]` | `[vfat]` when a vfat filesystem is mounted | The EFI system partition is vfat; banning the module would fail its mount at the next boot. |
| `os_auditd_enabled` | `true` | `false` | auditd is heavy (own log volume, separate forwarding pipeline). Audit signal already covered via Sentry (app) + journald/OVH (host). Reconsider when we have a SIEM that ingests auditd events. |
| `os_security_init_single` | `false` | `false` (pinned) | Single-user mode is part of the OVH rescue path. Keep available. Pinned explicitly so a future `os_hardening` bump can't flip it. |
| `os_security_init_prompt` | `true` | `false` | `/etc/issue` banner is cosmetic; SSH gates already cover us. |
| `os_ignore_users` | `[vagrant, kitchen]` | `+ markoto` | Otherwise password-ageing checks could lock out the service account. |

## Idempotency

`make deploy` is safe to re-run any time:

- `.env` rendered by `infra/render-env.sh` and written atomically via the `copy` module, diff-only updates.
- Compose files synced via `copy`, only changed files trigger compose re-eval.
- `markoto-compose up -d` recreates only services whose config changed.
- `/api/health` probe with retry; soft-fail prints diagnostics on miss.
- `make provision` a second time reports no changes.

## Rollback

```bash
make rollback ENV=prod TAG=v1.2.3
```

Runs `playbooks/rollback.yml` with `target_image_tag=v1.2.3`: the `markoto` role re-renders `.env` with that `IMAGE_TAG`, pulls and runs `markoto-compose up -d`.
Logged as `ROLLBACK` in `/opt/markoto/deploys.log`. The GitHub deploy
workflow rolls back by itself when the new tag fails its health check: it
returns to the tag in `/opt/markoto/.last-deploy`, whose images are kept by
the post-deploy prune.

## Disaster recovery

Same recipe as initial deploy:

1. Provision a new OVH VPS with Debian 13 (note new IP), keep the same managed-PG + S3.
2. Edit `inventories/prod/hosts.ini` → new IP. Pin the new host key in the GitHub Environment (`DEPLOY_KNOWN_HOSTS`).
3. `make provision ENV=prod && make deploy ENV=prod`.
4. Restore from latest gpg backup (`gpg --decrypt | gunzip | psql`, see the operator runbook, kept outside this repository).

The managed Postgres holds all user data, so as long as it survives the
new VPS picks up the existing dataset on first boot.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ssh: connection refused` after provision | ssh hardening locked you out, pubkey path was wrong | OVH rescue console → restore a backed-up `~/.ssh/authorized_keys` of `debian` |
| `/api/health` non-200 | DNS not propagated, ACME still in progress, or app crashed on boot | `make logs` → grep for `Invalid configuration` and `db-migrate` |
| `markoto-compose: no Podman socket` | the user manager or `podman.socket` is not running | as `markoto`: `systemctl --user enable --now podman.socket`; `loginctl show-user markoto -p Linger` must say `yes` |
| Every request comes from one IP (rate limits hit everyone, audit IPs all `10.213.80.x`) | Traefik ignores the PROXY header: its trust list and the pinned subnets differ, or `edge-proxy` is down | `markoto-compose ps edge-proxy`; compare `proxyProtocol.trustedIPs` with the `web` / `docker-api` subnets in `compose.prod.yml` |
| `edge-proxy` exits: `cannot bind socket [0.0.0.0:80]` | `net.ipv4.ip_unprivileged_port_start` is above 80 | `sysctl net.ipv4.ip_unprivileged_port_start` (expect 80); re-run `make provision` |
| `acme.json permission denied` | mode drifted | `chmod 600 /opt/markoto/traefik/acme.json` (the role enforces this on every run) |
| `IMAGE_TAG required` | image_tag missing from `group_vars/all.yml` | re-edit, re-deploy |
| Pull fails with `403 Forbidden` / `denied` from ghcr.io | the images are private and the host has no (valid) token | set `GHCR_PULL_USER` / `GHCR_PULL_TOKEN` (or the vault values) and deploy again |
| Backup timer failures | in-stack `backup` container down | `markoto-compose ps backup`, `markoto-compose logs backup`, `journalctl --user -u markoto-backup` |
| `the role 'devsec.hardening.os_hardening' was not found` | `make requirements` not run yet | `make requirements` |
| `potentially insufficient UIDs or GIDs available in user namespace` | the subordinate range of `markoto` is too small (needs 65536) | `grep markoto /etc/subuid /etc/subgid`; fix the range, then `podman system migrate` as `markoto` |
| Renders fail with "No usable sandbox!" | unprivileged user namespaces are off | `sysctl kernel.unprivileged_userns_clone` (expect 1), see `docs/SECURITY-HARDENING.md` §C.2 |

## Secrets-in-vault (what's encrypted)

Every `_password`, `_secret`, `_key` from `.env.example` lives in
`inventories/<env>/vault.yml`, encrypted with `ansible-vault encrypt` and
git-ignored (see above). The vault password lives in
`inventories/<env>/.vault-password` (also git-ignored).
