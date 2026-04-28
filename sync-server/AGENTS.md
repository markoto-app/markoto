# Sync Server (Hocuspocus)

Standalone WS sync container. Config at `src/index.ts`. Hooks: `onLoadDocument`, `onStoreDocument`, `onAuthenticate`, `onConnect`/`onDisconnect`, `onRequest`.

- **Persistence:** `y-postgresql` singleton with `useIndex: false` (1.0.1 has a SQL bug in the index-creation branch), `flushSize: 200`. `onLoadDocument` returns `new Y.Doc()` on failure (never throws). `clearDocument` on deletion.
- **Auth:** `JWT_SECRET` required at startup. Every WS connection must present a valid JWT. Verifies `payload.docId === documentName`.
- **Rate limiter:** 20 connections/IP via `connectionIPs: Map<socketId, ip>` (not mutating connection object — Hocuspocus v3 hook shapes vary). Max 5000 rooms.
- **Activity logging:** Primary attribution from `lastEditorByDoc` Map (JWT `userName`). Fallback: `mostRecentEditorFromAwareness`. Fire-and-forget POST to `${APP_URL}/api/internal/activity` with 5s timeout. Stamps `yjsDocIdBefore`/`yjsDocIdAfter` boundary ids per row so Tier 1 diff + Tier 2 restore can replay (see `app/components/collab/AGENTS.md`).
- **Comments snapshots:** on each comment.* mutation, posts a snapshot of the affected thread to `/api/internal/comments-snapshot` so the Tier 1 comment-context drawer can replay thread state at any past point.
- **Dev networking:** sync→app via `host.docker.internal`; **Nuxt dev must bind `0.0.0.0`** for the sync container to reach it.
- **Internal HTTP** (`src/internal-http.ts`, gated on `X-Internal-Secret`):
  - `GET /health` — public healthcheck for Traefik/Docker
  - `POST /internal/notify-deleted` — sets `ymeta._deleted` + `clearDocument()`
- **Graceful shutdown:** SIGTERM → `server.destroy()` → `ypgPersistence.destroy()`. 25s kill-timer. Compose `stop_grace_period: 30s`.
- **Running:** TS runs directly under Bun (no pre-bundle; bundler chokes on Hocuspocus CJS/ESM exports).

## Gotchas

- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary between versions — don't mutate connection objects; use separate Maps keyed on socketId.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback` to detect drift in the awareness-based fallback chain.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
