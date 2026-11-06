# markoto — Project Guide

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google) via `nuxt-auth-utils` + generic OpenID Connect for self-hosters' IdPs (`openid-client`), PostgreSQL (app data + Y.js state via `y-postgresql` + pgvector embeddings), external S3 for image uploads & pg backups, multi-lingual UI via `@nuxtjs/i18n`, AI writing assistance via a self-hosted LiteLLM proxy fronting Mistral (text + voice) / Jina (embeddings + `fetch_url` page extraction via Jina Reader) / Staan (web search) / BFL (image gen) — all EU-resident — with workspace knowledge-base retrieval, Stripe billing for tiered AI budgets enforced as per-user LiteLLM virtual-key `max_budget`. Single Linux VPS today, multi-instance-capable since Phase 3. Docker Compose + Ansible.

Login is **optional** — public docs work anonymously. Login is required to own, manage permissions, use workspaces, delete, or use AI.

License: **FSL-1.1-ALv2** (source-available, converts to Apache-2.0 after two years).

Pricing & monetisation strategy is internal and tracked outside this repo. AI agents do not need it for engineering work; reach for the implementation directly (`server/utils/billing.ts`, `users.plan`, `server/utils/litellmKeys.ts`, `server/utils/stripeWebhook.ts`).

**Billing is OFF by default** (`NUXT_BILLING_ENABLED`, see `shared/config/billingMode.ts`). The same code runs self-hosted (billing off), as the free-only hosted SaaS (billing off + `NUXT_PLANS_COMING_SOON=true`: paid plans shown as "coming soon" + a double-opt-in waitlist), and — later — with paid plans live (billing on). The Stripe code stays in the repo, dormant until the flag flips.

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
| `app/components/legal/AGENTS.md` | Privacy surfaces — onboarding gate, deletion modal/banner, age gate (no cookie banner: essential storage only) |
| `server/AGENTS.md` | Auth & access control + Drizzle/middleware/repos conventions + sweepers |
| `server/legal/AGENTS.md` | Privacy/legal registries — versions, lawful-basis, sub-processors, audit actions |
| `server/api/AGENTS.md` | API route map |
| `server/utils/AGENTS.md` | Workspace knowledge base + history/diff/restore + Stripe webhook + audit log + sweep locks + idempotency |
| `server/utils/agentic/AGENTS.md` | AI agentic loop, tools, voice, dictation, per-tool + per-session caps |
| `server/mcp/AGENTS.md` | MCP server — PAT auth, tool wrappers, YDocPool, agent attribution chain |
| `sync-server/AGENTS.md` | Hocuspocus configuration + Valkey-backed per-doc state + sticky sessions |
| `shared/templates/AGENTS.md` | Template registry/renderer split |
| `tests/e2e/AGENTS.md` | Flow Docs system (Playwright tests = docs) |
| `infra/README.md` | Ansible layout, role conventions, deploy/rollback playbooks |
| `docs/RELEASE-PROCESS.md` | One-PR-one-release flow + GHA wiring |
| `docs/RUNBOOK.md` | Symptom-driven prod incident playbook |
| `docs/LAUNCH-CHECKLIST.md` | One-time hosted launch (free-only shape): `prod` Environment secrets, Compose v5, first LiteLLM boot, post-deploy verification |
| `docs/BREACH-RESPONSE.md` | GDPR Art.33/34 + Swiss FADP data-breach response runbook (72h clock, notification paths) |
| `docs/CHEATSHEET.md` | Command discovery (Make targets, common workflows) |
| `docs/TEMPLATE-WORKFLOW.md` | How to build a design template (theme preset): reference, Markdown fixture, compare script, difference classification, template CSS rules, design checklist |
| `docs/AI-MODELS.md` | Chosen AI models per surface, rationale, sources, BYOK recommended models |
| `docs/DEPLOY-OVH.md` | First-time OVH VPS provisioning |
| `docs/SELF-HOSTING.md` | Self-host install (`install.sh`), config reference, login/OAuth, BYOK + instance AI defaults, upgrades + upgrade notes, backups/restore, re-embed, trusted proxy, troubleshooting |
| `docs/ARCHITECTURE.md` | Contributor-friendly architecture overview (mermaid diagram), distilled from this file |
| `CONTRIBUTING.md` | Dev setup, test tiers + docker test stack, coding rules, PR conventions (DCO/CLA still undecided) |
| `content/docs/` | User documentation rendered at `/docs` (Nuxt Content). Pages embed Playwright flows; write in the user's voice, no internals. Operator-only files in `docs/` carry an "Operator docs for the hosted markoto.app deployment" header |
| `docs/SECURITY-HARDENING.md` | Tier-1 hardening rationale + verification |
| `docs/GITHUB-CONFIG.md` | Branch protection, secrets, environments |
| `docs/TRANSLATION-REVIEW.md` | de/fr marketing pages awaiting native review (`reviewed: false`) and how to flip them |

---

## 1. Architecture

Browser (Nuxt 4 SSR + SPA with CodeMirror 6, Y.js, paged.js iframe) connects via HTTPS/WSS to Traefik, which routes to the Nuxt app container, the Hocuspocus sync container, and the headless Playwright renderer sidecar. App + sync + renderer all talk to PostgreSQL (managed) and Valkey (self-hosted). App talks to Hocuspocus over internal HTTP. Backup sidecar (unprivileged user) does daily `pg_dump | gzip | gpg → S3`, into its own `BACKUP_S3_*` bucket/credentials (default: the app's `NUXT_S3_*`; the app and renderer never receive them). Markitdown (FastAPI) handles imports only.

**Key design principles**
- **Full-stack Nuxt.** One Bun process serves SSR + Nitro API + OAuth. No CDN — also not for third-party browser assets: paged.js, Mermaid, KaTeX, highlight.js and every web font are served from our own origin under `/vendor/` (see below), so visitors' browsers and the renderer make no third-party request.
- **OAuth optional.** Anonymous users can view/edit public docs; login gates ownership and AI.
- **Y.js state in Postgres** via `y-postgresql` (`yjs_documents` table). Append-only + periodic merge; one `pg_dump` covers everything.
- **S3 = image uploads, workspace knowledge originals (deleted post-processing), and pg backups.** SeaweedFS in dev; OVH Object Storage in prod.
- **Workspace knowledge base.** Files uploaded to a workspace → markitdown → chunked → embedded → pgvector HNSW + tsvector for hybrid search. See `server/utils/AGENTS.md`.
- **Hocuspocus as separate container.** Long-lived WS shouldn't share the Nitro event loop. Server↔sync over shared-secret HTTP. Per-doc attribution + diff state lives in Valkey so multiple sync instances can share a view; sticky sessions at Traefik pin a client to one container.
- **Server-rendered PDF + PNG via Playwright sidecar** (`renderer` service). Internal-only; called by `server/utils/renderClient.ts`. The browser-side paged.js path still drives live preview + the `Cmd/Ctrl+P` print fallback — both in a sandboxed opaque-origin iframe (§4).
- **AI joins the doc as a real Y.js client** — edits broadcast live via CRDT, status via awareness. See `server/utils/agentic/AGENTS.md`.
- **Bring your own key (WP4).** Chat, image generation and transcription run on the user's own OpenAI-compatible provider (Settings → AI provider) or an operator instance default; resolution per request: own key → instance default → unavailable. Calls still go through LiteLLM (`byok/*` zero-cost deployment, clientside `api_key`/`api_base`, user's virtual key for rpm + tags). Embeddings / web search / page fetch stay platform-provided. SSRF policy on every save AND request. See `server/utils/aiProviders/` + `docs/AI-MODELS.md#bring-your-own-key`.
- **Mistral is EU-only.** Every Mistral call the platform pays — the LiteLLM deployments (`mistral-small-2603`, `ministral-8b-2512`, `zai-glm-5-3-flash`, Voxtral transcription via `custom_handlers.py`) and live dictation on the operator's key (`@mistralai/mistralai` realtime SDK, `serverURL`) — goes to Mistral's EU regional endpoint `api.eu.mistral.ai` at 1.1× list (the global `api.mistral.ai` makes no location commitment). A user's own Mistral key streams to the host they configured. Pinned by `tests/unit/mistralEuEndpoint.test.ts`.
- **Free AI allowance (hosted).** The hosted SaaS's chat default is `zai-glm-5-3-flash` (Z.ai GLM-5.3 Flash served by Mistral, EU endpoint `api.eu.mistral.ai`, platform-paid): $0.50 per user per month (`TIER_FREE_LITELLM_BUDGET_USD`, the key's `max_budget`) and $500 per month for all free users together (`NUXT_FREE_TIER_TOTAL_BUDGET_USD` → LiteLLM team `markoto-free-tier`; unset / 0 = none, self-host default). Enforced by the proxy only; BYOK (zero-cost) and paid tiers are outside the pool. Pool used up → 402 `ai/free-allowance-exhausted`. Keys are moved into / out of the team by `litellm-key-reconcile` (boot + 6 h). Requests are laid out for prompt caching (`server/utils/agentic/promptAssembly.ts`). See `server/utils/litellm/freeTierTeam.ts` + `docs/AI-MODELS.md#free-ai-allowance-hosted`.
- **Preview is paged, in an iframe.** `themeToCss(theme)` drives both live preview AND server-rendered PDF. See `app/utils/AGENTS.md`.
- **Stripe billing for AI quotas — switchable.** `NUXT_BILLING_ENABLED` (default `false`) gates every Stripe surface: off → no Stripe calls, Stripe env not required at boot, `/api/billing/{checkout,portal}` + the Stripe webhook + the workspace `(+)` toggle answer **404 `billing/disabled`**, Stripe sweepers don't start, every account resolves to the FREE tier (raise it via `TIER_FREE_*`), and purchase UI is hidden. Server helpers in `server/utils/billingMode.ts`, client `useBillingMode()`. Per-user `users.plan` + per-user LiteLLM virtual keys — the proxy's `max_budget` is the sole enforcement gate (the legacy `ai_usage_period` interaction counter was retired in Phase 6). Stripe webhook hardened with `processed_webhook_events` (idempotency) + `pending_stripe_events` (out-of-order stash). Workspaces can have `ai_enabled=true` to bill member AI usage to the workspace owner. See `server/utils/AGENTS.md`.
- **Markitdown isolated.** Python/FastAPI wrapper; Nuxt image stays lean (~615 MB vs ~1.1 GB for pandoc).
- **Single-VPS today, multi-instance-capable.** Sticky sessions + Valkey-backed sync state + advisory-locked sweepers + Stripe event dedup mean we can scale horizontally without code changes. We're not running multi-instance yet; 30-second downtime budget on deploy is the accepted trade.

---

## 2. Technology Stack

### Runtime

| Tool | Version | Purpose |
|---|---|---|
| Bun | 1.4.4 | JS/TS runtime + package manager (lockfile v2 — Bun ≥ 1.4 required to install) |
| Nuxt | 4.6.2 | Full-stack Vue (SSR + API via Nitro) |

### Nuxt modules

| Module | Version | Purpose |
|---|---|---|
| `@nuxt/ui` | 4.12.0 | Reka UI + Tailwind v4 |
| `nuxt-auth-utils` | 0.5.32 | OAuth + sealed-cookie sessions |
| `@nuxtjs/i18n` | 10.6.0 | 6 languages, lazy-loaded |
| `@vueuse/nuxt` | 14.4.0 | VueUse auto-imports |
| `@pinia/nuxt` | 1.0.3 | State management (must precede Colada) |
| `@pinia/colada-nuxt` | 1.2.0 | `useQuery` / `useMutation` |
| `@vite-pwa/nuxt` | 1.1.1 | PWA/Workbox |
| `nuxt-codemirror` | 0.0.11 | CM6 Vue wrapper — its Vite alias dedupes `@codemirror/{state,view}` to the root copies, which are declared as direct deps |

### Frontend

| Package | Version | Purpose |
|---|---|---|
| `yjs` | 13.6.33 | CRDT doc model |
| `y-codemirror.next` | 0.3.6 | CM6 ↔ Y.js with remote cursors |
| `@hocuspocus/provider` | 3.4.4 | WS provider |
| `@codemirror/lang-markdown` | 6.5.2 | Markdown + GFM |
| `@codemirror/language-data` | 6.5.2 | Code-fence highlighting |
| `markdown-it` + plugins | 14.3.3 | Core renderer (task-lists, emoji, footnote + custom pagebreak rule) |
| `@mdit/plugin-{attrs,mark,ins,sub,sup,dl,abbr,figure,img-size}` | 0.23–0.25 | Batch 1: typography & semantic markup |
| `@mdit/plugin-alert` + `@mdit/plugin-katex` + `katex` | 0.23–0.25 / 0.18 | Batch 2: alerts + math (`katex` forced onto the plugin via `overrides`; the vendored stylesheet in `shared/utils/katexAssets.ts` must match the minor version — 0.18 prefixed the internal CSS classes) |
| `markdown-it-anchor` + `markdown-it-toc-done-right` | 9.2.0 / 4.2.0 | Batch 3: heading IDs + `[[toc]]` |
| `mermaid` (devDependency, vendored single-file build, lazy, SRI) | 11.17.2 | Batch 3: diagrams; pinned in `shared/utils/mermaidAssets.ts` (IIFE `mermaid.min.js` — the ESM build's `import()` chunks can't be SRI-checked) |
| `highlight.js` | 11.12.0 | Code highlighting (vendored theme stylesheets, `shared/utils/hljsAssets.ts`) |
| `dompurify` | 3.4.17 | XSS sanitization (XSS test suite runs under jsdom — happy-dom breaks DOMPurify ≥ 3.4.8) |
| `pagedjs` (vendored) | 0.4.3 | CSS Paged Media polyfill; pinned in `shared/utils/pagedjsAssets.ts` |
| `@fontsource-variable/*` + `@fontsource/*` (devDependencies, exact) | 5.3.x | The 23 self-hosted web fonts (20-font theme picker + JetBrains Mono, IBM Plex Mono, Fraunces) — registry `shared/utils/themeFonts.ts` |
| `nanoid` | 6.0.2 | ID generation |
| `openai` | ^7.43 | OpenAI SDK pointed at LiteLLM (used for embeddings + text agentic loop + image gen + voice transcribe) |
| `@mistralai/mistralai` | ^2.7 | Mistral SDK — used only for Voxtral Realtime WS streaming (`extra/realtime` sub-export). All other Mistral calls go via LiteLLM. |
| `file-type` | ^22 | Magic-byte sniffer for knowledge-upload content-type validation |

### Sync server (`sync-server/`)

| Package | Version | Purpose |
|---|---|---|
| `@hocuspocus/server` | 3.4.4 | WS sync server |
| `y-postgresql` | 1.0.1 | Y.js persistence (⚠ `useIndex: false` — 1.0.1 has SQL bug) |
| `pg` | ^8.23 | Driver |
| `ioredis` | ^6 | Per-doc state in Valkey (separate from app's pool) |
| `@sentry/bun` | ^10 | Error telemetry (JWT verification uses `shared/utils/secrets`, no `jsonwebtoken` dep) |

### Nuxt server

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.4 | Type-safe ORM (`node-postgres` adapter) |
| `drizzle-kit` | 0.31.11 | Migration generator |
| `pg` | ^8.23 | Driver |
| `@aws-sdk/client-s3` + presigner | 3.1156.0 | Image uploads |
| `jsonwebtoken` | 9.0.3 | Hocuspocus token minting |
| `stripe` | ^23 | Subscription + webhook |
| `zod` | ^4 | Validates AI tool-call args (Mistral/OpenAI shape); `z.toJSONSchema` generates tool schemas |

### LiteLLM proxy (`infra/litellm/`)

Vendor-agnostic gateway between the app and external AI providers. Self-hosted (`ghcr.io/berriai/litellm:v1.106.4` — since 1.84 LiteLLM tags stable releases as plain `vX.Y.Z`, no `-stable` suffix) — runs as a Compose service on the `data` + `egress` networks, backed by a separate `litellm` database on the existing Postgres instance, connecting as its own role (`POSTGRES_LITELLM_USER`, owner of that database only). Admin UI off (`DISABLE_ADMIN_UI=True` — v1.106.4 ignores the `disable_admin_ui` config key).

Phase 1A wires only embeddings + reranker through LiteLLM (`jina-embeddings-v5-text-nano` for the workspace knowledge base). Phases 3 / 4 / 5 add image gen (BFL via custom provider, EU-pinned), text agentic loop (Mistral Small 4.0), and voice metering (Voxtral Realtime via custom-provider tick). The migration is complete; the historical migration plan + spike findings are archived outside the repo.

Four custom Python providers in `infra/litellm/custom_handlers.py`: `JinaEmbeddingsProvider` (active Phase 1A — reshapes Jina's `usage.total_tokens` → `prompt_tokens`), `MistralTranscribeProvider` (active Phase 2 — wraps Mistral's `/v1/audio/transcriptions` as a chat completion so LiteLLM extracts `usage.prompt_audio_seconds` correctly), `BFLFluxProvider` (active Phase 3 — BFL FLUX.2 [pro] EU-pinned to `api.eu2.bfl.ai`; default 1024² @ $0.030, optional width/height for non-square; submission+poll wrapped as chat-completion to fix the OSS image-gen spend-logger gap), `VoxtralTickProvider` (voice-tick billing stub, Phase 5). All use the OSS `litellm_settings.custom_provider_map` mechanism — no Enterprise license needed. Pattern when LiteLLM's native cost path doesn't fit a provider's response shape: wrap as chat completions with usage in `completion_tokens`, set `output_cost_per_token` to the unit price.

Health probe at `http://litellm:4000/health/liveliness` is wired into `/api/health` + `/api/health/deep`.

### Renderer sidecar (`renderer/`)

Headless Playwright service used by `server/utils/renderClient.ts` for server-rendered PDF + per-page PNG. Internal-only; not exposed via Traefik. **Runs as `pwuser` with Chromium's own sandbox** (no `--no-sandbox`): `cap_drop: [ALL]`, `no-new-privileges`, read-only root + tmpfs `/tmp`, and the seccomp profile `renderer/seccomp.json` (Docker default + `clone`/`unshare`/`chroot`, which the user-namespace sandbox needs). `RENDERER_CHROMIUM_SANDBOX=false` is the documented escape hatch for hosts without user namespaces; `RENDERER_LOCALHOST_TARGET` (default `host.docker.internal`) is where Chromium resolves `localhost` (dev/test point it at their SeaweedFS container). See `docs/SECURITY-HARDENING.md` §C. **Network lockdown (SSRF):** the renderer loads the print page straight from the app container (no Traefik, no CSP) and renders attacker-influenced markdown, so every browser-context request is checked against an origin allowlist (`renderer/src/allowlist.ts`: `APP_URL`, `S3_PUBLIC_ENDPOINT` else `S3_ENDPOINT`, plus `RENDERER_ALLOWED_ORIGINS` — no CDN host: scripts, styles and fonts come from the app's `/vendor/`); anything else is aborted (host-only log), WebSockets and service workers are refused. Playwright does not re-enter `route()` for redirect hops, so the app also sends a mirrored CSP on `/_internal/render/*` (`buildRenderCsp` in `server/utils/csp.ts`, applied by `server/plugins/csp.ts`; the app container needs the same `RENDERER_ALLOWED_ORIGINS`). A new third-party asset the print page needs is vendored under `/vendor/` (`scripts/lib/vendorAssets.ts`), never allowed as a new origin. Pinned by `tests/integration/endpoints/rendererNetwork.test.ts` + `tests/unit/rendererAllowlist.test.ts`.

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

All workflows start from `permissions: {}` (per-job grants), pin every third-party action by full commit SHA (Dependabot moves the pins), and take high-value secrets (`RELEASE_BOT_TOKEN`, live-AI provider keys, `DEPLOY_*`) only from main-only Environments (`release`, `staging`, `prod`; see `docs/GITHUB-CONFIG.md`). Deploys pin SSH host keys (`DEPLOY_KNOWN_HOSTS`); release images are cosign-signed with provenance + SBOM. `ci.yml` (PR gate) — jobs: `label-check`, `semantic-pr-title`, `actions-lint` (actionlint), `secret-scan` (gitleaks), `lint-typecheck` (incl. `sync-server/` + `renderer/` typecheck, render-env parity, ansible-lint + yamllint), `migration-guard`, `test-unit-dom`, `changes` (path filters), `test-repos-integration-flows` (coverage suite + integration tests; NO Playwright flow suite — the name is historical and stays because it is a required status check), `sonar`, `image-scan` (Trivy, only for images whose Dockerfile/deps changed; calls reusable `image-scan.yml`). Heavy jobs (`test-repos-integration-flows`, `sonar`) skip on draft PRs and docs-only PRs via job-level `if` on the `changes` job (never workflow-level `paths:`, which would leave required checks pending). `release.yml` — merge to `main` → releases are OPT-IN (runs only for PRs labeled `release:patch|minor|major`; unlabeled merges skip) → version bump + tagged GHCR images + full flow suite incl. live AI (provider keys wired here) + GH Release built from PR title + body. `staging-gate.yml` — auto after a published release: verify-release → deploy `latest` to staging (reuses `deploy.yml` via `workflow_call`, so staging's `.env` is rendered from GitHub too) → public smoke vs `https://staging.markoto.app` (no duplicate flow suite). `deploy.yml` — MANUAL `workflow_dispatch` only (staging or prod, tag input, auto-rollback). `sonar.yml` — SonarCloud baseline, weekly cron + manual dispatch. `image-scan-weekly.yml` — weekly cron + manual Trivy scan of all five images on `main`.

> Password hashing uses `nuxt-auth-utils` built-in scrypt `hashPassword`/`verifyPassword` — not argon2.

---

## 3. Data Model

| Data | Storage |
|---|---|
| Users (incl. `plan`, `plan_valid_until`, `stripe_*` cols, `litellm_key_*` cols, `locale`, `age_confirmed_at`, `deletion_requested_at`/`deletion_grace_until`, `is_admin`, `*_version_accepted`/`*_locale` for privacy/tos/dpa policy acceptance), documents (theme JSONB, `workspace_id`), workspaces (incl. `billing_owner_id`, `ai_enabled`), workspace_members, themes, uploads, activity_log, audit_log, consent_log, abuse_reports, data_export_jobs, ai_sessions, ai_session_messages, ai_session_provenance (which user an AI session wrote for + whether its edits count as their own for the AI taint gate), document_comments, mcp_personal_tokens, mcp_sessions, processed_webhook_events, pending_stripe_events, waitlist_signups, user_ai_providers (BYOK provider config per user per capability, AES-256-GCM-encrypted key), workspace_invites (pending invitations) | PostgreSQL (Drizzle) |
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

**Image uploads** (`uploads`): every row (pending + confirmed) counts against the uploader's `imageBytesPerUser` quota; `s3_key` is the final key (the browser only ever PUTs the staging key next to it); `gc_checked_at` + `unreferenced_since` (migration `0022`) drive the image GC. See `server/utils/AGENTS.md` → Uploads & storage.

**AI budget enforcement:** per-user LiteLLM virtual keys (`users.litellm_key_id` + encrypted `litellm_key_token`) with `max_budget` enforced by the proxy. The legacy `ai_usage_period` interaction-counter table was retired in Phase 6 (see the retirement note near `workspaceKnowledgeChunks` in `server/db/schema.ts`). Rate limits live in Valkey, not in a Postgres table.

**Document context columns** (added in `0001_silky_eternals.sql`): `description`, `audience`, `language`, `template_id` — all NOT NULL with sensible defaults. See `app/components/document/AGENTS.md`.

**Workspace invitations** (security batch B4): `workspace_invites` — one open invite per (workspace, normalised email): role, inviter (`ON DELETE SET NULL`), optional SHA-256 of the single-use emailed accept token, 14-day `expires_at` (expired rows reaped by `workspace-invite-sweep`). Inviting never adds a member; accepting (in-app on the matching verified account email, or via the emailed link) creates the `workspace_members` row. Lawful basis `workspace_invitations`. See `server/AGENTS.md` → Workspaces & roles.

**Anonymous gate** (`server/utils/anonGate/`, `shared/config/anonGate.ts`, `NUXT_ANON_GATE_ENABLED`, default = legal surfaces): before an anonymous visitor's document is created they accept the Terms + age ≥16 once per browser (signed httpOnly `markoto-anon-terms` cookie: version + time) and send a fresh ALTCHA proof-of-work solution, computed + verified in our own Nitro server with `altcha-lib` (HMAC key `NUXT_ALTCHA_HMAC_KEY`, 20-min expiry, replay-protected in Valkey, fails closed; ALTCHA Sentinel is commercial so there is no extra container). `documents.anon_terms_version` / `anon_terms_accepted_at` record it; 403 `anon-gate/*` otherwise. Anonymous docs show a "created by a markoto user · Report" bar. Anonymous abuse reports need the bot check too. All `/d/**`, render and doc-API responses send `X-Robots-Tag: noindex, nofollow`; `/robots.txt` deliberately allows `/d/` (crawlers must fetch a doc to see its noindex) and disallows internals. See `server/AGENTS.md` → Anonymous gate.

**Moderation notices** (DSA Art.16/17): `abuse_reports` carries the Art.16(2) fields (`content_url`, `reporter_name`, `reporter_locale`, `good_faith_confirmed_at`) and the decision (`decision_action` / `decision_rule` / `decision_explanation`); `moderation_notices` (cascades with its report) stores every receipt, decision notice and statement of reasons with its exact text and delivery status (`not_delivered_no_contact` for anonymous docs).

**Session revocation + anonymous-doc ownership** (B4): `users.session_epoch` (sealed into the cookie, bumped by "log out everywhere" + account-deletion request) and `documents.anon_creator_key_hash` (SHA-256 of the creating browser's `markoto-anon-creator` cookie; only that browser may delete an anonymous doc). See `server/AGENTS.md`.

**Paid-plans waitlist** (WP3): `waitlist_signups` — normalised email (unique), locale, `consent_version` + `consent_text_id`, optional `user_id` (`ON DELETE CASCADE`), SHA-256 hashes of the confirm + unsubscribe tokens (raw tokens exist only in the email), `created_at` / `confirmed_at`. No IP stored. Double opt-in; only confirmed rows count; unsubscribe deletes the row; unconfirmed rows reaped after 7 days by `waitlist-sweep`. Only open when billing is off AND `NUXT_PLANS_COMING_SOON=true`. Lawful basis `paid_plans_waitlist` (consent) in `server/legal/lawfulBasis.ts`. See `server/utils/AGENTS.md`.

**Privacy/compliance tables** (Workstream B):
- `consent_log` — append-only ePrivacy/GDPR-Art.7 record of consent decisions. Keyed on `anonId` (`markoto-anon` cookie) plus optional `userId`. Since `CONSENT_VERSION` 2 the only recordable purpose is `essential` (`server/utils/consentDecisions.ts`; nothing in the UI writes it — there is no banner); rows written under v1 (`analytics`, `session_replay`, never backed by a loaded script) stay as the record, are exported and anonymised on account deletion.
- `abuse_reports` — DSA Article 16 notice-and-action queue. `reporter_user_id` is `ON DELETE SET NULL` so reporter deletion doesn't drop the record (snapshotted `reporter_email` survives for moderator follow-up). `doc_id` is free-form text (no FK) — moderators triage by URL, malformed/missing ids are informational. Status enum: `open` / `acknowledged` / `actioned` / `dismissed`.
- `data_export_jobs` — GDPR Art.15/20 portability worker queue. Statuses: `queued` → `running` → `ready` (S3 zip + 7-day TTL) / `failed` / `expired`. Drained by `dataExportWorker.ts` plugin; expired rows reaped by `dataExportExpirySweep.ts`.

**Account-deletion columns** on `users`: `deletion_requested_at` (grace-period start) + `deletion_grace_until` (30-day deadline the sweep scans for). Cancelling the request nulls both. The hard-purge runs in `accountDeletionExecute.ts`, kicked by `accountDeletionSweep.ts`.

**Policy-acceptance columns** on `users`: per-document `*_version_accepted` + `*_locale` pairs for privacy / tos / dpa. The Onboarding Gate writes the first three on signup; the DPA-acceptance modal writes its row only when the user is about to own a workspace (B2B-only document). When `versions.ts` bumps a version, users with stale `_version_accepted` see a re-acceptance modal on next visit. See `server/legal/AGENTS.md` + `app/components/legal/AGENTS.md`.

**Audit-log actions** (privacy-relevant additions): `account.deletion.requested` / `.cancelled` / `.executed`, `consent.given` / `.withdrawn`, `abuse.reported` / `.actioned`, `policy.accepted`, `admin.granted` / `.revoked`. Defined in `server/legal/auditActions.ts`. IPs stored truncated (/24 IPv4, /48 IPv6) via `truncateIp`.

---

## 4. Security

**Authentication:** OAuth via `nuxt-auth-utils` (HTTP-only `SameSite=Lax` session cookie — not Strict: the OAuth callback is a cross-site redirect, and Strict would drop the session on the redirect after sign-in) plus an Origin / `Sec-Fetch-Site` check on every state-changing `/api` request (`server/middleware/csrf.ts`; webhooks + internal shared-secret routes exempt; 403 `csrf/origin-mismatch`). `SESSION_VERSION` invalidation. Per-user session epoch makes cookies revocable ("log out everywhere"); account deletion, data-export requests and BYOK key changes need a sign-in ≤ 12 h old (401 `auth/reauth-required`). Metadata of docs the caller can't open (`/meta`, denied `/token`) is never returned. Hocuspocus always requires valid JWT with doc-scoped claims (Phase 1). `JWT_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET`, `STRIPE_*` fail-fast on missing.

**Tier-1 hardening (Phase 9):** Postgres TLS via `PGSSL` / `PGSSLROOTCERT` env vars + `resolvePostgresSsl()` (fail-loud at boot if cert path unreadable); Valkey password + optional TLS; security headers via Traefik labels in `docker-compose.prod.yml` (CSP + CORP come from the app, see below); secrets-rotation playbook in `docs/SECRETS-ROTATION.md`; storage-at-rest encryption assumed at the OVH platform layer. See `docs/SECURITY-HARDENING.md`.

**Content-Security-Policy + preview isolation (security batch B5):** the app sets the CSP itself on every response of the production build (`server/plugins/csp.ts`, builders in `server/utils/csp.ts`; Traefik carries NO CSP label — it would be enforced on top) with a per-response nonce stamped on Nuxt's inline scripts. `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'` — no `'unsafe-inline'`, no `'unsafe-eval'`, no third-party host in any directive (`style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`); `style-src` keeps `'unsafe-inline'` (Nuxt UI tokens, KaTeX/paged.js inline styles). **Third-party browser assets are self-hosted** under `/vendor/` (`shared/utils/vendorAssets.ts`): `modules/vendor-assets.ts` copies paged.js, Mermaid, the KaTeX stylesheet + woff2 fonts, the highlight.js themes and the 23 Fontsource web fonts (woff2, unicode-range subsets, one stylesheet per family — `shared/utils/themeFonts.ts`) out of the pinned npm packages at every `nuxt dev`/`build`/`prepare` (into `node_modules/.cache/markoto-vendor-assets`, served as a Nitro public-asset dir); versioned paths, `immutable`; the build fails when an installed package's version/bytes differ from the version + SRI constants in `shared/utils/*Assets.ts` (`tests/unit/vendorAssets.test.ts` pins the same). Scripts/stylesheets stay SRI-locked. `@nuxt/fonts` is off (`ui.fonts: false`) — it fetched Google Fonts at build time. Same policy on hosted, self-host, local and the test stacks; `nuxt dev` sends none. The live preview + browser print iframes are sandboxed `allow-scripts` (print `+ allow-modals`) WITHOUT `allow-same-origin` — opaque origin, typed postMessage protocol (`app/utils/previewFrame.ts`), images via a 15-min doc-scoped `file-access` JWT (`GET /api/docs/:docId/file-token`; only `/api/files` accepts that scope, and `/api/files` + the bundled `/markoto-logos/*` cover marks + `/vendor/*` answer with `Cross-Origin-Resource-Policy: cross-origin`, everything else `same-site`; `/vendor/*` also sends `Access-Control-Allow-Origin: *` since fonts and the SRI tags load in CORS mode, `server/utils/vendorAssetHeaders.ts`; Chromium exempts plain `localhost`, so test this on a real host name). Pinned by `tests/unit/csp.test.ts`, `tests/unit/pagedPreviewIframe.test.ts`, `tests/nuxt/previewFrame.test.ts`, `tests/e2e/flows/preview-isolation.spec.ts`. See `docs/SECURITY-HARDENING.md` §A + `app/utils/AGENTS.md`.

**Rate limits:**

| What | Limit |
|---|---|
| Doc password verify | 5 per client+docId/min, 30 per docId/min across all clients, and 30 FAILED attempts per docId/hour lock the doc's password check (`server/utils/docPasswordLimits.ts`). Verify only works while the doc is `password-protected`; min length 8 when setting (older shorter passwords keep working) |
| Token endpoint | 30 per IP/min |
| Import | 10 per IP/min |
| PDF download | 10 per IP/min (`server/api/docs/[docId]/pdf.get.ts`) |
| Preview image token (`GET /api/docs/:id/file-token`) | 60 per IP/min |
| Anonymous doc creation | 10 per client key/hour + 30/day (IPv4 or IPv6 /64; `shared/config/anonLimits.ts`), on top of the anonymous gate (terms + ALTCHA, below); logged-in creation exempt — `server/api/docs.post.ts` |
| Anonymous gate challenge (`GET /api/anon-gate/challenge`) | 60 per client key/min (each costs one PBKDF2 derivation) |
| Billing checkout / portal | 10 per user/min each (`server/api/billing/{checkout,portal}.post.ts`) |
| Abuse reports | signed in: 10 per user/hour; anonymous: 5 per client key/hour + 20/day plus a fresh ALTCHA solution (`server/api/abuse-reports.post.ts`) |
| Cookie consent (`POST /api/consent`) | 20 per IP/10 min; ≤10 decisions per request, deduplicated to one row per purpose |
| Waitlist sign-up | 5 per IP/hour (429); 3 confirmation emails per address/24 h (silently skipped — same 202, no oracle); confirm/unsubscribe 30 per IP/10 min |
| AI calls (all billable surfaces) | per-user LiteLLM virtual key: tiered `max_budget` + `rpm_limit: 60`, set at key creation (`server/utils/litellm/userKeys.ts`). Replaced the legacy app-side AI-prompt/transcribe limits (Phase 6). Free tier with `NUXT_FREE_TIER_TOTAL_BUDGET_USD`: every free key is also in the LiteLLM team `markoto-free-tier`, whose `max_budget` caps all free users' platform-paid AI together per month (hosted: $500) → 402 `ai/free-allowance-exhausted` |
| Live dictation | 1 session/user (Valkey `SET NX`), 10 min/session hard cap, 30s idle timeout. No daily audio cap — spend is gated by the LiteLLM budget |
| Hocuspocus | 20 connections/IP (released on every socket close, incl. failed auth), 5000 rooms; per client update: 17 MiB WS frame / 16 MiB update / 16 MiB encoded document (`SYNC_MAX_{MESSAGE,UPDATE,DOCUMENT}_BYTES`; deletions always pass), ymeta writes validated like `PUT /meta`; messages queued before a document authenticates: 32 MiB/socket, 256 MiB/process, auth frame within 15 s (`SYNC_MAX_PREAUTH_BYTES`, `SYNC_MAX_PREAUTH_TOTAL_BYTES`, `SYNC_AUTH_TIMEOUT_MS`); read-only connections can't send stateless messages — see `sync-server/AGENTS.md` |
| Web tools (`web_search` Staan + `fetch_url` Jina Reader) | platform-paid upstream call, so per-user and shared by the editor AI + MCP: 30/hour and 100/day by default (`NUXT_WEB_TOOLS_{HOURLY,DAILY}_LIMIT`, `0` = unlimited), 429 `ai/web-tools-rate-limited`; fail OPEN on Valkey error (`server/utils/webTools.ts`). Tools not offered without `STAAN_API_KEY` / `JINA_AI_API_KEY` |
| Workspace invites | 20/hour per admin + 30/hour per workspace (429), ≤50 open invites per workspace (409 `workspace/invite-cap`), ≤3 invite emails per address per day (silently skipped); invite-link accept 20/user/10 min |
| Log out everywhere | 10/user/hour |
| Knowledge upload | 30 presign-requests/user/min |
| Knowledge files per user (across all workspaces) | tiered free/pro/max/ultra defaults: 5 / 50 / 500 / 2000 (`shared/config/tiers.ts`; every tier cap is overridable at runtime via `TIER_*` env vars — resolved by `server/utils/tierConfig.ts#getTiers()`, served to the client by `GET /api/billing/tiers`) |
| Knowledge bytes per workspace | tiered: 50 MB / 2 GB / 1 GB / 1 GB |
| Knowledge bytes per user (across all workspaces) | tiered: 50 MB / 2 GB / 10 GB / 50 GB |
| Knowledge — per file | 25 MB, 300-chunk ceiling (sentinel-truncated) — platform limits in `shared/config/tiers.ts` |
| Knowledge pending uploads | Valkey inflight slots (180 s TTL): per workspace (`cap − count`), per user, and per member of a workspace at most half the workspace's free slots (`memberShareOfWorkspaceSlots`), so one editor can't block the others |
| Image uploads (doc images) | 60 requests + 60 confirms /user/min; 10 MB per file |
| Image bytes per user (all docs) | tiered: 100 MB / 2 GB / 10 GB / 50 GB (`imageBytesPerUser`, `TIER_<PLAN>_IMAGE_BYTES_PER_USER`). Counts pending + confirmed `uploads` rows: own uploads, AI-generated images, and copies made by duplicating a doc (attributed to the duplicator). Reserved atomically at request (`reservePendingUpload`: per-user advisory lock + sum + insert), re-checked at confirm; 409 `upload/storage-quota` + `messageKey: image.storageQuotaReached`. Usage on the profile page (`/api/user/billing` → `imageBytesUsed`) |
| AI agentic loop | per-tool call-count caps + per-session interaction cap (50); cross-document / knowledge / web tools need the invoker's confirmation once the session has read other people's text (`server/utils/agentic/crossBoundary.ts`) |
| MCP (`/mcp`) | PAT required (403 otherwise, no session); 300 requests/client/min, 240/token/min, 60 new sessions/user/hour (≤20 usable at once, least recently used dropped), 120 tool calls/user/min, sessions bound to their token; render tools share the PDF allowance; `generate_image` 20/user/hour (`server/mcp/lib/mcpGate.ts`) |
| Workspaces owned per user | tiered: 1 / 10 / 30 / 100 (invited workspaces don't count) |

**Client keys:** IP-keyed limits use `getClientRateLimitKey(event)` — the IPv4 address or the IPv6 **/64** (a single subscriber controls a whole /64, so full-address keys would be unlimited buckets). **Atomic:** `checkRateLimit`, `consumeRateLimitBudget` and `reserveInflightSlot` are single Lua scripts in Valkey, so a concurrent burst can't overshoot (pinned against the real Valkey container in `tests/repos/rateLimitAtomic.test.ts`).

Valkey-backed rate limits are bypassed under test mode — `TEST_MODE=1` on an instance that does NOT look like a real deployment (`shared/utils/testMode.ts`: a non-loopback `NUXT_SITE_URL` disables it, and boot refuses to start with `TEST_MODE=1` on such an instance). `TEST_ENFORCE_RATE_LIMITS` (comma-separated namespaces or `*`, honoured only while test mode is active — it can only make an instance stricter) re-enables chosen limits: the integration suite's billing-off server enforces every MCP namespace so `tests/integration/mcp/rateLimits.test.ts` drives the real limits (`isRateLimitBypassed`).

**Rate-limit fail mode:** Valkey-backed limits fail OPEN on Valkey errors (DoS protection, not correctness). Single-session locks + pending-upload claims (live dictation, knowledge confirm) fail CLOSED (correctness; failing open would double-bill or duplicate state).

**BYOK provider URLs (SSRF):** user-supplied AI provider base URLs are checked by `server/utils/aiProviders/urlPolicy.ts` at save time AND on every request: no internal service hostnames (lowercased, trailing dots stripped; the list + the LiteLLM regex are pinned against every compose service/container/alias name by `tests/unit/internalHostnames.test.ts`), never loopback / link-local / metadata / reserved, private ranges only with `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true`, plain http only to private addresses, optional allowlist (`NUXT_AI_BYOK_ALLOWED_BASE_URLS`; REQUIRED at boot when `NUXT_LEGAL_SURFACES_ENABLED=true`, and prod compose has no empty fallback). IP classification parses addresses into bytes (`urlGuard.classifyIp`: IPv4-mapped/compatible/NAT64/6to4 judged by the embedded IPv4, Teredo refused). LiteLLM v1.106.4 does not DNS-check a clientside `api_base`, so the app check is authoritative (the `byok/*` regex in `infra/litellm/config.yaml` is defence in depth). LiteLLM must never follow redirects: `infra/litellm/custom_handlers.py` sets `litellm.client_session`/`aclient_session` with `follow_redirects=False` (else a public provider host can 302/307 the proxy to internal services — `tests/integration/endpoints/byokRedirect.test.ts`). BYOK errors shown to users are fixed sentences (`providerErrorMessage`), never upstream text.

**App-side outbound fetches of user/AI URLs** (`view_image`, image URLs from `fetch_url` / BYOK image responses) go through `server/utils/safeFetch.ts`: resolve once, every answer public, dial the checked IP with `Host` + `tls.serverName` (Bun), manual redirects with a re-check per hop (max 3), byte-capped body. `fetch_url` forwards the parsed `URL#href` (≤ 2000 chars) to Jina, never the raw string. Provider keys are AES-256-GCM-encrypted, never returned to the client, never logged (errors pass through `redactSecret`), never exported. Saving/verifying is rate-limited (20 / 10 min / user) and audited (`ai_provider.saved` / `.deleted`).

**Input validation:** `meta.put` validates title (≤255), accessMode (enum), wordCount (0–10M), sizeBytes (0–100M), theme (structural + numeric ranges + hex-color regex + font allowlist + `customCss` ≤ 64 KB through the css-tree sanitizer `shared/utils/customCss.ts` — at-rule allowlist, `url()` only to this doc's uploads / raster `data:image`, no `@import`/`@font-face`/`expression()`/`javascript:`; 400 `theme/custom-css-invalid` with line/column; re-sanitized at every render because Y.js writes bypass the endpoint). Image uploads: PNG/JPEG/GIF/WebP (no SVG), 10MB, stored type + size + magic-byte sniff at confirm. Imports: extension whitelist, 50MB file; request bodies are capped at 51 MiB for EVERY route by Bun itself (`maxRequestBodySize` in the custom production entry `server/runtime/bunEntry.ts`, wired via the `nitro:init` hook in `nuxt.config.ts` — the bun preset entry buffers every body before routing, so handlers can't refuse in time; override `NITRO_MAX_REQUEST_BODY_BYTES`), plus Traefik `buffering.maxRequestBodyBytes` on the `/api/import` router in prod + self-host and `readBodyWithLimit` in the handler, 75 s fetch timeout to markitdown; markitdown refuses zip archives that inflate past 200 MB / 10k entries / 100:1 and converts in a memory- and time-capped child process (`markitdown-server/server.py`). Knowledge uploads: extension allowlist + signed type + stored-type check + magic-byte sniff at confirm.

**File access:** `/api/files/:docId/:fileId` checks access mode before presigning. Presigned URL TTL: 120s upload, 120s read (can't be revoked; short to survive access-mode/password/deletion changes). The 302s from `/api/files`, the PDF download and the data-export download carry `Cache-Control: private, no-store` (`server/utils/privateRedirect.ts`); the PDF + export presigned GETs set the same `response-cache-control`. **Confirmed uploads are immutable:** every presigned PUT (images AND knowledge) writes a staging key (`…/staging/{file}`, `stagingKeyFor`); confirm checks the stored type + size, copies to the final key, deletes the staging key and sniffs the COPY — a re-used URL can only rewrite the staging key. Both PUTs sign `content-type`. **Knowledge originals are never served back** — deleted from S3 after successful processing; only `markdown_cache` + embedded chunks remain.

**Storage clean-up:** `orphan-cleanup` (hourly) reaps unconfirmed image rows + objects (final + staging) after 24 h, untracked objects under live `docs/{id}/`, whole prefixes of deleted docs, and knowledge objects (final or staging) older than 1 h with no `workspace_knowledge` row (`knowledgeOrphanSweep.ts`). `image-gc` (every 6 h) deletes confirmed images referenced nowhere for `NUXT_IMAGE_GC_RETENTION_DAYS` (default 30, `0` = off) — safety rules in `server/utils/imageGc.ts`.

**S3 bucket policy (prod deployment requirement):** the production S3 bucket MUST deny public `ListBucket`. Our code never issues a presigned GET for knowledge keys, but if the bucket is list-enabled an attacker who guesses one `workspaces/{wsId}/knowledge/` prefix could enumerate by key. OVH defaults buckets to private; verify with `aws s3api get-bucket-acl --bucket $BUCKET` post-deploy.

**Mid-session membership drift:** see `server/utils/AGENTS.md` (knowledge tools re-check role per invocation). Documents themselves rely on the Hocuspocus JWT expiring for revocation — accepted tradeoff (≤2 h).

**Stripe webhook security:** signature-verified per request; event IDs deduplicated via `processed_webhook_events`; out-of-order events stashed and re-applied. See `server/utils/stripeWebhook.ts`.

**Other:** scrypt password hashing, 2h password token expiry, `html: false` + DOMPurify for XSS, gitleaks history scan in CI.

**Error sanitisation:** `nuxt.config.ts` wires `nitro.errorHandler: '~~/server/error.ts'`. The handler exports `buildSanitizedErrorPayload(error, url)`: 4xx pass through (preserve `message` + `data` so `code: 'abuse/rate-limited'`-style hints reach the client); 5xx are stripped to `'Something went wrong on our side. Please try again — we\'ve been notified.'` + `data: { code: 'internal' }`. Stack traces never appear in the response. Drove this after a Drizzle error message containing the SQL + bound params (incl. an email) was rendered into a 500 response — a per-endpoint try/catch sweep would have left a blast-radius gap, the framework-level handler closes it for every present + future route.

**Privacy / GDPR posture (Workstream B):**
- **EU-only data path.** Operating entity is **LatentSpace Labs GmbH (Zurich, Switzerland)**, recognised as adequate under GDPR. Sub-processors all sit in EU regions OR Data Privacy Framework (registry: `server/legal/subProcessors.ts`): OVHcloud (`intra_eu`) for Managed Postgres + Object Storage; Mistral AI SAS (`intra_eu`) for text generation + Voxtral voice transcription; Jina AI GmbH (`intra_eu`) for embeddings + fetch-URL page extraction (Jina Reader); Staan / European Search Perspective SAS (`intra_eu`) for AI web search; Black Forest Labs GmbH (`intra_eu`) for image generation (EU-pinned FLUX.2); Stripe (DPF + SCC fallback) for billing; Resend (DPF + SCC fallback) for transactional email; Sentry (DPF + SCC fallback; data at rest in the Frankfurt EU region) for telemetry; Google LLC and GitHub, Inc. (both DPF + SCC fallback) for **OAuth sign-in only** — no other Google/GitHub data flows. **No PostHog** — its EU residency story doesn't match our stance.
- **Lawful basis ledger.** Every processing purpose (auth, doc storage, AI inference, billing, abuse triage, etc.) is keyed in `server/legal/lawfulBasis.ts` with `{basis, dataCategories, retention, subProcessors}`. New features that touch personal data MUST be added; the privacy page renders this list verbatim, so adding code without adding a registry entry produces a visible doc gap.
- **IP pseudonymisation.** All audit + abuse-report writes go through `truncateIp(ip)` (/24 IPv4, /48 IPv6). The raw IP never reaches the DB.
- **Right-to-erasure pipeline.** `requestAccountDeletion` flips the user into the 30-day grace period; `accountDeletionExecute.ts` runs the 10-step purge (Stripe customer, S3 keys, owned docs, sole-member workspaces, Y.js state, AI sessions, comments anonymised on others' docs, Activity Log rows detached AND their `user_name` snapshot cleared so the feed shows "Anonymous", audit attribution nulled via FK). `accountDeletionSweep.ts` claims rows past the deadline. Cancelling the request restores all state.
- **Right-to-portability.** `data_export_jobs` queue → `dataExportWorker.ts` builds a 13-entry zip (profile, workspaces, docs incl. Y.js reconstruction, comments, activity, audit excerpts, knowledge metadata, billing snapshot, consent log, abuse reports the user filed with the notices sent to them, statements of reasons received as a document owner). Files served via 7-day-TTL presigned GET; rows reaped by `dataExportExpirySweep.ts`.
- **Essential storage only, no cookie banner.** markoto loads no analytics, session replay or ad script; the only browser storage is strictly necessary (session, locale, anonymous-doc creator key, anonymous terms acceptance `markoto-anon-terms`, colour mode, pending invite, PWA cache — listed in privacy §9), which ePrivacy Art.5(3) exempts from consent and Swiss FMG Art.45c only requires us to disclose. The footer shows a "Cookies: essential only" note linking to the privacy policy. Adding non-essential storage means: a consent purpose in `server/utils/consentDecisions.ts` (+ `OPTIONAL_CONSENT_PURPOSES`), a `CONSENT_VERSION` bump, a `lawfulBasis.ts` purpose, and a new banner (equal-prominence Reject/Accept).
- **Hosted-only surfaces.** The onboarding gate, DPA step, `/legal/*` pages + footer links exist only with `NUXT_LEGAL_SURFACES_ENABLED=true` (hosted SaaS). Code default is off (self-hosters are their own operator; the bundled texts name LatentSpace Labs). Server: `server/utils/instanceConfig.ts` (`legalSurfacesEnabled()`, `assertLegalSurfacesEnabled()` → 404 `legal/disabled`, `abuseNotificationRecipient()`); client: `useInstanceConfig()`, `app/middleware/legal-surfaces.ts`.
- **Onboarding gate.** New accounts must accept Privacy + ToS + confirm age ≥16 (GDPR Art.8 child-consent floor) before the app shell mounts. The gate is exempt on `/legal/*` routes (chicken-and-egg: users must be able to read what they're accepting). `OnboardingGate.vue` blocks the app shell. Enforced server-side too: `server/middleware/onboarding.ts` answers 403 `onboarding/required` to every state-changing `/api` call (incl. AI) of a signed-in user without current acceptance; exempt: onboarding accept, logout, consent, account deletion + cancel, data export, waitlist confirm/unsubscribe, webhooks/internal. No-op with legal surfaces off.
- **DPA acceptance is workspace-owner-only.** Casual document users never see a DPA modal. The acceptance modal is gated on "user is about to own a workspace"; the profile page shows "Required when you create a workspace" for users who haven't crossed that threshold rather than a red "not accepted" warning.
- **Admin access.** `users.is_admin` column is the authority; `NUXT_ADMIN_USER_EMAILS` env-list is bootstrap-only (case-insensitive, comma-separated, whitespace-tolerant; promoted to a column flag on sign-in via `adminBootstrap.ts`, **verified emails only** — GitHub / Google / OIDC store NULL for unverified addresses, `server/utils/oauthEmail.ts`). Only the column qualifies for `/admin/*` (an env-listed email gets admin at its next sign-in). Granting/revoking admin emits `admin.granted` / `admin.revoked` audit rows.
- **Email infrastructure.** `server/utils/email/sendEmail.ts` wraps Resend with sandbox-sender fallback (`markoto <onboarding@resend.dev>`) when no verified domain is set. `NUXT_EMAIL_PROVIDER=stub` opts out entirely (used in tests + CI). Transactional kinds: `account.deletion.requested`, `account.deletion.executed`, `data.export.ready`, `breach.notification` (re-used as the abuse-report operator notification). Failures are best-effort — the primary state has already committed; a swallowed email error doesn't fail the user's request.

---

## 5. Docker Compose

| File | Scope | TLS | Use |
|---|---|---|---|
| `docker-compose.base.yml` | Shared service shape (postgres, valkey, sync, markitdown, renderer, backup) — pulled in by dev/local/prod via `include:` | — | Not run directly |
| `docker-compose.dev.yml` | Infra only (base + seaweedfs; ports published to host, valkey password fallback) — Nuxt on host | — | Daily dev with HMR |
| `docker-compose.local.yml` | Full stack — base + Traefik + `app` + seaweedfs on the purpose networks (as prod + `storage`) | mkcert on `ypad.127.0.0.1.nip.io` | Pre-push full-stack verification |
| `docker-compose.prod.yml` | Full stack — base + Traefik + ACME + security headers + GHCR images + sticky sessions for sync | Let's Encrypt | VPS deploy |
| `docker-compose.selfhost.yml` | Self-hosted full stack — base + Traefik (one origin: `/` app, `/sync` Hocuspocus, `/<bucket>/` SeaweedFS for presigned browser URLs) + in-stack pgvector Postgres + SeaweedFS (+ `s3-init` bucket one-shot) + GHCR images at `${IMAGE_TAG}`; `backup` behind `COMPOSE_PROFILES=backup`. Overlays: `docker-compose.selfhost.tls.yml` (Let's Encrypt for `MARKOTO_DOMAIN`), `docker-compose.selfhost.build.yml` (build from checkout) | plain HTTP on `${MARKOTO_HTTP_PORT}`, or LE via overlay | `./install.sh` writes `.env` (incl. `COMPOSE_FILE`), then plain `docker compose up -d`. See `docs/SELF-HOSTING.md` |
| `docker-compose.test.yml` | Standalone test infra (+ `--profile flows` for the e2e stack). Does NOT include base — uses `-test`-suffixed services with tmpfs storage | — | `bun run test:integration` / `bun run flows:test` |

Dev/local/prod/selfhost use Compose's `include:` directive to pull in `docker-compose.base.yml`. **Requires Docker Compose ≥ 5.0.0**: each env file redefines services it includes, which Compose 2.24–2.40 reject ("services.X conflicts with imported resource") and v5.0.0 re-allowed (compose-go#835); the GitHub runner's bundled 2.x can't render these files, so CI jobs that need them install a pinned v5 plugin (`selfhost-check`). Each env file then overrides only what's truly env-specific: image vs build, ports vs expose, mem_limit, security headers labels, env-key passthrough. **User commands stay one-flag** — `docker compose -f docker-compose.dev.yml up -d` works as before; the include is transparent. Verified by running `docker compose -f X config` before/after the refactor and getting byte-identical output for all four envs.

**Container + network baseline (B11, `docs/SECURITY-HARDENING.md` §C).** Every service: `cap_drop: [ALL]` + `no-new-privileges`; app / sync / renderer / markitdown / litellm (`65534`) / valkey (`999:1000`) run non-root, and those plus traefik + socket-proxy on a read-only root (tmpfs `/tmp`). Postgres + SeaweedFS keep only `CHOWN DAC_OVERRIDE FOWNER SETGID SETUID` for their entrypoints; prod traefik keeps `DAC_OVERRIDE` while `acme.json` is owner-owned. **Purpose networks** replace the flat `internal` one: `web`/`edge` (traefik, app, sync), `docker-api` (traefik ↔ `socket-proxy`, a read-only `tecnativa/docker-socket-proxy` — Traefik no longer mounts the Docker socket), `data` (postgres, valkey + app, sync, litellm, db-init, backup), `render` (app ↔ renderer, `markoto-app` alias lives here), `import` (app ↔ markitdown), `storage` (self-host/local SeaweedFS + traefik, app, renderer, backup, s3-init; SeaweedFS master/volume/filer bind loopback), `egress` (litellm, backup, prod db-init), `renderer-egress` (renderer only). Internal networks are `internal: true`. **DB roles:** `POSTGRES_USER` = admin (db-init + backup only); `db-init` (replaces `litellm-db-init`, runs `infra/postgres/db-init.sh` on every up) creates `POSTGRES_APP_USER` / `POSTGRES_LITELLM_USER` (each owns one DB, PUBLIC CONNECT revoked, existing objects handed over); compose falls back to `POSTGRES_USER` when unset (hosted: opt-in, `docs/LAUNCH-CHECKLIST.md`; self-host: `install.sh` generates them). The app reads LiteLLM's spend logs as the LiteLLM role (`NUXT_LITELLM_DB_USER/_PASSWORD`, `server/utils/litellm/litellmDb.ts`). **Dev/test/local publish on `127.0.0.1` only**; the test stack's default network has a fixed subnet (`10.213.47.0/24`, `TEST_NETWORK_SUBNET` / `TEST_NETWORK_GATEWAY`) so `fake-openai-test` binds the known gateway for the BYOK URL. `scripts/selfhost-check.sh` asserts all of this (selfhost overlays, prod, local, dev, test). Deploys sync `infra/postgres/db-init.sh` + `renderer/seccomp.json` alongside the compose files.

**Compose merge gotchas baked into the split:**
- `environment:` map-merges per key — base provides the shared keys, overrides add per-env ones.
- `command:`, `volumes:`, `depends_on:`, `networks:` are REPLACED wholesale on merge, not concatenated. `command:` for valkey is redefined in dev to swap `${VALKEY_PASSWORD:?required}` for `${VALKEY_PASSWORD:-devpassword}`.
- `seaweedfs` is defined inline in dev/local (NOT in base) because `include:` has no "drop service" mechanic — putting it in base would leak a phantom seaweedfs + seaweed_data volume into prod, which uses external S3.
- `ports:` and `expose:` are different keys and don't replace each other; the merged result can list both. Harmless.
- **Interpolation of an included file happens on its own, before the merge** — a `${VAR:?required}` in base fails even if the including file overrides that key. Every consumer's `.env` must satisfy base's required vars.

**Self-host shape (WP7).** `install.sh` (repo root, shellcheck-clean, idempotent: never regenerates or prints secrets; refuses a `.env` it didn't write — marker line) asks domain-or-HTTP-port / admin email / optional OAuth + AI keys, generates secrets with `openssl rand`, writes `.env` (0600, single-quoted values) including `COMPOSE_FILE` / `COMPOSE_PROJECT_NAME` / `COMPOSE_PROFILES`, pulls (falls back to building) and waits for the app container to be healthy. Subcommands: `upgrade [--tag]`, `status`, `logs`, `reembed`. Traefik only routes containers labelled `markoto.instance=${MARKOTO_INSTANCE}` (docker-provider constraint), networks are named `<instance>-{edge,data,render,import,storage,docker-api,egress,renderer-egress}`, so several instances (or the dev stack) coexist on one host. Code-level differences are all env: `NUXT_S3_PUBLIC_ENDPOINT` (browser-facing presign host), `NUXT_LEGAL_SURFACES_ENABLED=false`, `NUXT_TRUSTED_PROXY_HOPS`, `NUXT_OAUTH_*_REDIRECT_URL`, roomier `TIER_FREE_*` defaults. `scripts/selfhost-check.sh` (CI job `selfhost-check`) shellchecks `install.sh`, `docker compose config`s every overlay combination and asserts the network/hardening/loopback rules above.

Dev: `bun run dev --host 0.0.0.0` (0.0.0.0 so sync container can reach via `host.docker.internal`). Ports: Postgres 5432, Valkey 6379, SeaweedFS 8333, Hocuspocus 4001, markitdown 8080, renderer 8090. **Postgres image** is `pgvector/pgvector:pg16` everywhere (prod uses OVH managed Postgres; the image is dev/local/test only).

Prod key points: postgres healthcheck gates `app` + `sync` startup; `stop_grace_period: 30s`; Traefik healthcheck labels on `/api/health` + `/health`; sticky sessions on the `sync` service via `traefik.http.services.sync.loadbalancer.sticky.cookie=true`; backup sidecar pipes `pg_dump | gzip | aws s3 cp`; Dockerfile **must `COPY drizzle/`** into runtime image.

Required env (canonical names — see `.env.example`): `DOMAIN`, `ACME_EMAIL`, `REGISTRY`, `IMAGE_TAG`, `POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `NUXT_SESSION_PASSWORD` (≥32), `NUXT_JWT_SECRET` (≥32), `NUXT_INTERNAL_API_SECRET` (≥32), `NUXT_S3_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET}`, `NUXT_MARKITDOWN_URL`, `NUXT_SYNC_INTERNAL_URL`, `NUXT_PUBLIC_SYNC_URL`, `NUXT_LITELLM_URL`, `NUXT_LITELLM_MASTER_KEY`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `JINA_AI_API_KEY`, `MISTRAL_API_KEY`, `BFL_API_KEY`, `BACKUP_INTERVAL_SECONDS`, `BACKUP_RETENTION_COUNT`. Billing mode: `NUXT_BILLING_ENABLED` (default `false`; accepts `1/true/yes/on`) + `NUXT_PLANS_COMING_SOON` (default `false`; hosted free-only SaaS sets `true` for the "coming soon" pricing page + waitlist) — staging/prod render billing OFF + coming-soon ON via `infra/render-env.sh` / `env.j2`. Stripe (`NUXT_STRIPE_SECRET_KEY`, `NUXT_STRIPE_WEBHOOK_SECRET`, `NUXT_STRIPE_PRICE_{PRO,MAX,ULTRA}`) is required **only when `NUXT_BILLING_ENABLED=true`** (boot fails in production without the secret + webhook secret, exactly as before). `NUXT_SITE_URL` (origin for links in emails — never derived from the request Host; **required at boot in production**; prod compose pins `https://${DOMAIN}`). Free-tier limit overrides `TIER_FREE_{LITELLM_BUDGET_USD,WORKSPACES_OWNED,KNOWLEDGE_FILES,KNOWLEDGE_BYTES_PER_WORKSPACE,KNOWLEDGE_BYTES_PER_USER}` are passed through by prod compose — with billing off they ARE every account's limits. Optional pair: `NUXT_OAUTH_GITHUB_CLIENT_*` and/or `NUXT_OAUTH_GOOGLE_CLIENT_*` (the UI offers only configured providers — `shared/config/instance.ts`; none = anonymous-only). Generic OIDC (WP7b, self-host only — prod compose doesn't pass it): `NUXT_OAUTH_OIDC_{ISSUER,CLIENT_ID,CLIENT_SECRET}` (all-or-nothing, https issuer; http only under `TEST_MODE=1`/development), optional `NUXT_OAUTH_OIDC_{NAME,SCOPES,REDIRECT_URL}`; see `server/AGENTS.md` → OIDC. Instance shape: `NUXT_LEGAL_SURFACES_ENABLED` (default `false` = self-host: no onboarding gate / consent banner / DPA step / `/legal/*`; hosted sets `true` via prod compose + `render-env.sh` + `env.j2`), `NUXT_TRUSTED_PROXY_HOPS` (default 1; `server/utils/clientIp.ts`), `NUXT_S3_PUBLIC_ENDPOINT` (optional browser-facing S3 base URL), `NUXT_MARKETING_SITE_ENABLED` (default `false`; hosted `true`: product tour, `/sitemap.xml`, JSON-LD, `marketing-pages` middleware; the former `NUXT_PRODUCT_TOUR_ENABLED` is an alias for one release), `NUXT_DOCS_CANONICAL_BASE` (unset = `https://markoto.app`, empty = self; `/docs/**` canonical off the marketing site), `NUXT_SITE_INDEXABLE` (default `true`; staging renders `false` via `deploy.yml` → robots `Disallow: /` + `X-Robots-Tag: noindex` everywhere), `NUXT_CANONICAL_SITE_URL` (origin for canonical / og:url / JSON-LD / sitemap; empty = `NUXT_SITE_URL`; staging renders `https://markoto.app`). SEO helpers: `app/AGENTS.md` → SEO. Optional Sentry: `NUXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`. Optional sync-server size limits (bytes, empty = defaults 17 MiB / 16 MiB / 16 MiB): `SYNC_MAX_MESSAGE_BYTES`, `SYNC_MAX_UPDATE_BYTES`, `SYNC_MAX_DOCUMENT_BYTES` (passed by `docker-compose.base.yml`). Optional Postgres TLS: `PGSSL` (only honoured value: `disable`), `PGSSLROOTCERT`. Optional: `NUXT_AI_DICTATE_JWT_SECRET` (falls back to `NUXT_JWT_SECRET`). Optional LiteLLM model overrides: `NUXT_LITELLM_{EMBEDDINGS_MODEL,EMBEDDINGS_DIMS,REALTIME_TICK_MODEL}` (the former `NUXT_LITELLM_{TEXT,IMAGE,TRANSCRIBE}_MODEL` are gone — WP4). **Bring-your-own-key AI (WP4):** instance defaults `NUXT_AI_DEFAULT_{CHAT,IMAGE,TRANSCRIBE}_{MODEL,BASE_URL,API_KEY}` + `NUXT_AI_DEFAULT_CHAT_VISION` (MODEL alone = a LiteLLM alias, platform-paid; MODEL + BASE_URL + API_KEY = OpenAI-compatible endpoint used like a user key; the hosted SaaS renders `NUXT_AI_DEFAULT_CHAT_MODEL=zai-glm-5-3-flash` + `_VISION=true` and no image / transcription default), `NUXT_FREE_TIER_TOTAL_BUDGET_USD` (global monthly ceiling on free-tier platform-paid AI; hosted 500, empty / 0 = none), `NUXT_AI_BYOK_ALLOWED_BASE_URLS` (provider allowlist; empty = any public URL; staging/prod render the SaaS list), `NUXT_AI_BYOK_ALLOW_PRIVATE_URLS` (self-host opt-in for Ollama/vLLM, default `false`), `NUXT_AI_REALTIME_MODEL`; the app also takes `MISTRAL_API_KEY` (live dictation on an alias default only). See `docs/AI-MODELS.md#bring-your-own-key`. Self-hosted embeddings (hosted keeps the Jina default, not user-overridable): `NUXT_LITELLM_EMBEDDINGS_MODEL=custom-embeddings` + `NUXT_LITELLM_EMBEDDINGS_DIMS` (≤2000) + LiteLLM-side `EMBEDDINGS_UPSTREAM_{MODEL,API_BASE,API_KEY}` (all three must be defined — compose defaults them), optional `NUXT_LITELLM_EMBEDDINGS_{SEND_DIMENSIONS,TASK_HINTS}` (`auto|true|false`); see `docs/AI-MODELS.md#embeddings`. Compose substitutions use `${VAR:?required}`. Testing: `TEST_MODE=1` enables the in-process fakes (canned-fake STT, `/api/_test/login` shim), the rate-limit bypass, and skips the boot-time secret validator — only when `NUXT_SITE_URL` is empty or loopback (`isTestModeEnabled`); with a real site URL the app refuses to boot; `LITELLM_TEST_STUB=1` short-circuits per-user key creation for the unit/repos test tier (integration tests run against a real `litellm-test` container).

---

## 6. Project Structure

`app/` — Vue frontend. See `app/AGENTS.md` for details. Top-level dirs: `components/{auth,editor,preview,collab,ai,sharing,document,workspace,comments,common,content}/`, `composables/`, `pages/` (index, `d/[id]`, `w/[id]`, `pricing`), `utils/`, `layouts/`, `plugins/`.

`server/` — Nitro API + sync notification layer. See `server/AGENTS.md`. Top-level dirs: `routes/`, `api/`, `db/`, `middleware/`, `plugins/`, `repos/` (incl. `audit.ts`, `accountDeletionRepo.ts`, `dataExportJobs.ts`), `utils/` (incl. `audit.ts` is in repos; `stripeWebhook.ts`, `webhookEventSweep.ts`, `sweepLock.ts`, `idempotency.ts`, `healthProbes.ts`, `traceHeaders.ts`, `renderClient.ts`, `billing.ts`, `planLapseSweep.ts`, `accountDeletion.ts`/`accountDeletionPlan.ts`/`accountDeletionExecute.ts`/`accountDeletionSweep.ts`, `dataExport.ts`/`dataExportWorker.ts`/`dataExportExpirySweep.ts`, `adminAccess.ts`/`adminBootstrap.ts`, `email/sendEmail.ts` in utils), `legal/` (lawful-basis + sub-processors + audit-action registries; see `server/legal/AGENTS.md`), and `error.ts` (Nitro `errorHandler`).

`sync-server/src/` — Hocuspocus standalone container. Per-doc state in Valkey via `sync-state.ts` + `valkey.ts`. See `sync-server/AGENTS.md`.

`renderer/` — Playwright PDF + PNG sidecar. Internal-only.

`shared/` — Cross-cutting types + utilities used by both client and server. `types/` (theme, auth, pagedjs), `utils/` (themeToCss, themeValidation, themePresets, themeFonts, defaultTheme, postgresSsl, `*Assets.ts` vendored-asset version + SRI pins), `audiences/` (6-audience enum + tone fragments), `languages/` (presets + Intl.DisplayNames helper), `templates/` (registry; see `shared/templates/AGENTS.md`), `legal/` (`versions.ts` for policy/consent version registry, `entity.ts` for the operating-entity resolver — both client-and-server-safe).

`content/legal/` — markdown source for the rendered `/legal/*` pages. One sub-dir per document (`privacy/`, `terms/`, `dpa/`, `abuse-policy/`) with one file per locale (`en.md` authoritative, `fr.md` / `de.md` / `es.md` translations) plus `_meta.json`. Translations show a "viewing translation, English authoritative" notice. See `content/legal/_README.md`.

`infra/` — Ansible. `playbooks/` (provision, deploy, rollback, backup-test), `roles/` (base, ssh_hardening, markoto, backup_cron), `group_vars/`, `templates/`, `requirements.yml` (Galaxy), `Makefile` (common targets), `README.md`. See `docs/DEPLOY-OVH.md` + `docs/RUNBOOK.md`.

`.github/workflows/` — `ci.yml`, `release.yml`, `staging-gate.yml`, `deploy.yml`, `sonar.yml`. PR-title-as-release-name flow; one labeled PR = one release (releases are opt-in). See `docs/RELEASE-PROCESS.md` + `docs/GITHUB-CONFIG.md`.

`drizzle/` — generated migrations + meta snapshots (committed). `i18n/locales/` — en/de/fr/es/ja/zh JSON.

`docs/` — `DEPLOY.md`, `DEPLOY-OVH.md`, `LOCAL.md`, `S3-SETUP.md`, `OBSERVABILITY.md`, `SECRETS-ROTATION.md`, `SECURITY-HARDENING.md`, `RELEASE-PROCESS.md`, `RUNBOOK.md`, `GITHUB-CONFIG.md`, `CHEATSHEET.md`.

`scripts/` — standalone Bun scripts. `audit-markdown-pipeline.mjs` runs the full markdown-it + plugins + DOMPurify chain. `flows-ephemeral.ts` orchestrates the flow-test ephemeral stack. `build-flows.ts` publishes Playwright flow output to `public/flows/`.

`tests/` — `unit/` (pure functions, no Nuxt), `dom/` (happy-dom), `nuxt/` (composables + components in Nuxt env), `repos/` (DB-backed), `integration/` (REST + sync, opt-in), `e2e/` (Playwright flow tests; see `tests/e2e/AGENTS.md`).

`content/docs/` + `app/layouts/docs.vue` + `app/pages/docs/` + `app/components/content/{Flow,FlowFrame}.vue` — the docs site that consumes the flows. See `tests/e2e/AGENTS.md`.

---

## 7. Shipped Features (manifest)

For per-feature deep-dive, follow the sub-AGENTS.md links. List form, not essays.

- **Infrastructure & ops:** Compose stack (`include:`-based), Drizzle + versioned migrations at boot, y-postgresql persistence, S3 singleton, Markitdown service, Playwright renderer sidecar, daily pg backup sidecar, Sentry observability, throttled-Sentry wrapper, Valkey rate limiting + session locks, dual-secret rotation, inactive doc sweep, PWA. Ansible-driven prod deploy + rollback (Phase 10–11). CI/CD release pipeline + Apprise/Telegram notifications + OS update automation (Phase 12). actionlint + gitleaks + ansible-lint + yamllint CI gates (Phase 13). Make targets + `docs/CHEATSHEET.md` (Phase 14).
- **Auth & editor:** GitHub + Google OAuth, generic OpenID Connect sign-in for self-hosted IdPs (WP7b), `SESSION_VERSION` invalidation, anonymous doc creation, CodeMirror 6 + yCollab, split editor/preview, formatting toolbar + status bar, welcome doc, i18n (en complete; others scaffolded). Cookie hardening (Phase 6). See `server/AGENTS.md`.
- **Collaboration:** Awareness (names/colors/avatars), PresenceBar (deduped multi-tab), Y.js title sync, share modal with access-mode selector, scrypt password protection (3-layer), comments panel + `@ai` mention trigger, **Activity Log Tier 1 + 2** (see `app/components/collab/AGENTS.md`).
- **Multi-instance hardening (Phase 3–4):** Valkey-backed per-doc sync state (attribution + diff baselines), sticky sessions at Traefik for sync, advisory-locked sweepers (`sweepLock.ts`), idempotency keys (`idempotency.ts`), partial unique index on `activity_log(doc_id, yjs_doc_id_after) WHERE action IN ('edit', 'title.changed', 'theme.changed')` for cross-instance dedup, frontend version-skew detection (Phase 5–6).
- **Files & import/export:** Presigned upload flow + DB tracking, drag-drop + paste upload, markitdown import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), client-side `.md` download, server-rendered PDF via the Playwright sidecar (with browser-side paged.js + `window.print()` as a fallback path).
- **Preview & PDF:** paged.js pivot (A4/Letter pages, header/footer, footnotes via `float: footnote`), single `themeToCss()` for preview + print, iframe isolation, responsive page zoom, `Cmd/Ctrl+P` hijack, dark mode chrome. See `app/utils/AGENTS.md`.
- **Theme system:** Per-doc JSONB + `ymeta.theme` live broadcast, server validation, `ThemeEditorPanel.vue` (16 sections), 8 built-in presets (incl. markoto), self-hosted font picker (Fontsource + bundled TeX Gyre Termes/Heros + Latin Modern Roman/Mono, GUST licence, `fonts/`), TOC controls, mermaid theme picker, header/footer token chips, cover-page redesign, user-saved theme presets + workspace default theme, **custom CSS** (`theme.customCss`, documents only, css-tree sanitizer at write + render time). **Heading scale rule:** h4 = body, h1 = body·`headings.scale`³ (presets 1.6–2.2× body; display sizes only on the cover). Optional fields resolved via `shared/utils/themeOptions.ts` (stored themes without them stay valid): `headings.numbering` (1 / 1.1 / 1.1.1, also in the TOC), `code.{font,background,frame,wrap,lineNumbers}` + fence titles (```` ```ts title="x.ts" ````), `cover.layout: 'title-block'` (paper page 1: title, authors + `cover.affiliations`, date, and the doc's leading "Abstract" section) + `cover.{rules,smallCaps}`; page size A5. Review with `make theme-shots`. See `app/utils/AGENTS.md`.
- **Markdown extensions:** Batch 1 (typography), Batch 2 (katex + alerts), Batch 3 (anchor + TOC + Mermaid), pagebreak + comments. See `app/utils/AGENTS.md`.
- **Editor chrome:** Google-Docs-style menu bar, table size picker, diagram/alert/math dropdowns, right sidebar (Activity / Theme / Document / Knowledge), view-mode toggle, `DeleteConfirmModal`. Mobile-first redesign — bottom sheets, format bar, view-mode bar, voice + comment popups (Phase 14 mobile sprint).
- **Workspaces:** Three-role model, invite-by-email as a pending invitation the invitee accepts (dashboard or emailed link), last-admin invariant, cascade delete, role-gated UI at `/w/:id`. See `server/AGENTS.md`.
- **Document context + new-doc dialog + templates:** description / audience / language / templateId fields injected into every AI prompt; multi-language template skeletons. See `app/components/document/AGENTS.md` and `shared/templates/AGENTS.md`.
- **Document duplication:** `POST /api/docs/:id/duplicate` clones row + Y.js state with URL rewrite + S3 assets. See `server/utils/duplicateDocument.ts`.
- **Workspace knowledge base:** PDF/DOCX/PPTX/XLSX/HTML/EPUB/MD/TXT upload → markitdown → chunked → embedded → pgvector + tsvector hybrid search. See `server/utils/AGENTS.md`.
- **AI:** **Bring your own key (WP4)** — per-user OpenAI-compatible providers for chat / image / transcription (`user_ai_providers`, `/settings/ai`, `/api/user/ai-providers`, `/api/ai/availability`), instance defaults via `NUXT_AI_DEFAULT_*`, SSRF policy + verification on save, zero-cost `byok/*` LiteLLM deployment, AI entry points show an "Add your API key" CTA when no chat provider; the providers named below are the bundled operator defaults. **Free AI allowance (hosted):** chat default `zai-glm-5-3-flash` (GLM-5.3 Flash on Mistral's EU endpoint, fallback `mistral-small-2603`), $0.50/user + $500 total per month via per-key + LiteLLM-team budgets (`freeTierTeam.ts`, `keyReconcile.ts`), `ai/free-allowance-exhausted` + "add your own key" UI. 27 always-on tools + 2 workspace-gated knowledge tools (doc/theme/web/render + comment + cross-doc + theme-inspection/preset tools), `@ai` comment trigger, voice input, live dictation. **Taint + confirm:** once a session has read text someone else wrote, cross-document / knowledge / web tools wait for the invoker's Allow in the prompt bar; the prompt, status text and answers reach the invoker only (session channel, not awareness). Providers: **Mistral Small 4.0** (text + vision), **Voxtral Mini Transcribe + Voxtral Realtime** (one-shot + live dictation), **Jina v5-text-nano** (embeddings) + **Jina Reader** (`fetch_url` page extraction), **Staan** (European Search Perspective SAS — `web_search`), **BFL FLUX.2 [pro] EU-pinned** (image generation) — all routed via the self-hosted **LiteLLM proxy**. **Per-tool call-count caps + per-session interaction cap (50)** in `runLoop.ts` (Phase 2 — protects against cost-amplifying outliers). See `server/utils/agentic/AGENTS.md`.
- **MCP server:** external MCP clients (Claude Desktop, Cursor, scripts) call `/mcp` with long-lived Personal Access Tokens (SHA-256-hashed at rest, `mcp_personal_tokens` + `mcp_sessions` tables), scoped tool wrappers over the document/knowledge/web surfaces, YDocPool + agent attribution chain. See `server/mcp/AGENTS.md`.
- **Billing mode + waitlist (WP3):** `NUXT_BILLING_ENABLED` off by default (self-hosted + free-only SaaS), `NUXT_PLANS_COMING_SOON` for the hosted "coming soon" pricing page; billing endpoints 404 `billing/disabled` when off; everyone on the free tier; double-opt-in paid-plans waitlist (`waitlist_signups`, consent-based, in data export + account deletion). Paid-plan flows are tagged `@billing` and only run against a billing-on stack.
- **Billing (Stripe + LiteLLM):** `users.plan` + `plan_valid_until` + `stripe_*` cols; `workspaces.billing_owner_id` + `ai_enabled`; per-user LiteLLM virtual keys (`users.litellm_key_id` + AES-256-GCM-encrypted `litellm_key_token`) with `max_budget` enforced by the proxy; AI Points UI (1000 pts = $1.00) backed by `/api/ai/credits` reading `/key/info`; webhook signature verification + event-id dedup (`processed_webhook_events`) + out-of-order event stash (`pending_stripe_events`) + plan-lapse sweep + Stripe-driven `updateUserKeyBudget` / `resetUserKeySpend` on plan/period changes. See `server/utils/AGENTS.md`.
- **Audit log (Phase 2):** `audit_log` table records security-relevant + billing-relevant operations. Distinct from user-facing `activity_log`. See `server/repos/audit.ts`.
- **Privacy / GDPR / DSA infrastructure (Workstream B):** EU-only data path — AI + storage sub-processors are `intra_eu` (Mistral / Jina / Staan / BFL / OVH), the rest DPF-covered (Stripe / Resend / Sentry-EU / OAuth-only Google + GitHub); lawful-basis registry rendered into the privacy page; truncated-IP audit log; account-deletion request → 30-day grace → full cascading purge with comment anonymisation + workspace promote/cascade rules; data-export ZIP queue (GDPR Art.15/20); cookie consent banner (CNIL-grade equal-prominence, three purposes, append-only `consent_log`, anon-id cookie persists across login); onboarding gate (Privacy + ToS + age ≥16); DPA acceptance gated to workspace owners; DSA Article 16 abuse reporter with admin triage queue + email-out to operator; admin RBAC via `users.is_admin` column + env-list bootstrap; framework-level error sanitisation; transactional email via Resend with sandbox-sender fallback. See `server/legal/AGENTS.md` + `app/components/legal/AGENTS.md`.
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
- [ ] Markdown frontmatter, command palette, TOC sidebar, folding, highlighting, QR code sharing, keyboard cheat sheet, remaining locale translations, markdown export with base64-inlined images. (Y.js compaction shipped — background `yjs_documents` sweep in `sync-server/src/compaction.ts`.)

**Mobile MMP**
- [x] Mostly shipped — `visualViewport` keyboard-intrusion offset lives in `AIPromptBar.vue`; bottom sheets / format bar / view-mode bar shipped in the Phase 14 mobile sprint. Only the floating-toolbar-above-keyboard variant was deliberately deferred.

**AI**
- [ ] Semantic search across docs via embeddings — "find the section about X", "suggest related docs".
- [ ] Safari support for voice input / dictation — Safari's `MediaRecorder` only emits `audio/mp4` (AAC) which the Voxtral (Mistral) transcription path doesn't accept.

**Flow docs system** (see `tests/e2e/AGENTS.md`)
- [x] Tier 1 flows: `polished-pdf`, `import-existing`, `rich-content`, `password-protect` — shipped with hero strips, direction-anchoring annotations, and curated "Try next" forward links.
- [x] Two-context fixture (`flow.spawn(actorLabel)`) — spawns a sibling `BrowserContext` with its own cookies + identity; both actors push into the same manifest with `actor` field stamped per frame; `password-protect` rewritten to use it (visitor frames now come from a genuinely separate browser, not a cookie-clear simulation).
- [x] Tier 2 flows: `voice-dictate`, `document-context`, `knowledge-rag` — voice via the canned-fake STT mock (`NUXT_GOOGLE_SPEECH_MOCK=1`), document-context demonstrates audience+language steering on a single Mistral call, knowledge-rag uploads a postmortem fixture and asks the AI a question grounded in it.
- [x] Selective re-runs: `flows:test:changed` (`scripts/flows-test-changed.ts`).
- [x] CI integration — the PR gate (`ci.yml`) runs NO flow suite; the full suite incl. live-AI flows runs once per release in `release.yml` (`release:*`-labeled merges only), which also regenerates the docs/demo screenshots.
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
| Billing behind `NUXT_BILLING_ENABLED` (default off), Stripe code kept dormant | One codebase for self-hosted, free-only SaaS and (later) paid SaaS — differences are configuration only. Off = 404 `billing/disabled` on every billing endpoint (not 503: 503 means "retry", which would make Stripe retry a permanent config state forever), free tier for everyone, no Stripe env needed. The flag is parsed from `process.env` (not runtimeConfig) by `shared/config/billingMode.ts` so enforcement utils that run outside Nitro (repos tests) see the same value; the client gets it SSR-hydrated via `useBillingMode()` |
| Partial unique index `(doc_id, yjs_doc_id_after) WHERE action IN (...)` | Cross-instance dedup for activity rows without forcing a full-table unique constraint that would reject legitimate `restore` / `comment.*` rows |
| Postgres advisory locks for sweepers | `pg_try_advisory_lock` (session-pinned PoolClient) ensures only one app instance runs each sweeper. The `pg_try_advisory_xact_lock` variant auto-releases on COMMIT and is wrong for long-running sweep work |
| Per-tool call-count caps + per-session interaction cap (50) | Phase 2 — protects users + us from cost-amplifying outliers (a model that loops calling `view_image` would burn through quota). Caps abort with a user-visible message |
| `SESSION_VERSION` invalidation | Simpler than backwards-compat shims pre-launch |
| paged.js in srcdoc iframe | paged.js mutates global state; host-page approach caused unrecoverable layout jitter |
| Single `themeToCss()` for preview AND print | One function, two consumers — genuine WYSIWYG |
| Server-rendered PDF via Playwright sidecar (over pure browser-side) | Browser-side `window.print()` had layout drift on iOS Safari + AI-driven view-pages tool needs server-side bytes. Sidecar isolates Chromium dependency from the Nuxt image |
| Drop DOCX/HTML export | Maintenance burden; markdown + PDF covers all real needs |
| Markitdown over pandoc | 1.1 GB → 615 MB image; import-only use case doesn't need pandoc's output formats |
| Self-host paged.js / hljs / KaTeX / Mermaid / web fonts under `/vendor/` (was jsDelivr + Google Fonts) | A CDN receives every visitor's IP address (a privacy-policy disclosure and a third-party transfer we don't need), widens the CSP and the renderer's SSRF allowlist, and breaks previews/PDFs on air-gapped self-hosts. Vite still can't inject into srcdoc iframes, so the files are plain static assets copied from the pinned npm packages at build time; versioned paths keep the automatic cache-bust, SRI stays on scripts/stylesheets |
| `pgvector/pgvector:pg16` over stock `postgres:16-alpine` (dev/local/test) | Data-dir-compatible drop-in; avoids "install pgvector at runtime" ceremony. Prod uses OVH managed Postgres with the extension preinstalled |
| Single LiteLLM gateway for every AI surface | Phase 5–6 collapsed every provider onto one self-hosted EU-resident proxy with a vendor-agnostic OpenAI-shape API. Per-user virtual keys gate budget; spend tags surface 4-axis breakdowns to the admin dashboard. The interaction-counter table (`ai_usage_period`) was retired — LiteLLM's per-key `max_budget` is the only enforcement gate now |
| Mistral / Jina / Staan / BFL all EU-resident, no DPF transfers | Phase 6 swap. Mistral (Paris, text + voice), Jina (Berlin, embeddings + `fetch_url` page extraction via Jina Reader), Staan (European Search Perspective SAS, `web_search`), BFL (EU-pinned `api.eu2.bfl.ai`, image gen). All `intra_eu` transfer mechanism — no DPF / SCC paperwork. Replaced `google_gemini` + `google_speech_to_text` from the prior stack |
| Mistral `temperature: 0` on the agentic loop | Default ~0.7 caused tool-selection drift on a deterministic-ish task ("read doc, pick tool, edit, wrap up"). Pinning to 0 stabilises tool choice and stops flow tests from flaking on "model decided to chat instead of editing" |
| Separate `dictateJwtSecret` | Rotate independently of the Hocuspocus secret. Falls back to `jwtSecret` for dev |
| Zod as AI-tool source-of-truth | `z.toJSONSchema` generates the OpenAI/Mistral param schema + runtime validator from the same source; malformed args self-correct |
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
| **EU-only data path (Sentry-EU; no product analytics, no PostHog)** | LatentSpace Labs GmbH (Zurich) is the controller. Sub-processors must be in EU regions or DPF — Sentry's Frankfurt cluster covers telemetry. No analytics tool is loaded (the former analytics/session-replay consent purposes were removed in `CONSENT_VERSION` 2 because nothing backed them). PostHog has historically run product-analytics workloads through US infra; the EU-residency story didn't match our stance, so we're not adopting it |
| **Framework-level Nitro `errorHandler` (over per-endpoint try/catch)** | A SQL error containing bound params (incl. an email) leaked through a 500 response on `/api/abuse-reports`. Per-endpoint sanitisation has a blast-radius gap forever (every new route is an opportunity to forget); a single `nitro.errorHandler` covers all present + future routes uniformly. 4xx pass through (so client-actionable hints survive); 5xx are stripped to a generic message + `code: 'internal'` |
| **Account deletion as 30-day grace + cancellable, not immediate** | GDPR doesn't require synchronous purge — Art.17 says "without undue delay", which 30 days satisfies for a single-operator setup. The grace period gives users a recovery window for accidental deletes (a real support load); the cancel button restores all state with one click. Hard purge runs from `accountDeletionSweep.ts` once the deadline passes |
| **Comments on others' docs are ANONYMISED on account deletion, not removed** | Removing them tears holes in collaboration history that other users can't read around ("[deleted] replied to me — about what?"). The comment row stays; `author_user_id` nulls and `author_name_snapshot` flips to "Deleted user". Same pattern across `activity_log`, `audit_log`, `consent_log`. The user's owned docs ARE deleted; only artefacts on OTHER people's surfaces survive |
| **Workspace fates on owner deletion: cascade-delete sole-member, promote longest-tenured admin, remove member otherwise** | Sole-member workspace has no surviving stakeholder so cascade is fine. Multi-member workspace with the deleting owner as the only admin needs an admin to survive; we promote the **longest-tenured** other admin (deterministic + biased toward established trust) rather than asking the user to pick at delete time. If the deleter isn't an admin, just remove their membership |
| **DPA acceptance is workspace-owner-only (not for casual users)** | DPA is a B2B contract (LatentSpace Labs as data PROCESSOR for the workspace owner's content + members). A solo user editing their own doc doesn't have a Controller-Processor relationship — surfacing the DPA there is paperwork theatre that conditions users to click-through legal docs. Profile page shows "Required when you create a workspace" instead of a red "not accepted" warning |
| **Onboarding gate exempt on `/legal/*`** | Users must be able to read what they're accepting before they accept. Without the exemption, clicking the in-modal "Privacy policy" link would be blocked by the same modal that pointed at it.  |
| **Anon-id cookie persists across login (not user-id-keyed consent)** | Cookie consent is given by a **device + browser session**, not a user account. A logged-out user gives consent; the same browser later signs in; the consent record bridges via the anon-id pointer rather than starting over. The `consent_log` row optionally carries `userId` for auditability without making the row's identity the user |
| **`users.is_admin` column primary; `NUXT_ADMIN_USER_EMAILS` env-list secondary** | Env-only admin meant adding/removing an operator required a deploy. Column-only meant we'd lock ourselves out if the bootstrap account got nuked — there's no path back without DB access. Solution: column is the source of truth for `requireAdminUser`, but the env-list bootstraps on every sign-in with a verified email so a fresh deploy + a listed email = admin at first login without a manual UPDATE. No email fallback at check time: a stored address alone never grants admin |
| **Resend over self-hosted SMTP** | Self-hosted SMTP from a single VPS lands in spam folders 9 times out of 10 because reverse-DNS + DKIM + SPF + DMARC alignment is a part-time job. Resend is DPF-listed, has a Pro tier we can opt into when we outgrow the free 3 k/month, and the SDK auto-detects sandbox mode (`onboarding@resend.dev`) when no verified domain is configured — local dev sees the same code path |
| **`@nuxt/content` for `/legal/*` documents (not hand-rolled markdown-it)** | The legal page renderer is one of two places we render markdown server-side (the other is the document preview). Reusing the doc-preview pipeline would entangle legal-doc lifecycle with editor-doc lifecycle. `@nuxt/content` ships its own MD renderer + frontmatter handling and was already in dependency tree for the docs site |

For feature-specific decisions (restore reversibility, AI tool design, knowledge pipeline, Stripe webhook flow, etc.) see the sub-AGENTS.md for that area.

---

## 10. Project-wide Gotchas

For feature-specific gotchas see the sub-AGENTS.md for that area.

- **`server/auth/` is not a Nitro route dir.** OAuth handlers live in `server/routes/auth/`.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **`server/runtime/bunEntry.ts` is a copy of nitropack's `bun` preset entry** (plus Bun's `maxRequestBodySize`). The preset source it was derived from is pinned in `tests/fixtures/nitropack/bun-preset-entry.mjs.txt`; `tests/unit/bunEntryUpstream.test.ts` fails when an upgraded nitropack ships a different preset entry. Then re-derive `bunEntry.ts` from `node_modules/nitropack/dist/presets/bun/runtime/bun.mjs` and refresh the snapshot — never just refresh the snapshot.
- **`nitro.preset` must match runtime** — default `node-server` breaks packages with Bun conditional exports (lib0).
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
- **The knowledge vector column's dimension is runtime-configured, not schema-driven.** `schema.ts` and the migrations pin `vector(768)` (the hosted default); `server/plugins/02-embeddings-dimension.ts` retypes the column at boot to `NUXT_LITELLM_EMBEDDINGS_DIMS` only when no vectors are stored, otherwise it disables knowledge features (not the app) until `bun run knowledge:reembed` (in a container: `docker compose exec app bun cli/reembed-knowledge.js` — the Dockerfile bundles the script into `/app/cli/`). Don't "fix" the 768 in `schema.ts` — changing it would generate a spurious migration. Never add a migration that touches `workspace_knowledge_chunks.embedding`'s type. See `server/utils/AGENTS.md`.
- **LiteLLM reads `infra/litellm/config.yaml` once at boot, and its single-file bind mounts keep the OLD file after a deploy replaces it** (new inode). The litellm service carries a `markoto.litellm-config: ${LITELLM_CONFIG_HASH}` label; every deploy path (`deploy.yml`, the Ansible `markoto` role, `install.sh`) exports a hash of the two mounted files so `compose up -d` recreates the container when they change. A new deploy path must export it too (`scripts/selfhost-check.sh` checks the three). Staging once ran a week-old model list because of this.
- **LiteLLM crashes at startup if a referenced `os.environ/VAR` is undefined** (`argument of type 'NoneType' is not iterable`) — every `os.environ/` var in `infra/litellm/config.yaml` needs a compose default (see the `EMBEDDINGS_UPSTREAM_*` trio in `docker-compose.base.yml` + `docker-compose.test.yml`).
- **Never read `X-Forwarded-For` / `X-Real-IP` in an endpoint** — use `getClientIp(event)` (`server/utils/clientIp.ts`). The leftmost XFF entry is client-controlled; the helper takes the `NUXT_TRUSTED_PROXY_HOPS`-th entry from the right. The sync server's rate limiter uses the same `shared/utils/clientIp.ts`.
- **Browser-facing presigned S3 URLs use `usePresignS3Client()`**, not `useS3Client()` — SigV4 signs the Host, and on the self-host stack the app's S3 endpoint (`http://seaweedfs:8333`) isn't the one browsers reach (`NUXT_S3_PUBLIC_ENDPOINT`).
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
- **`OnboardingGate.vue` needs the `/legal/*` exemption** (and so would any future consent banner). A user must be able to read what they're being asked to accept. The check is `route.path.startsWith('/legal/')`.
- **The "DPA not accepted" surface is contextual, not blocking.** Casual document users never own a workspace, so showing them a red "Data Processing Addendum: not accepted" warning panics them about a doc that doesn't apply. Profile page renders `legal.notAccepted` only if the user has at least one workspace they own; otherwise renders `legal.dpaNotApplicable` ("Required when you create a workspace"). Don't fold these back into one branch.
- **Logout MUST be a hard reload (`window.location.href = '/'`), NOT `navigateTo()`.** Soft-navigate leaves stale `useState` keys (avatar, useAccountStatus, useLogout broadcast receiver) and 401 toasts as the SSR-cached fetches fire on the new page. The cross-tab BroadcastChannel logout receiver also expects a hard refresh — soft-navigate breaks the pattern.
- **`data-testid` on `UModal` prop doesn't reach the DOM** in Reka UI's slot composition. Move the testid onto a wrapper div inside `<template #content>` instead. The same restriction applies to `UDropdownMenu` items — use `data-testid` on the actual `<button>` rather than the menu item config.
- **Profile-page i18n keys are at root (`settings.profile.*`), NOT under `legal.*`.** The first version of the profile page nested the keys under `legal.settings.profile.*` — every `t('settings.profile.*')` call rendered the literal key. The `tests/unit/legal/i18nKeys.test.ts` pin guards the namespace.
- **`NitroErrorHandler` returns `void`.** Initial implementation tried `return JSON.stringify(payload)` and lost the response body. Use `await send(event, JSON.stringify(payload))` — the handler is fire-and-forget on the underlying socket, not an event.respond.
- **`reporter_user_id` is `ON DELETE SET NULL` but `reporter_email` is plain text.** When a reporter deletes their account the FK auto-nulls; the snapshot column is what survives so moderators can mailto: the original reporter. Don't add an FK constraint to the email column.
- **`abuse_reports.doc_id` is free-form text, NOT an FK to documents.** Reporters paste arbitrary input into the docId field ("test", URLs, fragments). The original FK exploded with a 500 on first invalid input. Drop migration: `0013_*.sql`. Validate shape (≤64 chars), not existence.
- **Repos that do `tx.execute(sql\`...\`)` return strings for timestamps**, not Date objects. `claimQueuedJob` in `dataExportJobs.ts` had to add `toDate` / `toDateOrNull` coercion because the worker compared `Date` instances. Drizzle's typed `select()` does the coercion; raw `execute` does not.
- **`yjs_documents` table doesn't exist in the repos test env** — created lazily by sync-server. `dataExport.ts` probes `pg_class` before attempting Y.js reconstruction so the export builder doesn't 42P01 in tests / fresh deploys.
- **The cancel-deletion endpoint is `/api/user/delete-cancel` (one path segment), NOT `/api/user/delete/cancel`** — the file is `delete-cancel.post.ts` at the user route root. A typo'd path returns 404 silently because the auth-middleware whitelist matches the parent prefix. Both the banner button and the profile page must call the right URL.
- **Sandbox-sender fallback in Resend uses `markoto <onboarding@resend.dev>`** — required when no verified domain is configured. `NUXT_EMAIL_PROVIDER=stub` skips entirely (test mode). Don't hardcode a custom From; let `sendEmail.ts` resolve it.
- **`isAdminEmail` is case-insensitive on BOTH the env value and the input** — the env-list `'Joel@LatentSpace-Labs.CH'` matches `'joel@latentspace-labs.ch'` and vice versa. Skip empty segments (`a,,b` is valid). Read the env var on every call; do not cache module-scope.
- **The AI tool `decl()` field MUST be `parameters`, not `parametersJsonSchema`.** Single most load-bearing field name in the AI loop — `internalToOpenAITools` reads `parameters`. Phase 6 caught a refactor that wrote `parametersJsonSchema` while readers stayed on `parameters`; TS missed the mismatch (excess-property checks on `return {literal}` from typed functions are unreliable), and every tool went out with an empty schema. Pinned by `tests/unit/aiToolSchemas.test.ts`. See `server/utils/agentic/AGENTS.md`.
- **Hocuspocus debounces 2 s before flushing edits to `yjs_documents`.** When a flow test (or any integration test) needs N **distinct** activity rows from N successive edits, fixed `waitForTimeout(3000)` between typings is required — API polling can't separate the batches because the debounce window is what creates new rows, not the flush itself. See `tests/e2e/AGENTS.md` for the wait-for-batch-window pattern.
- **`bun run test:coverage` undercounts.** `@vitest/coverage-v8` only measures code that runs in the vitest process; integration tests spawn a separate `bun run dev` subprocess via `tests/integration/setup/server.ts`, so every `server/api/*`, `server/middleware/*`, `server/plugins/*`, `server/routes/*` runs there — invisible to coverage. Three dead ends so we don't try again: (1) Bun doesn't honor `NODE_V8_COVERAGE` (oven-sh/bun#17867). (2) Spawning with `node` + NODE_V8_COVERAGE produces files but Nitro's Vite SSR transform records URLs as `evalmachine.<anonymous>` which c8 can't map. (3) `@nuxt/test-utils/e2e` `setup()` would work but our `nitro.preset: 'bun'` build traces Bun-specific paths and Stripe's ESM entry doesn't resolve under Node's ESM resolver. **Net: the API-route coverage gap is architectural.** When reviewing coverage, mentally overlay: every `server/{api,middleware,plugins,routes}/*` plus orchestrators like `processKnowledge.ts` and `aiClient.ts` is covered by the 300+ integration tests but doesn't show up in the number.

---

## 11. Operational Posture

**Where it runs:** Single OVH VPS (Debian/Ubuntu LTS), provisioned + maintained via Ansible (`infra/`). Single-instance today; multi-instance-capable since Phase 3 but not currently scaled out.

**What's managed:** OVH managed Postgres (HA + automatic backups + pgvector preinstalled), OVH Object Storage (S3-compatible). What's self-hosted: everything else (Nuxt app, Hocuspocus sync, renderer sidecar, markitdown, Valkey, backup sidecar).

**Deploy flow:** Merge a `release:*`-labeled PR (releases are opt-in; unlabeled merges accumulate) → `release.yml` builds + tags GHCR images, runs the full flow suite incl. live-AI, creates the GH Release from PR title/body → `staging-gate.yml` fires automatically: verify-release → deploys `latest` to staging (resetting the staging DB via `scripts/reset-staging-db.sh`) → public smoke suite against `https://staging.markoto.app` → prod deploy is a **manual** `deploy.yml` `workflow_dispatch` (choose environment + tag; the `.env` is rendered from GitHub secrets via `infra/render-env.sh`). One labeled PR = one release. See `docs/RELEASE-PROCESS.md`.

**Rollback:** `infra/playbooks/rollback.yml` flips the GHCR tag back. Database migrations are forward-only by convention; rollback is for code, not schema. See `docs/RUNBOOK.md`.

**Downtime budget:** ~30 seconds during deploy (compose stop → pull → start). HA is not engineered. Sticky sessions + Valkey state mean we *could* run blue/green, but the operational complexity isn't worth it at our traffic.

**Notifications:** Apprise via Telegram. Backup failures, OS update reboots, deploy success/failure all flow through `/usr/local/bin/markoto-notify`.

**Where to look first when something breaks:**
- `docs/RUNBOOK.md` — symptom-driven incident playbook.
- `docs/BREACH-RESPONSE.md` — if the incident involves a personal-data breach (unauthorised access/disclosure/loss), the 72h GDPR Art.33 clock starts at awareness.
- `docs/CHEATSHEET.md` — common Make targets + workflows.
- `docs/RELEASE-PROCESS.md` — deploy mechanics.
- `infra/README.md` — Ansible layout.
- Sentry — application errors. Throttled via `server/utils/throttledSentry.ts`.
- Apprise/Telegram channel — ops notifications.
