# Sync Server (Hocuspocus)

Standalone WS sync container. Config at `src/index.ts`. Hooks: `onLoadDocument`, `afterLoadDocument`, `beforeHandleMessage`, `onStoreDocument`, `onAuthenticate`, `onConnect`/`onDisconnect`, `onRequest`.

- **Persistence:** `y-postgresql` singleton with `useIndex: false` (1.0.1 has a SQL bug in the index-creation branch — so `persistence.ts` creates the `idx_yjs_documents_docname` index itself at boot, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`), `flushSize: 200`. **`onLoadDocument` RE-THROWS on a load error** (rejecting the WS connection so clients reconnect once persistence recovers) — it must NOT return a fresh `new Y.Doc()`, which would let clients' cached state persist back as "new" writes and silently overwrite the real document. y-postgresql returns an empty doc for genuinely-absent rows without throwing, so the catch only fires on real errors. `clearDocument` on deletion.
- **Background compaction (`compaction.ts`):** y-postgresql appends one `v1` row per store and only MERGES those rows inside `getYDocFromDb` — i.e. **when a doc is loaded**. Hocuspocus keeps a doc's `Y.Doc` in memory while any client is connected, so an **always-loaded** (never re-loaded) doc's row count grows without bound. A periodic sweep (`startCompactionSweeper()`, started after `server.listen`, stopped in `shutdown`) merges the granular rows of docs over `COMPACT_THRESHOLD` (default 500) `v1` rows. **Race-safety is the whole design:** it does NOT reuse the library's `flushDocument` (which deletes `id < mergedId` — unsafe from a non-serialized process). Instead it snapshots `ceiling = MAX(id)` BEFORE reading, merges rows `id <= ceiling`, inserts the merged row (new id > ceiling), and deletes only `id <= ceiling` in one transaction. A live writer's concurrent append has `id > ceiling`, so it's never folded in AND never deleted — it layers on top of the merged row on next load (Y.js updates are commutative/idempotent). Safe single- or multi-instance; a cross-instance advisory lock (`hashtext('yjs-compaction-sweep')`) means only one instance sweeps at a time. Config: `COMPACT_THRESHOLD` / `COMPACT_INTERVAL_MS` (default 900000; `<=0` disables) / `COMPACT_MAX_DOCS_PER_RUN` (default 50). **Interaction with restore (F4):** compaction raises `MIN(id)`, so activity-log restore points below the floor become unavailable — `restoreDoc` already guards this with `RestorePointCompactedError`. The pure `mergeUpdates` helper is unit-tested (`__tests__/compaction.test.ts`); the DB glue needs a live PG.
- **Auth:** `JWT_SECRET` required at startup. Every WS connection must present a valid JWT. Verifies `payload.docId === documentName`.
- **Rate limiter:** 20 connections/IP (`SYNC_MAX_CONNECTIONS_PER_IP`; 200 outside production), counted per (socket, document) slot in Maps keyed on socketId (not mutating connection object — Hocuspocus v3 hook shapes vary). Max 5000 rooms. **Slots are released on every socket teardown**: Hocuspocus calls `onConnect` before `onAuthenticate` but only wires `onDisconnect` for authenticated connections, so a failed handshake used to leak its slot forever (≈20 bad tokens locked an IP — and everyone behind its NAT — out until restart). `index.ts` subscribes each raw `ws` socket's `close` via `rateLimiter.trackSocket` (from `server.webSocketServer`'s `connection` event); both release paths are idempotent.
- **Update guard (`src/update-guard.ts`, `beforeHandleMessage`):** every incoming message is checked BEFORE Hocuspocus applies it; a `SyncRejection` closes that document connection with a code + reason from `shared/contracts/syncClose.ts`, which the editor turns into a "changes were not saved" banner and stops reconnecting (resending would be refused again). Checks: (1) **sizes** (`src/limits.ts`) — `SYNC_MAX_MESSAGE_BYTES` (17 MiB, also the `ws` `maxPayload`: bigger frames get close 1009 before Hocuspocus sees them), `SYNC_MAX_UPDATE_BYTES` (16 MiB), `SYNC_MAX_DOCUMENT_BYTES` (16 MiB, encoded state; tracked per doc as an estimate advanced by each accepted update and reset to the exact size on every store via `ypgPersistence.onStoreDocument`'s `onEncoded` callback; re-measured only when the estimate would cross the cap; pure deletions always pass so an oversized doc can be trimmed). Without these a single 90 MB insert OOM-killed the container. (2) **ymeta writes** — every value written into the `meta` map must pass `shared/utils/ymetaValidation.ts` (the same contract as `PUT /api/docs/:id/meta`: title ≤255, description ≤500, language ≤50, audience enum, theme = bounded JSON + `isValidTheme`, `_deleted` boolean, unknown keys small bounded JSON); nested Y types inside ymeta are refused. A decoded item only names its parent when it has no neighbour, so the guard follows `origin`/`rightOrigin`/parent-id references through the update and the doc's struct store (iterative + memoised) to find the root type; a reference to state the server doesn't have is refused (`invalid-update`) because Y.js would integrate such an item later as "pending", after the check. All guard work is synchronous so message order is preserved. Read-only connections are skipped (their updates are never applied). Unexpected guard errors fail closed as `invalid-update`.
- **Corrupted docs stay loadable:** `readMetaSnapshot` (`src/meta-snapshot.ts`) never throws — a theme that is a Y type or exceeds the JSON bounds hashes to `UNREADABLE_THEME_HASH` instead of `JSON.stringify`-ing it (a deeply nested theme used to overflow the stack in `onLoadDocument` and brick the doc forever). Baseline seeding in `onLoadDocument` is wrapped so it can't reject the load. Writing a valid theme over a corrupted one is accepted (repair path).
- **Awareness (`src/awareness-guard.ts`, `afterLoadDocument`):** a `change` listener normalises every client's `user` field with `shared/utils/awarenessUser.ts` (hex colour, capped name, https/same-origin avatar, positive integer id) — y-protocols emits `change` before `update`, and Hocuspocus re-broadcasts on `update` from the current states, so peers only ever receive the normalised shape. An `update` listener records which authenticated *writer* connection (JWT context) each awareness client id arrived on.
- **Activity logging:** Primary attribution from the Valkey-backed `last-editor` key (JWT `userId`/`userName`, written in `onChange`). Fallback (cold doc / Valkey down): `mostRecentVerifiedEditor` — the JWT identity of the writer connection whose awareness moved last. **Never the awareness `user.name`**: it is client-controlled, and anonymous editors used to forge any display name into the feed. An anonymous editor is logged as `userName: null` + `actorPrincipal: 'anonymous'` (the feed renders "Anonymous"). Fire-and-forget POST to `${APP_URL}/api/internal/activity` with 5s timeout. Stamps `yjsDocIdBefore`/`yjsDocIdAfter` boundary ids per row so Tier 1 diff + Tier 2 restore can replay (see `app/components/collab/AGENTS.md`).
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
- **Tests:** CI runs the sync-server unit tests from the root workspace (`tests/unit/sync*.test.ts`, `tests/unit/compaction.test.ts`, …), importing `sync-server/src/*` directly. Tests that build Y.Docs for sync-server helpers must import Y from `sync-server/src/yjs.ts` (the sync server's own yjs copy — Y.js relies on `instanceof`). End-to-end hardening against the real `sync-test` container: `tests/integration/sync/syncHardening.test.ts` (the test compose sets low `SYNC_MAX_*` limits that must match the constants in that file).

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

- **`shared/` imports must resolve inside the image.** The sync image installs `shared/package.json`'s deps into `shared/node_modules` (no root `node_modules`). `ymetaValidation.ts` pulls in the Zod theme schema, so `zod` is a `shared/` dependency; anything new that `sync-server/src` imports through `shared/` needs its npm deps listed there too. Never import `yjs` from `shared/` (the app and the sync server have separate copies).
- **Adding a ymeta key:** the update guard validates every ymeta write. Add the key to `isValidMetaValue` in `shared/utils/ymetaValidation.ts` in the same release that ships its read path (unknown keys only pass as small bounded JSON) — otherwise clients writing it get their connection closed.
- **Hocuspocus v3:** Use `Server` (not `Hocuspocus`) for standalone. Hook shapes vary between versions — don't mutate connection objects; use separate Maps keyed on socketId.
- **Bun can't pre-bundle Hocuspocus** — run TS directly via `bun run src/index.ts`.
- **Attribution fallback warning** — grep prod logs for `[hocuspocus] Attribution fallback`. Sentry tag `cause` distinguishes `valkey-miss` (cold doc / restart — normal) from `valkey-error` (Valkey down — operationally interesting). A spike of `valkey-error` means investigate the Valkey container; a steady trickle of `valkey-miss` is fine.
- **Dev sync networking** — `host.docker.internal` + `host-gateway` on Linux; Nuxt dev must bind `0.0.0.0`.
- **`onDisconnect` cleanup is per-instance.** `clientsCount === 0` only reflects clients on THIS container, so deleting Valkey keys when one container empties could erase another container's diff baseline. We accept the leak (state lingers under the 24 h TTL) over a multi-container DELETE-storm.
