# markoto — Project Guide

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google) via `nuxt-auth-utils`, PostgreSQL (app data + Y.js state via `y-postgresql` + pgvector embeddings), external S3 for image uploads & pg backups, multi-lingual UI via `@nuxtjs/i18n`, AI writing assistance via Google Gemini with workspace knowledge-base retrieval. Single Linux VPS, Docker Compose.

Login is **optional** — public docs work anonymously. Login is required to own, manage permissions, use workspaces, delete, or use AI.

---

## Where to look (sub-AGENTS.md index)

This file holds project-wide context. Domain-specific detail lives next to the code:

| Path | Scope |
|---|---|
| `app/AGENTS.md` | Vue frontend conventions + mobile breakpoint |
| `app/composables/AGENTS.md` | Document composables (token, sync, document orchestrator) |
| `app/utils/AGENTS.md` | Preview rendering pipeline + markdown comments + editor commands |
| `app/components/collab/AGENTS.md` | Activity Log: Tier 1 diffs + Tier 2 restore |
| `app/components/document/AGENTS.md` | Document context fields + new-doc dialog |
| `server/AGENTS.md` | Auth & access control + Drizzle/middleware/repos conventions |
| `server/api/AGENTS.md` | API route map |
| `server/utils/AGENTS.md` | Workspace knowledge base + history/diff/restore helpers |
| `server/utils/agentic/AGENTS.md` | AI agentic loop, tools, voice, dictation |
| `sync-server/AGENTS.md` | Hocuspocus configuration + hooks |
| `shared/templates/AGENTS.md` | Template registry/renderer split |
| `tests/e2e/AGENTS.md` | Flow Docs system (Playwright tests = docs) |

---

## 1. Architecture

Browser (Nuxt 4 SSR + SPA with CodeMirror 6, Y.js, paged.js iframe) connects via HTTPS/WSS to Traefik, which routes to the Nuxt app container and the Hocuspocus sync container. Both containers talk to PostgreSQL. App talks to Hocuspocus over internal HTTP. Backup sidecar does daily `pg_dump → S3`. Markitdown (FastAPI) handles imports only.

**Key design principles**
- **Full-stack Nuxt.** One Bun process serves SSR + Nitro API + OAuth. No CDN.
- **OAuth optional.** Anonymous users can view/edit public docs; login gates ownership and AI.
- **Y.js state in Postgres** via `y-postgresql` (`yjs_documents` table). Append-only + periodic merge; one `pg_dump` covers everything.
- **S3 = image uploads, workspace knowledge originals (deleted post-processing), and pg backups.** SeaweedFS in dev; external S3 in prod.
- **Workspace knowledge base.** Files uploaded to a workspace → markitdown → chunked → embedded → pgvector HNSW + tsvector for hybrid search. See `server/utils/AGENTS.md`.
- **Hocuspocus as separate container.** Long-lived WS shouldn't share the Nitro event loop. Server↔sync over shared-secret HTTP.
- **AI joins the doc as a real Y.js client** — edits broadcast live via CRDT, status via awareness. See `server/utils/agentic/AGENTS.md`.
- **Preview is paged, in an iframe.** `themeToCss(theme)` drives both live preview AND PDF print. No server Chromium. See `app/utils/AGENTS.md`.
- **Markitdown isolated.** Python/FastAPI wrapper; Nuxt image stays lean (~615 MB vs ~1.1 GB for pandoc).

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
| `jsonwebtoken` | 9.0.2 | JWT verification |

### Nuxt server

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.2 | Type-safe ORM (`node-postgres` adapter) |
| `drizzle-kit` | 0.31.10 | Migration generator |
| `pg` | ^8.20 | Driver |
| `@aws-sdk/client-s3` + presigner | 3.750.0 | Image uploads |
| `jsonwebtoken` | 9.0.2 | Hocuspocus token minting |
| `zod` | ^4 | Validates Gemini function-call args; `z.toJSONSchema` generates tool schemas |

> Password hashing uses `nuxt-auth-utils` built-in scrypt `hashPassword`/`verifyPassword` — not argon2.

---

## 3. Data Model

| Data | Storage |
|---|---|
| Users, documents (theme JSONB, `workspace_id`), shares, workspaces, workspace_members, uploads, activity, rate-limits, AI sessions | PostgreSQL (Drizzle) |
| Y.js document state | PostgreSQL (`yjs_documents` via `y-postgresql`) |
| Workspace knowledge (rows + markdown cache) | PostgreSQL (`workspace_knowledge`) |
| Knowledge chunks (content + 768-d vector + tsvector) | PostgreSQL (`workspace_knowledge_chunks`, pgvector HNSW + GIN) |
| Image blobs | S3 at `docs/{docId}/{fileId}.ext` |
| Knowledge originals (transient — deleted after successful processing) | S3 at `workspaces/{wsId}/knowledge/{kId}.{ext}` |
| Postgres backups | S3 at `backups/postgres/{ISO8601}.sql.gz` |
| User sessions | Sealed cookies (`nuxt-auth-utils`), versioned via `SESSION_VERSION` |

Schema source-of-truth: `server/db/schema.ts`. Enums as `text('col', { enum: [...] })` not `pgEnum` — adding values is TS-only, no `ALTER TYPE` friction.

**Migrations:** `bun run db:generate` diffs against `drizzle/meta/` snapshots. `server/plugins/00-db-migrate.ts` applies at boot. `NUXT_S3_ENDPOINT` swaps S3 backends with no code changes.

**Postgres image:** `pgvector/pgvector:pg16` (drop-in for `postgres:16-alpine`, data-dir compatible). Migration `0005_lame_cassandra_nova.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` before the knowledge tables — drizzle doesn't emit CREATE EXTENSION, so it's hand-prepended in the generated file.

**Document context columns** (added in `0001_silky_eternals.sql`): `description`, `audience`, `language`, `template_id` — all NOT NULL with sensible defaults. See `app/components/document/AGENTS.md`.

---

## 4. Security

**Authentication:** OAuth via `nuxt-auth-utils` (HTTP-only cookies, CSRF-protected). `SESSION_VERSION` invalidation. Hocuspocus always requires valid JWT. `JWT_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET` fail-fast on missing.

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
| Workspaces per user | 20 owned (invited workspaces don't count) |

**Input validation:** `meta.put` validates title (≤255), accessMode (enum), wordCount (0–10M), sizeBytes (0–100M), theme (structural + numeric ranges + hex-color regex + font allowlist). Image uploads: PNG/JPEG/GIF/WebP/SVG, 10MB. Imports: extension whitelist, 50MB. Knowledge uploads: extension allowlist + magic-byte sniff at confirm.

**File access:** `/api/files/:docId/:fileId` checks access mode before presigning. Presigned URL TTL: 5min upload, 120s read (can't be revoked; short to survive access-mode/password/deletion changes). **Knowledge originals are never served back** — deleted from S3 after successful processing; only `markdown_cache` + embedded chunks remain.

**S3 bucket policy (prod deployment requirement):** the production S3 bucket MUST deny public `ListBucket`. Our code never issues a presigned GET for knowledge keys, but if the bucket is list-enabled an attacker who guesses one `workspaces/{wsId}/knowledge/` prefix could enumerate by key. Infomaniak defaults buckets to private; verify with `aws s3api get-bucket-acl --bucket $BUCKET` post-deploy.

**Mid-session membership drift:** see `server/utils/AGENTS.md` (knowledge tools re-check role per invocation). Documents themselves rely on the Hocuspocus JWT expiring for revocation — accepted tradeoff (≤1 h).

**Other:** scrypt password hashing, 2h password token expiry, `html: false` + DOMPurify for XSS.

---

## 5. Docker Compose

| File | Scope | TLS | Use |
|---|---|---|---|
| `docker-compose.dev.yml` | Infra only (postgres, valkey, seaweedfs, sync, markitdown, backup) — Nuxt on host | — | Daily dev with HMR |
| `docker-compose.local.yml` | Full stack incl. Traefik | mkcert on `ypad.127.0.0.1.nip.io` | Pre-push full-stack verification |
| `docker-compose.prod.yml` | Full stack incl. Traefik | Let's Encrypt | VPS deploy |
| `docker-compose.test.yml` | Integration test infra (+ `--profile flows` for the e2e stack) | — | `bun run test:integration` / `bun run flows:test` |

Three standalone files — no shared base. Dev: `bun run dev --host 0.0.0.0` (0.0.0.0 so sync container can reach via `host.docker.internal`). Ports: Postgres 5432, Valkey 6379, SeaweedFS 8333, Hocuspocus 4001, markitdown 8080. **Postgres image** is `pgvector/pgvector:pg16` everywhere.

Prod key points: postgres healthcheck gates `app` + `sync` startup; `stop_grace_period: 30s`; Traefik healthcheck labels on `/api/health` + `/health`; backup sidecar pipes `pg_dump | gzip | aws s3 cp`; Dockerfile **must `COPY drizzle/`** into runtime image.

Required env (canonical names — see `.env.example`): `DOMAIN`, `ACME_EMAIL`, `REGISTRY`, `IMAGE_TAG`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `NUXT_SESSION_PASSWORD` (≥32), `NUXT_JWT_SECRET` (≥32), `NUXT_INTERNAL_API_SECRET` (≥32), `NUXT_S3_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET}`, `NUXT_MARKITDOWN_URL`, `NUXT_SYNC_INTERNAL_URL`, `NUXT_PUBLIC_SYNC_URL`, `NUXT_GOOGLE_GEMINI_API_KEY`, `NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY`, `BACKUP_INTERVAL_SECONDS`, `BACKUP_RETENTION_COUNT`. Optional pair: `NUXT_OAUTH_GITHUB_CLIENT_*` and/or `NUXT_OAUTH_GOOGLE_CLIENT_*`. Optional Sentry: `NUXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`. Optional AI tuning: `NUXT_GOOGLE_{MODEL,IMAGE_MODEL,IMAGE_RESOLUTION,EMBEDDING_MODEL,EMBEDDING_DIMS,SPEECH_MODEL,THINKING_BUDGET,DICTATE_JWT_SECRET}` (the last falls back to `NUXT_JWT_SECRET`). Compose substitutions use `${VAR:?required}`. Testing: `NUXT_GOOGLE_SPEECH_MOCK=1` (requires `TEST_MODE=1`) swaps the Cloud STT client for a canned fake; `TEST_MODE=1` also bypasses the boot-time secret validator entirely.

---

## 6. Project Structure

`app/` — Vue frontend. See `app/AGENTS.md` for details. Top-level dirs: `components/{auth,editor,preview,collab,ai,sharing,document,workspace,comments,common,content}/`, `composables/`, `pages/` (index, `d/[id]`, `w/[id]`), `utils/`, `layouts/`, `plugins/`.

`server/` — Nitro API + sync notification layer. See `server/AGENTS.md`. Top-level dirs: `routes/`, `api/`, `db/`, `middleware/`, `plugins/`, `repos/`, `utils/`.

`sync-server/src/` — Hocuspocus standalone container. See `sync-server/AGENTS.md`.

`shared/` — Cross-cutting types + utilities used by both client and server. `types/` (theme, auth, pagedjs), `utils/` (themeToCss, themeValidation, themePresets, themeFonts, defaultTheme, CDN version pins), `audiences/` (6-audience enum + tone fragments), `languages/` (presets + Intl.DisplayNames helper), `templates/` (registry; see `shared/templates/AGENTS.md`).

`drizzle/` — generated migrations + meta snapshots (committed). `i18n/locales/` — en/de/fr/es/ja/zh JSON. `docs/` — DEPLOY.md, LOCAL.md, S3-SETUP.md, OBSERVABILITY.md, SECRETS-ROTATION.md.

`scripts/` — standalone Bun scripts. `audit-markdown-pipeline.mjs` runs the full markdown-it + plugins + DOMPurify chain. `flows-ephemeral.ts` orchestrates the flow-test ephemeral stack. `build-flows.ts` publishes Playwright flow output to `public/flows/`.

`tests/` — `unit/` (pure functions, no Nuxt), `dom/` (happy-dom), `nuxt/` (composables + components in Nuxt env), `repos/` (DB-backed), `integration/` (REST + sync, opt-in), `e2e/` (Playwright flow tests; see `tests/e2e/AGENTS.md`).

`content/docs/` + `app/layouts/docs.vue` + `app/pages/docs/` + `app/components/content/{Flow,FlowFrame}.vue` — the docs site that consumes the flows. See `tests/e2e/AGENTS.md`.

---

## 7. Business Model & Unit Economics (design — not yet implemented)

This section captures the pricing design for the four-tier subscription model. **No code exists yet**; this is the plan. The real implementation requires `users.plan` + Stripe integration + an interaction counter threaded through every AI call site.

### Tier structure

Four tiers, per-user subscription. One flat-rate model — no pay-as-you-go overages at launch.

| Tier | Price | AI actions / period | Key differentiator |
|---|---|---|---|
| **Free** | $0 | 100 / mo | Try the product; funnel into paid |
| **Pro** | $10/mo | 1500 / mo | Solo power users; personal AI only |
| **Max** | $50/mo | 8000 / mo | Small teams; can toggle workspaces `(+)` so member usage bills to them |
| **Ultra** | $100/mo | 16000 / mo | Large teams; same `(+)` mechanics, bigger pool |

Monthly reset for ALL tiers. One monthly pool lets Free users burst-try the product (draft one doc with AI help, hit the cap, upgrade). Paid resets align with the Stripe billing-cycle anchor; Free resets on the calendar-month boundary.

### The `(+)` workspace concept

- **Pro users cannot toggle `(+)`.** Their subscription is personal-only. Members they invite to their workspaces still use their own quota.
- **Max and Ultra users can toggle any workspace they OWN to `(+)`.** While `(+)`, every AI call made by ANY member of that workspace is billed to the owner's quota.
- **Deactivating `(+)` is instant.** Members revert to their own quotas on the next call.
- **Ownership transfer:** `workspaces.billing_owner_id` (separate from `ownerId`) drives billing. If a Max owner leaves and hands the workspace to a Free user, `(+)` auto-disables.
- **Plan-downgrade handling:** if a Max owner's subscription lapses, `plan_valid_until` grants benefits through end-of-billing-period; after that, `(+)` auto-disables via a sweep job.

### What is an "AI action" / "interaction"?

Billing term (user-facing): **"AI action"**. Internal term (code + DB): **"interaction"**.

| Operation | Interactions charged |
|---|---|
| 1 model turn in the agentic loop | **1** |
| 1 grounded turn (`web_search` or `fetch_url`) | **5** |
| 1 generated image at 0.5K | **5** |
| 1 minute of dictation or voice-input transcription | **5** |

A 4-turn agentic loop where turn 3 calls `web_search` costs `1+1+5+1 = 8` interactions. The UI MUST show live interaction count during the loop — users can't predict cost otherwise. Embedding calls on knowledge upload are NOT counted.

### Model + resolution choices (locked in)

- **Text model**: `gemini-3.1-flash-lite` for ALL tiers. No per-tier model upgrades — paying users get MORE of the same quality, not different quality.
- **Image model**: `gemini-3.1-flash-image-preview` at **0.5K resolution**. Pin in `config.google.imageResolution`.
- **STT**: Cloud STT v1 `latest_long`.

### Unit cost math (April 2026)

- **Prompt turn — gemini-3.1-flash-lite:** $0.25/M input, $1.50/M output. Typical 6k+800 = $0.0027. **Planning number: $0.003 per turn.**
- **Grounded turn — `web_search`:** $0.003 inference + $14/1k Google Search queries past a 5000/mo project-wide free pool. Past free tier: $0.017 per grounded turn.
- **Image generation — 0.5K:** $0.045 per image (input tokens negligible).
- **Dictation — Cloud STT v1:** $0.016 per minute.

### Blended cost per interaction

Mix: 70% text turns / 10% grounded / 10% images / 10% speech minutes.

- Simple turns: 70% × $0.003 ÷ 1 = $0.0021
- Grounded: 10% × $0.017 ÷ 5 = $0.00034
- Images: 10% × $0.045 ÷ 5 = $0.0009
- Speech: 10% × $0.016 ÷ 5 = $0.00032

**Weighted blended cost per interaction: ~$0.0037.**

### Tier budget derivation

Stripe fees: 2.9% + $0.30 per charge. Net after fees + $0.50/user/mo infra: Pro $8.91, Max $47.75, Ultra $96.30.

We deliberately chose a lower at-cap margin (~40%) to be generous with users during growth. The bet: model prices will drop while caps stay constant — margin rises passively. Retention beats margin in months 12-24.

| Tier | Net | At 40% margin → AI budget | Interactions |
|---|---|---|---|
| Pro | $8.91 | $5.35 | ~1500/mo |
| Max | $47.75 | $28.65 | ~8000/mo |
| Ultra | $96.30 | $57.78 | ~16000/mo |

Free: 100 interactions × $0.0037 = $0.37/mo worst case. Average Free user hits ~30% of cap = $0.11/mo. Acceptable CAC.

### At-cap vs average-case margin

Worst case (every user maxes): all tiers ~38% margin. Real margin is much higher — SaaS norm is 15-30% of users hitting their cap. At 30% average utilisation: **~81% margin across the board**. The thin at-cap number is insurance against heavy-use outliers, not the expected case.

### Non-interaction caps per tier

| | Free | Pro | Max | Ultra |
|---|---|---|---|---|
| Workspaces you own | 1 | 10 | 30 | 100 |
| `(+)` workspaces (subset of above) | — | — | unlimited | unlimited |
| Knowledge files | 5 | 50 | 500 | 2000 |
| Knowledge bytes total | 50 MB | 2 GB | 10 GB | 50 GB |
| Dictation hard cap | 5 min/day | 30 min/day | 60 min/day | 60 min/day |
| AI sessions concurrent (per user) | 1/doc | 1/doc | 1/doc | 1/doc |

### Levers we deliberately chose NOT to pull

Documented so future-us can revisit when we genuinely need to reclaim margin.

1. **Switching to `gemini-2.5-flash-lite` (3× cheaper).** Worse at multi-tool agentic loops + long-context. Revisit once we have an eval harness.
2. **Turn-adaptive model selection** (2.5 for turns 1-3, 3.1 for 4+). Same rationale.
3. **Grounded-result caching in Valkey.** Free pool covers us initially; add when grounded spend becomes meaningful.
4. **Context pruning on long agentic loops.** Average loop is 3-5 turns; modest savings.
5. **Output-length control.** Cheap ~20% win; ship opportunistically during a prompt refactor.
6. **Per-tier model quality.** Pro gets pro-tier model? Users would hate the 10× faster burn rate.

### The bet on model pricing

Gemini pricing has dropped meaningfully every major version. If flash-lite drops 40% (plausible within 12 months): cost $0.0022, at-cap margins ~63% with NO change to caps or prices. If 60%: cost $0.0015, at-cap margins ~75%. **Caps stay constant, prices stay constant, margins rise passively.** That's the core economic bet.

If prices RISE instead, we pull the levers above without a user-visible price change.

### Implementation requirements (NOT YET DONE)

- Schema: `users.plan`, `users.plan_valid_until`, `users.stripe_customer_id`, `users.stripe_subscription_id`, `workspaces.billing_owner_id`, `workspaces.ai_enabled`.
- Tier config split in `nuxt.config.ts`: `tiers.{free,pro,max,ultra}`.
- `resolveBillingContext(userId, workspaceId)` → `{ plan, attributedTo }`.
- Interaction counter in Postgres (NOT Valkey — billing is correctness-critical). New `ai_usage_period` table, atomic INCR per turn in `runLoop.ts`.
- Stripe: checkout, billing portal, webhook (~200 lines).
- UI: `/pricing`, interactions-remaining display in `AIPromptBar`, `(+)` badge, plan-downgrade sweep job.

Realistic scope: 5-7 days end-to-end including Stripe + UI polish.

---

## 8. Shipped Features (manifest)

For the per-feature deep-dive, follow the sub-AGENTS.md links.

- **Infrastructure:** Compose stack, Drizzle + versioned migrations at boot, y-postgresql persistence, S3 singleton, Markitdown service, daily pg backup sidecar, Sentry observability, Valkey rate limiting, dual-secret rotation, inactive doc sweep, PWA.
- **Auth & editor:** GitHub + Google OAuth, `SESSION_VERSION` invalidation, anonymous doc creation, CodeMirror 6 + yCollab, split editor/preview, formatting toolbar + status bar, welcome doc, i18n (en complete; others scaffolded). See `server/AGENTS.md`.
- **Collaboration:** Awareness (names/colors/avatars), PresenceBar, Y.js title sync, share modal with access-mode selector, scrypt password protection (3-layer), comments panel + `@ai` mention trigger, **Activity Log Tier 1 + 2** (see `app/components/collab/AGENTS.md`).
- **Files & import/export:** Presigned upload flow + DB tracking, drag-drop + paste upload, markitdown import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), client-side `.md` download, client-side PDF via paged.js + `window.print()`.
- **Preview & PDF:** paged.js pivot (A4/Letter pages, header/footer, footnotes via `float: footnote`), single `themeToCss()` for preview + print, iframe isolation, responsive page zoom, `Cmd/Ctrl+P` hijack, dark mode chrome. See `app/utils/AGENTS.md`.
- **Theme system:** Per-doc JSONB + `ymeta.theme` live broadcast, server validation, `ThemeEditorPanel.vue` (11 sections), 6 built-in presets, 20-font Google Fonts picker, TOC controls, mermaid theme picker, header/footer token chips. Phase 4 (user-saved themes) pending.
- **Markdown extensions:** Batch 1 (typography), Batch 2 (katex + alerts), Batch 3 (anchor + TOC + Mermaid), pagebreak + comments. See `app/utils/AGENTS.md`.
- **Editor chrome:** Google-Docs-style menu bar, table size picker, diagram/alert/math dropdowns, right sidebar (Activity / Theme / Document / Knowledge), view-mode toggle, `DeleteConfirmModal`.
- **Workspaces:** Three-role model, invite-by-email, last-admin invariant, cascade delete, role-gated UI at `/w/:id`. See `server/AGENTS.md`.
- **Document context + new-doc dialog + templates:** description / audience / language / templateId fields injected into every AI prompt; multi-language template skeletons. See `app/components/document/AGENTS.md` and `shared/templates/AGENTS.md`.
- **Document duplication:** `POST /api/docs/:id/duplicate` clones row + Y.js state with URL rewrite + S3 assets. See `server/utils/duplicateDocument.ts`.
- **Workspace knowledge base:** PDF/DOCX/PPTX/XLSX/HTML/EPUB/MD/TXT upload → markitdown → chunked → embedded → pgvector + tsvector hybrid search. See `server/utils/AGENTS.md`.
- **AI:** 14 always-on tools + 2 workspace-gated knowledge tools, `@ai` comment trigger, voice input, live dictation. See `server/utils/agentic/AGENTS.md`.
- **Mobile:** Touch-optimized CM6, flex-wrap toolbar, hamburger menu, 640px breakpoint. See `app/AGENTS.md`.
- **Flow docs system:** Playwright tests = documentation. See `tests/e2e/AGENTS.md`.

---

## 9. TODOs

### MVP leftover
- [ ] DNS: `yourdomain.com`, `sync.` subdomains (prod deploy)
- [ ] CORS: Traefik middleware for S3 (prod deploy)

### Monetisation (design locked in; see §7)
- [ ] Schema: `users.plan` + `plan_valid_until` + `stripe_*` cols; `workspaces.billing_owner_id` + `ai_enabled`
- [ ] `tiers.{free,pro,max,ultra}` config split
- [ ] `resolveBillingContext(userId, workspaceId)` helper
- [ ] `ai_usage_period` table + atomic interaction counter threaded through `runLoop.ts`
- [ ] Stripe checkout + billing portal + webhook
- [ ] `/pricing` page + plan badges + interactions-remaining display in `AIPromptBar`
- [ ] `(+)` workspace toggle (Max/Ultra only) + lapsed-owner sweep job

### MMP

**History & snapshots**
- [x] Diff view + restore — shipped via Activity Log Tier 1 + 2. See `app/components/collab/AGENTS.md`.
- [ ] Timestamped snapshots in S3 via Hocuspocus hook (separate from y-postgresql append-log; would let us garbage-collect row history while keeping daily-granularity restore points).
- [ ] Timeline scrubber UI — currently restore is per-activity-row.
- [ ] Export at a point in time (PDF/markdown of a past state).

**Theme system**
- [ ] Phase 4: User-saved themes — `themes` table + CRUD endpoints

**Markdown extensions**
- [ ] Batch 4: `markdown-it-criticmarkup`, `markdown-it-multimd-table`, client-side BibTeX citations

**Power features**
- [ ] Markdown frontmatter, command palette, TOC sidebar, folding, highlighting, QR code sharing, keyboard cheat sheet, Y.js compaction, remaining locale translations, markdown export with base64-inlined images

**Mobile MMP**
- [ ] Floating toolbar above virtual keyboard via `visualViewport`, bottom tab bar (Edit/Preview/AI), sidebar as bottom sheet

**AI**
- [ ] Semantic search across docs via embeddings — "find the section about X", "suggest related docs"
- [ ] Safari support for voice input / dictation — Safari's `MediaRecorder` only emits `audio/mp4` (AAC) which Cloud STT sync doesn't accept.

**Flow docs system** (see `tests/e2e/AGENTS.md`)
- [ ] Tier 1 flows: `polished-pdf`, `import-existing`, `rich-content`, `password-protect`.
- [ ] Two-context fixture for password-protect flow.
- [ ] Selective re-runs: `flows:test:changed`.
- [ ] CI integration.
- [ ] Doc-content i18n pattern.
- [ ] `/docs/_internal/flows` gallery.
- [ ] Mobile flow project (375×667 + dedicated `MobileEditorPage`).

**AI (explicitly out of scope):** multi-turn conversation history, streaming text, "AI for Alice" attribution, user-selectable model, grounded-search caching, cost telemetry, provider-swap adapter. Generic image search (Bing deprecated, Google CSE expensive, DDG ToS); covered indirectly by `fetch_url`. Pexels/Unsplash stock-photo search — `generate_image` covers it.

---

## 10. Project-wide Decisions

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
| Sync-server per-doc state in Valkey, not in-process Maps | Lets multiple sync-server instances share attribution + diff baselines. Sticky sessions at Traefik pin a client to one container; residual cross-container race on `prev-text` produces at most one duplicate activity row per concurrency event (documented in `sync-server/AGENTS.md`). 24 h TTL caps memory growth |
| `SESSION_VERSION` invalidation | Simpler than backwards-compat shims pre-launch |
| paged.js in srcdoc iframe | paged.js mutates global state; host-page approach caused unrecoverable layout jitter |
| Single `themeToCss()` for preview AND print | One function, two consumers — genuine WYSIWYG |
| Client-side PDF via paged.js + `window.print()` | No server Chromium, no queue, no S3 round-trip |
| Drop DOCX/HTML export | Maintenance burden; markdown + PDF covers all real needs |
| Markitdown over pandoc | 1.1 GB → 615 MB image; import-only use case doesn't need pandoc's output formats |
| CDN for paged.js / hljs / KaTeX / Mermaid | Vite can't inject into srcdoc iframes; versioned CDN URL = automatic cache-bust |
| `pgvector/pgvector:pg16` over stock `postgres:16-alpine` | Data-dir-compatible drop-in; avoids "install pgvector at runtime" ceremony |
| Gemini over Claude | Materially cheaper; display name vendor-neutral ("AI Assistant") |
| Cloud Speech-to-Text over Gemini Live / inline audio | Gemini Live is conversational duplex (server-side VAD buffers until end-of-turn — wrong for dictation). Inline audio costs ~4× per minute. Cloud STT is purpose-built for streaming STT |
| Cloud STT v1 (not v2) | v2 streamingRecognize requires project id in recognizer path; v1 keeps the server code to a single SDK call. `latest_long` in v1 is plenty for dictation |
| Split Google API keys (Gemini + Cloud STT) | Two separately-restricted keys in GCP so a leak of one doesn't pivot to the other. Separate billing lines |
| Separate `dictateJwtSecret` | Rotate independently of the Hocuspocus secret. Falls back to `jwtSecret` for dev |
| Zod as AI-tool source-of-truth | `z.toJSONSchema` generates Gemini schema + runtime validator; malformed args self-correct |
| Implicit Gemini prefix cache, no explicit `ai.caches.create` | Automatic prefix cache handles within-loop + cross-user system-prompt sharing for free; explicit caching has minimum-size + TTL-refresh overhead that doesn't pay off on our traffic |
| Flow tests double as docs | A separate "tour the editor" docs system + e2e suite would drift apart. Sharing the same artefact forces both honest |
| Single shared test compose with profiles | A separate `docker-compose.flows.yml` hit the `--remove-orphans` footgun (compose project namespace shared with dev infra). One compose file under `--profile flows` |

For feature-specific decisions (restore reversibility, AI tool design, knowledge pipeline, etc.) see the sub-AGENTS.md for that area.

---

## 11. Project-wide Gotchas

For feature-specific gotchas see the sub-AGENTS.md for that area.

- **`server/auth/` is not a Nitro route dir.** OAuth handlers live in `server/routes/auth/`.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **`nitro.preset` must match runtime** — default `node-server` breaks packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **Drizzle `node-postgres`** — Promise-returning, no `.get()`/`.all()`. Use `(await db.select()...limit(1))[0]`.
- **Drizzle doesn't emit `CREATE EXTENSION`** — for `vector(...)` columns, hand-prepend `CREATE EXTENSION IF NOT EXISTS vector;` + `statement-breakpoint` to the generated SQL.
- **Migrations that TRUNCATE optional tables need `IF EXISTS` guards.** `yjs_documents` is created lazily by y-postgresql at sync-server startup, NOT by drizzle.
- **Never ship `passwordHash`** — always project explicitly on public endpoints.
- **Never issue usable JWT for forbidden/password-gated docs** — `token: null` prevents Hocuspocus connection.
- **Presigned read URL TTL: 120s** — can't be revoked; long TTLs outlive access-mode/password changes.
- **`y-postgresql` 1.0.1** — force `useIndex: false` (SQL bug in index-creation branch).
- **Workspace authz: one helper per concern.** `canEditDoc` (content), `canManageDoc` (sharing/delete), `canManageWorkspace` (admin actions). Mixing leaks permissions.
- **`workspaces.ownerId` vs `workspace_members.role='admin'`** — `ownerId` is provenance only, never used for authz. An original creator demoted to editor loses admin rights.
- **Removing a workspace member doesn't revoke active JWTs** — valid until next token refresh (up to 2h). Acceptable for now.
- **`vi.mock` paths resolve relative to the TEST FILE, not the source file.** Use `vi.mock('../../server/utils/database', ...)` from a test in `tests/unit/`. Symptom is opaque: tests "passing" but with phantom assertions because the mock never engaged.
- **`bun run test:coverage` undercounts.** `@vitest/coverage-v8` only measures code that runs in the vitest process; integration tests spawn a separate `bun run dev` subprocess via `tests/integration/setup/server.ts`, so every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*` runs there — invisible to coverage. Three dead ends so we don't try again: (1) Bun doesn't honor `NODE_V8_COVERAGE` (oven-sh/bun#17867). (2) Spawning with `node` + NODE_V8_COVERAGE produces files but Nitro's Vite SSR transform records URLs as `evalmachine.<anonymous>` which c8 can't map. (3) `@nuxt/test-utils/e2e` `setup()` would work but our `nitro.preset: 'bun'` build traces Bun-specific paths and Stripe's ESM entry doesn't resolve under Node's ESM resolver. **Net: the API-route coverage gap is architectural.** When reviewing coverage, mentally overlay: every `server/{api,middleware,plugins,routes}/*` plus orchestrators like `processKnowledge.ts` and `aiClient.ts` is covered by the 300+ integration tests but doesn't show up in the number.
