# markoto — Ansible deploy

Agentless, GPL-3.0, OVH-targeted automation. From "fresh VPS IP + clicked
managed Postgres + clicked S3 bucket" to a running stack in ~25 minutes.

For the click-by-click walkthrough see [`../docs/DEPLOY-OVH.md`](../docs/DEPLOY-OVH.md).
For the manual runbook (no Ansible) see [`../docs/DEPLOY.md`](../docs/DEPLOY.md).

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
├── Makefile                # convenience targets (provision/deploy/rollback/logs/ssh/status)
├── README.md               # this file
├── ansible.cfg             # roles_path, ssh args, stdout callback
├── requirements.yml        # community.general, community.docker, ansible.posix
├── inventory.example.ini   # template — fill in VPS IP
├── group_vars/
│   ├── all.yml             # non-secret defaults (domain, image tag, paths)
│   └── all.vault.example.yml  # secret template — encrypt before commit
├── playbooks/
│   ├── provision.yml       # one-time: base + ssh_hardening + docker
│   ├── deploy.yml          # idempotent: markoto + backup_cron
│   ├── rollback.yml        # set target_image_tag, re-deploy
│   └── backup-test.yml     # decrypt + sniff most-recent gpg backup
├── roles/
│   ├── base/               # apt, ufw, fail2ban, journald, timezone, LUKS check, markoto user
│   ├── ssh_hardening/      # PasswordAuth no, root login no, validate before reload
│   ├── docker/             # docker-ce + compose plugin via apt repo, daemon.json
│   ├── markoto/            # compose+env sync, pull, up -d, /api/health probe, deploys.log
│   └── backup_cron/        # 03:00 UTC daily belt-and-braces backup with failure log
├── files/                  # ovh-pg-ca.pem (drop here if pinning OVH managed PG)
└── templates/
    └── env.j2              # renders /opt/markoto/.env from group_vars + vault
```

## Quick start

```bash
cd infra/
make requirements                            # install collections (once)
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

Re-renders `.env` with `IMAGE_TAG=v1.2.3` and runs `compose up -d --pull missing`.
Tagged in `/opt/markoto/deploys.log`.

## Disaster recovery

Same recipe as initial deploy:

1. Provision a new OVH VPS (note new IP), keep the same managed-PG + S3.
2. Edit `inventory.ini` → new IP.
3. `make provision && make deploy`.
4. Restore from latest gpg backup via the runbook in `docs/DEPLOY.md` §6.

The managed Postgres holds all user data, so as long as it survives the
new VPS picks up the existing dataset on first boot.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ssh: connection refused` after provision | ssh hardening locked you out — pubkey path was wrong | OVH rescue console → restore a backed-up `~/.ssh/authorized_keys` |
| `/api/health` non-200 | DNS not propagated, ACME still in progress, or app crashed on boot | `make logs` → grep for `validate-secrets` and `db-migrate` |
| `acme.json permission denied` | mode drifted | `chmod 600 /opt/markoto/traefik/acme.json` (the role enforces this on every run) |
| `IMAGE_TAG required` | image_tag missing from `group_vars/all.yml` | re-edit, re-deploy |
| Backup cron FAIL log growing | in-stack `backup` container down | `docker compose ps backup`, `docker compose logs backup`, restart |

## Secrets-in-vault (what's encrypted)

Every `_password`, `_secret`, `_key` from `.env.example` lives in
`group_vars/all.vault.yml`. The vault file is encrypted with
`ansible-vault encrypt`; the encrypted form is safe to commit. The
plaintext is gitignored. The vault password lives in `.vault-password`
(also gitignored) so the Makefile can run unattended in CI later.
