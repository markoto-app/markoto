# markoto — Project Guide

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google) via `nuxt-auth-utils`, PostgreSQL (app data + Y.js state via `y-postgresql` + pgvector embeddings), external S3 for image uploads & pg backups, multi-lingual UI via `@nuxtjs/i18n`, AI writing assistance via Google Gemini with workspace knowledge-base retrieval, Stripe billing for tiered AI quotas. Single Linux VPS today, multi-instance-capable since Phase 3. Docker Compose + Ansible.

Login is **optional** — public docs work anonymously. Login is required to own, manage permissions, use workspaces, delete, or use AI.

License: **FSL-1.1-ALv2** (source-available, converts to Apache-2.0 after two years).

Pricing & monetisation strategy is internal and tracked outside this repo. AI agents do not need it for engineering work; reach for the implementation directly (`server/utils/billing.ts`, `users.plan`, `ai_usage_period`, `server/utils/stripeWebhook.ts`).

---

## Where to look (sub-AGENTS.md index)

This file holds project-wide context. Domain-specific detail lives next to the code:

| Path | Scope |
|---|---|
| `app/AGENTS.md` | Vue frontend conventions + mobile breakpoint + `useColorMode` hydration pattern |
| `app/composables/AGENTS.md` | Document composables (token, sync, document orchestrator) |
| `app/utils/AGENTS.md` | Preview rendering pipeline + markdown comments + editor commands |
| `app/components/collab/AGENTS.md` | Activity Log: Tier 1 diffs + Tier 2 restore |
| `app/components/document/AGENTS.md` | Document context fields + new-doc dialog |
| `server/AGENTS.md` | Auth & access control + Drizzle/middleware/repos conventions + sweepers |
| `server/api/AGENTS.md` | API route map |
| `server/utils/AGENTS.md` | Workspace knowledge base + history/diff/restore + Stripe webhook + audit log + sweep locks + idempotency |
| `server/utils/agentic/AGENTS.md` | AI agentic loop, tools, voice, dictation, per-tool + per-session caps |
| `sync-server/AGENTS.md` | Hocuspocus configuration + Valkey-backed per-doc state + sticky sessions |
| `shared/templates/AGENTS.md` | Template registry/renderer split |
| `tests/e2e/AGENTS.md` | Flow Docs system (Playwright tests = docs) |
| `infra/README.md` | Ansible layout, role conventions, deploy/rollback playbooks |
| `docs/RELEASE-PROCESS.md` | One-PR-one-release flow + GHA wiring |
| `docs/RUNBOOK.md` | Symptom-driven prod incident playbook |
| `docs/CHEATSHEET.md` | Command discovery (Make targets, common workflows) |
| `docs/DEPLOY-OVH.md` | First-time OVH VPS provisioning |
| `docs/SECURITY-HARDENING.md` | Tier-1 hardening rationale + verification |
| `docs/GITHUB-CONFIG.md` | Branch protection, secrets, environments |

---

## 1. Architecture

Browser (Nuxt 4 SSR + SPA with CodeMirror 6, Y.js, paged.js iframe) connects via HTTPS/WSS to Traefik, which routes to the Nuxt app container, the Hocuspocus sync container, and the headless Playwright renderer sidecar. App + sync + renderer all talk to PostgreSQL (managed) and Valkey (self-hosted). App talks to Hocuspocus over internal HTTP. Backup sidecar does daily `pg_dump → S3`. Markitdown (FastAPI) handles imports only.

**Key design principles**
- **Full-stack Nuxt.** One Bun process serves SSR + Nitro API + OAuth. No CDN.
- **OAuth optional.** Anonymous users can view/edit public docs; login gates ownership and AI.
- **Y.js state in Postgres** via `y-postgresql` (`yjs_documents` table). Append-only + periodic merge; one `pg_dump` covers everything.
- **S3 = image uploads, workspace knowledge originals (deleted post-processing), and pg backups.** SeaweedFS in dev; OVH Object Storage in prod.
- **Workspace knowledge base.** Files uploaded to a workspace → markitdown → chunked → embedded → pgvector HNSW + tsvector for hybrid search. See `server/utils/AGENTS.md`.
- **Hocuspocus as separate container.** Long-lived WS shouldn't share the Nitro event loop. Server↔sync over shared-secret HTTP. Per-doc attribution + diff state lives in Valkey so multiple sync instances can share a view; sticky sessions at Traefik pin a client to one container.
- **Server-rendered PDF + PNG via Playwright sidecar** (`renderer` service). Internal-only; called by `server/utils/renderClient.ts`. The browser-side paged.js path still drives live preview + the `Cmd/Ctrl+P` print fallback.
- **AI joins the doc as a real Y.js client** — edits broadcast live via CRDT, status via awareness. See `server/utils/agentic/AGENTS.md`.
- **Preview is paged, in an iframe.** `themeToCss(theme)` drives both live preview AND server-rendered PDF. See `app/utils/AGENTS.md`.
- **Stripe billing for AI quotas.** Per-user `users.plan` + `ai_usage_period` table; atomic interaction counter in `runLoop.ts`; Stripe webhook hardened with `processed_webhook_events` (idempotency) + `pending_stripe_events` (out-of-order stash). Workspaces can have `ai_enabled=true` to bill member AI usage to the workspace owner. See `server/utils/AGENTS.md`.
- **Markitdown isolated.** Python/FastAPI wrapper; Nuxt image stays lean (~615 MB vs ~1.1 GB for pandoc).
- **Single-VPS today, multi-instance-capable.** Sticky sessions + Valkey-backed sync state + advisory-locked sweepers + Stripe event dedup mean we can scale horizontally without code changes. We're not running multi-instance yet; 30-second downtime budget on deploy is the accepted trade.

---

## 2. Technology Stack

### Runtime

| Tool | Version | Purpose |
|---|---|---|
| Bun | 1.3.12 | JS/TS runtime + package manager |
| Nuxt | 4.4.2 | Full-stack Vue (SSR + API via Nitro) |

### Nuxt modules

| Module | Version | Purpose |
|---|---|---|
| `@nuxt/ui` | 4.6.1 | Reka UI + Tailwind v4 |
| `nuxt-auth-utils` | 0.5.29 | OAuth + sealed-cookie sessions |
| `@nuxtjs/i18n` | 10.2.1 | 6 languages, lazy-loaded |
| `@vueuse/nuxt` | 14.2.1 | VueUse auto-imports |
| `@pinia/nuxt` | 0.11.3 | State management (must precede Colada) |
| `@pinia/colada-nuxt` | 0.3.2 | `useQuery` / `useMutation` |
| `@vite-pwa/nuxt` | 0.10.6 | PWA/Workbox |
| `nuxt-codemirror` | 0.0.11 | CM6 Vue wrapper |

### Frontend

| Package | Version | Purpose |
|---|---|---|
| `yjs` | 13.6.30 | CRDT doc model |
| `y-codemirror.next` | 0.3.5 | CM6 ↔ Y.js with remote cursors |
| `@hocuspocus/provider` | 3.4.4 | WS provider |
| `@codemirror/lang-markdown` | 6.3.2 | Markdown + GFM |
| `@codemirror/language-data` | 6.5.1 | Code-fence highlighting |
| `markdown-it` + plugins | 14.1.0 | Core renderer (task-lists, emoji, footnote + custom pagebreak rule) |
| `@mdit/plugin-{attrs,mark,ins,sub,sup,dl,abbr,figure,img-size}` | 0.23–0.25 | Batch 1: typography & semantic markup |
| `@mdit/plugin-alert` + `@mdit/plugin-katex` + `katex` | 0.23–0.25 / 0.16 | Batch 2: alerts + math |
| `markdown-it-anchor` + `markdown-it-toc-done-right` | 9.2.0 / 4.2.0 | Batch 3: heading IDs + `[[toc]]` |
| `mermaid` (CDN ESM, lazy) | 11.x | Batch 3: diagrams; pinned in `shared/utils/mermaidCdn.ts` |
| `highlight.js` | 11.11.1 | Code highlighting (CDN stylesheet) |
| `dompurify` | 3.2.4 | XSS sanitization |
| `pagedjs` (CDN) | 0.4.3 | CSS Paged Media polyfill; pinned in `shared/utils/pagedjsCdn.ts` |
| `nanoid` | 5.1.5 | ID generation |
| `@google/genai` | ^1.50 | Gemini SDK |
| `@google-cloud/speech` | ^7.3 | Cloud Speech-to-Text SDK (API-key auth, NOT a service account) |
| `file-type` | ^22 | Magic-byte sniffer for knowledge-upload content-type validation |

### Sync server (`sync-server/`)

| Package | Version | Purpose |
|---|---|---|
| `@hocuspocus/server` | 3.4.4 | WS sync server |
| `y-postgresql` | 1.0.1 | Y.js persistence (⚠ `useIndex: false` — 1.0.1 has SQL bug) |
| `pg` | ^8.20 | Driver |
| `ioredis` | ^5 | Per-doc state in Valkey (separate from app's pool) |
| `jsonwebtoken` | 9.0.2 | JWT verification |

### Nuxt server

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.2 | Type-safe ORM (`node-postgres` adapter) |
| `drizzle-kit` | 0.31.10 | Migration generator |
| `pg` | ^8.20 | Driver |
| `@aws-sdk/client-s3` + presigner | 3.750.0 | Image uploads |
| `jsonwebtoken` | 9.0.2 | Hocuspocus token minting |
| `stripe` | ^17 | Subscription + webhook |
| `zod` | ^4 | Validates Gemini function-call args; `z.toJSONSchema` generates tool schemas |

### Renderer sidecar (`renderer/`)

Headless Playwright service used by `server/utils/renderClient.ts` for server-rendered PDF + per-page PNG. Internal-only; not exposed via Traefik.

### Infra (`infra/`)

| Tool | Purpose |
|---|---|
| Ansible (Galaxy) | Single-host provisioning + deploy + rollback |
| `geerlingguy.docker` 8.0.0 | Docker apt repo + engine |
| `geerlingguy.security` 3.0.0 | Unattended-upgrades + reboot windows |
| `devsec.hardening` 10.5.2 | CIS-aligned OS hardening (sysctl, file perms) |
| Hand-rolled roles | `ssh_hardening`, `base`, `markoto` (compose deploy), `backup_cron` |
| Apprise via Telegram | Cron / backup / health notifications (`/usr/local/bin/markoto-notify`) |

### CI/CD (`.github/workflows/`)

`ci.yml` — lint + typecheck + unit/dom/nuxt + repos + integration + actionlint + gitleaks + ansible-lint + yamllint. `release.yml` — PR-merge → tagged GHCR images + GH Release built from PR title + body. `deploy.yml` — Ansible-driven prod deploy + rollback dispatcher.

> Password hashing uses `nuxt-auth-utils` built-in scrypt `hashPassword`/`verifyPassword` — not argon2.

---

## 3. Data Model

| Data | Storage |
|---|---|
| Users (incl. `plan`, `plan_valid_until`, `stripe_*` cols), documents (theme JSONB, `workspace_id`), shares, workspaces (incl. `billing_owner_id`, `ai_enabled`), workspace_members, uploads, activity, audit, rate-limits, AI sessions, ai_usage_period, processed_webhook_events, pending_stripe_events | PostgreSQL (Drizzle) |
| Y.js document state | PostgreSQL (`yjs_documents` via `y-postgresql`) |
| Workspace knowledge (rows + markdown cache) | PostgreSQL (`workspace_knowledge`) |
| Knowledge chunks (content + 768-d vector + tsvector) | PostgreSQL (`workspace_knowledge_chunks`, pgvector HNSW + GIN) |
| Per-doc sync state (attribution map, diff baselines) | Valkey, 24h TTL (`sync-server/src/sync-state.ts`) |
| Image blobs | S3 at `docs/{docId}/{fileId}.ext` |
| Knowledge originals (transient — deleted after successful processing) | S3 at `workspaces/{wsId}/knowledge/{kId}.{ext}` |
| Postgres backups | S3 at `backups/postgres/{ISO8601}.sql.gz` |
| User sessions | Sealed cookies (`nuxt-auth-utils`), versioned via `SESSION_VERSION` |

Schema source-of-truth: `server/db/schema.ts`. Enums as `text('col', { enum: [...] })` not `pgEnum` — adding values is TS-only, no `ALTER TYPE` friction.

**Migrations:** `bun run db:generate` diffs against `drizzle/meta/` snapshots. `server/plugins/00-db-migrate.ts` applies at boot. `NUXT_S3_ENDPOINT` swaps S3 backends with no code changes.

**Postgres:** OVH managed Postgres in prod; `pgvector/pgvector:pg16` container in dev/local/test (data-dir compatible drop-in). Migration `0005_lame_cassandra_nova.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` before the knowledge tables — drizzle doesn't emit CREATE EXTENSION, so it's hand-prepended in the generated file.

**Audit log** (Phase 2): `audit_log` table records WHO changed access controls, deleted content, or performed billing-relevant operations. Distinct from the user-facing `activity_log` (which feeds the in-doc Activity Log UI). See `server/repos/audit.ts` + `server/utils/AGENTS.md`.

**Stripe webhook tables** (Phase 8): `processed_webhook_events` (event-id dedup) + `pending_stripe_events` (out-of-order stash for `customer.subscription.created` arriving before `checkout.session.completed`). See `server/utils/stripeWebhook.ts` + `server/utils/webhookEventSweep.ts`.

**AI usage** (`ai_usage_period`): per-user, atomic interaction counter, billing-cycle-anchored reset. Threaded through `runLoop.ts`. NOT in Valkey — billing is correctness-critical.

**Document context columns** (added in `0001_silky_eternals.sql`): `description`, `audience`, `language`, `template_id` — all NOT NULL with sensible defaults. See `app/components/document/AGENTS.md`.

---

## 4. Security

**Authentication:** OAuth via `nuxt-auth-utils` (HTTP-only cookies, CSRF-protected). `SESSION_VERSION` invalidation. Hocuspocus always requires valid JWT with doc-scoped claims (Phase 1). `JWT_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET`, `STRIPE_*` fail-fast on missing.

**Tier-1 hardening (Phase 9):** Postgres TLS via `PGSSL*` env vars + `resolvePostgresSsl()` (fail-loud at boot if cert path unreadable); Valkey password + optional TLS; security headers + CSP via Traefik labels in `docker-compose.prod.yml`; secrets-rotation playbook in `docs/SECRETS-ROTATION.md`; storage-at-rest encryption assumed at the OVH platform layer. See `docs/SECURITY-HARDENING.md`.

**Rate limits:**

| What | Limit |
|---|---|
| Password brute-force | 5 per IP+docId/min |
| Token endpoint | 30 per IP/min |
| Import | 10 per IP/min |
| AI prompt | 20 per user/hour |
| AI transcribe | 60 per user/hour |
| Live dictation | 1 session/user (Valkey `SET NX`), 30 min/user/day audio, 10 min/session, 30s idle |
| Hocuspocus | 20 connections/IP, 5000 rooms |
| Knowledge upload | 30 presign-requests/user/min |
| Knowledge — per workspace | 500 files, 1 GB total, 25 MB per file |
| Knowledge — per user | 100 files, 2 GB total (across all workspaces) |
| Knowledge — per file processing | 300-chunk ceiling (sentinel-truncated) |
| AI agentic loop | per-tool call-count caps + per-session interaction cap (50) |
| Workspaces per user | 20 owned (invited workspaces don't count) |

**Rate-limit fail mode:** Valkey-backed limits fail OPEN on Valkey errors (DoS protection, not correctness). Single-session locks (live dictation, knowledge confirm) fail CLOSED (correctness; failing open would double-bill or duplicate state).

**Input validation:** `meta.put` validates title (≤255), accessMode (enum), wordCount (0–10M), sizeBytes (0–100M), theme (structural + numeric ranges + hex-color regex + font allowlist). Image uploads: PNG/JPEG/GIF/WebP/SVG, 10MB, magic-byte sniff at confirm. Imports: extension whitelist, 50MB. Knowledge uploads: extension allowlist + magic-byte sniff at confirm.

**File access:** `/api/files/:docId/:fileId` checks access mode before presigning. Presigned URL TTL: 5min upload, 120s read (can't be revoked; short to survive access-mode/password/deletion changes). **Knowledge originals are never served back** — deleted from S3 after successful processing; only `markdown_cache` + embedded chunks remain.

**S3 bucket policy (prod deployment requirement):** the production S3 bucket MUST deny public `ListBucket`. Our code never issues a presigned GET for knowledge keys, but if the bucket is list-enabled an attacker who guesses one `workspaces/{wsId}/knowledge/` prefix could enumerate by key. OVH defaults buckets to private; verify with `aws s3api get-bucket-acl --bucket $BUCKET` post-deploy.

**Mid-session membership drift:** see `server/utils/AGENTS.md` (knowledge tools re-check role per invocation). Documents themselves rely on the Hocuspocus JWT expiring for revocation — accepted tradeoff (≤2 h).

**Stripe webhook security:** signature-verified per request; event IDs deduplicated via `processed_webhook_events`; out-of-order events stashed and re-applied. See `server/utils/stripeWebhook.ts`.

**Other:** scrypt password hashing, 2h password token expiry, `html: false` + DOMPurify for XSS, gitleaks history scan in CI.

---

## 5. Docker Compose

| File | Scope | TLS | Use |
|---|---|---|---|
| `docker-compose.base.yml` | Shared service shape (postgres, valkey, sync, markitdown, renderer, backup) — pulled in by dev/local/prod via `include:` | — | Not run directly |
| `docker-compose.dev.yml` | Infra only (base + seaweedfs; ports published to host, valkey password fallback) — Nuxt on host | — | Daily dev with HMR |
| `docker-compose.local.yml` | Full stack — base + Traefik + `app` + seaweedfs on the `internal` network | mkcert on `markoto.127.0.0.1.nip.io` | Pre-push full-stack verification |
| `docker-compose.prod.yml` | Full stack — base + Traefik + ACME + security headers + GHCR images + sticky sessions for sync | Let's Encrypt | VPS deploy |
| `docker-compose.test.yml` | Standalone test infra (+ `--profile flows` for the e2e stack). Does NOT include base — uses `-test`-suffixed services with tmpfs storage | — | `bun run test:integration` / `bun run flows:test` |

Dev/local/prod use Compose's `include:` directive (Compose v2.20+, July 2023) to pull in `docker-compose.base.yml`. Each env file then overrides only what's truly env-specific: image vs build, ports vs expose, mem_limit, security headers labels, env-key passthrough. **User commands stay one-flag** — `docker compose -f docker-compose.dev.yml up -d` works as before; the include is transparent. Verified by running `docker compose -f X config` before/after the refactor and getting byte-identical output for all four envs.

**Compose merge gotchas baked into the split:**
- `environment:` map-merges per key — base provides the shared keys, overrides add per-env ones.
- `command:`, `volumes:`, `depends_on:`, `networks:` are REPLACED wholesale on merge, not concatenated. `command:` for valkey is redefined in dev to swap `${VALKEY_PASSWORD:?required}` for `${VALKEY_PASSWORD:-devpassword}`.
- `seaweedfs` is defined inline in dev/local (NOT in base) because `include:` has no "drop service" mechanic — putting it in base would leak a phantom seaweedfs + seaweed_data volume into prod, which uses external S3.
- `ports:` and `expose:` are different keys and don't replace each other; the merged result can list both. Harmless.

Dev: `bun run dev --host 0.0.0.0` (0.0.0.0 so sync container can reach via `host.docker.internal`). Ports: Postgres 5432, Valkey 6379, SeaweedFS 8333, Hocuspocus 4001, markitdown 8080, renderer 8090. **Postgres image** is `pgvector/pgvector:pg16` everywhere (prod uses OVH managed Postgres; the image is dev/local/test only).

Prod key points: postgres healthcheck gates `app` + `sync` startup; `stop_grace_period: 30s`; Traefik healthcheck labels on `/api/health` + `/health`; sticky sessions on the `sync` service via `traefik.http.services.sync.loadbalancer.sticky.cookie=true`; backup sidecar pipes `pg_dump | gzip | aws s3 cp`; Dockerfile **must `COPY drizzle/`** into runtime image.

Required env (canonical names — see `.env.example`): `DOMAIN`, `ACME_EMAIL`, `REGISTRY`, `IMAGE_TAG`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `NUXT_SESSION_PASSWORD` (≥32), `NUXT_JWT_SECRET` (≥32), `NUXT_INTERNAL_API_SECRET` (≥32), `NUXT_S3_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET}`, `NUXT_MARKITDOWN_URL`, `NUXT_SYNC_INTERNAL_URL`, `NUXT_PUBLIC_SYNC_URL`, `NUXT_GOOGLE_GEMINI_API_KEY`, `NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY`, `NUXT_STRIPE_SECRET_KEY`, `NUXT_STRIPE_WEBHOOK_SECRET`, `BACKUP_INTERVAL_SECONDS`, `BACKUP_RETENTION_COUNT`. Optional pair: `NUXT_OAUTH_GITHUB_CLIENT_*` and/or `NUXT_OAUTH_GOOGLE_CLIENT_*`. Optional Sentry: `NUXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`. Optional Postgres TLS: `PGSSLMODE`, `PGSSLROOTCERT`. Optional AI tuning: `NUXT_GOOGLE_{MODEL,IMAGE_MODEL,IMAGE_RESOLUTION,EMBEDDING_MODEL,EMBEDDING_DIMS,SPEECH_MODEL,THINKING_BUDGET,DICTATE_JWT_SECRET}` (the last falls back to `NUXT_JWT_SECRET`). Compose substitutions use `${VAR:?required}`. Testing: `NUXT_GOOGLE_SPEECH_MOCK=1` (requires `TEST_MODE=1`) swaps the Cloud STT client for a canned fake; `TEST_MODE=1` also bypasses the boot-time secret validator entirely.

---

## 6. Project Structure

`app/` — Vue frontend. See `app/AGENTS.md` for details. Top-level dirs: `components/{auth,editor,preview,collab,ai,sharing,document,workspace,comments,common,content}/`, `composables/`, `pages/` (index, `d/[id]`, `w/[id]`, `pricing`), `utils/`, `layouts/`, `plugins/`.

`server/` — Nitro API + sync notification layer. See `server/AGENTS.md`. Top-level dirs: `routes/`, `api/`, `db/`, `middleware/`, `plugins/`, `repos/` (incl. `audit.ts`), `utils/` (incl. `audit.ts` is in repos; `stripeWebhook.ts`, `webhookEventSweep.ts`, `sweepLock.ts`, `idempotency.ts`, `healthProbes.ts`, `traceHeaders.ts`, `renderClient.ts`, `billing.ts`, `planLapseSweep.ts` in utils).

`sync-server/src/` — Hocuspocus standalone container. Per-doc state in Valkey via `sync-state.ts` + `valkey.ts`. See `sync-server/AGENTS.md`.

`renderer/` — Playwright PDF + PNG sidecar. Internal-only.

`shared/` — Cross-cutting types + utilities used by both client and server. `types/` (theme, auth, pagedjs), `utils/` (themeToCss, themeValidation, themePresets, themeFonts, defaultTheme, postgresSsl, CDN version pins), `audiences/` (6-audience enum + tone fragments), `languages/` (presets + Intl.DisplayNames helper), `templates/` (registry; see `shared/templates/AGENTS.md`).

`infra/` — Ansible. `playbooks/` (provision, deploy, rollback, backup-test), `roles/` (base, ssh_hardening, markoto, backup_cron), `group_vars/`, `templates/`, `requirements.yml` (Galaxy), `Makefile` (common targets), `README.md`. See `docs/DEPLOY-OVH.md` + `docs/RUNBOOK.md`.

`.github/workflows/` — `ci.yml`, `release.yml`, `deploy.yml`. PR-title-as-release-name flow; one PR = one release. See `docs/RELEASE-PROCESS.md` + `docs/GITHUB-CONFIG.md`.

`drizzle/` — generated migrations + meta snapshots (committed). `i18n/locales/` — en/de/fr/es/ja/zh JSON.

`docs/` — `DEPLOY.md`, `DEPLOY-OVH.md`, `LOCAL.md`, `S3-SETUP.md`, `OBSERVABILITY.md`, `SECRETS-ROTATION.md`, `SECURITY-HARDENING.md`, `RELEASE-PROCESS.md`, `RUNBOOK.md`, `GITHUB-CONFIG.md`, `CHEATSHEET.md`.

`scripts/` — standalone Bun scripts. `audit-markdown-pipeline.mjs` runs the full markdown-it + plugins + DOMPurify chain. `flows-ephemeral.ts` orchestrates the flow-test ephemeral stack. `build-flows.ts` publishes Playwright flow output to `public/flows/`.

`tests/` — `unit/` (pure functions, no Nuxt), `dom/` (happy-dom), `nuxt/` (composables + components in Nuxt env), `repos/` (DB-backed), `integration/` (REST + sync, opt-in), `e2e/` (Playwright flow tests; see `tests/e2e/AGENTS.md`).

`content/docs/` + `app/layouts/docs.vue` + `app/pages/docs/` + `app/components/content/{Flow,FlowFrame}.vue` — the docs site that consumes the flows. See `tests/e2e/AGENTS.md`.

---

## 7. Shipped Features (manifest)

For per-feature deep-dive, follow the sub-AGENTS.md links. List form, not essays.

- **Infrastructure & ops:** Compose stack (`include:`-based), Drizzle + versioned migrations at boot, y-postgresql persistence, S3 singleton, Markitdown service, Playwright renderer sidecar, daily pg backup sidecar, Sentry observability, throttled-Sentry wrapper, Valkey rate limiting + session locks, dual-secret rotation, inactive doc sweep, PWA. Ansible-driven prod deploy + rollback (Phase 10–11). CI/CD release pipeline + Apprise/Telegram notifications + OS update automation (Phase 12). actionlint + gitleaks + ansible-lint + yamllint CI gates (Phase 13). Make targets + `docs/CHEATSHEET.md` (Phase 14).
- **Auth & editor:** GitHub + Google OAuth, `SESSION_VERSION` invalidation, anonymous doc creation, CodeMirror 6 + yCollab, split editor/preview, formatting toolbar + status bar, welcome doc, i18n (en complete; others scaffolded). Cookie hardening (Phase 6). See `server/AGENTS.md`.
- **Collaboration:** Awareness (names/colors/avatars), PresenceBar (deduped multi-tab), Y.js title sync, share modal with access-mode selector, scrypt password protection (3-layer), comments panel + `@ai` mention trigger, **Activity Log Tier 1 + 2** (see `app/components/collab/AGENTS.md`).
- **Multi-instance hardening (Phase 3–4):** Valkey-backed per-doc sync state (attribution + diff baselines), sticky sessions at Traefik for sync, advisory-locked sweepers (`sweepLock.ts`), idempotency keys (`idempotency.ts`), partial unique index on `activity_log(doc_id, yjs_doc_id_after) WHERE action IN ('edit', 'title.changed', 'theme.changed')` for cross-instance dedup, frontend version-skew detection (Phase 5–6).
- **Files & import/export:** Presigned upload flow + DB tracking, drag-drop + paste upload, markitdown import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), client-side `.md` download, server-rendered PDF via the Playwright sidecar (with browser-side paged.js + `window.print()` as a fallback path).
- **Preview & PDF:** paged.js pivot (A4/Letter pages, header/footer, footnotes via `float: footnote`), single `themeToCss()` for preview + print, iframe isolation, responsive page zoom, `Cmd/Ctrl+P` hijack, dark mode chrome. See `app/utils/AGENTS.md`.
- **Theme system:** Per-doc JSONB + `ymeta.theme` live broadcast, server validation, `ThemeEditorPanel.vue` (11 sections), 6 built-in presets (incl. markoto), 20-font Google Fonts picker, TOC controls, mermaid theme picker, header/footer token chips, cover-page redesign, user-saved theme presets + workspace default theme.
- **Markdown extensions:** Batch 1 (typography), Batch 2 (katex + alerts), Batch 3 (anchor + TOC + Mermaid), pagebreak + comments. See `app/utils/AGENTS.md`.
- **Editor chrome:** Google-Docs-style menu bar, table size picker, diagram/alert/math dropdowns, right sidebar (Activity / Theme / Document / Knowledge), view-mode toggle, `DeleteConfirmModal`. Mobile-first redesign — bottom sheets, format bar, view-mode bar, voice + comment popups (Phase 14 mobile sprint).
- **Workspaces:** Three-role model, invite-by-email, last-admin invariant, cascade delete, role-gated UI at `/w/:id`. See `server/AGENTS.md`.
- **Document context + new-doc dialog + templates:** description / audience / language / templateId fields injected into every AI prompt; multi-language template skeletons. See `app/components/document/AGENTS.md` and `shared/templates/AGENTS.md`.
- **Document duplication:** `POST /api/docs/:id/duplicate` clones row + Y.js state with URL rewrite + S3 assets. See `server/utils/duplicateDocument.ts`.
- **Workspace knowledge base:** PDF/DOCX/PPTX/XLSX/HTML/EPUB/MD/TXT upload → markitdown → chunked → embedded → pgvector + tsvector hybrid search. See `server/utils/AGENTS.md`.
- **AI:** 16 tools (always-on + workspace-gated knowledge tools + cross-doc tools + theme-inspection/preset tools), `@ai` comment trigger, voice input, live dictation. **Per-tool call-count caps + per-session interaction cap (50)** in `runLoop.ts` (Phase 2 — protects against cost-amplifying outliers). See `server/utils/agentic/AGENTS.md`.
- **Billing (Stripe):** `users.plan` + `plan_valid_until` + `stripe_*` cols; `workspaces.billing_owner_id` + `ai_enabled`; `ai_usage_period` table; webhook signature verification + event-id dedup (`processed_webhook_events`) + out-of-order event stash (`pending_stripe_events`); plan-lapse sweep job. See `server/utils/AGENTS.md`.
- **Audit log (Phase 2):** `audit_log` table records security-relevant + billing-relevant operations. Distinct from user-facing `activity_log`. See `server/repos/audit.ts`.
- **Mobile:** Touch-optimized CM6, flex-wrap toolbar, hamburger menu, 640px breakpoint, mobile bottom sheets + format bar (Phase 14). See `app/AGENTS.md`.
- **Flow docs system:** Playwright tests = documentation. See `tests/e2e/AGENTS.md`.

---

## 8. TODOs

### MMP

**History & snapshots**
- [ ] Timestamped snapshots in S3 via Hocuspocus hook (separate from y-postgresql append-log; would let us garbage-collect row history while keeping daily-granularity restore points).
- [ ] Timeline scrubber UI — currently restore is per-activity-row.
- [ ] Export at a point in time (PDF/markdown of a past state).

**Markdown extensions**
- [ ] Batch 4: `markdown-it-criticmarkup`, `markdown-it-multimd-table`, client-side BibTeX citations.

**Power features**
- [ ] Markdown frontmatter, command palette, TOC sidebar, folding, highlighting, QR code sharing, keyboard cheat sheet, Y.js compaction, remaining locale translations, markdown export with base64-inlined images.

**Mobile MMP**
- [ ] Floating toolbar above virtual keyboard via `visualViewport`, bottom tab bar (Edit/Preview/AI), sidebar as bottom sheet.

**AI**
- [ ] Semantic search across docs via embeddings — "find the section about X", "suggest related docs".
- [ ] Safari support for voice input / dictation — Safari's `MediaRecorder` only emits `audio/mp4` (AAC) which Cloud STT sync doesn't accept.

**Flow docs system** (see `tests/e2e/AGENTS.md`)
- [x] Tier 1 flows: `polished-pdf`, `import-existing`, `rich-content`, `password-protect` — shipped with hero strips, direction-anchoring annotations, and curated "Try next" forward links.
- [ ] Two-context fixture for password-protect flow (currently uses single-context cookie-clear simulation; honest narrative but not a true second context).
- [ ] Selective re-runs: `flows:test:changed`.
- [ ] CI integration.
- [ ] Doc-content i18n pattern.
- [ ] `/docs/_internal/flows` gallery.
- [ ] Mobile flow project (375×667 + dedicated `MobileEditorPage`).

**Operational**
- [ ] CORS: Traefik middleware for S3 (only if/when we move static asset serving off S3 origins).
- [ ] HA — currently single-instance with 30s deploy downtime budget. The codebase is multi-instance-capable since Phase 3 but we don't run two app/sync nodes.

**AI (explicitly out of scope):** multi-turn conversation history, streaming text, "AI for Alice" attribution, user-selectable model, grounded-search caching, cost telemetry, provider-swap adapter. Generic image search (Bing deprecated, Google CSE expensive, DDG ToS); covered indirectly by `fetch_url`. Pexels/Unsplash stock-photo search — `generate_image` covers it.

---

## 9. Project-wide Decisions

| Decision | Rationale |
|---|---|
| Full-stack Nuxt over SPA + Fastify | One Bun process for SSR + API + auth |
| `nuxt-auth-utils` over `@sidebase/nuxt-auth` | Lighter; sealed-cookie sessions; built-in scrypt |
| Drizzle + Postgres | Versioned migrations, concurrent writers, `pg_dump` backup path |
| Single `pg` driver stack-wide | `y-postgresql` requires `pg.PoolConfig`; mixing = two pools |
| `y-postgresql` (was S3 blob overwrite) | Append+merge is durable; failed write can't nuke state |
| Text-enum columns, not `pgEnum` | Adding values is TS-only — no `ALTER TYPE` friction |
| `nitro.preset: 'bun'` | lib0 and other packages use Bun-specific conditional exports; `node-server` preset traces wrong condition |
| Hocuspocus as separate container | Long-lived WS + in-memory Y.Doc state shouldn't share Nitro event loop |
| Sticky sessions at Traefik for sync (not cross-instance Y.Doc replication) | Y.Doc replication across containers is a real research project; sticky sessions on the WS path + Valkey-backed per-doc attribution covers our scaling needs at zero engineering cost |
| Sync-server per-doc state in Valkey, not in-process Maps | Lets multiple sync-server instances share attribution + diff baselines. Sticky sessions pin a client to one container; residual cross-container race on `prev-text` produces at most one duplicate activity row per concurrency event (documented in `sync-server/AGENTS.md`). 24h TTL caps memory growth |
| Audit log as separate table from `activity_log` | `activity_log` is a user-facing feed (presence + edits + restores) with privacy implications. `audit_log` records security-relevant + billing-relevant operations for ops/forensics. Mixing them would force every audit query through user-permission filters |
| Stripe `event.id` dedup + `pending_stripe_events` stash | Stripe delivers webhooks at-least-once and out of order. `processed_webhook_events` covers redelivery (idempotency). `pending_stripe_events` covers `customer.subscription.*` arriving before `checkout.session.completed` (when `users.stripe_customer_id` is still null) — the stash is replayed by `webhookEventSweep.ts` once the customer record materialises |
| Partial unique index `(doc_id, yjs_doc_id_after) WHERE action IN (...)` | Cross-instance dedup for activity rows without forcing a full-table unique constraint that would reject legitimate `restore` / `comment.*` rows |
| Postgres advisory locks for sweepers | `pg_try_advisory_lock` (session-pinned PoolClient) ensures only one app instance runs each sweeper. The `pg_try_advisory_xact_lock` variant auto-releases on COMMIT and is wrong for long-running sweep work |
| Per-tool call-count caps + per-session interaction cap (50) | Phase 2 — protects users + us from cost-amplifying outliers (a model that loops calling `view_image` would burn through quota). Caps abort with a user-visible message |
| `SESSION_VERSION` invalidation | Simpler than backwards-compat shims pre-launch |
| paged.js in srcdoc iframe | paged.js mutates global state; host-page approach caused unrecoverable layout jitter |
| Single `themeToCss()` for preview AND print | One function, two consumers — genuine WYSIWYG |
| Server-rendered PDF via Playwright sidecar (over pure browser-side) | Browser-side `window.print()` had layout drift on iOS Safari + AI-driven view-pages tool needs server-side bytes. Sidecar isolates Chromium dependency from the Nuxt image |
| Drop DOCX/HTML export | Maintenance burden; markdown + PDF covers all real needs |
| Markitdown over pandoc | 1.1 GB → 615 MB image; import-only use case doesn't need pandoc's output formats |
| CDN for paged.js / hljs / KaTeX / Mermaid | Vite can't inject into srcdoc iframes; versioned CDN URL = automatic cache-bust |
| `pgvector/pgvector:pg16` over stock `postgres:16-alpine` (dev/local/test) | Data-dir-compatible drop-in; avoids "install pgvector at runtime" ceremony. Prod uses OVH managed Postgres with the extension preinstalled |
| Gemini over Claude | Materially cheaper; display name vendor-neutral ("AI Assistant") |
| Cloud Speech-to-Text over Gemini Live / inline audio | Gemini Live is conversational duplex (server-side VAD buffers until end-of-turn — wrong for dictation). Inline audio costs ~4× per minute. Cloud STT is purpose-built for streaming STT |
| Cloud STT v1 (not v2) | v2 streamingRecognize requires project id in recognizer path; v1 keeps the server code to a single SDK call. `latest_long` in v1 is plenty for dictation |
| Split Google API keys (Gemini + Cloud STT) | Two separately-restricted keys in GCP so a leak of one doesn't pivot to the other. Separate billing lines |
| Separate `dictateJwtSecret` | Rotate independently of the Hocuspocus secret. Falls back to `jwtSecret` for dev |
| Zod as AI-tool source-of-truth | `z.toJSONSchema` generates Gemini schema + runtime validator; malformed args self-correct |
| Implicit Gemini prefix cache, no explicit `ai.caches.create` | Automatic prefix cache handles within-loop + cross-user system-prompt sharing for free; explicit caching has minimum-size + TTL-refresh overhead that doesn't pay off on our traffic |
| Flow tests double as docs | A separate "tour the editor" docs system + e2e suite would drift apart. Sharing the same artefact forces both honest |
| Single shared test compose with profiles | A separate `docker-compose.flows.yml` hit the `--remove-orphans` footgun (compose project namespace shared with dev infra). One compose file under `--profile flows` |
| Compose `include:` over `-f base.yml -f override.yml` | Preserves single-file user invocation. Two-file form would force every team-member muscle-memory rewrite + every doc + every script |
| `seaweedfs` defined per-env (not in base) | Compose's `include:` always merges every service from the included file — there's no "drop service" mechanic. Putting seaweedfs in base would leak a phantom service + volume into prod (which uses external S3) |
| **License: FSL-1.1-ALv2 (not MIT)** | Source-available with non-compete; converts to Apache-2.0 after two years. Lets us open the source without inviting hyperscaler clones day one |
| **Ansible (not Terraform / Pulumi / k8s)** | Single-VPS target. Terraform is a cloud-resource state machine — wrong tool for "configure this Linux box". Pulumi has the same shape. k8s is wildly oversized for two long-running containers + a sidecar. Ansible is idempotent shell, which is exactly the abstraction that fits |
| **OVH managed Postgres + Object Storage; Valkey self-hosted** | Postgres is the highest-stakes component (Y.js durability, billing data); offload backups/replication/upgrade to a managed provider. Valkey is small, ephemeral, and trivially restartable — self-host saves the per-month line item |
| **Apprise via Telegram (not email) for ops notifications** | Telegram bot pushes to a phone in <1s; email goes to a folder we don't check. Apprise wraps the transport so swapping later is one env-var change |
| **PR-title-as-release-name (not release-drafter aggregation)** | release-drafter buckets every PR into category sections that bury what authors actually wrote. One PR = one release = one human-written description. Forces PR descriptions to be load-bearing |
| **geerlingguy.docker + devsec.hardening as Galaxy roles; ssh_hardening / base / markoto / backup_cron hand-rolled** | Galaxy roles for the well-trodden, OS-version-fragile bits (apt repo handling, CIS sysctl). Hand-roll the markoto-specific bits where a generic role would have us fighting variable schemas |
| **actionlint + gitleaks + ansible-lint + yamllint as CI gates** | actionlint catches workflow-expression-injection at PR time (Phase 13). gitleaks scans full history (`fetch-depth: 0`). ansible-lint + yamllint keep the infra dir from drifting into "works on my laptop". Each is a one-off install — no Maven-style toolchain to maintain |

For feature-specific decisions (restore reversibility, AI tool design, knowledge pipeline, Stripe webhook flow, etc.) see the sub-AGENTS.md for that area.

---

## 10. Project-wide Gotchas

For feature-specific gotchas see the sub-AGENTS.md for that area.

- **`server/auth/` is not a Nitro route dir.** OAuth handlers live in `server/routes/auth/`.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **`nitro.preset` must match runtime** — default `node-server` breaks packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **Drizzle `node-postgres`** — Promise-returning, no `.get()`/`.all()`. Use `(await db.select()...limit(1))[0]`.
- **Drizzle doesn't emit `CREATE EXTENSION`** — for `vector(...)` columns, hand-prepend `CREATE EXTENSION IF NOT EXISTS vector;` + `statement-breakpoint` to the generated SQL.
- **Drizzle 0.45.2 `onConflictDoNothing` partial-index predicate is named `where`** (not `targetWhere`). For inferring a partial unique index, pass `{ target: [...], where: sql\`...\` }`.
- **Migrations that TRUNCATE optional tables need `IF EXISTS` guards.** `yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle.
- **`resolvePostgresSsl()` throws on unreadable `PGSSLROOTCERT` path** — fail-loud at boot is the intended behaviour. Misreading the cert silently would degrade to `sslmode=require` which doesn't pin the CA.
- **Compose `include:` has no "drop service" mechanic** — a service defined in base shows up in every consumer. This drove the seaweedfs-per-env decision; remember if adding a service that should only exist in some envs.
- **Compose `command:` is REPLACED on merge, not appended** — base's valkey `command:` is fully redefined in dev to swap the password var. Forgetting this leaks `${VALKEY_PASSWORD:?required}` into dev where it's unset.
- **`geerlingguy.security` is `3.0.0`, not `3.1.0`** — 3.1.0 doesn't exist on Galaxy. `requirements.yml` is pinned exact for this reason; bumping needs a Galaxy version check first.
- **`rhysd/actionlint` does NOT exist as a composite-action on the Marketplace** — the canonical pattern is the install-script `bash <(curl -sSL .../download-actionlint.bash) <version>`. Trying to use `rhysd/actionlint@v1` returns a 404 on `actions/checkout` resolution.
- **Sweeper advisory locks need session-pinned `PoolClient`** — `pg_try_advisory_lock(...)` releases when its session ends, NOT on transaction commit. Use a checked-out client for the lifetime of the sweep, not a pool-borrowed query. The `_xact_lock` variant releases on commit and is wrong for sweepers that run multiple statements.
- **The `pending_stripe_events` stash needs its own sweeper config** — in addition to the in-flight pruning, `webhookEventSweep.ts` must also drain the stash periodically; otherwise an event that arrived too early sits forever if the matching `checkout.session.completed` was lost.
- **Never ship `passwordHash`** — always project explicitly on public endpoints.
- **Never issue usable JWT for forbidden/password-gated docs** — `token: null` prevents Hocuspocus connection.
- **Presigned read URL TTL: 120s** — can't be revoked; long TTLs outlive access-mode/password changes.
- **`y-postgresql` 1.0.1** — force `useIndex: false` (SQL bug in index-creation branch).
- **Workspace authz: one helper per concern.** `canEditDoc` (content), `canManageDoc` (sharing/delete), `canManageWorkspace` (admin actions). Mixing leaks permissions.
- **`workspaces.ownerId` vs `workspace_members.role='admin'` vs `workspaces.billing_owner_id`** — `ownerId` is provenance only, never used for authz. Authz goes through `role`. Billing attribution goes through `billing_owner_id` (which auto-disables `ai_enabled` if the billing owner's plan lapses).
- **Removing a workspace member doesn't revoke active JWTs** — valid until next token refresh (up to 2h). Acceptable for now.
- **`useColorMode()` at template top level causes hydration mismatch** — defer to `onMounted` with a neutral default ref, wrap in `<ClientOnly>`, or render both variants and CSS-toggle. See `app/AGENTS.md` for the Wordmark pattern.
- **PR description quality directly equals release notes quality** — `release.yml` builds the GH Release body from the PR title + body verbatim. A single-line "fix typo" PR title produces a single-line release. Worth the small social pressure to write proper PR descriptions.
- **`vi.mock` paths resolve relative to the TEST FILE, not the source file.** Use `vi.mock('../../server/utils/database', ...)` from a test in `tests/unit/`. Symptom is opaque: tests "passing" but with phantom assertions because the mock never engaged.
- **`bun run test:coverage` undercounts.** `@vitest/coverage-v8` only measures code that runs in the vitest process; integration tests spawn a separate `bun run dev` subprocess via `tests/integration/setup/server.ts`, so every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*` runs there — invisible to coverage. Three dead ends so we don't try again: (1) Bun doesn't honor `NODE_V8_COVERAGE` (oven-sh/bun#17867). (2) Spawning with `node` + NODE_V8_COVERAGE produces files but Nitro's Vite SSR transform records URLs as `evalmachine.<anonymous>` which c8 can't map. (3) `@nuxt/test-utils/e2e` `setup()` would work but our `nitro.preset: 'bun'` build traces Bun-specific paths and Stripe's ESM entry doesn't resolve under Node's ESM resolver. **Net: the API-route coverage gap is architectural.** When reviewing coverage, mentally overlay: every `server/{api,middleware,plugins,routes}/*` plus orchestrators like `processKnowledge.ts` and `aiClient.ts` is covered by the 300+ integration tests but doesn't show up in the number.

---

## 11. Operational Posture

**Where it runs:** Single OVH VPS (Debian/Ubuntu LTS), provisioned + maintained via Ansible (`infra/`). Single-instance today; multi-instance-capable since Phase 3 but not currently scaled out.

**What's managed:** OVH managed Postgres (HA + automatic backups + pgvector preinstalled), OVH Object Storage (S3-compatible). What's self-hosted: everything else (Nuxt app, Hocuspocus sync, renderer sidecar, markitdown, Valkey, backup sidecar).

**Deploy flow:** Merge PR → `release.yml` builds + tags GHCR images + creates GH Release from PR title/body → `deploy.yml` (Ansible) pulls images on the VPS + runs `make deploy`. One PR = one release. See `docs/RELEASE-PROCESS.md`.

**Rollback:** `infra/playbooks/rollback.yml` flips the GHCR tag back. Database migrations are forward-only by convention; rollback is for code, not schema. See `docs/RUNBOOK.md`.

**Downtime budget:** ~30 seconds during deploy (compose stop → pull → start). HA is not engineered. Sticky sessions + Valkey state mean we *could* run blue/green, but the operational complexity isn't worth it at our traffic.

**Notifications:** Apprise via Telegram. Backup failures, OS update reboots, deploy success/failure all flow through `/usr/local/bin/markoto-notify`.

**Where to look first when something breaks:**
- `docs/RUNBOOK.md` — symptom-driven incident playbook.
- `docs/CHEATSHEET.md` — common Make targets + workflows.
- `docs/RELEASE-PROCESS.md` — deploy mechanics.
- `infra/README.md` — Ansible layout.
- Sentry — application errors. Throttled via `server/utils/throttledSentry.ts`.
- Apprise/Telegram channel — ops notifications.
