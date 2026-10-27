# Security Hardening

> Operator docs for the hosted markoto.app deployment; self-hosters see [SELF-HOSTING.md](./SELF-HOSTING.md).

Cross-cutting hardening notes for the production stack. Three sections today:

- §A. HTTP headers + CSP — applied at the Traefik edge.
- §B. Valkey deployment posture — password enforcement, network exposure,
  optional TLS for managed-Redis providers.
- §C. Containers, networks and database roles — least-privilege
  containers, the Chromium sandbox in the renderer, purpose networks,
  the Docker socket proxy, separate Postgres roles.

For Postgres TLS see `shared/utils/postgresSsl.ts` (similar shape — opt-in
via env, system CA by default, `PGSSLROOTCERT` for cert pinning). For
secret rotation procedures see `docs/SECRETS-ROTATION.md`. For deploy
prerequisites see `docs/DEPLOY.md`.

---

# Section A — HTTP Headers + CSP

Where: every HTTPS response from the production stack carries a fixed set of
security headers, applied at the Traefik edge via the `security-headers`
middleware in `docker-compose.prod.yml`. The sync subdomain (Hocuspocus WS +
`/health`) carries a parallel `sync-security-headers` middleware that drops
CSP (no HTML responses) but keeps everything else.

This file documents what each header is for, the CSP allowlist rationale,
the iframe-sandbox hardening on the preview/print iframes, and the
verification recipe.

---

## 1. The header set

Final exact values applied to every response from the app router:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=(self)
Content-Security-Policy: <see §2>
```

| Header | Why |
|---|---|
| `Strict-Transport-Security` | Forces HTTPS for one year, including all subdomains. `preload` opts the domain into Chrome's HSTS preload list — listing on chromestatus.com is a separate **manual** step (see follow-ups). Once a browser sees this header, it pins HTTPS even if the user types `http://` — there is no quick way back, so do not deploy this until TLS on `${DOMAIN}` and `sync.${DOMAIN}` is fully working. |
| `X-Content-Type-Options: nosniff` | Blocks MIME-sniffing; an asset served with the wrong `Content-Type` cannot be retroactively interpreted as JS by the browser. Defense in depth against any future content-type bug. |
| `X-Frame-Options: DENY` | No origin can iframe markoto. Mitigates click-jacking. If we ever want third-party embeds, switch to `SAMEORIGIN` or replace with CSP `frame-ancestors`. The CSP already sets `frame-ancestors 'none'`, so DENY is duplicative-but-belt-and-braces for older browsers. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Same-origin requests carry the full URL; cross-origin requests carry only the origin (no path). External links from a doc don't leak which doc the user was reading. |
| `Cross-Origin-Opener-Policy: same-origin` | A new tab opened from markoto cannot keep a `window.opener` reference back to markoto. Tightens postMessage / Spectre-style surfaces. |
| `Cross-Origin-Resource-Policy: same-site` | Other origins cannot embed our static resources via `<img>`/`<script>`/etc. unless they're under the same site. |
| `Permissions-Policy` | Disables camera + geolocation outright. Allows microphone (live dictation needs it) and payment (future Stripe checkout) only on our own origin. No third-party iframe can hijack any of these. |

---

## 2. Content Security Policy

Final policy (applied to the app router only — the sync router serves
WebSocket upgrades + a `/health` JSON probe and never returns HTML):

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://js.stripe.com;
style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:;
img-src 'self' data: blob: https://${DOMAIN} https://*.${DOMAIN};
connect-src 'self' https://${DOMAIN} wss://sync.${DOMAIN} https://api.stripe.com https://*.ingest.sentry.io;
frame-src 'self' https://js.stripe.com https://hooks.stripe.com;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

### Allowlist rationale per source

| Source | Where it shows up |
|---|---|
| `cdn.jsdelivr.net` | `script-src` + `style-src`: paged.js polyfill, KaTeX CSS, hljs theme stylesheets, mermaid ESM. All version-pinned in `shared/utils/{pagedjsCdn,katexCdn,hljsCdn,mermaidCdn}.ts` with SRI hashes (mermaid is best-effort — `import()` does not yet support integrity validation). |
| `fonts.googleapis.com` + `fonts.gstatic.com` | The 20-font Google Fonts picker drives `themeFontsImport()`. The CSS loads from `fonts.googleapis.com`; the actual woff2 files come from `fonts.gstatic.com`. |
| `data:` in `font-src` | KaTeX inlines a couple of small font fallbacks as data URLs in its stylesheet. |
| `https://*.${DOMAIN}` in `img-src` | S3 image uploads served via `/api/files/...` go through our origin, but workspace knowledge previews + future asset-CDN domains will live on subdomains. The wildcard scopes us to our own apex. |
| `wss://sync.${DOMAIN}` | Hocuspocus WebSocket. Required — without this the editor never syncs. |
| `*.ingest.sentry.io` | Browser error reporting. Empty in dev keeps it inert. |
| `api.stripe.com` + `js.stripe.com` + `hooks.stripe.com` | Stripe billing (Checkout redirect + webhooks + Stripe.js). Live since the Phase-6+ billing work — see `server/api/billing/` + `server/utils/stripeWebhook.ts`. |
| `blob:` in `worker-src` + `img-src` | The PWA service worker registers from a blob URL; `<img>` blob URLs are used for paste-uploaded images before the presigned PUT completes. |

### Why `'unsafe-inline'` + `'unsafe-eval'`

Both flags weaken `script-src` and we accept the cost knowingly:

- **`'unsafe-inline'`**: Vite/Nuxt SSR injects an inline `<script>` block per
  page for hydration state (`window.__NUXT__`), and Nuxt UI injects an
  inline `<style id="nuxt-ui-colors">` block carrying every color token.
  Removing inline scripts requires either a per-request **nonce** plumbed
  through Nitro's HTML rendering pipeline (non-trivial) or `'strict-dynamic'`
  with a hash for the bootstrap script (Vite's hashed entry filenames
  defeat the static-hash route). Documented as a future hardening
  step — not a launch blocker.
- **`'unsafe-eval'`**: Vue's runtime template compiler uses `new Function`
  in some code paths, and mermaid's parser uses `eval`-like dynamic
  evaluation. Dropping this flag will cause silent runtime failures in
  certain themes — verify with a CSP-violation reporting endpoint before
  removing.

### Upgrade path (follow-up)

1. Add a `Report-Only` CSP that mirrors the active policy minus `'unsafe-inline'`/`'unsafe-eval'` and points `report-uri` at a `/api/_internal/csp-report` endpoint.
2. Run for a week, collect violations.
3. If the only violations are the known Vite + Nuxt UI inlines, plumb a per-request nonce through `useHead()` and remove `'unsafe-inline'` from `script-src` (style-src is harder; Nuxt UI's color tokens currently require it).
4. Submit the domain to https://hstspreload.org once the stack has run with HSTS for 30 days without rollback.

---

## 3. Iframe sandbox tightening

Two iframes in the editor host paged.js. Both carry a `sandbox` attribute now:

| Iframe | `sandbox` value | Why |
|---|---|---|
| `app/composables/usePagedPreview.ts` (live preview) | `allow-scripts allow-same-origin` | paged.js + the bootstrap need scripts; the bootstrap reads `window.parent.document` for color-mode sync, which requires same-origin. Deliberately NOT `allow-forms` / `allow-popups` / `allow-top-navigation` — preview must never navigate the host or open new windows. |
| `app/utils/printPdf.ts` (PDF export) | `allow-scripts allow-same-origin allow-modals` | Same as above + `allow-modals`: without it, Chromium silently no-ops `window.print()` inside a sandboxed iframe. |

Server-side render page (`app/pages/_internal/render/[docId].vue`) is loaded
in a top-level Playwright tab inside the renderer container, never in an
iframe — no sandbox needed there. The `frame-ancestors 'none'` in CSP
already prevents anyone from iframing it from outside.

---

## 4. Verification

After deploy:

```bash
curl -sI "https://${DOMAIN}" | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy|cross-origin|permissions-policy'
```

Expected output (one line per header). Spot-check the CSP with a real
browser: load the editor, open DevTools → Console — there should be **zero**
CSP violation reports during normal use (open a doc, type, switch themes,
trigger AI, generate a PDF). If a violation appears, decide whether the
allowlist is missing a host or whether the offending code is wrong.

For the sync subdomain:

```bash
curl -sI "https://sync.${DOMAIN}/health" | grep -iE 'strict-transport|x-frame|cross-origin'
```

Should match the app-domain headers minus CSP.

Compose-file syntax validation:

```bash
docker compose -f docker-compose.prod.yml config > /dev/null
```

This expands all label substitutions (including the CSP string with `${DOMAIN}`) and surfaces any quoting bug before deploy.

---

## 5. Follow-ups (not done here)

- **HSTS preload submission** — manual step at https://hstspreload.org/ once HSTS has run unmodified for ~30 days. Removal takes weeks.
- **CSP nonce wiring** — drop `'unsafe-inline'` from `script-src` once Vite/Nuxt-UI inlines are nonced.
- **CSP violation reporting** — add `report-uri /api/_internal/csp-report` once a Nitro endpoint exists to ingest reports into Sentry as `component=csp` events.
- **`docker-compose.local.yml`** — local stack does not currently apply these headers (mkcert TLS + nip.io domain; CSP'd CDN URLs would still resolve, but the dev loop tolerates a less-strict policy). Mirror the middleware to local once we want to verify CSP changes pre-push.
- **S3 bucket-policy audit** — orthogonal to headers but listed in AGENTS.md §4. `aws s3api get-bucket-acl --bucket $BUCKET` post-deploy must show `ListBucket` denied to public.

---

# Section B — Valkey Deployment Posture

## Threat model

We trust the VPS provider for disk encryption + the managed Postgres
provider (when used) for at-rest encryption. We do **NOT** extend the
trust boundary to include the Valkey container's host port — Valkey
requires a password and is bound to the internal `data` network only
in production (§C.3). The threat we're closing: any process on the VPS host
(including a misconfigured neighbour container or a future ops tool
running with looser permissions) being able to read/write rate-limit
counters, presence keys, render-singleflight locks, and per-doc edit
attribution by connecting to `127.0.0.1:6379`.

The data in Valkey is operational, not user-private — losing it would
let an attacker bypass rate limits or briefly corrupt activity-log
attribution, not exfiltrate user content. So password + network
isolation is enough; we do **not** turn on TLS today (see §B.4).

## B.1 Password enforcement

| Stack | Password | How |
|---|---|---|
| Production (`docker-compose.prod.yml`) | `${VALKEY_PASSWORD:?required}` from `.env` (≥32 random chars) | `--requirepass` arg + every consumer passes `VALKEY_PASSWORD` env var |
| Local full-stack (`docker-compose.local.yml`) | `${VALKEY_PASSWORD:?required}` — any string in `.env`, never internet-reachable | same as prod, mirrors the auth code path |
| Dev (`docker-compose.dev.yml`) | `${VALKEY_PASSWORD:-devpassword}` — defaults to a weak literal | host bun reads `VALKEY_PASSWORD=devpassword` from `.env.example` |
| Test (`docker-compose.test.yml`) | hardcoded `testpassword` | matches `tests/integration/setup/env.ts` literal |

The dev/test password is hardcoded weak ON PURPOSE: those stacks expose
6379 (or 6380) only on `127.0.0.1`, hold no real data, and exist to
exercise the SAME auth code path prod uses — so a regression that
silently disables `requirepass` breaks tests before it ships.

The runtime client config flows through `valkeyClientConfigFromEnv()` in
`shared/utils/connectionStrings.ts` → `new Redis(url, options)` in both
`server/utils/valkey.ts` and `sync-server/src/valkey.ts`. The `url` is
`redis://:password@host:port/db` (or `rediss://…` for TLS — see §B.4).

## B.2 Network exposure

| Compose file | Valkey listener | Why |
|---|---|---|
| `docker-compose.prod.yml` | `expose: ["6379"]` (`data` network only, no host port) | The app, sync, LiteLLM and backup containers reach Valkey over the internal `data` bridge (§C.3); the renderer and markitdown can't. Publishing 6379 would let any VPS-host process bypass docker network ACLs. |
| `docker-compose.local.yml` | `expose: ["6379"]` (same) | App runs IN a container; no host access needed. |
| `docker-compose.dev.yml` | `ports: ["127.0.0.1:6379:6379"]` | Nuxt runs on the host (`bun run dev`) and reaches Valkey via `localhost:6379`. Loopback only: the weak dev password must never face the LAN. |
| `docker-compose.test.yml` | `ports: ["127.0.0.1:6380:6379"]` | vitest runs on the host and reaches Valkey via `localhost:6380`. tmpfs storage; loopback only. |

Valkey listens on `0.0.0.0` inside the container (the upstream image
default) — that's correct because the docker bridge IS the only route in
when `ports:` is unset. We deliberately do NOT pass `--bind 127.0.0.1`
to the container; that would prevent app/sync containers on the bridge
from connecting.

Verify post-deploy:

```bash
ss -ltnp | grep :6379         # expect: nothing on the host
docker compose -f docker-compose.prod.yml exec app sh -c 'echo "PING" | nc -q1 valkey 6379'   # expect: connection refused without auth, or NOAUTH after PING
```

## B.3 Healthcheck shape

Production + local healthcheck:

```yaml
test: ["CMD", "valkey-cli", "--no-auth-warning", "-a", "${VALKEY_PASSWORD}", "ping"]
```

`--no-auth-warning` suppresses valkey-cli's stderr nag about passing
the password on the command line. The env var is already visible via
`docker inspect` so the warning adds noise without buying anything.

Dev + test use the same shape with the literal password in place of the
substitution.

## B.4 Optional TLS (deferred — plumbing in place)

For our single-VPS deployment with both app and Valkey containers on the
same docker network, the network IS the trust boundary — TLS is overkill.
But if Valkey ever moves to a separate host (Infomaniak managed Valkey,
OVH Redis-as-a-service, AWS ElastiCache, Upstash, etc.), TLS becomes
mandatory.

Plumbing today:

| Var | Default | When set |
|---|---|---|
| `VALKEY_TLS_ENABLED` | `false` | Set `true` to wrap the connection in TLS. The client uses `rediss://` and ioredis's TLS support against the system CA store. |
| `VALKEY_TLS_CA_PATH` | unset | Optional path to a provider-supplied CA PEM. Only needed for providers using a private CA — most public providers issue certs from a public CA chain that the system store already trusts. |

Wire-up: `valkeyClientConfigFromEnv()` (in
`shared/utils/connectionStrings.ts`) reads both vars and returns
`{ url, options: { tls: { ca? } } | undefined }`. Both
`server/utils/valkey.ts` and `sync-server/src/valkey.ts` spread the
returned options into `new Redis(url, options)`. Docs in `.env.example`.

When you turn it on at the server side, you'll also need `--tls-port`,
`--port 0`, `--tls-cert-file`, `--tls-key-file`, and `--tls-ca-cert-file`
on the valkey-server invocation — but if you're at that point you're
running managed Valkey and the provider hands you a pre-configured
endpoint, so the compose file doesn't need to add those args today.

## B.5 Verification recipe

Post-deploy or post-rotate, run from the VPS:

```bash
# Without auth — expect NOAUTH error.
docker compose -f docker-compose.prod.yml exec valkey valkey-cli ping
# Output: NOAUTH Authentication required.

# With auth — expect PONG.
docker compose -f docker-compose.prod.yml exec valkey \
  valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" ping
# Output: PONG

# From the app container — expect PONG (container has VALKEY_PASSWORD env).
docker compose -f docker-compose.prod.yml exec app sh -c \
  'apk add --no-cache redis 2>/dev/null; redis-cli -h valkey -a "$VALKEY_PASSWORD" --no-auth-warning ping'

# Confirm no host port exposed.
ss -ltnp | grep -E ':6379|:6380' || echo "ok: no valkey on host"
```

## B.6 Cross-references

- Secret rotation: `docs/SECRETS-ROTATION.md` covers the dual-secret
  pattern for `JWT_SECRET` / `INTERNAL_API_SECRET`. `VALKEY_PASSWORD`
  is rotated by stop-the-world (rate-limit / activity-attribution
  state survives the restart via AOF in prod, and is intentionally
  ephemeral in dev/test).
- Deploy prerequisites: `docs/DEPLOY.md`.
- Postgres TLS counterpart: `shared/utils/postgresSsl.ts` plus the
  existing TLS section in `docs/DEPLOY.md`.

---

# Section C — Containers, networks and database roles

The goal: a compromise of any one container — most plausibly the renderer
(Chromium on user-authored HTML/CSS/SVG and CDN scripts) or markitdown
(parsers for uploaded Office/PDF files) — gives the attacker as little as
possible: no root, no capabilities, nothing writable outside tmpfs, no
route to the database or the AI gateway, no Docker API. Enforced in CI by
`scripts/selfhost-check.sh` for the selfhost, prod and local stacks.

## C.1 Container baseline

Every service: `cap_drop: [ALL]` + `security_opt: [no-new-privileges:true]`.

| Service | Runs as | Root filesystem | Notes |
|---|---|---|---|
| app | `bun` (image) | read-only, tmpfs `/tmp` | |
| sync | `bun` (image) | read-only, tmpfs `/tmp` | |
| renderer | `pwuser` (image, uid 1000) | read-only, tmpfs `/tmp` (512 MB, counts against `mem_limit`) | `pids_limit: 2048`; Chromium sandbox on (§C.2) |
| markitdown | `app` (image) | read-only, tmpfs `/tmp` | no network except `import` (§C.3) |
| litellm | `65534:65534` (nobody) | read-only, tmpfs `/tmp` | admin UI off (`DISABLE_ADMIN_UI=True`) |
| valkey | `999:1000` (the image's `valkey` user, no root entrypoint) | read-only, data on its volume | |
| traefik | root **without capabilities** | read-only | binding 80/443 needs no capability (Docker sets `ip_unprivileged_port_start=0`); prod keeps `DAC_OVERRIDE` only while `traefik/acme.json` is owned by the deploy user (see docs/LAUNCH-CHECKLIST.md) |
| socket-proxy | root without capabilities (to open the `root:docker` socket) | read-only, tmpfs `/tmp` `/run` | §C.4 |
| db-init | `postgres` | read-only | one-shot, §C.5 |
| backup | `postgres` (uid 70) | writable | stages the encrypted dump in `/tmp`, which can be large |
| postgres, seaweedfs | image entrypoint (root → drops to its user) | writable | keep `CHOWN DAC_OVERRIDE FOWNER SETGID SETUID` only — what the entrypoint needs to fix data-dir ownership and drop privileges |

## C.2 Renderer: Chromium's sandbox

The renderer used to run as root with `--no-sandbox`. It now runs as
`pwuser` and launches Chromium **with** its sandbox (`chromiumSandbox:
true`, `renderer/src/render.ts`). As an unprivileged process without
capabilities, Chromium's zygote sandboxes renderer processes in new user /
PID / network namespaces. Docker's default seccomp profile only allows
`clone(CLONE_NEWUSER)` / `unshare` / `chroot` with `CAP_SYS_ADMIN` /
`CAP_SYS_CHROOT`, so the renderer gets its own profile,
`renderer/seccomp.json`: Docker's default profile
(github.com/moby/profiles, `seccomp/default.json`, Apache-2.0) plus one
rule allowing `chroot`, `clone` and `unshare` unconditionally. The kernel
still checks every namespace operation; only the seccomp pre-filter is
relaxed. Trade-off accepted: user namespaces add kernel attack surface,
but without them a Chromium exploit lands directly in the renderer's
process instead of in Chromium's sandbox.

Verified on Docker 29 with `kernel.apparmor_restrict_unprivileged_userns=1`
(Ubuntu-style hosts): Docker's `docker-default` AppArmor profile permits
the user namespace. Chromium's zygote processes run in their own user
namespace (`/proc/<pid>/ns/user` differs from the browser process),
seccomp mode 2, uid 1000.

To regenerate the profile after a Docker upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json \
  | jq '.syscalls += [{"names":["chroot","clone","unshare"],"action":"SCMP_ACT_ALLOW","comment":"markoto renderer: Chromium namespace sandbox (unprivileged user namespaces) without CAP_SYS_ADMIN/CAP_SYS_CHROOT"}]' \
  > renderer/seccomp.json
```

Escape hatch: a host that forbids unprivileged user namespaces entirely
(`kernel.unprivileged_userns_clone=0`, some hardened kernels, rootless
setups) fails renders with "No usable sandbox!". There,
`RENDERER_CHROMIUM_SANDBOX=false` on the renderer service launches Chromium
without its sandbox (logged as a warning at boot). Everything else in this
section still applies, so the blast radius stays the renderer container.

## C.3 Purpose networks

The flat `internal` network is gone. `internal: true` networks have no
route off the host.

| Network | Members | Internal |
|---|---|---|
| `web` / `edge` | traefik, app, sync | no (published entrypoint, app/sync egress) |
| `docker-api` | traefik, socket-proxy | yes |
| `data` | postgres, valkey, app, sync, litellm, db-init, backup | yes |
| `render` | app (alias `markoto-app`), renderer | yes |
| `import` | app, markitdown | yes |
| `storage` (self-host, local) | seaweedfs, traefik, app, renderer, backup, s3-init | yes (local: no, for the loopback-published S3 port) |
| `egress` | litellm, backup (+ db-init in prod) | no — AI providers, managed Postgres, external S3 |
| `renderer-egress` | renderer only | no — S3 and the pinned CDNs (the browser-level allowlist in `renderer/src/allowlist.ts` still applies) |

So the renderer reaches the app and its own egress, nothing else; markitdown
reaches only the app (it has no internet either). Verified from inside the
running self-host stack: `postgres`, `valkey`, `litellm`, `sync` don't even
resolve from the renderer or markitdown.

**Bundled SeaweedFS (self-host):** master, volume and filer bind and
advertise `127.0.0.1` inside the SeaweedFS container; only the
SigV4-authenticated S3 API listens on the network (`-s3.ip.bind=0.0.0.0`),
and the Iceberg / Lance side ports are off. Residual: `weed server` binds
the S3 gateway's gRPC port (18333, IAM-cache sync) on the same address as
the S3 API and has no flag to separate them. It is reachable only from the
`storage` members, all of which already hold the S3 admin key (which the
embedded IAM API on 8333 accepts for the same operations), so it grants
nothing extra.

## C.4 Docker socket proxy

Traefik's docker provider talks to `tcp://socket-proxy:2375`
(`tecnativa/docker-socket-proxy`, digest-pinned) instead of mounting
`/var/run/docker.sock`. The proxy allows `GET` on containers, events,
ping and version only (`CONTAINERS=1`, `POST=0`); every write endpoint and
everything else (images, exec, volumes, networks, …) answers 403. A
compromised Traefik can therefore no longer create a privileged container,
i.e. no longer become root on the host. It can still read container
metadata (including environment variables) — inherent to the docker
provider. Verify: `docker compose exec traefik wget -qO- --post-data= http://socket-proxy:2375/containers/create` → `403 Forbidden`.

## C.5 Postgres roles

`POSTGRES_USER` is the **admin** role (the bundled image's bootstrap
superuser, or the managed cluster's admin user). It is used only by the
`db-init` one-shot and the backup sidecar. With `POSTGRES_APP_USER` /
`POSTGRES_APP_PASSWORD` and `POSTGRES_LITELLM_USER` /
`POSTGRES_LITELLM_PASSWORD` set, `db-init` (`infra/postgres/db-init.sh`,
idempotent, runs on every `up`):

- creates both roles as `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, and
  re-applies their passwords (rotation = change `.env`, `up -d`);
- makes the app role the owner of the app database and the LiteLLM role the
  owner of `litellm`, and hands over every object the admin created before
  (tables, sequences, views, functions, enum types, the `drizzle` schema —
  extension-owned pgvector objects stay with the admin);
- creates the `vector` extension as admin (not a trusted extension);
- revokes `CONNECT`/`TEMP` on both databases from `PUBLIC` — the LiteLLM
  role cannot open the app database and vice versa.

The app needs LiteLLM's spend-log table for the 90-day retention sweep and
the admin spend query; it connects with the LiteLLM role for that
(`NUXT_LITELLM_DB_USER` / `_PASSWORD`, `server/utils/litellm/litellmDb.ts`).
That widens nothing — the app already holds the LiteLLM master key; the
separation protects the app database *from* a compromised proxy.

`install.sh` generates the roles for every self-host install and upgrade.
The hosted deployment opts in by setting the GitHub Environment values
(docs/LAUNCH-CHECKLIST.md); without them, everything keeps using the admin
role exactly as before.

## C.6 Dev and test stacks

`docker-compose.dev.yml`, `docker-compose.test.yml` and
`docker-compose.local.yml` publish every port on `127.0.0.1` only (they run
with committed, throwaway credentials). Containers that need the host's
`bun run dev` reach it through `host.docker.internal`; the renderer maps
`localhost` image URLs to the SeaweedFS container instead
(`RENDERER_LOCALHOST_TARGET`), because loopback-published ports aren't
reachable through the docker bridge. The one non-loopback binding is
`fake-openai-test` on the test network's fixed gateway address
(`10.213.47.1`, see the compose file): the BYOK base URL has to be the same
non-loopback address for the app on the host and for LiteLLM in a container.

## C.7 Verification

```bash
bash scripts/selfhost-check.sh            # static: networks, caps, read-only, loopback binds
docker compose exec renderer sh -c 'cat /proc/1/status | grep -E "^(Uid|CapEff|NoNewPrivs)"'
docker compose exec renderer bun -e 'require("net").connect(5432,"postgres").on("error",e=>console.log(e.code))'   # ENOTFOUND
docker compose exec postgres psql -U "$POSTGRES_USER" -c "select usename, datname from pg_stat_activity where usename is not null"
```
