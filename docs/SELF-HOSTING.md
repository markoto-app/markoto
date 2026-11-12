# Self-hosting markoto

Run the whole markoto stack on one Linux machine with Docker. The self-hosted
instance runs the same code and images as the hosted service at markoto.app;
everything that differs is configuration.

- [Requirements](#requirements)
- [Install](#install)
- [What runs](#what-runs)
- [Login](#login)
- [AI](#ai)
- [Configuration reference](#configuration-reference)
- [Ports and networking](#ports-and-networking)
- [Upgrades](#upgrades)
- [Upgrade notes](#upgrade-notes)
- [Backups and restore](#backups)
- [Re-embedding the knowledge base](#re-embedding)
- [Legal pages](#legal-pages)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Getting help](#getting-help)

## Requirements

- Linux host with Docker Engine and the Compose plugin **v5.0 or newer** (`docker compose version`; current Docker Engine packages ship it). The compose files extend a shared base with `include:` and override its services, which Compose 2.24–2.40 reject with "conflicts with imported resource".
- `openssl` and `curl` (for `install.sh`).
- About 6 GB of RAM for a small instance (the containers have memory caps that add up to more, but they are limits, not reservations) and 15 GB of disk for images plus your data.
- For HTTPS: a domain whose DNS A/AAAA record points at the host, and ports 80 and 443 reachable from the internet.
- Internet access is not needed at runtime for writing, the live preview and PDF export: the preview's scripts (paged.js, Mermaid), the math and code-highlighting styles and every web font are served by the instance itself, so visitors' browsers and the PDF renderer request nothing from a CDN or from Google Fonts. An instance on an air-gapped network renders previews and PDFs; only sign-in through GitHub / Google, the AI providers and email need their external services. Building the images from source needs the npm registry once (`bun install`), nothing else.

## Install

```sh
git clone https://github.com/joelbarmettlerUZH/markoto.app.git markoto
cd markoto
git checkout v0.0.9        # optional: pin a release; the installer then uses the matching images
./install.sh
```

The installer asks for:

1. **A domain** for HTTPS with Let's Encrypt, or nothing for **plain HTTP** on a port you choose (LAN use, or behind your own TLS reverse proxy).
2. **Admin email(s)**: these accounts become instance admins on their first login.
3. **Login** (optional): your own OpenID Connect provider and/or a GitHub / Google OAuth app. See [Login](#login).
4. **AI keys** (optional): Mistral (instance default for chat and voice), Jina (knowledge-base embeddings and the `fetch_url` tool), Staan (the `web_search` tool).

It then checks Docker, generates every secret with `openssl rand`, writes `.env` (mode 0600), pulls the images, starts the stack and waits until the app reports healthy. Secrets are never printed.

Non-interactive (every question has a flag; `./install.sh help` lists them):

```sh
# HTTPS
./install.sh -y --domain docs.example.org --acme-email ops@example.org --admin-email you@example.org

# Plain HTTP on port 8080
./install.sh -y --http-port 8080 --admin-email you@example.org
```

Re-running `./install.sh` is safe: existing secrets are kept, current values are offered as defaults. After the first install, the normal Compose commands work from the repository directory, because `.env` selects the compose files (`COMPOSE_FILE`) and the project name:

```sh
docker compose ps
docker compose logs -f app
docker compose up -d        # after editing .env
```

`install.sh` refuses to overwrite a `.env` it didn't write (for example a development `.env`). Use `--env-file PATH` to keep the self-host configuration elsewhere; then pass the same file to Compose (`docker compose --env-file PATH ...`).

### Images

By default the stack pulls `ghcr.io/joelbarmettleruzh/markoto-{app,sync,renderer,markitdown,backup}` at `IMAGE_TAG`. The installer picks the release tag of the checked-out commit, else the newest release tag reachable from it, and only falls back to the moving `latest` when the checkout has no tags (for example a shallow clone). Pass `--tag vX.Y.Z` to choose explicitly. Release images are signed (see [Verifying images](#verifying-images)). If the images can't be pulled, it falls back to building them from the checkout.

To always build from source:

```sh
./install.sh --build
```

This adds `deploy/compose/compose.selfhost.build.yml` to `COMPOSE_FILE`. After `git pull`, rebuild with `docker compose build && docker compose up -d` (or `./install.sh upgrade`).

### Verifying images

Release images are signed keyless with [cosign](https://docs.sigstore.dev/cosign/overview/) (GitHub OIDC, recorded in the public Rekor log) and carry a build provenance + SBOM attestation. Verify one before running it:

```sh
cosign verify ghcr.io/joelbarmettleruzh/markoto-app:vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity 'https://github.com/joelbarmettlerUZH/markoto.app/.github/workflows/release.yml@refs/heads/main'
```

Prefer a pinned `vX.Y.Z` tag over `latest`, which moves with every release.

## What runs

| Service | Image | Purpose |
|---|---|---|
| `traefik` | `traefik:v3` | The only service with a published port. Routes `/` to the app, `/sync` to Hocuspocus and `/<bucket>/…` to SeaweedFS, all on one origin. Let's Encrypt in HTTPS mode. |
| `socket-proxy` | `tecnativa/docker-socket-proxy` | Read-only Docker API for Traefik (container list and events only); Traefik never gets the Docker socket itself. |
| `app` | `markoto-app` | Nuxt (SSR + API + OAuth). Runs database migrations on start. |
| `sync` | `markoto-sync` | Hocuspocus (real-time collaboration over WebSocket). |
| `renderer` | `markoto-renderer` | Headless Chromium for server-side PDF export, with Chromium's own sandbox (needs the seccomp profile `deploy/config/renderer/seccomp.json` from the checkout). |
| `markitdown` | `markoto-markitdown` | DOCX / PDF / PPTX / XLSX / HTML / EPUB import, knowledge-file parsing. |
| `postgres` | `pgvector/pgvector:pg16` | All application data, document state, knowledge vectors. Volume `pg_data`. |
| `valkey` | `valkey/valkey:9` | Rate limits, locks, per-document sync state. Volume `valkey_data`. |
| `seaweedfs` | `chrislusf/seaweedfs` | S3-compatible storage: images, knowledge uploads (deleted after processing), PDF renders, data exports, backups. Volume `seaweed_data`. |
| `s3-init` | `markoto-backup` | One-shot: creates the bucket. |
| `litellm` | `ghcr.io/berriai/litellm` | AI gateway. Starts without any provider key. Admin UI off. |
| `db-init` | `pgvector/pgvector:pg16` | One-shot on every start: creates the `litellm` database and the separate database roles for the app and LiteLLM (`deploy/config/postgres/db-init.sh`). |
| `backup` | `markoto-backup` | Optional (`COMPOSE_PROFILES=backup`, on by default): encrypted `pg_dump` into the bucket. |

Every container runs without Linux capabilities and with `no-new-privileges`; the app, sync, renderer, markitdown, LiteLLM, Valkey and Traefik run as non-root users (Traefik: root without capabilities) on a read-only root filesystem. Details: [SECURITY-HARDENING.md, section C](SECURITY-HARDENING.md#section-c--containers-networks-and-database-roles).

The compose files: `deploy/compose/compose.selfhost.yml` (everything, plain HTTP), `deploy/compose/compose.selfhost.tls.yml` (HTTPS overlay), `deploy/compose/compose.selfhost.build.yml` (build-from-source overlay). They include `deploy/compose/compose.base.yml`, which the hosted deployment shares.

## Login

Users sign in with **your own OpenID Connect provider** (Authentik, Keycloak, Authelia, Pocket ID, Zitadel, Dex, ...) and/or **GitHub** and **Google** OAuth. Without any of them the instance is **anonymous-only**: anyone who can reach it can create, edit and share public documents, import files and export PDFs, but nobody can own documents, use workspaces, upload images, use AI or reach `/admin`. The login buttons are hidden and the account menu says sign-in isn't set up.

### Your own identity provider (OpenID Connect)

Register markoto at your IdP as a **confidential client** (client id + secret) for the **authorization code** flow:

- Redirect URI: `https://docs.example.org/auth/oidc`
- Scopes: `openid email profile`
- PKCE `S256` (markoto always sends it; enforce it at the IdP if it offers the switch)
- ID tokens signed with an asymmetric algorithm (RS256 / ES256 / ..., the default everywhere); HS256 tokens are rejected

Then set, in `.env` (or `./install.sh --oidc-issuer URL --oidc-client-id ID --oidc-client-secret S --oidc-name Authentik`):

| Variable | Value |
|---|---|
| `NUXT_OAUTH_OIDC_ISSUER` | The issuer, exactly as the `issuer` field of `<issuer>/.well-known/openid-configuration` (trailing slash included if your IdP has one). Must be `https://`. |
| `NUXT_OAUTH_OIDC_CLIENT_ID` / `_SECRET` | The client's credentials. Issuer, id and secret are all-or-nothing: a partial set stops the app at boot. |
| `NUXT_OAUTH_OIDC_NAME` | Optional button label: "Continue with *Authentik*". Empty: "Continue with single sign-on". |
| `NUXT_OAUTH_OIDC_SCOPES` | Optional, default `openid email profile` (`openid` is always added). |

`docker compose up -d`, and the sign-in menu shows the button (first, before GitHub/Google). Issuer values for common IdPs:

| IdP | Issuer |
|---|---|
| Keycloak | `https://sso.example.org/realms/<realm>` |
| Authentik | `https://auth.example.org/application/o/<application-slug>/` |
| Authelia | `https://auth.example.org` |
| Pocket ID | `https://id.example.org` |
| Zitadel | `https://<instance>.zitadel.cloud` (or your domain) |
| Dex | the `issuer:` from its config |

**Example: Keycloak** (verified against Keycloak 26.8). In the realm: *Clients → Create client* → type OpenID Connect, client id `markoto` → *Client authentication* on, *Standard flow* on (Direct access grants off) → *Valid redirect URIs* `https://docs.example.org/auth/oidc`, *Web origins* `https://docs.example.org` → save; *Advanced → Proof Key for Code Exchange Code Challenge Method* `S256`; copy the secret from *Credentials*. Then:

```bash
NUXT_OAUTH_OIDC_ISSUER=https://sso.example.org/realms/myrealm
NUXT_OAUTH_OIDC_CLIENT_ID=markoto
NUXT_OAUTH_OIDC_CLIENT_SECRET=<from the Credentials tab>
NUXT_OAUTH_OIDC_NAME=Keycloak
```

Keycloak puts `email_verified` in the token from the user's *Email verified* flag; tick it (or let users verify their address) for the accounts that should be linked or become admin, see below.

**How accounts are matched.** An IdP account is identified by the pair (issuer, `sub`), never by its email; renaming a user or changing their email at the IdP keeps the same markoto account. The email is used only when the IdP asserts `email_verified: true`; otherwise markoto stores no email for that user. A verified email:

- links the sign-in to an existing markoto account with the same email (e.g. someone who used GitHub before), the same rule as GitHub/Google. An account that already has an IdP identity is never re-pointed to another one;
- is matched against `NUXT_ADMIN_USER_EMAILS` for the admin bootstrap;
- is what workspace invitations look up.

So an IdP that lets people self-register with unverified addresses can't be used to take over an existing account or become admin. If you change the issuer URL or move to another IdP, users get new accounts unless their verified email links them to the old ones.

### GitHub and Google

**GitHub** (github.com → Settings → Developer settings → OAuth Apps → New OAuth App):

- Homepage URL: your public URL, e.g. `https://docs.example.org`
- Authorization callback URL: `https://docs.example.org/auth/github`
- Set `NUXT_OAUTH_GITHUB_CLIENT_ID` and `NUXT_OAUTH_GITHUB_CLIENT_SECRET`.

**Google** (console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID → Web application):

- Authorized redirect URI: `https://docs.example.org/auth/google`
- Set `NUXT_OAUTH_GOOGLE_CLIENT_ID` and `NUXT_OAUTH_GOOGLE_CLIENT_SECRET`.

Put the values in `.env` (or re-run `./install.sh`) and `docker compose up -d`. Both id and secret must be set, or the app refuses to start.

As with your own IdP, markoto only uses an email that GitHub or Google reports as verified (for linking accounts, `NUXT_ADMIN_USER_EMAILS` and invitations); an unverified address is not stored.

### HTTPS and who can sign up

**Login needs HTTPS.** The sign-in state and session cookies are `Secure`, which browsers only accept over HTTPS (and on `http://localhost`). On a plain-HTTP LAN address the editor works, but login does not. Use HTTPS mode, or plain-HTTP mode behind your own TLS proxy ([below](#behind-your-own-reverse-proxy)).

Everyone who can sign in at a configured provider gets an account; markoto has no allowlist of its own. With your own IdP, decide there who may use markoto (e.g. Authentik/Keycloak group or application bindings). With GitHub/Google, restrict access at the network level (VPN, firewall, proxy auth) if the instance shouldn't be open to everyone with a GitHub or Google account.

## AI

All AI is optional; without any key the AI controls show as unavailable and everything else works. AI needs a logged-in user.

**Bring your own key.** Each user can connect their own OpenAI-compatible provider per capability (chat, image, transcription) under **Settings → AI provider**. Details, provider presets and verification: [AI-MODELS.md#bring-your-own-key](AI-MODELS.md#bring-your-own-key).

**Instance defaults** apply to every user who hasn't set their own:

| Variables | Effect |
|---|---|
| `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_MODEL` alone | A model alias from `deploy/config/litellm/config.yaml`, paid with the operator's provider key (e.g. `MISTRAL_API_KEY`). Calls debit each user's monthly AI Points budget (`TIER_FREE_LITELLM_BUDGET_USD`). |
| `..._MODEL` + `..._BASE_URL` + `..._API_KEY` | Any OpenAI-compatible endpoint, used like a user key (no AI Points). |
| `NUXT_AI_DEFAULT_CHAT_VISION=false` | The default chat model can't read images. |

`install.sh --mistral-api-key` sets `MISTRAL_API_KEY`, `NUXT_AI_DEFAULT_CHAT_MODEL=mistral-small-2603` and `NUXT_AI_DEFAULT_TRANSCRIBE_MODEL=voxtral-mini-transcribe`. For image generation through the bundled FLUX alias add `BFL_API_KEY` and `NUXT_AI_DEFAULT_IMAGE_MODEL=flux-2-pro`.

**Local models (Ollama).** Ollama on the Docker host:

```sh
# .env
NUXT_AI_DEFAULT_CHAT_MODEL=qwen3:14b                  # a model with working tool calling
NUXT_AI_DEFAULT_CHAT_BASE_URL=http://host.docker.internal:11434/v1
NUXT_AI_DEFAULT_CHAT_API_KEY=ollama                   # any non-empty placeholder
NUXT_AI_DEFAULT_CHAT_VISION=false
```

The self-host compose maps `host.docker.internal` to the Docker host for the `app` and `litellm` containers. Ollama must listen on an address the containers can reach (`OLLAMA_HOST=0.0.0.0`, firewall permitting the Docker bridge). Operator defaults may point at private addresses; to let **users** pick private endpoints too, set `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`.

**Knowledge base (workspace files).** Uploaded files are embedded for retrieval. The default embeddings model is Jina (`JINA_AI_API_KEY`); without that key, uploads fail with an error and the rest works. Any other provider, including a local one: [AI-MODELS.md#embeddings](AI-MODELS.md#embeddings).

**Web tools.** `STAAN_API_KEY` enables the agent's `web_search`, `JINA_AI_API_KEY` its `fetch_url`. Without a key, the tool isn't offered. Per-user allowance: `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `NUXT_WEB_TOOLS_DAILY_LIMIT` (defaults 30 / 100, 0 = unlimited).

## Configuration reference

Everything lives in `.env` at the top of the checkout (the compose files are in `deploy/compose/`, the config they mount in `deploy/config/`). After a change: `docker compose up -d`. Variables marked *generated* are written by `install.sh`; don't change them on a running instance unless the notes say how.

This section explains the settings a self-hoster usually touches. The complete list (every variable, its type, default and which container reads it) is the generated [configuration reference](reference/configuration.md). The app, the sync server and the renderer check their settings at start and refuse to start with a list of every invalid or missing value (`docker compose logs app`).

### Instance and networking

| Variable | Default | Meaning |
|---|---|---|
| `MARKOTO_PUBLIC_URL` | (required) | The URL users open, without trailing slash. Email links, OAuth callbacks and browser-facing storage URLs derive from it. |
| `MARKOTO_SYNC_URL` | (required) | WebSocket URL of the collaboration server: the public URL with `ws(s)://` and `/sync`. |
| `MARKOTO_DOMAIN` | | HTTPS mode only: the domain for routing and the certificate. |
| `ACME_EMAIL` | | HTTPS mode only: Let's Encrypt account email. |
| `MARKOTO_HTTP_PORT` / `MARKOTO_HTTP_BIND` | `80` / `0.0.0.0` | Host port and address Traefik's HTTP entrypoint is published on. Bind to `127.0.0.1` behind a local proxy. |
| `MARKOTO_HTTPS_PORT` / `MARKOTO_HTTPS_BIND` | `443` / `0.0.0.0` | HTTPS mode. Let's Encrypt's TLS challenge needs public port 443. |
| `TRAEFIK_TRUSTED_IPS` | `127.0.0.1/32` | Comma-separated CIDRs of proxies in front of Traefik whose `X-Forwarded-*` headers are kept. |
| `NUXT_TRUSTED_PROXY_HOPS` | `1` | Reverse proxies in front of the app (Traefik = 1). See [Security notes](#trusted-proxy). |
| `SYNC_MAX_MESSAGE_BYTES` / `SYNC_MAX_UPDATE_BYTES` / `SYNC_MAX_DOCUMENT_BYTES` | 17 MiB / 16 MiB / 16 MiB | Largest WebSocket message, single change and document (encoded size) the collaboration server accepts, in bytes. A refused change shows the editor a "changes were not saved" banner; deleting content is always allowed. |
| `SYNC_MAX_PREAUTH_BYTES` / `SYNC_MAX_PREAUTH_TOTAL_BYTES` / `SYNC_AUTH_TIMEOUT_MS` | 32 MiB / 256 MiB / 15000 | Memory the collaboration server spends on messages sent before a connection has logged in to a document: per connection and across all connections (bytes), and how long a connection may send messages for a document without its login token (ms). Over the limit the connection is closed. |
| `NUXT_PUBLISH_DOMAINS_TARGET` / `NUXT_PUBLISH_TRAEFIK_TOKEN` | (off) | HTTPS mode only: custom domains for published pages. The target is the host your users point a CNAME at (it must resolve to this server); the token (≥ 32 random characters, e.g. `openssl rand -hex 32`) is what Traefik sends when it asks the app which domains to route. Verified domains get their certificates from Let's Encrypt through the same resolver as your own domain. Publishing at `/p/<slug>` works without either. |
| `NUXT_PUBLISH_PAGES_HOST` | (off) | The hostname published pages are served from, e.g. `pages.docs.example.org` (a bare name means `https://`; an origin like `http://pages.lan:8080` is accepted when the instance itself runs on plain HTTP). Empty: pages live at `<public URL>/p/<slug>`. Recommended for any public instance — see [Published pages](#published-pages). Required when `NUXT_LEGAL_SURFACES_ENABLED=true`. |
| `MARKOTO_INSTANCE` | `markoto` | Instance name: compose project, network names, Traefik routing scope. Run several instances on one host with different names and ports. |
| `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES` | set by `install.sh` | Which compose files and profiles `docker compose` uses. |
| `REGISTRY` / `IMAGE_TAG` | `ghcr.io/joelbarmettleruzh` / release tag | Image source. |

### Co-branding

For an instance run for one organisation, its name and logo can appear beside the markoto wordmark.

| Variable | Default | Meaning |
|---|---|---|
| `NUXT_INSTANCE_BRAND_NAME` | | Organisation name shown beside the markoto wordmark and in the browser tab title. |
| `NUXT_INSTANCE_BRAND_LOGO` | `/app/branding/logo.svg` with the brand overlay | Path of the logo inside the app container. |
| `NUXT_INSTANCE_SUPPORT_URL` / `NUXT_INSTANCE_SUPPORT_EMAIL` | | "Help & support" link in the account menu and the footer. |

To show a logo, create a `branding/` directory at the top of the checkout, next to `.env`, and put the file in it as logo.svg (or another name with `NUXT_INSTANCE_BRAND_LOGO=/app/branding/<file>`; SVG, PNG, WebP or JPEG, at most 1 MB). It is drawn at the wordmark's height, so a wide, simple mark works best. When `branding/` exists, `install.sh` adds `deploy/compose/compose.selfhost.brand.yml` to `COMPOSE_FILE`, which mounts the directory read-only into the app; re-run `./install.sh` (or add the file to `COMPOSE_FILE` yourself), then `docker compose up -d`.

### Secrets (generated)

`POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `NUXT_SESSION_PASSWORD`, `NUXT_JWT_SECRET`, `NUXT_INTERNAL_API_SECRET`, `NUXT_AI_DICTATE_JWT_SECRET`, `NUXT_MARKITDOWN_API_SECRET` (app ↔ document converter), `NUXT_ENCRYPTION_KEY` (encrypts the AI provider keys, LiteLLM keys and SSO client secrets the app stores: losing it makes them unreadable), `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` (encrypts LiteLLM's own stored keys: never change it on a running instance), `NUXT_S3_ACCESS_KEY` / `NUXT_S3_SECRET_KEY`, `BACKUP_GPG_PASSPHRASE` (needed to restore backups: store a copy outside this machine), `POSTGRES_APP_PASSWORD` / `POSTGRES_LITELLM_PASSWORD`. `POSTGRES_PASSWORD` is set when the database volume is first created; changing it later needs an `ALTER USER` inside Postgres too.

Rotating secrets:

- `NUXT_JWT_SECRET` and `NUXT_INTERNAL_API_SECRET` rotate without interruption: copy the current value into `NUXT_JWT_SECRET_PREVIOUS` / `NUXT_INTERNAL_API_SECRET_PREVIOUS`, set a new value (`openssl rand -hex 32`), `docker compose up -d`. Every service accepts both values while `_PREVIOUS` is set. Empty `_PREVIOUS` again (and `up -d`) after 2 hours, when every document token signed with the old secret has expired.
- `NUXT_SESSION_PASSWORD` has no rollover: a new value signs every user out.
- `NUXT_ENCRYPTION_KEY` rotates like the two above, plus one step: move the current value into `NUXT_ENCRYPTION_KEY_PREVIOUS`, set a new value, `docker compose up -d`, run `docker compose exec app bun cli/reencrypt-secrets.js`, then empty `_PREVIOUS` and `up -d` again. Replacing it without `_PREVIOUS` loses the stored values: users re-enter their AI provider keys, workspace admins their SSO client secret.
- `LITELLM_SALT_KEY` and `BACKUP_GPG_PASSPHRASE` must not change: the first encrypts the keys stored in LiteLLM, the second is needed to decrypt existing backups.

Database roles: `POSTGRES_USER` (default `markoto`) is the admin role; only the `db-init` one-shot and the backup use it. The app and the collaboration server connect as `POSTGRES_APP_USER` (default `markoto_app`), which owns the application database and nothing else; LiteLLM connects as `POSTGRES_LITELLM_USER` (default `litellm`), which owns only the `litellm` database. Neither role can connect to the other's database. `db-init` re-applies the two role passwords on every start, so changing `POSTGRES_APP_PASSWORD` / `POSTGRES_LITELLM_PASSWORD` in `.env` followed by `docker compose up -d` rotates them. Setting a role's user to the value of `POSTGRES_USER` turns that separation off.

### Login and admin

| Variable | Meaning |
|---|---|
| `NUXT_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | GitHub login. |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | Google login. |
| `NUXT_OAUTH_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | Your own OpenID Connect provider ([Login](#your-own-identity-provider-openid-connect)). |
| `NUXT_OAUTH_OIDC_NAME`, `_SCOPES` | Optional button label and scopes for it. |
| `NUXT_ADMIN_USER_EMAILS` | Comma-separated emails promoted to admin on login (`/admin/abuse-reports`, `/admin/ai-spend`). Only a verified email counts (GitHub/Google verified address, IdP `email_verified: true`). |
| `NUXT_SSO_ALLOW_PRIVATE_URLS` | `true` lets workspace single sign-on reach an identity provider on a private network (an on-prem Keycloak, say). Default `false`. |

### Limits

Billing is off on a self-hosted instance (`NUXT_BILLING_ENABLED=false`), so every account is on the free tier and these are everyone's limits. The self-host compose defaults are roomier than the hosted free tier.

| Variable | Self-host default | Meaning |
|---|---|---|
| `TIER_FREE_WORKSPACES_OWNED` | `50` | Workspaces a user can own. |
| `TIER_FREE_KNOWLEDGE_FILES` | `500` | Knowledge files per user (all workspaces). |
| `TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE` | `1073741824` (1 GiB) | |
| `TIER_FREE_KNOWLEDGE_BYTES_PER_USER` | `10737418240` (10 GiB) | |
| `TIER_FREE_IMAGE_BYTES_PER_USER` | `10737418240` (10 GiB) | Document images per user: uploads, AI-generated images and the copies made by duplicating a doc. Pending uploads count from the moment the upload starts. |
| `TIER_FREE_LITELLM_BUDGET_USD` | empty (= `1`, i.e. 1000 AI Points) | Monthly AI budget per user in USD, only for platform-paid instance defaults (markoto.app uses `0.5`). Applied when a user's AI key is created (first AI use); a change reaches existing users at the next app start. |
| `NUXT_FREE_TIER_TOTAL_BUDGET_USD` | empty (none) | Optional monthly ceiling in USD on platform-paid AI for all users together (a LiteLLM team budget). When it is used up, users without their own key are told the month's free allowance is used up; own-key calls are unaffected. See [AI-MODELS.md](./AI-MODELS.md#free-ai-allowance-hosted). |
| `NUXT_INACTIVE_DOC_TTL_DAYS` | `30` | Anonymous documents (no owner, not in a workspace) untouched this long are deleted. `0` disables. |
| `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `_DAILY_LIMIT` | `30` / `100` | Web tool calls per user. |
| `TIER_FREE_MEMBERS_PER_WORKSPACE` | empty (no limit) | People per workspace: members plus open invitations. `unlimited` or a number. A workspace already above it keeps everyone; only new invitations are refused. |
| `TIER_FREE_HISTORY_DAYS` | empty (no limit) | How far back the Activity Log can be viewed and restored, in days. Older entries stay stored. |
| `TIER_FREE_SAVED_THEMES` | `20` | Saved theme presets per user. |
| `TIER_FREE_IMPORT_MAX_BYTES` | `52428800` (50 MiB) | Largest file a user can import (never above 50 MiB). |
| `TIER_FREE_WEB_TOOLS_PER_DAY` | empty (no limit) | Extra per-user daily web-tool limit on top of `NUXT_WEB_TOOLS_DAILY_LIMIT`; the stricter one applies. |
| `TIER_FREE_MCP_TOOL_CALLS_PER_DAY` | empty (no limit) | MCP tool calls per user per day. |
| `TIER_FREE_FEATURE_CUSTOM_CSS` | `true` | Documents may use custom CSS. `false` keeps stored CSS but doesn't apply it. |
| `TIER_FREE_FEATURE_MCP_WRITE` | `true` | MCP clients may edit, render, generate images and use web tools. `false` = read-only MCP. |
| `TIER_FREE_FEATURE_AI_IMAGE` | `true` | Image generation on the instance default (`NUXT_AI_DEFAULT_IMAGE_*`). A user's own key always works. |
| `TIER_FREE_FEATURE_AI_VOICE` | `true` | Voice prompts + live dictation on the instance default (`NUXT_AI_DEFAULT_TRANSCRIBE_*`). |
| `TIER_FREE_FEATURE_AI_STRONG_MODEL` | `true` | Users may pick the strong chat model (`NUXT_AI_DEFAULT_CHAT_STRONG_MODEL`) in Settings → AI provider. |
| `TIER_FREE_FEATURE_SSO` | `true` | Workspaces may connect their own identity provider (OIDC or SAML single sign-on, SCIM). |
| `TIER_FREE_FEATURE_AUDIT_LOG` | `true` | Workspace admins can view and export the workspace's audit log. |
| `TIER_FREE_FEATURE_GUESTS` | `true` | Workspaces may invite guests, who see only the documents shared with them. |
| `TIER_FREE_FEATURE_BRAND_KIT` | `true` | Workspace brand kit: uploaded fonts and logos, a locked workspace design, workspace templates. |
| `TIER_FREE_FEATURE_SHARE_CONTROLS` | `true` | Share-link expiry, view-only links without download or print, view counts. |
| `TIER_FREE_FEATURE_CUSTOM_DOMAINS` | `true` | Users may serve a published page from a domain of their own. |

Every feature is on and these limits are off by default on a self-hosted instance; the variables exist so you can narrow them if you want to.

Retention and the collaboration server have their own optional knobs (empty = default): `NUXT_AUDIT_LOG_RETENTION_DAYS` (730) and `NUXT_ABUSE_REPORT_RETENTION_DAYS` (365, `0` = keep forever); `SYNC_MAX_MESSAGE_BYTES`, `SYNC_MAX_UPDATE_BYTES`, `SYNC_MAX_DOCUMENT_BYTES`, `SYNC_MAX_PREAUTH_BYTES`, `SYNC_MAX_PREAUTH_TOTAL_BYTES`, `SYNC_AUTH_TIMEOUT_MS`, `SYNC_MAX_CONNECTIONS_PER_IP` (20) and the document compaction sweep `COMPACT_THRESHOLD` (500 updates per snapshot), `COMPACT_INTERVAL_MS` (900000, `0` = off), `COMPACT_MAX_DOCS_PER_RUN` (50), `COMPACT_RETAIN_HISTORY_DAYS` (`0` = keep all edit history; otherwise older history is deleted and can no longer be restored — keep it at least as long as `TIER_FREE_HISTORY_DAYS`). `.env.example` in the repository explains each.

### Storage

| Variable | Default | Meaning |
|---|---|---|
| `NUXT_S3_BUCKET` | `markoto-files` | Bucket name. It is also the URL path prefix under which browsers reach storage, so don't pick a name that collides with an app route (`api`, `d`, `w`, `docs`, `settings`, …). |
| `NUXT_IMAGE_GC_RETENTION_DAYS` | `30` | An uploaded image that no document, restorable document version, theme or comment has referenced for this many days is deleted. `0` turns the image clean-up off. |
| `NUXT_AUDIT_LOG_RETENTION_DAYS` | `730` | Security audit-log entries older than this many days are deleted. `0` keeps them forever. |
| `NUXT_ABUSE_REPORT_RETENTION_DAYS` | `365` | Closed abuse reports (actioned or dismissed) are deleted this many days after they were closed; open reports are kept until handled. `0` keeps them forever. |

Uploads that are started but never finished are removed automatically: document images after 24 hours, workspace knowledge files after one hour.

To use an external S3 service instead of SeaweedFS, point the app at it with an override file (`NUXT_S3_ENDPOINT`, `NUXT_S3_PUBLIC_ENDPOINT` empty, and CORS as in [S3-SETUP.md](S3-SETUP.md)); the bundled SeaweedFS then sits idle.

### AI

See [AI](#ai): `NUXT_AI_DEFAULT_*`, `NUXT_AI_BYOK_ALLOWED_BASE_URLS`, `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS`, `NUXT_AI_REALTIME_MODEL`, `MISTRAL_API_KEY`, `BFL_API_KEY`, `JINA_AI_API_KEY`, `STAAN_API_KEY`, `NUXT_LITELLM_EMBEDDINGS_*`, `EMBEDDINGS_UPSTREAM_*`.

### Email (optional)

Without email configuration, transactional emails (account-deletion confirmations, data-export links) are written to the app log as `[email-stub]` and every flow completes normally. The data export is still downloadable from the profile page. Workspace invitations work without email too: the invitee sees the invitation on their dashboard after signing in with the invited address (with email configured they also get a one-time accept link; the link host comes from `NUXT_SITE_URL`).

| Variable | Meaning |
|---|---|
| `RESEND_API_KEY` | Enables delivery through Resend. |
| `NUXT_EMAIL_FROM` | Sender on a domain verified in Resend, e.g. `markoto <noreply@example.org>`. |
| `NUXT_EMAIL_PROVIDER=stub` | Force log-only even with a key. |

### Telemetry and operator surfaces

| Variable | Default | Meaning |
|---|---|---|
| `NUXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | empty | Error reporting to your Sentry project. Empty = nothing is sent anywhere. markoto has no analytics. |
| `NUXT_LEGAL_SURFACES_ENABLED` | `false` | See [Legal pages](#legal-pages). |
| `NUXT_ANON_GATE_ENABLED` | follows `NUXT_LEGAL_SURFACES_ENABLED` | `true`: before an anonymous visitor's first document they tick "I accept the Terms … and I'm at least 16" (links to `/legal/terms`, so only useful with your own legal pages) and pass an invisible proof-of-work bot check (ALTCHA, computed and verified by the app itself: no third-party service, no extra container, no cookie); anonymous visitors can then also use the report form. Needs `NUXT_ALTCHA_HMAC_KEY`. |
| `NUXT_ALTCHA_HMAC_KEY` | generated by `install.sh` | Key of that bot check (≥ 32 characters). Required only while the gate is on. |
| `NUXT_MARKETING_SITE_ENABLED` | `false` | "This instance is markoto.app": the product page at `/` for logged-out visitors, `/sitemap.xml`, the structured data on `/` and the hosted-only marketing pages. It advertises the hosted service; leave it off. Replaces `NUXT_PRODUCT_TOUR_ENABLED`, which is still read for one release. |
| `NUXT_DOCS_CANONICAL_BASE` | `https://markoto.app` | Where the bundled `/docs` pages point their canonical link, so search engines treat markoto.app's copy as the original instead of ranking the copies against each other. Set it empty to make your instance's docs self-canonical. |
| `NUXT_SITE_INDEXABLE` | `true` | `false` keeps the whole instance out of search engines: `/robots.txt` answers `Disallow: /` and every response carries `X-Robots-Tag: noindex, nofollow`. Documents are never indexed either way. Canonical links and `og:url` are built from `MARKOTO_PUBLIC_URL`. |
| `NUXT_LEGAL_CONTROLLER_NAME` | | Shown in the footer ("© 2026 …"). |
| `NUXT_LEGAL_CONTROLLER_ADDRESS` / `NUXT_LEGAL_REPRESENTED_BY` | | Postal address and authorised representative on the legal pages. Required (the app refuses to start without them) once `NUXT_LEGAL_SURFACES_ENABLED=true`. |
| `NUXT_LEGAL_ABUSE_CONTACT_EMAIL` | | Receives a notification for each in-app abuse report (needs email delivery). Reports are always listed under `/admin/abuse-reports`. |

## Ports and networking

Only Traefik publishes ports. Everything else sits on purpose networks, so a service reaches only what it needs:

| Network | Members |
|---|---|
| `<instance>-edge` | traefik, app, sync |
| `<instance>-docker-api` | traefik, socket-proxy |
| `<instance>-data` | postgres, valkey, app, sync, litellm, db-init, backup |
| `<instance>-render` | app, renderer |
| `<instance>-import` | app, markitdown |
| `<instance>-storage` | seaweedfs, traefik, app, renderer, backup, s3-init |
| `<instance>-egress` | litellm, backup (outbound: AI providers, an external backup bucket) |
| `<instance>-renderer-egress` | renderer (outbound: document images via the public URL; scripts and fonts come from the app) |

All but the two egress networks and `edge` are internal (no route off the host). The renderer and the import converter, which handle untrusted documents, cannot reach the database, Valkey, LiteLLM or the collaboration server. SeaweedFS's master, volume and filer listen only inside their own container; only its S3 API is on the network.

| Mode | Published | Routes on one origin |
|---|---|---|
| Plain HTTP | `${MARKOTO_HTTP_BIND}:${MARKOTO_HTTP_PORT}` → 80 | `/` app, `/sync` collaboration WebSocket, `/<bucket>/…` storage |
| HTTPS | 80 (redirects to HTTPS) and 443 | same, restricted to `Host(MARKOTO_DOMAIN)`; plus the [pages host](#published-pages) and verified custom domains (published pages only) |

Storage is reached by browsers directly with short-lived signed URLs (image upload and display, knowledge uploads, PDF and export downloads). Those URLs are signed for `MARKOTO_PUBLIC_URL`, so that URL must be exactly what users type.

PDF export renders in a headless browser inside the `renderer` container, which loads document images from the public URL. In HTTPS mode the compose file resolves the domain to the Docker host for that container; `localhost` URLs are mapped to the Docker host as well. Any other public URL must be reachable from inside the containers (true for the host's LAN address or a public DNS name), or images will be missing from PDFs.

### Behind your own reverse proxy

Run in plain-HTTP mode and let your proxy terminate TLS:

```sh
./install.sh -y --http-port 8080 --public-url https://docs.example.org --trusted-proxy 172.16.0.0/12
```

and in `.env` optionally `MARKOTO_HTTP_BIND=127.0.0.1` when the proxy runs on the same host. Proxy requirements:

- Forward everything for the host, including WebSocket upgrades on `/sync` (`Upgrade` / `Connection` headers).
- Preserve the `Host` header (storage signatures cover it).
- Allow request bodies up to 50 MB (imports).
- Append to `X-Forwarded-For`. With `--trusted-proxy CIDR`, `install.sh` sets `TRAEFIK_TRUSTED_IPS` to the proxy's address range (as Traefik sees it) and `NUXT_TRUSTED_PROXY_HOPS=2`.

### Published pages

Users can publish a document as a web page: a static, script-free snapshot anyone with the link can read. By default it lives on your instance's own origin, at `<public URL>/p/<slug>`. That works, but the page is HTML a user wrote, shown under your trusted hostname: a phishing page would look like it belongs to your instance, and the page shares an origin with the editor.

**For a public instance, serve published pages from a hostname of their own** — usually a subdomain, such as `pages.docs.example.org` next to `docs.example.org`:

1. **DNS.** Point the new name at the same server (an `A`/`AAAA` record, or a `CNAME` to your instance's domain).
2. **`.env`.** Set `NUXT_PUBLISH_PAGES_HOST=pages.docs.example.org`. In HTTPS mode also set `NUXT_PUBLISH_TRAEFIK_TOKEN` (≥ 32 random characters, `openssl rand -hex 32`) if custom domains haven't already: Traefik learns the pages host's route and requests its Let's Encrypt certificate through the same HTTP provider the custom domains use (`deploy/compose/compose.selfhost.tls.yml` switches that router on). In plain-HTTP mode Traefik already forwards every hostname, so only DNS (or your own proxy) is needed.
3. **Apply.** `docker compose up -d`. The first request to the new name may take a minute while the certificate is issued.

Afterwards pages are at `https://pages.docs.example.org/p/<slug>`, the publish dialog shows that address, and old `<public URL>/p/<slug>` links redirect there permanently. The pages host serves only published pages, their images and fonts, and `robots.txt` — no editor, no API, no sign-in — and it never sets or receives your instance's session cookie (that cookie is bound to your instance's exact hostname). The report link on a page still points at your instance. Custom domains keep working as before; they are unaffected by this setting.

## Upgrades

```sh
git pull                          # or: git checkout vX.Y.Z
./install.sh upgrade              # or: ./install.sh upgrade --tag vX.Y.Z
```

`upgrade` keeps your `.env`, generates secrets that a newer version may need, pulls (or rebuilds) the images, restarts and waits for health. Database migrations run automatically when the app starts and are forward-only: take a backup first, and to go back to an older version restore that backup. Read the release notes for configuration changes.

Keep the checkout and `IMAGE_TAG` on the same release: the compose files and the LiteLLM configuration come from the checkout, the code from the images.

Before upgrading across several releases, read the [upgrade notes](#upgrade-notes) below and the [release notes](https://github.com/joelbarmettlerUZH/markoto.app/releases) of every release in between (each release's notes are the description of the pull request that shipped it).

## Upgrade notes

Changes that can need action when you upgrade an existing instance. Newest first. Anything not listed here is backwards compatible.

| Change | Affects | What to do |
|---|---|---|
| **The compose files moved to `deploy/compose/`.** The stacks are `deploy/compose/compose.*.yml` (was `docker-compose.*.yml` at the top of the checkout); the config they mount moved to `deploy/config/` (LiteLLM, Postgres, the renderer's seccomp profile). | Instances installed before the move. | Run `./install.sh` once after pulling: it rewrites `COMPOSE_FILE` in `.env` to the new paths. Data, volumes and secrets are untouched. |
| **Stored secrets get their own encryption key.** The AI provider keys users save, the LiteLLM keys the app keeps and workspace SSO client secrets are now encrypted with the new `NUXT_ENCRYPTION_KEY` (no longer derived from `LITELLM_SALT_KEY`), with a separate key per kind and bound to their row. Values saved by an earlier version can't be read. | Every instance that stored AI provider keys or an SSO client secret | Run `./install.sh upgrade` (it generates `NUXT_ENCRYPTION_KEY`; with plain `docker compose`, add `NUXT_ENCRYPTION_KEY=` with the output of `openssl rand -hex 32` to `.env` first). Users enter their AI provider key again (Settings → AI provider shows it as needing a key); workspace admins enter the SSO client secret again. LiteLLM keys are replaced automatically on the next AI use. Back up the new key with the rest of `.env`. |
| **Invalid settings stop the start instead of being ignored.** The app, the sync server and the renderer now check every setting at start: a value that is not of the expected type (a boolean other than `true/false/1/0/yes/no/on/off`, a number with a unit, a URL without a scheme, a too-short secret, an unknown `NUXT_EMAIL_PROVIDER`, a `TIER_*` limit of `0`) stops the container with a message naming the variable. Before, most such values silently fell back to the default; some turned a feature off (for example a garbage `NUXT_INACTIVE_DOC_TTL_DAYS` disabled the anonymous-document clean-up, a short `NUXT_PUBLISH_TRAEFIK_TOKEN` closed the custom-domain endpoint). | Instances with a typo in `.env` | If a container doesn't start after the upgrade, `docker compose logs <service>` lists every problem; fix the values (the [configuration reference](reference/configuration.md) says what each expects) and `docker compose up -d`. |
| **The database migrations were squashed into one baseline.** `drizzle/` now holds a single migration that creates the whole schema; the retired workspace columns `billing_owner_id` and `ai_enabled` are gone. Document content moved from the `yjs_documents` table (created by the sync server) to `yjs_updates` (part of the schema); the old table is not read any more. A database created by an earlier version cannot be upgraded across this release: the app refuses to start with `relation "…" already exists`. | Every instance installed before this release | Recreate the database: export what you need (download each document you want to keep as Markdown first: its content does not carry over), then `docker compose down`, remove the Postgres volume (`docker volume rm <project>_pg_data`; `docker volume ls` shows the name; this also clears LiteLLM's spend records) and run `./install.sh upgrade`. There is no in-place upgrade path. |
| **Published pages can have their own hostname.** New optional `NUXT_PUBLISH_PAGES_HOST`; with it set, `<public URL>/p/<slug>` redirects to the pages host. Published images and fonts now refuse to be embedded by other sites (`Cross-Origin-Resource-Policy: same-origin`). Required when `NUXT_LEGAL_SURFACES_ENABLED=true`. | Public instances (recommended); instances with the legal surfaces on (required) | See [Published pages](#published-pages). |
| **The document converter (markitdown) requires a shared secret.** The app sends `NUXT_MARKITDOWN_API_SECRET` with every import, knowledge upload and design extraction; markitdown answers 401 without it, and `docker compose up` refuses to start while it is unset. | Everyone | Run `./install.sh upgrade` (it generates the secret). If you start the stack with plain `docker compose`, add `NUXT_MARKITDOWN_API_SECRET=` with the output of `openssl rand -hex 32` to `.env` first. |
| **With the legal surfaces on, the operator's address and representative are required.** `NUXT_LEGAL_CONTROLLER_ADDRESS` and `NUXT_LEGAL_REPRESENTED_BY` no longer fall back to the hosted operator's details; the app refuses to start without them while `NUXT_LEGAL_SURFACES_ENABLED=true`. | Instances with `NUXT_LEGAL_SURFACES_ENABLED=true` | Set both in `.env` ([Legal pages](#legal-pages)). |
| **Rootless Podman is supported.** `install.sh` detects Podman, adds `deploy/compose/compose.podman.yml` and sets `CONTAINER_SOCKET`. The compose files now declare service healthchecks, relabel bind mounts for SELinux (`:z`), and Traefik sets the low-port sysctl itself; on Docker nothing changes. | Podman hosts; SELinux hosts | Re-run `./install.sh` once on Podman. See [CONTAINER-ENGINES.md](contributing/CONTAINER-ENGINES.md). |
| **Plan limits and feature switches.** New optional `TIER_FREE_*` variables (members per workspace, history window, saved themes, import size, web-tool and MCP calls per day, custom CSS, MCP write access; see [Limits](#limits)). The defaults keep every feature on and set no new limit, so nothing changes unless you set them. | Nobody, unless you set the new variables | Nothing. |
| **`NUXT_PRODUCT_TOUR_ENABLED` is now `NUXT_MARKETING_SITE_ENABLED`.** The old name is still read for one release, then ignored. New: pages carry a canonical link built from `MARKOTO_PUBLIC_URL`; the bundled `/docs` pages point theirs at markoto.app (`NUXT_DOCS_CANONICAL_BASE`); `NUXT_SITE_INDEXABLE=false` keeps an instance out of search engines. | Instances that set the tour flag (it advertises the hosted service, so normally nobody); instances whose `/docs` should rank on their own | Rename the variable if you set it. Set `NUXT_DOCS_CANONICAL_BASE=` (empty) to make your docs self-canonical. |
| **Audit-log entries and closed abuse reports are deleted automatically.** Security audit-log entries older than 2 years (`NUXT_AUDIT_LOG_RETENTION_DAYS`, default 730) and abuse reports closed more than 1 year ago (`NUXT_ABUSE_REPORT_RETENTION_DAYS`, default 365) are deleted by daily sweeps; the first run after the upgrade removes everything already past those periods. | Everyone | To keep them longer, set either variable; `0` keeps them forever. |
| **No CDN: scripts, styles and fonts are served by the instance.** paged.js, Mermaid, the KaTeX and highlight.js styles and the theme fonts load from the instance's own `/vendor/` path instead of jsDelivr and Google Fonts, so previews and PDFs work without internet access. The renderer no longer accepts requests to those hosts. A theme that names a font outside the theme editor's list now renders in the fallback font (there is no file to serve for it); every font the editor offers is included. | Instances behind a reverse proxy that rewrites or blocks paths; themes with fonts typed in by hand | A custom proxy must pass `/vendor/` through unchanged, with the app's `Access-Control-Allow-Origin` and `Cross-Origin-Resource-Policy` headers. Pick a listed font for themes that used another one. |
| **Anonymous documents are deleted after 30 days without activity (was 180).** Documents that already exist get a grace period: none is deleted earlier than 30 days after the upgrade, nor later than the old 180-day rule would have. Optional anonymous gate (`NUXT_ANON_GATE_ENABLED`, off unless the legal surfaces are on) and anonymous abuse reports; every document page now sends `X-Robots-Tag: noindex, nofollow` (plus a robots meta tag), and the app serves a `/robots.txt` that disallows internal routes. | Instances with anonymous documents | Run `./install.sh upgrade` (it generates `NUXT_ALTCHA_HMAC_KEY`). To keep the old period, set `NUXT_INACTIVE_DOC_TTL_DAYS=180`. |
| **Least-privilege containers, split networks and separate database roles.** Every service drops its Linux capabilities and runs with `no-new-privileges`; most run as non-root users on a read-only filesystem. The single `<instance>-internal` network is replaced by purpose networks ([Ports and networking](#ports-and-networking)), so the renderer and the import converter no longer reach the database. Traefik reads Docker through a read-only `socket-proxy` instead of the Docker socket. The `litellm-db-init` one-shot is replaced by `db-init`, which also creates separate Postgres roles: the app (`POSTGRES_APP_USER`, owner of the app database only) and LiteLLM (`POSTGRES_LITELLM_USER`, owner of the `litellm` database only), hands existing tables over to them and blocks cross-database access. LiteLLM's admin UI is off. The renderer keeps Chromium's sandbox (seccomp profile `deploy/config/renderer/seccomp.json`). | Everyone | Run `./install.sh upgrade` (not just `docker compose up -d`): it generates the two role passwords in `.env`. Without them, the app and LiteLLM keep using `POSTGRES_USER` as before. Afterwards remove the leftovers of the old layout: `docker compose up -d --remove-orphans` (the exited `litellm-db-init` container) and `docker network rm <instance>-internal`. Keep the checkout and `IMAGE_TAG` on the same release: the new compose files expect the non-root renderer image. Hosts that forbid unprivileged user namespaces: see [Troubleshooting](#exports-backups-and-email). |
| **Image storage quota and image clean-up.** Each user's document images (uploads, AI-generated images, copies made by duplicating a document) are limited by `TIER_FREE_IMAGE_BYTES_PER_USER` (self-host default 10 GiB); existing images count toward it, and new uploads are refused with a clear message once the limit is reached. Images that nothing references any more are deleted after `NUXT_IMAGE_GC_RETENTION_DAYS` (default 30). Duplicated documents' images now count for the person who duplicated them. An image upload that is in progress while you upgrade fails and has to be repeated. The migration adds two nullable columns to `uploads`. | Everyone | Raise `TIER_FREE_IMAGE_BYTES_PER_USER` if your users store more; set `NUXT_IMAGE_GC_RETENTION_DAYS=0` to keep unused images forever. |
| **Stricter outbound-request and import limits.** AI provider URLs that answer with a redirect now fail (use the provider's final API URL); more internal host spellings are refused. With `NUXT_LEGAL_SURFACES_ENABLED=true`, an empty `NUXT_AI_BYOK_ALLOWED_BASE_URLS` stops the app from starting. OpenID Connect needs `NUXT_OAUTH_OIDC_REDIRECT_URL` or `NUXT_SITE_URL` (no longer taken from the request). Imports over 51 MiB are refused at the edge, and zip-based files that inflate past 200 MB are refused by the converter. | Instances with legal surfaces on; OIDC setups outside the shipped compose files; very large imports | Set the allowlist (see [Security notes](#security-notes)) or the OIDC redirect URL if boot reports them missing. |
| **Workspace invitations must be accepted.** Inviting by email now creates a pending invitation; the person joins only after accepting it (dashboard, or the emailed link). Existing members are unaffected. | Workspace admins | Tell invitees to accept from their dashboard (they must sign in with the invited email address, or use the email link). |
| **Anonymous documents can be deleted only from the browser that created them.** Anonymous documents created before this release can no longer be deleted through the app; the inactive-document clean-up still removes them. | Anonymous users | Nothing. |
| **Sessions can be revoked, and some actions need a recent sign-in.** "Log out everywhere" is on the profile page; account deletion, data-export requests and AI-provider changes ask for a sign-in from the last 12 hours. | Everyone | Nothing; sign in again when asked. |
| **`NUXT_SITE_URL` is required in production.** Email links are built only from it, never from the request's Host header. The self-host compose sets it from `MARKOTO_PUBLIC_URL`. | Instances run outside the shipped compose files | Set `NUXT_SITE_URL` to the public URL, or the app refuses to start. |
| **Admin rights come only from the stored admin flag.** `NUXT_ADMIN_USER_EMAILS` promotes a user when they sign in with a verified email; an email on the list no longer grants admin before that sign-in. | Admins added to the list but not signed in since | Sign out and in again. |
| **Document passwords need at least 8 characters** when set. Existing shorter passwords keep working. Password checks are limited per client, per document, and by failed attempts per document. | Everyone | Nothing. |
| **State-changing requests from another origin are refused** (403 `csrf/origin-mismatch`). | Setups that call the API from a page on a different host | Call it from the app's own origin, or without browser credentials. |
| **`TEST_MODE=1` refuses to start** on an instance whose `NUXT_SITE_URL` is not a local address. It is for the test suite only. | Anyone who set it by mistake | Remove `TEST_MODE`. |
| **Docker Compose 5.0 or newer is required.** The compose files override services that they pull in with `include:`, which Compose 2.24 to 2.40 reject with "conflicts with imported resource". `install.sh` refuses to run on an older Compose. | Everyone | Update Docker Engine and the Compose plugin (`docker compose version` must print 5.0.0 or higher). |
| **`NUXT_LEGAL_SURFACES_ENABLED` defaults to `false`.** The onboarding gate, DPA step and `/legal/*` pages describe the hosted service and its operator, so a self-hosted instance no longer shows them. | Instances that relied on the old always-on behaviour | Nothing, if you don't want them. To keep them, set `NUXT_LEGAL_SURFACES_ENABLED=true`, adapt `content/legal/` and set every `NUXT_LEGAL_*` variable ([Legal pages](#legal-pages)). |
| **AI model variables renamed.** `NUXT_LITELLM_TEXT_MODEL`, `NUXT_LITELLM_IMAGE_MODEL` and `NUXT_LITELLM_TRANSCRIBE_MODEL` no longer exist and are ignored. The replacements are `NUXT_AI_DEFAULT_CHAT_MODEL` (was TEXT), `NUXT_AI_DEFAULT_IMAGE_MODEL` and `NUXT_AI_DEFAULT_TRANSCRIBE_MODEL`, with the same alias values (for example `mistral-small-2603`). | Instances that set the old variables | Rename them in `.env`, then `docker compose up -d`. Without them, AI is unavailable until users add their own key under **Settings → AI provider**. |
| **Bring your own key.** Chat, image generation and transcription now resolve per user: the user's own provider, else the instance default, else unavailable. Calls on a user's own key never use AI Points. | Everyone using AI | Decide whether to set instance defaults ([AI](#ai)) or let users bring keys. `NUXT_AI_BYOK_ALLOWED_BASE_URLS` and `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS` control which provider URLs users may enter. |
| **Web search and page fetch are rate-limited** per user (30 per hour, 100 per day by default) and only offered when `STAAN_API_KEY` / `JINA_AI_API_KEY` is set. | Instances with those keys | Tune with `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `NUXT_WEB_TOOLS_DAILY_LIMIT` (`0` = unlimited). |
| **Billing is off by default** (`NUXT_BILLING_ENABLED=false`). Stripe variables aren't required and the billing endpoints answer 404 `billing/disabled`; every account is on the free tier. | Instances that copied a hosted-style `.env` | Nothing. Raise limits with the `TIER_FREE_*` variables. |

Database migrations are forward-only and run automatically. If a release notes a destructive migration, take a [backup](#backups) first (you should before every upgrade anyway).

## Backups

With the `backup` profile (default), the `backup` service runs `pg_dump` once a day (`BACKUP_INTERVAL_SECONDS`, default 86400), encrypts it with `BACKUP_GPG_PASSPHRASE` (gpg, AES-256) and stores it in the bucket under `backups/postgres/`, keeping the newest `BACKUP_RETENTION_COUNT` (default 14).

Postgres holds everything that matters: accounts, documents and their full edit history, comments, workspaces, knowledge text and vectors. The bucket holds uploaded images (and transient renders and exports).

**The backups are on the same disk as the data.** Either point the backup service at a separate S3 (below) or copy them off the machine.

By default the backups go into the same bucket, with the same credentials, as the app's files. To use another S3-compatible store, set these in `.env` (or `./install.sh --backup-s3-endpoint URL --backup-s3-bucket NAME --backup-s3-access-key KEY --backup-s3-secret-key SECRET`) and run `docker compose up -d`:

| Variable | Default |
|---|---|
| `BACKUP_S3_ENDPOINT` | the bundled SeaweedFS |
| `BACKUP_S3_BUCKET` | the app's bucket (`NUXT_S3_BUCKET`); a different bucket name on the bundled SeaweedFS is created for you |
| `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | the app's keys |
| `BACKUP_S3_REGION` | `us-east-1` |
| `BACKUP_S3_PREFIX` | `backups/postgres` |

Only the backup service receives them. For an external store, create a bucket with versioning (and object lock if you can) and a key limited to that bucket. A failed backup makes `docker compose run --rm --no-deps backup /usr/local/bin/backup.sh --once` exit non-zero and shows in `docker compose logs backup`.

The following copies the backups off the machine. The backup image has the aws CLI and the credentials, so for example (from the repository directory, e.g. in a nightly cron job):

```sh
docker compose run --rm --no-deps -v "$PWD/backup-copy:/out" --entrypoint sh backup -c \
  'AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_DEFAULT_REGION=us-east-1 \
   aws --endpoint-url "$S3_ENDPOINT" s3 sync "s3://$S3_BUCKET/backups/" /out/'
# then ship ./backup-copy to another machine / storage (the files are owned by root)
```

(sync `s3://$S3_BUCKET/` instead to copy the uploaded images too), or snapshot the Docker volumes (`<instance>_pg_data`, `<instance>_seaweed_data`) with your usual tooling. Keep `BACKUP_GPG_PASSPHRASE` somewhere safe outside the machine; without it the dumps can't be decrypted.

A one-off backup right now: `docker compose run --rm --no-deps backup /usr/local/bin/backup.sh --once`.

### Restore

The backup image has everything a restore needs (aws CLI, gpg, psql), so it runs in a throwaway container on the stack's network, nothing installed on the host:

```sh
# 1. Pick a backup.
docker compose run --rm --no-deps --entrypoint sh backup -c \
  'AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_DEFAULT_REGION=us-east-1 \
   aws --endpoint-url "$S3_ENDPOINT" s3 ls "s3://$S3_BUCKET/backups/postgres/"'

# 2. Stop everything that writes to the database.
docker compose stop app sync backup

# 3. Decrypt and load it. The dump drops and recreates every table: it REPLACES the current data.
docker compose run --rm --no-deps -e BACKUP_KEY=backups/postgres/20261026T154328Z.sql.gz.gpg \
  --entrypoint sh backup -c '
  set -e; export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" AWS_DEFAULT_REGION=us-east-1
  aws --endpoint-url "$S3_ENDPOINT" s3 cp "s3://$S3_BUCKET/$BACKUP_KEY" - \
  | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d 3<<EOF | gunzip \
  | psql -q -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >/dev/null
$BACKUP_GPG_PASSPHRASE
EOF
'

# 4. Start again.
docker compose up -d
```

A dump copied off the machine: `gpg -d` it (passphrase `BACKUP_GPG_PASSPHRASE`), `gunzip`, and pipe it into `docker compose exec -T postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB>`. On a new machine, put the old `.env` in place first and run `./install.sh` (it keeps the existing secrets), then restore.

## Re-embedding

After changing the embeddings model or its dimension (`NUXT_LITELLM_EMBEDDINGS_*`) on an instance that already has knowledge files:

```sh
./install.sh reembed --dry-run     # what would change
./install.sh reembed               # = docker compose exec app bun cli/reembed-knowledge.js
```

It is resumable and degrades only knowledge search while it runs. Details: [AI-MODELS.md#re-embedding](AI-MODELS.md#re-embedding).

## Legal pages

The hosted service shows an onboarding gate (age confirmation, privacy policy, terms), a data-processing addendum step for workspace owners, and `/legal/*` pages. Those texts describe the hosted markoto.app service and name LatentSpace Labs GmbH as the operator, so on a self-hosted instance they are **off** (`NUXT_LEGAL_SURFACES_ENABLED=false`): no gate, no DPA step, `/legal/*` answers 404, the footer shows no legal links. markoto itself sets no tracking or analytics cookies; the session, locale and anonymous-document creator cookies are functional.

You are the operator of your instance. If it is open to the public you may need your own privacy notice or imprint; host it wherever you like. To reuse the in-app legal surfaces instead, adapt the texts in `content/legal/` (and `server/legal/` registries), set `NUXT_LEGAL_SURFACES_ENABLED=true` and every `NUXT_LEGAL_*` variable (`CONTROLLER_NAME`, `CONTROLLER_ADDRESS`, `PRIVACY_CONTACT_EMAIL`, `ABUSE_CONTACT_EMAIL`, `GOVERNING_LAW`, `LEGAL_FORM`, `REGISTERED_OFFICE`, `REPRESENTED_BY`, `UID`, `CH_ID`, `EHRA_ID`). `CONTROLLER_ADDRESS` and `REPRESENTED_BY` have no default: the app refuses to start without them while the surfaces are on. Any other unset one falls back to the hosted operator's details, so set them all.

## Security notes

- **Secrets** live only in `.env` (mode 0600). Back it up securely; `NUXT_ENCRYPTION_KEY`, `LITELLM_SALT_KEY` and `BACKUP_GPG_PASSPHRASE` can't be recovered.
- **Exposure.** Only Traefik is published. Postgres, Valkey, LiteLLM, the renderer and the document converter are not reachable from outside the Docker networks, and inside them only from the services that use them ([Ports and networking](#ports-and-networking)). LiteLLM's admin UI is switched off; SeaweedFS's admin ports listen only inside its container. Storage is reachable through Traefik but only with valid signatures.
- **Internal endpoints.** The service-to-service routes (`/api/internal/`, the render routes, the collaboration server's `/sync/internal/`) are excluded from the public routers, and the app and collaboration server answer 404 to such a request when it carries Traefik's forwarding headers, even with the right secret. Every other `/api` route needs a signed-in session unless it is explicitly public. Details: [SECURITY-HARDENING.md, section D](SECURITY-HARDENING.md#section-d--public-edge-and-access-control).
- **Collaboration sessions follow access.** An open editor connection ends when its token expires (at most 2 hours, never past a share link's expiry) unless the editor gets a fresh token. When a document's access is narrowed (made private, password set, share link expired, …), its open connections are closed and must authenticate again, so someone who lost access stops receiving changes.
- **Containers.** No container has Linux capabilities beyond what an image's start-up needs (Postgres and SeaweedFS keep the few they use to fix data-directory ownership); all set `no-new-privileges`. Traefik reads the Docker API through a read-only proxy instead of the Docker socket. PDF export keeps Chromium's sandbox, which needs unprivileged user namespaces: the renderer runs with the seccomp profile `deploy/config/renderer/seccomp.json` (Docker's default plus the three calls the sandbox needs). On a host that forbids user namespaces altogether, set `RENDERER_CHROMIUM_SANDBOX=false` on the `renderer` service (see [Troubleshooting](#exports-backups-and-email)).
- <a id="trusted-proxy"></a>**Trusted proxy / client IPs.** Rate limits and the (truncated) IP on audit records use the client address. markoto takes the `NUXT_TRUSTED_PROXY_HOPS`-th entry from the right of `X-Forwarded-For` (default 1: Traefik's own entry), never the client-supplied leftmost one. Traefik drops forwarded headers from addresses outside `TRAEFIK_TRUSTED_IPS`. If you put another proxy in front, set both (see [above](#behind-your-own-reverse-proxy)); if you set too few hops, everyone behind your proxy shares one rate-limit bucket; too many, and clients can spoof their address again.
- **Bring-your-own-key URLs (SSRF).** Users can make the server connect to a provider URL. markoto checks the URL and every resolved address before each request (no loopback, link-local/cloud-metadata or internal service names; private networks only with `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`). The LiteLLM proxy does not follow HTTP redirects, so a provider URL can't bounce it to another address. Residual risk: LiteLLM resolves the hostname again when it connects, so a DNS-rebinding attacker with a near-zero TTL could switch the address between check and connection. With free-form URLs (the self-host default) you accept that risk; set `NUXT_AI_BYOK_ALLOWED_BASE_URLS` to a list of providers to close it. If you switch the legal surfaces on (`NUXT_LEGAL_SURFACES_ENABLED=true`, the hosted shape), the allowlist is required and the app refuses to boot without it. See [AI-MODELS.md#ssrf-protection](AI-MODELS.md#ssrf-protection).
- **Document import limits.** Anyone can import a file (`/api/import`, 10 per IP per minute). Request bodies are capped at 51 MiB (50 MB file + form framing) for every route by the app server itself (`NITRO_MAX_REQUEST_BODY_BYTES` to change it), and Traefik refuses larger bodies on the import route before they reach the app. The converter (markitdown) inspects zip-based files (DOCX, PPTX, XLSX, EPUB) before converting and refuses archives that inflate past 200 MB, contain more than 10,000 entries or compress more than 100:1; each conversion then runs in a child process with a memory cap and a 60 s time limit, so a hostile file can't take the converter down for other users. Tunable on the `markitdown` service: `MARKITDOWN_MAX_UNCOMPRESSED_MB`, `MARKITDOWN_MAX_ARCHIVE_ENTRIES`, `MARKITDOWN_MAX_COMPRESSION_RATIO`, `MARKITDOWN_TIMEOUT_SECONDS`, `MARKITDOWN_CHILD_MEMORY_MB` (defaults 200 / 10000 / 100 / 60 / 384).
- **Open sign-up.** Anyone with a GitHub or Google account can log in once OAuth is configured, and anyone your identity provider lets through once OIDC is. Restrict the network path or the IdP's application access if that's not what you want.
- **Updates.** The host OS and Docker are yours to patch. Follow markoto releases for application fixes.

## Troubleshooting

First look at `./install.sh status` (is every container up and healthy?) and `./install.sh logs <service>` (`app`, `sync`, `traefik`, `litellm`, `renderer`, `postgres`). Signed in as an admin (`NUXT_ADMIN_USER_EMAILS`), `/api/health/deep` shows each component's state; `/api/health` is the public pass/fail probe.

### Installation and startup

| Symptom | Cause and fix |
|---|---|
| `docker compose ... is too old; need >= 5.0.0` | Update Docker Engine and the Compose plugin ([Requirements](#requirements)). |
| `cannot talk to the docker daemon` | The daemon isn't running, or your user isn't in the `docker` group (`sudo usermod -aG docker $USER`, then log in again). |
| `.env exists but was not written by install.sh` | A development `.env` is in the way. Run `./install.sh --env-file /path/to/selfhost.env` and pass `--env-file` to every later `docker compose` call, or move the old file. |
| `--domain and --http-port are exclusive` | Pick HTTPS (domain) or plain HTTP (port), not both. |
| `the app did not become healthy within 900s` | `./install.sh logs app`. First boot also waits for LiteLLM's database migrations and for Postgres to initialise (a minute or two on slow disks). Out-of-memory kills show up as containers restarting in `docker compose ps`; the stack wants about 6 GB of RAM. |
| `Pulling failed ... Falling back to building` | The images for this tag aren't published, or the registry needs a login. Use a release tag (check it out first) or accept the local build (`--build`). |
| `port is already allocated` / `address already in use` | Another service owns port 80, 443 or your chosen HTTP port. Pick another with `--http-port`, or free the port (`sudo ss -ltnp 'sport = :80'`). |
| App container restarts with a missing-variable error naming a secret | The `.env` was edited or replaced and lost a generated secret. Run `./install.sh` again: it adds missing secrets and keeps existing ones. Never regenerate `NUXT_ENCRYPTION_KEY`, `LITELLM_SALT_KEY` or `BACKUP_GPG_PASSPHRASE` on a running instance. |
| `password authentication failed` for Postgres | `POSTGRES_PASSWORD` was changed after the database volume was created. Put the old value back (or `ALTER USER` inside Postgres). |
| App won't start after setting OAuth variables | Client ID and secret must both be set for a provider, or the app refuses to start. |

### Networking and login

| Symptom | Cause and fix |
|---|---|
| Certificate not issued | DNS must point at the host and ports 80 and 443 must be reachable from the internet: `./install.sh logs traefik`. Let's Encrypt rate-limits repeated failures; wait before retrying. |
| Images don't show, uploads fail | `MARKOTO_PUBLIC_URL` must match what the browser shows exactly (scheme, host, port); storage URLs are signed for it. Behind a proxy, the proxy must preserve the `Host` header. |
| Live collaboration doesn't connect | `MARKOTO_SYNC_URL` must be the public URL with `ws://` / `wss://` and `/sync`. A proxy in front must pass WebSocket upgrades. |
| Login fails with a cookie / state error | Login needs HTTPS (or `http://localhost`). Check the callback URL registered with GitHub or Google. |
| No login buttons at all | No sign-in provider is configured; the instance is anonymous-only ([Login](#login)). |
| Unrelated users hit `429` together | The client IP is read wrongly behind your proxy, so everyone shares one rate-limit bucket. Set `TRAEFIK_TRUSTED_IPS` and `NUXT_TRUSTED_PROXY_HOPS` ([Security notes](#trusted-proxy)). |
| Imports fail with 413 | Your proxy limits the body size. Allow up to 50 MB. |

### AI

| Symptom | Cause and fix |
|---|---|
| The AI bar says to add an API key | The user has no provider and the instance has no default. Add one under **Settings → AI provider**, or set `NUXT_AI_DEFAULT_*` ([AI](#ai)). |
| Saving a provider fails verification | Wrong key, base URL or model id; the message names the failing step. For a local server (Ollama) the base URL must be reachable from inside the containers, and `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true` is needed for private URLs entered by users. |
| "no tool support" warning on a chat provider | The model answered a tool-calling test with plain text. The writing assistant needs tool calling; pick another model. |
| No microphone button | No transcription provider. Live dictation additionally needs a Mistral transcription key. |
| The AI never generates images | No image provider is configured. |
| The AI can't search the web or read URLs | `STAAN_API_KEY` / `JINA_AI_API_KEY` is missing (the tool isn't offered), or the per-user allowance is used up (429 `ai/web-tools-rate-limited`). |
| Knowledge uploads fail | Embeddings need `JINA_AI_API_KEY` or a [custom embeddings provider](AI-MODELS.md#embeddings). After changing the model or dimension, run `./install.sh reembed` ([Re-embedding](#re-embedding)); `/api/health/deep` reports `checks.embeddings`. |
| Platform-paid AI stops with budget messages | The user's monthly AI Points budget (`TIER_FREE_LITELLM_BUDGET_USD`) is used up, or, with `NUXT_FREE_TIER_TOTAL_BUDGET_USD` set, the instance-wide monthly ceiling ("This month's free AI allowance is used up"). Both reset on the 1st of the month; a raised `TIER_FREE_LITELLM_BUDGET_USD` reaches existing users at the next app start. Calls on users' own keys never count. |
| LiteLLM keeps restarting | `./install.sh logs litellm`. It starts without provider keys, but needs its database (`./install.sh logs db-init`) and enough memory. |

### Exports, backups and email

| Symptom | Cause and fix |
|---|---|
| PDF export fails, or PDFs have no images | The `renderer` container loads images from the public URL, so that URL must be reachable from inside the containers ([Ports and networking](#ports-and-networking)). Check `./install.sh logs renderer`. |
| PDF export fails and the renderer log says `No usable sandbox!` | Chromium's sandbox needs unprivileged user namespaces, which this host (or kernel) forbids, or the seccomp profile `deploy/config/renderer/seccomp.json` isn't next to the compose files. Keep the checkout complete; if the host really forbids user namespaces, add `RENDERER_CHROMIUM_SANDBOX=false` to the `renderer` service's environment (Chromium then runs without its sandbox; the container stays unprivileged and isolated). |
| Document import fails | `./install.sh logs markitdown`; unsupported or corrupt files are rejected. |
| No backups appear | The `backup` profile is off (`COMPOSE_PROFILES` in `.env`), or the `backup` container is failing: `docker compose logs backup`. |
| No emails arrive | Email isn't configured, so mails are only written to the app log as `[email-stub]` ([Email](#email-optional)). |
| Admin pages return 403 | The signed-in email isn't in `NUXT_ADMIN_USER_EMAILS`, or the provider doesn't report it as verified. Promotion happens on login: log out and in again after changing it. |

## Getting help

- Questions and ideas: [GitHub Discussions](https://github.com/joelbarmettlerUZH/markoto.app/discussions).
- Bugs: [open an issue](https://github.com/joelbarmettlerUZH/markoto.app/issues/new/choose) with your release tag, the compose files in use and the relevant log lines. Remove secrets first.
- Security problems: never in a public issue, see [SECURITY.md](../SECURITY.md).
- How the system fits together: [ARCHITECTURE.md](ARCHITECTURE.md).
