# Security Hardening

How the markoto stack is hardened, for self-hosted instances and the hosted service alike (setup steps for self-hosters: [SELF-HOSTING.md](./SELF-HOSTING.md)).

- §A. HTTP headers + CSP, the CSP + CORP come from the app itself, the rest
  from the Traefik edge; preview iframe isolation.
- §B. Valkey deployment posture, password enforcement, network exposure,
  optional TLS for managed-Redis providers.
- §C. Containers, networks and database roles, least-privilege
  containers, the Chromium sandbox in the renderer, purpose networks,
  the Docker socket proxy, separate Postgres roles.
- §D. Public edge and access control, internal endpoints kept off the
  edge, default-deny API authentication, sync connections that end with
  their authorization, published pages on their own hostname, tenancy
  enforced below the handler with capability proofs.
- §E. Secrets at rest, telemetry and the supply chain, encryption of
  stored credentials, Sentry scrubbing, test-only code absent from release
  builds, digest-pinned images.

Postgres connections of a production build use TLS with certificate
verification (`shared/utils/runtime/postgresSsl.ts`): against the system CA
store, or against the CA in `PGSSLROOTCERT` (an unreadable path stops the
app at boot). `PGSSL=disable` turns TLS off, for a database on the same
Docker network such as the bundled self-host Postgres.

---

# Section A: HTTP Headers + CSP

Where: every HTTPS response from the production stack carries a fixed set of
security headers. Most come from the Traefik edge (`security-headers`
middleware in `deploy/compose/compose.prod.yml`, `markoto-headers` in
`deploy/compose/compose.selfhost.yml`). **`Content-Security-Policy` and
`Cross-Origin-Resource-Policy` come from the app** (`server/plugins/csp.ts`,
policies in `server/utils/rendering/csp.ts`): the CSP carries a per-response script
nonce that has to match the HTML, `/api/files` needs a different CORP than the
rest, and one builder in code means hosted, self-host, local and the test
stacks all serve the same policy. Traefik must NOT set either header on
the app: a Traefik CSP would be enforced in addition to the app's (pinned
by `tests/unit/rendering/csp.test.ts`). The hosted deployment serves sync
from its own subdomain with a parallel `sync-security-headers` middleware
(no HTML, no CSP); the self-host stack serves it under `/sync` on the app's
origin.

This file documents what each header is for, the CSP rationale, the isolation
of the preview/print iframes, and the verification recipe.

---

## 1. The header set

Values applied to every response from the app router (hosted deployment,
`deploy/compose/compose.prod.yml`):

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

The self-host stack (`markoto-headers` in `deploy/compose/compose.selfhost.yml`)
sends the same set with HSTS `max-age=31536000` only (no
`includeSubDomains`, no `preload`) and `payment=()`.

| Header | Why |
|---|---|
| `Strict-Transport-Security` | Forces HTTPS for one year. On the hosted domain it includes all subdomains, and `preload` makes the domain eligible for the browsers' HSTS preload list (submission at hstspreload.org is a separate manual step). Once a browser sees this header, it pins HTTPS even if the user types `http://`, there is no quick way back, so serve it only once TLS works on every covered host. Browsers ignore it on plain http. |
| `X-Content-Type-Options: nosniff` | Blocks MIME-sniffing; an asset served with the wrong `Content-Type` cannot be retroactively interpreted as JS by the browser. Defense in depth against any future content-type bug. |
| `X-Frame-Options: DENY` | No origin can iframe markoto. Mitigates click-jacking. The CSP already sets `frame-ancestors 'none'`; DENY covers older browsers. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Same-origin requests carry the full URL; cross-origin requests carry only the origin (no path). External links from a doc don't leak which doc the user was reading. |
| `Cross-Origin-Opener-Policy: same-origin` | A new tab opened from markoto cannot keep a `window.opener` reference back to markoto. Tightens postMessage / Spectre-style surfaces. |
| `Cross-Origin-Resource-Policy: same-site` | Other origins cannot embed our static resources via `<img>`/`<script>`/etc. unless they're under the same site. Set by the app. Exception: `/api/files/*` (a 302 to a presigned S3 URL) is `cross-origin`, the preview iframe runs in an opaque origin, which is never "same site", and its images go through this route; access there is decided by the session / file-access token, not by the requesting origin. Same for `/markoto-logos/*`, the public brand marks the default theme puts on cover pages, `/vendor/*`, the self-hosted paged.js / Mermaid / KaTeX / highlight.js files and web fonts, and `/api/docs/:docId/brand/*`, a workspace's brand-kit fonts and logos (token-gated like `/api/files`). `/vendor/*` and the brand files also answer `Access-Control-Allow-Origin: *` because fonts and the SRI-locked tags load in CORS mode (`server/utils/rendering/vendorAssetHeaders.ts`). The files of published pages (`/api/published/*`) are `same-origin`: only the page that serves them may load them. All in `crossOriginResourcePolicyFor` (`server/utils/rendering/csp.ts`). |
| `Permissions-Policy` | Disables camera + geolocation outright. Allows microphone (live dictation needs it) only on our own origin; payment is `self` on the hosted service and off on self-host. No third-party iframe can use any of these. |

---

## 2. Content Security Policy

Built per response by `buildAppCsp()` (`server/utils/rendering/csp.ts`), sent by
`server/plugins/csp.ts` on every response of the production build (the
`nuxt dev` server sends none, Vite's HMR client would trip it). Hosted shape:

```
default-src 'self';
script-src 'self' 'nonce-<per response>' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
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
'none'`, the same script/style/font sources (`'self'` + nonce), images
from `'self'`, the S3 origin and `RENDERER_ALLOWED_ORIGINS`, `connect-src
'self'`, no frames, `form-action 'none'`.

### Sources and why

| Source | Why |
|---|---|
| `'nonce-…'` | Nuxt's own inline scripts (payload/config, color-mode), stamped by the `render:html` hook on the head and body-edge chunks only, never on the rendered page body. The preview/print srcdoc iframes inherit the policy; their inline scripts carry the same nonce (read from `script.nonce` by `currentCspNonce()`). |
| No CDN | paged.js, Mermaid, the KaTeX stylesheet + fonts, the highlight.js themes and every web font are served from our own origin under `/vendor/` (`shared/utils/vendor/vendorAssets.ts`, copied from the pinned npm packages at build time by `modules/vendor-assets.ts`), so `'self'` covers them and no third-party host appears in the policy. Visitors' browsers send their IP address to nobody but us. The scripts and stylesheets stay SRI-locked (`shared/utils/*Assets.ts`; the build fails when the installed package's bytes differ). |
| `'wasm-unsafe-eval'` | `@nuxt/content` compiles its SQLite WASM in the browser for client-side docs queries. Allows WebAssembly compilation only, not `eval`/`new Function`. |
| `data:` in `font-src` / `img-src` | KaTeX font fallbacks; Mermaid diagrams render as `data:image/svg+xml` `<img>`s; custom CSS may use raster `data:image/*`. |
| S3 origin | Presigned image GETs (`/api/files` 302s there) and presigned upload PUTs. |
| sync origin | Hocuspocus WebSocket. |
| Sentry ingest origin | Browser error reporting (derived from the DSN, no wildcard). |
| `blob:` in `worker-src` / `img-src` / `media-src` | PWA service-worker plumbing, paste-upload previews, dictation audio. |

No Stripe origin: billing uses the Stripe Checkout **redirect**, not Stripe.js.

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

Regression pins: `tests/unit/rendering/csp.test.ts` (exact policy string, no proxy CSP
label in any compose file, every hljs theme has an SRI hash),
`tests/unit/rendering/pagedPreviewIframe.test.ts` (nonce on every inline script of the
iframe bootstrap, no inline handlers), and the Playwright suite
`tests/e2e/flows/preview-isolation.spec.ts` (no CSP violation on the editor
with a doc using images + Mermaid + KaTeX + highlight.js, the landing page
and the docs site).

---

## 3. Preview + print iframe isolation

Rendered document content is attacker-influenced (any editor of the doc,
imports, the AI). It is DOMPurify-sanitised, but the preview is where a
sanitizer bypass would execute, so it executes somewhere harmless:

| Iframe | `sandbox` | Origin |
|---|---|---|
| live preview (`app/composables/preview/usePagedPreview.ts`) | `allow-scripts` | opaque (`null`) |
| browser print (`app/utils/preview/printPdf.ts`, same bootstrap) | `allow-scripts allow-modals` | opaque (`null`) |

No `allow-same-origin`: script inside the preview cannot read the app's
cookies or storage (both throw), cannot touch `window.parent`'s DOM, and its
requests to the app are cross-site, no session cookie, and the CSRF check
refuses state-changing calls from origin `null`. Also omitted: `allow-forms`,
`allow-popups`, `allow-top-navigation`; every link click in the preview is
intercepted (fragments scroll, everything else is inert) and `frame-src
'self'` refuses navigation elsewhere. `allow-modals` (print only) is what
lets `window.print()` open the dialog.

How the preview still works:

- **postMessage protocol** (`app/utils/preview/previewFrame.ts`): render requests and
  the app's color mode go in; ready / page count / errors / print shortcut /
  print done come out. The parent accepts messages only from the iframe's
  window with origin `null`, validated per type; the iframe accepts them only
  from `window.parent` with the parent's exact origin and posts to that
  origin only.
- **Images**: own-document `/api/files/…` URLs get a 15-minute, read-only,
  doc-scoped `file-access` JWT (`GET /api/docs/:docId/file-token`, same
  access decision as `/api/files`). Only `/api/files` accepts that scope; the
  sync server rejects every scoped token.
- **Scripts, styles and fonts** come from our own origin (`/vendor/…`), which
  is cross-origin for the opaque iframe: those paths answer with
  `Cross-Origin-Resource-Policy: cross-origin` and
  `Access-Control-Allow-Origin: *` (public, versioned, credential-less
  files), the SRI-locked tags carry `crossorigin="anonymous"`. Chromium
  exempts plain `localhost` from part of this, test on a real host name
  (e.g. `markoto.127.0.0.1.nip.io`).
- **Off-screen throttling**: Chromium throttles rendering of off-screen
  cross-origin frames, so the hidden print iframe sits inside the viewport
  (1×1 px, transparent, click-through).

The server render page (`app/pages/_internal/render/[docId].vue`) is a
top-level page in the renderer's own Chromium (no app session there at all);
its CSP is `buildRenderCsp()` and its network is limited by the renderer
allowlist (§C). Mermaid runs in each document's own context: inside the
sandboxed iframe for preview/print, on the render page for the server PDF,
never in the app's origin.

---

## 4. Verification

After deploy:

```bash
curl -sI "https://${DOMAIN}" | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy|cross-origin|permissions-policy'
```

Expected output (one line per header). Spot-check the CSP with a real
browser: load the editor, open DevTools → Console, there should be **zero**
CSP violation reports during normal use (open a doc, type, switch themes,
trigger AI, generate a PDF). If a violation appears, decide whether the
allowlist is missing a host or whether the offending code is wrong. The
Network tab should show no request to any host but the app, sync, S3 and
(if configured) Sentry: no font or script CDN.

On the hosted layout, sync has its own subdomain:

```bash
curl -sI "https://sync.${DOMAIN}/health" | grep -iE 'strict-transport|x-frame|cross-origin'
```

Should match the app-domain headers minus CSP.

`docker compose -f <compose file> config > /dev/null` expands all label
substitutions and surfaces a quoting bug before deploy. The CSP is not in
any compose file: `curl -sI https://${DOMAIN}/ | grep -i content-security`
shows the app's header, with a new nonce on every request.

---

## 5. Known gaps

- **No CSP violation reporting.** The policy has no `report-uri`; violations show only in the browser console.
- **`deploy/compose/compose.local.yml`** does not apply the Traefik header set (HSTS, frame-deny, …). It does get the app's CSP + CORP, like every production build.
- **`style-src 'unsafe-inline'`** stays: removing it would need nonces or hashes for Nuxt UI's token block and a KaTeX / paged.js pipeline without inline styles.
- **The S3 bucket must be private** (no public `ListBucket` or read): the app never relies on public access, but it cannot check the bucket's policy. See [S3-SETUP.md](S3-SETUP.md#1-create-the-bucket).

---

# Section B: Valkey Deployment Posture

## Threat model

At-rest encryption of disks and managed databases is left to the hosting
provider. The trust boundary does **not** include a Valkey host port,
Valkey requires a password and sits on the internal `data` network only
(§C.3). The threat this closes: any process on the host (a misconfigured
neighbour container, an ops tool with looser permissions) reading or
writing rate-limit counters, presence keys, render locks and per-doc edit
attribution by connecting to `127.0.0.1:6379`.

The data in Valkey is operational, not user content, tampering with it
could bypass rate limits or briefly corrupt activity-log attribution, not
exfiltrate documents. So password + network isolation is enough; TLS is
off by default (see §B.4).

## B.1 Password enforcement

| Stack | Password | How |
|---|---|---|
| Production (`deploy/compose/compose.prod.yml`) | `${VALKEY_PASSWORD:?required}` from `.env` (≥32 random chars) | `--requirepass` arg + every consumer passes `VALKEY_PASSWORD` env var |
| Local full-stack (`deploy/compose/compose.local.yml`) | `${VALKEY_PASSWORD:?required}`, any string in `.env`, never internet-reachable | same as prod, mirrors the auth code path |
| Dev (`deploy/compose/compose.dev.yml`) | `${VALKEY_PASSWORD:-devpassword}`, defaults to a weak literal | host bun reads `VALKEY_PASSWORD=devpassword` from `.env.example` |
| Test (`deploy/compose/compose.test.yml`) | hardcoded `testpassword` | matches `tests/integration/setup/env.ts` literal |

The dev/test password is hardcoded weak ON PURPOSE: those stacks expose
6379 (or 6380) only on `127.0.0.1`, hold no real data, and exist to
exercise the SAME auth code path prod uses, so a regression that
silently disables `requirepass` breaks tests before it ships.

The runtime client config flows through `valkeyClientConfigFromEnv()` in
`shared/utils/runtime/connectionStrings.ts` → `new Redis(url, options)` in both
`server/utils/platform/valkey.ts` and `sync-server/src/valkey.ts`. The `url` is
`redis://:password@host:port/db` (or `rediss://…` for TLS, see §B.4).

## B.2 Network exposure

| Compose file | Valkey listener | Why |
|---|---|---|
| `deploy/compose/compose.prod.yml` | `expose: ["6379"]` (`data` network only, no host port) | The app, sync, LiteLLM and backup containers reach Valkey over the internal `data` bridge (§C.3); the renderer and markitdown can't. Publishing 6379 would let any VPS-host process bypass docker network ACLs. |
| `deploy/compose/compose.local.yml` | `expose: ["6379"]` (same) | App runs IN a container; no host access needed. |
| `deploy/compose/compose.dev.yml` | `ports: ["127.0.0.1:6379:6379"]` | Nuxt runs on the host (`bun run dev`) and reaches Valkey via `localhost:6379`. Loopback only: the weak dev password must never face the LAN. |
| `deploy/compose/compose.test.yml` | `ports: ["127.0.0.1:6380:6379"]` | vitest runs on the host and reaches Valkey via `localhost:6380`. tmpfs storage; loopback only. |

Valkey listens on `0.0.0.0` inside the container (the upstream image
default): that's correct because the docker bridge IS the only route in
when `ports:` is unset. We deliberately do NOT pass `--bind 127.0.0.1`
to the container; that would prevent app/sync containers on the bridge
from connecting.

Verify post-deploy:

```bash
ss -ltnp | grep :6379         # expect: nothing on the host
docker compose exec app sh -c 'echo "PING" | nc -q1 valkey 6379'   # expect: connection refused without auth, or NOAUTH after PING
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

## B.4 Optional TLS

With app and Valkey containers on the same Docker network, the network is
the trust boundary and TLS adds nothing: the hosted and self-host compose
files pin `VALKEY_HOST=valkey` and do not pass the variables below (the
hosted deploy does not render them either). They are for running the app
and sync server against a Valkey on a separate host (a managed Redis /
Valkey service), which needs TLS:

| Var | Default | When set |
|---|---|---|
| `VALKEY_TLS_ENABLED` | `false` | Set `true` to wrap the connection in TLS. The client uses `rediss://` and ioredis's TLS support against the system CA store. |
| `VALKEY_TLS_CA_PATH` | unset | Optional path to a provider-supplied CA PEM. Only needed for providers using a private CA, most public providers issue certs from a public CA chain that the system store already trusts. |

Wire-up: `valkeyClientConfigFromEnv()` (in
`shared/utils/runtime/connectionStrings.ts`) reads both vars and returns
`{ url, options: { tls: { ca? } } | undefined }`. Both
`server/utils/platform/valkey.ts` and `sync-server/src/valkey.ts` spread the
returned options into `new Redis(url, options)`. Docs in `.env.example`.

The bundled Valkey container does not serve TLS; a self-run TLS Valkey
needs `--tls-port`, `--port 0`, `--tls-cert-file`, `--tls-key-file` and
`--tls-ca-cert-file` on the `valkey-server` command. A managed service
hands you a TLS endpoint ready to use.

## B.5 Verification recipe

After a deploy or a password change, run on the host (the commands use the
hosted compose file; on self-host plain `docker compose` works):

```bash
# Without auth: expect NOAUTH error.
docker compose exec valkey valkey-cli ping
# Output: NOAUTH Authentication required.

# With auth: expect PONG.
docker compose exec valkey \
  valkey-cli --no-auth-warning -a "$VALKEY_PASSWORD" ping
# Output: PONG

# From the app container: expect PONG (container has VALKEY_PASSWORD env).
docker compose exec app sh -c \
  'apk add --no-cache redis 2>/dev/null; redis-cli -h valkey -a "$VALKEY_PASSWORD" --no-auth-warning ping'

# Confirm no host port exposed.
ss -ltnp | grep -E ':6379|:6380' || echo "ok: no valkey on host"
```

## B.6 Rotating the password

`VALKEY_PASSWORD` has no rollover window: change it in `.env` and recreate
Valkey and every service that connects to it (`docker compose up -d`). The
bundled Valkey runs with `--appendonly yes`, so rate-limit and attribution
state survive the restart.

---

# Section C: Containers, networks and database roles

The goal: a compromise of any one container, most plausibly the renderer
(Chromium on user-authored HTML/CSS/SVG) or markitdown
(parsers for uploaded Office/PDF files), gives the attacker as little as
possible: no root, no capabilities, nothing writable outside tmpfs, no
route to the database or the AI gateway, no Docker API. Enforced in CI by
`scripts/selfhost-check.sh` for the selfhost, prod and local stacks. The
hosted deployment adds a rootless engine underneath (§C.8).

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
| traefik | root **without capabilities** | read-only | binding 80/443 needs no capability: Docker sets `ip_unprivileged_port_start=0` in the container, on Podman the compose files set it (it is per network namespace). Hosted: root in the rootless user namespace is the `markoto` user, which owns `traefik/acme.json`, so no `DAC_OVERRIDE` |
| edge-proxy (hosted) | `haproxy` (image) | read-only | the only container in the host network namespace: binds 80/443 (host sysctl `ip_unprivileged_port_start=80`), relays TCP to Traefik's loopback ports with a PROXY header (§C.8) |
| socket-proxy | root without capabilities (to open the `root:docker` socket; hosted: the `markoto` user's Podman socket) | read-only, tmpfs `/tmp` `/run` | §C.4 |
| db-init | `postgres` | read-only | one-shot, §C.5 |
| backup | `postgres` (uid 70) | writable | stages the encrypted dump in `/tmp`, which can be large |
| postgres, seaweedfs | image entrypoint (root → drops to its user) | writable | keep `CHOWN DAC_OVERRIDE FOWNER SETGID SETUID` only, what the entrypoint needs to fix data-dir ownership and drop privileges |

## C.2 Renderer: Chromium's sandbox

The renderer runs as `pwuser` and launches Chromium **with** its sandbox
(`chromiumSandbox: true`, `renderer/src/render.ts`). As an unprivileged process without
capabilities, Chromium's zygote sandboxes renderer processes in new user /
PID / network namespaces. Docker's default seccomp profile only allows
`clone(CLONE_NEWUSER)` / `unshare` / `chroot` with `CAP_SYS_ADMIN` /
`CAP_SYS_CHROOT`, so the renderer gets its own profile,
`deploy/config/renderer/seccomp.json`: Docker's default profile
(the default seccomp profile of github.com/moby/profiles, Apache-2.0) plus one
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
  > deploy/config/renderer/seccomp.json
```

On Podman (the hosted stack, and any stack started with
`deploy/compose/compose.podman.yml`) the custom profile can't be handed
over (Compose sends it inline, Podman's API expects a path), so the
renderer runs under Podman's default seccomp profile, which already
allows the namespace syscalls, plus `CAP_SYS_CHROOT` for Chromium's
`chroot`. That capability is ambient for `pwuser` and acts only inside the
container's own mount namespace. Rootless Podman applies no AppArmor
profile (Docker's `docker-default` does), so on the hosted stack the
renderer's confinement is seccomp, no other capabilities, the read-only
root and the user namespace (§C.8).

Escape hatch: a host that forbids unprivileged user namespaces entirely
(`kernel.unprivileged_userns_clone=0`, some hardened kernels, rootless
setups) fails renders with "No usable sandbox!". There,
`RENDERER_CHROMIUM_SANDBOX=false` on the renderer service launches Chromium
without its sandbox (logged as a warning at boot). Everything else in this
section still applies, so the blast radius stays the renderer container.

## C.3 Purpose networks

Each service joins only the networks it needs. `internal: true` networks
have no route off the host. The self-host stack prefixes every name with
the instance (`<instance>-data`, …).

| Network | Members | Internal |
|---|---|---|
| `web` / `edge` | traefik, app, sync | no (published entrypoint, app/sync egress) |
| `docker-api` | traefik, socket-proxy | yes |
| `data` | postgres, valkey, app, sync, litellm, db-init, backup | yes |
| `render` | app (alias `markoto-app`), renderer | yes |
| `import` | app, markitdown | yes |
| `storage` (self-host, local) | seaweedfs, traefik, app, renderer, backup, s3-init | yes (local: no, for the loopback-published S3 port) |
| `egress` | litellm, backup (+ db-init in prod) | no, AI providers, managed Postgres, external S3 |
| `renderer-egress` | renderer only | no, S3 / the public URL presigned images point at (the browser-level allowlist in `renderer/src/allowlist.ts` still applies: app origin + S3 + `RENDERER_ALLOWED_ORIGINS`, no CDN) |

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
compromised Traefik therefore cannot create a privileged container,
i.e. cannot become root on the host. It can still read container
metadata (including environment variables), inherent to the docker
provider. Verify: `docker compose exec traefik wget -qO- --post-data= http://socket-proxy:2375/containers/create` → `403 Forbidden`.

Hosted: the proxy mounts the `markoto` user's rootless Podman socket
(`CONTAINER_SOCKET`, exported by `markoto-compose`). Even full access to
that API means control of `markoto`'s containers, not root on the host.

## C.5 Postgres roles

`POSTGRES_USER` is the **admin** role (the bundled image's bootstrap
superuser, or the managed cluster's admin user). It is used only by the
`db-init` one-shot and the backup sidecar. With `POSTGRES_APP_USER` /
`POSTGRES_APP_PASSWORD` and `POSTGRES_LITELLM_USER` /
`POSTGRES_LITELLM_PASSWORD` set, `db-init` (`deploy/config/postgres/db-init.sh`,
idempotent, runs on every `up`):

- creates both roles as `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, and
  re-applies their passwords (rotation = change `.env`, `up -d`);
- makes the app role the owner of the app database and the LiteLLM role the
  owner of `litellm`, and hands over every object the admin created before
  (tables, sequences, views, functions, enum types, the `drizzle` schema,
  extension-owned pgvector objects stay with the admin);
- creates the `vector` extension as admin (not a trusted extension);
- revokes `CONNECT`/`TEMP` on both databases from `PUBLIC`, the LiteLLM
  role cannot open the app database and vice versa.

The app needs LiteLLM's spend-log table for the 90-day retention sweep and
the admin spend query; it connects with the LiteLLM role for that
(`NUXT_LITELLM_DB_USER` / `_PASSWORD`, `server/db/litellm.ts`).
That widens nothing: the app already holds the LiteLLM master key; the
separation protects the app database *from* a compromised proxy.

`install.sh` generates the roles for every self-host install and upgrade.
Without the four variables set, every service connects as the admin role.

## C.6 Dev and test stacks

`deploy/compose/compose.dev.yml`, `deploy/compose/compose.test.yml` and
`deploy/compose/compose.local.yml` publish every port on `127.0.0.1` only (they run
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

On the hosted stack use `markoto-compose` (as `markoto`) instead of
`docker compose`.

## C.8 Hosted deployment: rootless Podman

_Operator docs for the hosted markoto.app deployment. Self-hosters can skip this section; it records how that one deployment is set up._

Staging and prod run the stack on Debian 13 with rootless Podman 5.4, as the
unprivileged `markoto` user (`infra/README.md`). What that adds, and what it
does not:

**Adds**

- **No root anywhere in the container path.** There is no root daemon. Root
  inside a container is `markoto` on the host; every other container uid is
  a subordinate id that owns nothing on the host. A container escape lands
  as an unprivileged user, not as root as with a rootful engine.
- **The engine API is not root-equivalent.** Docker's socket (and the
  `docker` group) amounts to root on the host. The Podman socket here gives
  control of `markoto`'s containers, volumes and images, and nothing else.
- **The deploy key can do nothing but drive the stack.** GitHub Actions logs
  in as `markoto` (no sudo, no password); the key is installed with
  `restrict` (no port, agent or X11 forwarding, no pty) and is that
  account's only key. Administration goes through `debian`, whose key never
  leaves the operator.
- **The firewall governs the published ports.** Docker publishes ports
  through its own iptables chains, past ufw. Rootless publishing happens in
  user space in the host network namespace, so ufw's deny-by-default
  applies; only 22, 80 and 443 are open, and Traefik listens on loopback.
- **The host keeps CIS's `ip_forward=0`**: rootless networking routes inside
  its own network namespace.

**Does not add, or costs**

- **The stack's secrets are still the stack's.** `.env`, the database (on
  staging), the S3 and provider keys all belong to `markoto`, and so does
  every container. A compromise of the app, or of `markoto`, reaches all of
  them, exactly as before. Rootless protects the host (OS, SSH, firewall,
  the admin account, persistence), not the application data.
- **Unprivileged user namespaces are on** (`kernel.unprivileged_userns_clone=1`,
  overriding devsec.hardening's Debian default). Rootless Podman needs them,
  and so does Chromium's sandbox in the renderer. They add kernel attack
  surface for every local user; the host has no other untrusted users.
- **No AppArmor profile** on rootless containers (§C.2). Confinement is the
  user namespace, `cap_drop: [ALL]`, `no-new-privileges`, seccomp (Podman's
  default; the renderer's custom profile only on Docker) and read-only roots.
- **Ports 80 to 1023 are unprivileged on the host**
  (`net.ipv4.ip_unprivileged_port_start=80`), so `edge-proxy` can bind 80
  and 443 without capabilities. Any local user could bind a port in that
  range while it is free; sshd (22) stays privileged.
- **Client addresses depend on the edge relay.** Rootless port publishing
  (`rootlessport`) hides the client address. `edge-proxy`, in the host
  network namespace, passes it to Traefik in a PROXY protocol v2 header;
  Traefik accepts the header only from its own two networks (pinned
  subnets). If the trust list and the subnets drift apart, Traefik ignores
  the header and every request appears to come from one internal address
  (per-IP rate limits and audit IPs collapse). `scripts/selfhost-check.sh`
  pins the two together. The relay handles only TCP; TLS stays in Traefik.
- **TLS certificates use ECDSA P-256 keys** (`acme.keytype=EC256`, also in
  the self-host TLS overlay). An RSA-4096 handshake cost about 40 ms of host
  CPU, so about 100 new connections per second saturated the host: a cheap
  way to exhaust it. Session resumption is on (Traefik's default).
- **The edge refuses instead of dying.** HAProxy admits at most `maxconn`
  connections and caps its own memory (`-m`); Traefik's memory limit is
  sized for that number (`docs/contributing/CONTAINER-ENGINES.md`, "Edge
  sizing"). Past the cap, clients wait in the listen queue.

Verify on a host:

```bash
# as markoto
podman info --format '{{.Host.Security.Rootless}} {{.Host.RootlessNetworkCmd}}'   # true pasta
podman top markoto-app-1 user huser          # container user and the host uid it maps to
markoto-compose ps edge-proxy traefik
# from another machine: the app must see your address, e.g. the IP of your
# own sign-in in the admin audit log (truncated to /24 or /48)
# as debian
sudo ss -ltnp | grep -E ':(80|443|10080|10443)\b'   # 80/443 on all addresses, 10080/10443 on 127.0.0.1 only
sudo ufw status
```

---

# Section D: Public edge and access control

## D.1 Internal endpoints stay off the public edge

Some routes exist only for other containers of the stack:

| Route | Caller | Authentication |
|---|---|---|
| app `/api/internal/**` | sync server | `X-Internal-Secret` (`NUXT_INTERNAL_API_SECRET`, or its `_PREVIOUS` value during a rotation) |
| app `/api/internal/traefik/custom-domains` | Traefik's HTTP provider | its own token (`NUXT_PUBLISH_TRAEFIK_TOKEN`) |
| app `/_internal/render/**`, `/api/_internal/render-bootstrap` | the renderer's Chromium | a short-lived render JWT |
| sync `/internal/**` | app | `X-Internal-Secret` |
| renderer | app | `X-Internal-Secret` |
| markitdown (every endpoint but `/health`) | app | `X-Markitdown-Secret` (`NUXT_MARKITDOWN_API_SECRET`) |

Three layers keep them private:

1. **Routing.** The public Traefik routers of the hosted, self-host and
   local stacks exclude these path prefixes (`scripts/selfhost-check.sh`
   asserts it); the renderer and markitdown have no public router at all.
2. **Edge-header check.** App and sync server answer **404** to a request
   on an internal route that carries a header Traefik adds to every
   forwarded request (`X-Forwarded-Server`, `X-Forwarded-Host`,
   `X-Real-IP`, `Forwarded`), even with a valid secret
   (`shared/utils/security/internalSecret.ts`,
   `server/utils/platform/internalRoutes.ts`). Internal callers reach the
   service directly over the Docker network and never send them.
3. **Secret.** One constant-time, rotation-aware check
   (`checkInternalSecret`) shared by app, sync server and renderer. A
   service without a configured secret refuses the request.

The checks run in `server/middleware/auth.ts` on the normalised path
(decoded, lower-cased, repeated slashes collapsed), so a new route under
one of these prefixes cannot be public by accident.

## D.2 Default-deny API authentication

`server/middleware/auth.ts` requires a valid session for every `/api/**`
route that is not on its explicit list of public routes. A new public
endpoint needs an entry there; a route that forgets its own check stays
closed. Public routes (document token, metadata, file access, PDF, …) make
their access decision in the handler. State-changing `/api` requests must
also pass the Origin / `Sec-Fetch-Site` check in `server/middleware/csrf.ts`.

## D.3 Sync connections end when their authorization ends

The sync server checks a document token when a connection authenticates
and then tracks its expiry (`sync-server/src/connection-expiry.ts`):

- Shortly before a token expires, the server asks the client for a fresh
  one; the editor fetches it from the app's token endpoint, which checks
  access again, and the connection continues.
- A connection whose token is not renewed by its expiry is closed with a
  re-authenticate reason.
- When access to a document becomes stricter (access mode, password, share
  link expiry, view-only, moderation, workspace move), the app calls the
  sync server's `/internal/reauth-document`; tokens issued before the
  change no longer open the document, and open connections must
  re-authenticate.

Document tokens live at most 2 hours, and never past a share link's expiry
(`server/utils/documents/docJwt.ts`).

## D.4 Published pages on their own hostname

A published page is HTML a user wrote. With `NUXT_PUBLISH_PAGES_HOST` set,
pages are served from that hostname, and `/p/<slug>` on the app redirects
there (`server/utils/publish/pagesHost.ts`,
`server/middleware/00.custom-domain.ts`). The pages host and every custom
domain:

- serve only the page, its files (`/api/published/…`), `/vendor/…` and
  `robots.txt`: no app, no API, no sign-in, GET and HEAD only;
- never receive or set a session cookie: the session cookie is host-only
  on the app's hostname, the incoming `Cookie` header is dropped and
  `Set-Cookie` is blocked on every response from these hosts;
- serve page files with `Cross-Origin-Resource-Policy: same-origin`.

Without it (the self-host default), pages share the app's origin at
`<app>/p/<slug>`. With `NUXT_LEGAL_SURFACES_ENABLED=true` (the hosted
shape) the app refuses to boot without it; for a public self-hosted
instance it is recommended (see
[SELF-HOSTING.md](SELF-HOSTING.md#published-pages)).

## D.5 Tenancy: capability proofs below the handler

The access decision is made once, in the access layer
(`server/utils/access/`, with the pure rules of
`shared/utils/documents/docPermissions.ts`), and turned into a **proof**:
`DocAccess<level>`, `WorkspaceAccess<level>`, `UserScope`, `AdminActor` or
`SystemActor` (`server/repos/proofs/`). Every repo function that writes,
deletes or returns tenant-private data demands one and takes the object id
from it. The repos are the only code that talks to the database
(dependency-cruiser `db-access-only-in-repos`, ESLint
`markoto/data-access-boundaries`).

Who mints proofs:

| Minter | Proofs |
|---|---|
| Handler policies (`server/utils/api/policy*.ts`) | `docAccess` at the route's need, `workspaceAccess` at the caller's role, `self`, `adminActor`; `prove.workspace(id, need)` / `prove.doc(id, kind)` for a second object (a move or copy target, a document named in the body), bound to the authenticated caller; SCIM and render-token routes get a workspace / view proof held by a named job |
| MCP tool wrapper (`server/mcp/lib/wrapDocBoundTool.ts`), AI tools | `proveDocMembership` / `proveWorkspaceAccess` for the acting user, through the same rules |
| Background jobs, webhooks, internal routes | `system('<job name>')`, which may act on anything |

What this guarantees:

- **A missing check fails to compile, not open.** A handler or tool that
  takes an id from a URL, body or model output cannot pass it to a repo
  function; it needs a proof for that object, and only the access layer
  makes one after deciding.
- **Sub-resources stay inside their parent.** Activity rows, comments,
  uploads, shares, knowledge files, brand assets, invites, templates and
  members are addressed by their own id but queried with the parent from
  the proof (`… AND workspace_id = ${ws.workspaceId}`), so the id of another
  tenant's row returns nothing (`tests/repos/tenancyIsolation.test.ts`).
  AI conversation memory and session provenance are keyed by the document
  AND the user of one document proof; an AI session row is found and
  released only for its initiator.
- **Every exported repo function takes a proof or is listed with a
  reason.** `tests/unit/access/repoProofs.test.ts` walks the exports of
  `server/repos/**` with the TypeScript checker and fails for a function
  without a proof parameter that is not on its exemption list, and for a
  listed one that has since gained a proof. The exemptions: the
  authorization bootstrap (it decides who the caller is, so no proof exists
  yet: `repos/access/`, the session's user row and epoch, OAuth and SSO
  sign-in lookups), the proof machinery, pure helpers, database plumbing,
  public-by-design reads (published pages, the custom-domain routing table,
  whether a document id exists), the token-keyed waitlist, and billing
  state keyed by the paying subject (LiteLLM keys and spend, credit grants,
  plans, subscriptions, image quota): billing resolves that user or
  workspace once from an authorized request or a named job and hands it to
  every AI call and sweep, so a proof minted inside billing from the same
  id would check nothing.
- **Proofs cannot be forged in production code.** The classes are nominal
  (an object literal does not type-check), their constructors take a
  module-private token whose type is its own unique symbol (so `new` does
  not type-check outside the proof module, and throws if forced), and
  instances are frozen. The mint is importable only from the access layer,
  the test mint only from `tests/**` (dependency-cruiser + ESLint). Lying
  to the compiler is refused by lint in `server/**`: the type-aware rule
  `markoto/no-proof-forgery` (`scripts/lint/proofRules.mjs`) rejects any
  type assertion whose target is or holds a proof type (through aliases,
  `as unknown as …`, `Parameters<…>`, arrays, object types) and any `any`
  / `never` value in a slot whose type holds a proof (`repo(x as never)`,
  `repo(JSON.parse(s))`, `const p: DocAccess = Object.create(…)`);
  `as any` is refused everywhere (`no-explicit-any`), and `@ts-ignore` /
  `@ts-expect-error` / `@ts-nocheck` in server code (`ban-ts-comment`).
  A test refuses an `eslint-disable` of these rules in `server/**`
  (`tests/unit/access/proofRules.test.ts`).
  The authorization bootstrap reads (`server/repos/access/`: role, document
  ACL row, token hash) are importable only by the access layer.
- **The proof entry points have named callers.** The access-layer
  functions that turn a user id or a decision the caller made into a proof
  (`docProofFor`, `workspaceProofFor`, `proveRenderDoc`, `proveSelf`,
  `proveAdmin`, `proveScimWorkspace`, `proveNewDoc`, `proveDocMembership`,
  `proveWorkspaceAccess`, `proverFor`) may be imported or auto-imported
  only by the files listed per function in `PROOF_ENTRY_CALLERS`
  (`markoto/proof-entry-imports`): the handler policies and their
  second-object prover, the MCP authenticator and tool wrapper, the AI
  session and tools, the creation flows and SCIM. No handler is on the
  list: a handler that reaches a second object asks `ctx.prove`, which is
  bound to the user the policy authenticated, so it names only the object.
  `proveWorkspaceDoc` is open: it derives a document proof from a
  workspace proof the caller already holds.
- **Levels are checked by the compiler.** A view proof is not a write
  proof; a manage proof is also an edit, write and view proof
  (`tests/unit/access/proofs.test.ts`). The policy matrix
  (`tests/unit/platform/defineApiHandler.test.ts`) checks that every proof
  a policy hands out names the requested object and actor and carries
  exactly what was decided.
- **The audit actor is the proof's actor**, so an audit row cannot name
  someone other than who was authorized.

What it does not guarantee:

- **It is a code-structure control, not an isolation boundary.** All
  server code runs in one process with one database role that can read
  every tenant's rows. A deliberate forgery is still possible: a generic
  helper that casts to its type parameter (`<T>(x: unknown) => x as T`,
  called as `make<DocAccess>(…)`) hides the proof type from the rule, and
  `Reflect.construct` / `Object.setPrototypeOf` can then build an object
  with the class's prototype. Such an object lacks the private state
  (`allows()` throws), but a repo that only reads `docId` would not
  notice. Review has to catch these.
- **The access layer trusts the user id it is given.** `proveDocMembership(userId, …)`
  proves what *that* user may do; called with the wrong id it mints a
  valid proof for the wrong person. Every such entry point is limited to
  its named callers (above), which pass the policy's user, the
  authenticated token's user or the session initiator; the restriction
  does not check which id they pass.
- **Elevated actors are unrestricted.** `system(…)` and `AdminActor` reach
  every tenant. Their use is greppable by name and banned from
  user-facing handlers by lint (`markoto/no-system-actor-in-handlers`), but
  a bug in a sweeper affects everyone.
- **Proofs are not revalidated.** A proof is valid for the object it names
  for as long as the code holds it. Request handlers hold it for one
  request; an AI session holds its document proof for the whole session
  (the knowledge tools re-check the workspace role per call, and document
  JWTs bound open sync connections, §D.3).
- **The parent constraint is written by hand** in each repo function.
  The isolation tests cover the sub-resource families above, not every
  function.
- **Outside the layer:** the sync server's own `yjs_updates` SQL (guarded by
  its document JWT), LiteLLM's database, and scripts run by operators.

What row-level security would add: Postgres RLS policies on the tenant
tables, with the actor and tenant set per transaction (`SET LOCAL`), would
enforce isolation in the database itself, against a missing parent
constraint, a raw query that skips the repo layer, or an injection. The
cost is restating the access rules (owner, workspace roles, guest shares,
access modes, password and anonymous-creator access, share expiry, SSO
grants) as SQL policies next to `docPermissions.ts`, a role with
`BYPASSRLS` for the jobs, and every query running inside a transaction that
carries the settings. Markoto does not use RLS today. The proof layer is
the prerequisite: every query already runs with a known actor and tenant,
and `withTransaction` is the one place where such settings would be set.

---

# Section E: Secrets at rest, telemetry and the supply chain

## E.1 Stored credentials are encrypted per purpose and per row

The app keeps a few credentials in Postgres because it has to present them
later. All of them go through `server/utils/platform/secretBox.ts`:

| Column | Purpose (HKDF `info`) | Bound to (AES-GCM associated data) |
|---|---|---|
| `users.litellm_key_token` | `litellm-user-key` | user id |
| `workspace_members.litellm_key_token` | `litellm-member-key` | workspace id + user id |
| `user_ai_providers.api_key_encrypted` | `ai-provider-key` | user id + capability |
| `sso_connections.oidc_client_secret` | `sso-client-secret` | workspace id (one connection per workspace) |

- **Its own secret.** `NUXT_ENCRYPTION_KEY` (≥ 32 chars, required in
  production) is given to the app only. It is not LiteLLM's salt
  (`LITELLM_SALT_KEY` stays with the LiteLLM container), so a compromised
  proxy does not hold the key to the app's stored credentials.
- **One key per purpose.** Each purpose gets its own AES-256 key, derived
  with HKDF-SHA-256 from the secret; a ciphertext of one kind never
  decrypts as another.
- **Bound to its row.** The associated data names the purpose and the
  owning row, so a ciphertext copied into another user's or workspace's
  row (SQL injection, a mass-assignment bug, a restore mix-up) fails
  authentication instead of decrypting for the wrong owner.
- **Format.** `v2:<nonce>:<tag>:<ciphertext>`, a random 96-bit nonce per
  encryption. Anything else is refused with an error that carries no key,
  plaintext or ciphertext.
- **Failure is graceful.** A value that can't be decrypted (lost key,
  rotation without `_PREVIOUS`) is treated as absent: a new LiteLLM key is
  minted and the old one deleted by its id, the user is asked for their
  provider key again, the SSO sign-in answers 409 `sso/incomplete` until an
  admin enters the client secret again. Never a 500 loop.
- **Rotation.** Encryption uses `NUXT_ENCRYPTION_KEY`, decryption tries it
  and then `NUXT_ENCRYPTION_KEY_PREVIOUS`; `cli/reencrypt-secrets.js`
  rewrites every row with the current key
  ([SELF-HOSTING.md](SELF-HOSTING.md), rotating secrets).

SCIM tokens and MCP personal access tokens are not encrypted but stored as
SHA-256 hashes (high-entropy random tokens, looked up by hash), and are
never shown again after creation.

Pinned by `tests/unit/platform/secretBox.test.ts` (round trip, wrong
purpose, wrong row, tampering, rotation, nonce uniqueness, no secrets in
errors).

## E.2 What reaches Sentry

The app server, the sync server and the renderer pass every error event,
every sampled transaction and every breadcrumb through one scrubber
(`shared/utils/security/sentryScrub.ts`) wired as `beforeSend`,
`beforeSendTransaction` and `beforeBreadcrumb`, with `sendDefaultPii: false`:

- URLs (request URL, span and breadcrumb URLs, `http.url` / `url.full`)
  lose their query string, fragment and credentials, presigned S3
  signatures, render tokens (`?t=`), invite / unsubscribe tokens; query
  attributes (`url.query`, `http.query`) are dropped;
- request bodies, cookies, query strings and the process environment are
  dropped; request headers are reduced to an allowlist (content type and
  length, user agent, accept*, host, origin, referer without query,
  request id): no `authorization`, `cookie`, `x-internal-secret`,
  `stripe-signature`;
- values under keys that name a secret (token, secret, password,
  authorization, cookie, key, signature, credential, session, dsn) are
  replaced anywhere in `extra`, `contexts`, `tags`, span and breadcrumb
  data; email-like keys are masked;
- free text (messages, exception values, span descriptions) has bearer
  tokens, JWTs, provider keys (`sk-…`, `whsec_…`), AWS signature
  parameters and email addresses redacted; every string is length-capped;
- the user is reduced to the numeric id (no email, username, IP); stack
  frames lose local variables;
- a scrubber failure drops the event rather than sending it unscrubbed.

Pinned by `tests/unit/platform/sentryScrub.test.ts` (a Stripe webhook
event, a transaction with presigned S3 and render-token spans,
fetch / http / console / navigation breadcrumbs). The browser SDK
(`app/utils/platform/sentryClient.ts`) has its own, narrower `beforeSend`.

## E.3 No test-only code in release builds

The test-only routes (`server/api/_test/**`: the sign-in shim, AI-tool
execution, budget helpers, export-worker trigger) are compiled in only when
the build runs with `MARKOTO_TEST_BUILD=1` (`nitro.ignore` in
`nuxt.config.ts`). The integration and flow test harnesses set it for their
own builds; the Dockerfile never does, and fails the image build if a test
route is found in `.output/` (`scripts/check-test-routes.ts`). Each route
also still refuses to run outside test mode (`TEST_MODE=1` on a
non-deployment, `shared/utils/security/testMode.ts`), as defence in depth.

The remaining `isTestModeEnabled()` branches in production code only relax
behaviour under that runtime gate (rate limits, the anonymous-gate
proof-of-work difficulty, http issuers / test host names for OIDC, SSO,
custom domains and the pages host, canned transcription, stricter error
registry checks, the sync server's kick log).

## E.4 Images and dependencies are pinned

- Every third-party image is pinned by digest (`tag@sha256:…` in the
  compose files, `FROM …@sha256:…` in the Dockerfiles); our own images are
  pinned by release tag and cosign-signed. `scripts/selfhost-check.sh`
  fails on an unpinned image. Dependabot (`docker` for the Dockerfiles,
  `docker-compose` for the compose files) moves tag and digest together.
- Every `bun install` in the Dockerfiles uses `--frozen-lockfile
  --ignore-scripts`: no dependency install script runs in an image build.
  The app's own `postinstall` (`nuxt prepare`) runs explicitly.
- The markitdown converter's Python tests run in CI inside the image they
  test (`markitdown-tests` job).
- Document passwords are capped at 1,024 characters before scrypt sees
  them (set and verify), so a huge "password" can't burn CPU.
- `/api/health/deep` (admins only) reports probe errors through the same
  text scrubber, so a driver error quoting a connection string doesn't
  show its credentials.

