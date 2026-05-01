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

### Cross-instance dedup (closed)

Two containers flushing the same doc concurrently used to produce duplicate activity rows: each read the same `sync:prev-text:{docId}` baseline, computed the same delta, and POSTed identical `edit` rows. Closed via a partial unique index `uq_activity_doc_yjsafter ON (doc_id, yjs_doc_id_after) WHERE yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')` on `activity_log`, with `INSERT ... ON CONFLICT DO NOTHING` in `appendActivity`. The second container's INSERT silently no-ops; the doc state itself is durable in Postgres via `y-postgresql` (always was). Comment-snapshot rows that legitimately share a `yjsDocIdAfter` across one batch — and user-originated `restore` rows — are excluded by the action filter and continue to insert unconditionally.

**Detection:** look for `[activity] dedup skipped insert` in app logs to confirm the race is firing and being absorbed; absence means the residual race isn't actually firing in your traffic. Sticky sessions make it rare (both clients would need different cookies, e.g. anonymous + authenticated on the same doc) and the Hocuspocus debounce window (2-10 s) further shrinks the overlap window.

### Residual `prev-text` race (accepted)

The dedup index closes the *duplicate-row* outcome but not the underlying baseline race. Two containers reading `sync:prev-text:{docId}` between writes still both diff against the same baseline, so the activity row that survives reflects a **partial diff** when the writes interleave at the line level (one container's "+3 lines" was actually -1/+4 if it had observed the other's flush first). We accept this:

- The doc text itself is durable — `y-postgresql` is the source of truth and never sees the race.
- Activity-row `linesAdded`/`linesRemoved` are user-facing summary stats, not audit-grade. A line-count off by a few in a high-concurrency edit window is preferable to introducing a Valkey lock around every flush (which would couple every doc-write to Valkey availability — a worse failure mode than imprecise stats).
- Sticky sessions plus the 2-10 s Hocuspocus debounce make the actual overlap window vanishingly small in practice.

Don't try to fix this with a Valkey `WATCH` / `MULTI` around the baseline read; the cure is worse than the disease.

## Y.js schema migration playbook

When adding a new field to ymeta (or any Y.Map shared across clients), follow these
steps in order. Skipping any of them risks data loss when an old client and a new
client are concurrently connected to the same doc.

1. **Ship the read path first.** New code reads `ymeta.get('newField')` and provides
   a sensible default for `undefined`. Test that a doc that never had the field
   renders correctly. Ship this through one full release cycle — wait until you're
   confident no production clients are running pre-read-path code.

2. **Then ship the write path.** New code writes the field. Old clients still don't
   know about it; their writes don't touch the field, which Y.Map handles correctly
   (sparse updates don't delete missing keys).

3. **Never make a new field required-without-fallback in code.** If your handler
   does `if (!ymeta.get('newField')) throw`, an old client connecting first
   without the field will crash the new code. Always have a default.

4. **Removing a field: invert the order.** Stop writing it (one release), then stop
   reading it (next release), then optionally clean up the data (lazy on next write).

5. **Renaming a field: do BOTH for one release.** Read both old + new, write both
   old + new, in parallel. Then deprecate the old name in the next release.

The Y.Doc binary state itself is forwards/backwards compatible — Y.js handles version
mixing — but APPLICATION-LEVEL contracts (which keys exist, what their shapes are)
need this discipline. Test mixed-version scenarios manually before each ymeta change.

## Gotchas

- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary between versions — don't mutate connection objects; use separate Maps keyed on socketId.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback`. Sentry tag `cause` distinguishes `valkey-miss` (cold doc / restart — normal) from `valkey-error` (Valkey down — operationally interesting). A spike of `valkey-error` means investigate the Valkey container; a steady trickle of `valkey-miss` is fine.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **`onDisconnect` cleanup is per-instance.** `clientsCount === 0` only reflects clients on THIS container, so deleting Valkey keys when one container empties could erase another container's diff baseline. We accept the leak (state lingers under the 24 h TTL) over a multi-container DELETE-storm.
