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

## Install

```sh
git clone https://github.com/joelbarmettlerUZH/md-online.git markoto
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

By default the stack pulls `ghcr.io/joelbarmettleruzh/markoto-{app,sync,renderer,markitdown,backup}` at `IMAGE_TAG`. The installer picks the release tag of the checked-out commit (`git describe --tags --exact-match`), else `latest`. If the images can't be pulled, it falls back to building them from the checkout.

To always build from source:

```sh
./install.sh --build
```

This adds `docker-compose.selfhost.build.yml` to `COMPOSE_FILE`. After `git pull`, rebuild with `docker compose build && docker compose up -d` (or `./install.sh upgrade`).

## What runs

| Service | Image | Purpose |
|---|---|---|
| `traefik` | `traefik:v3` | The only service with a published port. Routes `/` to the app, `/sync` to Hocuspocus and `/<bucket>/…` to SeaweedFS, all on one origin. Let's Encrypt in HTTPS mode. |
| `app` | `markoto-app` | Nuxt (SSR + API + OAuth). Runs database migrations on start. |
| `sync` | `markoto-sync` | Hocuspocus (real-time collaboration over WebSocket). |
| `renderer` | `markoto-renderer` | Headless Chromium for server-side PDF export. |
| `markitdown` | `markoto-markitdown` | DOCX / PDF / PPTX / XLSX / HTML / EPUB import, knowledge-file parsing. |
| `postgres` | `pgvector/pgvector:pg16` | All application data, document state, knowledge vectors. Volume `pg_data`. |
| `valkey` | `valkey/valkey:9` | Rate limits, locks, per-document sync state. Volume `valkey_data`. |
| `seaweedfs` | `chrislusf/seaweedfs` | S3-compatible storage: images, knowledge uploads (deleted after processing), PDF renders, data exports, backups. Volume `seaweed_data`. |
| `s3-init` | `markoto-backup` | One-shot: creates the bucket. |
| `litellm` + `litellm-db-init` | `ghcr.io/berriai/litellm` | AI gateway. Starts without any provider key. |
| `backup` | `markoto-backup` | Optional (`COMPOSE_PROFILES=backup`, on by default): encrypted `pg_dump` into the bucket. |

The compose files: `docker-compose.selfhost.yml` (everything, plain HTTP), `docker-compose.selfhost.tls.yml` (HTTPS overlay), `docker-compose.selfhost.build.yml` (build-from-source overlay). They include `docker-compose.base.yml`, which the hosted deployment shares.

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
| `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_MODEL` alone | A model alias from `infra/litellm/config.yaml`, paid with the operator's provider key (e.g. `MISTRAL_API_KEY`). Calls debit each user's monthly AI Points budget (`TIER_FREE_LITELLM_BUDGET_USD`). |
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

**Upgrading from before WP4:** `NUXT_LITELLM_TEXT_MODEL`, `NUXT_LITELLM_IMAGE_MODEL` and `NUXT_LITELLM_TRANSCRIBE_MODEL` no longer exist. Set `NUXT_AI_DEFAULT_CHAT_MODEL`, `NUXT_AI_DEFAULT_IMAGE_MODEL` and `NUXT_AI_DEFAULT_TRANSCRIBE_MODEL` to the same aliases.

## Configuration reference

Everything lives in `.env` next to the compose files. After a change: `docker compose up -d`. Variables marked *generated* are written by `install.sh`; don't change them on a running instance unless the notes say how.

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
| `MARKOTO_INSTANCE` | `markoto` | Instance name: compose project, network names, Traefik routing scope. Run several instances on one host with different names and ports. |
| `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES` | set by `install.sh` | Which compose files and profiles `docker compose` uses. |
| `REGISTRY` / `IMAGE_TAG` | `ghcr.io/joelbarmettleruzh` / release tag | Image source. |

### Secrets (generated)

`POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `NUXT_SESSION_PASSWORD`, `NUXT_JWT_SECRET`, `NUXT_INTERNAL_API_SECRET`, `NUXT_AI_DICTATE_JWT_SECRET`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` (encrypts stored keys: never change it on a running instance), `NUXT_S3_ACCESS_KEY` / `NUXT_S3_SECRET_KEY`, `BACKUP_GPG_PASSPHRASE` (needed to restore backups: store a copy outside this machine). Rotation: [SECRETS-ROTATION.md](SECRETS-ROTATION.md). `POSTGRES_PASSWORD` is set when the database volume is first created; changing it later needs an `ALTER USER` inside Postgres too.

### Login and admin

| Variable | Meaning |
|---|---|
| `NUXT_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | GitHub login. |
| `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | Google login. |
| `NUXT_OAUTH_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | Your own OpenID Connect provider ([Login](#your-own-identity-provider-openid-connect)). |
| `NUXT_OAUTH_OIDC_NAME`, `_SCOPES` | Optional button label and scopes for it. |
| `NUXT_ADMIN_USER_EMAILS` | Comma-separated emails promoted to admin on login (`/admin/abuse-reports`, `/admin/ai-spend`). Only a verified email counts (GitHub/Google verified address, IdP `email_verified: true`). |

### Limits

Billing is off on a self-hosted instance (`NUXT_BILLING_ENABLED=false`), so every account is on the free tier and these are everyone's limits. The self-host compose defaults are roomier than the hosted free tier.

| Variable | Self-host default | Meaning |
|---|---|---|
| `TIER_FREE_WORKSPACES_OWNED` | `50` | Workspaces a user can own. |
| `TIER_FREE_KNOWLEDGE_FILES` | `500` | Knowledge files per user (all workspaces). |
| `TIER_FREE_KNOWLEDGE_BYTES_PER_WORKSPACE` | `1073741824` (1 GiB) | |
| `TIER_FREE_KNOWLEDGE_BYTES_PER_USER` | `10737418240` (10 GiB) | |
| `TIER_FREE_LITELLM_BUDGET_USD` | `1` | Monthly AI Points budget per user, only for platform-paid instance defaults. Applied when a user's AI key is created (first AI use); later changes don't update existing users. |
| `NUXT_INACTIVE_DOC_TTL_DAYS` | `180` | Anonymous documents untouched this long are deleted. `0` disables. |
| `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `_DAILY_LIMIT` | `30` / `100` | Web tool calls per user. |

### Storage

| Variable | Default | Meaning |
|---|---|---|
| `NUXT_S3_BUCKET` | `markoto-files` | Bucket name. It is also the URL path prefix under which browsers reach storage, so don't pick a name that collides with an app route (`api`, `d`, `w`, `docs`, `settings`, …). |

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
| `NUXT_LEGAL_CONTROLLER_NAME` | | Shown in the footer ("© 2026 …"). |
| `NUXT_LEGAL_ABUSE_CONTACT_EMAIL` | | Receives a notification for each in-app abuse report (needs email delivery). Reports are always listed under `/admin/abuse-reports`. |

## Ports and networking

Only Traefik publishes ports. Everything else is on two internal Docker networks (`<instance>-edge` for Traefik and the routed services, `<instance>-internal` for databases and backends).

| Mode | Published | Routes on one origin |
|---|---|---|
| Plain HTTP | `${MARKOTO_HTTP_BIND}:${MARKOTO_HTTP_PORT}` → 80 | `/` app, `/sync` collaboration WebSocket, `/<bucket>/…` storage |
| HTTPS | 80 (redirects to HTTPS) and 443 | same, restricted to `Host(MARKOTO_DOMAIN)` |

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

## Upgrades

```sh
git pull                          # or: git checkout vX.Y.Z
./install.sh upgrade              # or: ./install.sh upgrade --tag vX.Y.Z
```

`upgrade` keeps your `.env`, generates secrets that a newer version may need, pulls (or rebuilds) the images, restarts and waits for health. Database migrations run automatically when the app starts and are forward-only: take a backup first, and to go back to an older version restore that backup. Read the release notes for configuration changes.

Keep the checkout and `IMAGE_TAG` on the same release: the compose files and the LiteLLM configuration come from the checkout, the code from the images.

Before upgrading across several releases, read the [upgrade notes](#upgrade-notes) below and the [release notes](https://github.com/joelbarmettlerUZH/md-online/releases) of every release in between (each release's notes are the description of the pull request that shipped it).

## Upgrade notes

Changes that can need action when you upgrade an existing instance. Newest first. Anything not listed here is backwards compatible.

| Change | Affects | What to do |
|---|---|---|
| **Workspace invitations must be accepted.** Inviting by email now creates a pending invitation; the person joins only after accepting it (dashboard, or the emailed link). Existing members are unaffected. | Workspace admins | Tell invitees to accept from their dashboard (they must sign in with the invited email address, or use the email link). |
| **Anonymous documents can be deleted only from the browser that created them.** Anonymous documents created before this release can no longer be deleted through the app; the inactive-document clean-up still removes them. | Anonymous users | Nothing. |
| **Sessions can be revoked, and some actions need a recent sign-in.** "Log out everywhere" is on the profile page; account deletion, data-export requests and AI-provider changes ask for a sign-in from the last 12 hours. | Everyone | Nothing; sign in again when asked. |
| **`NUXT_SITE_URL` is required in production.** Email links are built only from it, never from the request's Host header. The self-host compose sets it from `MARKOTO_PUBLIC_URL`. | Instances run outside the shipped compose files | Set `NUXT_SITE_URL` to the public URL, or the app refuses to start. |
| **Admin rights come only from the stored admin flag.** `NUXT_ADMIN_USER_EMAILS` promotes a user when they sign in with a verified email; an email on the list no longer grants admin before that sign-in. | Admins added to the list but not signed in since | Sign out and in again. |
| **Document passwords need at least 8 characters** when set. Existing shorter passwords keep working. Password checks are limited per client, per document, and by failed attempts per document. | Everyone | Nothing. |
| **State-changing requests from another origin are refused** (403 `csrf/origin-mismatch`). | Setups that call the API from a page on a different host | Call it from the app's own origin, or without browser credentials. |
| **`TEST_MODE=1` refuses to start** on an instance whose `NUXT_SITE_URL` is not a local address. It is for the test suite only. | Anyone who set it by mistake | Remove `TEST_MODE`. |
| **Docker Compose 5.0 or newer is required.** The compose files override services that they pull in with `include:`, which Compose 2.24 to 2.40 reject with "conflicts with imported resource". `install.sh` refuses to run on an older Compose. | Everyone | Update Docker Engine and the Compose plugin (`docker compose version` must print 5.0.0 or higher). |
| **`NUXT_LEGAL_SURFACES_ENABLED` defaults to `false`.** The onboarding gate, cookie banner, DPA step and `/legal/*` pages describe the hosted service and its operator, so a self-hosted instance no longer shows them. | Instances that relied on the old always-on behaviour | Nothing, if you don't want them. To keep them, set `NUXT_LEGAL_SURFACES_ENABLED=true`, adapt `content/legal/` and set every `NUXT_LEGAL_*` variable ([Legal pages](#legal-pages)). |
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

The hosted service shows an onboarding gate (age confirmation, privacy policy, terms), a cookie-consent banner, a data-processing addendum step for workspace owners, and `/legal/*` pages. Those texts describe the hosted markoto.app service and name LatentSpace Labs GmbH as the operator, so on a self-hosted instance they are **off** (`NUXT_LEGAL_SURFACES_ENABLED=false`): no gate, no banner, no DPA step, `/legal/*` answers 404, the footer shows no legal links. markoto itself sets no tracking or analytics cookies; the session cookie and an anonymous-id cookie are functional.

You are the operator of your instance. If it is open to the public you may need your own privacy notice or imprint; host it wherever you like. To reuse the in-app legal surfaces instead, adapt the texts in `content/legal/` (and `server/legal/` registries), set `NUXT_LEGAL_SURFACES_ENABLED=true` and every `NUXT_LEGAL_*` variable (`CONTROLLER_NAME`, `CONTROLLER_ADDRESS`, `PRIVACY_CONTACT_EMAIL`, `ABUSE_CONTACT_EMAIL`, `GOVERNING_LAW`, `LEGAL_FORM`, `REGISTERED_OFFICE`, `REPRESENTED_BY`, `UID`, `CH_ID`, `EHRA_ID`); any unset one falls back to the hosted operator's details.

## Security notes

- **Secrets** live only in `.env` (mode 0600). Back it up securely; `LITELLM_SALT_KEY` and `BACKUP_GPG_PASSPHRASE` can't be recovered.
- **Exposure.** Only Traefik is published. Postgres, Valkey, LiteLLM (including its admin UI), SeaweedFS's admin ports and the internal service endpoints are not reachable from outside the Docker networks. Storage is reachable through Traefik but only with valid signatures.
- <a id="trusted-proxy"></a>**Trusted proxy / client IPs.** Rate limits and the (truncated) IP on audit records use the client address. markoto takes the `NUXT_TRUSTED_PROXY_HOPS`-th entry from the right of `X-Forwarded-For` (default 1: Traefik's own entry), never the client-supplied leftmost one. Traefik drops forwarded headers from addresses outside `TRAEFIK_TRUSTED_IPS`. If you put another proxy in front, set both (see [above](#behind-your-own-reverse-proxy)); if you set too few hops, everyone behind your proxy shares one rate-limit bucket; too many, and clients can spoof their address again.
- **Bring-your-own-key URLs (SSRF).** Users can make the server connect to a provider URL. markoto checks the URL and every resolved address before each request (no loopback, link-local/cloud-metadata or internal service names; private networks only with `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`). Residual risk: LiteLLM resolves the hostname again when it connects, so a DNS-rebinding attacker with a near-zero TTL could switch the address between check and connection. With free-form URLs (the self-host default) you accept that risk; set `NUXT_AI_BYOK_ALLOWED_BASE_URLS` to a list of providers to close it. See [AI-MODELS.md#ssrf-protection](AI-MODELS.md#ssrf-protection).
- **Open sign-up.** Anyone with a GitHub or Google account can log in once OAuth is configured. Restrict the network path if that's not what you want.
- **Updates.** The host OS and Docker are yours to patch. Follow markoto releases for application fixes.

## Troubleshooting

First look at `./install.sh status` (is every container up and healthy?) and `./install.sh logs <service>` (`app`, `sync`, `traefik`, `litellm`, `renderer`, `postgres`). As an instance admin, `/api/health/deep` shows each component's state; `/api/health` is the public pass/fail probe.

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
| App container restarts with a missing-variable error naming a secret | The `.env` was edited or replaced and lost a generated secret. Run `./install.sh` again: it adds missing secrets and keeps existing ones. Never regenerate `LITELLM_SALT_KEY` or `BACKUP_GPG_PASSPHRASE` on a running instance. |
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
| Platform-paid AI stops with budget messages | The user's monthly AI Points budget (`TIER_FREE_LITELLM_BUDGET_USD`) is used up. It resets every 30 days; raising the variable doesn't change existing users' keys. Calls on users' own keys never count. |
| LiteLLM keeps restarting | `./install.sh logs litellm`. It starts without provider keys, but needs its database (`litellm-db-init`) and enough memory. |

### Exports, backups and email

| Symptom | Cause and fix |
|---|---|
| PDF export fails, or PDFs have no images | The `renderer` container loads images from the public URL, so that URL must be reachable from inside the containers ([Ports and networking](#ports-and-networking)). Check `./install.sh logs renderer`. |
| Document import fails | `./install.sh logs markitdown`; unsupported or corrupt files are rejected. |
| No backups appear | The `backup` profile is off (`COMPOSE_PROFILES` in `.env`), or the `backup` container is failing: `docker compose logs backup`. |
| No emails arrive | Email isn't configured, so mails are only written to the app log as `[email-stub]` ([Email](#email-optional)). |
| Admin pages return 403 | The signed-in email isn't in `NUXT_ADMIN_USER_EMAILS`, or the provider doesn't report it as verified. Promotion happens on login: log out and in again after changing it. |

## Getting help

- Questions and ideas: [GitHub Discussions](https://github.com/joelbarmettlerUZH/md-online/discussions).
- Bugs: [open an issue](https://github.com/joelbarmettlerUZH/md-online/issues/new/choose) with your release tag, the compose files in use and the relevant log lines. Remove secrets first.
- Security problems: never in a public issue, see [SECURITY.md](../SECURITY.md).
- How the system fits together: [ARCHITECTURE.md](ARCHITECTURE.md).
