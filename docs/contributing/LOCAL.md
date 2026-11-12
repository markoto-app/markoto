# Local full stack

Runs the production shape on your machine: every service in a container, Traefik with TLS, locally trusted certificates. Daily development uses `deploy/compose/compose.dev.yml` and `bun run dev` on the host instead; use this to check Traefik labels, TLS behaviour, or anything that only shows up in containers.

Prerequisites: Docker Compose 5.0 or newer, and a `.env` (run `make setup` once; it generates the required secrets).

## 1. Install mkcert

```bash
# macOS
brew install mkcert nss

# Linux (Debian/Ubuntu): mkcert ships in the standard repos
sudo apt install -y mkcert libnss3-tools
```

Then install the local CA (or `make mkcert-install`):

```bash
mkcert -install
```

This adds mkcert's root CA to your OS and browser trust stores, so browsers on this machine trust every certificate mkcert issues.

## 2. Generate the certificate

`make certs` does this (and `make local-up` runs it when the files are missing). By hand:

```bash
cd deploy/config/traefik/local
mkcert -cert-file ypad.127.0.0.1.nip.io.pem \
       -key-file  ypad.127.0.0.1.nip.io-key.pem \
       "ypad.127.0.0.1.nip.io" "*.ypad.127.0.0.1.nip.io"
```

The two `.pem` files are gitignored. The bare name covers the app; the wildcard covers `sync.ypad.127.0.0.1.nip.io` and the published-pages host `pages.ypad.127.0.0.1.nip.io`.

### Why nip.io

`*.127.0.0.1.nip.io` resolves to `127.0.0.1` without editing `/etc/hosts`. No DNS changes and no `sudoers` edits are needed, and it works from any browser on the machine.

## 3. Start the stack

```bash
make local-up     # = docker compose --env-file .env -f deploy/compose/compose.local.yml up -d --build
```

The first build takes a few minutes (base images, the Nuxt app, the sync server, the renderer and markitdown).

Verify:

```bash
curl -I https://ypad.127.0.0.1.nip.io/api/health        # 200
curl -I https://sync.ypad.127.0.0.1.nip.io/health       # 200
```

Open https://ypad.127.0.0.1.nip.io; the browser shows a valid certificate.

## 4. OAuth providers (optional for local)

Anonymous editing works without OAuth keys. To test sign-in, create OAuth apps with the callback URLs `https://ypad.127.0.0.1.nip.io/auth/github` and `/auth/google`, and put the credentials into `.env` (or your shell) before starting the stack:

```bash
NUXT_OAUTH_GITHUB_CLIENT_ID=...
NUXT_OAUTH_GITHUB_CLIENT_SECRET=...
```

The UI offers only the providers that are configured.

## 5. Teardown

```bash
make local-down    # make local-clean also wipes the Postgres and SeaweedFS volumes
```

## Troubleshooting

- **`ERR_CERT_AUTHORITY_INVALID`**: `mkcert -install` was not run, or did not reach the browser's trust store (Firefox has its own; `mkcert -install` covers it when `nss` / `libnss3-tools` is installed).
- **Traefik finds no certificate**: check `docker compose --env-file .env -f deploy/compose/compose.local.yml logs traefik`. The `.pem` file names in `deploy/config/traefik/local/tls.yml` must match the files in `deploy/config/traefik/local/`.
- **Port 443 already in use**: another stack or a local reverse proxy holds it (`sudo lsof -i :443`).
- **No `host.docker.internal`**: unlike the dev stack, the app runs in a container here, so the sync server reaches it at `http://app:3000`.
- **A change to `renderer/` or `sync-server/` has no effect after `docker compose restart`**: `restart` reuses the existing image. Rebuild with `docker compose --env-file .env -f deploy/compose/compose.local.yml up -d --build renderer` (or `sync`); the same applies to the dev stack.
