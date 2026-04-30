# Local Full-Stack Runbook

For reproducing the production stack on your dev machine — all containers, Traefik TLS, locally-trusted certs. Daily dev usually uses `docker-compose.dev.yml` + `bun run dev` on the host instead; use this when you need to verify Traefik labels, TLS behaviour, or anything that only manifests in containers.

## 1. Install mkcert

```bash
# macOS
brew install mkcert nss

# Linux (Debian/Ubuntu)
sudo apt install libnss3-tools
curl -L https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64 -o /usr/local/bin/mkcert
chmod +x /usr/local/bin/mkcert
```

Then install the local CA:

```bash
mkcert -install
```

This adds mkcert's root CA to your OS/browser trust store. Browsers on this machine will now trust any cert mkcert issues.

## 2. Generate the cert

```bash
cd traefik/local
mkcert -cert-file ypad.127.0.0.1.nip.io.pem \
       -key-file  ypad.127.0.0.1.nip.io-key.pem \
       "ypad.127.0.0.1.nip.io" "*.ypad.127.0.0.1.nip.io"
```

The two `.pem` files are gitignored. The wildcard covers `sync.ypad.127.0.0.1.nip.io`; the bare name covers the app host itself.

### Why nip.io

`*.127.0.0.1.nip.io` resolves to `127.0.0.1` without editing `/etc/hosts`. No DNS changes, no `sudoers` fiddling — just works from any browser on the machine.

## 3. Start the stack

```bash
docker compose -f docker-compose.local.yml up -d --build
```

First build takes a few minutes (pulls base images, builds the Nuxt app, builds sync-server and markitdown).

Verify:

```bash
curl -I https://ypad.127.0.0.1.nip.io/api/health        # 200
curl -I https://sync.ypad.127.0.0.1.nip.io/health       # 200
```

Open https://ypad.127.0.0.1.nip.io — browser shows a valid cert (no warning page).

## 4. OAuth providers (optional for local)

Anonymous editing works without OAuth keys. If you want to test login flows locally, create additional OAuth apps with callback URLs `https://ypad.127.0.0.1.nip.io/auth/github` / `/auth/google`. Put the creds in your shell env before `docker compose up`:

```bash
export GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...
```

`docker-compose.local.yml` picks them up via the `${...:-}` defaults (falls back to empty if unset — login buttons will then 500 when clicked, which is fine).

## 5. Teardown

```bash
docker compose -f docker-compose.local.yml down
```

Add `-v` to wipe the Postgres and SeaweedFS volumes.

## Troubleshooting

- **`ERR_CERT_AUTHORITY_INVALID`** — `mkcert -install` wasn't run, or wasn't run in the browser's trust store (Firefox uses its own; `mkcert -install` handles it if `nss` is installed).
- **Traefik says "no certificate found"** — check `docker compose -f docker-compose.local.yml logs traefik`. Likely the `.pem` filenames in `traefik/local/tls.yml` don't match what mkcert produced. mkcert's default output names are `./<first-name>.pem` and `./<first-name>-key.pem` when using `-cert-file`/`-key-file`.
- **Port 443 already in use** — another Docker stack or a local reverse proxy is holding it. `sudo lsof -i :443`.
- **`host.docker.internal` not needed** — unlike `dev.yml`, in `local.yml` the app is itself in a container, so sync reaches it at `http://app:3000` directly.
- **Source change to `renderer/` or `sync-server/` doesn't take effect after `docker compose restart`** — `restart` only kicks the EXISTING container; it does NOT rebuild the image. Use `docker compose -f docker-compose.dev.yml up -d --build renderer` (or `sync`) instead. Same applies to `docker-compose.local.yml`. Symptoms: edits don't show up, console.log changes invisible, fixes appear to do nothing.
