# Sync Server (Hocuspocus)

Standalone WS sync container. Config at `src/index.ts`. Hooks: `onLoadDocument`, `onStoreDocument`, `onAuthenticate`, `onConnect`/`onDisconnect`, `onRequest`.

- **Persistence:** `y-postgresql` singleton with `useIndex: false` (1.0.1 has a SQL bug in the index-creation branch), `flushSize: 200`. `onLoadDocument` returns `new Y.Doc()` on failure (never throws). `clearDocument` on deletion.
- **Auth:** `JWT_SECRET` required at startup. Every WS connection must present a valid JWT. Verifies `payload.docId === documentName`.
- **Rate limiter:** 20 connections/IP via `connectionIPs: Map<socketId, ip>` (not mutating connection object — Hocuspocus v3 hook shapes vary). Max 5000 rooms.
- **Activity logging:** Primary attribution from the Valkey-backed `last-editor` key (JWT `userName`, written in `onChange`). Fallback: `mostRecentEditorFromAwareness`. Fire-and-forget POST to `${APP_URL}/api/internal/activity` with 5s timeout. Stamps `yjsDocIdBefore`/`yjsDocIdAfter` boundary ids per row so Tier 1 diff + Tier 2 restore can replay (see `app/components/collab/AGENTS.md`).
- **Per-doc state in Valkey** (`src/sync-state.ts`, `src/valkey.ts`): three keys back what used to be process-local Maps so multiple sync-server instances can share the view. Sync-server has its own ioredis client, separate from the app's pool. Operations are best-effort — Valkey errors fall through to the awareness heuristic, never abort sync.
  - `sync:last-editor:{docId}` — JSON `{userId, userName, at}`. Primary attribution source.
  - `sync:prev-text:{docId}` — last-flushed markdown. Diff baseline. On Valkey miss, the edit row is skipped (better than emitting "+N lines whole doc"); the new baseline is still written.
  - `sync:prev-meta:{docId}` — JSON `{title, themeJson}`. Drives `title.changed` / `theme.changed` rows.
  - **TTL: 24 h** on every key. A doc untouched for 24 h is "cold"; the next edit can rebuild attribution from awareness without harm. Keeps Valkey memory bounded.
- **Comments snapshots:** on each comment.* mutation, posts a snapshot of the affected thread to `/api/internal/comments-snapshot` so the Tier 1 comment-context drawer can replay thread state at any past point.
- **Dev networking:** sync→app via `host.docker.internal`; **Nuxt dev must bind `0.0.0.0`** for the sync container to reach it.
- **Internal HTTP** (`src/internal-http.ts`, gated on `X-Internal-Secret`):
  - `GET /health` — public healthcheck for Traefik/Docker
  - `POST /internal/notify-deleted` — sets `ymeta._deleted` + `clearDocument()`
- **Graceful shutdown:** SIGTERM → `server.destroy()` → `ypgPersistence.destroy()` → `closeValkey()`. 25s kill-timer. Compose `stop_grace_period: 30s`.
- **Running:** TS runs directly under Bun (no pre-bundle; bundler chokes on Hocuspocus CJS/ESM exports).
- **Tests:** unit tests under `src/__tests__/` (vitest). `bun run test` from `sync-server/`.

## Multi-instance scaling

Hocuspocus's in-memory `Y.Doc` tracking is per-process — one container holds the canonical doc state for any given `documentName` while clients are connected. To scale horizontally we use **sticky sessions** at Traefik (`loadbalancer.sticky.cookie=true` in `docker-compose.prod.yml`): all WS connections from a given client cookie route to the same container, so a single client's awareness/edit stream stays pinned. Per-doc attribution + diff state lives in Valkey and is shared across containers.

### Residual cross-instance race

Sticky sessions pin a client, **not a docId**. Two clients editing the same doc CAN land on different containers, in which case:

1. Container A flushes — reads `sync:prev-text:{docId}`, computes delta, writes new baseline.
2. Container B flushes concurrently — reads the SAME `prev-text` (if A hasn't written yet), computes the SAME delta against the SAME prior, writes the same baseline.
3. Both containers POST an `edit` activity row with the same `linesAdded/Removed`.

**Worst case: one duplicate activity row per cross-container concurrency event.** Not corrupting (the Y.Doc state itself is durable in Postgres via `y-postgresql`), just noisy. We don't solve this with WATCH/MULTI or a Lua read-then-write because:
- Sticky sessions make it rare (both clients would need to connect through different cookies, e.g. anonymous + authenticated on the same doc).
- The Hocuspocus debounce window (2-10 s) further reduces the overlap window.
- A clean fix needs a `(docId, yjsDocIdAfter)` dedup index on the activity table — a schema change deliberately deferred from this migration.

**Detection:** grep prod logs for activity rows with identical `(docId, yjsDocIdAfter, linesAdded, linesRemoved)` tuples within a few seconds of each other. If frequency justifies it, add the dedup index later.

## Gotchas

- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary between versions — don't mutate connection objects; use separate Maps keyed on socketId.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback`. Sentry tag `cause` distinguishes `valkey-miss` (cold doc / restart — normal) from `valkey-error` (Valkey down — operationally interesting). A spike of `valkey-error` means investigate the Valkey container; a steady trickle of `valkey-miss` is fine.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **`onDisconnect` cleanup is per-instance.** `clientsCount === 0` only reflects clients on THIS container, so deleting Valkey keys when one container empties could erase another container's diff baseline. We accept the leak (state lingers under the 24 h TTL) over a multi-container DELETE-storm.
