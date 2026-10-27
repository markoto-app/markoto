# Security Hardening

> Operator docs for the hosted markoto.app deployment; self-hosters see [SELF-HOSTING.md](./SELF-HOSTING.md).

Cross-cutting hardening notes for the production stack. Three sections today:

- §A. HTTP headers + CSP — the CSP + CORP come from the app itself, the rest
  from the Traefik edge; preview iframe isolation.
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
security headers. Most come from the Traefik edge (`security-headers`
middleware in `docker-compose.prod.yml`, `markoto-headers` in
`docker-compose.selfhost.yml`). **`Content-Security-Policy` and
`Cross-Origin-Resource-Policy` come from the app** (`server/plugins/csp.ts`,
policies in `server/utils/csp.ts`): the CSP carries a per-response script
nonce that has to match the HTML, `/api/files` needs a different CORP than the
rest, and one builder in code means hosted, self-host, local and the test
stacks all serve the same policy. Traefik must NOT set either header — a
Traefik CSP would be enforced in addition to the app's (pinned by
`tests/unit/csp.test.ts`). The sync subdomain (Hocuspocus WS + `/health`)
carries a parallel `sync-security-headers` middleware (no HTML, no CSP).

This file documents what each header is for, the CSP rationale, the isolation
of the preview/print iframes, and the verification recipe.

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
| `Cross-Origin-Resource-Policy: same-site` | Other origins cannot embed our static resources via `<img>`/`<script>`/etc. unless they're under the same site. Set by the app. Exception: `/api/files/*` (a 302 to a presigned S3 URL) is `cross-origin` — the preview iframe runs in an opaque origin, which is never "same site", and its images go through this route; access there is decided by the session / file-access token, not by the requesting origin. |
| `Permissions-Policy` | Disables camera + geolocation outright. Allows microphone (live dictation needs it) and payment (future Stripe checkout) only on our own origin. No third-party iframe can hijack any of these. |

---

## 2. Content Security Policy

Built per response by `buildAppCsp()` (`server/utils/csp.ts`), sent by
`server/plugins/csp.ts` on every response of the production build (the
`nuxt dev` server sends none — Vite's HMR client would trip it). Hosted shape:

```
default-src 'self';
script-src 'self' 'nonce-<per response>' 'wasm-unsafe-eval'
  https://cdn.jsdelivr.net/npm/pagedjs@0.4.3/dist/paged.polyfill.min.js
  https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js;
style-src 'self' 'unsafe-inline'
  https://cdn.jsdelivr.net/npm/katex@0.18.11/dist/katex.min.css
  https://cdn.jsdelivr.net/npm/highlight.js@11.12.0/styles/
  https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net/npm/katex@0.18.11/dist/fonts/;
img-src 'self' data: blob: <S3 origin>;
connect-src 'self' <sync origin> <S3 origin> <Sentry ingest origin>;
frame-src 'self'; worker-src 'self' blob:; manifest-src 'self'; media-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';
upgrade-insecure-requests            (only when NUXT_SITE_URL is https)
```

The variable parts come from runtime config: `NUXT_PUBLIC_SYNC_URL`,
`NUXT_S3_PUBLIC_ENDPOINT` (else `NUXT_S3_ENDPOINT`), `NUXT_PUBLIC_SENTRY_DSN`,
`NUXT_SITE_URL`. A self-host on one origin collapses to `'self'`.

The server render page (`/_internal/render/*`, loaded by the renderer
sidecar from the app container) gets `buildRenderCsp()`: `default-src
'none'`, the same script/style/font sources (nonce, pinned CDN files), images
from `'self'`, the S3 origin and `RENDERER_ALLOWED_ORIGINS`, `connect-src
'self'`, no frames, `form-action 'none'`.

### Sources and why

| Source | Why |
|---|---|
| `'nonce-…'` | Nuxt's own inline scripts (payload/config, color-mode) — stamped by the `render:html` hook on the head and body-edge chunks only, never on the rendered page body. The preview/print srcdoc iframes inherit the policy; their inline scripts carry the same nonce (read from `script.nonce` by `currentCspNonce()`). |
| CDN **files** | jsDelivr serves arbitrary npm content, so a bare `https://cdn.jsdelivr.net` would let an injection load any package. Only the two exact script files (paged.js, Mermaid), the KaTeX stylesheet + its `fonts/` directory and the highlight.js `styles/` directory are allowed. Every one of them is also SRI-locked (`shared/utils/*Cdn.ts`). |
| `'wasm-unsafe-eval'` | `@nuxt/content` compiles its SQLite WASM in the browser for client-side docs queries. Allows WebAssembly compilation only — not `eval`/`new Function`. |
| `fonts.googleapis.com` + `fonts.gstatic.com` | The 20-font Google Fonts picker (`themeFontsImport()`). |
| `data:` in `font-src` / `img-src` | KaTeX font fallbacks; Mermaid diagrams render as `data:image/svg+xml` `<img>`s; custom CSS may use raster `data:image/*`. |
| S3 origin | Presigned image GETs (`/api/files` 302s there) and presigned upload PUTs. |
| sync origin | Hocuspocus WebSocket. |
| Sentry ingest origin | Browser error reporting (derived from the DSN — no wildcard). |
| `blob:` in `worker-src` / `img-src` / `media-src` | PWA service-worker plumbing, paste-upload previews, dictation audio. |

Stripe origins are gone: billing uses the Checkout **redirect**, not Stripe.js.

### What still needs `'unsafe-inline'` and why

- **`style-src` only.** Nuxt UI injects its color tokens as an inline
  `<style>`; Vue `:style` bindings, KaTeX output (inline `style` attributes
  that pass the `sanitizeHtml.ts` property allowlist) and paged.js (a fresh
  `<style>` per pagination) all need inline styles. Styles can't run script;
  CSS-based exfiltration is bounded by `img-src` / `font-src` /
  `connect-src`.
- **`script-src` has neither `'unsafe-inline'` nor `'unsafe-eval'`.** Inline
  event handlers (`onerror=` …) and injected `<script>` never run, even if
  something slipped past DOMPurify. Vue's production build is runtime-only
  (no template compiler, no `new Function`); paged.js and Mermaid don't
  evaluate strings.

Regression pins: `tests/unit/csp.test.ts` (exact policy string, no proxy CSP
label in any compose file, every hljs theme has an SRI hash),
`tests/unit/pagedPreviewIframe.test.ts` (nonce on every inline script of the
iframe bootstrap, no inline handlers), and the Playwright suite
`tests/e2e/flows/preview-isolation.spec.ts` (no CSP violation on the editor
with a doc using images + Mermaid + KaTeX + highlight.js, the landing page
and the docs site).

---

## 3. Preview + print iframe isolation

Rendered document content is attacker-influenced (any editor of the doc,
imports, the AI). It is DOMPurify-sanitised, but the preview is where a
sanitizer bypass would execute — so it executes somewhere harmless:

| Iframe | `sandbox` | Origin |
|---|---|---|
| live preview (`app/composables/usePagedPreview.ts`) | `allow-scripts` | opaque (`null`) |
| browser print (`app/utils/printPdf.ts`, same bootstrap) | `allow-scripts allow-modals` | opaque (`null`) |

No `allow-same-origin`: script inside the preview cannot read the app's
cookies or storage (both throw), cannot touch `window.parent`'s DOM, and its
requests to the app are cross-site — no session cookie, and the CSRF check
refuses state-changing calls from origin `null`. Also omitted: `allow-forms`,
`allow-popups`, `allow-top-navigation`; every link click in the preview is
intercepted (fragments scroll, everything else is inert) and `frame-src
'self'` refuses navigation elsewhere. `allow-modals` (print only) is what
lets `window.print()` open the dialog.

How the preview still works (details: `app/utils/AGENTS.md`):

- **postMessage protocol** (`app/utils/previewFrame.ts`): render requests and
  the app's color mode go in; ready / page count / errors / print shortcut /
  print done come out. The parent accepts messages only from the iframe's
  window with origin `null`, validated per type; the iframe accepts them only
  from `window.parent` with the parent's exact origin and posts to that
  origin only.
- **Images**: own-document `/api/files/…` URLs get a 15-minute, read-only,
  doc-scoped `file-access` JWT (`GET /api/docs/:docId/file-token`, same
  access decision as `/api/files`). Only `/api/files` accepts that scope; the
  sync server rejects every scoped token.
- **Off-screen throttling**: Chromium throttles rendering of off-screen
  cross-origin frames, so the hidden print iframe sits inside the viewport
  (1×1 px, transparent, click-through).

The server render page (`app/pages/_internal/render/[docId].vue`) is a
top-level page in the renderer's own Chromium (no app session there at all);
its CSP is `buildRenderCsp()` and its network is limited by the renderer
allowlist (§C). Mermaid runs in each document's own context: inside the
sandboxed iframe for preview/print, on the render page for the server PDF —
never in the app's origin.

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

This expands all label substitutions and surfaces any quoting bug before deploy. The CSP is not in the compose file any more — `curl -sI https://${DOMAIN}/ | grep -i content-security` shows the app's header (a new nonce on every request).

---

## 5. Follow-ups (not done here)

- **HSTS preload submission** — manual step at https://hstspreload.org/ once HSTS has run unmodified for ~30 days. Removal takes weeks.
- **CSP violation reporting** — add `report-uri /api/_internal/csp-report` once a Nitro endpoint exists to ingest reports into Sentry as `component=csp` events.
- **`docker-compose.local.yml`** — the local stack does not apply the Traefik header set (HSTS, frame-deny, …). It does get the app's CSP + CORP, like every production build.
- **`style-src 'unsafe-inline'`** — would need nonces/hashes for Nuxt UI's token block plus a KaTeX/paged.js pipeline without inline styles; not planned.
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
