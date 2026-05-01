# Security Hardening

Cross-cutting hardening notes for the production stack. Two sections today:

- §A. HTTP headers + CSP — applied at the Traefik edge.
- §B. Valkey deployment posture — password enforcement, network exposure,
  optional TLS for managed-Redis providers.

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
| `api.stripe.com` + `js.stripe.com` + `hooks.stripe.com` | Pre-listed for the not-yet-shipped checkout flow (AGENTS.md §7). Safe to leave allow-listed before Stripe is wired up — the hosts simply aren't contacted. |
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
requires a password and is bound to the docker `internal` network only
in production. The threat we're closing: any process on the VPS host
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
| `docker-compose.prod.yml` | `expose: ["6379"]` (docker internal network only, no host port) | The app + sync containers reach Valkey over the `internal` docker bridge. Publishing 6379 would let any VPS-host process bypass docker network ACLs. |
| `docker-compose.local.yml` | `expose: ["6379"]` (same) | App runs IN a container; no host access needed. |
| `docker-compose.dev.yml` | `ports: ["6379:6379"]` | Nuxt runs on the host (`bun run dev`) and reaches Valkey via `localhost:6379`. Acceptable: dev infra holds nothing private. |
| `docker-compose.test.yml` | `ports: ["6380:6379"]` | vitest runs on the host and reaches Valkey via `localhost:6380`. tmpfs storage; nothing private. |

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
