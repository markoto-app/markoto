# API Routes

`server/api/` → `/api/*`. `server/routes/` → `/`. `server/auth/` is unreachable.

**Auth:** `GET /auth/github`, `GET /auth/google`, `GET /api/_auth/session`

**Meta:** `GET /api/health` (DB probe), `GET /api/version` (SPA staleness)

**Documents:** `POST /api/docs` (anon OK; accepts optional `workspaceId` + new-doc-dialog fields `title`/`description`/`audience`/`language`/`templateId`/`themePreset`, all validated against the registries — empty body = legacy zero-config flow), `GET/PUT /api/docs/:id/meta` (PUT validates description ≤500, audience enum, language ≤50; owner-only), `DELETE /api/docs/:id` (`canManageDoc`), `GET /api/docs/:id/token` (consolidated: token + readOnly + requiresPassword + forbidden + accessMode + ownerId + workspaceId + workspaceRole + theme + description/audience/language for editor hydration + `initialBody` (server-rendered template body, locale-matched on doc.language) + templateId), `GET /api/docs/:id/activity`, `GET /api/docs/:docId/activity/:activityId/diff` (Tier 1 — replays Y.js up to before/after boundaries, returns `structuredPatch` hunks; whitelisted public, auth via `decideActivityAccess`), `GET /api/docs/:docId/activity/:activityId/comment-context` (Tier 1 comment expansion; same auth shape), `POST /api/docs/:docId/activity/:activityId/restore` (Tier 2 — edit-access required; calls `restoreDocToYjsId` then writes `restore` activity row; atomic on failure), `POST /api/docs/:id/password`, `PATCH /api/docs/:id/workspace` (move; `canManageDoc` on source + admin/editor on target), `POST /api/docs/:id/duplicate` (clone row + Y.js state with URL rewrite + S3 assets; `canEditDoc` on source, new owner = duplicator; description/audience/language/templateId copy through unchanged)

**Internal (sync→app, `X-Internal-Secret`):** `POST /api/internal/activity` (sync→app activity logging; the sync-server stamps `yjsDocIdBefore`/`yjsDocIdAfter` boundary ids per row so Tier 1 diffs + Tier 2 restores can replay), `POST /api/internal/comments-snapshot` (per-thread state snapshot triggered on every comment.* mutation; serialised by `pg_advisory_xact_lock(hashtext(docId))` so concurrent writes don't both read the same `latest_id` and produce identical phantom snapshots).

**User:** `GET /api/user/documents`, `GET /api/user/workspaces`, `GET /api/user/recent`

**Files:** `POST /api/upload/request` (presigned PUT), `POST /api/upload/confirm`, `GET /api/files/:docId/:fileId` (302 → presigned GET, access-controlled)

**Import:** `POST /api/import` (DOCX/PDF/PPTX/XLSX/HTML/EPUB → markdown, 50MB, public)

**Workspaces (login required):** `POST /api/workspaces` (enforces per-user cap), `GET/PUT/DELETE /api/workspaces/:wsId`, `POST /api/workspaces/:wsId/members`, `PATCH/DELETE /api/workspaces/:wsId/members/:userId`

**Workspace knowledge (login required + membership):**
- `POST /api/workspaces/:wsId/knowledge/upload-request` — admin/editor; rate-limited + cap-checked; mints 300s presigned PUT + reserves Valkey inflight slot
- `POST /api/workspaces/:wsId/knowledge/confirm` — HEAD + `file-type` magic sniff + advisory-locked cap recheck + row insert; kicks `processKnowledge` fire-and-forget; always releases inflight slots
- `GET /api/workspaces/:wsId/knowledge` — any member; returns items (sans `markdown_cache`) + aggregate usage/cap info
- `DELETE /api/workspaces/:wsId/knowledge/:knowledgeId` — admin or editor-who-uploaded; cascades chunks via FK + best-effort S3 delete

**AI (login required):** `POST /api/ai/prompt` (returns `{sessionId}`; also handles selection-scoped rewrites since phase 5 collapsed the separate rewrite path into this one), `POST /api/ai/abort` (initiator only, 403 otherwise), `POST /api/ai/transcribe` (voice → text via Cloud STT sync; `{text, inaudible}`), `POST /api/ai/dictate/token` (mints 60s JWT for the dictation WS), `WS /api/ai/dictate` (live dictation relay — JWT auth via first message, NOT query string), `POST /api/docs/:docId/comments/:commentId/trigger-ai` (AI ↔ comment thread via `@ai` mention; see `server/utils/agentic/AGENTS.md`)

Auth guard: see `server/AGENTS.md` for whitelist conventions.
