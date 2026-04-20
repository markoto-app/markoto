# YPad — Project Guide

Collaborative markdown editor: Y.js CRDT + Hocuspocus sync, OAuth (GitHub/Google) via `nuxt-auth-utils`, PostgreSQL (app data + Y.js state via `y-postgresql`), external S3 for image uploads & pg backups, multi-lingual UI via `@nuxtjs/i18n`, AI writing assistance via Google Gemini. Single Linux VPS, Docker Compose.

Login is **optional** — public docs work anonymously. Login is required to own, manage permissions, use workspaces, delete, or use AI.

---

## 1. Architecture

Browser (Nuxt 4 SSR + SPA with CodeMirror 6, Y.js, paged.js iframe) connects via HTTPS/WSS to Traefik, which routes to the Nuxt app container and the Hocuspocus sync container. Both containers talk to PostgreSQL. App talks to Hocuspocus over internal HTTP. Backup sidecar does daily `pg_dump → S3`. Markitdown (FastAPI) handles imports only.

**Key design principles**
- **Full-stack Nuxt.** One Bun process serves SSR + Nitro API + OAuth. No CDN.
- **OAuth optional.** Anonymous users can view/edit public docs; login gates ownership and AI.
- **Y.js state in Postgres** via `y-postgresql` (`yjs_documents` table). Append-only + periodic merge; one `pg_dump` covers everything.
- **S3 = image uploads + pg backups only.** SeaweedFS in dev; external S3 in prod.
- **Hocuspocus as separate container.** Long-lived WS shouldn't share the Nitro event loop. Server↔sync over shared-secret HTTP.
- **AI joins the doc as a real Y.js client** — edits broadcast live via CRDT, status via awareness.
- **Preview is paged, in an iframe.** `themeToCss(theme)` drives both live preview AND PDF print. No server Chromium.
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
| Image blobs | S3 at `docs/{docId}/{fileId}.ext` |
| Postgres backups | S3 at `backups/postgres/{ISO8601}.sql.gz` |
| User sessions | Sealed cookies (`nuxt-auth-utils`), versioned via `SESSION_VERSION` |

Schema source-of-truth: `server/db/schema.ts`. Enums as `text('col', { enum: [...] })` not `pgEnum` — adding values is TS-only, no `ALTER TYPE` friction.

**Migrations:** `bun run db:generate` diffs against `drizzle/meta/` snapshots. `server/plugins/00-db-migrate.ts` applies at boot (numeric prefix forces load-first). `server/plugins/99-shutdown.ts` closes pg pool. `NUXT_S3_ENDPOINT` swaps S3 backends with no code changes.

---

## 4. Auth & Access Control

### Access modes

| Mode | Anonymous | Logged-in non-owner | Owner |
|---|---|---|---|
| **Private** (default for logged-in docs) | forbidden | forbidden | Full control |
| **Open edit** (default for anonymous docs) | Edit | Edit | Full control |
| **Open view** | View | View | Edit + manage |
| **Password-protected** | Enter password | Enter password | Edit + manage |

Workspace membership overrides: admin/editor bypasses `private` and `password-protected`; viewer gets read-only access regardless of accessMode.

**Read-only: 4 layers** — (1) token mints JWT with `readOnly: true`, (2) Hocuspocus blocks Y.js updates, (3) CM6 Compartments set `EditorView.editable + EditorState.readOnly`, (4) UI hides toolbar.

**Password-protected: 3 layers** — (1) token returns `token: null`, (2) Hocuspocus rejects, (3) `v-if="!requiresPassword"` blocks editor mount.

**Session:** 7d maxAge. `SESSION_VERSION` in `server/utils/validatedSession.ts` invalidates stale cookies on next request. OAuth handlers in `server/routes/auth/` (NOT `server/auth/`).

### Workspaces & roles

`workspace_members` is the authorization source of truth — `workspaces.ownerId` is provenance only, never read for authz. Three roles:

| Action | Viewer | Editor | Admin | Doc owner |
|---|:-:|:-:|:-:|:-:|
| View doc | ✓ | ✓ | ✓ | ✓ |
| Edit content / title / theme | — | ✓ | ✓ | ✓ |
| Change access mode / password | — | — | ✓ | ✓ |
| Delete doc | — | own only | any | own |
| Create doc in workspace | — | ✓ | ✓ | n/a |
| Add / remove members, change roles | — | — | ✓ | n/a |
| Rename / delete workspace | — | — | ✓ | n/a |
| Leave workspace | ✓ | ✓ | ✓ (if not last admin) | n/a |

- **≥1 admin invariant** enforced in `workspace_members/[userId].patch.ts` and `.delete.ts` (409 on last-admin demotion/removal).
- **Invite: exact-email only.** 404 no-such-user, 409 duplicate. Default role = editor. No typeahead to avoid user enumeration.
- **Central helpers:** `server/utils/workspaceAccess.ts` — `getWorkspaceRole`, `getDocAuthz`, `canEditDoc`, `canManageDoc`, `canManageWorkspace`, `countWorkspaceAdmins`. Additive: standalone/anonymous doc flows unchanged.
- **Token endpoint** queries `workspace_members`: admin/editor → `readOnly: false`, bypasses `private`; viewer → `readOnly: true` always.
- **Cascade delete:** iterates all docs, calls `deleteDocument()` per-doc (S3 + Y.js + sync notify); `workspace_members` drop via FK cascade.
- **"Recent Documents"** dashboard lists only owned docs; workspace docs surface inside the workspace view.

---

## 5. API Routes

`server/api/` → `/api/*`. `server/routes/` → `/`. `server/auth/` is unreachable.

**Auth:** `GET /auth/github`, `GET /auth/google`, `GET /api/_auth/session`

**Meta:** `GET /api/health` (DB probe), `GET /api/version` (SPA staleness)

**Documents:** `POST /api/docs` (anon OK; accepts `workspaceId`), `GET/PUT /api/docs/:id/meta`, `DELETE /api/docs/:id` (`canManageDoc`), `GET /api/docs/:id/token` (consolidated: token + readOnly + requiresPassword + forbidden + accessMode + ownerId), `GET /api/docs/:id/activity`, `POST /api/docs/:id/password`

**Internal (sync→app, `X-Internal-Secret`):** `POST /api/internal/activity`

**User:** `GET /api/user/documents`, `GET /api/user/workspaces`, `GET /api/user/recent`

**Files:** `POST /api/upload/request` (presigned PUT), `POST /api/upload/confirm`, `GET /api/files/:docId/:fileId` (302 → presigned GET, access-controlled)

**Import:** `POST /api/import` (DOCX/PDF/PPTX/XLSX/HTML/EPUB → markdown, 50MB, public)

**Workspaces (login required):** `POST /api/workspaces`, `GET/PUT/DELETE /api/workspaces/:wsId`, `POST /api/workspaces/:wsId/members`, `PATCH/DELETE /api/workspaces/:wsId/members/:userId`

**AI (login required):** `POST /api/ai/prompt` (returns `{sessionId}`), `POST /api/ai/rewrite`, `POST /api/ai/abort` (initiator only, 403 otherwise)

Auth guard: `server/middleware/auth.ts` whitelists public patterns; protects `/api/docs/` (outside whitelist), `/api/workspaces`, `/api/user`, `/api/upload`, `/api/ai`. Token endpoint never issues a usable JWT for forbidden/password-gated docs.

---

## 6. Sync Server (Hocuspocus)

Config at `sync-server/src/index.ts`. Hooks: `onLoadDocument`, `onStoreDocument`, `onAuthenticate`, `onConnect`/`onDisconnect`, `onRequest`.

- **Persistence:** `y-postgresql` singleton with `useIndex: false`, `flushSize: 200`. `onLoadDocument` returns `new Y.Doc()` on failure (never throws). `clearDocument` on deletion.
- **Auth:** `JWT_SECRET` required at startup. Every WS connection must present a valid JWT. Verifies `payload.docId === documentName`.
- **Rate limiter:** 20 connections/IP via `connectionIPs: Map<socketId, ip>` (not mutating connection object — Hocuspocus v3 hook shapes vary). Max 5000 rooms.
- **Activity logging:** Primary attribution from `lastEditorByDoc` Map (JWT `userName`). Fallback: `mostRecentEditorFromAwareness`. Fire-and-forget POST to `${APP_URL}/api/internal/activity` with 5s timeout. Dev: sync→app via `host.docker.internal`; **Nuxt dev must bind `0.0.0.0`.**
- **Internal HTTP** (`sync-server/src/internal-http.ts`, gated on `X-Internal-Secret`):
  - `GET /health` — public healthcheck for Traefik/Docker
  - `POST /internal/notify-deleted` — sets `ymeta._deleted` + `clearDocument()`
- **Graceful shutdown:** SIGTERM → `server.destroy()` → `ypgPersistence.destroy()`. 25s kill-timer. Compose `stop_grace_period: 30s`.
- **Running:** TS runs directly under Bun (no pre-bundle; bundler chokes on Hocuspocus CJS/ESM exports).

---

## 7. AI Features — Gemini as Collaborator

Two flows:
- **Top-bar prompt** (`AIPromptBar.vue`) — agentic loop, tools: `view_document`, `replace_text`, `insert_text`, `web_search`. Model: `NUXT_GOOGLE_MODEL` (default `gemini-3.1-flash-lite-preview`).
- **Inline selection rewrite** (`AISelectionPopup.vue`) — one-shot, no tools, full-doc context windowed to 40k chars. Model: `NUXT_GOOGLE_REWRITE_MODEL` (default `gemini-2.5-flash-lite`).

**AI-as-Y.js-client:** Server mints a JWT (`userId=ai:assistant:{sessionId}`), opens a `HocuspocusProvider`, sets awareness `{isAI, aiSession, aiStatus}`. Each edit is `ydoc.transact(fn, 'ai:assistant:{sessionId}')` — users watch edits land in real time. No SSE; status rides on awareness. `aiSession.kind` (`'prompt' | 'rewrite'`) discriminates animations so the floating bar only pulses during prompt sessions and vice versa.

**Function tools** (`server/utils/agentic/functionTools.ts` + `server/utils/aiToolAdapter.ts`):

| Tool | Behavior |
|---|---|
| `view_document({ view_range? })` | Returns `ytext.toString()` with 1-indexed line prefixes |
| `replace_text({ old_str, new_str })` | 0 matches → error; 2+ → "Found N matches"; 1 → transact delete+insert |
| `insert_text({ insert_line, insert_text })` | Maps line → char idx; transacts insert |
| `web_search({ query })` | Isolated sub-call with `googleSearch` only; never mixed with `functionDeclarations` |

Zod schemas are the source of truth — `z.toJSONSchema(schema, { target: 'draft-7' })` generates both Gemini's param schema and the runtime validator. Parse failures return as `functionResponse.isError` so the model self-corrects.

**Inline rewrite race safety:** Client sends Y.js `RelativePosition` for selection; server resolves to absolute. Fallback chain: relative pos → raw index → single `indexOf` → 409 "Selection has moved".

**Limits:** `ai-prompt: 20/h`, `ai-rewrite: 30/h` per user. Prompt deadline 5 min, rewrite 30s, `MAX_TURNS = 20`. Sweeper (`server/plugins/ai-session-sweep.ts`) aborts sessions >7 min (threshold intentionally above prompt deadline). Error status lingers 2.5s in awareness so clients latch before cleanup.

**Cancellation:** `POST /api/ai/abort` — 404 if ended, 403 if not initiator. Status → `{phase:'done', message:'Stopped'}`.

**Per-user cap:** 1 session per user per doc, enforced by Postgres UNIQUE index in `ai_sessions`.

---

## 8. Document Composables

Three-file split (`app/composables/`):
- **`useDocToken.ts`** — fetches `/api/docs/:docId/token`; seeds initial theme; handles password-verify reconnect. Exposes: `token, readOnly, requiresPassword, forbidden, accessMode, isOwner, hasOwner, initialTheme, pendingPasswordUnlock, setAccessMode`.
- **`useHocuspocusSync.ts`** — provider lifecycle only. `getToken()` callback for reconnects. Exposes: `provider, status, synced, userCount, docSizeBytes, reconnect`.
- **`useDocument.ts`** — thin orchestrator. Creates Y.Doc + awareness + undoManager, composes the workers, owns title bridge (`ymeta.observe` → Vue ref), deletion observer (`ymeta._deleted`), welcome-doc seeding.

Key invariants: single consolidated fetch on init (token endpoint returns metadata + theme — no separate `/meta` call); single Awareness instance passed to both provider and yCollab; title/theme bridged via `ymeta.observe()`; `requiresPassword` flips false only on `onSynced` to prevent empty-doc-prepend bug.

`canEditTheme` mirrors content edit access: read-only = false, owner = true, anonymous on ownerless doc = true.

---

## 9. Preview Rendering & PDF Export

Right pane shows discrete A4/Letter pages inside a same-origin srcdoc iframe. PDF uses the same pipeline in a hidden iframe + `window.print()`. No server Chromium.

**Pipeline (`app/utils/renderMarkdown.ts` → `shared/utils/themeToCss.ts` → `app/composables/usePagedPreview.ts`):**
1. `renderMarkdown.ts` — singleton markdown-it + DOMPurify. Plugins lazy-imported inside `init()`. Pipeline: core + task-lists + emoji + footnote + Batches 1–3 + custom pagebreak rule. Always emits `language-${lang}` class so the mermaid detector finds `pre code.language-mermaid`.
2. `transformFootnotesForPagedMedia(html)` lifts footnote `<li>` from end-of-doc `<section>` to inline `<span class="footnote">` at the ref site — required for paged.js `float: footnote`.
3. `themeToCss.ts` compiles `DocTheme` into the full stylesheet — `@page`, margin boxes, `.paged-doc` body, headings, TOC (with `target-counter` page numbers), page-break, column-span spanners.
4. `usePagedPreview.ts` mounts a persistent srcdoc iframe. Parent calls `iframe.contentWindow.__renderDoc(opts)` (250ms debounce). Iframe decodes images, pre-processes mermaid → SVG, then runs paged.js. Posts back `{type:'paginated', pageCount}`. Fragment links intercepted to prevent srcdoc iframe navigation.
5. `printPdf.ts` — hidden iframe, `window.PagedConfig = { auto: true, after: () => print() }`, 30s timeout. Mermaid pre-processed in parent context (different window = different module instance).

**Why iframe:** paged.js mutates global head styles + `:root` vars and re-paginates on every call. Running on the host page caused unrecoverable layout contamination. Use CSS `zoom` (not `transform: scale`) for responsive shrinking — zoom shrinks layout box; scale doesn't.

**paged.js quirks:** Polisher only processes `@page` rules from `stylesheets` argument — pass `[{ 'theme.css': cssText }]`. Margin boxes are siblings of `.paged-doc`, not descendants; CSS custom properties don't propagate up. Bake `{title}`/`{date}` into the CSS string directly.

**Theme system (`shared/types/theme.ts:DocTheme`):** Per-doc JSONB in `documents.theme`, mirrored to `ymeta.theme`. Validated by `shared/utils/themeValidation.ts`. Editor panel: `ThemeEditorPanel.vue` (11 accordion sections). Presets in `shared/utils/themePresets.ts` (Modern, Academic Paper 2-col, Tech Report, Business Report, Novel, Newsletter). Font picker from `shared/utils/themeFonts.ts` (20 fonts). Header/footer tokens: `{title}`, `{date}`, `{page}`, `{pages}` — inserted at cursor via `data-slot`/`data-position`. Phase 4 (user-saved themes) still pending.

---

## 10. Mobile

Breakpoint: `useMediaQuery('(max-width: 639px)')` — matches Tailwind `sm:`. Don't reintroduce 768px.

- Edit-only default on narrow; `watchEffect` forces `viewMode = 'edit'` when `isMobile && viewMode === 'split'`.
- CM6 responsive theme via Compartment: 16px font (prevents iOS auto-zoom), 1.7 line-height, reconfigured on resize.
- `autocapitalize: 'sentences'`, `autocorrect: 'on'`, `spellcheck: 'true'` always on.
- Toolbar `flex-wrap`, collapsed hamburger menu, icon-only connection badge, responsive title.
- Right sidebar: `< xl` (≤1279px) — opening panel hides preview; `xl+` — fixed `w-80` sidebar, genuine triple-pane. Preview uses `hidden xl:block` (CSS), not `v-if`, so resize past xl restores it without remounting.

---

## 11. Security

**Authentication:** OAuth via `nuxt-auth-utils` (HTTP-only cookies, CSRF-protected). `SESSION_VERSION` invalidation. Hocuspocus always requires valid JWT. `JWT_SECRET`, `DATABASE_URL`, `INTERNAL_API_SECRET` fail-fast on missing.

**Rate limits:**

| What | Limit |
|---|---|
| Password brute-force | 5 per IP+docId/min |
| Token endpoint | 30 per IP/min |
| Import | 10 per IP/min |
| AI prompt | 20 per user/hour |
| AI rewrite | 30 per user/hour |
| Hocuspocus | 20 connections/IP, 5000 rooms |

**Input validation:** `meta.put` validates title (≤255), accessMode (enum), wordCount (0–10M), sizeBytes (0–100M), theme (structural + numeric ranges + hex-color regex + font allowlist). Uploads: PNG/JPEG/GIF/WebP/SVG, 10MB. Imports: extension whitelist, 50MB.

**File access:** `/api/files/:docId/:fileId` checks access mode before presigning. Presigned URL TTL: 5min upload, 120s read (can't be revoked; short to survive access-mode/password/deletion changes).

**Other:** scrypt password hashing, 2h password token expiry, `html: false` + DOMPurify for XSS.

---

## 12. Docker Compose

| File | Scope | TLS | Use |
|---|---|---|---|
| `docker-compose.dev.yml` | Infra only (postgres, valkey, seaweedfs, sync, markitdown, backup) — Nuxt on host | — | Daily dev with HMR |
| `docker-compose.local.yml` | Full stack incl. Traefik + GlitchTip | mkcert on `ypad.127.0.0.1.nip.io` | Pre-push full-stack verification |
| `docker-compose.prod.yml` | Full stack incl. Traefik + GlitchTip | Let's Encrypt | VPS deploy |

Three standalone files — no shared base. Dev: `bun run dev --host 0.0.0.0` (0.0.0.0 so sync container can reach via `host.docker.internal`). Ports: Postgres 5432, Valkey 6379, SeaweedFS 8333, Hocuspocus 4001, markitdown 8080.

Prod key points: postgres healthcheck gates `app` + `sync` startup; `stop_grace_period: 30s`; Traefik healthcheck labels on `/api/health` + `/health`; backup sidecar pipes `pg_dump | gzip | aws s3 cp`; Dockerfile **must `COPY drizzle/`** into runtime image.

Required env: `DOMAIN`, `ACME_EMAIL`, `SESSION_PASSWORD` (≥32), `GITHUB/GOOGLE_CLIENT_*`, `POSTGRES_PASSWORD`, `S3_*`, `JWT_SECRET` (≥64), `INTERNAL_API_SECRET`, `GOOGLE_API_KEY/MODEL/REWRITE_MODEL`, `BACKUP_*`.

---

## 13. Project Structure

`app/` — Vue frontend: `components/{auth,editor,preview,collab,ai,sharing,document,workspace,common}/`, `composables/`, `pages/` (index, `d/[id]`, `w/[id]`), `utils/` (renderMarkdown, printPdf, editorCommands, download, welcomeDoc).

`server/` — Nitro API: `routes/auth/` (OAuth), `api/` (docs, upload, files, import, internal, ai, user, workspaces), `db/schema.ts`, `middleware/auth.ts`, `plugins/` (00-db-migrate, 99-shutdown, orphan-cleanup, ai-session-sweep, inactive-doc-sweep), `utils/` (workspaceAccess, documentAccess, documentLifecycle, aiSessions, aiClient, aiToolAdapter, agentic/).

`sync-server/src/` — Hocuspocus: index, persistence, auth, rate-limiter, activity-logger, internal-http.

`shared/` — Cross-cutting: `types/` (theme, auth, pagedjs), `utils/` (themeToCss, themeValidation, themePresets, themeFonts, defaultTheme, CDN version pins).

`drizzle/` — generated migrations + meta snapshots (committed). `i18n/locales/` — en/de/fr/es/ja/zh JSON. `docs/` — DEPLOY.md, LOCAL.md, S3-SETUP.md, OBSERVABILITY.md, SECRETS-ROTATION.md.

---

## 14. Shipped Features

**Infrastructure:** Compose stack, Drizzle + versioned migrations at boot, y-postgresql persistence, S3 singleton, Markitdown service, daily pg backup sidecar with retention pruning, GlitchTip observability, Valkey rate limiting, dual-secret rotation, inactive doc sweep, PWA.

**Auth & editor:** GitHub + Google OAuth, `SESSION_VERSION` invalidation, anonymous doc creation, CodeMirror 6 + yCollab, split editor/preview, formatting toolbar + status bar, welcome doc, i18n (en complete; others scaffolded).

**Collaboration:** Awareness (names/colors/avatars), PresenceBar, Y.js title sync, share modal with access-mode selector, scrypt password protection (3-layer), activity feed (500 cap/doc), remote deletion broadcast via `ymeta._deleted`.

**Files & import/export:** Presigned upload flow (request → PUT → confirm) + DB tracking, drag-drop + paste upload, markitdown import (DOCX/PDF/PPTX/XLSX/HTML/EPUB), client-side `.md` download, client-side PDF via paged.js + `window.print()`.

**Preview & PDF:** paged.js pivot (A4/Letter pages, header/footer, footnotes via `float: footnote`), single `themeToCss()` for preview + print, iframe isolation, responsive page zoom, `Cmd/Ctrl+P` hijack, dark mode chrome, snap-to-bottom guard, image `decode()` before paginate.

**Theme system:** Per-doc JSONB + `ymeta.theme` live broadcast, server validation, `ThemeEditorPanel.vue` (11 sections), 6 built-in presets, 20-font Google Fonts picker, TOC controls (`maxDepth`/`showTitle`/`showPageNumbers`/`leaderStyle`), mermaid theme picker, header/footer token chips.

**Markdown extensions:** Batch 1 (attrs/mark/ins/sub/sup/dl/abbr/figure/img-size), Batch 2 (katex + alerts), Batch 3 (anchor + TOC + Mermaid, 8 diagram kinds), page break (`<!-- pagebreak -->`), `markdownReference.ts` for AI vocabulary.

**Editor chrome:** Google-Docs-style menu bar (File/Edit/View/Insert/Format/Sharing/Help), table size picker (8×8 modal), diagram/alert/math dropdowns, right sidebar (Activity OR Theme), view-mode toggle (Edit/Split/Preview), `DeleteConfirmModal`.

**Workspaces:** Three-role model (admin/editor/viewer), invite-by-email, last-admin invariant, cascade delete, role-gated UI at `/w/:id`, workspace doc table.

**AI:** Gemini agentic loop (4 tools), inline rewrite with RelativePosition race safety, awareness-based status, per-user-per-doc cap via Postgres UNIQUE index, initiator-only cancel, floating prompt bar (rainbow ring animation), selection popup, animation decoupled by `kind`.

**Security hardening:** Fail-fast env, rate limits, file access control, `meta.put` validation, 2h password token expiry.

**Mobile:** Touch-optimized CM6 (16px font via Compartment), flex-wrap toolbar, hamburger menu, 640px breakpoint.

---

## 15. TODOs

### MVP leftover
- [ ] DNS: `yourdomain.com`, `sync.` subdomains (prod deploy)
- [ ] CORS: Traefik middleware for S3 (prod deploy)

### MMP

**Workspaces**
- [ ] Move an existing doc into / between workspaces (currently immutable after creation)

**History & snapshots**
- [ ] Timestamped snapshots in S3 via Hocuspocus hook
- [ ] History view: load any snapshot into fresh Y.Doc
- [ ] Timeline scrubber, diff view, restore, export at point

**Theme system**
- [ ] Phase 4: User-saved themes — `themes` table + CRUD endpoints
- [ ] AI `update_theme` tool in agentic loop

**Preview/print**
- [ ] Refactor `IFRAME_BOOTSTRAP` template literal in `usePagedPreview.ts` to its own file

**Markdown extensions**
- [ ] Batch 4: `markdown-it-criticmarkup`, `markdown-it-multimd-table`, client-side BibTeX citations

**Power features**
- [ ] Markdown frontmatter (export theme/title; import interprets it)
- [ ] Command palette
- [ ] Table of contents sidebar
- [ ] Follow cursor
- [ ] QR code sharing
- [ ] Keyboard shortcuts cheat sheet
- [ ] Offline mode (PWA cache)
- [ ] Y.js document compaction for oversized docs
- [ ] Remaining locale translations (de, fr, es, ja, zh)
- [ ] Markdown export with base64-inlined images

**Mobile MMP**
- [ ] Floating toolbar above virtual keyboard via `visualViewport`
- [ ] Bottom tab bar (Edit / Preview / AI)
- [ ] Sidebar as bottom sheet

**AI**
- [ ] Microphone input with speech-to-text
- [ ] Image generation (`gemini-3.1-flash-image-preview`)
- [ ] Google Image Search tool
- [ ] Pexels / Unsplash search tool

**AI (explicitly out of scope for now):** multi-turn conversation history, streaming text to UI, activity attribution "AI for Alice", user-selectable model, grounded-search caching, cost telemetry, provider-swap adapter.

---

## 16. Technical Decisions

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
| `SESSION_VERSION` invalidation | Simpler than backwards-compat shims pre-launch |
| paged.js in srcdoc iframe | paged.js mutates global state; host-page approach caused unrecoverable layout jitter |
| Single `themeToCss()` for preview AND print | One function, two consumers — genuine WYSIWYG |
| Client-side PDF via paged.js + `window.print()` | No server Chromium, no queue, no S3 round-trip |
| Drop DOCX/HTML export | Maintenance burden; markdown + PDF covers all real needs |
| Markitdown over pandoc | 1.1 GB → 615 MB image; import-only use case doesn't need pandoc's output formats |
| CDN for paged.js / hljs / KaTeX / Mermaid | Vite can't inject into srcdoc iframes; versioned CDN URL = automatic cache-bust |
| Mermaid pre-process before paged.js | paged.js sees plain inline SVG; no runtime rendering during pagination |
| Zod as AI-tool source-of-truth | `z.toJSONSchema` generates Gemini schema + runtime validator; malformed args self-correct |
| Custom `web_search` wrapping `googleSearch` | `googleSearch` + `functionDeclarations` coexistence shifts between model versions; wrapping also gives pre-call status UX |
| Table size picker as UModal | Anchored popover had trigger location and click-competition issues; centered modal sidesteps both |
| Gemini over Claude | Materially cheaper; display name vendor-neutral ("AI Assistant") |

---

## 17. Gotchas

- **`server/auth/` is not a Nitro route dir.** OAuth handlers live in `server/routes/auth/`.
- **`@nuxtjs/i18n` v10:** `lazy` removed — lazy is default when `locales[].file` is set. `langDir: 'locales/'` resolves relative to `i18n/`, not `app/`.
- **`markdown-it-emoji`** needs `.full`: `const emoji = (mod as any).full || (mod as any).default || mod`.
- **`highlight.js` CSS** must be dynamically imported inside `initMd()` — otherwise code blocks are all white.
- **CM6 `readOnly` must go through Compartments** — `isReadOnly` is async-set after `fetchToken`.
- **Single Awareness instance** — create in orchestrator, pass to both `HocuspocusProvider` and yCollab.
- **Y.js Map reactivity** — `ymeta.get('title')` isn't Vue-reactive; use `ymeta.observe()` → ref + computed.
- **`y-postgresql` 1.0.1** — force `useIndex: false` (SQL bug in index-creation branch).
- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary — don't mutate connection object; use separate Maps.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **`nitro.preset` must match runtime** — default `node-server` breaks packages with Bun conditional exports (lib0).
- **Nitro NFT tracer misses `@google/genai`'s transitive `ws`** — fix with `nitro.externals.traceInclude: ['node_modules/ws/index.js']`.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback` to detect drift.
- **Drizzle `node-postgres`** — Promise-returning, no `.get()`/`.all()`. Use `(await db.select()...limit(1))[0]`.
- **Never ship `passwordHash`** — always project explicitly on public endpoints.
- **Never issue usable JWT for forbidden/password-gated docs** — `token: null` prevents Hocuspocus connection.
- **Zod `z.tuple(...)` rejected by Gemini** — use `.array().min(N).max(N)`.
- **AI sweeper threshold must exceed prompt deadline** (7 min > 5 min) — otherwise legit long web searches get killed.
- **Inline rewrite positions** — `RelativePosition`, not raw indices; 409 on ambiguous fallback.
- **Presigned read URL TTL: 120s** — can't be revoked; long TTLs outlive access-mode/password changes.
- **Mobile breakpoint: 639px** — matches Tailwind `sm:`. Don't reintroduce 768px.
- **paged.js + iframe:** Polisher only processes `@page` from `stylesheets` arg (not `<style>` in content tree). Pass `[{ 'theme.css': cssText }]`. `Polisher.add()` takes `{filename: cssText}` map, not Style elements.
- **Margin boxes are siblings of `.paged-doc`, not descendants** — CSS custom properties don't propagate up. Bake `{title}`/`{date}` into the CSS string in `themeToCss`.
- **srcdoc iframe `postMessage`:** `targetOrigin: '*'` required — srcdoc has opaque origin in Chromium (`"null"`). Trust boundary: `e.source === iframe.contentWindow`.
- **CSS `zoom` not `transform: scale`** — `scale` leaves layout box full-size and overflows; `zoom` shrinks both.
- **Footnotes need `transformFootnotesForPagedMedia()`** — markdown-it-footnote puts all footnotes at end of doc; paged.js `float: footnote` needs inline `<span>` at the ref site.
- **Backticks in `IFRAME_BOOTSTRAP` template literal** — any unescaped backtick inside the string closes the outer template early. Use `\`` or reword.
- **Mermaid SVG overflow** — `overflow: visible` on `.mermaid svg` + `.mermaid foreignObject`, `white-space: nowrap` on inner elements. Use `htmlLabels: true` (foreignObject) — `htmlLabels: false` undersizes SVG `<text>` nodes.
- **srcdoc fragment links navigate the iframe** — capture `<a href="#...">` clicks in iframe bootstrap; `preventDefault + target.scrollIntoView()`.
- **`html: false` doesn't block manually pushed tokens** — custom block rules that call `state.push('html_block')` render verbatim regardless. Use this for controlled HTML emission.
- **TOC: anchor plugin must load BEFORE toc plugin** — `markdown-it-anchor` assigns IDs; `markdown-it-toc-done-right` reads them. Share one `slugify` function.
- **KaTeX inline `style`** — DOMPurify must allow `style` attribute; add `math`/`semantics`/`mrow`/etc. to the allowlist.
- **`renderMarkdown` always emits `language-${lang}` class** — even for unknown languages; required for mermaid detector to find `pre code.language-mermaid`.
- **Literal `@` in i18n locale JSON** — `@:key` is parsed as a linked message. Escape with `{'@'}` or reword to avoid `@` in string literals.
- **Workspace authz: one helper per concern.** `canEditDoc` (content), `canManageDoc` (sharing/delete), `canManageWorkspace` (admin actions). Mixing leaks permissions.
- **Removing a workspace member doesn't revoke active JWTs** — valid until next token refresh (up to 2h). Acceptable for now.
- **`workspaces.ownerId` vs `workspace_members.role='admin'`** — `ownerId` is provenance only, never used for authz. An original creator demoted to editor loses admin rights.
